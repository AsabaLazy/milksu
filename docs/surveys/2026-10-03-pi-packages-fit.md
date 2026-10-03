# Pi 侧三处替换结论（2026-10-03）

调研底稿。允许改工具名，也允许改尚未进安装包的研究存储。不改 `current-system.md`。采纳后再回写。

锁文件钉 `pi-coding-agent` 1.0.0。本机 `node_modules` 仍是 0.87.0。下文按已发布的 1.0.0。`pi-durable` 标了实验性，接口会变。

## 结论

编码内核保持 `pi-coding-agent`。DSH 保持并列内核。安全循环不写进侧车。

这次只改三处自有实现。MCP 客户端留在 `pi-mcp-adapter`，升到带协议开关的版本。普通 Coding 打开 `codemode`。Deep Research 的状态改到 `pi-durable`。

`chord` 继续只当 Pi 扩展的依赖。不打开 facet 宿主。不替换 Desktop RPC。

| 包 | 决定 | 接了会怎样 | 不接会怎样 |
| --- | --- | --- | --- |
| `pi-mcp` | 不接入 | 协议停在 `2025-11-25`。手写客户端，不依赖官方 SDK。只说 `2026-07-28` 的服务器连不上。沙箱和审批要改接到 `bridge-mcp.js` | 客户端留在 `pi-mcp-adapter`。协议开关从 `2.20.0` 起就有 |
| `pi-mcp-adapter` | 留下并升级。在传入的配置里写 `protocolVersion` | 从 `2.17.0` 升到 `5.0.0`。每个服务器写 `"auto"` 或 `"2026-07-28"`。不写则仍走 `"legacy"`。`createMcpAdapter({ config })` 仍不读本机 mcp 文件。补丁先对照新版的 sampling 导入 | 停在 `2.17.0`。没有协议开关。只说 `2026-07-28` 的服务器连不上 |
| `pi-codemode` | 接入。只打开普通 Coding | 多次读取收进脚本，只有脚本结果进上下文。嵌套调用仍逐条审批、逐条出现。CTF、CVE 和实验室若也打开，逐步轨迹会折进脚本，所以这三处不开 | 目录仍靠一个名为 `mcp` 的代理工具露出。重复读取都进模型上下文 |
| `pi-durable` | 接入。只换研究状态，不换编码内核 | 运行、引用和报告写入 Document，步骤变成任务。重启走 `resume`。v1 到 v3 迁移删掉。编码原文仍是 Pi JSONL。若拿它换掉 `pi-coding-agent`，压缩、技能、LSP、子代理和审批都要重接，DSH 仍要另留一条 | 研究留在 `internal/research`。失联后未确认的停止仍没有出口 |
| `chord` | 不另接。保持现有依赖位置 | 在 `milksu.plugin/v1` 和 Desktop RPC 旁边再开一套 facet 宿主。主题、看板娘和手机帧都要改接 | 插件留在 `internal/plugin`。手机帧仍是 Desktop RPC。它继续只做 `pi-subagents` 的 peer |

## 包本身

前四行按 npm 1.0.0 的 README。`pi-mcp-adapter` 按它自己的文档，最新版是 `5.0.0`。最后一列是这次用的特性。

