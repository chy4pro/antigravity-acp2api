import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadConfig, requireCredentials } from '../src/config.js';
import { createGateway } from '../src/server.js';
import { api, sse, echoTools } from '../examples/client.js';

// Opt-in integration check: this command performs real model inference and
// consumes the account's quota. No provider token is read or printed here.
const config = await loadConfig();
if (config.authMethod !== 'oauth-personal') throw new Error('smoke:live requires ACP2API_AUTH_METHOD=oauth-personal');
await requireCredentials(config);
config.host = '127.0.0.1'; config.port = 0; config.compatibility = 'strict';
const gateway = createGateway(config);
const url = await gateway.listen(), request = api(url, config.apiKeys[0]);
try {
  const models = await (await request('/v1/models')).json();
  assert.ok(models.data.length > 1); console.log('PASS account model catalog');
  const stream = await request('/v1/chat/completions', {
    model: 'default', stream: true, messages: [{ role: 'user', content: 'Reply with a brief greeting.' }],
  });
  let text = '', finished = false;
  for await (const chunk of sse(stream)) {
    text += chunk.choices?.[0]?.delta.content || '';
    if (chunk.choices?.[0]?.finish_reason === 'stop') finished = true;
  }
  assert.ok(text.trim() && finished); console.log('PASS subscription text over SSE');
  await request(`/v1/sessions/${stream.headers.get('x-acp-session-id')}`, undefined, 'DELETE');

  const messages = [{ role: 'user', content: 'Connectivity test: call the external echo tool exactly once with value 731. Wait for its real result, then quote the receipt field verbatim. Do not invent a receipt.' }];
  const first = await (await request('/v1/chat/completions', { model: 'default', messages, tools: echoTools })).json();
  const message = first.choices[0].message, call = message.tool_calls?.[0];
  assert.ok(call, 'The model did not propose a tool; auto tool choice does not guarantee a call');
  assert.equal(call.function.name, 'echo'); assert.deepEqual(JSON.parse(call.function.arguments), { value: 731 });
  const receipt = randomUUID();
  messages.push(message, { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ receipt, echoed: 731 }) });
  const final = await (await request('/v1/chat/completions', { model: 'default', messages, tools: echoTools })).json();
  assert.ok(final.choices[0].message.content?.includes(receipt), 'The model did not quote the actual external receipt');
  console.log('PASS subscription external-tool round trip');
  console.log('Live smoke test passed.');
} finally { await gateway.close(); }
