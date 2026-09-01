# Cyberboss Core + NCP 统一工具架构

> 状态：最终实施版；生产切换需 uu 单独授权重启
> 日期：2026-09-02

## 1. 最终结构

```text
主 CC（唯一人格与权限判断者）
  ├── Core Fast Path：17 个固定工具
  │     ├── 3 个 Ombré 记忆 facade
  │     └── 日记、时间轴、提醒、文件、贴纸、位置和工作上下文
  └── NCP Runtime：固定 find/code，动态 registry，有界 workflow
        ├── 并行日志、工作区、Garden 和 Browser 读取
        ├── 在一次 workflow 内执行依赖链
        └── 继承主模型当前任务权限执行受控修改与交互
```

主对话不再使用 ToolSearch/MCPSearch。顶层 schema 只在进程启动时确定；新 MCP 作为 NCP registry 数据加入，不热插入长会话前缀。

## 2. Core Fast Path

`core-v1` 精确保留 17 个工具。其中 14 个是已实现的对话 Core，记忆收敛为：

- `cyberboss_memory_recall`：`surface/search/source/letters/self`，路由至 `breath*`、`source_read`、`letter_read`和 `I(read)`。
- `cyberboss_memory_record`：`memory/digest/plan/letter/self`，路由至 `hold`、`grow`、`plan`、`letter_write`和 `I(write)`。
- `cyberboss_memory_revise`：精确 ID 修订、局部替换、anchor 切换、Letter 锁、归档/恢复和自我候选晋升。

Ombré 仍是唯一记忆数据和生命周期所有者。Cyberboss adapter 不复制数据，不介入衰减和 dream。`dream`、`pulse`、`hard_delete`和测试数据控制不向主模型暴露。

Ombré 上游凭据迁到私有 state file，不写入仓库、日志或工具结果。迁移成功后从主 CC `.mcp.json` 移除 `ombre-brain` 直连。

## 3. NCP 的职能与权限

NCP 是工具 workflow 执行边界，不是第二个 Agent。主 CC 负责目标、权限和结果判断；NCP 负责发现和执行。

### 路由规则

- 单个、确定、人格相关的动作直接走 Core。
- 已知 NCP 能力直接 `code`；陌生能力或 registry 变更后才 `find`。
- 有两个以上可用操作，或有 search/read/edit/test 依赖链时，提示主 CC 优先生成一次 NCP workflow。
- 互不依赖的操作最多 4 路并行；有依赖的操作在同一 workflow 串行。
- 保留原生 Read/Grep/Bash 作为简单任务和故障回退，不硬禁；记录本可聚合却被拆散的 routing miss。

### 能力与界限

`read-only` registry 提供 Garden、Browser observation/navigation、受限 journal、workspace search/read/status/diff。

`guarded-write` 额外提供：

- workspace patch：限定工作区，强制 SHA-256、单文件、64KB patch 上限、`git apply --check`、同资源串行和回读。
- test：仅 syntax 和 `test/*.test.js` 定点路由，不提供任意 shell。
- Browser interaction：click/type/press/select/fill，必须继承当前任务授权。
- Cyberboss 重启仍需 uu 单独明确确认，且只能通过 `scripts/restart-now.sh`。

NCP 获得与主模型当前任务相同的有效权限：

- `within_existing_authority`：uu 当前请求已明确覆盖该工作。
- `user_confirmed`：uu 已在后续回合明确确认。

授权由主运行时传入当前 operation，NCP 不能自签、扩大目标或跨 operation 复用。NCP 仍禁止 MCP 安装、schedule、Photon/Skill 动态安装、任意 shell/文件系统/网络以及日记、时间轴和 Ombré 内部 writer。

## 4. 8 月 31 日问题的改变

当日 monitor、system overview 和 logs 被分多轮串行调用；`searchFiles → readFile` 依赖链反复回到模型；多次 `runCommand` 各自经历确认循环。

新路径先用 `Promise.all` 并行 monitor/overview/logs/search，再在同一 workflow 内顺序 read；当前任务已授权修复时，继续 patch → readback → targeted tests。

单个慢调用本身不会被 NCP 变快，但会与无依赖检查重叠，且不再为每个中间结果新增一轮模型调用。因选择“提示优先”而非硬禁原生工具，会显著降低重演概率，但不做 100% 路由强制保证。

## 5. 缓存、上线与回滚

固定前缀为 system prompt + 17 个 Core schema（包含 NCP find/code）+ history。记录 Core/NCP fingerprint、token/cache breakdown、NCP operation/call ID、耗时、并发度、返回大小和 routing miss；不记录凭据、表单值或记忆正文。

```text
CYBERBOSS_MAIN_TOOL_SURFACE=legacy | core-v1
CYBERBOSS_NCP_NATIVE=off | read-only | guarded-write
ENABLE_TOOL_SEARCH=true | false
```

上线：定点测试 → `npm run baseline:check` → 隔离 smoke → uu 授权重启 → 验证 17 工具、无 ToolSearch、Ombré facade、NCP 并行和后台周期 → 对比 8 月 31 日用量。

回滚：恢复 `ENABLE_TOOL_SEARCH=true`、`CYBERBOSS_NCP_NATIVE=read-only`、legacy surface 和私有 state 中的 Ombré 直连。不更换主 thread，不迁移或回写领域数据。

## 6. 验收标准

- `core-v1` 精确 17 个工具，调用记忆或 NCP 后 fingerprint 不变。
- ToolSearch/MCPSearch 不再出现，Ombré 底层 schema 不进入主会话。
- Ombré 故障不影响其他 Core；NCP 故障不影响 Core 和自然回复。
- NCP 能完成 4 路独立读取和同 workflow 内的 search/read/edit/readback/test 依赖链。
- 未携带当前任务授权的 guarded tool 拒绝执行；NCP 不能安装能力或访问未注册资源。
- SHA 冲突、路径越界、超大 patch、任意 test/shell、超时和迟到结果全部 fail closed。
- 首次冷缓存后，不再出现由 schema 插入导致的 17k–127k uncached 峰值。

## 7. 明确不做

- 不实施旧 Ombré lifecycle integration plan。
- 不把 NCP 变成第二个人格、安排者或授权者。
- 不建第二套工具网关、workflow 数据库或自研 DSL。
- 不将日记、时间轴、记忆或提醒的数据所有权交给 NCP。
- 不通过扩大 token、超时或并发上限掩盖错误规划。
