import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocialDataX } from '../src/socialdatax.js';
import { PatrolEngine } from '../src/engine.js';
import { Store, defaultSettings } from '../src/store.js';
import { startSchema } from '../src/schema.js';

const id = n => n.toString(16).padStart(24, '0'), uid = '111111111111111111111111';
const note = (n, time = 1000 - n) => ({ note_id: id(n), note_url: `https://www.xiaohongshu.com/explore/${id(n)}`,
  title: `大肥鱼${n}`, content: '模拟正文', publish_time: time, note_type: 'image', image_items: [], comment_count: 0,
  author: { name: '模拟作者', user_id: uid }, points: { cost: 10 } });
const page = (items, token = '') => ({ items, next_page_token: token, points: { cost: 10 } });
const saved = n => ({ kind: 'note', sourceKey: `note:${id(n)}`, discussionNoteId: id(n), title: '已采集', text: '已存正文',
  context: '', images: [], coverage: { source: 'socialdatax' }, discussion: { scope: 'note', complete: true, sourceKeys: [] },
  lastCapture: { scope: 'note', complete: true } });
async function fixture(t, reply) {
  const root = await mkdtemp(join(tmpdir(), 'whale-stop-seen-')); t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], events = [];
  const api = await new SocialDataX(root, null, async (address, input) => {
    const path = new URL(address).pathname.replace('/socialdatax/api/v1/xhs', ''), body = JSON.parse(input.body);
    calls.push({ path, body }); return Response.json(await reply(path, body, input.signal));
  }).init(); await api.setKey('fixture-only');
  return { root, api, calls, events, async collect(extra = {}) {
    const bundles = [];
    for await (const bundle of api.collect({ ...defaultSettings(), keywords: ['大肥鱼'], urls: [], stopOnSeen: true, readComments: false,
      maxNotes: 20, ...extra }, new AbortController().signal, e => events.push(e))) bundles.push(bundle);
    return bundles;
  } };
}

test('同页遇旧就停止该词，余项正文及下一页均不请求，未凑满篇数正常结束', async t => {
  const notes = [note(1), note(2), note(3)];
  const f = await fixture(t, (path, body) => {
    if (path === '/note/search') { assert.equal(body.page_token, ''); return page(notes, 'must-not-fetch'); }
    assert.equal(path, '/note/detail'); assert.equal(body.note_id, id(1)); return notes[0];
  });
  const result = await f.collect({ excludedNoteIds: [id(2)] });
  assert.deepEqual(result.map(b => b.note.discussionNoteId), [id(1)]);
  assert.equal(f.calls.length, 2); assert.equal(f.events.filter(e => e.type === 'api').at(-1).costCents, 20);
  assert.equal(f.events.filter(e => e.type === 'seen-stop').length, 1);
  assert.ok(!f.events.some(e => e.type === 'search-limit' || e.type === 'api-stop'));
});

test('四个词各自遇到同一旧笔记均停止，只计四次搜索，零新帖也为正常完成', async t => {
  const f = await fixture(t, path => { assert.equal(path, '/note/search'); return page([note(9), note(10)], 'must-not-fetch'); });
  const e = await new PatrolEngine(new Store(f.root), {}, { analyzeDiscussion() { assert.fail('不得调用模型'); } }, f.api).init();
  await e.store.upsert(saved(9));
  await e.start({ keywords: ['甲', '乙', '丙', '丁'], stopOnSeen: true, readComments: false, maxNotes: 20 }); await e.active.promise;
  const job = e.store.data.jobs.at(-1);
  assert.equal(job.status, 'completed'); assert.equal(job.notesRead, 0); assert.equal(job.notesExcluded, 1);
  assert.deepEqual(job.stoppedKeywords.map(s => s.keyword), ['甲', '乙', '丙', '丁']);
  assert.equal(job.apiRequests, 4); assert.equal(job.apiCostCents, 40); assert.equal(f.calls.length, 4);
  assert.match(job.message, /4个关键词已按遇旧即停结束/); assert.match(job.searchSummary, /关键词遇旧即停/);
});

