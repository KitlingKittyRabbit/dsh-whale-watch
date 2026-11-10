import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import vm from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocialDataX } from '../src/socialdatax.js';
import { PatrolEngine } from '../src/engine.js';
import { Store, defaultSettings } from '../src/store.js';
import { publishedAt } from '../src/search-results.js';
import { discussionHash } from '../src/discussion.js';

const id = n => n.toString(16).padStart(24, '0');
const page = (items, token = '') => ({ items, next_page_token: token, points: { cost: 10 } });
const note = (n, time, word = '大肥鱼') => ({ note_id: id(n), note_url: `https://www.xiaohongshu.com/explore/${id(n)}`,
  title: `${word}${n}`, content: `正文 #${word}[话题]#`, note_type: 'image', publish_time: time,
  author: { name: '模拟作者' }, image_items: [], comment_count: 0, points: { cost: 10 } });
async function fixture(t, reply) {
  const root = await mkdtemp(join(tmpdir(), 'whale-search-results-')); t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], events = [];
  const api = await new SocialDataX(root, null, async (address, input) => {
    const path = new URL(address).pathname.replace('/socialdatax/api/v1/xhs', ''), body = JSON.parse(input.body);
    calls.push({ path, body }); return Response.json(await reply(path, body));
  }).init(); await api.setKey('fixture-only');
  return { root, api, calls, events, async collect(extra) {
    const bundles = [];
    for await (const bundle of api.collect({ ...defaultSettings(), urls: [], keywords: [], readComments: false, ...extra }, new AbortController().signal, e => events.push(e))) bundles.push(bundle);
    return bundles;
  } };
}

test('先检索全部关键词再限制篇数，按发布时间合并乱序候选，正文与检索来源可核对', async t => {
  const groups = { 大肥鱼: [note(1, 100), note(2, 300)], 子午: [note(3, 500, '子午')], 鲸鱼娘: [note(4, 400, '鲸鱼娘')], 癌哥笑笑传: [note(5, 200, '癌哥笑笑传')] };
  const all = Object.values(groups).flat();
  const f = await fixture(t, (path, body) => path === '/note/search' ? page(groups[body.keyword]) :
    path === '/note/detail' ? all.find(n => n.note_id === body.note_id) : assert.fail('不得读取评论'));
  const result = await f.collect({ keywords: Object.keys(groups), maxNotes: 2, apiBudgetYuan: .6 });
  assert.deepEqual(result.map(b => b.note.discussionNoteId), [id(3), id(4)]);
  assert.deepEqual(f.calls.slice(0, 4).map(c => c.body.keyword), Object.keys(groups));
  assert.ok(f.calls.slice(0, 4).every(c => c.path === '/note/search' && c.body.sort_type === 'time_descending'));
  assert.equal(f.calls.length, 6);
  assert.equal(result[0].note.publishedAt, new Date(500000).toISOString());
  assert.deepEqual(result[0].note.collection.matchedKeywords, ['子午']);
  assert.equal(result[0].note.collection.query, '子午');
  assert.equal(f.events.filter(e => e.type === 'search').length, 4);
});

test('合并继续各词分页、保留独立令牌并跨词去重，达到篇数后不额外翻页', async t => {
  const a = note(1, 600), b = note(2, 400), c = note(3, 500), d = note(4, 300);
  const f = await fixture(t, (path, body) => {
    if (path === '/note/search') return body.keyword === '甲' ? (body.page_token ? (assert.equal(body.page_token, '甲-next'), page([b])) : page([a], '甲-next')) : page([a, c, d], '乙-next');
    return [a, b, c, d].find(n => n.note_id === body.note_id);
  });
  const result = await f.collect({ keywords: ['甲', '乙'], maxNotes: 3 });
  assert.deepEqual(result.map(b => b.note.discussionNoteId), [id(1), id(3), id(2)]);
  assert.equal(f.calls.filter(c => c.path === '/note/detail').length, 3);
  assert.deepEqual(f.calls.filter(c => c.path === '/note/search' && c.body.page_token).map(c => c.body.page_token), ['甲-next']);
});

