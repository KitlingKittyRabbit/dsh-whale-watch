import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SocialDataX } from '../src/socialdatax.js';
import { PatrolEngine } from '../src/engine.js';
import { Store, defaultSettings } from '../src/store.js';
import { settingsSchema, startSchema } from '../src/schema.js';
import { discussionInput } from '../src/discussion.js';

const nid = '111111111111111111111111', url = `https://www.xiaohongshu.com/explore/${nid}`;
const note = { note_id: nid, note_url: url, title: '笔记标题', content: '笔记正文', note_type: 'image', image_items: [], comment_count: 1, author: { name: '作者' }, points: { cost: 10 } };
const comment = { comment_id: 'c1', note_id: nid, content: '只应保留的旧评论', content_type: 'text', image_items: [], reply_count: 0, parent_comment_id: null, author: { name: '读者' } };
const normal = { decision: 'normal', categories: ['正常讨论'], reason: '构造结果', evidence: [], uncertainties: [] };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'whale-note-only-')); t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], analyses = [];
  const api = await new SocialDataX(root, null, async (address, input) => {
    const path = new URL(address).pathname.split('/xhs')[1]; calls.push(path);
    if (path === '/note/detail') return Response.json(note);
    if (path === '/note/comment/list') return Response.json({ items: [comment], next_page_token: '', points: { cost: 10 } });
    throw new Error('意外请求');
  }).init(); await api.setKey('fixture');
  const model = { cacheKey: (i, s) => i.contentHash + s.discussionHash, async analyzeDiscussion(records, targets) {
    analyses.push(structuredClone({ records, targets }));
    return targets.map(i => ({ id: i.id, analysis: { ...normal } }));
  } };
  const engine = await new PatrolEngine(new Store(root), {}, model, api).init();
  const run = async (input, mode) => { await engine.start(input, mode); await engine.active.promise; return engine.store.data.jobs.at(-1); };
  return { root, engine, api, calls, analyses, run };
}

test('只看笔记在最小正文预算内完成，零评论接口，分析与范围说明均不包含评论', async t => {
  const f = await fixture(t);
  const job = await f.run({ urls: [url], readComments: false, readImages: false, maxNotes: 1, apiBudgetYuan: .1 });
  assert.deepEqual(f.calls, ['/note/detail']); assert.equal(job.status, 'completed');
  assert.equal(job.apiCostCents, 10); assert.equal(job.collected, 1); assert.equal(job.analyzed, 1); assert.deepEqual(job.discussionGaps, []);
  assert.match(job.searchSummary, /只看笔记/);
  const data = f.analyses[0]; assert.equal(data.records.length, 1); assert.equal(data.targets.length, 1);
  assert.equal(data.targets[0].kind, 'note'); assert.equal(data.targets[0].coverage.discussionIncomplete, false);
  assert.equal(discussionInput(data.records, data.targets).contextScope, 'note-only');
  assert.deepEqual(discussionInput(data.records, data.targets).comments, []);
  assert.equal(data.records[0].discussion.reportedComments, 1); assert.equal(data.records[0].discussion.scope, 'note');
});

test('笔记模式去重，切回评论模式仍能补采同篇评论，清空缓存也能重新读取', async t => {
  const f = await fixture(t), opts = { urls: [url], maxNotes: 1, analyze: false };
  await f.run({ ...opts, readComments: false });
  assert.deepEqual(f.engine.store.data.seenCache.ids, [nid]);
  await f.run({ ...opts, readComments: false }); assert.equal(f.calls.length, 1);
  await f.run({ ...opts, readComments: true }); assert.deepEqual(f.calls, ['/note/detail', '/note/detail', '/note/comment/list']);
  assert.equal(f.engine.store.data.items.length, 2); assert.equal(f.engine.store.data.items.find(i => i.kind === 'note').discussion.scope, undefined);
  await f.engine.clearSeenCache(); await f.run({ ...opts, readComments: false }); assert.equal(f.calls.at(-1), '/note/detail');
});

for (const complete of [true, false]) test(`仅更新笔记保留原${complete ? '完整' : '部分'}评论快照，旧评论及判断不进模型、不被改写`, async t => {
  const f = await fixture(t);
  const oldComment = await f.engine.store.upsert({ kind: 'comment', sourceKey: `comment:${nid}:c1`, discussionNoteId: nid, text: '只应保留的旧评论', title: note.title, coverage: { source: 'socialdatax' } });
  oldComment.analysis = { ...normal }; oldComment.readAt = '已阅';
  const oldNote = await f.engine.store.upsert({ kind: 'note', sourceKey: `note:${nid}`, discussionNoteId: nid, title: note.title, text: note.content, coverage: { source: 'socialdatax' }, discussion: { complete, sourceKeys: [oldComment.sourceKey], commentsRead: 1, limitations: complete ? [] : ['旧评论有缺口'] } });
  const before = structuredClone(oldComment), snapshot = structuredClone(oldNote.discussion);
  const job = await f.run({ urls: [url], maxNotes: 1, readComments: false, excludeSeen: false, readImages: false });
  assert.equal(job.status, 'completed'); assert.deepEqual(f.calls, ['/note/detail']);
  assert.deepEqual(oldComment, before); assert.deepEqual(oldNote.discussion, snapshot);
  assert.equal(oldNote.lastCapture.scope, 'note'); assert.equal(oldNote.lastCapture.complete, true);
  assert.equal(f.engine.unitViews()[0].entries.length, 2);
  assert.equal(f.analyses[0].records.length, 1); assert.equal(JSON.stringify(f.analyses[0]).includes('只应保留的旧评论'), false);
});

