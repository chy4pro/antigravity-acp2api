import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const write = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const reply = (id, result) => write({ id, result });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let sessionId = 'fake_session', mcp, tools = [], mcpSeq = 0;
const pending = new Map();
const log = value => { if (process.env.ACP2API_TEST_RECORD_FILE) appendFileSync(process.env.ACP2API_TEST_RECORD_FILE, `${JSON.stringify(value)}\n`); };
function text(value) { write({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } } } }); }
async function mcpRequest(method, params) {
  const id = ++mcpSeq;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
}

async function handle(message) {
  const { id, method, params } = message;
  if (!method) return;
  if (method === 'initialize') {
    log({ initialize: params });
    if (process.env.ACP2API_TEST_INIT_DELAY) await pause(Number(process.env.ACP2API_TEST_INIT_DELAY));
    return reply(id, { protocolVersion: 1, agentInfo: { name: 'antigravity-acp', version: '1.2.1' }, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } }, authMethods: [{ id: 'oauth-personal' }] });
  }
  if (method === 'authenticate') return reply(id, {});
  if (method === 'session/new') {
    log({ newSession: params });
    if (JSON.stringify(params._meta?.agy?.enabledTools) !== '[]') throw new Error('Builtins were not disabled');
    const server = params.mcpServers?.[0];
    if (server) {
      mcp = spawn(server.command, server.args, { env: { ...process.env, ...Object.fromEntries(server.env.map(e => [e.name, e.value])) }, stdio: ['pipe', 'pipe', 'inherit'] });
      const reader = createInterface({ input: mcp.stdout });
      reader.on('line', line => { const value = JSON.parse(line); const waiter = pending.get(value.id); if (waiter) { pending.delete(value.id); value.error ? waiter.reject(new Error(value.error.message)) : waiter.resolve(value.result); } });
      await mcpRequest('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '1' }, capabilities: {} });
      tools = (await mcpRequest('tools/list', {})).tools;
    }
    return reply(id, { sessionId, models: { currentModelId: 'test-model', availableModels: [{ modelId: 'test-model', name: 'Test model' }] }, configOptions: [] });
  }
  if (method === 'session/set_config_option') return reply(id, {});
  if (method === 'session/cancel') { log({ cancelled: true }); return; }
  if (method !== 'session/prompt') return write({ id, error: { code: -32601, message: 'Unknown method' } });
  const prompt = params.prompt.map(b => b.text || '').join('\n');
  log({ prompt });
  if (prompt.includes('TEST_CRASH')) process.exit(17);
  if (prompt.includes('TEST_HANG')) return;
  if (prompt.includes('TEST_UNICODE')) { text('你好世界'); return reply(id, { stopReason: 'end_turn' }); }
  if (prompt.includes('TEST_STREAM_WAIT')) { text('partial'); return; }
  if (prompt.includes('TEST_STREAM_RUNTIME_ERROR')) { text('partial'); await pause(20); text('Agent execution '); await pause(10); text('error: subsequent inference failed'); return reply(id, { stopReason: 'end_turn' }); }
  if (prompt.includes('TEST_ERROR')) {
    text('Agent execution '); await pause(10); text('error: test failure'); return reply(id, { stopReason: 'end_turn' });
  }
  if (prompt.includes('TEST_STREAM_ERROR')) { text('partial'); await pause(30); process.exit(17); }
  if (prompt.includes('TEST_TOOL')) {
    const count = prompt.includes('TEST_TOOL_TWO') ? 2 : 1;
    text('Checking.');
    const results = await Promise.all(Array.from({ length: count }, (_, n) => {
      const args = { value: prompt.includes('TEST_TOOL_INVALID') ? 'wrong_type' : n + 7 };
      log({ proposed: args });
      return mcpRequest('tools/call', { name: tools[0].name, arguments: args });
    }));
    for (const result of results) log({ externalResult: result });
    text(results.map(r => r.content[0].text).join('|'));
    return reply(id, { stopReason: 'end_turn' });
  }
  if (prompt.includes('TEST_STREAM')) {
    for (const chunk of ['Hello', ' ', 'world']) { text(chunk); await pause(60); }
  } else if (prompt.includes('TEST_IMAGE')) {
    text(params.prompt.some(b => b.type === 'image') ? 'IMAGE_RECEIVED' : 'NO_IMAGE');
  } else text('OK');
  reply(id, { stopReason: 'end_turn' });
}

for await (const line of createInterface({ input: process.stdin })) {
  try { const message = JSON.parse(line); void handle(message).catch(e => write({ id: message.id, error: { code: -32603, message: e.message } })); } catch {}
}