test('关键词之间本轮重复不算历史旧帖，某词停止不会挡住其他词的新帖', async t => {
  const a = note(1, 500), b = note(2, 450), old = note(9, 400), later = note(10, 300);
  const f = await fixture(t, (path, body) => path === '/note/search' ? (assert.equal(body.page_token, ''), page(body.keyword === '甲' ? [a, old, later] : [a, b, old], 'must-not-fetch')) :
    (assert.ok([id(1), id(2)].includes(body.note_id)), [a, b].find(n => n.note_id === body.note_id)));
  const result = await f.collect({ keywords: ['甲', '乙'], excludedNoteIds: [id(9)] });
  assert.deepEqual(result.map(b => b.note.discussionNoteId), [id(1), id(2)]);
  assert.deepEqual(f.events.filter(e => e.type === 'seen-stop').map(e => e.keyword), ['甲', '乙']);
  assert.equal(f.calls.filter(c => c.path === '/note/detail').length, 2);
});

test('关闭遇旧即停保持跳过旧帖继续翻页的行为', async t => {
  const a = note(1), old = note(2), b = note(3);
  const f = await fixture(t, (path, body) => path === '/note/search' ? body.page_token ? page([b]) : page([a, old], 'next') : [a, b].find(n => n.note_id === body.note_id));
  const result = await f.collect({ stopOnSeen: false, excludedNoteIds: [id(2)] });
  assert.deepEqual(result.map(b => b.note.discussionNoteId), [id(1), id(3)]);
  assert.equal(f.calls.filter(c => c.path === '/note/search').length, 2);
  assert.ok(!f.events.some(e => e.type === 'seen-stop'));
});

test('翻到第二页才遇旧时也立即截断，第三页和旧帖之后的正文均不读取', async t => {
  const a = note(1), old = note(2), after = note(3);
  const f = await fixture(t, (path, body) => {
    if (path === '/note/search') {
      assert.ok(['', 'second'].includes(body.page_token));
      return body.page_token ? page([old, after], 'must-not-fetch-third') : page([a], 'second');
    }
    assert.equal(body.note_id, id(1)); return a;
  });
  const result = await f.collect({ excludedNoteIds: [id(2)] });
  assert.equal(result.length, 1); assert.equal(f.calls.length, 3);
  assert.equal(f.events.find(e => e.type === 'seen-stop').page, 2);
});

test('取消排除已查仍可更新旧帖，遇旧选项不阻止正文重读', async t => {
  const notes = [note(1), note(2)];
  const f = await fixture(t, (path, body) => path === '/note/search' ? page(notes) : notes.find(n => n.note_id === body.note_id));
  const e = await new PatrolEngine(new Store(f.root), {}, {}, f.api).init(); await e.store.upsert(saved(1));
  await e.start({ keywords: ['大肥鱼'], stopOnSeen: true, excludeSeen: false, readComments: false, analyze: false, maxNotes: 2 }); await e.active.promise;
  const job = e.store.data.jobs.at(-1);
  assert.equal(job.notesRead, 2); assert.equal(job.stoppedKeywords?.length || 0, 0);
  assert.equal(f.calls.filter(c => c.path === '/note/detail').length, 2);
});

test('指定用户列表不套用关键词停止策略，旧置顶仍可跳过并读取后续新帖', async t => {
  const old = { ...note(1), is_pinned: true }, fresh = note(2);
  const f = await fixture(t, (path, body) => path === '/user/note/list' ? page([old, fresh]) : (assert.equal(body.note_id, id(2)), fresh));
  const e = await new PatrolEngine(new Store(f.root), {}, {}, f.api).init(); await e.store.upsert(saved(1));
  await e.start({ users: [uid], stopOnSeen: true, readComments: false, analyze: false }); await e.active.promise;
  const job = e.store.data.jobs.at(-1); assert.equal(job.notesRead, 1); assert.equal(job.stoppedKeywords?.length || 0, 0);
  assert.ok(f.calls.every(c => c.path !== '/note/search'));
});

