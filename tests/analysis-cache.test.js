import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, hash } from '../src/store.js';
import { PatrolEngine } from '../src/engine.js';
import { createHandler } from '../src/http.js';

const normal = { decision: 'normal', reason: '正常讨论', evidence: [], categories: ['正常讨论'] };
const nid = n => (n + 1).toString(16).padStart(24, '0');
const note = n => ({ kind: 'note', sourceKey: `note:${nid(n)}`, title: `笔记${n}`, text: '正文原文', context: '正文语境', coverage: { source: 'socialdatax' } });
const comment = (n, c) => ({ kind: 'comment', sourceKey: `comment:${nid(n)}:c${c}`, text: `评论原文${c}`, context: '上级评论：上下文', author: `评论者${c}`, coverage: { source: 'socialdatax' } });
const saved = (e, id) => e.store.data.items.find(item => item.id === id);
const withoutResult = ({ analysis, analysisKey, analysisError, ...record }) => record;

async function fixture(t, root) {
  const dir = root || await mkdtemp(join(tmpdir(), 'patrol-analysis-cache-'));
  if (!root) t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = { model: 0, data: 0, browser: 0 };
  const noModel = async () => { calls.model++; throw new Error('缓存操作不得调用模型'); };
  const model = {
    cacheKey: (item, options) => hash(JSON.stringify([item.contentHash, options.discussionHash, options.rules])),
    analyze: noModel, analyzeDiscussion: noModel, readImages: noModel,
  };
  const browser = { async *collect() { calls.browser++; throw new Error('缓存操作不得浏览网页'); }, close: async () => {} };
  const api = { hasKey: true, init: async () => {}, async *collect() { calls.data++; throw new Error('缓存操作不得调用数据商'); } };
  const e = await new PatrolEngine(new Store(dir), browser, model, api).init();
  t.after(() => assert.deepEqual(calls, { model: 0, data: 0, browser: 0 }));
  return e;
}

function setResult(e, item, { stale = false, error, read = false } = {}) {
  item.analysis = structuredClone(normal);
  item.analysisKey = stale ? '旧缓存键' : e.model.cacheKey(item, e.itemOptions(item, e.analysisSettings(e.store.data.settings)));
  if (error) item.analysisError = error;
  if (read) item.readAt = '2026-10-01T00:00:00.000Z';
}

test('仅清当前快照中的旧/失败旧结论，保留新结果、纯失败和原文资料；已阅也清，重复空清理保留撤销备份', async t => {
  const e = await fixture(t), parent = await e.store.upsert(note(0)), comments = [];
  for (let n = 0; n < 6; n++) comments.push(await e.store.upsert(comment(0, n)));
  parent.discussion = { complete: true, sourceKeys: comments.slice(0, 5).map(item => item.sourceKey) };
  const [oldUnread, fresh, failedOld, failedOnly, oldRead, outsideSnapshot] = comments;
  for (const item of [parent, ...comments]) setResult(e, item);
  oldUnread.analysisKey = oldRead.analysisKey = outsideSnapshot.analysisKey = '旧缓存键';
  oldRead.readAt = '2026-10-01T00:00:00.000Z';
  failedOld.analysisError = failedOnly.analysisError = '重试超时'; failedOnly.analysis = null;
  for (const item of [oldUnread, failedOld, oldRead]) {
    item.review = { verdict: 'uncertain', note: '用户备注', at: '2026-10-01' };
    item.history = [{ text: '更早原文', analysis: { decision: 'review' }, readAt: '旧已阅' }];
    item.images = [{ index: 1, attachment: { attachmentId: 'sha256:fixture', mediaType: 'image/png' } }];
    item.vision = { pages: [{ index: 1, text: '已读配图文字' }], complete: true, key: '识图键' };
  }
  // Image readings affect discussion-wide keys. Refresh only the two results
  // that are intentionally current, after all input material is in place.
  for (const item of [parent, fresh]) setResult(e, item);
  failedOld.analysisKey = e.model.cacheKey(failedOld, e.itemOptions(failedOld, e.analysisSettings(e.store.data.settings)));
  assert.equal(e.isStale(failedOld), false, '缓存键仍匹配但重试失败的旧结果也应可清理');
  await e.store.save();
  const before = structuredClone(e.store.data), original = new Map(before.items.map(item => [item.id, item]));
  assert.deepEqual([e.state().analysisCache.count, e.state().analysisCache.unreadCount], [3, 2]);
  assert.equal(e.state().counts.entries.pending, 2, '失败旧结论和纯失败本已待分析');
  const result = await e.clearAnalysisCache();
  assert.deepEqual([result.cleared, result.unread], [3, 2]);
  assert.equal(e.state().counts.entries.pending, 3, '仅另一个未阅旧结论新增进入待分析');
  assert.equal(e.store.data.items.length, before.items.length);
  for (const item of [oldUnread, failedOld, oldRead]) {
    const current = saved(e, item.id);
    assert.deepEqual([current.analysis, current.analysisKey, current.analysisError], [null, null, null]);
    assert.deepEqual(withoutResult(current), withoutResult(original.get(item.id)), '清理不改原文、配图、识图、历史、复核和已阅');
  }
  for (const item of [parent, fresh, failedOnly, outsideSnapshot]) assert.deepEqual(saved(e, item.id), original.get(item.id));
  assert.deepEqual(e.store.data.settings, before.settings);
  assert.deepEqual(e.store.data.background, before.background);
  assert.deepEqual(e.store.data.context, before.context);
  assert.deepEqual(e.store.data.seenCache, before.seenCache);
  const backup = structuredClone(e.store.data.analysisCacheTrash);
  let writes = 0; const save = e.store.save.bind(e.store);
  e.store.save = async () => { writes++; await save(); };
  assert.equal((await e.clearAnalysisCache()).cleared, 0);
  assert.equal(writes, 0);
  assert.deepEqual(e.store.data.analysisCacheTrash, backup);
  assert.deepEqual([e.state().analysisCache.canRestore, e.state().analysisCache.backupCount], [true, 3]);
});

