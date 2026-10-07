import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('专题助手入口通过宿主创建空白对话、选择制作预设再打开，不自动发送模型消息', async () => {
  let definition;
  const sandbox = { window: { __ModuleLoader__: { load: module => { definition = module.factory(() => ({ createElement() {} })); } } }, document: { createElement: () => ({ remove() {} }), head: { append() {} } } };
  vm.runInNewContext(await readFile(new URL('../ui/client.js', import.meta.url), 'utf8'), sandbox);
  for (const service of ['sessions', 'remote', 'remote.agentPresets', 'uiWorkspace']) assert.ok(definition.inject.includes(service));
  const registrations = [], actions = [];
  const ctx = { effect: fn => fn(), layout: { selectPanel: id => actions.push(['panel', id]) }, slots: { inject: (_name, fn) => fn(), register: spec => { registrations.push(spec); return () => {}; } },
    sessions: { create: async () => { actions.push(['create']); return 'blank-config-session'; } },
    remote: { agentPresets: { select: async (id, preset) => { actions.push(['preset', id, preset]); return { ok: true }; } } },
    uiWorkspace: { openSession: id => actions.push(['open', id]) } };
  definition.apply(ctx);
  await registrations.find(s => s.name === 'main').inject().openBuilder();
  assert.deepEqual(actions, [['create'], ['preset', 'blank-config-session', 'whale-watch-context-builder'], ['open', 'blank-config-session']]);
});
