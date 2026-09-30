import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { fixture, tools } from './helpers.js';

test('strict validation, auth, real model listing and capability declaration', async t => {
  const { post, url, gateway } = await fixture(t);
  assert.equal((await post({ model: 'default', messages: [{ role: 'user', content: 'hello' }] }, undefined, 'wrong')).status, 401);
  for (const extra of [{ temperature: 0 }, { max_tokens: 10 }, { tools, tool_choice: 'required' }, { system: 'system' }, { parallel_tool_calls: true }, { tools: [{ ...tools[0], function: { ...tools[0].function, strict: true } }] }]) {
    const res = await post({ model: 'default', messages: [{ role: 'user', content: 'hello' }], ...extra });
    assert.equal(res.status, 400, JSON.stringify(extra));
  }
  assert.equal(gateway.manager.sessions.size, 0);
  const caps = await (await fetch(`${url}/v1/acp/capabilities`, { headers: { authorization: 'Bearer test-key' } })).json();
  assert.equal(caps.compatibility, 'strict'); assert.equal(caps.usage, 'unavailable');
  const models = await (await fetch(`${url}/v1/models`, { headers: { authorization: 'Bearer test-key' } })).json();
  assert.equal(models.data[1].id, 'test-model');
  const unsupported = await post({ model: 'default', max_tokens: 100, messages: [{ role: 'user', content: 'hello' }] }, '/v1/messages');
  assert.equal(unsupported.status, 400); assert.equal((await unsupported.json()).type, 'error');
});