test('综合排序轮换各词，点赞排序按可比较数值合并，缺失数值不能伪造排名', async t => {
  const a = { ...note(1, 100), like_count: 3 }, b = { ...note(2, 200), like_count: 1 }, c = { ...note(3, 300), like_count: 20 };
  const f = await fixture(t, (path, body) => path === '/note/search' ? page(body.keyword === '甲' ? [a, b] : [c]) : [a, b, c].find(n => n.note_id === body.note_id));
  assert.deepEqual((await f.collect({ keywords: ['甲', '乙'], noteSort: 'general', maxNotes: 3 })).map(b => b.note.discussionNoteId), [id(1), id(3), id(2)]);
  assert.deepEqual((await f.collect({ keywords: ['甲', '乙'], noteSort: 'like_count_descending', maxNotes: 2 })).map(b => b.note.discussionNoteId), [id(3), id(1)]);
  assert.equal(publishedAt(0), null); assert.equal(publishedAt(null), null); assert.equal(publishedAt(Infinity), null); assert.equal(publishedAt(1e30), null);
});

test('多词检索额度不足时留下正文额度并说明未查词，部分结果不伪装完整完成', async t => {
  const a = note(1, 100);
  const f = await fixture(t, path => path === '/note/search' ? page([a]) : a);
  const e = await new PatrolEngine(new Store(f.root), {}, {}, f.api).init();
  await e.start({ keywords: ['甲', '乙'], maxNotes: 1, apiBudgetYuan: .2, readComments: false, analyze: false }); await e.active.promise;
  const job = e.store.data.jobs.at(-1);
  assert.equal(f.calls.length, 2); assert.equal(job.apiCostCents, 20); assert.equal(job.notesRead, 1); assert.equal(job.status, 'partial');
  assert.match(job.searchLimits.join(''), /乙.*尚未检索/);
  assert.equal(e.store.data.items.length, 1);
});

test('详情缺发布时间时使用搜索返回时间；都缺失就明确保留未知，不从ID推算', async t => {
  const a = note(1, 100), b = note(2, undefined);
  const f = await fixture(t, (path, body) => path === '/note/search' ? page([a, b]) : { ...[a, b].find(n => n.note_id === body.note_id), publish_time: null });
  const result = await f.collect({ keywords: ['大肥鱼'], maxNotes: 2 });
  assert.equal(result[0].note.publishedAt, new Date(100000).toISOString()); assert.equal(result[1].note.publishedAt, null);
});

test('最新批次排除旧人机恋及技术记录，修复逐条前插造成的倒序，筛选不改原始存档', async t => {
  const f = await fixture(t, () => assert.fail('只读查询不得请求数据API'));
  const e = await new PatrolEngine(new Store(f.root), {}, {}, f.api).init();
  const record = (n, title) => ({ kind: 'note', sourceKey: `note:${id(n)}`, title, text: title, context: '', images: [], coverage: {}, discussion: { complete: true, sourceKeys: [] } });
  const old = await e.store.upsert(record(1, '人机恋旧记录')); old.capturedAt = '2026-10-31T00:00:00Z';
  const tech = await e.store.upsert(record(2, 'Unsloth技术旧记录')); tech.capturedAt = '2026-10-31T00:00:00Z';
  const a = await e.store.upsert(record(3, '大肥鱼较新')), b = await e.store.upsert(record(4, '大肥鱼较旧'));
  e.store.data.jobs.push({ id: 'batch', mode: 'scan', startedAt: '2026-11-10T08:00:00Z', options: { keywords: ['大肥鱼'], noteSort: 'time_descending' }, collectedItemIds: [a.id, b.id] });
  const before = JSON.stringify(e.store.data);
  assert.deepEqual(e.results({ batch: 'latest' }).items.map(i => i.id), [a.id, b.id]);
  assert.equal(e.results().total, 4); assert.equal(e.results({ batch: 'latest', filter: 'unanalyzed' }).total, 2);
  assert.equal(e.results({ batch: 'latest', offset: 1, limit: 1 }).items[0].id, b.id);
  assert.deepEqual(e.results({ batch: 'latest' }).items[0].collection.matchedKeywords, ['大肥鱼']);
  assert.equal(e.results({ batch: 'latest' }).items[0].collection.query, null);
  assert.equal(JSON.stringify(e.store.data), before);
  assert.equal(e.results().items[0].id, a.id);
  e.store.data.jobs.push({ id: 'empty-batch', mode: 'scan', collectedItemIds: [] });
  assert.equal(e.results({ batch: 'latest' }).total, 0, '新一轮零结果不能拿上一轮冒充');
  assert.equal(e.results().total, 4);
});

