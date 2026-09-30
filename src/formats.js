import { randomUUID } from 'node:crypto';
import { errorBody } from './errors.js';

const uid = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const estimate = value => Math.ceil(Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value)) / 4);

export class Output {
  constructor(res, request, session, config) {
    this.res = res; this.request = request; this.session = session; this.config = config;
    this.format = request.format; this.id = uid(this.format === 'messages' ? 'msg' : this.format === 'responses' ? 'resp' : 'chatcmpl');
    this.messageId = uid('msg'); this.created = Math.floor(Date.now() / 1000); this.text = '';
    this.started = false; this.textStarted = false; this.sequence = 0;
    this.meta = { compatibility: config.compatibility, usage: config.compatibility === 'strict' ? 'unavailable' : 'estimated_visible_bytes_div4',
      tool_calls: 'one_per_response', session_id: session.id, warnings: request.warnings };
    res.setHeader('x-acp-session-id', session.id);
    res.setHeader('x-acp-compatibility', config.compatibility);
    res.setHeader('x-acp-usage', this.meta.usage);
    res.setHeader('x-request-id', this.id);
    res.once('close', () => clearInterval(this.heartbeat));
  }

  usage(text, call) {
    if (this.config.compatibility === 'strict') return null;
    const input = estimate(this.request.messages), output = estimate(text) + (call ? estimate(call.arguments) : 0);
    if (this.format === 'chat') return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
    return { input_tokens: input, output_tokens: output, ...(this.format === 'responses' ? { total_tokens: input + output } : {}) };
  }

  responseObject(result, output = []) {
    return { id: this.id, object: 'response', created_at: this.created, status: result?.reason === 'length' ? 'incomplete' : 'completed',
      error: null, incomplete_details: result?.reason === 'length' ? { reason: 'max_output_tokens' } : null,
      model: this.session.model, output, parallel_tool_calls: false,
      usage: this.usage(result?.text || '', result?.call), metadata: this.request.metadata || {}, x_acp: this.meta };
  }

