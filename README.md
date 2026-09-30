# antigravity-acp2api

[English](README.md) | [简体中文](README.zh-CN.md)

Version: **0.0.1**

An HTTP API gateway for the **official Google Antigravity ACP runtime**. Strict mode is the default: unsupported parameters are rejected rather than silently ignored.

The gateway implements a subset of OpenAI Chat Completions and OpenAI Responses, including text, SSE streaming, and external function calls. A Claude Messages adapter is also implemented, but **strict mode rejects Claude requests**: ACP does not expose native generation token budgets or exact usage, so the gateway cannot fulfill the standard Messages contract. The operator must explicitly enable `relaxed` mode to accept approximate behavior.

Antigravity's built-in execution tools are disabled. External function proposals travel through MCP and are returned as `tool_calls`, `function_call`, or `tool_use`. The gateway waits for the API client to supply the result before continuing the same ACP session. **The gateway does not execute shell commands proposed by the model.** Without `tools`, the model can still return commands as ordinary text.

Validation status: 16 gateway regression tests and 7 end-to-end checks using the real official ACP runtime with a local mock model service have passed. Real Google subscription login and inference remain unverified. See the [validation report](docs/validation.md) and [compatibility matrix](docs/compatibility.md), both currently in Chinese.

## API feature comparison

This table describes **this gateway's adapters**, not the full capabilities of the original provider APIs. OpenAI columns show the default **strict** mode. The Claude column shows the explicitly enabled **relaxed** adapter: **strict mode rejects the entire Claude Messages endpoint with HTTP 400**.

**Legend:** ✅ supported · ⚠️ limited or approximate · ❌ unsupported / rejected.

| Capability | OpenAI Chat Completions — strict | OpenAI Responses — strict | Claude Messages — relaxed only |
| --- | --- | --- | --- |
| Text responses | ✅ | ✅ | ✅ |
| SSE text streaming | ✅ Incremental text | ✅ Incremental text | ✅ Incremental text |
| Official SDK parsing | ✅ OpenAI SDK tested | ✅ OpenAI SDK tested | ✅ Anthropic SDK tested |
| Commands as text, without executing them | ✅ | ✅ | ✅ |
| Built-in command/file execution disabled | ✅ | ✅ | ✅ |
| External function proposals and result round trips | ✅ `tool_calls` | ✅ `function_call` | ✅ `tool_use` |
| Multiple tool calls | ⚠️ One call per response | ⚠️ One call per response | ⚠️ One call per response |
| Tool arguments streamed token by token | ❌ Complete JSON in one delta | ❌ Complete JSON in one delta | ❌ Complete JSON in one delta |
| `tool_choice: auto / none` | ✅ Fixed tool set per session | ✅ Fixed tool set per session | ✅ Fixed tool set per session |
| Required / named tool choice | ❌ | ❌ | ❌ |
| Parallel external tool delivery | ❌ Sequential delivery | ❌ Sequential delivery | ❌ Sequential delivery |
| Inline base64 images | ✅ No `detail` option | ✅ No `detail` option | ✅ |
| Remote image URLs, files, audio, video | ❌ | ❌ | ❌ |
| Conversation continuation | ⚠️ Exact history in a live session | ⚠️ Exact history or latest `previous_response_id` | ⚠️ Exact history in a live session |
| Importing external history | ❌ | ❌ | ⚠️ Text transcript only |
| Editing/forking history or recovering pending calls after restart | ❌ | ❌ | ❌ |
| Model selection | ✅ Actual Antigravity catalog | ✅ Actual Antigravity catalog | ✅ Actual Antigravity catalog |
| Native system/developer instruction priority | ❌ | ❌ | ❌ User prompt text only |
| Native generation token budget (`max_tokens`, etc.) | ❌ Parameter rejected | ❌ Parameter rejected | ❌ Visible UTF-8 byte cap only |
| Exact token usage | ❌ `usage` omitted | ❌ `usage: null` | ⚠️ Visible-byte estimate, not billing usage |
| `temperature`, `top_p`, penalties, `seed` | ❌ | ❌ | ❌ |
| `stop` / `stop_sequences` | ❌ | ❌ | ❌ |
| JSON/Schema-constrained generation | ❌ | ❌ | ❌ |
| Log probabilities, multiple candidates, prediction | ❌ | ❌ | ❌ |
| Thinking/reasoning controls and signatures | ❌ | ❌ | ❌ |
| Prompt caching / `cache_control` | ❌ | ❌ | ❌ |
| Provider-hosted search and execution tools | ❌ | ❌ | ❌ |
| Store and retrieve response objects | ❌ | ⚠️ Bounded in-memory cache | ❌ |
| Background jobs / WebSocket transport | ❌ | ❌ | ❌ |

Tool schemas are checked when the gateway receives a proposed call; this does **not** enable model-side constrained decoding. Text streams as ACP chunks arrive, while a tool's arguments become available only when its real MCP call arrives. Relaxed mode does not restore native system priority, token budgets, or exact usage.

