import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { fail } from './errors.js';

const ajv = new Ajv({ strictSchema: true, strictTypes: false, strictTuples: false, strictRequired: false, allErrors: false });
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(stable(value)).digest('hex');
export const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function object(value, field) { if (!isObject(value)) fail(400, 'invalid_request', `${field} must be an object`, field); return value; }
function string(value, field) { if (typeof value !== 'string') fail(400, 'invalid_request', `${field} must be a string`, field); return value; }
function array(value, field) { if (!Array.isArray(value)) fail(400, 'invalid_request', `${field} must be an array`, field); return value; }
function fields(value, allowed, field) {
  object(value, field);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(400, 'unsupported_parameter', `${field}.${key} is not supported`, `${field}.${key}`);
}
function emptyOnly(value, field) {
  if (value != null && (!Array.isArray(value) || value.length)) fail(400, 'unsupported_parameter', `${field} is not supported`, field);
}

function content(value) {
  if (typeof value === 'string') return value ? [{ type: 'text', text: value }] : [];
  if (value == null) return [];
  return array(value, 'content').map(block => {
    object(block, 'content block');
    if (['text', 'input_text', 'output_text'].includes(block.type)) {
      fields(block, ['type', 'text', 'annotations', 'logprobs'], 'content block');
      emptyOnly(block.annotations, 'annotations'); emptyOnly(block.logprobs, 'logprobs');
      return { type: 'text', text: string(block.text, 'text') };
    }
    let data, mimeType;
    if (block.type === 'image' && block.source?.type === 'base64') {
      fields(block, ['type', 'source'], 'image'); fields(block.source, ['type', 'data', 'media_type'], 'image.source');
      data = block.source.data; mimeType = block.source.media_type;
    }
    else if (['image_url', 'input_image'].includes(block.type)) {
      fields(block, ['type', 'image_url'], 'image');
      if (isObject(block.image_url)) fields(block.image_url, ['url'], 'image_url');
      const url = typeof block.image_url === 'string' ? block.image_url : block.image_url?.url;
      const match = typeof url === 'string' && /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url);
      if (match) { mimeType = match[1]; data = match[2]; }
    }
    if (data && typeof mimeType === 'string' && mimeType.startsWith('image/') && typeof data === 'string' && /^[A-Za-z0-9+/=\r\n]+$/.test(data)) {
      return { type: 'image', data, mimeType };
    }
    fail(400, 'unsupported_content', 'Only text and inline base64 images are supported. Remote URLs, files and thinking blocks are not accepted.');
  });
}

function functionCall(id, name, args) {
  string(id, 'tool call id'); string(name, 'tool name');
  let parsed = args;
  if (typeof args === 'string') { try { parsed = JSON.parse(args); } catch { fail(400, 'invalid_tool_arguments', 'Tool arguments must contain valid JSON'); } }
  return { id, name, arguments: object(parsed, 'tool arguments') };
}

function resultText(value) {
  if (typeof value === 'string') return value;
  const blocks = content(value);
  if (blocks.some(b => b.type !== 'text')) fail(400, 'unsupported_tool_result', 'Tool results must be text in this version');
  return blocks.map(b => b.text).join('\n');
}