test('补齐发布时间与检索信息不使已成功的分析失效，也不丢失已阅状态', async t => {
  const f = await fixture(t, () => assert.fail('不应联网'));
  const store = await new Store(f.root).init();
  const record = { kind: 'note', sourceKey: `note:${id(1)}`, title: '大肥鱼', text: '原文', context: '', coverage: {}, images: [] };
  const saved = await store.upsert(record); saved.analysis = { decision: 'normal' }; saved.readAt = '已阅';
  const before = saved.contentHash, context = discussionHash([saved]);
  await store.upsert({ ...record, publishedAt: '2026-11-10T00:00:00Z', collection: { query: '大肥鱼', matchedKeywords: ['大肥鱼'] } });
  assert.equal(saved.contentHash, before); assert.equal(discussionHash([saved]), context); assert.equal(saved.analysis.decision, 'normal'); assert.equal(saved.readAt, '已阅');
  assert.equal(saved.publishedAt, '2026-11-10T00:00:00Z'); assert.equal(saved.collection.query, '大肥鱼');
  await store.upsert({ ...record, text: '更新正文', publishedAt: null });
  assert.equal(saved.publishedAt, '2026-11-10T00:00:00Z');
});

test('原生页面默认最近一轮，卡片折叠时已能核对发布时间及关键词，范围选择连到请求状态', async t => {
  const f = await fixture(t, () => assert.fail('页面渲染不得采集'));
  const e = await new PatrolEngine(new Store(f.root), {}, {}, f.api).init();
  const n = await e.store.upsert({ kind: 'note', sourceKey: `note:${id(1)}`, title: '大肥鱼', text: '#大肥鱼[话题]#',
    coverage: {}, discussion: { complete: true, sourceKeys: [] }, publishedAt: '2026-11-10T00:00:00Z',
    collection: { query: '大肥鱼', keywords: ['大肥鱼'], matchedKeywords: ['大肥鱼'] } });
  e.store.data.jobs.push({ id: 'test-batch', mode: 'scan', status: 'completed', startedAt: '2026-11-10T08:00:00Z', collectedItemIds: [n.id], options: {}, messages: [] });
  const snapshot = e.state(), results = e.results({ batch: 'latest' }), changes = [];
  let index = 0, definition, component;
  const React = { Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: initial => { const i = index++; return [i === 1 ? snapshot : i === 3 ? results : initial, value => changes.push([i, value])]; },
    useEffect() {}, useRef: value => ({ current: value }), useCallback: value => value };
  vm.runInNewContext(await readFile(new URL('../ui/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: module => { definition = module.factory(() => React); } } },
    document: { createElement: () => ({ remove() {} }), head: { append() {} } },
  });
  definition.apply({ effect: fn => fn(), slots: { inject: (_slot, fn) => fn(), register: (spec, render) => { if (spec.name === 'main') component = render; } } });
  const nodes = [], strings = [];
  function visit(node) {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node == null || node === false) return;
    if (typeof node !== 'object') { strings.push(String(node)); return; }
    if (typeof node.type === 'function') { visit(node.type(node.props)); return; }
    nodes.push(node); visit(node.props.children);
  }
  visit(component({}));
  const text = strings.join('\n');
  assert.match(text, /最近一轮采集/); assert.match(text, /全部记录/); assert.match(text, /发布：.*采集：/);
  assert.match(text, /检索词：大肥鱼.*标题／正文字面命中：大肥鱼/);
  assert.match(text, /这一轮采集，共 1 篇.*上方统计包含全部历史记录/);
  const choice = nodes.find(node => node.type === 'select' && node.props.value === 'latest');
  assert.ok(choice); choice.props.onChange({ target: { value: 'all' } });
  assert.ok(changes.some(([i, value]) => i === 6 && value === 'all'));
  assert.ok(changes.some(([i, value]) => i === 5 && value === 0));
});
