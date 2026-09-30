import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ROOT } from '../src/config.js';

export async function connection() {
  const baseURL = process.env.ACP2API_BASE_URL || `http://${process.env.ACP2API_HOST || '127.0.0.1'}:${process.env.ACP2API_PORT || '8787'}`;
  const key = process.env.ACP2API_API_KEY || (await readFile(join(resolve(process.env.ACP2API_STATE_DIR || join(ROOT, '.state')), 'api-key'), 'utf8')).trim();
  return api(baseURL, key);
}

export function api(baseURL, key) {
  return async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`${baseURL}${path}`, {
      method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    return response;
  };
}

export async function* sse(response) {
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      if (data === '[DONE]') return;
      const value = JSON.parse(data);
      if (value.error || value.type === 'error') throw new Error(JSON.stringify(value));
      yield value;
    }
  }
}

export const echoTools = [{ type: 'function', function: {
  name: 'echo', description: 'Ask the external API client to echo an integer; wait for its real response.',
  parameters: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false },
} }];
