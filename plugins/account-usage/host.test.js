import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from './index.js'
import { createUsage, RECORD_KEY } from './usage.js'

// All grants, identities, response streams, clocks and transports are synthetic.
const base = 1_800_000_000_000
function grant(account = 'fixture-A', extra = {}) {
  const claim = { exp: base / 1000 + 86_400, 'https://api.openai.com/auth': { chatgpt_account_id: account } }
  return { kind: 'grant', payload: { type: 'oauth', accountId: account, expires: base + 86_400_000,
    access: `fixture.${Buffer.from(JSON.stringify(claim)).toString('base64url')}.fixture`, ...extra } }
}
const weekly = { limit_window_seconds: 604800, used_percent: 32.5, reset_at: base / 1000 + 86400 }
const short = { limit_window_seconds: 18000, used_percent: 100 }
const payload = (w = weekly, s = short) => ({ rate_limit: { primary_window: w, secondary_window: s },
  additional_rate_limits: [{ rate_limit: { primary_window: weekly } }], email: 'fixture field must not escape' })
const unavailable = { status: 'unavailable' }
function harness(options = {}) {
  const h = { record: grant(), time: base, count: 0, responder: () => Response.json(payload()), ...options }
  h.usage = createUsage({ readRecord: async key => {
    assert.equal(key, RECORD_KEY); return h.record
  }, now: () => h.time, timeoutMs: h.timeout ?? 1000, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage'); assert.equal(init.redirect, 'error')
    assert.equal(init.method, 'GET'); assert.equal(init.credentials, 'omit')
    const headers = new Headers(init.headers)
    assert.ok(headers.get('Authorization') === `Bearer ${h.record.payload.access}`)
    assert.ok(headers.get('ChatGPT-Account-Id') === h.record.payload.accountId)
    assert.deepEqual([...headers.keys()].sort(), ['accept', 'authorization', 'chatgpt-account-id'])
    h.count++; return h.responder(init)
  } })
  return h
}

test('account-level windows are matched by duration and projected without upstream fields', async () => {
  const h = harness({ responder: () => Response.json(payload(short, weekly)) })
  assert.deepEqual(await h.usage.get(), { status: 'ready', checkedAt: base,
    week: { remainingPercent: 67.5, resetAt: base + 86400_000 }, short: { remainingPercent: 0, resetAt: null } })
  h.record = undefined
  assert.deepEqual(await h.usage.get(), { status: 'signed-out' }); assert.equal(h.count, 1)
})

test('no other grant, invalid/expired/mismatched access, or key ever causes a fetch', async () => {
  for (const record of [undefined, { kind: 'api-key', key: 'not-an-oauth-grant' }, grant('x', { accountId: 'y' }),
    grant('x', { access: 'bad' }), grant('x', { expires: base }), grant('x', { type: 'api_key' })]) {
    const h = harness({ record })
    assert.deepEqual(await h.usage.get(), record === undefined ? { status: 'signed-out' } : unavailable); assert.equal(h.count, 0)
  }
})

test('unsupported, duplicated, invalid, reset and cross-account data fail closed', async () => {
  const noWeek = { ...weekly, limit_window_seconds: 1200 }
  for (const data of [payload(), payload(weekly, weekly), payload(noWeek, null), payload({ ...weekly, used_percent: -1 }, null),
    payload({ ...weekly, used_percent: '0' }, null), payload({ ...weekly, reset_at: base / 1000 }, null),
    payload({ ...weekly, reset_at: 'unexpected' }, null), {}, { ...payload(), account_id: null }]) {
    const body = data.rate_limit?.secondary_window === short ? { ...data, account_id: 'different' } : data
    const h = harness({ responder: () => Response.json(body) }); assert.deepEqual(await h.usage.get(), unavailable)
  }
  const partial = harness({ responder: () => Response.json(payload(noWeek, short)) })
  assert.equal((await partial.usage.get()).week, null)
  const rolling = harness({ responder: () => Response.json(payload({ ...weekly, reset_at: base / 1000 }, short)) })
  const live = await rolling.usage.get()
  assert.equal(live.week, null); assert.equal(live.short.remainingPercent, 0)
})

test('shared manual cooldown and read TTL; no retained result after failures or reset', async () => {
  const h = harness()
  await h.usage.get(); h.time += 3000
  assert.equal((await h.usage.get(true)).checkedAt, base); assert.equal(h.count, 1)
  h.time += 7000; await h.usage.get(true); assert.equal(h.count, 2)
  h.time += 59000; await h.usage.get(); assert.equal(h.count, 2)
  h.time += 1000; h.responder = () => new Response(null, { status: 401 })
  assert.deepEqual(await h.usage.get(), unavailable); assert.deepEqual(await h.usage.get(true), unavailable); assert.equal(h.count, 3)
  const r = harness({ responder: () => Response.json(payload({ ...weekly, reset_at: base / 1000 + 2 }, null)) })
  assert.equal((await r.usage.get()).week.remainingPercent, 67.5); r.time += 2000
  assert.deepEqual(await r.usage.get(), { ...unavailable, retryAt: base + 10_000 }); assert.equal(r.count, 1)
})

test('a reset in cooldown preserves the other window and its original sample time; ordinary read retries at the floor', async () => {
  for (const expires of ['week', 'short']) {
    const survivor = expires === 'week' ? 'short' : 'week'
    const h = harness({ responder: () => Response.json(payload(
      { ...weekly, ...(expires === 'week' ? { reset_at: base / 1000 + 3 } : {}) },
      { ...short, ...(expires === 'short' ? { reset_at: base / 1000 + 3 } : {}) })) })
    const initial = await h.usage.get()
    h.time = base + 3000
    for (const manual of [false, true]) {
      const partial = await h.usage.get(manual)
      assert.equal(partial.checkedAt, base); assert.equal(partial[expires], null)
      assert.deepEqual(partial[survivor], initial[survivor]); assert.equal(partial.retryAt, base + 10_000)
    }
    assert.equal(h.count, 1)
    h.time = base + 10_000; h.responder = () => Response.json(payload(weekly, short))
    const next = await h.usage.get()
    assert.equal(next.checkedAt, h.time); assert.ok(next.week && next.short); assert.equal(next.retryAt, undefined); assert.equal(h.count, 2)
  }
})