  async write(data) {
    if (this.res.destroyed) throw new Error('Client disconnected');
    if (this.res.write(data)) return;
    await new Promise((resolve, reject) => {
      const cleanup = () => { this.res.off('drain', drain); this.res.off('close', close); };
      const drain = () => { cleanup(); resolve(); };
      const close = () => { cleanup(); reject(new Error('Client disconnected')); };
      this.res.once('drain', drain); this.res.once('close', close);
    });
  }
  async event(type, data) {
    if (this.format === 'responses') data = { ...data, type, sequence_number: this.sequence++ };
    await this.write(`${type ? `event: ${type}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
  }
  chunk(delta, finish = null) {
    return { id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.session.model,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }] };
  }
  async begin() {
    if (this.started) return;
    this.started = true;
    this.res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
    this.heartbeat = setInterval(() => { if (!this.res.destroyed) this.res.write(': keepalive\n\n'); }, 15000);
    this.heartbeat.unref();
    if (this.format === 'chat') await this.event(null, this.chunk({ role: 'assistant', content: '' }));
    else if (this.format === 'messages') await this.event('message_start', { type: 'message_start', message: {
      id: this.id, type: 'message', role: 'assistant', model: this.session.model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: estimate(this.request.messages), output_tokens: 0 }, x_acp: this.meta,
    } });
    else {
      const response = { ...this.responseObject(null), status: 'in_progress', usage: null };
      await this.event('response.created', { response });
      await this.event('response.in_progress', { response });
    }
  }
  async textDelta(text) {
    this.text += text;
    if (!this.request.stream) return;
    await this.begin();
    if (this.format === 'chat') await this.event(null, this.chunk({ content: text }));
    else if (this.format === 'messages') {
      if (!this.textStarted) await this.event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      await this.event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    } else {
      if (!this.textStarted) {
        await this.event('response.output_item.added', { output_index: 0, item: { id: this.messageId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
        await this.event('response.content_part.added', { item_id: this.messageId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      }
      await this.event('response.output_text.delta', { item_id: this.messageId, output_index: 0, content_index: 0, delta: text, logprobs: [] });
    }
    this.textStarted = true;
  }

  async finish(result) {
    const call = result.call;
    const textItem = { id: this.messageId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: result.text, annotations: [], logprobs: [] }] };
    const callItem = call && { id: uid('fc'), type: 'function_call', status: 'completed', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) };
    if (result.reason === 'length') textItem.status = 'incomplete';
    let body;
    if (this.format === 'chat') {
      const message = { role: 'assistant', content: result.text || (call ? null : '') };
      if (call) message.tool_calls = [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }];
      body = { id: this.id, object: 'chat.completion', created: this.created, model: result.model,
        choices: [{ index: 0, message, finish_reason: result.reason, logprobs: null }], x_acp: this.meta };
      const usage = this.usage(result.text, call); if (usage) body.usage = usage;
    } else if (this.format === 'messages') {
      const content = [];
      if (result.text || !call) content.push({ type: 'text', text: result.text });
      if (call) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
      body = { id: this.id, type: 'message', role: 'assistant', model: result.model, content,
        stop_reason: result.reason === 'tool_calls' ? 'tool_use' : result.reason === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null,
        usage: this.usage(result.text, call), x_acp: this.meta };
    } else body = this.responseObject(result, [...(result.text || !call ? [textItem] : []), ...(call ? [callItem] : [])]);

    if (!this.request.stream) {
      this.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      this.res.end(JSON.stringify(body)); return body;
    }
    await this.begin();
    if (this.format === 'chat') {
      if (call) await this.event(null, this.chunk({ tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }));
      await this.event(null, this.chunk({}, result.reason));
      if (this.config.compatibility === 'relaxed') await this.event(null, { ...this.chunk({}), choices: [], usage: body.usage, x_acp: this.meta });
      await this.write('data: [DONE]\n\n');
    } else if (this.format === 'messages') {
      if (this.textStarted) await this.event('content_block_stop', { type: 'content_block_stop', index: 0 });
      if (call) {
        const index = this.textStarted ? 1 : 0;
        await this.event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } });
        await this.event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) } });
        await this.event('content_block_stop', { type: 'content_block_stop', index });
      } else if (!this.textStarted) {
        await this.event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        await this.event('content_block_stop', { type: 'content_block_stop', index: 0 });
      }
      await this.event('message_delta', { type: 'message_delta', delta: { stop_reason: body.stop_reason, stop_sequence: null }, usage: { output_tokens: body.usage.output_tokens } });
      await this.event('message_stop', { type: 'message_stop' });
    } else {
      if (this.textStarted) {
        await this.event('response.output_text.done', { item_id: this.messageId, output_index: 0, content_index: 0, text: result.text, logprobs: [] });
        await this.event('response.content_part.done', { item_id: this.messageId, output_index: 0, content_index: 0, part: textItem.content[0] });
        await this.event('response.output_item.done', { output_index: 0, item: textItem });
      } else if (!call) {
        await this.event('response.output_item.added', { output_index: 0, item: { ...textItem, status: 'in_progress' } });
        await this.event('response.output_item.done', { output_index: 0, item: textItem });
      }
      if (call) {
        const index = this.textStarted ? 1 : 0;
        await this.event('response.output_item.added', { output_index: index, item: { ...callItem, status: 'in_progress', arguments: '' } });
        await this.event('response.function_call_arguments.delta', { item_id: callItem.id, output_index: index, delta: callItem.arguments });
        await this.event('response.function_call_arguments.done', { item_id: callItem.id, output_index: index, name: callItem.name, arguments: callItem.arguments });
        await this.event('response.output_item.done', { output_index: index, item: callItem });
      }
      await this.event(result.reason === 'length' ? 'response.incomplete' : 'response.completed', { response: body });
    }
    clearInterval(this.heartbeat); this.res.end(); return body;
  }
  async error(error) {
    clearInterval(this.heartbeat);
    if (this.res.destroyed) return;
    const body = errorBody(error, this.format);
    if (!this.res.headersSent) {
      this.res.writeHead(error.status || 502, { 'content-type': 'application/json' }); this.res.end(JSON.stringify(body));
    } else {
      if (this.format === 'responses') await this.event('error', { code: error.code || 'upstream_error', message: error.message, param: null });
      else await this.event(this.format === 'messages' ? 'error' : null, body);
      this.res.end();
    }
  }
}
