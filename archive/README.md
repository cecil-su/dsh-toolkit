# 历史标题迁移工具（仅归档）

这两份工具展示两个不同的迁移策略，不是可安装插件。没有包清单、Cordis 安装入口或自动执行逻辑；两个 `apply()` 都直接抛错。只保留图标、双语资源、可注入的迁移函数和 mock 测试。没有真实会话清单，也不读写收据。

| 子目录 | 历史用途 | 遇到问题 |
| --- | --- | --- |
| [title-migration-1123](./title-migration-1123/README.md) | 扫描工作区、去重，按条件刷新旧自动标题 | 单项异常记为 `error` 后继续 |
| [title-compact-once](./title-compact-once/README.md) | 按冻结的编号和预期标题逐一精简；不扫描工作区 | 出错或回读校验失败后停止后续刷新 |

原工具以独占创建收据防止重复运行。归档演示使用注入的单次执行记录器：`claim()` 同步且首次才成功，`note(row)` 收集状态；测试只在内存中模拟，不提供跨进程或跨重启的持久化保证。不要将归档接入真实会话。

在仓库根目录运行（Node.js 20+，无需安装依赖）：

```sh
node --test archive/title-migration-1123/mock.test.mjs archive/title-compact-once/mock.test.mjs
```
