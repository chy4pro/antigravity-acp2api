import { mkdtemp, mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, prepareProfile, requireCredentials } from './config.js';
import { AcpClient } from './acp.js';
import { createGateway } from './server.js';

const command = process.argv[2] || 'serve';
try {
  const config = await loadConfig();
  if (command === 'serve') {
    await access(config.command);
    const gateway = createGateway(config);
    const address = await gateway.listen();
    console.log(JSON.stringify({ event: 'listening', address, compatibility: config.compatibility, key_file: config.keyFile }));
    let closing = false;
    const close = async () => { if (closing) return; closing = true; await gateway.close(); };
    process.on('SIGTERM', () => { void close(); });
    process.on('SIGINT', () => { void close(); });
  } else if (command === 'login' || command === 'doctor') {
    await prepareProfile(config);
    if (command === 'doctor') await requireCredentials(config);
    await mkdir(join(config.stateDir, 'workspaces'), { recursive: true, mode: 0o700 });
    const cwd = await mkdtemp(join(config.stateDir, 'workspaces', `${command}-`));
    const client = new AcpClient(config, cwd);
    client.on('fault', () => {});
    const interrupted = () => { void client.close(); };
    process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
    try {
      const info = await client.initialize();
      console.log(JSON.stringify({ agent: info.agentInfo, auth_methods: info.authMethods?.map(m => m.id) }));
      if (command === 'login') {
        console.log(`Starting official ${config.authMethod} login. Credentials stay in ${config.geminiHome}.`);
        client.on('diagnostic', text => process.stderr.write(text));
        await client.request('authenticate', { methodId: config.authMethod }, 600000);
        console.log('Official authentication completed.');
      } else {
        const result = await client.request('session/new', { cwd, mcpServers: [], _meta: { agy: { enabledTools: [] } } });
        console.log(JSON.stringify({ status: 'ready', selected_model: result.models?.currentModelId,
          models: result.models?.availableModels?.map(m => m.modelId), inference_performed: false }));
      }
    } finally {
      process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted);
      client.removeAllListeners('diagnostic'); await client.close(); await rm(cwd, { recursive: true, force: true });
    }
  } else throw new Error('Usage: node src/cli.js serve|login|doctor');
} catch (e) {
  console.error(JSON.stringify({ error: e.code || 'startup_error', message: e.code === 'ENOENT' ? 'Official runtime is missing. Run npm run setup first.' : e.message }));
  process.exitCode = 1;
}
