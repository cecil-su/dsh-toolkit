# dsh-toolkit

集中维护本地 DeepSeek Harness（DSH）插件。`plugins/` 中每个目录都是可独立安装的 bundle；仓库根目录不是 DSH 插件，不要整体安装。

| 插件 | 作用 |
| --- | --- |
| [codex-signin](plugins/codex-signin/) | 在模型设置中提供 Codex 登录入口 |
| [account-usage](plugins/account-usage/) | 聊天时查看 Codex 账号周剩余，展开查看套餐提供的窗口、重置时间和刷新状态 |
| [session-title](plugins/session-title/) | 自动生成简短的会话标题，保留手动改名；识别到明确的任务指令时可沿用 Agent Steward 的任务标题 |
| [compaction-effort](plugins/compaction-effort/) | 为 `openai-codex` 所有模型的上下文压缩请求补上 `medium`；不改主对话 |

## 本地安装和维护

在 DSH 插件管理中添加所需插件的本地目录，例如 `E:\ai\dsh-toolkit\plugins\codex-signin`。安装以本地链接引用源码：仓库移位前先处理插件链接；更新后通过插件管理核对启用状态和来源。不要手改 DSH profile，也不要将凭据或会话数据放入仓库。

## 测试

在仓库根目录运行 `node --test "plugins/*/*.test.*"` 检查压缩策略和账号额度插件。测试使用模拟数据，不读取真实账号，也不发模型请求。
