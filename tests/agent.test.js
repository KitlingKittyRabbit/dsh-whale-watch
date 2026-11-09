import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, hash } from '../src/store.js';
import { PatrolEngine } from '../src/engine.js';
import { apply } from '../src/agent.js';
import { SEARCH_OPTIONS } from '../src/search-options.js';
import { CONTEXT_TEMPLATE } from '../src/topic-context.js';
import { apply as registerPlugin } from '../src/index.js';

const normal = { decision: 'normal', categories: ['正常讨论'], evidence: [], uncertainties: [], reason: '正常讨论' };
const nid = n => n.toString(16).padStart(24, '0');
const note = n => ({ kind: 'note', sourceKey: `note:${nid(n)}`, title: `笔记${n}`, text: '创作讨论', coverage: { source: 'manual' } });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'whale-agent-')); t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], exports = [], imageReads = [], collection = [], keyWrites = [];
  const ref = { attachmentId: 'fixture-image', bytes: 3, width: 1, height: 1, mediaType: 'image/png', name: '原图' };
  const catalog = { providers: [{ id: 'fixture', models: [{ id: 'text' }, { id: 'vision', inputModalities: ['image'] }] }] };
  const model = { catalog: async () => catalog, cacheKey: (item, settings) => hash(item.contentHash + settings.rules + settings.discussionHash),
    analyze: async item => { calls.push([item.id]); return normal; },
    analyzeDiscussion: async (_records, targets) => { calls.push(targets.map(i => i.id)); return targets.map(i => ({ id: i.id, analysis: normal })); },
    ctx: { attachments: {
      readImage: async image => { assert.deepEqual(image, ref); imageReads.push(image); return { ref, data: Buffer.from([1, 2, 3]) }; },
      saveFile: async input => { exports.push({ name: input.name, value: JSON.parse(input.data.toString('utf8')) }); return { attachmentId: `file-${exports.length}`, bytes: input.data.length, name: input.name }; },
    } } };
  const api = { hasKey: true, init: async () => {}, setKey: async key => { keyWrites.push(key); api.hasKey = !!key; },
    async *collect(options) { collection.push(options); yield note(99); } };
  const engine = await new PatrolEngine(new Store(root), {}, model, api).init();
  const tools = {}; apply({ dafeiyuPatrol: engine, effect: fn => fn(), tools: { register: tool => { tools[tool.name] = tool; return () => {}; } } });
  const execute = (name, args = {}) => tools[name].execute(args);
  const finish = async () => { if (engine.active) await engine.active.promise; };
  return { engine, tools, execute, finish, calls, exports, imageReads, collection, keyWrites, ref, catalog, root };
}

test('巡查工具沿用全部搜索选项，采集不分析；单独分析不再次读取平台', async t => {
  const f = await fixture(t);
  for (const [key, option] of Object.entries(SEARCH_OPTIONS)) assert.deepEqual(f.tools.patrol_start.parameters.properties[key].enum, option.choices.map(([value]) => value));
  const choices = { noteSort: 'comment_count_descending', publishTimeRange: 'week', noteType: 'image', commentSort: 'like_count_descending' };
  await f.execute('patrol_start', { ...choices, analyze: false, apiBudgetYuan: .5 }); await f.finish();
  assert.equal(f.collection.length, 1); assert.equal(f.calls.length, 0);
  for (const [key, value] of Object.entries(choices)) assert.equal(f.collection[0][key], value);
  await f.execute('patrol_analyze', { readImages: false }); await f.finish();
  assert.equal(f.collection.length, 1); assert.equal(f.engine.state().counts.pending, 0);
});

test('巡查助手可指定用户及且或关系，单轮只给用户不附加默认关键词', async t => {
  const f = await fixture(t), users = ['111111111111111111111111'];
  assert.deepEqual(f.tools.patrol_start.parameters.properties.userKeywordMode.enum, ['and', 'or']);
  await f.execute('patrol_start', { users, analyze: false }); await f.finish();
  assert.deepEqual(f.collection[0].users, users); assert.deepEqual(f.collection[0].keywords, []);
  await f.execute('patrol_start', { users, keywords: ['创作'], userKeywordMode: 'or', analyze: false }); await f.finish();
  assert.deepEqual(f.collection[1].users, users); assert.deepEqual(f.collection[1].keywords, ['创作']);
  assert.equal(f.collection[1].userKeywordMode, 'or');
  await f.execute('patrol_settings', { users, keywords: [], userKeywordMode: 'and' });
  assert.deepEqual(f.engine.store.data.settings.users, users); assert.deepEqual(f.engine.store.data.settings.keywords, []);
  assert.equal(f.calls.length, 0);
});

