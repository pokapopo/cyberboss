# Cyberboss 接入 NCP 的轻量实施方案

## 1. 结论

可以接入 NCP，但第一版只把它当作 **Garden 与 Playwright 的工具聚合层**：在一次外层工具调用中完成多个独立读取，并且只把经过筛选的短结果交回主会话。

Cyberboss 继续独占消息队列、TurnGate、系统调度、微信投递、人格上下文和内部业务工具。NCP 不接管这些职责，也不开启自己的 scheduler。

这套接法不会直接与现有消息队列竞争。主要风险不在排队，而在任务中断后的下游取消、写操作重复，以及嵌套工具调用的可观察性。第一版通过“只并行读取、写操作隔离、短超时、保留外层执行摘要”控制风险。

## 2. 目标

- 保留 cc 的同一主会话、人格和关系上下文。
- 减少 Garden / 浏览器任务中“一次只调一个工具”造成的模型续跑。
- 避免下游 MCP 的中间大结果全部进入主会话 transcript。
- 不改变微信消息、Garden 唤醒和系统维护消息的排队顺序。
- 保持发帖、回复、点赞、登录和表单提交等写操作可确认、可核查、不可盲目重试。
- 接入足够轻，出现问题时能够直接撤回 NCP 配置，恢复原来的直连方式。

## 3. 非目标

- 不建立第二套消息队列、Agent 或工作流引擎。
- 不让 NCP 管理日记、时间轴、记忆、提醒或微信发送。
- 不启用 NCP scheduler、自动任务或其他内部调度能力。
- 第一版不建设通用 Result Vault，也不要求向量检索先完成。
- 不并行执行任何会改变外部状态的操作。
- 不追求一次调用完成整个浏览器任务；有顺序依赖的步骤仍然逐步执行。

## 4. 接入后的数据流

```text
微信消息 / Garden Wake / 系统消息
                │
                ▼
   Cyberboss SystemMessageQueue
                │
                ▼
        TurnGate + 主会话
                │
                ▼
             Claude
                │
                ├── 直连：Cyberboss / Ombré 工具
                │
                └── NCP code
                      ├── Garden MCP
                      └── Playwright MCP
```

关键点：NCP 位于 Claude 的下游，只是当前 turn 内的一次工具调用。它不读取 Cyberboss 的入站队列，也不创建新的 Cyberboss turn，因此不会成为第二个消息消费者。

## 5. 工具边界

| 能力 | 第一版路径 | 原因 |
|---|---|---|
| 微信消息接收与发送 | Cyberboss 直连 | 保留 context token、重试和投递语义 |
| 系统消息、Garden Wake | Cyberboss 队列 | 保持统一准入和排队顺序 |
| TurnGate、live steering | Cyberboss runtime | NCP 不拥有会话生命周期 |
| 日记、时间轴、提醒、文件、位置 | Cyberboss 直连 | 避免内部状态和审批语义被隐藏 |
| Ombré 记忆 | 直连 | 保留 runtime 元数据和记忆行为 |
| Garden 读取 | NCP | 可聚合独立读取并压缩返回 |
| Garden 写入 | NCP 单独调用或暂时直连 | 不能批量、不能不确定重试 |
| Playwright 页面读取 | NCP | 可在稳定页面上筛选必要文字 |
| Playwright 导航、点击、填写、提交 | NCP 串行调用或暂时直连 | 页面状态存在明确依赖 |
| NCP scheduler / MCP 管理 | 禁用 | 防止形成第二套调度与状态来源 |

## 6. NCP 解决什么、不解决什么

### 6.1 可以解决

NCP Code Mode 可以在一次外层调用内执行多个下游 MCP 调用。对互不依赖的读取使用 `Promise.all` 后，Claude 只需要在整批结束时续跑一次。

示意：

```ts
const [notifications, activity, profile] = await Promise.all([
  garden.list_notifications({ limit: 10 }),
  garden.list_activity({ limit: 10 }),
  garden.get_self({}),
]);

return {
  notifications: pickUsefulText(notifications),
  activity: pickUsefulText(activity),
  profile: pickUsefulText(profile),
};
```

三个原始结果只在 NCP 执行环境中使用。只要最终 `return` 保持精简，中间数据不会全部进入 Claude 主会话。

### 6.2 不能自动解决

NCP 不会自动把大结果存成 `artifact_id`。Code Mode 最终返回的对象仍会序列化进入主会话；如果代码直接返回完整页面或完整帖子列表，仍然会消耗大量上下文。

因此第一版必须遵守一个简单规则：

> NCP 内部可以读取完整结果，但最终只返回当前判断需要的字段和文字。

如果上线后确实频繁需要找回已经省略的文字，再接入现有《工具结果外置与并行读取实施计划》中的 Result Vault。它是可选第二阶段，不作为 NCP 试点的前置条件。

## 7. 最终返回格式

每次 NCP 调用返回短结果和轻量执行摘要，不返回日志、HTML、完整无障碍树或认证信息。

