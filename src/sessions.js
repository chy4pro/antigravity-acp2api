import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AcpClient } from './acp.js';
import { ToolBridge } from './bridge.js';
import { ApiError, fail } from './errors.js';
import { stable, toolManifest, promptBlocks } from './normalize.js';
import { prepareProfile, requireCredentials } from './config.js';

const ERROR_PREFIXES = ['Agent execution error:', 'Failed to connect to the agent', 'Connection to the agent was lost'];

class Session {
  constructor(manager, request, owner, cwd) {
    this.manager = manager; this.config = manager.config; this.id = `sess_${randomUUID()}`;
    this.requestedModel = request.model; this.format = request.format; this.owner = owner;
    this.tools = request.tools; this.system = request.system; this.cwd = cwd;
    this.history = []; this.queue = []; this.waiter = null; this.busy = false;
    this.closed = false; this.activePrompt = false; this.currentCall = null; this.queuedBytes = 0;
    this.touched = Date.now(); this.guard = ''; this.runtimeFailed = false;
    this.bridge = new ToolBridge(this.tools);
    this.bridge.on('call', call => this.push({ type: 'call', call }));
    this.bridge.on('fault', error => this.push({ type: 'error', error }));
  }

  async initialize() {
    await this.bridge.start();
    this.acp = new AcpClient(this.config, this.cwd);
    this.acp.allowedTools = new Set(this.tools.map(t => t.name));
    this.acp.on('fault', error => this.push({ type: 'error', error }));
    this.acp.on('update', update => this.update(update));
    const hello = await this.acp.initialize();
    if (hello.agentInfo?.name !== 'antigravity-acp' || hello.agentInfo?.version !== '1.2.1') {
      throw new ApiError(503, 'unsupported_runtime', 'This release has been validated with official Antigravity ACP 1.2.1. Install the pinned runtime with npm run setup.');
    }
    this.info = hello;
    const mcpServers = this.tools.length ? [{
      name: 'api', command: process.execPath, args: [this.config.helperPath],
      env: [{ name: 'ACP2API_BRIDGE_URL', value: this.bridge.url }, { name: 'ACP2API_BRIDGE_TOKEN', value: this.bridge.token }],
    }] : [];
    const result = await this.acp.request('session/new', { cwd: this.cwd, mcpServers, _meta: { agy: { enabledTools: [] } } });
    if (!result?.sessionId) throw new ApiError(502, 'invalid_acp', 'ACP did not return a session ID');
    this.acpId = result.sessionId;
    this.models = result.models?.availableModels || result.configOptions?.find(o => o.id === 'model')?.options?.map(o => ({ modelId: o.value, name: o.name })) || [];
    this.model = result.models?.currentModelId || result.configOptions?.find(o => o.id === 'model')?.currentValue;
    if (this.requestedModel !== 'default') {
      if (!this.models.some(m => m.modelId === this.requestedModel)) throw new ApiError(400, 'model_not_available', 'Requested model is not available in this Antigravity account. Query GET /v1/models.', 'model');
      if (this.model !== this.requestedModel) await this.acp.request('session/set_config_option', { sessionId: this.acpId, configId: 'model', value: this.requestedModel });
      this.model = this.requestedModel;
    }
    if (!this.model) throw new ApiError(502, 'model_unknown', 'The agent did not report its selected model');
  }

  update(update) {
    if (this.runtimeFailed || update?.sessionUpdate !== 'agent_message_chunk' || update.content?.type !== 'text') return;
    const text = update.content.text;
    // Known runtime failures arrive as assistant text in ACP 1.2.1. Reserve
    // these prefixes so they cannot become a successful API completion.
    // Also inspect subsequent ACP chunks: a later inference can fail after
    // earlier prose or after a tool result has already been returned.
    this.guard += text;
    if (ERROR_PREFIXES.some(prefix => this.guard.startsWith(prefix))) {
      this.push({ type: 'error', error: new ApiError(502, 'upstream_error', 'The official Antigravity runtime reported a model execution error.') });
      this.guard = ''; this.runtimeFailed = true; return;
    }
    if (ERROR_PREFIXES.some(prefix => prefix.startsWith(this.guard))) return;
    this.push({ type: 'text', text: this.guard }); this.guard = '';
  }

