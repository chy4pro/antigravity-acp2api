# antigravity-acp2api

[English](README.md) | [简体中文](README.zh-CN.md)

版本：**0.0.1**

把**官方 Google Antigravity ACP** 接成 HTTP API。默认严格模式：只接受能够实现的能力，不支持的参数直接报错。

已实现 OpenAI Chat Completions、OpenAI Responses 的文字和外部工具子集，包括 SSE 流式输出。Claude Messages 的格式适配也已实现，但**默认严格模式拒绝 Claude 请求**：ACP 不暴露原生生成 token 预算和精确用量，无法兑现标准 Messages 请求与响应的全部要求。需要接受近似行为时，必须由服务操作者显式开启 `relaxed` 模式。

网关关闭 Antigravity 的内置执行工具。模型提出的外部函数调用通过 MCP 转为 API 的 `tool_calls` / `function_call` / `tool_use`；网关等待调用方提交结果，再让同一个 ACP 会话继续。**网关不会执行模型提出的 shell 命令。** 不传 `tools` 时，模型也可以直接输出命令文本。

当前状态：16 项网关回归测试、7 项真实官方 ACP 运行时与本地模拟模型服务的端到端检查通过。真实 Google 订阅尚未登录和实测。详见 [验证报告](docs/validation.md) 与 [兼容性表](docs/compatibility.md)。

## 启动

需要 Node.js 22 或更新版本。自动安装脚本支持 Linux / macOS 的 arm64、x64；本次实际验证环境为 Linux arm64。Windows 暂未验证。

```bash
cd antigravity-acp2api
npm ci
npm run setup
cp .env.example .env
npm run login
npm run doctor
npm start
```

如果已经安装依赖和官方运行时，可直接从 `npm run login` 开始。安装脚本从 Google 官方下载域名下载 ACP **1.2.1**，保存在 `.runtime/`。存在时不会覆盖。发布地址取自 [官方 ACP registry 条目](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json)。

`login` 调用官方 ACP 的 `authenticate(oauth-personal)` 流程。按终端显示的官方登录流程在浏览器完成登录；在网关所在机器运行，不要把 Google token 发给网关客户端。当前账号是否可用、可选模型及额度由 Google 返回；这里没有自行实现 OAuth 或 Google 私有推理接口。

`doctor` 检查登录状态、握手和模型目录，**不进行推理**。登录后还可以运行以下真实订阅冒烟检查，它会实际消耗少量模型额度，验证文字 SSE 和一个外部工具结果的往返：

```bash
npm run smoke:live
```

默认监听 `http://127.0.0.1:8787`。首次运行自动生成网关 API key，位于 `.state/api-key`，权限 `0600`。它独立于 Google 登录凭据。

## 调用

```bash
ACP2API_KEY=$(cat .state/api-key)

curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $ACP2API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"default","messages":[{"role":"user","content":"请输出列出当前目录文件的命令，只输出文字，不执行。"}],"stream":true}'
```

`model: "default"` 使用官方会话当前默认模型。真实可选模型通过 `GET /v1/models` 获取，不能把任意厂商模型名当作别名。网关不会伪造模型目录。

OpenAI JavaScript SDK 的 Chat Completions 和 Responses 已实测可解析：

```js
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.ACP2API_API_KEY,
  baseURL: 'http://127.0.0.1:8787/v1',
  maxRetries: 0,
});
const result = await client.responses.create({
  model: 'default',
  input: '用一句话解释 ACP。',
});
console.log(result.output_text);
```

示例中的 `ACP2API_API_KEY` 应设置为网关 key；使用自动生成的 key 时，可先执行 `export ACP2API_API_KEY="$(cat .state/api-key)"`。默认严格模式不要传 `system`、`instructions`、`max_tokens`、`temperature`、`response_format` 等不支持的参数。SDK 可解析格式，不代表所有客户端都能原样接入；自动添加这些参数或强制要求用量统计的客户端需要调整。

两个可直接运行的示例：

```bash
node --env-file-if-exists=.env examples/chat-stream.js
node --env-file-if-exists=.env examples/external-tools.js
```

第二个示例由调用方执行一个简单的 `echo` 函数，并把真实结果回传。业务工具可以换成命令提案：网关只输出调用，是否执行由调用方决定。示例支持 `ACP2API_BASE_URL`、`ACP2API_API_KEY` 和 `ACP2API_PROMPT`。

## 接口

| 路径 | 说明 |
| --- | --- |
| `GET /health` | 进程健康检查，不检查 Google 登录，不需要 key |
| `GET /v1/acp/capabilities` | 当前严格/近似模式、能力和限制 |
| `GET /v1/models` | 通过官方 ACP 获取账号可用模型；不执行推理 |
| `POST /v1/chat/completions` | 文字、流式、外部函数调用 |
| `POST /v1/responses` | 同上；支持活跃会话内的 `previous_response_id` |
| `GET /v1/responses/:id` | 获取内存中仍保留的响应；`store:false` 不保存 |
| `POST /v1/messages` | 默认返回 400；显式近似模式提供 Claude 格式 |
| `DELETE /v1/sessions/:id` | 终止会话、挂起调用和对应 ACP 子进程 |

除健康检查外均要求 `Authorization: Bearer <key>` 或 `x-api-key: <key>`。响应头 `X-ACP-Session-ID` 和响应中的 `x_acp` 扩展对象说明会话与兼容性。SSE 同样提供响应头；严格模式不伪造 token 用量。

## 工具与会话规则

