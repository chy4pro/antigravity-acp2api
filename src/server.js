import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readJson, equalSecret } from './bridge.js';
import { normalize } from './normalize.js';
import { SessionManager } from './sessions.js';
import { Output } from './formats.js';
import { ApiError, asApiError, errorBody, fail } from './errors.js';

export function createGateway(config) {
  const manager = new SessionManager(config);
  const controllers = new Set();
  const server = createServer((req, res) => { void handle(req, res); });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;

  function authenticate(req) {
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
    const key = bearer || req.headers['x-api-key'];
    if (typeof key !== 'string' || !config.apiKeys.some(candidate => equalSecret(key, candidate))) fail(401, 'invalid_api_key', 'A valid gateway API key is required');
    return createHash('sha256').update(key).digest('hex');
  }
  function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }

  async function handle(req, res) {
    let format = 'chat', output, session;
    const abort = new AbortController(); controllers.add(abort);
    const disconnected = () => { if (!res.writableFinished) abort.abort(new ApiError(499, 'client_disconnected', 'Client disconnected')); };
    res.once('close', disconnected);
    let timer;
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/v1/messages') format = 'messages';
      else if (path.startsWith('/v1/responses')) format = 'responses';
      if (req.method === 'GET' && path === '/health') return json(res, 200, { status: 'ok', service: 'antigravity-acp2api', version: '0.0.1' });
      const owner = authenticate(req);
      if (req.method === 'GET' && path === '/v1/acp/capabilities') return json(res, 200, {
        version: '0.0.1', runtime: 'antigravity-acp 1.2.1', compatibility: config.compatibility,
        endpoints: ['/v1/chat/completions', '/v1/responses', '/v1/messages'],
        text_streaming: true, external_tools: 'one_call_per_response', builtins: 'disabled',
        usage: config.compatibility === 'strict' ? 'unavailable' : 'estimated_visible_bytes_div4',
        claude_messages: config.compatibility === 'strict' ? 'rejected_exact_usage_and_max_tokens_unavailable' : 'approximate_explicitly_labeled',
        history: 'live_session_exact_prefix', pending_call_restart_recovery: false,
        unsupported: ['temperature', 'top_p', 'native_system_priority', 'strict_json', 'required_tool_choice', 'parallel_tool_calls=true', 'thinking_signatures', 'cache_control'],
      });
      if (req.method === 'GET' && path === '/v1/models') return json(res, 200, { object: 'list', data: await manager.models(owner) });
      if (req.method === 'GET' && /^\/v1\/responses\/[^/]+$/.test(path)) {
        const state = manager.responses.get(path.split('/').at(-1));
        if (!state || state.session.owner !== owner) fail(404, 'response_not_found', 'Response is unavailable');
        return json(res, 200, state.body);
      }
      if (req.method === 'DELETE' && /^\/v1\/sessions\/[^/]+$/.test(path)) {
        const id = path.split('/').at(-1), target = manager.sessions.get(id);
        if (!target || target.owner !== owner) fail(404, 'session_not_found', 'Session is unavailable');
        await target.close(); return json(res, 200, { id, deleted: true });
      }
      if (req.method !== 'POST' || !['/v1/chat/completions', '/v1/messages', '/v1/responses'].includes(path)) fail(404, 'not_found', 'Endpoint not found');
      if (!(req.headers['content-type'] || '').toLowerCase().includes('application/json')) fail(415, 'unsupported_media_type', 'Use Content-Type: application/json');
      const body = await readJson(req, config.maxBodyBytes);
      const request = normalize(body, format, config);
      timer = setTimeout(() => abort.abort(new ApiError(504, 'request_timeout', 'The active request timed out; its ACP session has been closed')), config.requestTimeoutMs);
      // Do not detach acquisition on cancellation: wait for the bounded ACP
      // handshake, then close it, so no abandoned agent process is leaked.
      session = await manager.acquire(request, owner, req.headers['x-acp-session-id']);
      if (abort.signal.aborted) throw abort.signal.reason;
      output = new Output(res, request, session, config);
      const result = await manager.collect(session, request, abort.signal, text => output.textDelta(text));
      const response = await output.finish(result);
      if (format === 'responses') manager.remember(output.id, session, response, request);
    } catch (error) {
      const e = asApiError(error);
      if (session) await session.close();
      if (!res.destroyed) {
        try {
          if (output) await output.error(e);
          else json(res, e.status, errorBody(e, format));
        } catch { res.destroy(); }
      }
    } finally {
      clearTimeout(timer); controllers.delete(abort); res.off('close', disconnected);
      if (session) { session.busy = false; session.touched = Date.now(); }
    }
  }

  return {
    server, manager, config,
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
      return `http://${config.host}:${server.address().port}`;
    },
    async close() {
      for (const controller of controllers) controller.abort(new ApiError(503, 'server_shutdown', 'Gateway is shutting down'));
      await manager.close();
      if (server.listening) { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; }
    },
  };
}
