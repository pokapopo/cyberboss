# cyberboss-app

## 进程架构

```
shared-start.js (守护进程)
  └─ spawn → bin/cyberboss.js start (主进程)
       └─ spawn → claude.exe (运行时子进程)

WeChat LongPoll
  → ChannelAdapter (src/adapters/channel/weixin/)
    → CyberbossApp (src/core/app.js)
      → TurnGateStore (src/core/turn-gate-store.js)
        → process-client.js → claude.exe
```

- `shared-start.js`：看门狗，主进程退出后自动重启。只在启动时调 `ensureBridgeNotRunning()` 清理孤儿进程。
- 主进程：写 PID 到 `~/.cyberboss/cyberboss.pid`，**仅用于外部查询，不做自动杀旧进程**。
- claude 子进程：由 `process-client.js` 管理生命周期。

---

## 调试须知

> 以下规则来自 MCP 自杀 bug 的实际排查教训（详见 memory: `bug-mcp-suicide-pid-kill`）：
> MCP 子进程通过 `killStalePidIfSafe` 读出主进程 PID，`taskkill /F /T` 反杀。所有 JS error hook 跳过、crash.log 无记录、退出码 1。
> 排查走了弯路——先花大量时间在 JS 层埋 checkpoint，但根因在系统进程层。以下规则就是为了避免重蹈覆辙。

### Force-kill 特征识别（先于一切）

看到这三个信号同时出现 → **进程被外部 force-kill，不是 JS bug**：
1. 退出码 1
2. crash handler 没触发（`uncaughtException` / `unhandledRejection` / `beforeExit` 全跳过）
3. `setTimeout` / 异步回调没执行

Windows 上 `taskkill /F /T /PID` 硬杀进程，所有异步回调、error hook、flush 操作全部跳过，进程直接消失。
确认 force-kill 后 → 找谁发了 `taskkill`（查其他 Node 进程、`killStalePidIfSafe`、`killPidTree` 调用点）。

### PID 文件只写不杀

`src/index.js` 启动时不读旧 PID、不调 `killPidTree`。PID 文件（`~/.cyberboss/cyberboss.pid`）**仅用于外部查询**。

历史上这里会杀旧进程，导致调试时两个实例互相 kill——一个实例的启动流程触发对另一个的 `taskkill /F /T`，被 kill 方静默消失。

### 排查顺序（不可跳层）

```
1. 系统层（先查这里）
   tasklist | findstr node
   tasklist | findstr claude
   type %USERPROFILE%\.cyberboss\cyberboss.pid

2. 数据层
   type %USERPROFILE%\.cyberboss\sessions.json

3. JS层（最后查这里）
   加同步 checkpoint 日志缩小范围（见下方）
```

### 同步 checkpoint 定位法

crash 绕过所有 error hook 时，用 `fs.appendFileSync` 打点定位死亡窗口：

```js
const ck = (msg) => { try { require("fs").appendFileSync("D:/cyberboss-app/crash-ck.txt", `${Date.now()} ${msg}\n`); } catch {} };
ck("checkpoint-label");
```

最后一个出现的 checkpoint 和下一个未出现的 checkpoint 之间的代码就是死亡区间。**必须同步写**——异步写在进程被杀前来不及 flush，日志为空。

### Windows 注意事项

- 杀进程只用 `taskkill /F /T /PID`，SIGTERM 无效
- 调试时手动启动主进程，确认不会和 `shared-start.js` 冲突

---

## 死循环规则

**同一文件改了 3 次问题还在 → 立刻停，不许继续改代码。** 大概率根因不在这一层。

停下来回答这三个问题：
1. 我假设的根因是什么？有没有直接证据？
2. 这个问题在哪一层？`[ ] JS逻辑层` `[ ] 系统进程层` `[ ] IPC通信层` `[ ] 配置/数据层`
3. 我还没检查过什么？

回答完再决定下一步。

---

## VS Code Remote ExtHost Watchdog

```
/root/scripts/claude-code-watchdog.sh
```

VS Code Remote-SSH 的第一个 Extension Host 有时不会自动激活用户扩展（包括 Claude Code），导致 Code 一直不可用。Watchdog 检测到 ExtHost 启动 90 秒后仍无扩展激活时，SIGKILL 触发 VS Code Server 重建。

### 运行方式

`.bashrc` 中 `nohup` 启动，每次开 VS Code Remote 终端时自动拉起。脚本自带 PID 锁（`/tmp/claude-code-watchdog.lock`），保证只有一个实例。

### 安全检查

| 机制 | 说明 |
|---|---|
| PID 锁 | `LOCK_FILE` → 旧 PID 存活则静默退出，僵死则清理 |
| `trap EXIT` | 退出时自动清锁文件 |
| 宽限期 | 90s，给 VS Code 足够时间初始化 |
| 冷却期 | 每次 kill 后 180s 冷却，等替换 ExtHost 激活 |
| 上限 | 每个 watchdog 生命周期最多 kill 3 次 |
| 去重 | 同一 PID 不重复 kill |
| 目标范围 | 只匹配 `bootstrap-fork.*extensionHost`，不碰其他进程 |

### 常见问题

**开了 18 个 watchdog 实例**（已修复）：
- 根因：`.bashrc` 每次开 shell 都 `&` spawn，无防重复机制
- 修法：脚本加 PID 锁 → 只有第一个实例存活，后续全部静默退出

**ExtHost 崩溃 ≠ watchdog 干的**：
- 先看 ExtHost 日志：`/root/.vscode-server/data/logs/<date>/exthostN/remoteexthost.log`
- 搜 `_doActivateExtension` 看激活数，搜 `Error` 看扩展自身报错
- 如果日志里没有 `signal 9`/`SIGKILL`，就不是 watchdog 杀的
- 最近一次 Copilot 扩展报 `Error: e is not iterable`，是 Copilot 自己的 bug

### 手动管理

```bash
# 查看是否在跑
cat /tmp/claude-code-watchdog.lock && kill -0 $(cat /tmp/claude-code-watchdog.lock) && echo "running" || echo "dead"

# 停掉
kill $(cat /tmp/claude-code-watchdog.lock)

# 手动启动
nohup /root/scripts/claude-code-watchdog.sh &>/dev/null &
```
