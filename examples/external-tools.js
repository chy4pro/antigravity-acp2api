import { connection, echoTools } from './client.js';

const request = await connection();
const messages = [{ role: 'user', content: process.env.ACP2API_PROMPT || '请调用 echo 工具，value 为 7；等待外部客户端返回后，说明实际收到的结果。' }];
let sessionId;
try {
  for (let turn = 0; turn < 8; turn++) {
    const body = await (await request('/v1/chat/completions', { model: 'default', messages, tools: echoTools })).json();
    sessionId = body.x_acp.session_id;
    const message = body.choices[0].message; messages.push(message);
    if (message.content) console.log(message.content);
    if (!message.tool_calls?.length) break;
    for (const call of message.tool_calls) {
      // This is caller-side application logic. The gateway only forwards the
      // proposal and waits. It does not execute shell commands.
      if (call.function.name !== 'echo') throw new Error('Unexpected tool');
      const args = JSON.parse(call.function.arguments);
      console.log('Received tool proposal:', call.function.name, args);
      const result = JSON.stringify({ echoed: args.value });
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
    if (turn === 7) throw new Error('Example exceeded its tool-loop limit');
  }
} finally {
  if (sessionId) await request(`/v1/sessions/${sessionId}`, undefined, 'DELETE').catch(() => {});
}