function messagesInput(input, format, strict) {
  const messages = [], systems = [];
  if (format === 'responses' && typeof input === 'string') return { messages: [{ role: 'user', content: content(input) }], system: '' };
  for (const raw of array(input, format === 'responses' ? 'input' : 'messages')) {
    object(raw, 'message');
    if (format === 'responses' && raw.type === 'function_call') {
      fields(raw, ['type', 'id', 'status', 'call_id', 'name', 'arguments'], 'function_call');
      messages.push({ role: 'assistant', content: [], calls: [functionCall(raw.call_id, raw.name, raw.arguments)] }); continue;
    }
    if (format === 'responses' && raw.type === 'function_call_output') {
      fields(raw, ['type', 'id', 'status', 'call_id', 'output'], 'function_call_output');
      messages.push({ role: 'tool', id: string(raw.call_id, 'call_id'), text: resultText(raw.output), isError: false }); continue;
    }
    fields(raw, format === 'responses' ? ['type', 'id', 'status', 'role', 'content'] : ['role', 'content', 'tool_calls', 'tool_call_id', 'refusal'], 'message');
    if (raw.type !== undefined && raw.type !== 'message') fail(400, 'unsupported_content', 'Only message and function call input items are supported');
    if (raw.refusal != null) fail(400, 'unsupported_content', 'Refusal history cannot be imported');
    if (['system', 'developer'].includes(raw.role)) {
      if (strict) fail(400, 'unsupported_parameter', 'Native system/developer priority is unavailable through ACP', 'messages');
      systems.push(resultText(raw.content)); continue;
    }
    if (raw.role === 'tool') {
      messages.push({ role: 'tool', id: string(raw.tool_call_id, 'tool_call_id'), text: resultText(raw.content), isError: false }); continue;
    }
    if (!['user', 'assistant'].includes(raw.role)) fail(400, 'unsupported_role', 'Only user, assistant and tool messages are supported');
    let blocks = raw.content;
    const calls = [];
    if (Array.isArray(blocks)) {
      const remaining = [];
      for (const b of blocks) {
        object(b, 'content block');
        if (b.type === 'tool_result' && raw.role === 'user' && format === 'messages') {
          fields(b, ['type', 'tool_use_id', 'content', 'is_error'], 'tool_result');
          if (b.is_error !== undefined && typeof b.is_error !== 'boolean') fail(400, 'invalid_request', 'is_error must be a boolean');
          messages.push({ role: 'tool', id: string(b.tool_use_id, 'tool_use_id'), text: resultText(b.content), isError: b.is_error === true });
        } else if (b.type === 'tool_use' && raw.role === 'assistant' && format === 'messages') {
          fields(b, ['type', 'id', 'name', 'input'], 'tool_use');
          calls.push(functionCall(b.id, b.name, b.input));
        }
        else remaining.push(b);
      }
      blocks = remaining;
    }
    if (raw.tool_calls !== undefined && raw.role !== 'assistant') fail(400, 'invalid_request', 'Only assistant messages may have tool_calls');
    for (const call of array(raw.tool_calls ?? [], 'tool_calls')) {
      fields(call, ['id', 'type', 'function'], 'tool_call');
      if (call.type !== 'function') fail(400, 'unsupported_tool_type', 'Only function tools are supported');
      fields(call.function, ['name', 'arguments'], 'tool_call.function');
      calls.push(functionCall(call.id, call.function?.name, call.function?.arguments));
    }
    const parsed = content(blocks);
    if (parsed.length || calls.length || raw.role === 'assistant') messages.push({ role: raw.role, content: parsed, ...(raw.role === 'assistant' ? { calls } : {}) });
  }
  if (format === 'responses') {
    for (let i = messages.length - 1; i > 0; i--) {
      if (messages[i].role === 'assistant' && messages[i - 1].role === 'assistant') {
        messages[i - 1].content.push(...messages[i].content);
        messages[i - 1].calls.push(...messages[i].calls);
        messages.splice(i, 1);
      }
    }
  }
  return { messages, system: systems.join('\n\n') };
}