| 包 | 是做什么的 | 主要特性 | 其余特性 | 这次用的 |
| --- | --- | --- | --- | --- |
| `pi-mcp` | 独立的 MCP 客户端。这个包没有服务端，也不依赖官方 SDK | 传输有 stdio 和 Streamable HTTP。协议是 `2025-11-25`，并接受更早的三个版本。能做分页的 `tools/list` 和 `tools/call` | 进度通知、取消、断线后续传，以及一小部分 OAuth。内存传输给测试用。初始范围不含服务端、旧的 HTTP 加 SSE、sampling、tasks 和批量 JSON-RPC | 不用。协议停在 `2025-11-25` |
| `pi-mcp-adapter` | Pi 的 MCP 扩展。客户端用官方 `@modelcontextprotocol/client` v2 | 从 `2.20.0` 起，每个服务器有 `protocolVersion`。`"auto"` 先探 `2026-07-28`，再退回旧握手。`"2026-07-28"` 只认这一版 | 传输含 stdio、Streamable HTTP、旧 SSE 和 rmcp-mux。Tasks 在新版连接上、且服务器声明该扩展时启用。OAuth 默认进系统钥匙串。npm 最新 `5.0.0`，发布于 2026-10-02 | 升级现有依赖。配置从 `createMcpAdapter({ config })` 传入。每个服务器写 `"auto"`。仍不读本机 mcp 文件。沙箱、环境过滤和审批留在 `bridge-mcp.js` |
| `pi-codemode` | 在 QuickJS 的 WASM 里跑模型写的 JavaScript。脚本只能调用宿主注入的工具 | 嵌套的工具调用不进模型上下文。模型只看到脚本的输出和返回值。沙箱里没有文件、网络、定时器和模块 | `text`、`image`、`exit`、`store` 和 `load`。`store` 由宿主保存，沙箱自己不落盘。可设超时。每次工具调用记在 `result.calls`。直接 `tool.execute` 会跳过审批钩子。要审批时，嵌套调用改走 `runToolCall` | 用脚本调用注入的工具。只有脚本结果进模型上下文。嵌套调用改走现有审批，不走跳过钩子的默认路径。`store` 不存产品状态。CTF、CVE 和实验室不用 |
| `pi-durable` | 实验性的会话运行时。对话、模型回合、工具调用和自有状态先写入存储，然后才显示。模型用 `pi-ai`。Document 状态用 `chord` | 一次提交可以同时写条目、Document 和任务。工具意图先落盘，再执行。进程重启后 `resume` 接上。存储用 SQLite 或 JSONL | 压缩、分叉、重置、子代理、子任务、钩子、用量和 `watch`。忙时的下一条进 `pi.inbox`。流式正文最多每 100 毫秒落盘。只有标了 `replay: "safe"` 的工具会在重启后重跑，其余给模型一条 interrupted。可选工具是 `bash`、`read`、`write`、`edit`。一份存储同时只由一个进程打开 | 只用 Document 和任务承接研究。运行、引用和报告是 Document。步骤是任务。重启用 `resume`。编码会话不用。不装 `bash`、`read`、`write`、`edit` |
| `chord` | 应用组装运行时。一份功能要拆到多个进程时，用它声明服务和复制状态。它不依赖其他 Pi 包 | facet 把插件拆进不同进程。服务分单例和按 key。复制状态发布不可变快照，订阅方收到增量 | 远程服务绑定。传输由调用方自己接。参数要求严格 JSON。另有取消用的 context，以及增量跟踪 | 不新接。它已经是 `pi-subagents` 的 peer。不打开 facet 宿主。复制状态、远程绑定和 facet 都不用 |

`dmmulroy/pi-mcp` 是另一个 git 仓库，版本 `0.1.0`。npm 上没有这个包名。它依赖官方客户端 `2.0.0`。本文不改用它。

`"legacy"` 仍走旧的 `initialize`。`"auto"` 先探新版，旧服务器再退回。`"2026-07-28"` 对不上就失败。现有补丁把 sampling 的 `complete` 改为从 `@earendil-works/pi-ai/compat` 导入。升级后先看上游是否已改这条导入。

## 目标

1. 普通 Coding 可用脚本收起多次工具调用。每一次调用仍单独审批，并单独出现在过程里。
2. MCP 目录留在 `pi-mcp-adapter`。协议用 `"auto"`。沙箱、环境过滤和不读本机 mcp 配置留下。
3. Deep Research 重启后能恢复。研究库不再单独做 v1 到 v3 迁移。
4. 编码原文、DSH 会话、产品插件和手机协议留在现在的位置。
5. 安全页以后接 shama 的 ACP。这次不把那条循环写进侧车。

## 组件对照

