import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store, defaultSettings } from '../src/store.js';
import { PatrolEngine } from '../src/engine.js';
import { DshModel } from '../src/model.js';
import { createHandler } from '../src/http.js';
import { systemPrompt, VERIFICATION_PROMPT, DEFAULT_RULES } from '../src/rules.js';
import { BUILTIN_DS_CONTEXT, CONTEXT_TEMPLATE, parseContext, loadedContext, topicInput } from '../src/topic-context.js';
import { apply as builderTools } from '../src/context-agent.js';

const generic = () => parseContext({ ...CONTEXT_TEMPLATE, id: 'garden-discussion', name: '园艺讨论', background: { memo: '本专题讨论园艺用语 [B1]', sources: [{ ref: 'B1', title: '园艺用语材料', url: 'https://example.org/garden', summary: '材料提供园艺相关术语。' }] }, glossary: [{ term: '爆盆', meaning: '植物生长茂盛的说法', aliases: [], sourceRefs: ['B1'], status: 'source_claim' }], interpretationNotes: ['讨论种植效果与侮辱种植者应区分。'] });
async function fixture(t, model = {}) {
  const root = await mkdtemp(join(tmpdir(), 'whale-context-')); t.after(() => rm(root, { recursive: true, force: true }));
  const engine = await new PatrolEngine(new Store(root), {}, { analyze() { throw new Error('不得自动调用模型'); }, ...model }, { init: async () => {}, collect() { throw new Error('不得自动采集'); } }).init();
  return engine;
}
test('配置格式拒绝未知字段、超量文件、危险来源、重复与悬空引用；内置配置完整有效', () => {
  assert.equal(BUILTIN_DS_CONTEXT.background.sources.length, 36); assert.equal(BUILTIN_DS_CONTEXT.glossary.length, 7);
  assert.equal(parseContext(JSON.stringify(generic())).name, '园艺讨论');
  for (const config of [{ ...generic(), apiKey: 'secret' }, { ...generic(), schemaVersion: 2 }, { ...generic(), background: { ...generic().background, memo: '引用不存在 [B99]' } }, { ...generic(), glossary: [{ term: '错误引用', meaning: '测试', sourceRefs: ['B99'] }] }, { ...generic(), background: { ...generic().background, sources: [...generic().background.sources, ...generic().background.sources] } }]) assert.throws(() => parseContext(config));
  for (const url of ['javascript:alert(1)', 'file:///tmp/secret', 'https://user:password@example.org']) {
    const config = generic(); config.background.sources[0].url = url; assert.throws(() => parseContext(config));
  }
  assert.throws(() => parseContext(' '.repeat(300000) + JSON.stringify(generic())), /300 KB/);
});
test('导入、重启与撤销恢复专题及背景，采集、规则和已有结论不变', async t => {
  const engine = await fixture(t), d = engine.store.data;
  const item = await engine.store.upsert({ kind: 'comment', text: '原文', context: '', title: '保留' }); item.analysis = { decision: 'normal' }; item.analysisKey = 'old'; item.readAt = 'read';
  d.settings.rules += '\n我定制的行为规则';
  d.background = { enabled: false, active: { id: 'prior', readings: [], memo: '先前背景' }, draft: null, history: [] };
  const original = structuredClone(d);
  await engine.importContext({ config: generic() });
  assert.equal(engine.analysisSettings(d.settings).topicContext.name, '园艺讨论'); assert.equal(d.background.active.origin, 'context-file');
  assert.deepEqual(d.items, original.items); assert.deepEqual(d.settings, original.settings); assert.deepEqual(d.jobs, original.jobs);
  assert.equal(engine.state().counts.pending, 0); assert.equal(engine.state().counts.retainedResults, 0); // 已阅不进入队列
  const restarted = await new Store(engine.store.root).init(); assert.equal(restarted.data.context.active.config.id, 'garden-discussion');
  await engine.undoContext(); assert.deepEqual(d.background, original.background); assert.equal(d.context.active, null); assert.deepEqual(d.items, original.items);
  await engine.useBuiltinContext(); assert.equal(d.context.active.config.id, 'ds-personification'); assert.equal(d.background.active.readings.length, 36);
  await engine.unloadContext(); assert.equal(engine.analysisSettings(d.settings).topicContext, null); assert.equal(d.background.active, null);
  await engine.undoContext(); assert.equal(d.context.active.config.id, 'ds-personification');
});
test('任务运行时拒绝切换；写入失败回滚背景和专题', async t => {
  const engine = await fixture(t); engine.active = {}; await assert.rejects(engine.importContext({ config: generic() }), /任务进行中/); engine.active = null;
  const previous = structuredClone(engine.store.data), save = engine.store.save.bind(engine.store);
  engine.store.save = async () => { throw new Error('保存失败'); };
  await assert.rejects(engine.importContext({ config: generic() }), /保存失败/); assert.deepEqual(engine.store.data, previous);
  await assert.rejects(engine.saveContextDraft({ config: generic() }), /保存失败/); assert.deepEqual(engine.store.data, previous);
  engine.store.save = save;
});
test('旧版迁移保留原背景、记录、用户规则；新安装不加载DS语境', async t => {
  const engine = await fixture(t); assert.equal(engine.store.data.context.active, null);
  const old = structuredClone(engine.store.data); delete old.context; old.settings.rules = '用户自定义规则，请保留'; old.background.active = { id: 'old', readings: [], memo: '用户旧背景' }; old.items = [{ id: 'a', kind: 'comment', text: '旧评论', readAt: null, analysis: { decision: 'normal' }, analysisKey: 'old' }];
  await writeFile(engine.store.path, JSON.stringify(old));
  const migrated = await new Store(engine.store.root).init(); assert.equal(migrated.data.context.active.origin, 'legacy');
  assert.deepEqual(migrated.data.background, old.background); assert.deepEqual(migrated.data.items, old.items); assert.deepEqual(migrated.data.settings, old.settings);
  const next = await new Store(engine.store.root).init(); assert.equal(next.data.context.active.hash, migrated.data.context.active.hash);
});
test('配置导出捕捉当前背景编辑，排除原帖、图片、密钥；重读背景后术语来源仍不串号', async t => {
  const engine = await fixture(t); await engine.importContext({ config: generic() });
  const b = engine.store.data.background.active; b.memo = '手工更正 [B1]'; b.readings[0].parts.push({ label: '正文', text: 'PRIVATE_FULL_POST' });
  engine.store.data.settings.apiKey = 'PRIVATE_KEY'; engine.store.data.items.push({ text: 'PRIVATE_ITEM', images: ['PRIVATE_IMAGE'] });
  const out = engine.exportContext(), serialized = JSON.stringify(out); assert.equal(out.background.memo, b.memo); assert.equal(out.glossary[0].term, '爆盆');
  for (const secret of ['PRIVATE_FULL_POST', 'PRIVATE_KEY', 'PRIVATE_ITEM', 'PRIVATE_IMAGE']) assert.ok(!serialized.includes(secret));
  b.readings[0] = { ref: 'B1', title: '另一事件', url: 'https://example.org/other', summary: '新内容', parts: [] }; b.memo = '新内容 [B1]';
  const changed = engine.exportContext(); assert.equal(changed.glossary[0].sourceRefs[0], 'B2'); assert.equal(changed.background.sources.find(s => s.ref === 'B2').url, 'https://example.org/garden'); assert.equal(changed.background.memo, b.memo);
  assert.deepEqual(parseContext(JSON.stringify(changed)), changed);
});
test('配置制作助手只有读取、校验、保存草稿；草稿不会启用或启动付费任务', async t => {
  const engine = await fixture(t), registered = [];
  builderTools({ dafeiyuPatrol: engine, effect: fn => fn(), tools: { register: value => { registered.push(value); return () => {}; } } });
  assert.deepEqual(registered.map(t => t.name), ['context_format', 'context_current', 'context_validate', 'context_save_draft']);
  const tools = Object.fromEntries(registered.map(t => [t.name, t]));
  assert.equal((await tools.context_format.execute({})).format, 'whale-watch-context');
  await tools.context_save_draft.execute({ configJson: JSON.stringify(generic()) });
  assert.equal(engine.store.data.context.active, null); assert.equal(engine.store.data.background.active, null); assert.equal(engine.store.data.jobs.length, 0); assert.equal(engine.store.data.items.length, 0);
  assert.equal(engine.draftContext().name, '园艺讨论');
  await engine.applyContextDraft(); assert.equal(engine.store.data.context.active.config.id, 'garden-discussion'); assert.equal(engine.store.data.context.draft, null);
  await engine.undoContext(); assert.equal(engine.draftContext().name, '园艺讨论'); assert.equal(engine.store.data.context.active, null);
});
test('初判、整篇分析及证据核对共用载入术语，通用系统提示没有固定DS词义', async () => {
  const calls = [], settings = { ...defaultSettings(), topicContext: topicInput(loadedContext(generic())) };
  const text = '你真脑残', finding = { category: '人身攻击', quote: text, target: '被回复者', behavior: '人格侮辱' };
  const item = { id: 'comment', kind: 'comment', text, context: '回复种植者', title: '讨论', contentHash: 'same', coverage: {} };
  const proposed = { targetQuote: text, interpretation: '侮辱被回复者', decision: 'review', categories: ['人身攻击'], reason: '辱骂', evidence: [text], findings: [finding], uncertainties: [], confidence: .8 };
  const model = new DshModel({ agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'text' }) }, llm: { stream: options => (async function* () {
    calls.push(options); const kind = options.messages[0].source.kind;
    const value = kind === 'dafeiyu-patrol-evidence-check' ? { verdict: 'supported', reason: '有逐字证据', findings: [finding] } : kind === 'whale-watch-discussion-analysis' ? { results: [{ id: item.id, analysis: proposed }] } : proposed;
    yield { type: 'text-delta', index: 0, text: JSON.stringify(value) }; yield { type: 'finish', reason: { kind: 'stop' } };
  })() } });
  const first = await model.analyze(item, settings); assert.equal(first.contextUsed.name, '园艺讨论');
  await model.analyzeDiscussion([{ id: 'note', kind: 'note', text: '种植讨论', title: '园艺', coverage: {} }, item], [item], settings, new AbortController().signal);
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.deepEqual(JSON.parse(call.messages[0].content[0].text).background.topic, settings.topicContext);
    assert.ok(!call.system.includes('八分钱')); assert.ok(!call.system.includes('鲸鱼娘'));
  }
  for (const prompt of [systemPrompt(DEFAULT_RULES), VERIFICATION_PROMPT]) for (const term of ['八分钱', 'xyy', '鲸鱼娘', '结城理', '钟离']) assert.ok(!prompt.includes(term));
  assert.notEqual(model.cacheKey(item, settings), model.cacheKey(item, { ...settings, topicContext: null }));
});
test('导入新专题后普通分析继续保留旧结果，只处理失败或未分析项', async t => {
  const engine = await fixture(t, { cacheKey: (_item, settings) => settings.topicContext?.hash || 'none' });
  const item = await engine.store.upsert({ kind: 'comment', text: '内容', context: '' }); item.analysis = { decision: 'normal' }; item.analysisKey = 'none';
  await engine.importContext({ config: generic() });
  assert.equal(engine.state().counts.pending, 0); assert.equal(engine.state().counts.retainedResults, 1);
  assert.equal(engine.results({ filter: 'unanalyzed' }).total, 0);
  await engine.start({ readImages: false }, 'analyze'); await engine.active.promise;
  assert.equal(engine.store.data.jobs.at(-1).analyzed, 0); assert.equal(item.analysisKey, 'none');
});
test('配置HTTP下载为可重新导入的JSON，同源与坏配置保护生效', async t => {
  const engine = await fixture(t), server = createServer(createHandler(engine)); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`, base = origin + '/plugins/dafeiyu-patrol/api/context/';
  const post = (path, config, from = origin) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: from }, body: JSON.stringify({ config }) });
  assert.equal((await post('import', generic(), 'https://evil.example')).status, 403);
  assert.equal((await post('import', { ...generic(), model: 'no' })).status, 400);
  assert.equal(engine.context().active, null); assert.equal((await post('import', generic())).status, 200);
  const download = await fetch(base + 'export'); assert.match(download.headers.get('content-disposition'), /garden-discussion.json/); assert.deepEqual(parseContext(await download.text()), engine.exportContext());
  const builtin = await fetch(base + 'builtin/export'); assert.equal(parseContext(await builtin.text()).id, 'ds-personification');
  assert.equal((await fetch(base + 'draft/export')).status, 400);
});