1. 在请求中声明函数的名称、描述和 JSON Schema，模型通过网关提供的 MCP 工具提出调用。
2. 每个 API 响应最多交出一个外部调用；多个上游调用依次交付。收到工具调用时 HTTP 响应结束，底层 ACP prompt 保持等待。
3. 调用方保留返回的 assistant 消息，追加匹配 ID 的工具结果，再发下一次请求。Responses 也可使用 `previous_response_id` 加 `function_call_output`。
4. 网关把结果交回真实 MCP 请求，让原 ACP 会话继续。结果必须是文本；不会编造成功回执。

同一会话需要原样保留历史，模型、格式和工具定义不能中途变更。Chat 会自动匹配历史；多个会话历史相同或希望明确指定时，传 `X-ACP-Session-ID`。Headers 中指定会话也仍需完整、匹配的历史。Responses 可以复用最新响应 ID，不能从旧响应分叉。

会话、响应 ID 和挂起工具调用仅保存在当前进程内。进程重启、会话过期后返回 409；不会把旧历史静默降级成一段用户文本。断开正在生成的 HTTP 请求会取消并关闭该会话。正常收到工具调用后结束 HTTP 连接不属于取消。

## 显式近似模式

在 `.env` 中设置 `ACP2API_COMPATIBILITY=relaxed`，重启后才启用。默认文件仍为 `strict`。

近似模式允许 Claude Messages、system 文本和输出长度限制，但会在响应头、`x_acp` 和 warnings 中标注差异：

- system/instructions 作为用户提示文本加入，不具有原生 system 优先级。
- `max_tokens` 等参数只限制**可见输出的 UTF-8 字节数**，不控制模型实际生成 token，也不限制已发生的模型用量。触发截断会关闭会话。
- `usage` 按可见文本字节数除以 4 估算，未计入隐藏上下文、思考、缓存和官方 agent 的内部请求，不能用于计费。
- 导入的外部历史只会成为文本转录，不会恢复原生角色历史。

其余不支持的参数仍然拒绝。Claude 的 `thinking`、签名、缓存块、精确用量等没有因此变为可用。示例：

```js
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({
  apiKey: process.env.ACP2API_API_KEY,
  baseURL: 'http://127.0.0.1:8787',
  maxRetries: 0,
});
const message = await client.messages.stream({
  model: 'default', max_tokens: 4096,
  messages: [{ role: 'user', content: '你好。' }],
}).finalMessage();
console.log(message.content);
```

## 配置与本地状态

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `ACP2API_HOST` / `ACP2API_PORT` | `127.0.0.1` / `8787` | HTTP 地址 |
| `ACP2API_API_KEY` | 自动生成 | 网关访问 key |
| `ACP2API_COMPATIBILITY` | `strict` | `strict` 或显式 `relaxed` |
| `ACP2API_STATE_DIR` | 项目下 `.state` | 状态目录 |
| `ACP2API_AUTH_METHOD` | `oauth-personal` | 官方个人 OAuth；`gemini-api-key` 主要用于独立测试 |
| `ACP2API_COMMAND` | `.runtime/agy_acp_server.par` | 官方 ACP 可执行文件绝对路径 |
| `ACP2API_ARGS` | Linux 为 `["--uid="]` | JSON 数组形式的启动参数 |
| `ACP2API_MAX_SESSIONS` | `4` | 同时保留的会话数量 |
| `ACP2API_REQUEST_TIMEOUT_MS` | `120000` | 单次活动请求时限 |
| `ACP2API_TOOL_TIMEOUT_MS` | `300000` | 等待外部工具结果的空闲时限 |
| `ACP2API_SESSION_TTL_MS` | `900000` | 普通会话空闲时限 |

请求体和累计输入历史上限 4 MiB，可见输出上限 4 MiB。每个会话启动独立官方 ACP 进程，较多会话会增加内存占用。达到会话数量上限时返回 503，可主动 DELETE 释放。

登录状态位于 `.state/gemini/antigravity-acp/`。每次会话使用新的空工作目录，不读取现有项目的配置。`.state/`、`.env`、`.runtime/` 已加入 `.gitignore`。这里的工具禁用属于 ACP 能力和权限配置，并非操作系统沙箱。

## 检查与调试

```bash
npm run check
npm test
npm run test:official
npm audit
```

`test:official` 使用 `.runtime/` 中的官方程序和本地模拟模型服务，不需要 Google 凭据；如果运行时未安装，会明确显示 skipped。也可用 `ACP2API_TEST_OFFICIAL_BIN` 指定官方程序。成功运行的详细证据写入 `test-results/official-integration.json`。

常见错误：

| 错误 | 处理 |
| --- | --- |
| `google_login_required` / 401 | 在网关主机运行 `npm run login` |
| `auth_profile_mismatch` / 409 | 使用该状态目录原有的认证方式，或指定另一个状态目录 |
| `unsupported_parameter` / 400 | 删除不支持的参数；不会自动忽略 |
| `claude_usage_unavailable` / 400 | 使用 OpenAI 子集，或由操作者显式选择近似模式 |
| `history_mismatch` / 409 | 保留服务器返回的完整历史；检查会话 ID |
| `unknown_tool_call` / 409 | 检查是否重复提交、过期、重启或更换了 key |
| `session_capacity` / 503 | DELETE 不再使用的会话或等待过期 |
| `upstream_error` / 502 | 官方运行时报告推理失败；重新检查登录/额度/模型 |
| `unsupported_runtime` / 503 | 使用已验证的官方 1.2.1；版本升级需重新验证 |

更多细节见 [架构说明](docs/architecture.md)。
