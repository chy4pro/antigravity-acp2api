# 调试与验证报告

验证日期：2026-09-30。环境：Linux arm64，Node.js 22.23.1。固定官方 Antigravity ACP 1.2.1。

## 已验证

### 16 项网关回归测试

通过 `npm test` 执行。测试使用受控 ACP 子进程，并实际运行本项目 MCP helper、本地 HTTP 服务和官方 OpenAI / Anthropic JavaScript 客户端。

覆盖：严格参数和嵌套字段拒绝、鉴权、模型目录、文字增量、会话续接、工具提案与真实外部结果、多个调用顺序交付、调用 ID 隔离、参数篡改、重复与过期结果、非法模型参数、进程崩溃、部分 SSE 失败、超时、HTTP 断线、容量限制、并发冲突、关闭时的初始化竞态、Responses 两种续接方法、Claude 显式近似格式、UTF-8 截断和缺少 Google 登录时的预检。

### 7 项真实官方运行时端到端检查

通过 `npm run test:official` 执行。运行的是安装脚本下载的官方二进制及其 companion。模型服务指向本地模拟 Gemini HTTP/SSE 服务，使用占位 key，不使用 Google 账号凭据。

| 检查 | 结果 |
| --- | --- |
| 不传外部工具时，真实模型请求没有工具；OpenAI SDK 收到分时文字增量 | 通过 |
| 真正挂起 MCP 请求；调用方未交结果时不继续推理；结果进入下一次模型请求 | 通过 |
| OpenAI Responses SSE 被官方 SDK 正确组装 | 通过 |
| 底层模型一次生成两个调用，API 依次交付并回传两个结果 | 通过 |
| base64 PNG 经官方 ACP 到达模型 HTTP 请求 | 通过 |
| 模型 HTTP 400 被包装成 ACP 文本时，网关返回 502 | 通过 |
| 显式 relaxed 的 Claude SSE 被官方 SDK 正确组装，携带估算标记 | 通过 |

测试器给本地模型 SSE 注入约 160 ms 的块间隔，并要求客户端可见增量跨度至少 200 ms。这证明适配链路保留了增量传输，不是完成后一次性输出。测试未证明真实 Google 后端的首 token 延迟或吞吐。

Node 测试运行器会把这 7 个子测试的父套件也计入统计，因此输出是 **8 passed**；网关测试另有 **16 passed**，合计 **23 项行为检查**。

原始时序、检查项和 `live_google_subscription:false` 写入 `test-results/official-integration.json`。此文件由每次执行重新生成并被 Git 忽略。

### 安装及静态检查

- `npm run setup` 已实际从 Google 下载并解压 Linux arm64 发行包，后续端到端检查使用项目内 `.runtime/` 运行时。
- 下载包 SHA-256：`7e7ef4088bc185e1af4204029e0f4ec4210af20724f3ff262186ac0bcea6aa0e`。这是本次下载的记录值，不是独立签名认证。
- `npm run check` 通过 JavaScript 语法检查。
- 两个 `examples/` 可执行示例都已连接受控 ACP 测试服务运行，输出和会话清理通过。
- CLI 入口的启动、健康检查、未登录请求返回 401 和 SIGTERM 正常退出均已实际运行检查。
- `npm audit` 在本次执行时报告 0 vulnerabilities。
- `npm run doctor` 在没有个人 OAuth 凭据的默认配置下返回 `google_login_required`，没有触发浏览器自动登录或伪造 ready。

## 未验证

- 真实 Google 个人订阅的交互式 OAuth 登录、refresh、可用模型和真实推理。
- 真实 Google 额度耗尽、限流、断网、长时间运行的全部错误类型。
- macOS、Windows、Linux x64 的实际启动与进程清理；安装地址覆盖 Linux/macOS 四种组合，但本次仅运行 Linux arm64。
- 生产高并发、反向代理下的背压和持续数小时的工具等待。

因此当前结论是：**官方 ACP 到 API 的本地适配链路已实现并通过上述检查；真实订阅可用性仍待账号登录后的验证。**

## 登录后的最后验证

```bash
npm run login
npm run doctor
npm run smoke:live
```

`smoke:live` 创建临时本地网关，检查账号模型目录、文字 SSE，再把一个随机外部 receipt 经工具结果回传，要求模型引用实际值。检查结束后清理会话和进程；不会打印 Google 凭据。若模型在 `auto` 模式下没有提出工具调用，检查会明确失败，不能把这种情况伪装成工具链路已验证。

该命令已经提供，但本次没有真实账号凭据，未执行其在线推理部分。
