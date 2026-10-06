import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, hash } from '../src/store.js';
import { PatrolEngine } from '../src/engine.js';
import { discussionUnits } from '../src/units.js';
import { discussionInput } from '../src/discussion.js';
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
  assert.equal(calls.length, 3); assert.ok(calls.every(c => c.records.length === 23));
  assert.equal(new Set(calls.flatMap(c => c.targets)).size, 23);
  assert.equal(e.state().counts.pending, 1); assert.equal(e.store.data.jobs.at(-1).status, 'partial');
  assert.equal(discussionInput(calls[0].records, calls[0].records).comments[0].capturedParentContext, '我反对辱骂');
  await e.resume(); await e.active.promise;
  assert.equal(calls.length, 6); assert.equal(e.state().counts.pending, 0);
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
