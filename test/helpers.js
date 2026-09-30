import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createGateway } from '../src/server.js';

export const tools = [{ type: 'function', function: { name: 'echo', description: 'Return a value from the external caller', parameters: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false } } }];

export async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'acp2api-test-'));
  const config = await loadConfig({ ...process.env, ACP2API_STATE_DIR: dir, ACP2API_API_KEY: 'test-key', ACP2API_PORT: '0',
    ACP2API_COMMAND: process.execPath, ACP2API_ARGS: JSON.stringify([resolve('test/fake-acp.js')]), ACP2API_AUTH_METHOD: 'gemini-api-key', ACP2API_COMPATIBILITY: 'strict' });
  config.agentEnv.ACP2API_TEST_RECORD_FILE = join(dir, 'record.jsonl');
  Object.assign(config, overrides);
  const gateway = createGateway(config), url = await gateway.listen();
  t.after(async () => { await gateway.close(); await rm(dir, { recursive: true, force: true }); });
  const post = (body, path = '/v1/chat/completions', key = 'test-key', headers = {}) => fetch(`${url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers }, body: JSON.stringify(body),
  });
  return { dir, config, gateway, url, post };
}
