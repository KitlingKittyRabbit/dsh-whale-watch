import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const project = fileURLToPath(new URL('../', import.meta.url));
const patch = new URL('../work/patrol-dev.patch.yml', import.meta.url);
await mkdir(new URL('../work/', import.meta.url), { recursive: true });
await writeFile(patch, `- id: hmr\n  config:\n    base: ${JSON.stringify(project)}\n    root: [src, ui, evaluation]\n- insert:\n    - id: dafeiyu-patrol-local\n      name: ${JSON.stringify(fileURLToPath(new URL('../src/index.js', import.meta.url)))}\n`);
console.log('开发覆盖文件：' + fileURLToPath(patch));
console.log('用 dsh web --patch <上述路径> 加载。先在这个 profile 停用正式安装包，避免重复加载。未修改任何 DSH profile 配置。');
