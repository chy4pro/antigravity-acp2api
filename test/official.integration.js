import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readJson } from '../src/bridge.js';
import { fixture, tools } from './helpers.js';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

const binary = process.env.ACP2API_TEST_OFFICIAL_BIN || resolve('.runtime/agy_acp_server.par');
let available = true;
try { await access(binary); } catch { available = false; }

test('official Antigravity ACP 1.2.1 end-to-end against a loopback model', { skip: !available, timeout: 120000 }, async t => {
  const requests = [], chunks = [], blocked = [];
  const mock = createServer((req, res) => { void serve(req, res); });
  mock.on('connect', (req, socket) => { blocked.push(req.url); socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
  async function serve(req, res) {
    try {
      const body = await readJson(req, 16 * 1024 * 1024);
      const text = JSON.stringify(body.contents || []);
      requests.push({ time: Date.now(), path: req.url, body });
      if (text.includes('OFFICIAL_ERROR')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'LOCAL_MODEL_ERROR' } })); return;
      }
      const results = (body.contents || []).flatMap(c => c.parts || []).filter(p => p.functionResponse);
      let parts;
      if (text.includes('OFFICIAL_TOOL') && results.length === 0) {
        const declarations = (body.tools || []).flatMap(t => t.functionDeclarations || []);
        assert.ok(declarations.some(t => t.name === 'call_mcp_tool'));
        parts = [Array.from({ length: text.includes('OFFICIAL_TOOL_TWO') ? 2 : 1 }, (_, n) => ({ functionCall: { name: 'call_mcp_tool', args: {
          ServerName: 'api', ToolName: 'echo', Arguments: { value: 7 + n }, toolSummary: 'External echo', toolAction: 'Waiting for result',
        } } }))];
      } else if (results.length) parts = [[{ text: `VERIFIED:${results.map(r => JSON.stringify(r.functionResponse.response)).join('|')}` }]];
      else parts = [[{ text: 'OFFICIAL_' }], [{ text: 'STREAM_' }], [{ text: 'OK' }]];
      const frames = parts.map((part, i) => `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: part }, ...(i === parts.length - 1 ? { finishReason: 'STOP' } : {}) }],
        ...(i === parts.length - 1 ? { usageMetadata: { promptTokenCount: 13, candidatesTokenCount: 3, totalTokenCount: 16 } } : {}) })}\n\n`);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': Buffer.byteLength(frames.join('')) });
      for (let i = 0; i < frames.length; i++) {
        chunks.push({ index: i, time: Date.now() }); res.write(frames[i]);
        if (i < frames.length - 1) await new Promise(resolve => setTimeout(resolve, 160));
      }
      res.end();
    } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
  }
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  t.after(async () => { mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); });
  const endpoint = `http://127.0.0.1:${mock.address().port}`;
  const env = { ...process.env, GEMINI_API_KEY: 'local-test-placeholder', GOOGLE_GEMINI_BASE_URL: endpoint,
    HTTP_PROXY: endpoint, HTTPS_PROXY: endpoint, http_proxy: endpoint, https_proxy: endpoint,
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' };
  for (const key of ['GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_ENTERPRISE', 'AGY_LLM_GATEWAY_URL', 'AGY_ADC_AUTH']) delete env[key];
  const { url, post, gateway } = await fixture(t, { command: binary, args: process.platform === 'linux' ? ['--uid='] : [], agentEnv: env, maxSessions: 8 });
  const client = new OpenAI({ apiKey: 'test-key', baseURL: `${url}/v1`, maxRetries: 0 });
  const evidence = { runtime: 'official Antigravity ACP 1.2.1', model_service: 'loopback deterministic mock', live_google_subscription: false, checks: [] };

  await t.test('tools disabled and OpenAI SDK receives incremental text before generation ends', async () => {
    const received = [];
    const stream = await client.chat.completions.create({ model: 'default', messages: [{ role: 'user', content: 'OFFICIAL_TEXT' }], stream: true });
    for await (const chunk of stream) if (chunk.choices[0]?.delta.content) received.push({ time: Date.now(), text: chunk.choices[0].delta.content });
    assert.equal(received.map(x => x.text).join(''), 'OFFICIAL_STREAM_OK');
    assert.ok(received.at(-1).time - received[0].time >= 200);
    assert.deepEqual(requests[0].body.tools || [], []);
    evidence.checks.push({ name: 'empty_tools_and_text_stream', received, passed: true });
  });

  await t.test('real MCP result crosses two HTTP requests into the next model inference', async () => {
    const messages = [{ role: 'user', content: 'OFFICIAL_TOOL' }];
    const first = await client.chat.completions.create({ model: 'default', messages, tools });
    const call = first.choices[0].message.tool_calls[0];
    assert.equal(call.function.name, 'echo'); assert.deepEqual(JSON.parse(call.function.arguments), { value: 7 });
    const before = requests.length;
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(requests.length, before);
    messages.push(first.choices[0].message, { role: 'tool', tool_call_id: call.id, content: 'ACTUAL_EXTERNAL_RESULT' });
    const final = await client.chat.completions.create({ model: 'default', messages, tools });
    assert.ok(final.choices[0].message.content.includes('ACTUAL_EXTERNAL_RESULT'));
    assert.ok(JSON.stringify(requests.at(-1).body.contents).includes('ACTUAL_EXTERNAL_RESULT'));
    const names = (requests.at(-1).body.tools || []).flatMap(t => t.functionDeclarations || []).map(t => t.name);
    assert.ok(!names.includes('run_command')); assert.ok(!names.includes('view_file'));
    evidence.checks.push({ name: 'external_tool_roundtrip', tool_names: names, passed: true });
  });

  await t.test('Responses streaming through the real official runtime', async () => {
    const final = await client.responses.stream({ model: 'default', input: 'OFFICIAL_RESPONSES' }).finalResponse();
    assert.equal(final.output_text, 'OFFICIAL_STREAM_OK');
    evidence.checks.push({ name: 'responses_sdk_stream', passed: true });
  });

  await t.test('two native upstream tool calls are serialized without guessing a batch boundary', async () => {
    const messages = [{ role: 'user', content: 'OFFICIAL_TOOL_TWO' }];
    for (const value of [7, 8]) {
      const next = await client.chat.completions.create({ model: 'default', messages, tools });
      assert.equal(next.choices[0].message.tool_calls.length, 1);
      const call = next.choices[0].message.tool_calls[0];
      assert.deepEqual(JSON.parse(call.function.arguments), { value });
      messages.push(next.choices[0].message, { role: 'tool', tool_call_id: call.id, content: `SERIAL_RESULT_${value}` });
    }
    const final = await client.chat.completions.create({ model: 'default', messages, tools });
    assert.ok(final.choices[0].message.content.includes('SERIAL_RESULT_7'));
    assert.ok(final.choices[0].message.content.includes('SERIAL_RESULT_8'));
    evidence.checks.push({ name: 'two_native_calls_serialized', passed: true });
  });

  await t.test('inline images reach the model through the official ACP runtime', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0f8AAAAASUVORK5CYII=';
    await client.chat.completions.create({ model: 'default', messages: [{ role: 'user', content: [
      { type: 'text', text: 'OFFICIAL_IMAGE' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
    ] }] });
    const images = requests.at(-1).body.contents.flatMap(c => c.parts || []).filter(p => p.inlineData);
    assert.ok(images.some(p => p.inlineData.mimeType === 'image/png' && p.inlineData.data === png));
    evidence.checks.push({ name: 'inline_image_transport', passed: true });
  });

  await t.test('upstream HTTP 400 never becomes successful assistant prose', async () => {
    const response = await post({ model: 'default', messages: [{ role: 'user', content: 'OFFICIAL_ERROR' }] });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'upstream_error');
    const messages = [{ role: 'user', content: 'OFFICIAL_TOOL' }];
    const proposal = await client.chat.completions.create({ model: 'default', messages, tools });
    const message = proposal.choices[0].message;
    messages.push(message, { role: 'tool', tool_call_id: message.tool_calls[0].id, content: 'OFFICIAL_ERROR' });
    const afterTool = await post({ model: 'default', messages, tools });
    assert.equal(afterTool.status, 502);
    assert.equal((await afterTool.json()).error.code, 'upstream_error');
    evidence.checks.push({ name: 'upstream_error_mapping', passed: true });
  });

  await t.test('explicit relaxed Claude streaming uses real ACP and labels approximate usage', async () => {
    const relaxed = await fixture(t, { command: binary, args: process.platform === 'linux' ? ['--uid='] : [], agentEnv: env, compatibility: 'relaxed' });
    const anthropic = new Anthropic({ apiKey: 'test-key', baseURL: relaxed.url, maxRetries: 0 });
    const message = await anthropic.messages.stream({ model: 'default', max_tokens: 1000, messages: [{ role: 'user', content: 'OFFICIAL_CLAUDE' }] }).finalMessage();
    assert.equal(message.content[0].text, 'OFFICIAL_STREAM_OK');
    assert.equal(message.x_acp.usage, 'estimated_visible_bytes_div4');
    evidence.checks.push({ name: 'claude_sdk_stream_relaxed_only', passed: true });
  });
  assert.deepEqual(blocked, []);
  evidence.external_connections = blocked;
  evidence.time = new Date().toISOString();
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/official-integration.json', JSON.stringify(evidence, null, 2));
  await gateway.close();
});