test('OpenAI SDK parses nonstreaming, genuine incremental streaming, and session continuation', async t => {
  const { url, post, dir } = await fixture(t);
  const client = new OpenAI({ apiKey: 'test-key', baseURL: `${url}/v1`, maxRetries: 0 });
  const messages = [{ role: 'user', content: 'hello' }];
  const first = await client.chat.completions.create({ model: 'default', messages });
  assert.equal(first.choices[0].message.content, 'OK'); assert.equal(first.usage, undefined);
  messages.push(first.choices[0].message, { role: 'user', content: 'followup' });
  const second = await client.chat.completions.create({ model: 'default', messages });
  assert.equal(second.x_acp.session_id, first.x_acp.session_id);
  const times = [], chunks = [];
  for await (const chunk of await client.chat.completions.create({ model: 'default', messages: [{ role: 'user', content: 'TEST_STREAM' }], stream: true })) {
    if (chunk.choices[0]?.delta.content) { times.push(Date.now()); chunks.push(chunk.choices[0].delta.content); }
  }
  assert.equal(chunks.join(''), 'Hello world'); assert.ok(times.at(-1) - times[0] >= 60);
  const record = (await readFile(join(dir, 'record.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(record.filter(r => r.newSession).every(r => r.newSession._meta.agy.enabledTools.length === 0));
  assert.ok(record.filter(r => r.initialize).every(r => r.initialize.clientCapabilities.terminal === false));
  const changed = await post({ model: 'default', messages: [{ role: 'user', content: 'edited' }, first.choices[0].message, { role: 'user', content: 'next' }] });
  assert.equal(changed.status, 409);
});

test('external tools wait for results; two upstream calls become two valid API turns', async t => {
  const { post, dir } = await fixture(t);
  const messages = [{ role: 'user', content: 'TEST_TOOL_TWO' }];
  let response = await post({ model: 'default', messages, tools });
  assert.equal(response.status, 200);
  const first = await response.json();
  assert.equal(first.choices[0].finish_reason, 'tool_calls');
  assert.equal(first.choices[0].message.tool_calls.length, 1);
  assert.ok(!(await readFile(join(dir, 'record.jsonl'), 'utf8')).includes('externalResult'));
  const firstCall = first.choices[0].message.tool_calls[0];
  messages.push(first.choices[0].message, { role: 'tool', tool_call_id: firstCall.id, content: `EXTERNAL_${JSON.parse(firstCall.function.arguments).value}` });
  const second = await (await post({ model: 'default', messages, tools })).json();
  assert.equal(second.choices[0].finish_reason, 'tool_calls');
  const secondCall = second.choices[0].message.tool_calls[0];
  assert.notEqual(secondCall.id, firstCall.id);
  messages.push(second.choices[0].message, { role: 'tool', tool_call_id: secondCall.id, content: `EXTERNAL_${JSON.parse(secondCall.function.arguments).value}` });
  const third = await (await post({ model: 'default', messages, tools })).json();
  assert.equal(third.choices[0].message.content, 'EXTERNAL_7|EXTERNAL_8');
  assert.equal(third.choices[0].finish_reason, 'stop');
  const duplicate = await post({ model: 'default', messages, tools });
  assert.equal(duplicate.status, 409);
});

test('tool IDs are isolated by API key; forged arguments and expired calls are rejected', async t => {
  const { post, gateway } = await fixture(t, { apiKeys: ['test-key', 'second-key'], toolTimeoutMs: 80 });
  const messages = [{ role: 'user', content: 'TEST_TOOL' }];
  const first = await (await post({ model: 'default', messages, tools })).json();
  const message = first.choices[0].message;
  messages.push(message, { role: 'tool', tool_call_id: message.tool_calls[0].id, content: 'result' });
  assert.equal((await post({ model: 'default', messages, tools }, undefined, 'second-key')).status, 409);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal((await post({ model: 'default', messages, tools })).status, 409);
  assert.equal(gateway.manager.sessions.size, 0);
});

test('runtime failures are errors, including partial streaming failures and timeout cleanup', async t => {
  const { post, gateway } = await fixture(t, { requestTimeoutMs: 450 });
  const error = await post({ model: 'default', messages: [{ role: 'user', content: 'TEST_ERROR' }] });
  assert.equal(error.status, 502); assert.equal((await error.json()).error.code, 'upstream_error');
  const stream = await post({ model: 'default', stream: true, messages: [{ role: 'user', content: 'TEST_STREAM_ERROR' }] });
  const output = await stream.text();
  assert.ok(output.includes('partial')); assert.ok(output.includes('"error"'));
  assert.ok(!output.includes('[DONE]')); assert.ok(!output.includes('"finish_reason":"stop"'));
  const late = await post({ model: 'default', stream: true, messages: [{ role: 'user', content: 'TEST_STREAM_RUNTIME_ERROR' }] });
  const lateOutput = await late.text();
  assert.ok(lateOutput.includes('partial')); assert.ok(lateOutput.includes('upstream_error'));
  assert.ok(!lateOutput.includes('[DONE]')); assert.ok(!lateOutput.includes('Agent execution'));
  const hang = await post({ model: 'default', messages: [{ role: 'user', content: 'TEST_HANG' }] });
  assert.equal(hang.status, 504); assert.equal(gateway.manager.sessions.size, 0);
});

test('Responses API works through the official OpenAI SDK, including result continuation', async t => {
  const { url } = await fixture(t);
  const client = new OpenAI({ apiKey: 'test-key', baseURL: `${url}/v1`, maxRetries: 0 });
  const first = await client.responses.create({ model: 'default', input: 'TEST_TOOL', tools: tools.map(t => ({ type: 'function', ...t.function })) });
  const call = first.output.find(item => item.type === 'function_call'); assert.ok(call);
  const second = await client.responses.create({ model: 'default', previous_response_id: first.id, input: [{ type: 'function_call_output', call_id: call.call_id, output: 'REAL_RESULT' }] });
  assert.equal(second.output_text, 'REAL_RESULT');
  const stream = client.responses.stream({ model: 'default', input: 'TEST_STREAM' });
  const final = await stream.finalResponse();
  assert.equal(final.output_text, 'Hello world');
});

test('explicit relaxed Claude mode works with Anthropic SDK and marks estimates', async t => {
  const { url } = await fixture(t, { compatibility: 'relaxed' });
  const client = new Anthropic({ apiKey: 'test-key', baseURL: url, maxRetries: 0 });
  const tool = { name: 'echo', description: 'Echo', input_schema: tools[0].function.parameters };
  const messages = [{ role: 'user', content: 'TEST_TOOL' }];
  const first = await client.messages.create({ model: 'default', max_tokens: 1000, tools: [tool], messages });
  assert.equal(first.stop_reason, 'tool_use'); assert.equal(first.x_acp.usage, 'estimated_visible_bytes_div4');
  const call = first.content.find(b => b.type === 'tool_use');
  messages.push({ role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'CLAUDE_RESULT' }] });
  const final = await client.messages.stream({ model: 'default', max_tokens: 1000, tools: [tool], messages }).finalMessage();
  assert.equal(final.content[0].text, 'CLAUDE_RESULT'); assert.equal(final.stop_reason, 'end_turn');
});

test('inline image transport, unknown model rejection, and explicit session deletion', async t => {
  const { post, url, gateway } = await fixture(t);
  const request = { model: 'default', messages: [{ role: 'user', content: [{ type: 'text', text: 'TEST_IMAGE' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }] };
  const response = await post(request); assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'IMAGE_RECEIVED');
  const id = response.headers.get('x-acp-session-id');
  assert.equal((await fetch(`${url}/v1/sessions/${id}`, { method: 'DELETE', headers: { authorization: 'Bearer test-key' } })).status, 200);
  assert.equal(gateway.manager.sessions.size, 0);
  const bad = await post({ ...request, model: 'nonexistent' }); assert.equal(bad.status, 400);
});
