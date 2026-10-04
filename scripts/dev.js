import { createServer } from 'node:http';
import { join } from 'node:path';
import { Store, hash } from '../src/store.js';
import { XhsBrowser } from '../src/browser.js';
import { PatrolEngine } from '../src/engine.js';
import { createHandler } from '../src/http.js';

// Independent preview uses no keys. The real model adapter is mounted by DSH.
const model = {
  async catalog() { return { mode: 'offline', current: { provider: '请在 DSH 内使用', model: '现有模型配置' }, providers: [] }; },
  cacheKey(item, settings) { return hash(item.contentHash + settings.rules + 'offline'); },
  async analyze() { throw new Error('当前是独立界面预览，请从 DSH 中打开插件以使用已配置的模型'); },
};
const root = join(process.cwd(), '.data', 'preview');
const engine = await new PatrolEngine(new Store(root), new XhsBrowser(root), model).init();
const handler = createHandler(engine);
const server = createServer((req, res) => {
  if (req.url === '/') { res.writeHead(302, { location: '/plugins/dafeiyu-patrol' }); res.end(); }
  else handler(req, res);
});
server.listen(3086, '127.0.0.1', () => console.log('独立界面预览：http://127.0.0.1:3086/plugins/dafeiyu-patrol（模型分析请从 DSH 打开）'));
async function close() { await engine.dispose(); server.close(() => process.exit(0)); }
process.on('SIGINT', close); process.on('SIGTERM', close);
