import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { ApiError } from './errors.js';

export class AcpClient extends EventEmitter {
  constructor(config, cwd) {
    super();
    this.config = config;
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.buffer = '';
    this.stderr = '';
    this.child = spawn(config.command, config.args, {
      cwd, env: { ...config.agentEnv, GEMINI_HOME: config.geminiHome },
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.consume(chunk));
    this.child.stderr.on('data', chunk => {
      this.stderr = (this.stderr + chunk).slice(-32768);
      this.emit('diagnostic', chunk);
    });
    this.child.stdin.on('error', () => {});
    this.child.on('error', e => this.die(new ApiError(503, 'runtime_unavailable', `Cannot start official ACP runtime (${e.code || 'spawn failed'}). Run npm run setup or configure ACP2API_COMMAND.`)));
    this.child.on('exit', () => {
      if (!this.closed && process.platform !== 'win32' && this.child.pid) {
        try { process.kill(-this.child.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') this.emit('diagnostic', 'Could not terminate exited agent process group\n'); }
      }
      this.die(new ApiError(502, 'agent_exited', 'The official ACP process exited; this session can no longer be continued.'));
    });
  }

  die(error) {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
    if (!this.closed) this.emit('fault', error);
  }

  consume(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 16 * 1024 * 1024) { this.die(new ApiError(502, 'invalid_acp', 'ACP output exceeded the frame limit')); void this.close(); return; }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { this.die(new ApiError(502, 'invalid_acp', 'Official runtime emitted invalid JSON-RPC')); void this.close(); return; }
      if (message.method) {
        if (message.id !== undefined) void this.handleRequest(message);
        else if (message.method === 'session/update') this.emit('update', message.params?.update);
      } else if (this.pending.has(message.id)) {
        const pending = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) {
          const auth = message.error.code === -32000;
          pending.reject(new ApiError(auth ? 401 : 502, auth ? 'google_login_required' : 'acp_request_failed', auth ? 'Google login is required. Run npm run login on the gateway host.' : 'The official ACP server rejected the request.'));
        } else pending.resolve(message.result);
      }
    }
  }

  async handleRequest(message) {
    if (message.method === 'session/request_permission') {
      const p = message.params || {};
      const meta = p.toolCall?._meta;
      const permitted = meta?.mcp?.server === 'api' && this.allowedTools?.has(meta?.mcp?.tool);
      const option = p.options?.find(o => o.kind === (permitted ? 'allow_once' : 'reject_once'));
      this.send({ jsonrpc: '2.0', id: message.id, result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } });
    } else {
      this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client filesystem, terminal, and other execution methods are disabled' } });
    }
  }

  send(message) {
    if (!this.closed && !this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeout = this.config.rpcTimeoutMs) {
    if (this.closed) return Promise.reject(new ApiError(410, 'session_closed', 'ACP session is closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = timeout > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new ApiError(504, 'acp_timeout', `ACP ${method} timed out`));
      }, timeout) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  initialize() {
    return this.request('initialize', {
      protocolVersion: 1, clientInfo: { name: 'antigravity-acp2api', version: '0.0.1' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
  }

  close() {
    if (!this.closing) this.closing = this.cleanup();
    return this.closing;
  }

  async cleanup() {
    this.closed = true;
    this.die(new ApiError(410, 'session_closed', 'ACP session was closed'));
    const child = this.child;
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const kill = signal => {
      try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
    };
    const exited = new Promise(resolve => child.once('exit', resolve));
    kill('SIGTERM');
    let timer;
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { kill('SIGKILL'); resolve(); }, 1500); })]);
    clearTimeout(timer);
  }
}
