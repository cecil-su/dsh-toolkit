import { createHash } from 'node:crypto'

export const RECORD_KEY = 'llm-pi-ai/openai-codex'
const ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage'
const MAX_BYTES = 64 * 1024
const FRESH_MS = 60_000
const COOLDOWN_MS = 10_000
const MAX_SAMPLE_AGE_MS = 15 * FRESH_MS
const TEMPORARY = Symbol('temporary upstream failure')
const UNAVAILABLE = Object.freeze({ status: 'unavailable' })
const SIGNED_OUT = Object.freeze({ status: 'signed-out' })
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x)

// This is the pi-ai record owner's OAuth format. Use the claim only to check
// consistency, not to authenticate a caller. OpenAI validates the bearer.
function identity(record, now) {
  if (record === undefined) return SIGNED_OUT
  const grant = record.kind === 'grant' && record.payload
  if (grant?.type !== 'oauth' || typeof grant.accountId !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,256}$/.test(grant.accountId) ||
      !Number.isSafeInteger(grant.expires) || grant.expires <= now) return UNAVAILABLE
  const token = grant.access
  if (typeof token !== 'string' || token.length > 24_000 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return UNAVAILABLE
  const claim = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
  if (claim?.['https://api.openai.com/auth']?.chatgpt_account_id !== grant.accountId ||
      !Number.isSafeInteger(claim.exp) || claim.exp <= now / 1000) return UNAVAILABLE
  // No bearer, grant, refresh token or identifier is retained in the cache.
  return { scope: createHash('sha256').update(token).digest('hex'), token, account: grant.accountId,
    expires: Math.min(grant.expires, claim.exp * 1000) }
}

function remaining(used) {
  // Subtract exact decimal tenths as integers (100 - 99.9 is not exactly 0.1 in JS).
  const tenths = Math.round(used * 10)
  if (tenths / 10 === used) return (1000 - tenths) / 10
  return 100 - used
}

function parseUsage(data, account, now) {
  if (!object(data) || (Object.hasOwn(data, 'account_id') && data.account_id !== account) ||
      !object(data.rate_limit)) return UNAVAILABLE
  const result = { status: 'ready', checkedAt: now, week: null, short: null }
  const seen = new Set()
  for (const window of [data.rate_limit.primary_window, data.rate_limit.secondary_window]) {
    if (window == null) continue
    if (!object(window)) return UNAVAILABLE
    const key = window.limit_window_seconds === 604800 ? 'week' : window.limit_window_seconds === 18000 ? 'short' : null
    if (!key) continue // Never label an additional, model-specific or unknown limit as the account limit.
    if (seen.has(key)) return UNAVAILABLE
    seen.add(key)
    const used = window.used_percent
    const seconds = window.reset_at
    if (!Number.isFinite(used) || used < 0 || used > 100 ||
        (seconds != null && (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 8_640_000_000_000))) return UNAVAILABLE
    const resetAt = seconds == null ? null : seconds * 1000
    if (resetAt === null || resetAt > now) result[key] = { remainingPercent: remaining(used), resetAt }
  }
  return result.week || result.short ? result : UNAVAILABLE
}

async function readJson(response, signal) {
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new Error()
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) throw new Error()
  const reader = response.body.getReader()
  let size = 0
  const chunks = []
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read().catch(() => { throw TEMPORARY })
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) throw new Error()
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
  } finally { reader.releaseLock() }
}

function retryMs(header, now) {
  if (!header) return FRESH_MS
  const ms = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now
  return Number.isNaN(ms) ? FRESH_MS : Math.max(COOLDOWN_MS, Math.min(ms, 3_600_000))
}

