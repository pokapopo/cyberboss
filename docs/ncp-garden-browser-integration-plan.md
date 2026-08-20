# Cyberboss 统一 Token 优化方案

## 1. 结论

将原 NCP 方案收束为一套统一、可分阶段落地的 Token 优化架构。核心目标是减少同一份长上下文被后台任务、工具续跑和中途插话反复读取，同时保持 cc 的人格、关系和可见对话连续性。

NCP 仍是独立的下游工具聚合器，只负责 Garden / Playwright 的只读调用与短结果返回。它不接管 Cyberboss 的消息队列、TurnGate、调度、记忆、人格或微信投递。

建议引入可复用的 **通用 Agent Runtime + 模型网关**。第一阶段仍可与 Cyberboss 同进程部署，但模块、接口和持久化 schema 不得依赖微信或 Cyberboss 私有字段，之后可由现有前端网关直接复用，而不是重做计量、预算和取消逻辑。

## 2. 现状与主要浪费

当前实现已经具备单一 SystemMessageQueue、TurnGate、5 秒消息防抖、微信 live steering、上下文 rollover 和基础 work log，但存在以下缺口：

- check-in 默认每 3–60 分钟随机触发，只检查系统队列是否已有任务；即使没有新增事件也会启动主模型。
- 增量日记默认每 30–60 分钟触发，只延迟到微信静默窗口后执行，没有已处理消息游标。
- check-in、增量日记和每日 finalize 都复用微信主线程，因此每次模型续跑都会读取长主会话。
- finalize 依赖模型重新理解当天材料，缺少稳定的日内摘要与事件增量输入。
- live steering 通过“中断当前物理执行，再向同一逻辑 turn 写入新消息”实现；竞态或连续插话会产生已付费但被废弃的推理，并再次携带长上下文。
- runtime 已上报 input、cache-read、cache-create 和 output token；work log 也记录 source / triggerKind，但两者尚未形成按任务累计的 token、成本、取消和重试账本。
- 主线程启动时注入人格和操作说明，工具由项目 MCP 配置暴露；固定前缀和工具目录变化尚未作为缓存命中率指标管理。

最近用量审计显示，主要放大项是长上下文的 cache-read，而不是用户可见输出。因此优先级应是减少模型请求次数和每次请求携带的历史，而不是压缩 cc 的人格文本或削弱关系连续性。

## 3. 架构边界

```text
微信 / Garden Wake / 系统触发
             │
             ▼
  渠道适配 / 前端网关 / 系统触发
             │
             ▼
  通用 Agent Runtime
  ├─ task envelope、增量游标、后台节流、取消重算、任务预算
  └─ 工具结果压缩、幂等状态与生命周期事件
             │
             ▼
  模型网关
  ├─ 模型路由、调用重试、用量/成本限制
  └─ Prompt Cache 指纹与命中监控
             │
       ┌─────┴──────────────┐
       ▼                    ▼
 cc 主模型/主会话       便宜模型或确定性处理
       │
       └── NCP 标准工具接口 ── Garden / Playwright 只读工具
```

不变量：

- 通用 Runtime 拥有与渠道无关的 task/run 生命周期；Cyberboss 只把现有 Queue、TurnGate 和领域状态映射到通用接口。
- 微信适配器只负责渠道收发、typing/context token 等渠道语义，不承载预算、增量或取消策略。
- cc 的人格、关系上下文和用户可见回复留在主模型路径。
- TOL 只做准入、输入裁剪、路由和计量，不自行消费微信消息，也不创建隐藏对话人格。
- NCP 保持独立，通过标准调用/结果/usage 接口接入，不读取 Cyberboss 私有队列或状态文件。

## 4. 通用 Agent Runtime 与模型网关

### 4.1 通用 Agent Runtime

Runtime 不理解“日记”“微信”“Cyberboss”或“uu”，只提供六类能力：

1. **Task lifecycle**：统一任务准入、运行、取消、替代执行、完成和不确定状态。
2. **Budget admission**：消费网关返回的成本聚合，执行单任务/小时/日预算及后台降频。
3. **Adaptive throttle**：根据连续空跑、事件密度、失败和成本调整后台任务间隔。
4. **Incremental cursor**：提供 source + scope 游标、幂等提交和重启恢复。
5. **Tool result compression**：用统一 result envelope 截断、摘要、去重，并保留证据 ID、状态和截断标记。
6. **Cancellation/recompute**：合并连续改向，隔离被取消 run 的副作用，并给替代任务传短 continuity delta。

