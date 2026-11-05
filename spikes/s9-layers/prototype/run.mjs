import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// Check BEFORE resolving/loading Electron. This script cannot launch locally.
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CLOVER_S9_CI !== '1') throw new Error('Electron runs only in the S9 GitHub Actions job');
const command = process.argv[2];
const checks = command === 'all' ? ['process', 'memory', 'crossing', 'network'] : [command];
if (checks.some(c => !['process', 'memory', 'crossing', 'network'].includes(c))) throw new Error('unknown check');
const executable = resolve('node_modules/electron/dist', readFileSync('node_modules/electron/path.txt', 'utf8').trim());
mkdirSync('results', { recursive: true });
for (const check of checks) for (const count of check === 'memory' ? [1, 5, 10, 20] : [3]) {
  const home = mkdtempSync(join(tmpdir(), 'clover-s9-'));
  console.log(`Clover S9 ${check}, ${count} layers: starting CI-only Electron`);
  const child = spawn(executable, ['main.cjs', `--check=${check}`, `--layers=${count}`], { stdio: 'inherit', env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, CLOVER_HOME: home } });
  const timeout = setTimeout(() => child.kill('SIGKILL'), check === 'network' ? 420_000 : 180_000);
  const code = await new Promise(resolve => child.once('exit', resolve));
  clearTimeout(timeout);
  if (code !== 0) process.exitCode = 1;
}