// Credential changes and disposal invalidate even pending record reads. Join
// only a lookup for the same current token; verify it again before publishing.
export function createUsage({ readRecord, fetchImpl = globalThis.fetch, now = Date.now, monotonic = () => performance.now(), timeoutMs = 8000 }) {
  let generation = 0, scope, flight, cache, lastCheckedAt, failedAt, next = 0, disposed = false
  function clear() {
    generation++
    flight?.abort.abort()
    scope = flight = cache = lastCheckedAt = failedAt = undefined
    next = 0
  }
  // One monotonic deadline covers the initial grant, upstream body, verification
  // and any shared-flight wait. A late joiner cannot extend the shared lookup.
  async function bounded(work, deadline, fallback = UNAVAILABLE) {
    let timer
    const left = deadline - monotonic()
    if (left <= 0) return fallback
    try {
      const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(fallback), left) })
      const value = await Promise.race([timeout, work()])
      // A known denial must not become a temporary timeout at a deadline boundary.
      return value === UNAVAILABLE || monotonic() < deadline ? value : fallback
    } finally { clearTimeout(timer) }
  }
  async function current(deadline) {
    try { return await bounded(async () => identity(await readRecord(RECORD_KEY), now()), deadline) }
    catch { return UNAVAILABLE }
  }
  // Return only windows still applicable to this *verified* grant. Never change
  // checkedAt, or make a previous success fresh by polling during backoff.
  function project(t, id) {
    if (!cache) return null
    const validUntil = Math.min(cache.checkedAt + MAX_SAMPLE_AGE_MS, id.expires)
    if (t < cache.checkedAt || t >= validUntil) { cache = undefined; return null }
    const live = w => w?.resetAt != null && w.resetAt <= t ? null : w
    const week = live(cache.week), short = live(cache.short)
    return week || short ? { ...cache, week, short, validUntil } : null
  }
  function duringBackoff(available, id) {
    if (failedAt !== undefined) {
      const snapshot = available || { ...UNAVAILABLE, validUntil: id.expires,
        ...(lastCheckedAt !== undefined ? { checkedAt: lastCheckedAt } : {}) }
      return { ...snapshot, refreshFailed: true, failedAt, retryAt: next }
    }
    return available && available.week === cache.week && available.short === cache.short
      ? available : cache ? { ...(available || UNAVAILABLE), retryAt: next } : UNAVAILABLE
  }
  async function sample(id, signal) {
    let res
    try {
      // Never follow a redirect/send credentials to a new destination. Manual
      // mode also lets us distinguish a sign-in redirect from a network outage.
      res = await fetchImpl(ENDPOINT, { method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store', signal,
        headers: { Authorization: `Bearer ${id.token}`, 'ChatGPT-Account-Id': id.account, Accept: 'application/json' } })
    } catch { return TEMPORARY }
    if (res.redirected) return UNAVAILABLE
    if (res.status === 429) return { retry: retryMs(res.headers.get('retry-after'), now()) }
    if (res.status === 408 || (res.status >= 500 && res.status <= 599)) return TEMPORARY
    if (res.status !== 200) return UNAVAILABLE // includes 401/403: no fallback to last known value
    try { return parseUsage(await readJson(res, signal), id.account, now()) }
    catch (err) { return err === TEMPORARY ? TEMPORARY : UNAVAILABLE }
  }
  async function get(force = false) {
    const deadline = monotonic() + timeoutMs
    if (disposed) return UNAVAILABLE
    const start = generation
    const id = await current(deadline)
    if (start !== generation || disposed) return UNAVAILABLE
    if (!id.scope) { if (scope) clear(); return id }
    if (scope && scope !== id.scope) clear()
    scope = id.scope
    if (flight) return bounded(() => flight.promise, deadline)
    const t = now(), available = project(t, id)
    if (t < next) return duringBackoff(available, id)
    if (!force && failedAt === undefined && available && t - cache.checkedAt < FRESH_MS &&
        available.week === cache.week && available.short === cache.short) return available
    next = t + COOLDOWN_MS
    const epoch = generation, abort = new AbortController()
    const promise = (async () => {
      // Reserve time to verify identity even if upstream never settles. Without
      // that second read, a network timeout could expose a logged-out account.
      const upstreamDeadline = deadline - Math.min(1000, timeoutMs / 4)
      const value = await bounded(() => sample(id, abort.signal), upstreamDeadline, TEMPORARY)
      abort.abort() // Also closes rejected, oversized and non-200 response bodies.
      if (epoch !== generation) return UNAVAILABLE
      const verified = await current(deadline)
      if (epoch !== generation) return UNAVAILABLE
      if (verified.scope !== id.scope) { clear(); return verified.status === 'signed-out' ? SIGNED_OUT : UNAVAILABLE }
      const finished = now()
      if (value === TEMPORARY || value.retry) {
        failedAt = finished
        next = Math.max(next, finished + (value.retry || FRESH_MS))
        return duringBackoff(project(finished, verified), verified)
      }
      failedAt = undefined
      cache = value.status === 'ready' ? value : undefined // A real response replaces *all* windows.
      lastCheckedAt = cache?.checkedAt
      return project(finished, verified) || UNAVAILABLE
    })().finally(() => {
      abort.abort()
      if (flight?.abort === abort) flight = undefined
    })
    flight = { promise, abort }
    return promise
  }
  return { get, invalidate: clear, dispose() { disposed = true; clear() } }
}
