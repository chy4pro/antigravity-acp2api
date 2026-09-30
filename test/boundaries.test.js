import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import OpenAI from 'openai';
import { fixture, tools } from './helpers.js';

async function eventually(check) {
  const deadline = Date.now() + 3000;
  while (!await check()) {
    if (Date.now() > deadline) assert.fail('Condition did not become true before deadline');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('unsupported nested fields and malformed types fail before starting ACP', async t => {
  const { post, gateway, dir } = await fixture(t);
  const base = { model: 'default', messages: [{ role: 'user', content: 'hello' }] };
  const bodies = [
    { ...base, tool_choice: {} }, { ...base, tool_choice: null }, { ...base, tool_choice: '' },
    { ...base, tool_choice: { type: 'auto', ignored: true } },
    { ...base, parallel_tool_calls: 'false' }, { ...base, tools: [null] },
    { ...base, stream: true, stream_options: { include_usage: 'false' } },
    { ...base, messages: [{ role: 'system', content: '' }, ...base.messages] },
    { ...base, messages: [{ role: 'assistant', content: null, tool_calls: {} }] },
    { ...base, messages: [{ role: 'user', content: [null] }] },
    { ...base, messages: [{ role: 'user', name: 'silently_ignored', content: 'hello' }] },
    { ...base, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }] }] },
    { ...base, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aA==', detail: 'high' } }] }] },
    { ...base, tools: [{ type: 'function', function: { name: 'unknown_schema', parameters: { type: 'object', made_up_validation: true } } }] },
  ];
  for (const body of bodies) assert.equal((await post(body)).status, 400, JSON.stringify(body));
  for (const extra of [{ store: 'false' }, { previous_response_id: 9 }, { metadata: { a: 1 } }]) {
    assert.equal((await post({ model: 'default', input: 'hello', ...extra }, '/v1/responses')).status, 400);
  }
  assert.equal(gateway.manager.sessions.size, 0);
  await assert.rejects(access(join(dir, 'record.jsonl')));
});

test('disconnect cancels the active agent; busy and capacity errors preserve its session until cancellation', async t => {
  const { post, gateway, url } = await fixture(t, { maxSessions: 1 });
  const messages = [{ role: 'user', content: 'hello' }];
  const first = await (await post({ model: 'default', messages })).json();
  const id = first.x_acp.session_id;
  messages.push(first.choices[0].message, { role: 'user', content: 'TEST_STREAM_WAIT' });
  const controller = new AbortController();
  const response = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-key', 'x-acp-session-id': id },
    body: JSON.stringify({ model: 'default', messages, stream: true }), signal: controller.signal,
  });
  const reader = response.body.getReader(); await reader.read();
  const session = gateway.manager.sessions.get(id), pid = session.acp.child.pid;
  const duplicate = await post({ model: 'default', messages }, undefined, undefined, { 'x-acp-session-id': id });
  assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).error.code, 'session_busy');
  assert.equal((await post({ model: 'default', messages: [{ role: 'user', content: 'independent' }] })).status, 503);
  assert.equal(gateway.manager.sessions.get(id), session);
  controller.abort(); await reader.cancel().catch(() => {});
  await eventually(() => gateway.manager.sessions.size === 0);
  await session.close();
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('shutdown waits for in-flight initialization and leaves no untracked sessions', async t => {
  const { post, gateway, config, dir } = await fixture(t);
  config.agentEnv.ACP2API_TEST_INIT_DELAY = '150';
  const pending = post({ model: 'default', messages: [{ role: 'user', content: 'hello' }] }).catch(() => null);
  await eventually(async () => { try { return (await readFile(join(dir, 'record.jsonl'), 'utf8')).includes('initialize'); } catch { return false; } });
  await gateway.close(); await pending;
  assert.equal(gateway.manager.creating, 0); assert.equal(gateway.manager.sessions.size, 0);
  assert.equal(gateway.manager.initializing.size, 0);
});

test('tool argument tampering is rejected without consuming the real pending call', async t => {
  const { post } = await fixture(t);
  const messages = [{ role: 'user', content: 'TEST_TOOL' }];
  const first = await (await post({ model: 'default', messages, tools })).json();
  const assistant = first.choices[0].message;
  const result = { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: 'UNMODIFIED_RESULT' };
  const forged = structuredClone(assistant); forged.tool_calls[0].function.arguments = '{"value":999}';
  assert.equal((await post({ model: 'default', messages: [...messages, forged, result], tools })).status, 409);
  const changedTools = [{ ...tools[0], function: { ...tools[0].function, description: 'changed' } }];
  assert.equal((await post({ model: 'default', messages: [...messages, assistant, result], tools: changedTools })).status, 409);
  const final = await (await post({ model: 'default', messages: [...messages, assistant, result], tools })).json();
  assert.equal(final.choices[0].message.content, 'UNMODIFIED_RESULT');
});

test('invalid generated tool arguments become an upstream error, never a callable API result', async t => {
  const { post, gateway } = await fixture(t);
  const response = await post({ model: 'default', messages: [{ role: 'user', content: 'TEST_TOOL_INVALID' }], tools });
  assert.equal(response.status, 502); assert.equal((await response.json()).error.code, 'invalid_tool_arguments');
  assert.equal(gateway.manager.calls.size, 0); assert.equal(gateway.manager.sessions.size, 0);
});

test('Responses full output replay supports text plus a tool call without previous_response_id', async t => {
  const { url } = await fixture(t);
  const client = new OpenAI({ apiKey: 'test-key', baseURL: `${url}/v1`, maxRetries: 0 });
  const input = [{ role: 'user', content: 'TEST_TOOL' }];
  const first = await client.responses.create({ model: 'default', input, store: false, tools: tools.map(t => ({ type: 'function', ...t.function })) });
  assert.equal(first.output.length, 2);
  await assert.rejects(client.responses.retrieve(first.id), error => error.status === 404);
  const call = first.output.find(item => item.type === 'function_call');
  const second = await client.responses.create({ model: 'default', input: [...input, ...first.output, { type: 'function_call_output', call_id: call.call_id, output: 'REPLAY_RESULT' }] });
  assert.equal(second.output_text, 'REPLAY_RESULT');
});

test('explicit approximate limit truncates at a UTF-8 boundary and closes its session', async t => {
  const { post, gateway } = await fixture(t, { compatibility: 'relaxed' });
  const response = await post({ model: 'default', messages: [{ role: 'user', content: 'TEST_UNICODE' }], max_tokens: 5 });
  const body = await response.json();
  assert.equal(body.choices[0].message.content, '你');
  assert.equal(body.choices[0].finish_reason, 'length');
  assert.ok(body.x_acp.warnings.some(w => w.includes('UTF-8 byte')));
  assert.equal(gateway.manager.sessions.size, 0);
});

test('missing OAuth and mismatched authentication profiles fail before starting an agent', async t => {
  const { post, dir, gateway, config } = await fixture(t, { authMethod: 'oauth-personal' });
  const response = await post({ model: 'default', messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(response.status, 401); assert.equal((await response.json()).error.code, 'google_login_required');
  assert.equal(gateway.manager.sessions.size, 0);
  await assert.rejects(access(join(dir, 'record.jsonl')));
  config.authMethod = 'gemini-api-key';
  const changed = await post({ model: 'default', messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(changed.status, 409); assert.equal((await changed.json()).error.code, 'auth_profile_mismatch');
  await assert.rejects(access(join(dir, 'record.jsonl')));
});