  push(event) {
    if (this.closed) return;
    if (event.type === 'text') {
      this.queuedBytes += Buffer.byteLength(event.text);
      if (this.queuedBytes > this.config.maxOutputBytes) {
        this.queue = [{ type: 'error', error: new ApiError(502, 'output_too_large', 'Buffered agent output exceeded the gateway limit') }];
        this.acp.child.stdout.pause();
        if (this.waiter) { const wake = this.waiter; this.waiter = null; wake(); }
        return;
      }
    }
    this.queue.push(event);
    if (this.waiter) { const wake = this.waiter; this.waiter = null; wake(); }
  }
  async next(signal) {
    if (signal.aborted) throw signal.reason;
    while (!this.queue.length) {
      if (this.closed) throw new ApiError(410, 'session_closed', 'Session is closed');
      if (signal.aborted) throw signal.reason;
      await new Promise((resolve, reject) => {
        const abort = () => { this.waiter = null; reject(signal.reason); };
        this.waiter = () => { signal.removeEventListener('abort', abort); resolve(); };
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    if (signal.aborted) throw signal.reason;
    const event = this.queue.shift();
    if (event.type === 'text') this.queuedBytes -= Buffer.byteLength(event.text);
    return event;
  }
  startPrompt(blocks) {
    if (this.activePrompt) fail(409, 'turn_in_progress', 'A tool result is required before a new user turn');
    this.guard = ''; this.runtimeFailed = false; this.activePrompt = true;
    void this.acp.request('session/prompt', { sessionId: this.acpId, prompt: blocks }, 0).then(result => {
      if (this.guard) { this.push({ type: 'text', text: this.guard }); this.guard = ''; }
      this.activePrompt = false;
      this.push({ type: 'end', reason: result?.stopReason });
    }, error => { this.activePrompt = false; this.push({ type: 'error', error }); });
  }
  resume(result) {
    if (!this.currentCall || this.currentCall.id !== result.id) fail(409, 'unexpected_tool_result', 'Tool result does not match the outstanding call');
    this.bridge.resolve(result.id, result.text, result.isError);
    this.manager.calls.delete(result.id); this.currentCall = null;
  }
  close() {
    if (!this.closing) this.closing = this.cleanup();
    return this.closing;
  }
  async cleanup() {
    this.closed = true;
    this.manager.sessions.delete(this.id);
    for (const [id, session] of this.manager.calls) if (session === this) this.manager.calls.delete(id);
    for (const [id, state] of this.manager.responses) if (state.session === this) this.manager.responses.delete(id);
    if (this.waiter) { const wake = this.waiter; this.waiter = null; wake(); }
    // Stop the agent before resolving abandoned MCP handlers, so cancellation
    // cannot accidentally initiate another inference with synthetic results.
    if (this.acp) {
      if (this.activePrompt) this.acp.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.acpId } });
      await this.acp.close();
    }
    await this.bridge.close();
    await rm(this.cwd, { recursive: true, force: true });
  }
}

function sameHistory(a, b) { return stable(a) === stable(b); }

export class SessionManager {
  constructor(config) {
    this.config = config; this.sessions = new Map(); this.calls = new Map(); this.responses = new Map(); this.creating = 0;
    this.closed = false; this.initializing = new Set();
    this.sweeper = setInterval(() => {
      for (const session of this.sessions.values()) {
        const ttl = session.currentCall ? config.toolTimeoutMs : config.sessionTtlMs;
        if (!session.busy && Date.now() - session.touched > ttl) void session.close();
      }
    }, Math.min(config.toolTimeoutMs, config.sessionTtlMs, 1000));
    this.sweeper.unref();
  }

  async create(request, owner) {
    if (this.closed) fail(503, 'server_shutdown', 'Gateway is shutting down');
    if (this.sessions.size + this.creating >= this.config.maxSessions) fail(503, 'session_capacity', 'Active session limit reached. Close an old session or wait for its idle timeout.');
    this.creating++;
    let session, done;
    const completion = new Promise(resolve => { done = resolve; });
    this.initializing.add(completion);
    try {
      await prepareProfile(this.config);
      await requireCredentials(this.config);
      const workspaceRoot = join(this.config.stateDir, 'workspaces');
      await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
      const cwd = await mkdtemp(join(workspaceRoot, 'session-'));
      session = new Session(this, request, owner, cwd);
      if (this.closed) fail(503, 'server_shutdown', 'Gateway is shutting down');
      await session.initialize();
      if (this.closed) fail(503, 'server_shutdown', 'Gateway is shutting down');
      this.sessions.set(session.id, session);
      return session;
    } catch (error) { if (session) await session.close(); throw error; }
    finally { this.creating--; this.initializing.delete(completion); done(); }
  }

