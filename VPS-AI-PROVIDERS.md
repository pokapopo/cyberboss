# VPS AI 供应商与模型记忆

最后核对：2026-08-13 UTC

对应 Ombré Brain 长期记忆桶：`0fb7d63dc486`（标题：VPS AI 供应商与模型分工）。
本文件保存完整脱敏快照；记忆桶保存稳定拓扑与用途边界，动态模型清单仍以实时
接口和本文件为准。

这份文件记录本 VPS 上已经配置或正在使用的 AI 供应商、模型和用途，供
uu、Cyberboss、CC 与 Codex 后续维护时查阅。它是运行状态的脱敏快照，**不保存
API Key、Token、Cookie、密码或其他凭据**。

## 一眼看懂当前分工

| 用途 | 供应商 | 当前模型 | 状态 |
|---|---|---|---|
| Cyberboss 主聊天 / Agent | DeepSeek 原生 Anthropic 兼容接口 | Sonnet/Opus → `deepseek-v4-pro`；Haiku → `deepseek-v4-flash` | 当前生效 |
| Cyberboss 主聊天回滚 | OpenCode Go | `glm-5.2` | 已保留，未生效 |
| Cyberboss 图片理解 | 阿里云 DashScope | `qwen-vl-plus` | 当前生效 |
| Ombré Brain 打标、分析、长文提取/摘要 | DeepSeek | `deepseek-v4-flash` | 当前生效 |
| Ombré Brain 向量化 | 阿里云 DashScope | `text-embedding-v4` | 当前生效 |
| 本机 Codex 编程 Agent | OpenAI / Codex | `gpt-5.6-sol`，reasoning `medium` | 当前会话配置 |

## 1. OpenCode Go

- 用途：Cyberboss 的 Claude Code 主聊天回滚与工具调用。
- 供应商入口：`https://opencode.ai/zen/go`
- 保留的默认模型：`glm-5.2`
- 本地路由：CC Switch Web 将 Anthropic Messages/工具调用转换为 OpenAI Chat
  Completions。
- 管理服务：`cc-switch-web.service`
- 管理端：`127.0.0.1:17666`
- 转换代理：`127.0.0.1:15721`
- CC Switch 供应商 ID：`opencode-go-glm52`
- 以上两个端口都只能监听本机，不得直接暴露到公网。

Claude Code 看到的 `sonnet`、`opus`、`haiku` 或对应 Claude 模型名只是兼容路由
名称；当前均映射到上游 `glm-5.2`，不表示调用了 Anthropic 官方模型。

### 2026-08-12 实时获取到的可用模型

CC Switch 可通过 OpenCode Go 的 `/v1/models` 一键重新获取列表。下面是本次核对
时账号返回的 25 个模型；供应商以后可能增删模型，因此应以实时获取结果为准。

- DeepSeek：`deepseek-v4-flash`、`deepseek-v4-pro`
- GLM：`glm-5`、`glm-5.1`、`glm-5.2`
- GPT：`gpt-5.6-luna`
- Grok：`grok-4.5`
- HY：`hy3`、`hy3-preview`
- Kimi：`kimi-k2.5`、`kimi-k2.6`、`kimi-k2.7-code`、`kimi-k3`
- MiMo：`mimo-v2-omni`、`mimo-v2-pro`、`mimo-v2.5`、`mimo-v2.5-pro`
- MiniMax：`minimax-m2.5`、`minimax-m2.7`、`minimax-m3`
- Qwen：`qwen3.5-plus`、`qwen3.6-plus`、`qwen3.7-max`、`qwen3.7-plus`、`qwen3.8-max`

切换主聊天模型时，只修改这个供应商的 Claude 模型映射；不要顺手修改 Ombré、
视觉或向量配置。更换后至少验证一次普通文本和一次工具调用。

## 2. DeepSeek

### Ombré Brain 当前用途

- 接口：`https://api.deepseek.com`
- 模型：`deepseek-v4-flash`
- 任务：记忆元数据分析、打标、长文提取和摘要（Ombré 的 compress/digest 链路）。
- 私密内容是否进入提取由上层记忆策略和请求决定，不应因为整理供应商而改变。

### Cyberboss 主聊天当前用途

- 接口：`https://api.deepseek.com/anthropic`
- 默认/Sonnet/Opus 映射：`deepseek-v4-pro`
- Haiku 映射：`deepseek-v4-flash`
- 可恢复的 root-only 配置备份：
  `/root/.cyberboss/provider-backups/claude-settings-20260812T070306Z-pre-opencode-go.json`

2026-08-13 已通过普通文本、自动工具调用和真实 Claude Code CLI 烟测。
CC Switch 仍保留两个供应商记录，但主聊天当前直连 DeepSeek，不经过
仅为 OpenAI Chat 转换而部署的本地代理。

该备份包含敏感配置，只能由 root 读取；不要复制进仓库、聊天记录或协作文件。

## 3. 阿里云 DashScope

统一兼容入口：`https://dashscope.aliyuncs.com/compatible-mode/v1`

### Cyberboss 视觉

- 模型：`qwen-vl-plus`
- 模式：`auto`
- 用途：图片、截图、聊天内容等视觉理解。

### Ombré Brain 向量化

- 模型：`text-embedding-v4`
- 用途：记忆向量、语义检索和召回索引。
- 这是 Embeddings 专用模型。生成模型（例如 `glm-5.2`、
  `deepseek-v4-flash`）不能仅靠改模型名替代它。

## 4. OpenAI / Codex

- 用途：VPS 上的 Codex 编程 Agent，会话与代码维护，不是 Cyberboss 面向微信的
  主聊天后端。
- 当前模型：`gpt-5.6-sol`
- 当前推理强度：`medium`
- 当前 `/root/.codex/config.toml` 没有登记额外自定义 model provider；认证由 Codex
  自身凭据管理，不写入本文件。

## 5. 记忆系统边界

- 当前长期记忆系统：Ombré Brain。
- Cyberboss 旧版记忆召回与十轮提取：已停用，旧数据和备份仍保留。
- Ombré 写入：由 `hold` / `grow` 等记忆动作完成。
- Ombré 召回：由 `breath` / `breath_search` 等动作完成。
- 主聊天供应商切换不等于记忆模型切换；除非 uu 明确要求，否则不要联动修改。

## 6. 维护与核对原则

1. 可用模型清单优先从供应商实时接口获取，不把本文件当作永久不变的模型目录。
2. 修改前先确认任务属于主聊天、视觉、记忆生成还是向量化，四者独立管理。
3. 任何文档只记录“凭据已配置”，绝不记录凭据值。
4. OpenCode Go 主聊天切换后验证文本与工具调用；向量模型切换后必须重建或验证
   向量兼容性，不能只看请求成功。
5. 当前 OpenCode Go Key 曾在聊天中出现过，应完成轮换；轮换只更新秘密存储，不
   改本文件中的模型与拓扑说明。

## 7. 事实来源

- Cyberboss：`/root/cyberboss/.env`（只核对非敏感模型字段）
- Claude live 配置：`/root/.claude/settings.json`
- CC Switch 数据库：`/root/.cc-switch/cc-switch.db`
- Ombré：`/opt/ombre-brain/.env`（只核对非敏感模型字段）
- Codex：`/root/.codex/config.toml`
- 服务：`cyberboss.service`、`cc-switch-web.service`、`ombre-brain` 容器

这些运行配置可能在未来切换后发生变化。每次模型拓扑发生实质变化，都应同步
更新本文件的日期、当前分工和对应章节。
