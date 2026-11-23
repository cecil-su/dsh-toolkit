/**
 * Host half of the Codex sign-in entry.
 *
 * The pi-ai adapter registers one authorization flow per installed catalog
 * provider, so the `openai-codex` ChatGPT-subscription login already exists on
 * `ctx.authorization`; what the Web GUI lacks is a surface that starts it. This
 * plugin contributes the smallest surface that fits the existing transport: one
 * plain GET route on the Host web server. Opening it starts the flow and
 * answers 302 with the provider's authorization page, so the browser tab does
 * the whole conversation (the flow catches the provider's localhost callback
 * itself) and nothing has to cross the Client/Server Remote boundary.
 *
 * The committed credential is written by the flow through the credential store,
 * which raises `credentials/record-updated`; the Models page already refetches
 * on that forwarded event, so the page needs no extra wiring.
 */

/** pi-ai catalog provider this entry signs in. */
const PROVIDER = 'openai-codex'

/** Credential record the adapter's flow writes: `<scope>/<provider>`. */
const CREDENTIAL_KEY = `llm-pi-ai/${PROVIDER}`

/** Path of the sign-in entry itself. */
const SIGN_IN_PATH = '/codex-signin'

/** Path that withdraws an attempt stuck waiting for the browser. */
const CANCEL_PATH = '/codex-signin/cancel'

/** How long the flow may take to hand back an authorization page. */
const AUTH_URL_TIMEOUT_MS = 20000

/**
 * Both services are hard requirements: without the web server there is no
 * surface, and without the authorization seam there is no flow to start.
 */
export const inject = ['webServer', 'authorization']

const STYLE = `
:root { color-scheme: light dark; }
body {
  margin: 0; padding: 48px 24px;
  font: 14px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  background: #ffffff; color: #1c1c1e;
}
main { max-width: 560px; margin: 0 auto; }
h1 { margin: 0 0 12px; font-size: 18px; font-weight: 600; letter-spacing: -0.01em; }
p { margin: 0 0 10px; color: #4a4a4f; }
code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: #f2f2f7; border-radius: 4px; padding: 1px 5px; }
a { color: #1f6feb; text-decoration: none; }
a:hover { text-decoration: underline; }
ul { margin: 0 0 10px; padding-left: 18px; color: #4a4a4f; }
@media (prefers-color-scheme: dark) {
  body { background: #16171a; color: #f2f2f7; }
  p, ul { color: #a9a9b2; }
  code { background: #24252a; }
}
`

/**
 * Render one plain HTML page and finish the response.
 * @param res - the response this route owns.
 * @param status - HTTP status code.
 * @param heading - page title, also the visible heading.
 * @param body - trusted markup for the body paragraphs.
 */