  async acquire(request, owner, explicitId) {
    if (request.previousId) {
      const state = this.responses.get(request.previousId);
      if (!state || state.session.owner !== owner) fail(409, 'response_not_found', 'Previous response is unknown, expired or belongs to another API key');
      if (!sameHistory(state.history, state.session.history)) fail(409, 'history_fork_unsupported', 'Only the latest response in this session can be continued');
      request.messages = [...state.history, ...request.messages];
      explicitId = state.session.id;
    }
    if (Buffer.byteLength(JSON.stringify(request.messages)) > this.config.maxBodyBytes) fail(413, 'history_too_large', 'Conversation history exceeds the gateway limit. Start a new session.');
    const last = request.messages.at(-1);
    let session;
    if (explicitId) {
      session = this.sessions.get(explicitId);
      if (!session || session.owner !== owner) fail(409, 'session_not_found', 'Session is unknown, expired or belongs to another API key');
    } else if (last.role === 'tool') {
      session = this.calls.get(last.id);
      if (!session || session.owner !== owner) fail(409, 'unknown_tool_call', 'Tool call is unknown, expired or belongs to another API key');
    } else {
      const prior = request.messages.slice(0, -1);
      const candidates = [...this.sessions.values()].filter(s => s.owner === owner && s.format === request.format && s.requestedModel === request.model && sameHistory(s.history, prior));
      if (candidates.length > 1) fail(409, 'ambiguous_session', 'Multiple sessions match this history. Supply X-ACP-Session-ID.');
      session = candidates[0];
    }
    let fresh = false;
    if (!session) {
      if (last.role !== 'user') fail(400, 'invalid_turn', 'A new conversation must end with a user message');
      if (request.messages.length > 1 && this.config.compatibility === 'strict') fail(409, 'history_import_unsupported', 'This history was not generated by an active gateway session; strict mode does not convert it into a text transcript');
      if (request.messages.length > 1) request.warnings.push('History was imported as a text transcript, not native message roles.');
      session = await this.create(request, owner); fresh = true;
    }
    if (session.busy) fail(409, 'session_busy', 'Another HTTP request is already using this session');
    if (session.closed) fail(409, 'session_expired', 'Session has expired');
    if (session.format !== request.format || session.requestedModel !== request.model || session.system !== request.system) fail(409, 'session_configuration_changed', 'Changing API format, model or system instructions within a session is unsupported');
    if (request.toolsSpecified && stable(toolManifest(session.tools)) !== stable(toolManifest(request.tools))) fail(409, 'tools_changed', 'Changing tools within an existing ACP session is unsupported');
    request.tools = session.tools;
    if (!fresh && !sameHistory(request.messages.slice(0, -1), session.history)) fail(409, 'history_mismatch', 'The supplied history differs from the session history. Editing, branching, and importing arbitrary role messages are unsupported.');
    if (!fresh && session.currentCall && last.role !== 'tool') fail(409, 'tool_result_required', 'Send the outstanding tool result before continuing');
    if (last.role === 'tool' && !session.currentCall) fail(409, 'unexpected_tool_result', 'There is no pending tool result in this session');
    session.busy = true; session.touched = Date.now();
    try {
      session.history = request.messages;
      if (last.role === 'tool') session.resume(last);
      else session.startPrompt(promptBlocks(request, fresh, fresh && request.messages.length > 1));
      return session;
    } catch (e) { session.busy = false; await session.close(); throw e; }
  }

  async collect(session, request, signal, onText) {
    let text = '', reason = 'stop', call = null, bytes = 0;
    const budget = request.outputBudget ?? this.config.maxOutputBytes;
    for (;;) {
      const event = await session.next(signal);
      if (event.type === 'error') throw event.error;
      if (event.type === 'text') {
        let accepted = '';
        for (const char of event.text) { const n = Buffer.byteLength(char); if (bytes + n > budget) break; accepted += char; bytes += n; }
        text += accepted;
        if (accepted) await onText(accepted);
        if (accepted !== event.text) {
          reason = 'length';
          if (request.outputBudget === undefined) throw new ApiError(502, 'output_too_large', 'Agent output exceeded the gateway limit');
          await session.close(); break;
        }
      } else if (event.type === 'call') {
        if (bytes + Buffer.byteLength(JSON.stringify(event.call.arguments)) > budget) throw new ApiError(502, 'tool_output_too_large', 'Tool arguments exceed the output limit; no partial call was returned');
        call = event.call; reason = 'tool_calls';
        session.currentCall = call; this.calls.set(call.id, session); break;
      } else if (event.type === 'end') {
        if (event.reason === 'cancelled') throw new ApiError(502, 'upstream_cancelled', 'The agent cancelled the turn');
        if (['max_tokens', 'max_turn_requests'].includes(event.reason)) reason = 'length';
        else if (event.reason === 'refusal') throw new ApiError(502, 'upstream_refusal', 'Agent refused the turn or exhausted its quota; ACP does not distinguish these conditions');
        else if (event.reason !== 'end_turn') throw new ApiError(502, 'unknown_stop_reason', 'Unknown ACP stop reason');
        break;
      }
    }
    const assistant = { role: 'assistant', content: text ? [{ type: 'text', text }] : [], calls: call ? [call] : [] };
    session.history = [...session.history, assistant];
    session.touched = Date.now();
    return { text, call, reason, model: session.model, sessionId: session.id, warnings: request.warnings, closed: session.closed };
  }

  remember(id, session, body, request) {
    if (!request.store || session.closed) return;
    // Keep the immutable history array by reference. acquire() replaces it,
    // and canonical messages are never mutated after collection.
    this.responses.set(id, { session, history: session.history, body });
    while (this.responses.size > 1000) this.responses.delete(this.responses.keys().next().value);
  }

  async models(owner) {
    const request = { model: 'default', format: 'chat', tools: [], system: '' };
    const session = await this.create(request, owner);
    try { return [{ id: 'default', object: 'model', created: 0, owned_by: 'antigravity', name: 'Current Antigravity default' }, ...session.models.map(m => ({ id: m.modelId, object: 'model', created: 0, owned_by: 'antigravity', name: m.name }))]; }
    finally { await session.close(); }
  }
  async close() {
    this.closed = true; clearInterval(this.sweeper);
    await Promise.all([...this.sessions.values()].map(s => s.close()));
    await Promise.all([...this.initializing]);
  }
}