test('decimal tenths subtract exactly, without rounding genuine sub-tenth readings', async () => {
  for (const [used, expected] of [[99.9, 0.1], [0.1, 99.9], [99.96, 100 - 99.96], [0, 100], [100, 0]]) {
    const h = harness({ responder: () => Response.json(payload({ ...weekly, used_percent: used }, null)) })
    assert.equal((await h.usage.get()).week.remainingPercent, expected)
  }
})

test('429 is honored on both methods; a different account receives no stale response', async () => {
  const h = harness({ responder: () => new Response(null, { status: 429, headers: { 'retry-after': '120' } }) })
  assert.deepEqual(await h.usage.get(), unavailable); h.time += 110000
  assert.deepEqual(await h.usage.get(true), unavailable); assert.equal(h.count, 1)
  h.time += 10000; await h.usage.get(); assert.equal(h.count, 2)
  h.record = grant('fixture-B'); h.responder = () => Response.json({ ...payload(null, short), account_id: 'fixture-B' })
  assert.equal((await h.usage.get()).week, null); assert.equal(h.count, 3)
})

test('in-flight coalescing, change during request (even without an event), and disposal', async () => {
  let release, started
  const ready = new Promise(resolve => { started = resolve })
  const h = harness({ responder: () => new Promise(resolve => { release = resolve; started() }) })
  const a = h.usage.get(), b = h.usage.get(true)
  await ready; assert.equal(h.count, 1)
  h.record = grant('fixture-B'); release(Response.json(payload()))
  assert.deepEqual(await a, unavailable); assert.deepEqual(await b, unavailable)
  let signal
  h.responder = init => new Promise(resolve => { signal = init.signal; signal.addEventListener('abort', () => resolve(Response.json(payload()))) })
  const pending = h.usage.get(); await new Promise(resolve => setImmediate(resolve)); h.usage.dispose()
  assert.equal(signal.aborted, true); assert.deepEqual(await pending, unavailable); assert.deepEqual(await h.usage.get(), unavailable)
})

test('oversized declared and chunked bodies, transport errors, malformed JSON, redirects and timeout disclose nothing', async () => {
  for (const responder of [() => new Response('x', { headers: { 'content-type': 'application/json', 'content-length': '65537' } }),
    () => new Response(new Uint8Array(65537), { headers: { 'content-type': 'application/json' } }),
    () => new Response('{secret invalid JSON', { headers: { 'content-type': 'application/json' } }),
    () => new Response('unexpected'), () => { throw new Error('sensitive transport failure') },
    () => new Response(null, { status: 302, headers: { location: 'https://invalid.test/' } }),
    init => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('timeout'))))]) {
    const h = harness({ responder, timeout: 20 }); assert.deepEqual(await h.usage.get(), unavailable); assert.equal(h.count, 1)
  }
})

test('end-to-end deadline includes both credential reads and the upstream operation', async () => {
  for (const readMs of [3700, 4000]) {
    let ticks = 0, reads = 0
    const usage = createUsage({ now: () => base, monotonic: () => ticks, timeoutMs: 8000,
      readRecord: () => { ticks += readMs; reads++; return grant() },
      fetchImpl: () => { ticks += 500; return Response.json(payload()) } })
    const result = await usage.get()
    assert.equal(reads, 2); assert.equal(result.status, readMs === 3700 ? 'ready' : 'unavailable')
    usage.dispose()
  }
})

test('a stuck credential read times out, and events discard pending snapshots', async () => {
  let resolveRead, called = 0
  const usage = createUsage({ readRecord: () => new Promise(resolve => { resolveRead = resolve }),
    now: () => base, timeoutMs: 20, fetchImpl: () => { called++; throw new Error() } })
  assert.deepEqual(await usage.get(), unavailable)
  resolveRead(grant())
  const pending = usage.get(); usage.invalidate(); resolveRead(grant())
  assert.deepEqual(await pending, unavailable); assert.equal(called, 0)
})

test('plugin registers only exact owner-protected Connection routes; no inputs or caching', async () => {
  const routes = new Map(), events = new Map(); let reads = 0, dispose
  apply({ effect: effect => { dispose = effect() }, on: (name, fn) => events.set(name, fn),
    credentials: { readRecord: async key => { assert.equal(key, RECORD_KEY); reads++ } },
    connection: { fetch: { register: route => routes.set(route.path, route) } } })
  assert.deepEqual([...routes.keys()], ['/api/account-usage/read', '/api/account-usage/refresh'])
  for (const [path, route] of routes) {
    assert.deepEqual(route.methods, ['POST']); assert.equal(route.requestBody, 'streaming')
    const request = (suffix, headers) => new Request(`https://host.test${path}${suffix}`, { method: 'POST', headers })
    assert.equal((await route.fetch(request('', {}))).status, 400)
    assert.equal((await route.fetch(request('?account=1', { 'content-type': 'application/json' }))).status, 400)
    const res = await route.fetch(request('', { 'content-type': 'application/json' }))
    assert.equal(res.headers.get('cache-control'), 'no-store'); assert.deepEqual(await res.json(), { status: 'signed-out' })
  }
  assert.equal(reads, 2); events.get('credentials/record-updated')(RECORD_KEY); dispose()
})
