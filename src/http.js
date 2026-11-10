import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BROWSER_DISABLED_MESSAGE } from './disabled-browser.js';

export const PANEL_PATH = '/plugins/dafeiyu-patrol';
const assets = {
  '': ['index.html', 'text/html; charset=utf-8'],
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/native.css': ['native.css', 'text/css; charset=utf-8'],
  '/assets/watch-desk-duo-v2.webp': ['assets/watch-desk-duo-v2.webp', 'image/webp'],
  '/assets/discussion-search.svg': ['assets/discussion-search.svg', 'image/svg+xml'],
};
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('请求应使用 JSON 格式');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 400000) throw new Error('请求内容过大'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
export function createHandler(engine) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname.slice(PANEL_PATH.length);
      if (req.method === 'GET' && Object.hasOwn(assets, route)) {
        const [file, type] = assets[route];
        const content = await readFile(fileURLToPath(new URL(`../ui/${file}`, import.meta.url)));
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache',
          'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'", 'x-content-type-options': 'nosniff' });
        res.end(content); return;
      }
      if (req.method === 'GET') {
        const imageRoute = /^\/api\/image\/([a-zA-Z0-9-]+)\/(\d+)$/.exec(route);
        if (imageRoute) {
          const item = engine.store.data.items.find(i => i.id === imageRoute[1]);
          const image = item?.images?.find(i => i.index === Number(imageRoute[2]));
          if (!image?.attachment || !engine.model.ctx?.attachments) return send(res, 404, { error: '配图未保存' });
          const loaded = await engine.readSavedImage(item.id, image.index);
          res.writeHead(200, { 'content-type': loaded.ref.mediaType, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
          res.end(loaded.data); return;
        }
        const downloads = {
          '/api/context/export': () => engine.exportContext(),
          '/api/context/template': () => engine.contextFormat().template,
          '/api/context/builtin/export': () => engine.builtinContext(),
          '/api/context/draft/export': () => engine.draftContext(),
        };
        if (Object.hasOwn(downloads, route)) {
          const config = downloads[route]();
          res.setHeader('content-disposition', `attachment; filename="${config.id}.json"`);
          return send(res, 200, config);
        }
        if (route === '/api/context/document') return send(res, 200, engine.contextDocument());
        if (route === '/api/context') return send(res, 200, engine.context());
        if (route === '/api/status') return send(res, 200, engine.state());
        if (route === '/api/models') return send(res, 200, await engine.model.catalog());
        if (route === '/api/background') return send(res, 200, engine.background());
        if (route === '/api/evaluation') return send(res, 200, engine.evaluation());
        if (route === '/api/results') return send(res, 200, engine.results({ filter: url.searchParams.get('filter') || 'all', batch: url.searchParams.get('batch') === 'latest' ? 'latest' : 'all', limit: Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 50)), offset: Math.max(0, Number(url.searchParams.get('offset')) || 0) }));
        if (route === '/api/export') {
          res.setHeader('content-disposition', 'attachment; filename="dafeiyu-patrol-results.json"');
          return send(res, 200, engine.exportRecords());
        }
        if (route === '/api/evaluation/export') {
          res.setHeader('content-disposition', 'attachment; filename="dafeiyu-patrol-evaluation.json"');
          return send(res, 200, engine.evaluation());
        }
      }
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (!origin || new URL(origin).host !== req.headers.host || req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: '操作必须从巡查面板发起' });
        const data = await body(req);
        if (route === '/api/context/edit') return send(res, 200, await engine.editContext(data));
        if (route === '/api/context/import') return send(res, 200, await engine.importContext(data));
        if (route === '/api/context/builtin') return send(res, 200, await engine.useBuiltinContext());
        if (route === '/api/context/validate') return send(res, 200, engine.validateContext(data));
        if (route === '/api/context/draft') return send(res, 200, await engine.saveContextDraft(data));
        if (route === '/api/context/apply-draft') return send(res, 200, await engine.applyContextDraft());
        if (route === '/api/context/unload') return send(res, 200, await engine.unloadContext());
        if (route === '/api/context/undo') return send(res, 200, await engine.undoContext());
        if (route === '/api/background/preset') return send(res, 200, await engine.useCommunityBackground());
        if (['/api/background/start', '/api/background/update'].includes(route)) return send(res, 410, { error: '旧背景阅读入口已停用，请到专题页编辑资料或让 AI 制作配置' });
        if (route === '/api/settings') return send(res, 200, await engine.settings(data));
        if (route === '/api/data-key') return send(res, 200, await engine.dataKey(data));
        if (route === '/api/login' || route === '/api/source') return send(res, 410, { error: BROWSER_DISABLED_MESSAGE });
        if (route === '/api/collection/clear') return send(res, 200, await engine.clearCollection());
        if (route === '/api/collection/restore') return send(res, 200, await engine.restoreCollection());
        if (route === '/api/start') return send(res, 200, await engine.start(data));
        if (route === '/api/cache/clear') return send(res, 200, await engine.clearSeenCache());
        if (route === '/api/cache/restore') return send(res, 200, await engine.restoreSeenCache());
        if (route === '/api/analysis-cache/clear') return send(res, 200, await engine.clearAnalysisCache());
        if (route === '/api/analysis-cache/restore') return send(res, 200, await engine.restoreAnalysisCache());
        if (route === '/api/analyze/item') return send(res, 200, await engine.retry(data));
        if (route === '/api/analyze') return send(res, 200, await engine.start(data, 'analyze'));
        if (route === '/api/evaluate') return send(res, 200, await engine.start(data, 'evaluate'));
        if (route === '/api/stop') return send(res, 200, await engine.stop());
        if (route === '/api/resume') return send(res, 200, await engine.resume(data));
        if (route === '/api/import') return send(res, 200, await engine.import(data));
        if (route === '/api/read') return send(res, 200, await engine.markRead(data));
        if (route === '/api/review') return send(res, 200, await engine.review(data));
      }
      send(res, 404, { error: '没有这个接口' });
    } catch (error) { if (!res.headersSent) send(res, 400, { error: error.message }); else res.end(); }
  };
}
