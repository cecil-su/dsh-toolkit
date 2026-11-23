# Codex sign-in

在 DSH 的「设置 → 模型」页给 OpenAI Codex 加一个**用 ChatGPT Plus / Pro 订阅登录**的入口。它不新增登录能力，只是把模型适配器里已经注册好的 `openai-codex` OAuth 流程接到页面上——此前这个流程没有任何界面入口。

## 用法

1. 设置 → 模型，页面底部有「OpenAI Codex / ChatGPT 订阅」卡片；已经添加了该 provider 时，它的卡片里也有一条同样的入口。
2. 点「用 ChatGPT 账号登录」。DSH 会在新标签页里打开 Host 的登录入口，入口随即把标签页转到 OpenAI 的授权页。
3. 在浏览器里用 ChatGPT 账号确认授权。回调落在本机 `127.0.0.1:1455`，由 Host 里的登录流程接住，凭据写进 DSH 的凭据库。
4. 回到 DSH：模型设置页会在凭据更新事件到达时自动刷新，模型选择器里出现 Codex 系列模型。

如果标签页卡在授权页不动、或者想放弃，打开 `/codex-signin/cancel` 可以取消这次登录；之后再点一次登录按钮即可重来。

## 实现

- **Host 半边**（`index.js`）：在 `ctx.webServer` 上挂两个 GET 路由。`/codex-signin` 调用 `ctx.authorization.begin()` 启动 `llm-pi-ai/openai-codex` 的 `oauth` 流程：流程先问「浏览器登录 / 设备码登录」，入口自动选第一项（浏览器），拿到授权地址后直接 302 过去；流程本身继续跑在 Host 进程里，接住 localhost 回调并提交凭据。`/codex-signin/cancel` 调用 `ctx.authorization.cancel()`。跨站请求（`Sec-Fetch-Site: cross-site`）被拒绝。
- 流程在授权页之后还会抛出一个「粘贴授权码」的问题，与本地回调赛跑；入口让它一直挂着——浏览器回调正常会先到，pi-ai 会自己撤回这个落败的问题。
- **Client 半边**（`client.js`）：在 `settings.models.footer` 注册一张卡片，并在 `settings.models.provider-card`（按 `llm-pi-ai` 命名空间分派）里给 `openai-codex` 那一张卡注册一条紧凑入口。点击时先 `window.open('about:blank')` 占住标签页，再把它导航到 `/codex-signin`，避开弹窗拦截。Host 地址优先取 `__DSH_TRANSPORT__.streamBaseUrl`（静态 Desktop 页面），否则取页面自身的 origin（Web）。
- 凭据只由 pi-ai 的登录流程写入，插件自己不碰凭据文件。

## 限制

- **没有登录状态回显**：入口不显示「已登录 / 未登录」。Codex 的凭据是 `llm-pi-ai/openai-codex` 的授权记录，模型页的凭据关联只覆盖 api-key 引用，所以这里读不到；真正的反馈是模型选择器里出现 Codex 模型。
- **只有「浏览器登录」被自动选中**：设备码登录需要把验证码显示给用户，入口没有这个界面，所以固定选第一项。
- **回调走不通时要手动取消**：如果 `127.0.0.1:1455` 被占用或浏览器没能回到本机，这次尝试会一直挂着；打开 `/codex-signin/cancel` 取消后可以重试。
- **一次只能有一个登录在进行**：重复点击会得到「已经有一次登录在进行」的页面，等它结束或先取消。
- **走的是 pi-ai 的 legacy Codex 通道**：即 `openai-codex` provider（ChatGPT Plus/Pro → GPT-5.x Codex 系列），不是 `openai` provider 上更新的「Sign in with ChatGPT」；后者需要安装标识，DSH 明确不提供。
- 刷新令牌是单次轮转的：DSH 里登录并使用刷新后，pi 自己保存的那份 Codex 登录态会失效，需要在 pi 里重新登录。
- 目录里的模型不都对订阅开放：本机实测 `gpt-5.5`、`gpt-5.3-codex-spark` 会被服务端以「not supported when using Codex with a ChatGPT account」拒绝，其余（`gpt-5.6-luna/sol/terra`、`gpt-6-astra/luna/sol`、`gpt-6.1-sol`）正常。模型页里可以删掉不可用的行。

## 依赖

- Host：`@deepseek-ai/dsh-host-webserver`（`ctx.webServer`）、`@deepseek-ai/dsh-authorization`（`ctx.authorization`）、`@deepseek-ai/dsh-llm-pi-ai`（登录流程与凭据记录）。
- Client：`@deepseek-ai/dsh-client-ui-settings-models`（两个扩展槽）。