统一接口：

- `admit(taskEnvelope) -> run | skip | defer | downgrade`
- `readDelta(source, scope, cursor) -> items + nextCursor`
- `requestCancel(runId, replacementDelta) -> cancellationState`
- `compressToolResult(toolResultEnvelope, policy) -> compressedEnvelope`

`taskEnvelope` 使用稳定通用字段：`taskId`、`runId`、`source`、`kind`、`priority`、`visibility`、`background`、`scope`、`continuityKey`、`idempotencyKey`、`budgetClass`、`modelClass`、`createdAt`、`metadata`。渠道与业务私有字段只能放在 namespaced `metadata` 中。

### 4.2 模型网关

模型网关是所有模型提供商调用的唯一计量边界，供 Cyberboss Runtime 与现有前端 API 共同调用：

- `invoke(modelRequestEnvelope) -> modelResultEnvelope/event stream`
- `recordUsage(runId, providerUsage) -> costAggregate`
- `route(modelClass, capabilities, budget) -> provider/model`
- `getBudgetState(scope) -> soft/hard limits + consumption`

它负责提供商模型映射、有限重试、用量去重、价格表、软硬成本限制、固定前缀/工具目录指纹及 cache-read/cache-create 监控。Runtime 不内置价格与提供商重试策略；微信和前端不自行重复统计。

### 4.3 Cyberboss 适配层

适配层负责把现有字段映射到通用接口：`triggerKind`、`bindingKey`、`workspaceRoot`、`threadId`、`turnId`、消息 ID、TurnGate 状态和系统队列记录。

它决定：

- 哪些微信消息或事件构成 check-in / 日记的新增输入。
- 游标何时提交：只有任务成功并完成必要写入后提交；失败、取消或结果不确定时保留原游标。
- 用户 turn 是否正在运行，以及后台任务应跳过、延后还是降级。
- 哪些结果需要交给 cc 主模型形成用户可见回复。

第一版不增加队列或 daemon。可复用 Runtime/网关接口先采用本地实现和原子 JSON backend；Cyberboss 适配器负责 `triggerKind/bindingKey/TurnGate` 映射，前端 API 使用同一 task/model envelope。未来替换远端 backend 时无需修改渠道协议。

## 5. 核心优化

### 5.1 Check-in 事件门控与自适应降频

check-in 在启动任何模型前先做确定性门控：检查上次 check-in 后是否出现新微信消息、Garden Wake、提醒到期、位置/时间轴变化或其他明确事件。

- 无新增事件：直接记录 `skip:no_delta`，不恢复主会话、不调用模型。
- 有新增事件但只需结构化判断：由规则或便宜模型生成短判断结果。
- 只有确实需要以 cc 身份主动联系时，才把短事件摘要交给主模型生成最终消息。
- 连续空跑时按阶梯或指数方式扩大间隔；新用户消息、重要事件或到期提醒到来时恢复正常区间。
- 降频状态持久化，重启后不重置为空闲高频轮询。

check-in 不再读取完整主 transcript。它只接收稳定人格约束、最近必要状态和自上次游标后的短事件包。

### 5.2 增量日记与 finalize

增量日记改为 delta pipeline：

- 为每个用户/工作区维护已处理消息游标和事件游标。
- 每次只读取上次成功处理后的新用户消息、相关 cc 回复摘要以及新增时间轴观察。
- 无 delta 时直接跳过；相同消息 ID 不重复抽取。
- 事实抽取、去重和草稿归并优先使用规则或便宜模型，结果写入现有日记碎片/时间轴接口。
- 增量任务不得要求模型重新浏览主会话。

每日 finalize 只使用：当天已确认事件、增量日记碎片、滚动日内摘要、未决观察和必要的短证据引用。它负责合并与最终表达，不重新读取完整 transcript。finalize 成功后原子提交当天游标和摘要状态；失败或发送失败仍遵守现有 finalize 不盲目重试的契约。

本方案不改变长期记忆的提取、审批或写入规则。

### 5.3 生成中插话、取消与重算