```json
{
  "ok": true,
  "summary": "找到 8 条通知，其中 2 条需要回复。",
  "items": [
    {"id": "...", "author": "...", "text": "..."}
  ],
  "calls": [
    {"tool": "garden.list_notifications", "ok": true, "duration_ms": 420},
    {"tool": "garden.list_activity", "ok": true, "duration_ms": 510}
  ],
  "truncated": false
}
```

初始限制：

- 最终结果建议不超过 4,000 字符。
- 每批最多 4 个独立读取。
- 单项失败只记录该项失败，不自动重跑整批。
- 不把 Cookie、请求头、Token、表单密码或完整页面源码写入返回值和日志。
- 需要更多文字时，由 Claude 发起一次更具体的读取，不在 NCP 内无限搜索。

## 8. 并行边界

### 8.1 允许并行

- Garden 的通知、动态、个人资料等互不依赖的列表读取。
- 已知多个帖子 ID 后，并行读取各帖正文。
- 已稳定加载页面上的只读信息，并且读取之间不会改变页面状态。
- 多个独立 URL 的文本提取，但每个 URL 使用独立页面或独立上下文。

### 8.2 必须串行

- 导航 → 页面加载 → snapshot。
- 点击 → 弹窗出现 → 读取弹窗。
- 登录 → 验证码人工接管 → 登录后检查。
- 查找帖子 → 决定是否回复 → 写入回复 → 验证结果。
- 任何发帖、回复、点赞、关注、删除、编辑、上传或表单提交。

并行只用于减少独立读取的模型往返，不用于把一个有状态流程强行压成一批。

## 9. 与消息队列和 turn 生命周期的兼容

### 9.1 正常排队

Cyberboss 的 SystemMessageQueue 和 TurnGate 保持唯一权威。NCP 调用运行期间，新的微信消息仍按现有逻辑尝试 live steering；不能 steering 时继续进入 Cyberboss 的 pending 队列。NCP 不直接接触这些消息。

### 9.2 中途插话与取消

当前 NCP 实现没有足够明确的下游取消传播保证。外层 turn 被打断时，已经发出的 Garden / Playwright 请求可能继续运行到完成或超时。

第一版保护：

- 并行批次仅包含读取操作。
- 单个 NCP 批次设置 20–30 秒超时。
- 不在一个 NCP 调用中执行长时间等待、验证码等待或轮询。
- 收到 steering 后，不复用旧调用结果执行新的写操作。
- 上线前必须进行“慢读取期间微信插话”的定点测试。

后续只有在确认取消可以从 Cyberboss → Claude MCP client → NCP → 下游 MCP 完整传播后，才考虑让较长任务进入 NCP。

### 9.3 服务重启

NCP 作为 Claude 管理的 stdio MCP 子进程运行，不单独消费 Cyberboss 持久队列。验证时需要确认 Claude 结束或 Cyberboss 重启后，NCP 及其下游连接能够退出，且不会在恢复后重复写入。

## 10. 写操作保护

第一版的写操作遵守以下规则：

1. 一个 NCP 调用最多执行一个外部写操作。
2. 写入前所需读取可以先完成，但不得把多个候选写动作一起提交。
3. 返回实际对象 ID、链接、写入文本摘要和服务端状态。
4. 返回 `uncertain`、连接断开或外层超时时，禁止自动重试。
5. 重试前先用只读工具检查写入是否已经存在。
6. 写操作不与其他读取放进 `Promise.all`。

在取消传播和执行日志尚未验证前，Garden 发帖/回复及浏览器提交也可以继续直连，仅把读取迁入 NCP。

## 11. 可观察性

Cyberboss 外层通常只能看到 `ncp.code`，看不到每个嵌套工具事件。为避免工作日志失真，NCP 最终返回中保留：

- 下游工具名称。
- 开始与结束时间或总耗时。
- 成功、失败、超时或不确定状态。
- 读取条目数；写操作的对象 ID。

只记录元数据，不记录完整正文。第一版不建设新的日志平台；先把摘要并入现有 runtime tool result 和工作日志即可。

## 12. 云向量 API

向量检索与 Cyberboss 消息队列是两条独立路径。它只影响 NCP 如何从工具目录中找到合适工具，不改变消息顺序或 turn 所有权。

当前 NCP 源码默认加载 `Xenova/all-MiniLM-L6-v2`，没有现成的通用云 embedding 配置。因此接云 API 需要一个很薄的 provider 适配，而不是简单填写现有配置。

第一版建议不让它阻塞试点：

- Garden 和 Playwright 工具数量有限，常用工具可以按明确名称调用。
- `find` 可以先使用当前本地/关键词回退。
- 只有真实观察到工具发现不准或本地模型资源占用明显，再增加云 embedding provider。

若增加云 provider，只需要统一一个 `embed(text[])` 接口，凭据通过环境变量注入，按工具 schema hash 缓存结果；云 API 失败时回退关键词搜索，不能阻塞 Cyberboss 消息处理。API 密钥不得写入仓库、协作文件或 NCP 返回值。

## 13. 分阶段实施

### 阶段 0：基线与配置快照