See [Tools and sessions](#tools-and-sessions), [Explicit relaxed mode](#explicit-relaxed-mode), and the [detailed compatibility notes](docs/compatibility.md) (Chinese).

## Quick start

Requires Node.js 22 or later. The installer supports Linux and macOS on arm64 and x64. Runtime validation has been performed on Linux arm64; Windows has not been validated.

```bash
cd antigravity-acp2api
npm ci
npm run setup
cp .env.example .env
npm run login
npm run doctor
npm start
```

If dependencies and the official runtime are already installed, start with `npm run login`. The installer downloads ACP **1.2.1** from Google's official download domain into `.runtime/`. It does not overwrite an existing installation. Release URLs come from the [official ACP registry entry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json).

`login` invokes the official ACP `authenticate(oauth-personal)` flow. Run it on the gateway host and follow the browser sign-in instructions printed in the terminal. Google credentials stay on that host; API clients use a separate gateway key. Account eligibility, available models, and quotas are determined by Google. This project does not implement a separate Google OAuth flow or private inference API.

`doctor` checks credentials, the ACP handshake, and the model catalog. **It does not perform inference.** After signing in, you can also run the live subscription smoke test below. It makes real model requests, consumes some quota, and checks text streaming plus an external tool result round trip:

```bash
npm run smoke:live
```

The default address is `http://127.0.0.1:8787`. On first use, the gateway generates an API key at `.state/api-key` with permissions `0600`. This key is independent of Google credentials.

## Usage

```bash
ACP2API_KEY=$(cat .state/api-key)

curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $ACP2API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"default","messages":[{"role":"user","content":"Return a command to list files in the current directory. Output text only; do not execute it."}],"stream":true}'
```

`model: "default"` selects the official session's current default model. Use `GET /v1/models` to retrieve the actual model catalog. Arbitrary provider model names are not treated as aliases, and the gateway does not invent a model list.

Chat Completions and Responses have been tested with the official OpenAI JavaScript SDK:

```js
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.ACP2API_API_KEY,
  baseURL: 'http://127.0.0.1:8787/v1',
  maxRetries: 0,
});
const result = await client.responses.create({
  model: 'default',
  input: 'Explain ACP in one sentence.',
});
console.log(result.output_text);
```

Set `ACP2API_API_KEY` to your gateway key. When using the generated key, run `export ACP2API_API_KEY="$(cat .state/api-key)"` before the SDK example. In strict mode, omit unsupported parameters such as `system`, `instructions`, `max_tokens`, `temperature`, and `response_format`. SDK parsing compatibility does not mean every API client will work unchanged: clients that automatically add these parameters or require usage statistics need adjustment.

Two runnable examples are included:

```bash
node --env-file-if-exists=.env examples/chat-stream.js
node --env-file-if-exists=.env examples/external-tools.js
```

The second example executes a simple `echo` function in the API client and sends its actual result back. You can instead declare a function that proposes a command: the gateway returns the proposal, and the caller decides whether to execute it. The examples support `ACP2API_BASE_URL`, `ACP2API_API_KEY`, and `ACP2API_PROMPT`.

## Endpoints

| Endpoint | Behavior |
| --- | --- |
| `GET /health` | Process health only; does not check Google login and requires no key |
| `GET /v1/acp/capabilities` | Current compatibility mode, capabilities, and limitations |
| `GET /v1/models` | Account model catalog from official ACP; no inference |
| `POST /v1/chat/completions` | Text, streaming, and external function calls |
| `POST /v1/responses` | The same capabilities, with `previous_response_id` for active sessions |
| `GET /v1/responses/:id` | Retrieve a response still held in memory; `store:false` skips storage |
| `POST /v1/messages` | Returns 400 by default; Claude format requires explicit relaxed mode |
| `DELETE /v1/sessions/:id` | Close a session, pending calls, and its ACP subprocess |

All endpoints except `/health` require `Authorization: Bearer <key>` or `x-api-key: <key>`. The `X-ACP-Session-ID` response header and `x_acp` response extension describe session state and compatibility. SSE responses also carry the headers. Strict mode does not fabricate token usage.

## Tools and sessions

1. Declare a function's name, description, and JSON Schema in the request. The model proposes calls through the gateway's MCP tools.
2. Each API response returns at most one external call. Multiple upstream calls are delivered sequentially. The HTTP response ends when the call is returned, while the underlying ACP prompt remains pending.
3. Preserve the returned assistant message, append a tool result with the matching call ID, and send the next request. Responses also supports `previous_response_id` with `function_call_output`.
4. The gateway delivers that result to the real pending MCP request so the original ACP session can continue. Tool results must be text; the gateway does not invent successful results.

Within a session, preserve history exactly and keep the model, API format, and tool definitions unchanged. Chat matches sessions by history. Supply `X-ACP-Session-ID` when multiple sessions have identical histories or when you want to select one explicitly. An explicit session header still requires complete, matching history. Responses can continue the latest response ID; branching from older responses is unsupported.

Sessions, response IDs, and pending calls exist only in the current process. Continuing after a restart or session expiry returns 409 instead of silently importing old history as user text. Disconnecting an HTTP request during generation cancels and closes its session. A normal HTTP response ending after a tool proposal does not cancel the pending tool call.

## Explicit relaxed mode

Set `ACP2API_COMPATIBILITY=relaxed` in `.env` and restart the gateway to enable it. The default configuration remains `strict`.

Relaxed mode permits Claude Messages, system text, and output length limits, with differences disclosed in response headers, `x_acp`, and warnings:

- System instructions are inserted as user prompt text. They do not have native system priority.
- Parameters such as `max_tokens` cap **visible output in UTF-8 bytes**. They do not control the model's actual generation token budget or limit usage already incurred. Truncation closes the session.
- `usage` is estimated from visible text bytes divided by four. It excludes hidden context, thinking, caching, and internal agent requests, and must not be used for billing.
- Imported external history becomes a text transcript; it does not restore native message roles.

Other unsupported parameters are still rejected. Relaxed mode does not enable Claude thinking blocks, signatures, caching, or exact usage. Example:

```js
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ACP2API_API_KEY,
  baseURL: 'http://127.0.0.1:8787',
  maxRetries: 0,
});
const message = await client.messages.stream({
  model: 'default', max_tokens: 4096,
  messages: [{ role: 'user', content: 'Hello.' }],
}).finalMessage();
console.log(message.content);
```

## Configuration and local state

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `ACP2API_HOST` / `ACP2API_PORT` | `127.0.0.1` / `8787` | HTTP listener |
| `ACP2API_API_KEY` | Generated locally | Gateway access key |
| `ACP2API_COMPATIBILITY` | `strict` | `strict` or explicitly enabled `relaxed` |
| `ACP2API_STATE_DIR` | `.state` in the project directory | Local state directory |
| `ACP2API_AUTH_METHOD` | `oauth-personal` | Official personal OAuth; `gemini-api-key` is mainly used for separate testing |
| `ACP2API_COMMAND` | `.runtime/agy_acp_server.par` | Absolute path to the official ACP executable |
| `ACP2API_ARGS` | `["--uid="]` on Linux | Launch arguments as a JSON array |
| `ACP2API_MAX_SESSIONS` | `4` | Maximum number of retained sessions |
| `ACP2API_REQUEST_TIMEOUT_MS` | `120000` | Timeout for an active HTTP request |
| `ACP2API_TOOL_TIMEOUT_MS` | `300000` | Idle timeout while waiting for an external tool result |
| `ACP2API_SESSION_TTL_MS` | `900000` | Idle timeout for other sessions |

Request bodies and accumulated input history are limited to 4 MiB; visible output is limited to 4 MiB. Each session starts a separate official ACP process, so retaining more sessions increases memory usage. The gateway returns 503 when session capacity is reached. Use DELETE to release sessions you no longer need.

Login state is stored under `.state/gemini/antigravity-acp/`. Each session uses a fresh, empty working directory instead of an existing project's configuration. `.state/`, `.env`, and `.runtime/` are gitignored. Tool restrictions are implemented through ACP capabilities and permissions; they are not an operating-system sandbox.

## Testing and troubleshooting

```bash
npm run check
npm test
npm run test:official
npm audit
```

`test:official` runs the official executable in `.runtime/` against a local mock model service and needs no Google credentials. If the runtime is missing, it explicitly reports a skipped test. You can also select an official executable with `ACP2API_TEST_OFFICIAL_BIN`. Successful runs write detailed evidence to `test-results/official-integration.json`.

Common errors:

| Error | Action |
| --- | --- |
| `google_login_required` / 401 | Run `npm run login` on the gateway host |
| `auth_profile_mismatch` / 409 | Use the state directory's original authentication method or a different state directory |
| `unsupported_parameter` / 400 | Remove the unsupported parameter; it is not silently ignored |
| `claude_usage_unavailable` / 400 | Use the OpenAI subset or explicitly enable relaxed mode as the operator |
| `history_mismatch` / 409 | Preserve the complete returned history and check the session ID |
| `unknown_tool_call` / 409 | Check for duplicate submission, expiry, restart, or a changed API key |
| `session_capacity` / 503 | DELETE unused sessions or wait for expiry |
| `upstream_error` / 502 | The official runtime reported an inference failure; check login, quota, and model availability |
| `unsupported_runtime` / 503 | Use the validated official 1.2.1 runtime; upgrades require revalidation |

Additional documentation, currently in Chinese:

- [Compatibility matrix](docs/compatibility.md)
- [Architecture](docs/architecture.md)
- [Validation report](docs/validation.md)