保留现有 5 秒消息防抖，不新增第二套防抖或等待窗口。

优化点放在模型执行边界：

- 同一 5 秒窗口内仍按现有逻辑合并消息。
- 生成中的新消息先区分“补充”“纠正/改向”“新任务”；能追加为轻量增量输入时，不重建完整 turn。
- 必须改向时，取消链路要有明确的 `requested / acknowledged / completed / uncertain` 状态；旧执行结果不得在取消后触发写操作或用户投递。
- 连续 steering 在上一取消未确认前合并为一个最新方向，避免多次 interrupt/restart。
- runtime 支持时使用同一会话的增量输入；不支持时采用短连续性摘要启动替代执行，而不是把完整 transcript 再拼入新请求。
- 记录被废弃执行已经消耗的 token，并把它归因到 `cancelled_recompute`，用于异常告警。

消息不丢失和顺序正确优先于节省 token；不确定状态禁止自动重放任何外部写操作。

### 5.4 固定前缀与工具按需暴露

- 系统提示、人格、关系说明和稳定操作规则使用版本化内容指纹；未发生真实变更时保持字节、顺序和分段稳定。
- 当前时间、事件、delta 和任务说明统一放在动态后缀，避免污染可缓存前缀。
- 指令刷新只在版本变化时发生，不把周期性后台任务写入固定人格层。
- Cyberboss 与 Ombré 的核心小工具保持直连；Garden / Playwright 读取通过 NCP 按需发现和调用。
- 不为同一能力同时暴露直连与 NCP 两套重复入口。
- 工具目录变化、前缀指纹变化和 cache-read 命中情况进入 usage ledger。

暂不建设 Context Compiler，也不尝试重写或动态拼装整段历史。

### 5.5 后台模型路由

推荐三级路径：

- **规则层**：事件是否为空、游标比较、ID 去重、预算判断、简单合并和安全门控。
- **便宜模型层**：事实抽取、候选去重、短摘要、分类和低风险后台判断。
- **cc 主模型层**：所有用户可见回复、亲密/关系表达、复杂判断，以及需要人格连续性的最终日记文字。

便宜模型输出必须是结构化候选，不得直接伪装成 cc 向用户发送；关键事实仍由现有证据和写入接口校验。

## 6. NCP 边界

NCP 只聚合 Garden / Playwright 的只读调用，并在完整结果进入主会话前裁剪：

- 每批最多 4 个互不依赖的读取，默认 20–30 秒超时。
- 最终返回默认不超过约 4,000 字符，包含摘要、必要 ID、截断标记和各下游调用状态。
- 一个读取失败不重试整批；超时或取消返回明确状态。
- 不返回完整 HTML、无障碍树、Cookie、认证头或大列表原文。
- NCP scheduler、MCP 自管理和其他内部自动化能力显式禁用。

读写隔离继续保留：发帖、回复、点赞、关注、点击、填写、上传和提交不进入并行只读批次。外部写操作保持单次、串行、可核查；成功返回对象 ID/链接，`uncertain` 时先只读核查，禁止盲目重试。

NCP 通过标准 envelope 返回 `calls[]`、耗时、状态、截断量和可选 usage；TOL 只消费这些元数据，不依赖 NCP 私有配置或调度能力。

## 7. 统计、预算与告警

最小统计维度：

- 来源：user_chat、live_steering、checkin、diary_incremental、diary_finalize、garden_wake、其他系统任务。
- 模型与 runtime、thread/turn/run、工具阶段数和 NCP 子调用数。
- input、cache-read、cache-create、output、估算成本和延迟。
- completed、failed、cancelled、uncertain、retry，以及被取消后浪费的 token。
- delta 输入数、跳过原因、游标跨度、摘要/裁剪前后大小。

预算只自动约束后台任务：支持单任务、小时、日预算和来源配额。达到软阈值时告警并降级模型或延长间隔；达到硬阈值时跳过非必要后台任务。提醒、明确用户请求和必要的最终投递不得因后台预算被静默丢弃。

当前 Cyberboss 适配的安全默认值按总 Token 计：单任务软/硬阈值 25 万/50 万，小时 100 万/200 万，每日 500 万/1000 万；均可由部署环境覆盖或显式设为 0 关闭。价格表存在时，成本阈值与 Token 阈值并行生效，任一超限即触发相应策略。

