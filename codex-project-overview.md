# Cyberboss 架构地图（Codex 启动上下文）

用途：先用这份短地图定位边界，再只读取任务相关文件。动态分支、未提交改动和当前任务以 `.agent-coordination/` 与 `git status` 为准，不在这里维护。

## 系统定位

Cyberboss 是 Node.js 22+ 的个人 Agent Bridge：微信负责交互，核心层编排 turn，Codex 或 Claude Code 负责推理；日记、时间轴、提醒、贴纸、文件与位置是项目能力。运行态和私人数据默认在 `~/.cyberboss/`，不在仓库内。

## 主调用链

```text
bin/cyberboss.js
  → src/index.js（配置、CLI、启动）
  → CyberbossApp.start()（src/core/app.js）
  → Weixin LongPoll（src/adapters/channel/weixin/）
  → normalize / debounce / command-or-message routing
  → prepare input / vision context / TurnGate
  → selected runtime adapter
  → normalized runtime events
  → StreamDelivery
  → Weixin text/media reply
```

系统 check-in、提醒和日记轮询不经过微信入站，但会汇入 `SystemMessageDispatcher`，随后复用同一套 turn 准入、runtime 和投递链路。

## 分层与入口

| 区域 | 职责 | 优先入口 |
|---|---|---|
| `src/core/` | 编排消息、命令、turn、线程状态、队列和投递 | `app.js`, `stream-delivery.js`, `turn-gate-store.js` |
| `src/adapters/channel/weixin/` | 微信登录、LongPoll、消息规范化、文本/媒体发送和 context token | `index.js`, `api.js`, `media-send.js` |
| `src/adapters/runtime/codex/` | Codex app-server JSON-RPC、thread/session、模型、审批、事件映射 | `index.js`, `rpc-client.js`, `events.js` |
| `src/adapters/runtime/claudecode/` | Claude Code 子进程、stream-json、resume、IPC、项目 MCP 配置 | `index.js`, `process-client.js`, `ipc-server.js` |
| `src/services/` | 日记、时间轴、提醒、贴纸、文件、视觉等业务能力 | 对应 `*-service.js` |
| `src/tools/` | 将项目能力暴露给 runtime 的工具宿主和 MCP stdio server | `tool-host.js`, `create-project-tooling.js` |
| `src/integrations/` | 外部能力适配；当前主要是 `timeline-for-agent` | `timeline/index.js` |
| `src/app/` | 后台 poller / 内部触发器 | `system-checkin-poller.js` |

## 两条 Runtime 路径

- `CYBERBOSS_RUNTIME=codex`：`createCodexRuntimeAdapter` 连接 Codex app-server；配置 endpoint 时走 WebSocket，否则可 spawn `codex app-server --stdio`。线程用 `thread/start|resume`，turn 用 `turn/start`。
- `CYBERBOSS_RUNTIME=claudecode`：`createClaudeCodeRuntimeAdapter` 通过 `ClaudeCodeProcessClient` 启动 `claude`，使用 stream-json 收发，按 session id 恢复，并通过项目 `.mcp.json` 接入 Cyberboss 工具。
- 两者在 core 中统一为 runtime events；微信命令、TurnGate 和 StreamDelivery 不应依赖某个 runtime 的私有协议。

## 核心状态与不变量

- `SessionStore`：`~/.cyberboss/sessions.json`，按 runtime 隔离 workspace/binding 与 thread/session 的映射。
- `TurnGateStore`：同一 `bindingKey + workspaceRoot` 同时只允许一个活跃 turn；后续输入缓冲后再 flush。
- `ThreadStateStore`：跟踪运行、审批、完成/失败和上下文状态。
- `StreamDelivery`：把 runtime 流事件聚合成微信可发送内容，绑定正确回复目标，并处理分片、重试及延迟补发。
- 各 JSON queue/store 应通过 `src/core/json-state-file.js` 的原子写入和文件锁更新，避免并发覆盖。
- 微信 `contextToken` 是回复路由条件；thread/session id 是 runtime 状态，二者不要混用。

主要持久化内容包括 `sessions.json`、各类 `*-queue.json`、`diary/`、`timeline/`、`stickers/`、`inbox/` 和 `locations.json`；准确路径以 `src/core/config.js` 为准。

## 修改时的最短阅读路径

- 消息没进来：`weixin/index.js` → `app.js: handleIncomingMessage/handlePreparedMessage`
- 排队、重复或 turn 卡住：`app.js` → `turn-gate-store.js` → `thread-state-store.js`
- 回复错人、丢失、重复或分片异常：`app.js: handleRuntimeEvent` → `stream-delivery.js` → channel send
- Codex 线程/RPC/审批：`runtime/codex/index.js` → `rpc-client.js` → `events.js`
- Claude Code 启动/resume/IPC：`runtime/claudecode/index.js` → `process-client.js` → `ipc-server.js`
- 内部消息/check-in/日记：`system-checkin-poller.js` → `system-message-dispatcher.js`
- 状态损坏或并发写：目标 store → `json-state-file.js`

涉及 turn lifecycle、消息投递、PID 或运行时进程时，先完整阅读 `CLAUDE.md`。更高层的边界说明见 `docs/architecture.md`，用户命令与部署行为见 `README.zh-CN.md`。

## 验证

- 工作前只读检查：`npm run agent:status`
- 测试路由：`test/ROUTES.md`
- 定点测试：`node --test test/<area>.test.js`
- 语法：`npm run check:syntax`
- 全量：`npm test` 或 `npm run check`
- 运行态诊断：`npm run doctor`、`npm run shared:status`
