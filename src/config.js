import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from './errors.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function integer(value, fallback, min = 1) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`Invalid integer configuration: ${value}`);
  return n;
}

export async function loadConfig(env = process.env) {
  const stateDir = resolve(env.ACP2API_STATE_DIR || join(ROOT, '.state'));
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const keyFile = join(stateDir, 'api-key');
  let apiKey = env.ACP2API_API_KEY;
  if (!apiKey) {
    try { apiKey = (await readFile(keyFile, 'utf8')).trim(); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      apiKey = randomBytes(32).toString('hex');
      try { await writeFile(keyFile, `${apiKey}\n`, { mode: 0o600, flag: 'wx' }); }
      catch (e) { if (e.code !== 'EEXIST') throw e; apiKey = (await readFile(keyFile, 'utf8')).trim(); }
    }
  }
  if (!apiKey) throw new Error('Gateway API key must not be empty');
  const compatibility = env.ACP2API_COMPATIBILITY || 'strict';
  if (!['strict', 'relaxed'].includes(compatibility)) throw new Error('ACP2API_COMPATIBILITY must be strict or relaxed');
  const authMethod = env.ACP2API_AUTH_METHOD || 'oauth-personal';
  if (!['oauth-personal', 'gemini-api-key'].includes(authMethod)) throw new Error('Unsupported auth method');
  const args = env.ACP2API_ARGS ? JSON.parse(env.ACP2API_ARGS) : process.platform === 'linux' ? ['--uid='] : [];
  if (!Array.isArray(args) || args.some(x => typeof x !== 'string')) throw new Error('ACP2API_ARGS must be a JSON string array');
  return {
    host: env.ACP2API_HOST || '127.0.0.1', port: integer(env.ACP2API_PORT, 8787, 0),
    apiKeys: [apiKey], keyFile, stateDir, compatibility, authMethod,
    geminiHome: join(stateDir, 'gemini'),
    command: env.ACP2API_COMMAND || join(ROOT, '.runtime', process.platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par'),
    args, agentEnv: { ...env }, maxSessions: integer(env.ACP2API_MAX_SESSIONS, 4),
    requestTimeoutMs: integer(env.ACP2API_REQUEST_TIMEOUT_MS, 120000),
    toolTimeoutMs: integer(env.ACP2API_TOOL_TIMEOUT_MS, 300000),
    sessionTtlMs: integer(env.ACP2API_SESSION_TTL_MS, 900000),
    maxBodyBytes: 4 * 1024 * 1024, maxOutputBytes: 4 * 1024 * 1024,
    rpcTimeoutMs: 30000, helperPath: join(ROOT, 'src', 'mcp-helper.js'),
  };
}

export async function prepareProfile(config) {
  const dir = join(config.geminiHome, 'antigravity-acp');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'settings.json');
  try { await writeFile(path, JSON.stringify({ auth: { type: config.authMethod } }), { flag: 'wx', mode: 0o600 }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const profile = JSON.parse(await readFile(path, 'utf8'));
    if (profile.auth?.type !== config.authMethod) throw new ApiError(409, 'auth_profile_mismatch', 'The existing profile uses another authentication method. Select its original ACP2API_AUTH_METHOD or a separate ACP2API_STATE_DIR.');
  }
}

export async function requireCredentials(config) {
  if (config.authMethod !== 'oauth-personal') return;
  try { await access(join(config.geminiHome, 'antigravity-acp', 'acp_token.json')); }
  catch { throw new ApiError(401, 'google_login_required', 'No Google subscription login exists in this gateway profile. Run npm run login on the gateway host.'); }
}