test('清理备份跨重启可精确撤销，原本未定义的结果字段保持未定义，不变成null', async t => {
  const e = await fixture(t), records = [];
  for (let n = 0; n < 3; n++) records.push(await e.store.upsert({ kind: 'comment', sourceKey: `manual:${n}`, text: `独立原文${n}`, context: '', coverage: { source: 'manual' } }));
  for (const item of records) item.analysis = structuredClone(normal);
  records[1].analysisKey = null; records[1].analysisError = null;
  records[2].analysisKey = '旧键'; records[2].analysisError = '上次重算失败';
  assert.equal(Object.hasOwn(records[0], 'analysisKey'), false);
  assert.equal(Object.hasOwn(records[0], 'analysisError'), false);
  await e.store.save(); const before = structuredClone(e.store.data.items);
  assert.equal((await e.clearAnalysisCache()).cleared, 3);
  const restarted = await fixture(t, e.store.root);
  assert.equal(restarted.state().analysisCache.backupCount, 3);
  const result = await restarted.restoreAnalysisCache();
  assert.deepEqual([result.restored, result.skipped], [3, 0]);
  assert.deepEqual(restarted.store.data.items, before);
  const restoredMissing = saved(restarted, records[0].id);
  assert.equal(restoredMissing.analysisKey, undefined); assert.equal(restoredMissing.analysisError, undefined);
  assert.equal(Object.hasOwn(restoredMissing, 'analysisKey'), false); assert.equal(Object.hasOwn(restoredMissing, 'analysisError'), false);
  const persisted = JSON.parse(await readFile(restarted.store.path, 'utf8'));
  assert.deepEqual(persisted.items, before); assert.equal(persisted.analysisCacheTrash, null);
  await assert.rejects(restarted.restoreAnalysisCache(), /没有可撤销/);
});