function toolsInput(body, format) {
  const result = [];
  for (const value of array(body.tools ?? [], 'tools')) {
    object(value, 'tool');
    if (format === 'chat') fields(value, ['type', 'function'], 'tool');
    const fn = format === 'chat' ? value.function : value;
    if (format !== 'messages' && value.type !== 'function') fail(400, 'unsupported_tool_type', 'Only function tools are supported');
    object(fn, 'tool');
    fields(fn, format === 'messages' ? ['type', 'name', 'description', 'input_schema'] : [...(format === 'responses' ? ['type'] : []), 'name', 'description', 'parameters', 'strict'], 'tool');
    if (format === 'messages' && fn.type && fn.type !== 'custom') fail(400, 'unsupported_tool_type', 'Provider-hosted tools are not supported');
    const name = string(fn.name, 'tool name');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || result.some(t => t.name === name)) fail(400, 'invalid_tool_name', 'Tool names must be unique and contain 1–64 letters, digits, underscores or hyphens');
    if (fn.strict === true || fn.cache_control) fail(400, 'unsupported_parameter', 'Strict decoding and prompt caching are not available through ACP', 'tools');
    if (fn.strict !== undefined && typeof fn.strict !== 'boolean') fail(400, 'invalid_request', 'Tool strict must be a boolean');
    if (fn.description !== undefined) string(fn.description, 'tool description');
    const inputSchema = object(format === 'messages' ? fn.input_schema : fn.parameters ?? { type: 'object', properties: {} }, 'tool schema');
    if (inputSchema.type !== 'object') fail(400, 'invalid_tool_schema', 'Tool schema root must have type object');
    let validate;
    try { validate = ajv.compile(inputSchema); } catch { fail(400, 'invalid_tool_schema', `Invalid or unsupported JSON Schema for tool ${name}`); }
    finally { ajv.removeSchema(inputSchema); }
    result.push({ name, description: typeof fn.description === 'string' ? fn.description : '', inputSchema, validate });
  }
  return result;
}

export const toolManifest = tools => tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