test('分析未阅和明确重算沿用只看笔记范围；拒绝评论重算，切回后可继续评论', async t => {
  const f = await fixture(t);
  await f.run({ urls: [url], maxNotes: 1, analyze: false });
  const c = f.engine.store.data.items.find(i => i.kind === 'comment'), n = f.engine.store.data.items.find(i => i.kind === 'note');
  const before = structuredClone(c);
  await f.run({ readComments: false, readImages: false }, 'analyze');
  assert.deepEqual(c, before); assert.equal(f.analyses[0].records.length, 1); assert.equal(f.analyses[0].targets.length, 1);
  await assert.rejects(f.engine.retry({ id: c.id, readComments: false }), /只看笔记/);
  await f.engine.retry({ id: n.id, readComments: false }); await f.engine.active.promise;
  assert.deepEqual(c, before); assert.equal(f.analyses.at(-1).records.length, 1);
  await f.run({ readComments: true, readImages: false }, 'analyze');
  assert.equal(f.analyses.at(-1).records.length, 2); assert.deepEqual(f.analyses.at(-1).targets.map(i => i.kind), ['comment']);
  assert.equal(f.calls.length, 2, '离线分析及重算不重新读取平台');
});

test('只看笔记可保存并续跑，旧任务省略时保持评论模式，不受当前默认模式改变影响', async t => {
  const f = await fixture(t);
  assert.equal(settingsSchema.parse(defaultSettings()).readComments, true);
  assert.equal(startSchema.parse({ readComments: false }).readComments, false);
  assert.throws(() => startSchema.parse({ readComments: 'false' }));
  await f.engine.patchSettings({ readComments: false });
  assert.equal((await new Store(f.root).init()).data.settings.readComments, false);
  const legacyOptions = { ...defaultSettings(), urls: [url], maxNotes: 1, analyze: false, excludeSeen: false }; delete legacyOptions.readComments;
  f.engine.store.data.jobs.push({ id: 'old', status: 'interrupted', mode: 'scan', options: legacyOptions });
  await f.engine.resume({ jobId: 'old' }); await f.engine.active.promise;
  assert.equal(f.engine.store.data.jobs.at(-1).options.readComments, true); assert.ok(f.calls.includes('/note/comment/list'));
  f.engine.store.data.jobs.push({ id: 'only-note', status: 'interrupted', mode: 'scan', options: { ...defaultSettings(), urls: [url], maxNotes: 1, analyze: false, excludeSeen: false, readComments: false } });
  const before = f.calls.length; await f.engine.resume({ jobId: 'only-note' }); await f.engine.active.promise;
  assert.equal(f.engine.store.data.jobs.at(-1).options.readComments, false); assert.deepEqual(f.calls.slice(before), ['/note/detail']);
});

test('笔记模式标记已阅及恢复只影响笔记，不替未看的评论标为已阅', async t => {
  const f = await fixture(t); await f.run({ urls: [url], maxNotes: 1, analyze: false });
  const c = f.engine.store.data.items.find(i => i.kind === 'comment'), n = f.engine.store.data.items.find(i => i.kind === 'note');
  await f.engine.markRead({ id: n.id, readComments: false }); assert.ok(n.readAt); assert.equal(c.readAt, null);
  await f.engine.markRead({ id: n.id, read: false, readComments: false }); assert.equal(n.readAt, null); assert.equal(c.readAt, null);
});

test('只看笔记采集中断后仅继续本轮篇目，已保存的部分评论快照不导致重复采集', async t => {
  const f = await fixture(t);
  const oldComment = await f.engine.store.upsert({ kind: 'comment', sourceKey: `comment:${nid}:c1`, text: comment.content, coverage: { source: 'socialdatax' } });
  await f.engine.store.upsert({ kind: 'note', sourceKey: `note:${nid}`, title: note.title, text: note.content, coverage: { source: 'socialdatax' }, discussion: { complete: false, sourceKeys: [oldComment.sourceKey] } });
  const outsider = await f.engine.store.upsert({ kind: 'note', sourceKey: 'note:222222222222222222222222', title: '其他任务笔记', text: '其他原文', coverage: { source: 'socialdatax' } });
  let reached, calls = 0; const saved = new Promise(resolve => { reached = resolve; });
  f.api.collect = async function* (_options, signal) {
    calls++;
    yield { note: { kind: 'note', sourceKey: `note:${nid}`, discussionNoteId: nid, title: note.title, text: note.content, coverage: { source: 'socialdatax' },
      discussion: { scope: 'note', complete: true, sourceKeys: [] }, lastCapture: { scope: 'note', complete: true } }, comments: [] };
    reached(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted();
  };
  const first = await f.engine.start({ urls: [url], readComments: false, excludeSeen: false, maxNotes: 1, readImages: false });
  await saved; await f.engine.stop();
  await f.engine.resume({ jobId: first.jobId }); await f.engine.active.promise;
  assert.equal(calls, 1); assert.equal(outsider.analysis, null); assert.equal(oldComment.analysis, null);
  assert.equal(f.analyses.length, 1); assert.equal(f.analyses[0].records.length, 1);
  assert.equal(f.analyses[0].targets[0].sourceKey, `note:${nid}`);
});