test('撤销保留清理后的新结果、新失败及整篇材料变化，不以旧结论覆盖', async t => {
  const changes = {
    新结果: async (e, ids) => Object.assign(saved(e, ids.target), { analysis: { decision: 'review', reason: '新判断' }, analysisKey: '新键', analysisError: null }),
    新失败: async (e, ids) => { saved(e, ids.target).analysisError = '新重试失败'; },
    自身原文: async (e, ids) => { saved(e, ids.target).text = '修改后的目标原文'; },
    自身配图: async (e, ids) => { saved(e, ids.target).images = [{ index: 1, attachment: { attachmentId: 'sha256:new' } }]; },
    自身识图: async (e, ids) => { saved(e, ids.target).vision = { pages: [{ text: '新的目标识图' }] }; },
    正文识图: async (e, ids) => { saved(e, ids.parent).vision = { pages: [{ text: '新的正文识图' }] }; },
    同篇另一条评论: async (e, ids) => { saved(e, ids.sibling).text = '同篇其它评论已更新'; },
    同篇新增评论: async (e, ids) => { const added = await e.store.upsert(comment(0, 9)); saved(e, ids.parent).discussion.sourceKeys.push(added.sourceKey); },
    重新采到同编号新原文: async e => { await e.store.upsert({ ...comment(0, 1), text: '重新采到的新原文' }); },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async st => {
    const e = await fixture(st), parent = await e.store.upsert(note(0));
    const target = await e.store.upsert(comment(0, 1)), sibling = await e.store.upsert(comment(0, 2));
    parent.discussion = { complete: true, sourceKeys: [target.sourceKey, sibling.sourceKey] };
    setResult(e, target, { stale: true }); await e.store.save();
    assert.equal((await e.clearAnalysisCache()).cleared, 1);
    await change(e, { parent: parent.id, target: target.id, sibling: sibling.id }); await e.store.save();
    const beforeUndo = structuredClone(e.store.data.items), result = await e.restoreAnalysisCache();
    assert.deepEqual([result.restored, result.skipped], [0, 1]);
    assert.deepEqual(e.store.data.items, beforeUndo);
    assert.deepEqual(JSON.parse(await readFile(e.store.path, 'utf8')).items, JSON.parse(JSON.stringify(beforeUndo)));
    assert.equal(e.state().analysisCache.canRestore, false);
  });
});

test('原子持久化失败时清理和撤销都回滚内存，磁盘原文件及撤销备份可继续使用', async t => {
  const e = await fixture(t), item = await e.store.upsert(note(0)); setResult(e, item, { stale: true }); await e.store.save();
  const before = structuredClone(e.store.data), file = await readFile(e.store.path, 'utf8');
  // Make the temporary file unwritable without touching the saved state file.
  await mkdir(e.store.path + '.tmp');
  await assert.rejects(e.clearAnalysisCache(), { code: 'EISDIR' });
  assert.deepEqual(e.store.data, before); assert.equal(await readFile(e.store.path, 'utf8'), file);
  assert.equal(e.analysisCacheMutation, false);
  await rm(e.store.path + '.tmp', { recursive: true }); await e.clearAnalysisCache();
  const cleared = structuredClone(e.store.data), clearedFile = await readFile(e.store.path, 'utf8');
  await mkdir(e.store.path + '.tmp');
  await assert.rejects(e.restoreAnalysisCache(), { code: 'EISDIR' });
  assert.deepEqual(e.store.data, cleared); assert.equal(await readFile(e.store.path, 'utf8'), clearedFile);
  assert.equal(e.analysisCacheMutation, false);
  await rm(e.store.path + '.tmp', { recursive: true });
  assert.equal((await e.restoreAnalysisCache()).restored, 1);
  assert.deepEqual(e.store.data.items, before.items);
});

test('有任务运行时拒绝清理和撤销，不改记录及备份', async t => {
  const e = await fixture(t), item = await e.store.upsert(note(0)); setResult(e, item, { stale: true }); await e.clearAnalysisCache();
  const before = structuredClone(e.store.data), file = await readFile(e.store.path, 'utf8');
  e.active = { job: { id: 'running-task' } };
  await assert.rejects(e.clearAnalysisCache(), /任务进行中/);
  await assert.rejects(e.restoreAnalysisCache(), /任务进行中/);
  assert.deepEqual(e.store.data, before); assert.equal(await readFile(e.store.path, 'utf8'), file);
  e.active = null; assert.equal((await e.restoreAnalysisCache()).restored, 1);
});