function respond(res, status, heading, body) {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)} · DSH</title>
<style>${STYLE}</style>
</head>
<body><main>
<h1>${escapeHtml(heading)}</h1>
${body}
</main></body></html>`
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  res.end(html)
}

/**
 * Escape text for HTML insertion.
 * @param value - untrusted text.
 * @returns the same text with markup characters escaped.
 */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}

/**
 * Race one promise against a deadline without rejecting.
 * @param promise - the value to wait for.
 * @param ms - deadline in milliseconds.
 * @returns the value, or undefined when the deadline wins.
 */
async function beforeDeadline(promise, ms) {
  let timer
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => { resolve(undefined) }, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Collect what the flow said, for the failure page.
 * @param notices - notices observed during the attempt.
 * @returns trusted markup, or an empty string.
 */
function noticesText(notices) {
  if (notices.length === 0) return ''
  const items = notices
    .map((notice) => typeof notice?.message === 'string' ? `<li>${escapeHtml(notice.message)}</li>` : '')
    .filter((item) => item !== '')
  return items.length === 0 ? '' : `<ul>${items.join('')}</ul>`
}

/**
 * Start one attempt and redirect the browser to the provider's authorization
 * page. The flow keeps running in this process after the redirect.
 * @param ctx - Host context carrying the two injected services.
 * @returns the GET handler.
 */
function signInHandler(ctx) {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      respond(res, 405, '只支持 GET', '<p>这个地址由设置页的登录入口打开。</p>')
      return
    }
    // A cross-site browser request must not start a sign-in; a top-level
    // navigation from the page itself arrives as same-origin (or none).
    if (String(req.headers['sec-fetch-site'] ?? '') === 'cross-site') {
      respond(res, 403, '跨站请求被拒绝', '<p>请从 DSH 设置页的登录入口打开这个地址。</p>')
      return
    }

    const entry = ctx.authorization.describe(CREDENTIAL_KEY)
    if (entry === undefined) {
      respond(res, 500, '没有可用的登录流程',
        `<p>当前 profile 没有注册 <code>${escapeHtml(CREDENTIAL_KEY)}</code> 的登录流程。</p>
         <p>请确认 <code>@deepseek-ai/dsh-llm-pi-ai</code> 已挂载，并且它的内置目录里包含 <code>${escapeHtml(PROVIDER)}</code>。</p>`)
      return
    }
    if (entry.inFlight) {
      respond(res, 409, '已经有一次登录在进行',
        `<p>请在已经打开的浏览器标签里完成授权，或在浏览器里等待它结束。</p>
         <p><a href="${CANCEL_PATH}">取消这次登录</a></p>`)
      return
    }

    const method = entry.methods.some((item) => item.id === 'oauth') ? 'oauth' : entry.methods[0].id
    const controller = new AbortController()
    const notices = []
    let settle
    let settled = false
    const authorizationUrl = new Promise((resolve) => { settle = resolve })
    const finish = (value) => {
      if (settled) return
      settled = true
      settle(value)
    }

    // The pi-ai Codex login asks two things: which sign-in method to use
    // (`browser` first, `device_code` second) and, after the authorization page
    // is handed out, a manual code that races the localhost callback. The entry
    // takes the first option of any choice, and lets a typed question wait,
    // because the browser callback normally wins and pi-ai withdraws the losing
    // question through its own signal.
    const interaction = {
      notify(notice) {
        notices.push(notice)
        if (typeof notice?.url === 'string' && notice.url !== '') finish(notice.url)
      },
      prompt(prompt) {
        // The adapter restates pi-ai's prompts in its own neutral vocabulary,
        // where the discriminator is `kind`; the library's own `type` is kept as
        // a fallback so either shape answers the method choice.
        const kind = prompt?.kind ?? prompt?.type
        if (kind === 'select') {
          const options = Array.isArray(prompt.options) ? prompt.options : []
          const preferred = options.find((option) => option?.id === 'browser') ?? options[0]
          return Promise.resolve(typeof preferred?.id === 'string' ? preferred.id : '')
        }
        return new Promise(() => {})
      },
    }

    let failure
    const attempt = ctx.authorization.begin({
      key: CREDENTIAL_KEY,
      method,
      interaction,
      signal: controller.signal,
    })
    attempt.then(
      () => { finish(undefined) },
      (error) => { failure = error; finish(undefined) },
    )

    const url = await beforeDeadline(authorizationUrl, AUTH_URL_TIMEOUT_MS)
    if (typeof url !== 'string' || url === '') {
      controller.abort()
      respond(res, 502, '登录没有启动',
        `<p>${escapeHtml(failure?.message ?? '登录流程没有在 20 秒内给出授权地址。')}</p>${noticesText(notices)}`)
      return
    }

    res.writeHead(302, {
      location: url,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end()
  }
}

/**
 * Withdraw an attempt left waiting for a browser the human already closed.
 * @param ctx - Host context carrying the two injected services.
 * @returns the GET handler.
 */
function cancelHandler(ctx) {
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      respond(res, 405, '只支持 GET', '<p>这个地址由设置页的登录入口打开。</p>')
      return
    }
    const entry = ctx.authorization.describe(CREDENTIAL_KEY)
    if (entry?.inFlight !== true) {
      respond(res, 200, '没有进行中的登录', `<p>已经没有任何等待中的 Codex 登录。</p><p><a href="${SIGN_IN_PATH}">重新登录</a></p>`)
      return
    }
    try {
      ctx.authorization.cancel(CREDENTIAL_KEY)
    } catch (error) {
      respond(res, 500, '取消失败', `<p>${escapeHtml(error?.message ?? String(error))}</p>`)
      return
    }
    respond(res, 200, '已取消登录', `<p>可以关闭这个标签页。</p><p><a href="${SIGN_IN_PATH}">重新登录</a></p>`)
  }
}

/**
 * Mount both routes and give them back on unload.
 * @param ctx - Host context.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: SIGN_IN_PATH, handler: signInHandler(ctx) }),
      ctx.webServer.register({ kind: 'exact', path: CANCEL_PATH, handler: cancelHandler(ctx) }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'codex-signin: routes')
}
