import { RECORD_KEY, createUsage } from './usage.js'

export const name = 'account-usage'
export const inject = ['credentials', 'connection']

export function apply(ctx) {
  const usage = createUsage({ readRecord: key => ctx.credentials.readRecord(key) })
  ctx.effect(() => () => usage.dispose(), 'account-usage: volatile state')
  ctx.on('credentials/record-updated', key => { if (key === RECORD_KEY) usage.invalidate() })

  // Connection admits authenticated requests and only dispatches exact Fetch
  // routes for owner Peers (rc.5). Never replace this with a webServer route.
  for (const method of ['read', 'refresh']) {
    const path = `/api/account-usage/${method}`
    ctx.connection.fetch.register({
      path, methods: ['POST'], requestBody: 'streaming', // do not buffer incoming bodies
      async fetch(request) {
        const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
        const url = new URL(request.url)
        // No user-supplied account, endpoint, credentials, or options. Require a
        // non-simple request; JSON content type alone carries no payload.
        if (request.method !== 'POST' || url.pathname !== path || url.search ||
            request.headers.get('content-type') !== 'application/json' ||
            request.headers.has('transfer-encoding') ||
            ![null, '0'].includes(request.headers.get('content-length'))) {
          return new Response(null, { status: 400, headers })
        }
        const started = performance.now()
        const value = request.signal.aborted ? { status: 'unavailable' } : await usage.get(method === 'refresh')
        // The sample timestamp is never re-stamped on cache hits. Provide a separate
        // clock reference at dispatch (including how much of the RTT was Host work).
        const timed = value.status === 'ready' || value.retryAt != null
        return Response.json(timed ? { ...value, serverNow: Date.now(), hostWorkMs: Math.floor(performance.now() - started) } : value, { headers })
      },
    })
  }
}