test('清理和撤销持久化期间阻止任务与记录写入，结束后解除锁定', async t => {
  for (const action of ['clearAnalysisCache', 'restoreAnalysisCache']) await t.test(action, async st => {
    const e = await fixture(st), item = await e.store.upsert(note(0)); setResult(e, item, { stale: true }); await e.store.save();
    if (action === 'restoreAnalysisCache') await e.clearAnalysisCache();
    let release, entered; const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
    const save = e.store.save.bind(e.store);
    e.store.save = async () => { entered(); await held; await save(); };
    const pending = e[action](); await started;
    try {
      assert.equal(e.analysisCacheMutation, true);
      const before = structuredClone(e.store.data);
      const blocked = [
        () => e.start({}, 'analyze'), () => e.markRead({ id: item.id }),
        () => e.review({ id: item.id, verdict: 'confirmed', note: '不能写入' }),
        () => e.import({ text: '不能导入', analyze: false }),
        () => e.clearCollection(), () => e.restoreCollection(),
        () => e.clearAnalysisCache(), () => e.restoreAnalysisCache(),
      ];
      for (const operation of blocked) await assert.rejects(operation(), /正在更新旧结论缓存/);
      assert.deepEqual(e.store.data, before); assert.equal(e.active, null);
    } finally { release(); await pending; e.store.save = save; }
    assert.equal(e.analysisCacheMutation, false);
    await e.markRead({ id: item.id }); assert.ok(saved(e, item.id).readAt);
    const imported = await e.import({ text: '锁释放后可以导入', analyze: false }); assert.ok(saved(e, imported.id));
  });
});

test('已阅先进入持久化时拒绝清理、撤销和启动，写入失败后精确恢复已阅状态并释放占用', async t => {
  const e = await fixture(t), original = await e.store.upsert(note(0)); setResult(e, original, { stale: true });
  await e.clearAnalysisCache();
  // Keep an undo backup and also a result that a second clear could target.
  setResult(e, saved(e, original.id), { stale: true }); await e.store.save();
  const before = structuredClone(e.store.data), disk = await readFile(e.store.path, 'utf8');
  let release, entered; const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const save = e.store.save.bind(e.store);
  e.store.save = async () => { entered(); await held; throw new Error('已阅保存失败'); };
  const pending = e.markRead({ id: original.id }).then(() => ({ ok: true }), error => ({ error })); await started;
  let outcome;
  try {
    assert.ok(saved(e, original.id).readAt, '已阅写入已开始，但尚未持久化');
    const during = structuredClone(e.store.data);
    await assert.rejects(e.clearAnalysisCache(), /稍后/);
    await assert.rejects(e.restoreAnalysisCache(), /稍后/);
    await assert.rejects(e.start({}, 'analyze'), /稍后/);
    assert.deepEqual(e.store.data, during, '被拒绝的并发操作不替换记录或备份');
    assert.equal(e.active, null);
  } finally { release(); outcome = await pending; e.store.save = save; }
  assert.match(outcome.error?.message || '', /已阅保存失败/);
  assert.deepEqual(e.store.data, before); assert.equal(await readFile(e.store.path, 'utf8'), disk);
  assert.equal(saved(e, original.id).readAt, null);
  await e.markRead({ id: original.id }); assert.ok(saved(e, original.id).readAt, '失败后可再次正常保存已阅');
});

test('同源HTTP可清理及撤销，跨源和无来源请求403；全过程不调用模型或数据商', async t => {
  const e = await fixture(t), item = await e.store.upsert(note(0)); setResult(e, item, { stale: true }); await e.store.save();
  const server = createServer(createHandler(e)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (action, headers = { origin: base }) => fetch(`${base}/plugins/dafeiyu-patrol/api/analysis-cache/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}',
  });
  for (const headers of [{ origin: 'https://evil.example' }, {}, { origin: base, 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await post('clear', headers)).status, 403);
    assert.ok(saved(e, item.id).analysis); assert.equal(e.state().analysisCache.canRestore, false);
  }
  const clear = await post('clear'); assert.equal(clear.status, 200); assert.equal((await clear.json()).cleared, 1);
  assert.equal(saved(e, item.id).analysis, null);
  assert.equal((await post('restore', { origin: 'https://evil.example' })).status, 403);
  assert.equal(saved(e, item.id).analysis, null); assert.equal(e.state().analysisCache.canRestore, true);
  const restore = await post('restore'); assert.equal(restore.status, 200);
  assert.deepEqual(await restore.json(), { restored: 1, skipped: 0, message: '已恢复 1 条旧结论。' });
  assert.deepEqual(saved(e, item.id).analysis, normal);
});
