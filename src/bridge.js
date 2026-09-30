import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { toolManifest } from './normalize.js';
import { ApiError } from './errors.js';

export async function readJson(req, maximum = 4 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw new ApiError(413, 'body_too_large', 'Request exceeds the size limit');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'invalid_json', 'Request body must be valid JSON'); }
}
export function equalSecret(a, b) {
  const x = Buffer.from(a || ''), y = Buffer.from(b || '');
  return x.length === y.length && timingSafeEqual(x, y);
}
function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }

export class ToolBridge extends EventEmitter {
  constructor(tools) {
    super(); this.tools = tools; this.token = randomBytes(32).toString('hex'); this.pending = new Map();
    this.server = createServer((req, res) => { void this.handle(req, res); });
    this.server.requestTimeout = 0;
  }
  async start() {
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    this.url = `http://127.0.0.1:${this.server.address().port}`;
  }
  async handle(req, res) {
    try {
      if (!equalSecret(req.headers.authorization, `Bearer ${this.token}`)) return json(res, 401, { error: 'Unauthorized' });
      if (req.method === 'GET' && req.url === '/tools') return json(res, 200, { tools: toolManifest(this.tools) });
      if (req.method !== 'POST' || req.url !== '/call') return json(res, 404, { error: 'Not found' });
      const body = await readJson(req);
      const tool = this.tools.find(t => t.name === body.name);
      if (!tool || !tool.validate(body.arguments)) {
        const error = new ApiError(502, 'invalid_tool_arguments', 'The model proposed an unknown tool or arguments outside its declared schema');
        this.emit('fault', error);
        return json(res, 200, { isError: true, content: [{ type: 'text', text: error.message }] });
      }
      if (this.pending.size >= 32) throw new ApiError(502, 'too_many_calls', 'Too many pending tool calls');
      const call = { id: `call_${randomUUID().replaceAll('-', '')}`, name: tool.name, arguments: body.arguments };
      this.pending.set(call.id, { call, res });
      res.once('close', () => {
        if (this.pending.delete(call.id)) this.emit('fault', new ApiError(502, 'tool_bridge_disconnected', 'The internal MCP connection closed before its result was delivered'));
      });
      this.emit('call', call);
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: 'Internal tool bridge error' });
      this.emit('fault', error);
    }
  }
  resolve(id, text, isError = false) {
    const pending = this.pending.get(id);
    if (!pending) throw new ApiError(409, 'unknown_tool_call', 'Tool call is unknown, already completed, or expired');
    this.pending.delete(id);
    json(pending.res, 200, { content: [{ type: 'text', text }], isError });
  }
  async close() {
    for (const { res } of this.pending.values()) {
      if (!res.writableEnded) json(res, 200, { content: [{ type: 'text', text: 'Gateway session closed before receiving an external result' }], isError: true });
    }
    this.pending.clear();
    if (this.server.listening) {
      const closed = new Promise(resolve => this.server.close(resolve));
      this.server.closeAllConnections(); await closed;
    }
  }
}