test('按篇分析、继续剩余、明确重算、已阅和恢复与界面共用后台', async t => {
  const f = await fixture(t), ids = [];
  for (const n of [1, 2]) {
    ids.push((await f.engine.store.upsert(note(n))).id);
    await f.engine.store.upsert({ kind: 'comment', sourceKey: `comment:${nid(n)}:c1`, text: '正常评论', context: '', coverage: { source: 'manual' } });
  }
  const job = await f.execute('patrol_analyze', { discussionNoteLimit: 1, readImages: false }); await f.finish();
  assert.equal(f.engine.state().counts.pending, 1); assert.equal(f.engine.state().counts.entries.pending, 2); assert.equal(f.calls.flat().length, 2);
  await f.execute('patrol_resume', { jobId: job.jobId }); await f.finish();
  assert.equal(f.engine.state().counts.pending, 0); assert.equal(f.calls.flat().length, 4);
  await f.execute('patrol_retry', { id: ids[0] }); await f.finish();
  assert.equal(f.calls.flat().length, 6);
  const other = await f.execute('patrol_results', { filter: 'other' }); assert.equal(other.total, 2);
  assert.equal(other.items[0].discussionSummary.other, 2);
  await f.execute('patrol_mark_read', { id: ids[0], read: true }); assert.equal((await f.execute('patrol_results', { filter: 'read' })).total, 1);
  await f.execute('patrol_mark_read', { id: ids[0], read: false }); assert.equal((await f.execute('patrol_results')).total, 2);
});

test('局部设置保留未指定字段；拒绝失配模型、密钥、超限值，保存失败回滚', async t => {
  const f = await fixture(t), original = structuredClone(f.engine.store.data.settings);
  await f.execute('patrol_settings', { noteSort: 'general', discussionNoteLimit: 2 });
  assert.deepEqual(f.engine.store.data.settings, { ...original, noteSort: 'general', discussionNoteLimit: 2 });
  assert.deepEqual(await f.execute('patrol_models'), f.catalog);
  await f.execute('patrol_settings', { provider: 'fixture', model: 'text', visionProvider: 'fixture', visionModel: 'vision' });
  const saved = structuredClone(f.engine.store.data.settings);
  for (const patch of [{ apiKey: 'SECRET' }, { provider: 'fixture' }, { visionProvider: 'fixture', visionModel: '' }, { apiBudgetYuan: 999 }, { discussionAnalysisLimit: 0 }]) await assert.rejects(f.execute('patrol_settings', patch));
  assert.deepEqual(f.engine.store.data.settings, saved);
  const save = f.engine.store.save.bind(f.engine.store); f.engine.store.save = async () => { throw new Error('写入失败'); };
  await assert.rejects(f.execute('patrol_settings', { noteSort: 'time_descending' }), /写入失败/); assert.deepEqual(f.engine.store.data.settings, saved); f.engine.store.save = save;
  const link = await f.execute('patrol_data_key', { action: 'settings' }); assert.match(link.url, /tab=settings/); assert.equal(f.keyWrites.length, 0);
  assert.ok(!Object.hasOwn(f.tools.patrol_data_key.parameters.properties, 'apiKey'));
  await f.execute('patrol_data_key', { action: 'clear' }); assert.deepEqual(f.keyWrites, ['']);
});