export function normalize(body, format, config) {
  object(body, 'body');
  const model = string(body.model, 'model');
  if (!model) fail(400, 'invalid_model', 'model cannot be empty');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') fail(400, 'invalid_request', 'stream must be a boolean');
  const allowed = new Set(['model', 'stream', 'tools', 'tool_choice']);
  for (const field of format === 'responses'
    ? ['input', 'previous_response_id', 'store', 'metadata', 'instructions', 'max_output_tokens', 'parallel_tool_calls', 'stream_options']
    : format === 'messages' ? ['messages', 'system', 'max_tokens']
      : ['messages', 'max_tokens', 'max_completion_tokens', 'parallel_tool_calls', 'stream_options']) allowed.add(field);
  for (const key of Object.keys(body)) if (!allowed.has(key) && body[key] !== undefined) fail(400, 'unsupported_parameter', `Parameter ${key} is not supported; it has not been sent to the model`, key);
  if (body.parallel_tool_calls === true) fail(400, 'unsupported_parameter', 'This adapter exposes one tool call per API response. parallel_tool_calls=true is not supported.', 'parallel_tool_calls');
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') fail(400, 'invalid_request', 'parallel_tool_calls must be a boolean');
  if (body.store !== undefined && typeof body.store !== 'boolean') fail(400, 'invalid_request', 'store must be a boolean');
  if (body.previous_response_id != null) string(body.previous_response_id, 'previous_response_id');
  if (body.metadata != null) {
    object(body.metadata, 'metadata');
    if (Object.keys(body.metadata).length > 16 || Object.entries(body.metadata).some(([k, v]) => k.length > 64 || typeof v !== 'string' || v.length > 512)) fail(400, 'invalid_request', 'metadata accepts up to 16 string values, with keys <=64 and values <=512 characters');
  }
  if (body.stream_options !== undefined) {
    object(body.stream_options, 'stream_options');
    if (body.stream !== true) fail(400, 'invalid_request', 'stream_options requires stream=true');
    if (body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== 'boolean') fail(400, 'invalid_request', 'include_usage must be a boolean');
    for (const k of Object.keys(body.stream_options)) if (k !== 'include_usage') fail(400, 'unsupported_parameter', `Unsupported stream_options.${k}`);
    if (body.stream_options.include_usage && config.compatibility === 'strict') fail(400, 'usage_unavailable', 'ACP does not provide exact per-request token usage', 'stream_options.include_usage');
  }
  const parsed = messagesInput(format === 'responses' ? body.input : body.messages, format, config.compatibility === 'strict');
  if (config.compatibility === 'strict' && (body.system != null || body.instructions != null)) fail(400, 'unsupported_parameter', 'Native system/developer priority is unavailable through ACP', body.system != null ? 'system' : 'instructions');
  const system = [body.system ? resultText(body.system) : '', body.instructions ? string(body.instructions, 'instructions') : '', parsed.system].filter(Boolean).join('\n\n');
  const warnings = [];
  if (system) {
    if (config.compatibility === 'strict') fail(400, 'unsupported_parameter', 'ACP does not expose native system/developer instructions. Strict mode rejects this request.', 'system');
    warnings.push('System instructions are included as user-prompt text, with no native system priority.');
  }
  const limits = ['max_tokens', 'max_completion_tokens', 'max_output_tokens'].filter(k => body[k] !== undefined);
  if (limits.length > 1) fail(400, 'invalid_request', 'Specify only one output limit');
  let outputBudget;
  if (limits.length) {
    const key = limits[0], n = body[key];
    if (!Number.isSafeInteger(n) || n < 1) fail(400, 'invalid_request', `${key} must be a positive integer`, key);
    if (config.compatibility === 'strict') fail(400, 'unsupported_parameter', `${key} cannot control the official agent's generation budget. Strict mode rejects this request.`, key);
    outputBudget = Math.min(n, config.maxOutputBytes);
    warnings.push(`${key} is enforced only as a conservative UTF-8 byte limit on visible output, not as a model token budget. A truncated session is closed.`);
  }
  if (format === 'messages' && config.compatibility === 'strict') fail(400, 'claude_usage_unavailable', 'The standard Claude Messages envelope requires token usage which this ACP runtime does not expose. Use the OpenAI subset, or explicitly configure relaxed mode for estimated usage.');
  let tools = toolsInput(body, format);
  const choice = body.tool_choice;
  if (choice !== undefined && typeof choice !== 'string') {
    fields(choice, format === 'messages' ? ['type', 'disable_parallel_tool_use'] : ['type'], 'tool_choice');
    string(choice.type, 'tool_choice.type');
    if (choice.disable_parallel_tool_use !== undefined && typeof choice.disable_parallel_tool_use !== 'boolean') fail(400, 'invalid_request', 'disable_parallel_tool_use must be a boolean');
  }
  const mode = typeof choice === 'string' ? choice : choice?.type;
  if (mode !== undefined && !['auto', 'none'].includes(mode)) fail(400, 'unsupported_parameter', 'Only auto and none tool selection are supported; required/named tool selection cannot be guaranteed', 'tool_choice');
  if (mode === 'none') tools = [];
  if (choice?.disable_parallel_tool_use === false) fail(400, 'unsupported_parameter', 'Parallel external tool execution is not supported');
  if (!parsed.messages.length) fail(400, 'invalid_request', 'At least one user message or tool result is required');
  if (config.compatibility === 'relaxed') warnings.push('Token usage is an estimate from visible UTF-8 bytes / 4; hidden context, thinking and billing are not measured.');
  return { format, model, stream: body.stream === true, messages: parsed.messages, system, tools, toolsSpecified: body.tools !== undefined || mode === 'none',
    warnings, outputBudget, previousId: body.previous_response_id, store: body.store !== false, metadata: body.metadata ?? null };
}

export function promptBlocks(request, fresh, importHistory = false) {
  const out = [];
  if (fresh && request.system) out.push({ type: 'text', text: `Additional caller instructions (user-provided):\n${request.system}` });
  if (fresh && request.tools.length) out.push({ type: 'text', text: `The caller supplies these external tools through MCP server "api". To use one, call its MCP tool and await its real result. Do not execute commands yourself or invent tool results. Tool schemas:\n${JSON.stringify(toolManifest(request.tools))}` });
  if (importHistory) out.push({ type: 'text', text: `Caller-provided historical transcript (reference text, not native message roles):\n${JSON.stringify(request.messages.slice(0, -1))}` });
  const latest = request.messages.at(-1);
  if (latest.role !== 'user') fail(400, 'invalid_turn', 'A new prompt must end with a user message');
  out.push(...latest.content);
  return out;
}