预计 0.5 天。

- 记录当前 Garden / Playwright MCP 配置和回滚方法。
- 选取三类真实任务：Garden 浏览、Garden 通知检查、浏览器定向读取。
- 记录模型续跑次数、工具结果字符数、总耗时和输入量。
- 不修改 Cyberboss 队列、TurnGate 或投递代码。

### 阶段 1：只读 NCP 试点

预计 1–2 天。

- 安装并固定经过验证的 NCP 版本。
- 只向 NCP 注册 Garden 与 Playwright。
- 保持 NCP 内部 scheduler 和不需要的内部 MCP 关闭。
- 暂时保留原直连配置用于快速回滚，但避免同时向模型暴露重复工具入口。
- 增加少量 Code Mode 示例，强调并行只读和精简 `return`。
- 完成 Garden 三读取并行、浏览器定向文本读取和部分失败测试。

### 阶段 2：生命周期和日志验证

预计 1 天。

- 测试 NCP 慢读取期间微信 live steering。
- 测试 Garden Wake 在用户 turn 运行时只入队一次、完成后只调度一次。
- 测试 Claude 进程退出、Cyberboss 重启和调用超时。
- 将嵌套调用名称、耗时和状态纳入现有工作日志。
- 如果发现下游调用无法及时结束，继续限制为短读取，不迁移写操作。

### 阶段 3：受控写操作

预计 1 天，可选。

- 先迁移一个低风险 Garden 写操作。
- 验证成功、明确失败、连接断开和 `uncertain` 四种结果。
- 验证超时后查询确认而不是自动重试。
- 浏览器登录、验证码和最终提交继续保留人工确认边界。

### 阶段 4：按数据决定是否补能力

可选，不预先实施。

- 省略文字确实经常需要找回时，再加入 Result Vault。
- 工具发现质量不足时，再接云 embedding API。
- 取消传播成为实际瓶颈时，再补 AbortSignal / cancellation 链路。

首个只读可用版本预计 2–4 个有效开发日。完整加入受控写操作预计再增加约 1–2 天。

## 14. 验证矩阵

| 场景 | 预期结果 |
|---|---|
| 三个独立 Garden 读取 | 一个外层 NCP 调用，一次模型续跑 |
| 一个读取失败 | 其他读取正常返回，不重试整批 |
| 大型帖子或 snapshot | 最终仅返回必要文字，主会话不出现完整原文 |
| 慢读取时收到微信新消息 | 消息不丢失；能够 steering 或在当前 turn 后继续处理 |
| 活跃 turn 中收到 Garden Wake | 只排队一次，之后只执行一次 |
| NCP 调用超时 | 返回失败；不触发任何自动写入重试 |
| 写入成功但外层断连 | 先只读核查，不重复发布 |
| Cyberboss / Claude 重启 | NCP 子进程退出或重建，无孤立调度任务 |
| 云 embedding API 不可用 | 工具发现回退，不阻塞消息队列 |
| 撤回 NCP | Garden / Playwright 恢复直连，主会话和队列状态无需迁移 |

## 15. 验收标准

- Cyberboss 仍是唯一的入站队列、TurnGate 和系统调度拥有者。
- 微信消息、Garden Wake 和系统消息没有丢失、重复或乱序。
- 三个独立读取能压缩为一个外层 NCP 调用。
- NCP 最终结果默认控制在约 4,000 字符以内。
- 中间 Garden / Playwright 大结果不进入主会话。
- 所有写操作保持单次、串行，并在结果中留下对象 ID 或可核查状态。
- 超时或 `uncertain` 不自动重试。
- 工作日志能够看见嵌套工具名、耗时和状态，但不保存敏感正文。
- 同类工具密集任务的模型续跑次数明显下降；输入量以降低 20%–40% 为观察目标，不作预先保证。
- 回滚只需恢复 MCP 配置，不需要迁移消息队列或会话数据。

## 16. 回滚

1. 从 Claude MCP 配置中移除 NCP 入口。
2. 恢复 Garden 和 Playwright 的原直连配置。
3. 重启 Claude runtime，确认工具目录恢复。
4. 检查不存在 NCP scheduler 任务或残留子进程。
5. 用一次 Garden 读取和一次浏览器 snapshot 验证直连恢复。

NCP 不拥有 Cyberboss 队列、thread 或持久业务状态，因此回滚不需要转换消息或人格上下文。

## 17. 最终实施原则

> Cyberboss 管“谁在什么时候说话和行动”；NCP 只负责“这一轮如何更省地调用 Garden 与浏览器”。读取可以并行，写入必须单独；中间结果留在执行层，主会话只接收做判断所需的文字。

## 18. 参考

- [NCP 项目与 Code Mode 说明](https://github.com/portel-dev/ncp)
- [NCP 当前 embedding 实现](https://github.com/portel-dev/ncp/blob/0ec1a74241d2ae0d092064747fd7ba1a9284909a/src/discovery/rag-engine.ts#L399-L405)
- [现有工具结果外置与并行读取计划](./tool-result-offloading-and-parallel-reads.md)
