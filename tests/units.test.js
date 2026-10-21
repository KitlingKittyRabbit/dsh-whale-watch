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
test('旧评论改变注明整篇材料变化而不自动重算；明确重算只涉及所属整篇', async t => {
  const calls = [], e = await engine(t, calls);
  const parent = await e.store.upsert(note(0)); const c = await e.store.upsert(comment(0, 1)); await e.store.upsert(note(1));
  await e.start({ discussionNoteLimit: 2, readImages: false }, 'analyze'); await e.active.promise;
  c.text = '更新的评论'; assert.equal(e.isStale(parent), true); assert.equal(e.state().counts.pending, 0);
  const previousCalls = calls.length;
  await e.start({ readImages: false }, 'analyze'); await e.active.promise;
  assert.equal(calls.length, previousCalls);
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
test('无快照讨论按实际保存来源说明局限，手动或未知来源不冒充旧版浏览器采样', () => {
  const url = `https://www.xiaohongshu.com/explore/${nid(0)}`;
  for (const [noteSource, commentSource, label] of [
    ['manual', 'manual', '手动导入样本'],
    ['rendered-dom', 'rendered-dom', '旧版浏览器采样'],
    [undefined, undefined, '已保存讨论样本'],
    ['manual', 'rendered-dom', '已保存讨论样本'],
    ['socialdatax', 'socialdatax', '已保存讨论样本'],
  ]) {
    const items = [
      { id: 'n', kind: 'note', title: '导入正文', text: '正文', url, coverage: { source: noteSource } },
      { id: 'c', kind: 'comment', text: '评论', url, coverage: { source: commentSource } },
    ];
    const original = structuredClone(items), groups = discussionUnits(items);
    assert.equal(groups.length, 1, '相同原帖链接仍按原逻辑归并');
    assert.deepEqual(groups[0].members.map(i => i.id), ['n', 'c']);
    const discussion = groups[0].records[0].discussion;
    assert.equal(discussion.complete, false);
    assert.match(discussion.limitations.join(''), new RegExp(label));
    if (label !== '旧版浏览器采样') assert.doesNotMatch(discussion.limitations.join(''), /浏览器/);
    assert.deepEqual(items, original, '只修改派生说明，不改已保存来源或原记录');
  }
  const orphan = discussionUnits([{ id: 'c', kind: 'comment', text: '单独导入评论', url, coverage: { source: 'manual' } }])[0];
  assert.match(orphan.records[0].discussion.limitations.join(''), /手动导入样本/);
  assert.match(orphan.records[0].discussion.limitations.join(''), /未保存所属笔记正文/);
  assert.equal(orphan.records[0].synthetic, true);
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

test('篇数与条目数分别统计，保留旧判断，已阅及旧快照不串入当前计数', async t => {
  const e = await engine(t), p = await e.store.upsert(note(0));
  const comments = [];
  for (let n = 0; n < 6; n++) comments.push(await e.store.upsert(comment(0, n)));
  const second = await e.store.upsert(note(1));
  // The last saved comment belongs to an older capture, outside this snapshot.
  p.discussion = { complete: true, sourceKeys: comments.slice(0, 5).map(i => i.sourceKey) };
  for (const i of [p, ...comments, second]) {
    i.analysis = normal; i.analysisKey = e.model.cacheKey(i, e.itemOptions(i, e.analysisSettings(e.store.data.settings)));
  }
  comments[0].analysis = { ...normal, decision: 'review' };
  comments[1].analysis = { ...normal, decision: 'uncertain' };
  comments[2].analysis = null; comments[2].analysisError = '模型超时';
  comments[3].analysisKey = '旧规则';
  comments[4].readAt = '已阅'; comments[5].analysis = { ...normal, decision: 'review' };
  const c = e.state().counts;
  assert.equal(c.unread, 2); assert.equal(c.suspicious, 1); assert.equal(c.other, 2); assert.equal(c.pending, 1);
  assert.deepEqual(c.entries, { unread: 6, suspicious: 1, other: 4, pending: 1 });
  assert.equal(c.entries.unread, c.entries.suspicious + c.entries.other + c.entries.pending);
  assert.equal(e.results({ filter: 'other' }).total, 2, '其它筛选含有已判其它条目的篇目');
  const mixed = e.results().items.find(i => i.id === p.id);
  assert.equal(mixed.inspectionResult, 'suspicious');
  assert.deepEqual([mixed.discussionSummary.suspicious, mixed.discussionSummary.other, mixed.discussionSummary.pending], [1, 3, 1]);
  await e.markRead({ id: p.id });
  assert.deepEqual(e.state().counts.entries, { unread: 1, suspicious: 0, other: 1, pending: 0 });
  assert.equal(e.state().counts.other, 1); assert.equal(e.results({ filter: 'other' }).total, 1);
  await e.markRead({ id: p.id, read: false });
  assert.deepEqual(e.state().counts.entries, { unread: 7, suspicious: 1, other: 5, pending: 1 });
});

test('失败重试期间补读图片只重试原失败条目，不扩大到整篇旧结论，保留完整新语境', async t => {
  const calls = [], e = await engine(t, calls);
  const p = await e.store.upsert({ ...note(0), coverage: { imageCount: 1 } });
  const c = await e.store.upsert(comment(0, 1)), f = await e.store.upsert(comment(0, 2));
  await e.start({ readImages: false }, 'analyze'); await e.active.promise;
  f.analysis = null; f.analysisError = '超时';
  const completed = [p,c].map(i => ({ item:i, analysis:i.analysis, key:i.analysisKey })), before = calls.length;
  e.model.readImages = async () => ({ pages: [{ index: 1, text: '新配图内容' }], complete: true });
  await e.start({ readImages: true }, 'analyze'); await e.active.promise;
  assert.equal(calls.length, before + 1);
  assert.deepEqual(calls.at(-1).targets, [f.id]);
  assert.equal(calls.at(-1).records.length, 3);
  assert.equal(calls.at(-1).records[0].vision.pages[0].text, '新配图内容');
  for (const i of completed) { assert.equal(i.item.analysis,i.analysis); assert.equal(i.item.analysisKey,i.key); }
  assert.equal(e.state().counts.pending, 0); assert.equal(e.state().counts.retainedResults, 2);
  assert.equal(e.store.data.jobs.at(-1).analyzed, 1);
  await e.start({ readImages: true }, 'analyze'); await e.active.promise;
  assert.equal(calls.length, before + 1);
});

test('新增评论与背景规则变化不扩大分析范围，明确重算才处理已有结论', async t => {
  const calls = [], e = await engine(t, calls);
  const p = await e.store.upsert(note(0)); const c = await e.store.upsert(comment(0,1));
  await e.start({ readImages: false }, 'analyze'); await e.active.promise;
  const previous = [p,c].map(i => ({ item:i, analysis:i.analysis, key:i.analysisKey }));
  const extra = await e.store.upsert(comment(0,2));
  e.store.data.settings.rules += '\n修改规则';
  const before = calls.length;
  await e.start({ readImages: false }, 'analyze'); await e.active.promise;
  assert.equal(calls.length,before+1); assert.deepEqual(calls.at(-1).targets,[extra.id]);
  assert.equal(calls.at(-1).records.length,3);
  for (const i of previous) { assert.equal(i.item.analysis,i.analysis); assert.equal(i.item.analysisKey,i.key); }
  assert.equal(e.state().counts.pending,0);
  await e.retry({ id:p.id }); await e.active.promise;
  assert.deepEqual(calls.at(-1).targets.sort(),[p.id,c.id,extra.id].sort());
  assert.equal(e.state().counts.retainedResults,0);
});

test('明确整篇重算失败时保留旧结论及原缓存键，失败仍待分析；下轮只重试失败项', async t => {
  const calls = [], e = await engine(t,calls);
  const p = await e.store.upsert(note(0)), c = await e.store.upsert(comment(0,1));
  await e.start({ readImages:false }, 'analyze'); await e.active.promise;
  const previous = { analysis:c.analysis, key:c.analysisKey };
  e.store.data.settings.rules += '\n改动';
  const original = e.model.analyzeDiscussion;
  e.model.analyzeDiscussion = async (records,targets) => (await original(records,targets)).map(r=>r.id===c.id?{id:r.id,error:'引文不符'}:r);
  await e.retry({id:p.id}); await e.active.promise;
  assert.equal(c.analysis,previous.analysis); assert.equal(c.analysisKey,previous.key);
  assert.equal(c.analysisError,'引文不符'); assert.equal(e.state().counts.entries.pending,1);
  e.model.analyzeDiscussion = original;
  await e.start({readImages:false},'analyze'); await e.active.promise;
  assert.deepEqual(calls.at(-1).targets,[c.id]); assert.equal(c.analysisError,null);
});

test('继续明确重算任务仍只处理未完成项，不重算成功项、不扩到其它篇，保留已阅状态', async t => {
  const calls = [], e = await engine(t,calls);
  const p = await e.store.upsert(note(0)), c = await e.store.upsert(comment(0,1));
  await e.store.upsert(note(1));
  await e.retry({id:p.id}); await e.active.promise;
  await e.markRead({id:p.id});
  c.analysisError = '重算失败';
  const old = e.store.data.jobs.at(-1); old.status = 'cancelled';
  const before = calls.length, saved = p.analysis;
  await e.resume({jobId:old.id}); await e.active.promise;
  assert.equal(calls.length,before+1); assert.deepEqual(calls.at(-1).targets,[c.id]);
  assert.equal(calls.at(-1).records.length,2); assert.equal(p.analysis,saved);
  assert.ok(p.readAt); assert.ok(c.readAt);
  assert.equal(e.store.data.items.find(i=>i.sourceKey===note(1).sourceKey).analysis,null);
});

test('重算已有结论中途停止，再继续必须处理尚未重算的旧结果，不能因有旧结论跳过', async t => {
  const calls = [], e = await engine(t,calls);
  const p = await e.store.upsert(note(0));
  for (let c=0;c<5;c++) await e.store.upsert(comment(0,c));
  await e.retry({id:p.id}); await e.active.promise;
  const initial = e.model.analyzeDiscussion;
  let resolveStarted, batches = 0;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  e.model.analyzeDiscussion = async (records,targets,settings,signal) => {
    batches++;
    if (batches===2) { resolveStarted(); await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})); }
    return initial(records,targets);
  };
  await e.retry({id:p.id}); await started; await e.stop();
  const stopped = e.store.data.jobs.at(-1);
  assert.equal(stopped.analyzed,3); assert.equal(stopped.remainingTargetIds.length,3);
  assert.equal(e.state().counts.entries.pending,0,'旧结论保留，任务剩余目标与普通待分析队列不同');
  const remaining = [...stopped.remainingTargetIds];
  e.model.analyzeDiscussion = initial;
  const before = calls.length;
  await e.resume({jobId:stopped.id}); await e.active.promise;
  assert.equal(calls.length,before+1); assert.deepEqual(calls.at(-1).targets,remaining);
  assert.deepEqual(e.store.data.jobs.at(-1).remainingTargetIds,[]);
});

test('升级前已中断的整篇重算可按结果时间恢复剩余目标，已重算条目不重复', async t => {
  const calls=[],e=await engine(t,calls),p=await e.store.upsert(note(0)),c=await e.store.upsert(comment(0,1));
  await e.retry({id:p.id});await e.active.promise;
  const old=e.store.data.jobs.at(-1);old.status='cancelled';old.startedAt='2026-10-09T10:00:00.000Z';delete old.remainingTargetIds;
  p.analysis={...p.analysis,analyzedAt:'2026-10-09T10:01:00.000Z'};
  c.analysis={...c.analysis,analyzedAt:'2026-10-09T09:00:00.000Z'};
  const before=calls.length;await e.resume({jobId:old.id});await e.active.promise;
  assert.equal(calls.length,before+1);assert.deepEqual(calls.at(-1).targets,[c.id]);
});
