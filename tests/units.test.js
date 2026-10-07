import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, hash } from '../src/store.js';
import { PatrolEngine } from '../src/engine.js';
import { discussionUnits } from '../src/units.js';
import { discussionInput, DISCUSSION_BATCH_SIZE } from '../src/discussion.js';
import { CONTEXTUAL_BEHAVIOR_GUIDE } from '../src/rules.js';
const nid = n => (n + 1).toString(16).padStart(24, '0');
const note = n => ({ kind: 'note', sourceKey: `note:${nid(n)}`, title: `笔记${n}`, text: '正常作品', url: '', coverage: { source: 'rendered-dom' } });
const comment = (n, c) => ({ kind: 'comment', sourceKey: `comment:${nid(n)}:c${c}`, text: `评论${c}`, context: '上级评论：我反对辱骂\n\n【所属笔记配图补充】\n旧读取', coverage: { source: 'rendered-dom' } });
const normal = { decision: 'normal', categories: ['正常讨论'], evidence: [], uncertainties: [], reason: '正常讨论' };
async function engine(t, calls = []) {
  const dir = await mkdtemp(join(tmpdir(), 'patrol-units-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const model = { cacheKey: (i, s) => hash(i.contentHash + s.discussionHash + s.rules),
    analyzeDiscussion: async (records, targets) => { calls.push({ records: structuredClone(records), targets: targets.map(i => i.id) }); return targets.map(i => ({ id: i.id, analysis: normal })); },
    analyze: async () => normal };
  return new PatrolEngine(new Store(dir), {}, model).init();
}
test('36篇笔记和542条旧评论显示36篇，保留578条原文，已阅和撤销按整篇执行', async t => {
  const e = await engine(t);
  for (let n = 0; n < 36; n++) await e.store.upsert(note(n), { persist: false });
  for (let c = 0; c < 542; c++) await e.store.upsert(comment(c % 36, c), { persist: false });
  assert.equal(e.state().counts.unread, 36); assert.equal(e.state().counts.records, 578); assert.equal(e.state().counts.pending, 36);
  const view = e.results({ limit: 100 }); assert.equal(view.total, 36); assert.equal(view.items[0].discussionSummary.complete, false);
  assert.match(view.items[0].discussionSummary.limitations.join(''), /旧版浏览器采样/);
  const id = view.items[0].id, members = view.items[0].entries.map(i => i.id);
  await e.markRead({ id }); assert.equal(e.state().counts.unread, 35); assert.equal(e.results({ filter: 'read' }).total, 1);
  assert.ok(e.store.data.items.filter(i => members.includes(i.id)).every(i => i.readAt));
  assert.equal(e.store.data.items.length, 578);
  await e.markRead({ id, read: false }); assert.equal(e.state().counts.unread, 36); assert.equal(e.results({ filter: 'read' }).total, 0);
});
test('旧采样分析用正文和全部已保存评论，篇数上限不在中间切掉评论；续跑跳过完成篇目', async t => {
  const calls = [], e = await engine(t, calls);
  for (let n = 0; n < 2; n++) { await e.store.upsert(note(n)); for (let c = 0; c < 22; c++) await e.store.upsert(comment(n,c)); }
  await e.start({ discussionNoteLimit: 1, maxAnalysis: 1, discussionAnalysisLimit: 1, readImages: false }, 'analyze'); await e.active.promise;
  const perNote = Math.ceil(23 / DISCUSSION_BATCH_SIZE);
  assert.equal(calls.length, perNote); assert.ok(calls.every(c => c.records.length === 23));
  assert.ok(calls.every(c => c.targets.length <= 3));
  assert.equal(new Set(calls.flatMap(c => c.targets)).size, 23);
  assert.equal(e.state().counts.pending, 1); assert.equal(e.store.data.jobs.at(-1).status, 'partial');
  assert.equal(discussionInput(calls[0].records, calls[0].records).comments[0].capturedParentContext, '我反对辱骂');
  await e.resume(); await e.active.promise;
  assert.equal(calls.length, perNote * 2); assert.equal(e.state().counts.pending, 0);
  assert.equal(e.store.data.jobs.at(-1).cached, 23);
});
test('旧评论改变使整篇判断失效；重试一条实际重试所属整篇，不碰其它篇', async t => {
  const calls = [], e = await engine(t, calls);
  const parent = await e.store.upsert(note(0)); const c = await e.store.upsert(comment(0, 1)); await e.store.upsert(note(1));
  await e.start({ discussionNoteLimit: 2, readImages: false }, 'analyze'); await e.active.promise;
  c.text = '更新的评论'; assert.equal(e.isStale(parent), true); assert.equal(e.state().counts.pending, 1);
  await e.retry({ id: c.id }); await e.active.promise;
  assert.deepEqual(calls.at(-1).targets.sort(), [parent.id, c.id].sort()); assert.equal(e.state().counts.pending, 0);
});
test('正文正常而评论可疑归入同篇可疑，保留评论作者；部分已阅不阻碍未阅内容分类', async t => {
  const e = await engine(t); const p = await e.store.upsert(note(0)); const c = await e.store.upsert({ ...comment(0, 1), author: '评论者' });
  await e.start({ readImages: false }, 'analyze'); await e.active.promise;
  c.analysis = { ...normal, decision: 'review', categories: ['人身攻击'] };
  const view = e.results({ filter: 'suspicious' }); assert.equal(view.total, 1); assert.equal(view.items[0].entries.find(i => i.id === c.id).author, '评论者');
  assert.equal(p.analysis.decision, 'normal');
  p.readAt = '已阅'; p.analysisKey = '旧结果';
  assert.equal(e.state().counts.pending, 0); assert.equal(e.state().counts.suspicious, 1);
});
test('孤立评论和完整API快照不冒充完整旧讨论，不从相似标题猜归属', () => {
  const groups = discussionUnits([{ ...comment(0,1), id: 'c' }, { ...note(1), id: 'n', title: '相同标题' }, { ...comment(2,2), id: 'd', title: '相同标题' }]);
  assert.equal(groups.length, 3); assert.equal(groups[0].records[0].text, ''); assert.equal(groups[0].records[0].synthetic, true);
  const p = { ...note(0), id: 'p', discussion: { complete: true, sourceKeys: [`comment:${nid(0)}:c1`, `comment:${nid(0)}:c2`] } };
  const group = discussionUnits([p, { ...comment(0,1), id: 'c' }])[0];
  assert.equal(group.records[0].discussion.complete, false); assert.match(group.records[0].discussion.limitations.join(''), /部分评论记录缺失/);
});
test('八分钱补充按辱亲谐音解释，明确不使用身价解释', () => {
  assert.match(CONTEXTUAL_BEHAVIOR_GUIDE, /“X爸坟前”的谐音/);
  assert.match(CONTEXTUAL_BEHAVIOR_GUIDE, /不是价格或“身价八分钱”/);
});

test('失败项下轮逐条重试，保留整篇上下文和成功结果，不反复重跑已完成项', async t => {
  const calls = [], e = await engine(t, calls);
  await e.store.upsert(note(0));
  for (let c = 0; c < 6; c++) await e.store.upsert(comment(0, c));
  const original = e.model.analyzeDiscussion; let fail = true;
  e.model.analyzeDiscussion = async (records, targets) => {
    const result = await original(records, targets);
    return fail && calls.length === 2 ? result.map(r => ({ id: r.id, error: 'The operation was aborted due to timeout' })) : result;
  };
  await e.start({ readImages: false }, 'analyze'); await e.active.promise;
  assert.equal(e.state().counts.analysisFailed, 3); assert.equal(e.state().counts.analysisFailedNotes, 1);
  const completed = e.store.data.items.filter(i => i.analysis).map(i => ({ id: i.id, result: i.analysis, key: i.analysisKey }));
  const failedIds = e.store.data.items.filter(i => i.analysisError).map(i => i.id);
  const firstRunCalls = calls.length; fail = false;
  await e.start({ readImages: false }, 'analyze'); await e.active.promise;
  const retries = calls.slice(firstRunCalls);
  assert.equal(retries.length, 3); assert.ok(retries.every(c => c.targets.length === 1 && c.records.length === 7));
  assert.deepEqual(retries.flatMap(c => c.targets), failedIds);
  for (const c of completed) {
    const saved = e.store.data.items.find(i => i.id === c.id);
    assert.equal(saved.analysis, c.result); assert.equal(saved.analysisKey, c.key); assert.equal(saved.history?.length || 0, 0);
  }
  assert.equal(e.state().counts.pending, 0); assert.equal(e.state().counts.analysisFailed, 0);
  assert.match(e.store.data.jobs.at(-1).messages.map(m => m.message).join('\n'), /失败项单独重试/);
  await e.start({ readImages: false }, 'analyze'); await e.active.promise;
  assert.equal(calls.length, firstRunCalls + 3); assert.equal(e.store.data.jobs.at(-1).cached, 7);
});

test('可疑篇目和待分析篇目可重叠，持续失败不能当成其它或被清掉', async t => {
  const e = await engine(t), p = await e.store.upsert(note(0)), c = await e.store.upsert(comment(0, 0));
  await e.start({ readImages: false }, 'analyze'); await e.active.promise;
  p.analysis = { ...normal, decision: 'review' }; c.analysis = null; c.analysisError = '引文不属于本条原文';
  e.model.analyzeDiscussion = async (records, targets) => {
    assert.equal(records.length, 2); assert.deepEqual(targets.map(i => i.id), [c.id]);
    return [{ id: c.id, error: '引文不属于本条原文' }];
  };
  await e.start({ readImages: false }, 'analyze'); await e.active.promise;
  assert.equal(e.state().counts.suspicious, 1); assert.equal(e.state().counts.pending, 1);
  assert.equal(e.state().counts.other, 0); assert.equal(e.state().counts.analysisFailed, 1);
  assert.equal(c.analysis, null); assert.equal(c.analysisError, '引文不属于本条原文');
});