test('停止后续跑保留任务开始时的边界，本任务刚采集的笔记只跳过、不触发提前停止', async t => {
  const a = note(1, 500), b = note(2, 400), old = note(9, 300), after = note(10, 200);
  let interrupted = false, reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const f = await fixture(t, async (path, body, signal) => {
    if (path === '/note/search') { assert.equal(body.page_token, ''); return page([a, b, old, after], 'must-not-fetch'); }
    assert.equal(path, '/note/detail');
    if (body.note_id === id(2) && !interrupted) {
      interrupted = true; reached();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    assert.ok([id(1), id(2)].includes(body.note_id)); return [a, b].find(n => n.note_id === body.note_id);
  });
  const e = await new PatrolEngine(new Store(f.root), {}, {}, f.api).init(); await e.store.upsert(saved(9));
  const first = await e.start({ keywords: ['大肥鱼'], stopOnSeen: true, readComments: false, analyze: false, maxNotes: 3 });
  await waiting; await e.stop();
  const initial = e.store.data.jobs.at(-1);
  assert.equal(initial.status, 'cancelled'); assert.deepEqual(initial.seenBoundaryIds, [id(9)]); assert.equal(initial.collectedItemIds.length, 1);
  await e.resume({ jobId: first.jobId }); await e.active.promise;
  const resumed = e.store.data.jobs.at(-1);
  assert.equal(resumed.status, 'completed'); assert.equal(resumed.options.stopOnSeen, true);
  assert.deepEqual(resumed.seenBoundaryIds, [id(9)]); assert.equal(resumed.notesRead, 1); assert.equal(resumed.collectedItemIds.length, 2);
  assert.equal(resumed.stoppedKeywords[0].noteId, id(9));
  assert.equal(f.calls.filter(c => c.path === '/note/detail' && c.body.note_id === id(1)).length, 1);
  assert.ok(!f.calls.some(c => c.body.note_id === id(10)));
});

test('仅采过笔记的旧帖仍可补采评论，不会因遇旧停止而丢掉未完成范围', async t => {
  const a = note(1);
  const f = await fixture(t, path => path === '/note/search' ? page([a]) : path === '/note/detail' ? a : (assert.equal(path, '/note/comment/list'), page([])));
  const e = await new PatrolEngine(new Store(f.root), {}, {}, f.api).init(); await e.store.upsert(saved(1));
  await e.start({ keywords: ['大肥鱼'], stopOnSeen: true, readComments: true, analyze: false, maxNotes: 1 }); await e.active.promise;
  const job = e.store.data.jobs.at(-1); assert.equal(job.notesRead, 1); assert.deepEqual(job.seenBoundaryIds, []);
  assert.ok(f.calls.some(c => c.path === '/note/comment/list')); assert.equal(job.stoppedKeywords?.length || 0, 0);
});

test('旧配置默认继续查找；默认策略可单独保存，旧任务续跑不被新默认改成遇旧停止', async t => {
  const f = await fixture(t, () => assert.fail('此检查不使用数据接口'));
  let received;
  const api = { hasKey: true, init: async () => {}, async *collect(options) { received = options; } };
  const e = await new PatrolEngine(new Store(f.root), {}, {}, api).init();
  assert.equal(e.store.data.settings.stopOnSeen, false); assert.equal(startSchema.parse({ stopOnSeen: true }).stopOnSeen, true);
  await e.patchSettings({ stopOnSeen: true }); assert.equal(e.options({}).stopOnSeen, true); assert.equal(e.options({ stopOnSeen: false }).stopOnSeen, false);
  const options = { ...defaultSettings(), keywords: ['大肥鱼'], urls: [], readComments: false, analyze: false, maxNotes: 1 }; delete options.stopOnSeen;
  e.store.data.jobs.push({ id: 'legacy', mode: 'scan', status: 'interrupted', options, collectedItemIds: [] });
  await e.resume({ jobId: 'legacy' }); await e.active.promise;
  assert.equal(received.stopOnSeen, false); assert.equal(e.store.data.settings.stopOnSeen, true);
  assert.equal((await new Store(f.root).init()).data.settings.stopOnSeen, true);
});