| 组件 | 现在 | 改成 | 目标 |
| --- | --- | --- | --- |
| Coding 会话 | `SessionManager` 按 `conversationId` 打开 Pi JSONL | 不改 | 4 |
| 压缩、技能、LSP、子代理 | 在 `pi-coding-agent` 里 | 不改。不用 `pi-durable` 替换这个内核 | 4 |
| DSH | 并列内核。研究用 `deep-research-web` 技能 | 不改。会话不进 `Harness` | 4 |
| MCP 客户端 | `pi-mcp-adapter` 2.17.0，加本仓库补丁 | 升到 `5.0.0`。传入配置里每个服务器写 `protocolVersion: "auto"`。不换 `@earendil-works/pi-mcp` | 2 |
| MCP 露出方式 | 一个名为 `mcp` 的代理工具 | 普通 Coding 改由 `codemode` 调用目录里的工具。工具名会变 | 1、2 |
| 加载范围 | 只在传入 `mcpConfig` 时加载。不读 `~/.pi/agent/mcp.json`，也不读项目 `.pi/mcp.json` | 这两条保持 | 2 |
| 沙箱和审批 | `bridge-mcp.js` 做 `sandbox-exec`、环境过滤和逐次审批。上限 16 个服务、64 个工具 | 留在该文件，仍调用 `pi-mcp-adapter`。插件和 Computer Use 的进程仍由本仓库启动 | 2 |
| 嵌套调用 | 产品路径没有 `codemode` | 必须走进现有审批扩展，并逐条发出 `tool_call`。直接 `tool.execute` 会绕开审批 | 1 |
| 模式开关 | 四类任务同一套工具披露约定 | `codemode` 只在普通 Coding 打开。`mode` 保持其他工具可见。CTF、CVE 和实验室仍用显式工具 | 1、5 |
| 系统沙箱 | QuickJS 不在产品路径里 | QuickJS 不代替 `sandbox-exec` | 2 |
| Deep Research | `internal/research` 的 SQLite，与 Pi 对话并行。schema 未进安装包，带 v1 到 v3 迁移 | 一条 Conversation。运行、引用和报告是 Document。步骤是任务。会话 id 与 Pi 对话互指 | 3 |
| 研究的界面数据 | Go 读写 `data/domain/research/` | Go 改读投影。界面和重启读 Go 的结果 | 3 |
| 研究中断 | sidecar 失联后，未确认的停止没有出口。强杀会留下孤儿 worker | 未确认的停止改为任务中止。重启后 `resume`。删除会话时同一次操作清掉投影和 Pi 原文 | 3 |
| 新的 Pi-only 长任务 | 尚无统一位置。研究是第一份自写状态机 | 沿研究这条路径。不再各写一份 SQLite | 3 |
| 产品插件 | `milksu.plugin/v1`，主题、看板娘和设置在 `internal/plugin` | 不改 | 4 |
| agent 新工具 | 有进 Pi 扩展的，也有留在本仓库桥里的 | 新工具写成 Pi 扩展。不另开第三份注册表 | 4 |
| `chord` | `pi-subagents` 的 peer。源码不打开 facet 宿主 | 保持 | 4 |
| 手机 | 已定设计未实现。手机是渲染器。管道是 WSS，帧是 Desktop RPC | 不改帧。普通会话仍走现有会话 RPC。研究视图可把 `watch` 的操作批放进同一套帧 | 4 |
| 安全页 | CTF、CVE、实验室的领域事实和 Judge 在 MilkSU。shama 尚未接入 | 下一形态是 ACP 客户端。这几个包不实现这条循环 | 5 |

OAuth 仍走适配器。默认存在系统钥匙串。传入的 `config` 不合并本机 mcp 文件。

目标 1 的准入测试：审批拒绝嵌套调用时，这次调用失败。测试通过之后，才把 `codemode` 放进默认工具名。

## 落地

1. 按锁文件重装。确认 `createAgentSession` 仍能打开旧的 Pi JSONL。对应目标 4。
2. 把 `pi-mcp-adapter` 升到 `5.0.0`。传入的每个服务器写上 `"auto"`。对照 sampling 补丁。补沙箱、环境过滤和逐次审批的测试。对应目标 2。
3. 补上嵌套调用的审批测试，再打开普通 Coding 的 `codemode`。对应目标 1。
4. 研究状态迁到 Document 和任务。删掉研究库的迁移阶梯。DSH 不改。对应目标 3。
