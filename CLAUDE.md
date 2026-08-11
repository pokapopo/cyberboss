# cyberboss-app

## 多 Agent 协作入口

开始任何项目任务前，先阅读 `.agent-coordination/README.md`、`STATUS.md`、`DECISIONS.md`、双方的 `handoffs/` 文件以及相关 `tasks/` 文件。CC 维护 `handoffs/claude.md`；完成、暂停或阻塞时同步更新任务文件、自己的 handoff 和 `STATUS.md`。共享目录不得记录密码、Token、Cookie 或 `.env` 内容。

## 架构

详细架构见 memory: `project-architecture`。要点：`shared-start.js` 守护主进程，主进程写 PID 仅用于外部查询不杀旧进程，claude 子进程由 `process-client.js` 管理。

## 调试

调试方法论已迁移至经验库（`cyberboss_experience_search`），遇到问题时先检索：
- `force-kill-pattern-recognition` — 退出码1+无crash handler → 被外部强杀
- `investigation-order` — 系统层→数据层→JS层，不可跳
- `sync-checkpoint-method` — fs.appendFileSync 打点定位死亡区间
- `dead-loop-rule` — 同文件改3次立刻停
- `pid-file-read-only` — PID 文件只写不杀
- `experience-record-workflow` — bug 修复后写入经验库的流程

## VS Code Remote ExtHost Watchdog

`/root/scripts/claude-code-watchdog.sh` 守护 VS Code Remote-SSH ExtHost，卡死在 workspace lock 竞争时 90s 超时 SIGKILL 触发重建。故障排查与设计机制已入库（`cyberboss_experience_search`）：
- `watchdog-design-mechanisms` — PID 锁、宽限期、冷却期、kill 上限、去重、目标范围、健康判断
- `watchdog-18-instances-bashrc-spawn` — 重复 spawn 根因与修复
- `exthost-crash-not-watchdog` — 判断 ExtHost 崩溃是否 watchdog 所致

```bash
# 查看是否在跑
cat /tmp/claude-code-watchdog.lock && kill -0 $(cat /tmp/claude-code-watchdog.lock) && echo "running" || echo "dead"

# 停掉
kill $(cat /tmp/claude-code-watchdog.lock)

# 手动启动
nohup /root/scripts/claude-code-watchdog.sh &>/dev/null &
```

---

## 浏览器自动化

2026-08-10 安装了 `ai-social-browser`，并让 `@playwright/mcp`（v0.0.79）通过 CDP 连接它的常驻 headed Chromium。可通过 MCP 工具操作任意网站，不需写脚本；浏览器登录态保存在独立的持久 profile 中。配置在 `.mcp.json` 的 `playwright` 块。

### 可用工具（重启后生效）

- `browser_navigate` — 导航到 URL
- `browser_click` — 点击页面元素
- `browser_snapshot` — 读取页面无障碍树（结构文本）
- `browser_evaluate` — 在页面执行 JS
- `browser_type` / `browser_fill` — 输入文本
- `browser_screenshot` — 截图
- `browser_drag` — 拖拽

### 使用原则

- 浏览器操作优先使用 MCP 工具，不要写 Playwright 脚本
- 浏览器由 `browser-core.service` 常驻后台，页面和登录态在工具调用及 Cyberboss 重启后保留
- 通用浏览器 MCP 连接 `http://127.0.0.1:9333`；CDP、手机控制台和动作服务均只监听 localhost，不得改成公网监听
- 通用浏览器 MCP 每次开始网页任务时，必须先用 `browser_tabs` 创建一个自己的新标签页，再在该页导航；如需固定桌面尺寸，只能对这个新建页使用 `browser_resize`（默认 1100x1300）。不得导航、缩放、关闭首次连接时已经存在的人工标签页。手机控制台会为后建的 AI 标签创建独立的手机尺寸伴随页并跟随其网址；AI 原标签保持桌面 viewport，AI 不得操作或关闭伴随页
- 人工登录、验证码或风控接管使用 `https://browser.uuhalo.xyz` 的手机触屏控制台；公网先经过现有 Nginx Basic Auth，再使用控制台第二层密码。登录凭据只在浏览器中输入，不导出 cookie，不把账号密码交给 Agent
- `browser-mobile-console.service` 仅监听 `127.0.0.1:8274`，提供二进制低延迟画面、直接触摸、键盘和标签页控制；noVNC、VNC 与旧 relay 服务已移除
- X 专用动作服务为 `http://127.0.0.1:8272/twitter`，小红书只读动作服务为 `http://127.0.0.1:8273/xiaohongshu`；优先使用这些结构化动作处理对应平台
- 社交写动作返回 `uncertain` 时禁止自动重试，避免重复发布；遵守服务端频率闸并只使用专门小号
- 复杂交互（排序、上传、弹窗）通过 `evaluate` 跑 js 处理
