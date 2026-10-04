import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { XhsBrowser } from './browser.js';
import { DshModel } from './model.js';
import { PatrolEngine } from './engine.js';
import { createHandler, PANEL_PATH } from './http.js';
import { AGENT_PROMPT } from './rules.js';

export const name = 'dafeiyu-patrol';
export const inject = ['llm', 'agentDefaultModel', 'agentPresets', 'attachments'];
export async function apply(ctx, config = {}) {
  const root = config.dataDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dafeiyu-patrol');
  const engine = await new PatrolEngine(new Store(root), new XhsBrowser(root, ctx.attachments), new DshModel(ctx)).init();
  ctx.provide('dafeiyuPatrol', engine);
  ctx.effect(() => () => engine.dispose(), 'patrol cleanup');
  ctx.inject(['webServer', 'connection'], httpCtx => {
    const handler = createHandler(engine);
    httpCtx.effect(() => httpCtx.webServer.register({ kind: 'prefix', path: PANEL_PATH, handler: (req, res) => {
      const rejection = httpCtx.connection.requestRejection(req);
      if (rejection) { res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(rejection === 401 ? '请先在同一浏览器登录 DSH，再打开巡查面板。' : '请求来源未获允许'); return; }
      return handler(req, res);
    } }), 'patrol web panel');
  });
  const unregister = await ctx.agentPresets.register({
    id: 'dafeiyu-patrol', name: '鲸声守望', description: '辅助发现不合理讨论，共同维护讨论与创作环境', order: 5,
    plugins: [
      { name: '@deepseek-ai/dsh-persona', config: { prefix: AGENT_PROMPT, suffix: '', complete: false } },
      { name: fileURLToPath(new URL('./agent.js', import.meta.url)) },
    ],
  });
  ctx.effect(() => unregister, 'patrol preset');
}
