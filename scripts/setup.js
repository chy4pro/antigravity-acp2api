import { mkdir, mkdtemp, rename, rm, chmod, access, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import yauzl from 'yauzl';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { ROOT } from '../src/config.js';

const version = '1.2.1';
const platform = process.platform, arch = process.arch;
if (!['linux', 'darwin'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
  throw new Error('Automatic install supports Linux/macOS arm64 and x64. For another platform, install the official ACP package and set ACP2API_COMMAND/ACP2API_ARGS.');
}
const target = join(ROOT, '.runtime');
try { await access(join(target, 'agy_acp_server.par')); console.log('Official runtime already exists in .runtime. No files were replaced.'); }
catch {
  const temp = await mkdtemp(join(ROOT, '.runtime-install-'));
  try {
    const archive = join(temp, 'release.zip');
    const osDir = platform === 'darwin' ? 'macos' : 'linux';
    const archName = arch === 'x64' ? 'x86_64' : 'arm64';
    const url = `https://dl.google.com/agy-extensions/releases/${osDir}/agy-acp-server-${version}-${platform}-${archName}.zip`;
    console.log(`Downloading official Antigravity ACP ${version} from dl.google.com (several hundred MB).`);
    const response = await fetch(url, { signal: AbortSignal.timeout(600000) });
    if (!response.ok) throw new Error(`Official download returned HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { mode: 0o600 }));
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    const extracted = join(temp, 'bin'); await mkdir(extracted);
    // Only these two fixed root filenames are extracted; archive paths and
    // symlinks are never used as destination paths.
    await new Promise((resolve, reject) => {
      yauzl.open(archive, { lazyEntries: true }, (error, zip) => {
        if (error) return reject(error);
        zip.on('error', reject); zip.on('end', resolve);
        zip.on('entry', entry => {
          if (!['agy_acp_server.par', 'localharness_external'].includes(entry.fileName)) return zip.readEntry();
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (mode === 0o120000 || entry.uncompressedSize > 2 * 1024 ** 3) { zip.close(); return reject(new Error('Unexpected runtime archive entry')); }
          zip.openReadStream(entry, (error, stream) => {
            if (error) { zip.close(); return reject(error); }
            void pipeline(stream, createWriteStream(join(extracted, entry.fileName), { flags: 'wx', mode: 0o700 }))
              .then(() => zip.readEntry(), error => { zip.close(); reject(error); });
          });
        });
        zip.readEntry();
      });
    });
    await access(join(extracted, 'agy_acp_server.par'));
    await access(join(extracted, 'localharness_external'));
    await chmod(join(extracted, 'agy_acp_server.par'), 0o755);
    await chmod(join(extracted, 'localharness_external'), 0o755);
    await writeFile(join(extracted, 'install.json'), JSON.stringify({ version, url, archive_sha256: hash.digest('hex'), downloaded_at: new Date().toISOString() }, null, 2));
    await rename(extracted, target);
    console.log('Installed. Run npm run login, then npm run doctor.');
  } finally { await rm(temp, { recursive: true, force: true }); }
}
