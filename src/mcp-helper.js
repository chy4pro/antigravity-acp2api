// The only MCP process launched by the gateway. It transports calls; it never
// executes commands or accesses the filesystem on behalf of the model.
import { createInterface } from 'node:readline';

const endpoint = process.env.ACP2API_BRIDGE_URL;
const token = process.env.ACP2API_BRIDGE_TOKEN;
if (!endpoint || !token) throw new Error('Missing local bridge configuration');

async function bridge(path, body) {
  const response = await fetch(`${endpoint}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Local tool bridge returned ${response.status}`);
  return response.json();
}

async function handle(message) {
  if (message.id === undefined) return;
  let result;
  switch (message.method) {
    case 'initialize': result = { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'antigravity-acp2api', version: '0.0.1' } }; break;
    case 'ping': result = {}; break;
    case 'tools/list': result = await bridge('/tools'); break;
    case 'tools/call': result = await bridge('/call', message.params); break;
    case 'resources/list': result = { resources: [] }; break;
    case 'prompts/list': result = { prompts: [] }; break;
    default: process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported' } })}\n`); return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
}

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  void handle(message).catch(() => {
    if (message.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Local tool bridge is unavailable' } })}\n`);
  });
}
