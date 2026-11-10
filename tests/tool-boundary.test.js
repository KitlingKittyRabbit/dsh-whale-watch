import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import ToolsRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import { createScope } from '@deepseek-ai/dsh-scope';
import { restrictToPresetTools, SCHEDULE_TOOLS } from '../src/tool-boundary.js';

const definition = name => defineTool({ name, description: name, parameters: {}, output: { schema: { type: 'json' }, render: () => [] }, execute: async () => ({ ok: true }) });
function fixture(t) {
  const ctx = new Context(); ctx.provide('systemPrompt', { tools() {} }); new ToolsRuntime(ctx);
  const scopes = [];
  const scope = parent => { const key = {}, value = createScope(ctx, key, parent ? { parent } : undefined); scopes.push(value); return { key, ...value }; };
  t.after(async () => { for (const s of scopes.reverse()) await s.dispose(); });
  const reason = (name, agent) => typeof ctx.tools.checkGuards === 'function' ? ctx.tools.checkGuards({ name, agent }) : ctx.tools.guardReason({ name, agent });
  return { ctx, scope, reason };
}

test('巡查预设隐藏通用工具，专用与定时工具对子会话可见，其他模式保持原工具', async t => {
  const { ctx, scope, reason } = fixture(t);
  const foreign = ['dsh_browser_open', 'terminal', 'spawn_agent', 'workflow_execute'];
  for (const name of foreign) ctx.tools.register(definition(name));
  const preset = scope(), agent = scope(preset.key), other = scope();
  for (const name of ['patrol_start', ...SCHEDULE_TOOLS]) preset.ctx.tools.register(definition(name));
  restrictToPresetTools(preset.ctx, ['patrol_start', ...SCHEDULE_TOOLS]);
  assert.deepEqual(ctx.tools.schemas(agent.key).map(t => t.name).sort(), ['patrol_start', ...SCHEDULE_TOOLS].sort());
  for (const name of foreign) {
    assert.equal(ctx.tools.get(name, agent.key), undefined);
    assert.ok(ctx.tools.get(name, other.key));
    assert.match(reason(name, agent.key), /不能通过浏览器、终端或委派绕行/);
    assert.equal(reason(name, other.key), undefined);
  }
  for (const name of ['patrol_start', ...SCHEDULE_TOOLS, 'run_code']) assert.equal(reason(name, agent.key), undefined);
  ctx.tools.register(definition('later_browser_tool'));
  assert.match(reason('later_browser_tool', agent.key), /只允许专用工具/);
  assert.equal(reason('later_browser_tool', other.key), undefined);
});

test('配置制作助手不获得调度、浏览器或巡查执行能力，退出预设后限制解除', async t => {
  const { ctx, scope, reason } = fixture(t);
  for (const name of ['dsh_browser_open', 'schedule_create', 'patrol_start']) ctx.tools.register(definition(name));
  const preset = scope(), agent = scope(preset.key);
  preset.ctx.tools.register(definition('context_save_draft'));
  restrictToPresetTools(preset.ctx, ['context_save_draft']);
  assert.deepEqual(ctx.tools.schemas(agent.key).map(t => t.name), ['context_save_draft']);
  assert.match(reason('schedule_create', agent.key), /只允许专用工具/);
  assert.equal(reason('context_save_draft', agent.key), undefined);
  await preset.dispose();
  assert.ok(ctx.tools.get('dsh_browser_open', agent.key));
  assert.equal(reason('dsh_browser_open', agent.key), undefined);
});

test('预设工具限制拒绝挂在全局，防止误伤宿主全部会话', t => {
  const { ctx } = fixture(t);
  ctx.tools.register(definition('dsh_browser_open'));
  assert.throws(() => restrictToPresetTools(ctx, []), /requires a scoped context/);
  assert.ok(ctx.tools.get('dsh_browser_open'));
});
