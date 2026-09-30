# 兼容性与明确拒绝的行为

本项目提供 API 子集，不声称与原生厂商 API 完全等价。下面是当前代码的默认严格行为。

| 能力 | OpenAI Chat | OpenAI Responses | Claude Messages |
| --- | --- | --- | --- |
| 普通文字、SSE 文字增量 | 支持 | 支持 | 仅显式 relaxed |
| API 外观 / SDK 解析 | 已测官方 OpenAI SDK | 已测官方 OpenAI SDK | 已测官方 Anthropic SDK，限 relaxed |
| 函数提案与调用方结果回传 | 支持，每次一个 | 支持，每次一个 | 仅 relaxed，每次一个 |
| 工具参数流式逐 token 生成 | 不支持；完整 JSON 作为一次 delta | 同左 | 同左 |
| 禁止内置命令/文件执行工具 | 支持 | 支持 | 支持 |
| 命令作为普通文字输出 | 支持 | 支持 | 仅 relaxed |
| 行内 base64 图片输入 | 支持，不支持 detail | 支持，不支持 detail | 仅 relaxed |
| 远程图片 URL、文件、音频、视频 | 拒绝 | 拒绝 | 拒绝 |
| 活跃会话内连续对话 | 完整历史匹配 | 完整历史或最新 previous_response_id | 仅 relaxed |
| 任意历史导入、编辑、分叉 | 拒绝 | 拒绝 | relaxed 仅可文本转录导入 |
| 模型选择 | 官方实际模型目录 | 同左 | 同左 |
| 原生 system / developer 优先级 | 拒绝 | instructions 拒绝 | 拒绝 |
| 原生 max_tokens / max_output_tokens | 拒绝 | 拒绝 | 拒绝标准请求 |
| 精确 token usage | 不返回 usage | usage 为 null | 严格模式无法提供必需 envelope，拒绝 |
| temperature / top_p / penalties / seed | 拒绝 | 拒绝 | 拒绝 |
| stop / stop_sequences | 拒绝 | 拒绝 | 拒绝 |
| JSON/Schema 约束解码 | 拒绝 | 拒绝 | 拒绝 |
| tool_choice auto / none | 支持，现有会话不能切换工具集合 | 同左 | 仅 relaxed |
| 强制调用、指定函数调用 | 拒绝 | 拒绝 | 拒绝 |
| parallel_tool_calls=true | 拒绝 | 拒绝 | 禁止并行外部工具 |
| logprobs、多候选 n、预测输出 | 拒绝 | 拒绝 | 拒绝 |
| thinking / reasoning 控制、签名 | 拒绝 | 拒绝 | 拒绝 |
| prompt cache / cache_control | 拒绝 | 拒绝 | 拒绝 |
| 厂商托管工具、搜索、执行环境 | 拒绝 | 拒绝 | 拒绝 |
| 服务端保存响应 / 获取响应 | 不支持 | 当前进程内存中的有界缓存 | 不支持 |
| background、异步任务、WebSocket | 拒绝 | 拒绝 | 拒绝 |

Claude 严格模式的拒绝是刻意的兼容性选择。只生成一个看起来类似的 JSON，并不能兑现 `max_tokens` 和精确 `usage`。网关不把估算的数字包装为严格模式的真实统计。

## 输入校验

未知顶层参数和不支持的嵌套参数返回 400，不会继续调用模型。`system` 消息即使为空也拒绝。图片 `detail`、命名消息 `name`、工具缓存字段等也不会静默丢弃。

函数参数使用支持的 JSON Schema 子集校验（AJV，object 根节点）。未知关键字、未注册 format、不支持的 schema 方言会拒绝；不远程获取 `$ref`。`strict:true` 拒绝，因为运行时不提供模型端约束解码。模型产生不符合声明的参数时返回 502，不向 API 调用方交出一个看似有效的调用。

`metadata` 仅在 Responses 接口作为本地附加信息保存并返回，不发送给模型。支持最多 16 个字符串值，键不超过 64 字符，值不超过 512 字符。

## 会话差异

API 的 HTTP 生命周期与 ACP prompt 生命周期不同。模型提案交出后，API 响应可以结束，但 ACP 正在等待 MCP 返回。提交工具结果必须路由到同一个活跃会话，不是重新拼接一份提示调用模型。

默认模式要求：新会话是一条用户消息；后续请求是上次返回的完整历史加一条新用户消息或一条工具结果。提供 Responses 的最新 `previous_response_id` 时，网关先补齐已保存的历史。多个连续用户消息、工具结果混入新问题、历史修改等不在这个子集中，会明确失败。相同会话的并发请求返回 409。

`parallel_tool_calls:false` 表示向调用方每次只交付一个调用。底层 agent 仍可能一次提出多个 MCP 调用，网关顺序交付并等待对应结果。它不是对上游模型并行解码策略的控制。`tool_choice:auto` 也不保证模型一定调用工具。

原生模型的单轮文本/工具边界与 agent 的边界不同：一个 API 响应可能包含 agent 内部多次推理汇总后的可见文本。模型默认提示、思考和上下文管理仍由官方 agent 控制。

## 流与错误

文字在真实 ACP `agent_message_chunk` 到来时转换成 SSE，而不是等完成后切割。函数参数仅在真实 MCP 调用到达后才完整可用，不能承诺参数逐 token 流式。

首次输出之前失败返回 HTTP 错误；开始 SSE 后失败发送错误事件并结束连接，不补成功的终止事件。工具调用返回后，未收到工具结果时不会向模型伪造成功回执。

ACP 1.2.1 会把部分模型 HTTP 错误转换成 assistant 文本。网关对已实测的 `Agent execution error:` 等前缀进行拦截。代价是模型有意输出这些保留前缀时也会被判为错误；未识别的新运行时错误文本仍是兼容性风险，不能声称覆盖所有厂商错误。ACP `refusal` 还可能代表额度耗尽，两者无法精确区分。

## 依据

- [ACP 会话启动](https://agentclientprotocol.com/protocol/session-setup) 与 [prompt turn](https://agentclientprotocol.com/protocol/prompt-turn)：会话、内容块和持续交互模型。
- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)：函数提案与结果回传的 API 结构。
- [Claude streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)：Messages SSE 生命周期。
- [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)：本地 helper 的传输形式。

具体 Antigravity 私有 metadata 行为以固定官方 1.2.1 的本地端到端验证为准，不把它视为跨版本稳定承诺。