test('草稿采用、本机文件导入、资料编辑和撤销保留原文；旧版本不能覆盖新资料', async t => {
  const f = await fixture(t);
  await f.execute('patrol_import', { text: '保留原文', analyze: false });
  const items = structuredClone(f.engine.store.data.items), config = structuredClone(CONTEXT_TEMPLATE);
  config.name = '自定义专题';
  await f.engine.saveContextDraft({ config });
  assert.equal((await f.execute('patrol_context', { source: 'draft' })).name, config.name);
  await f.execute('patrol_context_update', { action: 'apply_draft' });
  const current = await f.execute('patrol_context'); const edited = structuredClone(current.config); edited.background.memo = '修改说明';
  await f.execute('patrol_context_update', { action: 'edit', configJson: JSON.stringify(edited), baseHash: current.baseHash, backgroundId: current.backgroundId });
  await assert.rejects(f.execute('patrol_context_update', { action: 'edit', configJson: JSON.stringify(current.config), baseHash: current.baseHash, backgroundId: current.backgroundId }), /已发生变化/);
  await f.execute('patrol_context_update', { action: 'undo' }); assert.equal(f.engine.exportContext().background.memo, config.background.memo);
  await f.execute('patrol_context_update', { action: 'unload' }); assert.equal(f.engine.store.data.context.active, null);
  await f.execute('patrol_context_update', { action: 'undo' }); assert.equal(f.engine.exportContext().name, config.name);
  const path = join(f.root, 'topic.json'); await writeFile(path, JSON.stringify(config));
  await f.execute('patrol_context_update', { action: 'import', filePath: path });
  await assert.rejects(f.execute('patrol_context_update', { action: 'import', filePath: path, configJson: JSON.stringify(config) }), /一项/);
  await writeFile(path, ' '.repeat(300001)); await assert.rejects(f.execute('patrol_context_update', { action: 'validate', filePath: path }), /300 KB/);
  await f.execute('patrol_context_update', { action: 'builtin' }); assert.equal(f.engine.exportContext().id, 'ds-personification');
  assert.deepEqual(f.engine.store.data.items, items); assert.equal(f.engine.store.data.jobs.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.collection.length, 0);
});

test('原图输出包含宿主图片块，缺图报错；JSON导出为可下载附件且不包含密钥', async t => {
  const f = await fixture(t), item = await f.engine.store.upsert(note(1)); item.images = [{ index: 1, attachment: f.ref }, { index: 2, error: '未保存' }];
  const list = await f.execute('patrol_images', { id: item.id }); assert.equal(list.available.length, 2); assert.equal(f.imageReads.length, 0);
  const images = await f.execute('patrol_images', { id: item.id, indices: [1, 1] }); assert.equal(f.imageReads.length, 1);
  const rendered = f.tools.patrol_images.output.render({}, images); assert.deepEqual(rendered.find(b => b.type === 'image').attachment, f.ref);
  await assert.rejects(f.execute('patrol_images', { id: item.id, indices: [2] }), /未保存/);
  await assert.rejects(f.execute('patrol_images', { id: item.id, indices: [1, 2, 3, 4, 5] }), /最多4张/);
  await f.engine.useBuiltinContext();
  for (const source of ['records', 'context', 'template', 'builtin']) {
    const out = await f.execute('patrol_export', { source });
    assert.equal(f.tools.patrol_export.output.render({}, out)[1].type, 'file');
    assert.equal(out.attachment.name, out.filename); assert.ok(!Object.hasOwn(out, 'items'));
    assert.ok(!JSON.stringify(f.exports.at(-1).value).includes('apiKey'));
    if (source === 'records') assert.equal(f.exports.at(-1).value.items[0].text, item.text);
    else assert.ok(!Object.hasOwn(f.exports.at(-1).value, 'items'));
  }
  assert.equal(f.calls.length, 0); assert.equal(f.collection.length, 0);
});

test('宿主注册两个独立预设，用途说明明确，巡查和配置制作使用不同工具模块', async t => {
  const root = await mkdtemp(join(tmpdir(), 'whale-presets-')); t.after(() => rm(root, { recursive: true, force: true }));
  const presets = [];
  await registerPlugin({ provide() {}, effect: fn => fn(), inject() {}, agentPresets: { register: async preset => { presets.push(preset); return () => {}; } } }, { dataDir: root });
  assert.equal(presets.length, 2);
  assert.match(presets[0].description, /操作工作台/); assert.match(presets[1].description, /只制作专题草稿/);
  assert.ok(presets[0].plugins[1].name.endsWith('/agent.js'));
  assert.ok(presets[1].plugins[1].name.endsWith('/context-agent.js'));
  assert.match(presets[0].plugins[0].config.prefix, /patrol_resume/);
});