异常告警至少覆盖：后台 cache-read 突增、连续空跑、同一任务重复游标、取消未确认、写操作不确定后重试、单任务工具轮次或成本异常。

## 8. 实施阶段

### 阶段 1：统一计量与基线

- 把 runtime usage 归并到 work log/run，建立按来源、模型、取消和重试的账本。
- 增加成本表、后台预算策略和只告警不拦截的观察模式。
- 记录固定前缀与工具目录指纹。

### 阶段 2：后台任务增量化

- 增加通用增量游标和 Cyberboss 事件适配。
- check-in 上线无事件跳过和连续空闲降频。
- 增量日记只处理 delta；finalize 改用日内摘要与事件集合。
- 先以影子模式对比旧输入和新输入，再切换写入权威。

### 阶段 3：取消与重算优化

- 完善 steering 分类、连续插话合并和取消状态机。
- 阻断取消后旧结果的写入/投递，统计废弃 token。
- 为 runtime 增量输入和短连续性替代路径做能力协商与回退。

### 阶段 4：NCP 只读试点与工具按需暴露

- 固定验证过的 NCP 版本，显式关闭内部调度/自管理能力。
- 通过严格只读边界接入 Garden / Playwright，验证短返回和部分失败。
- 避免重复工具入口，完成慢读取 steering、超时、进程退出和重启测试。

### 阶段 5：预算执行与调参

- 从观察模式切换为后台软预算、硬预算和超额降频。
- 按真实数据调整 check-in 退避、delta 批量、模型路由和 NCP 截断阈值。
- 连续观察 3–7 天，与同类任务基线比较。

## 9. 验收标准

- cc 的人格、关系表达和主对话连续性无可感知退化。
- check-in 无新增事件时不调用模型；连续空闲会持久化降频，新事件能恢复正常节奏。
- 增量日记只读取游标后的消息；重复触发不重复写入。
- finalize 不读取完整 transcript，仍能从摘要、事件和证据生成完整日记并遵守现有发送契约。
- 保留唯一 5 秒防抖；连续插话最多形成一次待确认取消和一次替代执行。
- 被取消的旧执行不能产生外部写入或用户投递，取消/重算 token 可统计。
- 固定前缀无配置变化时指纹稳定；动态数据不进入固定前缀。
- 后台判断可以降级到规则/便宜模型，用户可见回复始终由 cc 主模型生成。
- 每个 run 可按来源查看 token、估算成本、取消、重试和工具阶段。
- 后台预算超限会告警并降频，不影响明确用户消息和必要投递。
- NCP 仅暴露允许的只读路径；写操作串行、幂等核查、超时不盲重试。
- 同等活动量下，后台任务 cache-read 降低至少 70%；全日重复上下文读取降低至少 50%。两者以 3–7 天对照数据验收。

## 10. 重启、幂等与回滚

- 游标、预算窗口、退避状态和 usage ledger 使用原子持久化；重启后从最后成功提交点继续。
- 写操作保留现有对象 ID、幂等核查和 `uncertain` 保护；取消或断连后先读后写。
- 通用 Runtime 或模型网关故障时可切换为观察/旁路模式，恢复现有 Cyberboss 准入与模型路径，不迁移消息队列。
- delta pipeline 可按任务来源单独关闭，回退到现有 check-in/日记流程；旧游标保留但不推进。
- 模型路由可逐项回退到 cc 主模型，规则层不得阻塞用户 turn。
- NCP 回滚只需移除其 MCP 入口并恢复 Garden / Playwright 直连；它不拥有 Cyberboss 队列、thread 或业务状态。
- 固定前缀策略可通过版本指针回退到上一份已验证的人格/工具清单。

## 11. 明确不做

- 不建设 Context Compiler。
- 暂不调整长期记忆的提取、审批和写入规则。
- 不建立第二套消息队列、scheduler、人格 Agent 或工作流引擎。
- 不让便宜模型直接生成用户可见的 cc 回复。
- 不把 NCP 与 TOL 强耦合，也不让 NCP 承担预算、记忆或调度职责。

最终原则：**主会话只承担关系连续性、复杂判断和最终表达；后台工作以事件增量运行；每一次长上下文读取都必须能够归因、计量并受到预算约束。**
