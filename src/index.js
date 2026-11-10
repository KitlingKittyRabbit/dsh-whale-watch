import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { Store } from './store.js';
import { DisabledBrowser } from './disabled-browser.js';
import { DshModel } from './model.js';
import { PatrolEngine } from './engine.js';
import { createHandler, PANEL_PATH } from './http.js';
import { CONTEXT_BUILDER_PROMPT } from './topic-context.js';
import { AGENT_PROMPT } from './rules.js';
import { SocialDataX } from './socialdatax.js';

export const name = 'dafeiyu-patrol';
export const inject = ['llm', 'agentDefaultModel', 'agentPresets', 'attachments'];
export async function apply(ctx, config = {}) {
  const root = config.dataDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dafeiyu-patrol');
  const engine = await new PatrolEngine(new Store(root), new DisabledBrowser(), new DshModel(ctx), new SocialDataX(root, ctx.attachments)).init();
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
  // Native scheduling is verified with this host revision. Older supported
  // hosts keep their patrol preset without requiring a newer host package.
  const toolsVersion = JSON.parse(await readFile(new URL(import.meta.resolve('@deepseek-ai/dsh-tools/package.json')), 'utf8')).version;
  const scheduleTools = toolsVersion === '0.2.2-rc.1' && !!ctx.get?.('schedule');
  engine.capabilities = { schedule: scheduleTools };
  const unregister = await ctx.agentPresets.register({
    id: 'dafeiyu-patrol', name: '鲸声守望', description: '操作工作台：采集、分析、查看结果、管理专题和设置', order: 5,
    plugins: [
      { name: '@deepseek-ai/dsh-persona', config: { prefix: AGENT_PROMPT, suffix: '', complete: false } },
      { name: fileURLToPath(new URL('./agent.js', import.meta.url)), config: { scheduleTools } },
      ...(scheduleTools ? [{ name: '@deepseek-ai/dsh-tool-schedule' }] : []),
    ],
  });
  ctx.effect(() => unregister, 'patrol preset');
  const unregisterBuilder = await ctx.agentPresets.register({
    id: 'whale-watch-context-builder', name: '鲸声守望配置制作助手', description: '只制作专题草稿：整理背景和术语，不采集、不分析、不直接启用', order: 6,
    plugins: [
      { name: '@deepseek-ai/dsh-persona', config: { prefix: CONTEXT_BUILDER_PROMPT, suffix: '', complete: false } },
      { name: fileURLToPath(new URL('./context-agent.js', import.meta.url)) },
    ],
  });
  ctx.effect(() => unregisterBuilder, 'context builder preset');
}
