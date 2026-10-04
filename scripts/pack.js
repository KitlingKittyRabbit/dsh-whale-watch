import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

// A fresh checkout has no ignored artifacts directory yet.
await mkdir('artifacts', { recursive: true });
if (!process.env.npm_execpath) throw new Error('请通过 npm run pack:plugin 打包');
const result = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--pack-destination', 'artifacts'], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
