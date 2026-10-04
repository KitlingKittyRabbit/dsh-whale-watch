import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, hash } from '../src/store.js';
import { PatrolEngine } from '../src/engine.js';
import { NeedsAttention } from '../src/browser.js';
import { parseAnalysis, validateNoteUrl } from '../src/schema.js';

const result = (overrides = {}) => ({ decision: 'review', categories: ['骚扰动员'], reason: '鼓动攻击', evidence: ['去骚扰她'], uncertainties: [], confidence: .8, ...overrides });
const record = (n = 0) => ({ kind: 'comment', sourceKey: `comment:${n}`, text: `去骚扰她 ${n}`, context: '作者在号召行动', title: '测试', url: '', coverage: {} });
async function fixture(t, browser, model = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'patrol-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const engine = await new PatrolEngine(new Store(dir), { close: async () => {}, ...browser }, { cacheKey: (item, options) => hash(item.contentHash + options.rules), analyze: async () => result(), ...model }).init();
  return engine;
}
test('只接受逐字证据；引用上级评论不能伪装成目标原文', () => {
  assert.equal(parseAnalysis(JSON.stringify(result()), record()).decision, 'review');
  assert.throws(() => parseAnalysis(JSON.stringify(result({ evidence: ['捏造的攻击'] })), record()), /原文不符/);
  assert.throws(() => parseAnalysis(JSON.stringify(result({ evidence: [] })), record()), /没有原文/);
});
test('图片未读取时不能给整篇正常结论', () => {
  const item = { ...record(), coverage: { imagesUnread: true } };
  const parsed = parseAnalysis(JSON.stringify(result({ decision: 'normal', categories: ['正常讨论'], evidence: [] })), item);
  assert.equal(parsed.decision, 'uncertain'); assert.ok(parsed.uncertainties.length);
});
test('评论独立表达感谢不因背景缺图降级；依赖缺失画面的附和仍标信息不足', () => {
  const base = { ...record(), text: '辛苦帖主', coverage: { contextImagesUnread: true, contextTextTruncated: true, parentMissing: true } };
  const normal = result({ decision: 'normal', categories: ['正常讨论'], evidence: [], targetQuote: '辛苦帖主', interpretation: '向帖主表示感谢', missingContextAffectsDecision: false });
  const independent = parseAnalysis(JSON.stringify(normal), base);
  assert.equal(independent.decision, 'normal'); assert.ok(independent.uncertainties.length);
  const dependent = parseAnalysis(JSON.stringify({ ...normal, targetQuote: '就按图里说的干', missingContextAffectsDecision: true }), { ...base, text: '就按图里说的干' });
  assert.equal(dependent.decision, 'uncertain');
});
test('分析对象与问题依据均不能借用上级原文', () => {
  const item = { ...record(), text: '正义补档', context: '去骚扰她' };
  assert.throws(() => parseAnalysis(JSON.stringify(result({ targetQuote: '去骚扰她' })), item), /分析对象引文/);
  assert.throws(() => parseAnalysis(JSON.stringify(result({ targetQuote: '正义补档', evidence: ['正义补档'], findings: [{ category: '骚扰动员', quote: '去骚扰她', target: '她', behavior: '号召骚扰' }] })), item), /问题依据/);
});
test('旧规则结论退出当前分类，重新分析保留原文、已阅与历史', async t => {
  const engine = await fixture(t, {});
  const item = await engine.store.upsert(record());
  await engine.retry({ id: item.id }); await engine.active.promise;
  assert.equal(engine.state().counts.review, 1);
  engine.store.data.settings.rules += '\n新增语境规则';
  assert.equal(engine.state().counts.review, 0); assert.equal(engine.state().counts.pending, 1);
  assert.equal(engine.results({ filter: 'review' }).total, 0);
  assert.equal(engine.results({ filter: 'unanalyzed' }).items[0].analysisStale, true);
  await engine.markRead({ id: item.id });
  await engine.retry({ id: item.id }); await engine.active.promise;
  assert.equal(item.history.length, 1); assert.equal(item.history[0].reason, '重新分析');
  assert.ok(item.readAt); assert.equal(item.text, record().text); assert.equal(engine.isStale(item), false);
});
test('仅接受真实小红书笔记网址，拒绝伪装域名和脚本', () => {
  assert.ok(validateNoteUrl('https://www.xiaohongshu.com/explore/6ac119d5000000001500fd74?xsec_token=example'));
  for (const url of ['javascript:alert(1)', 'https://www.xiaohongshu.com.evil.example/explore/6ac119d5000000001500fd74', 'https://127.0.0.1/x', 'https://www.xiaohongshu.com/search_result?keyword=hello', 'https://user:password@xhslink.cn/o/example']) assert.throws(() => validateNoteUrl(url));
});
test('整轮分析上限包含失败；重复巡查复用缓存', async t => {
  let calls = 0;
  const engine = await fixture(t, { async *collect() { for (let n = 0; n < 5; n++) yield record(n); } }, { async analyze() { calls++; return result(); } });
  await engine.start({ maxAnalysis: 2 }); await engine.active.promise;
  assert.equal(calls, 2); assert.equal(engine.store.data.items.length, 5);
  await engine.start({ maxAnalysis: 2 }); await engine.active.promise;
  assert.equal(calls, 4); assert.equal(engine.store.data.items.length, 5);
  assert.equal(engine.store.data.jobs.at(-1).cached, 2);
});
test('失败的模型调用也消耗额度，不继续尝试超出整轮上限', async t => {
  let calls = 0;
  const engine = await fixture(t, { async *collect() { for (let n = 0; n < 5; n++) yield record(n); } }, { async analyze() { calls++; throw new Error('服务暂不可用'); } });
  await engine.start({ maxAnalysis: 2 }); await engine.active.promise;
  assert.equal(calls, 2); assert.equal(engine.store.data.jobs.at(-1).failed, 2);
  assert.ok(engine.store.data.items.every(i => !i.analysis));
});
test('导入仅分析导入的项目，不错误分析列表第一条', async t => {
  const analyzed = [];
  const engine = await fixture(t, {}, { async analyze(item) { analyzed.push(item.text); return result({ evidence: [], decision: 'normal' }); } });
  await engine.import({ text: '先导入的内容', analyze: false });
  await engine.import({ text: '后导入的内容', analyze: false });
  await engine.import({ text: '先导入的内容' }); await engine.active.promise;
  assert.deepEqual(analyzed, ['先导入的内容']);
});
test('同一评论内容改变时保留历史并撤回旧结论和复核状态', async t => {
  const engine = await fixture(t, {});
  const item = await engine.store.upsert(record()); item.analysis = result();
  await engine.review({ id: item.id, verdict: 'confirmed' });
  const next = await engine.store.upsert({ ...record(), text: '改成正常讨论' });
  assert.equal(next.id, item.id); assert.equal(next.analysis, null); assert.equal(next.review.verdict, 'pending'); assert.equal(next.history.length, 1);
});
test('登录暂停不宣称成功；可继续，且没有自动完成验证', async t => {
  let attempts = 0;
  const engine = await fixture(t, { async *collect() { if (++attempts === 1) throw new NeedsAttention('请登录'); yield record(); } });
  await engine.start(); await engine.active.promise;
  assert.equal(engine.store.data.jobs.at(-1).status, 'paused');
  await engine.resume(); await engine.active.promise;
  assert.equal(engine.store.data.jobs.at(-1).status, 'completed');
});
test('停止任务将取消模型调用，等待其退出后才允许新任务', async t => {
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const engine = await fixture(t, { async *collect() { yield record(); } }, { async analyze(item, settings, signal) { entered(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
  await engine.start(); await started; await engine.stop();
  assert.equal(engine.active, null); assert.equal(engine.store.data.jobs.at(-1).status, 'cancelled');
});
test('漏采单列且任务只算部分完成；扫码页不进入模型', async t => {
  let calls = 0;
  const engine = await fixture(t, { async *collect(options, signal, progress) {
    progress({ type: 'attempt', message: '读取1' });
    yield { ...record(), kind: 'note' };
    progress({ type: 'attempt', message: '读取2' });
    progress({ type: 'skip', url: 'https://www.xiaohongshu.com/explore/6ac119d5000000001500fd74', code: 'app_required', reason: '需App查看', message: '跳过2' });
  } }, { async analyze() { calls++; return result(); } });
  await engine.start(); await engine.active.promise;
  const job = engine.store.data.jobs.at(-1);
  assert.equal(job.status, 'partial'); assert.equal(job.notesAttempted, 2); assert.equal(job.notesRead, 1);
  assert.equal(job.skippedNotes.length, 1); assert.equal(job.failed, 0); assert.equal(calls, 1);
  assert.match(job.message, /1 篇未读取/);
});
test('全部漏采不显示成功；仅采集不调用模型', async t => {
  let calls = 0, readable = false;
  const engine = await fixture(t, { async *collect(options, signal, progress) {
    progress({ type: 'attempt', message: '读取' });
    if (readable) yield { ...record(), kind: 'note' };
    else progress({ type: 'skip', url: '', code: 'app_required', reason: '需App', message: '未读' });
  } }, { async analyze() { calls++; return result(); } });
  await engine.start({ analyze: false }); await engine.active.promise;
  assert.equal(engine.store.data.jobs.at(-1).status, 'failed'); assert.equal(engine.store.data.items.length, 0);
  readable = true; await engine.start({ analyze: false }); await engine.active.promise;
  assert.equal(engine.store.data.jobs.at(-1).status, 'completed'); assert.equal(calls, 0);
});
test('历史去重跨任务及存储重启有效，主动取消后可重新读取', async t => {
  const { excludeKnownLinks } = await import('../src/browser.js');
  const id = '6ac119d5000000001500fd74', url = `https://www.xiaohongshu.com/explore/${id}`;
  let reads = 0;
  const adapter = { async *collect(options, signal, progress) {
    const selected = excludeKnownLinks([url], new Set(options.excludedNoteIds));
    if (selected.excluded.length) progress({ type: 'excluded', count: selected.excluded.length, message: '排除已查' });
    for (const link of selected.urls) { reads++; progress({ type: 'attempt', message: '读取' }); yield { ...record(), kind: 'note', sourceKey: `note:${id}`, url: link, coverage: { source: 'rendered-dom' } }; }
  } };
  let engine = await fixture(t, adapter);
  await engine.start({ analyze: false }); await engine.active.promise; assert.equal(reads, 1);
  // Includes a failed-only URL and manually imported note: neither becomes collection history.
  engine.store.data.jobs.push({ status: 'failed', options: { urls: ['unused'] } });
  await engine.import({ kind: 'note', text: '手动摘录', url: 'https://www.xiaohongshu.com/explore/6ac119d5000000001500fd75', analyze: false });
  engine = await new PatrolEngine(new Store(engine.store.root), adapter, engine.model).init();
  await engine.start({ analyze: false }); await engine.active.promise;
  assert.equal(reads, 1); const job = engine.store.data.jobs.at(-1);
  assert.equal(job.status, 'completed'); assert.equal(job.notesExcluded, 1); assert.equal(job.notesAttempted, 0); assert.equal(job.collected, 0); assert.match(job.message, /没有发现新笔记/);
  await engine.start({ analyze: false, excludeSeen: false }); await engine.active.promise;
  assert.equal(reads, 2); assert.equal(engine.store.data.jobs.at(-1).notesExcluded, 0); assert.equal(engine.store.data.items.length, 2);
});
test('清空已查缓存保留原文分析复核，重启仍为空，重新采集可复用模型结果', async t => {
  const { excludeKnownLinks } = await import('../src/browser.js');
  const id = '6ac119d5000000001500fd74', url = `https://www.xiaohongshu.com/explore/${id}`;
  let reads = 0, calls = 0;
  const adapter = { async *collect(options, signal, progress) {
    const selected = excludeKnownLinks([url], new Set(options.excludedNoteIds));
    if (selected.excluded.length) progress({ type: 'excluded', count: 1, message: '排除' });
    if (selected.urls.length) { reads++; progress({ type: 'attempt', message: '读取' }); yield { ...record(), kind: 'note', sourceKey: `note:${id}`, url, coverage: { source: 'rendered-dom' } }; }
  } };
  let engine = await fixture(t, adapter, { async analyze() { calls++; return result(); } });
  await engine.start(); await engine.active.promise;
  await engine.review({ id: engine.store.data.items[0].id, verdict: 'dismissed', note: '保留复核' });
  // A legacy installation has notes but no independent cache: migrate existing history once.
  delete engine.store.data.seenCache; await engine.store.save();
  engine = await new PatrolEngine(new Store(engine.store.root), adapter, engine.model).init();
  assert.equal(engine.state().seenCache.count, 1);
  const originals = structuredClone(engine.store.data.items);
  const cleared = await engine.clearSeenCache(); assert.equal(cleared.cleared, 1);
  assert.deepEqual(engine.store.data.items, originals); assert.equal(engine.state().seenCache.count, 0);
  engine = await new PatrolEngine(new Store(engine.store.root), adapter, engine.model).init();
  assert.equal(engine.state().seenCache.count, 0); assert.equal(engine.state().seenCache.canRestore, true);
  await engine.start(); await engine.active.promise;
  assert.equal(reads, 2); assert.equal(calls, 1); assert.equal(engine.store.data.jobs.at(-1).cached, 1);
  assert.equal(engine.state().seenCache.count, 1); assert.equal(engine.store.data.items[0].review.verdict, 'dismissed');
});
test('撤销清理合并清理后的新增历史，重复清空空缓存不丢失撤销机会', async t => {
  const engine = await fixture(t, {});
  const first = '6ac119d5000000001500fd74', next = '6ac119d5000000001500fd75';
  const captured = id => ({ ...record(), kind: 'note', sourceKey: `note:${id}`, coverage: { source: 'rendered-dom' } });
  await engine.store.upsert(captured(first)); await engine.clearSeenCache(); await engine.clearSeenCache();
  assert.equal(engine.state().seenCache.canRestore, true);
  await engine.store.upsert(captured(next));
  const restored = await engine.restoreSeenCache(); assert.equal(restored.count, 2);
  assert.deepEqual(new Set(engine.store.data.seenCache.ids), new Set([first, next]));
  assert.equal(engine.state().seenCache.canRestore, false); await assert.rejects(engine.restoreSeenCache(), /没有可撤销/);
});
test('运行中的采集禁止清理或撤销已查缓存', async t => {
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const engine = await fixture(t, { async *collect(options, signal) {
    entered(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  await engine.start({ analyze: false }); await started;
  await assert.rejects(engine.clearSeenCache(), /任务进行中/); await assert.rejects(engine.restoreSeenCache(), /任务进行中/);
  await engine.stop(); assert.equal(engine.state().seenCache.count, 0);
});

test('已阅从各未阅筛选移除，保留原文和分析，重启持久化且批量分析跳过', async t => {
  let calls = 0;
  let engine = await fixture(t, {}, { async analyze() { calls++; return result(); } });
  const first = await engine.store.upsert(record(100));
  const second = await engine.store.upsert(record(101));
  first.analysis = result();
  const original = structuredClone(first);
  await engine.markRead({ id: first.id });
  assert.deepEqual(engine.results().items.map(i => i.id), [second.id]);
  assert.equal(engine.results({ filter: 'review' }).total, 0);
  assert.equal(engine.results({ filter: 'read' }).total, 1);
  assert.equal(engine.state().counts.total, 2); assert.equal(engine.state().counts.unread, 1); assert.equal(engine.state().counts.pending, 1);
  assert.equal(first.text, original.text); assert.deepEqual(first.analysis, original.analysis); assert.ok(first.readAt);
  engine = await new PatrolEngine(new Store(engine.store.root), engine.browser, engine.model).init();
  assert.equal(engine.results({ filter: 'read' }).total, 1);
  await engine.start({}, 'analyze'); await engine.active.promise; assert.equal(calls, 1);
  await engine.markRead({ id: first.id, read: false });
  assert.equal(engine.results().total, 2); assert.equal(engine.results({ filter: 'read' }).total, 0);
  await assert.rejects(engine.markRead({ id: 'missing' }), /没有找到/);
});
test('相同内容不重新弹出已阅记录，实际变化重新出现并保留原已阅历史', async t => {
  const engine = await fixture(t, {});
  const first = await engine.store.upsert(record(100)); await engine.markRead({ id: first.id }); const readAt = first.readAt;
  await engine.store.upsert(record(100)); assert.equal(engine.results().total, 0); assert.equal(first.readAt, readAt);
  await engine.store.upsert({ ...record(100), text: '修改后的内容' });
  assert.equal(engine.results().total, 1); assert.equal(first.readAt, null); assert.equal(first.history[0].readAt, readAt);
});
test('旧人工复核映射为已阅，恢复未阅后重启不会再次隐藏', async t => {
  const engine = await fixture(t, {});
  const first = await engine.store.upsert(record(100)); delete first.readAt; first.review = { verdict: 'dismissed', note: '旧复核理由', at: new Date().toISOString() }; await engine.store.save();
  let next = await new PatrolEngine(new Store(engine.store.root), engine.browser, engine.model).init();
  assert.equal(next.results().total, 0); assert.equal(next.results({ filter: 'read' }).items[0].review.note, '旧复核理由');
  await next.markRead({ id: first.id, read: false });
  next = await new PatrolEngine(new Store(engine.store.root), engine.browser, engine.model).init();
  assert.equal(next.results().total, 1);
});

test('重试指定失败记录只分析该条，保留已阅状态，不处理其他失败或成功记录', async t => {
  const analyzed = [];
  const engine = await fixture(t, {}, { async analyze(item) { analyzed.push(item.id); return result(); } });
  const first = await engine.store.upsert(record(100)); first.analysisError = 'max-tokens';
  const second = await engine.store.upsert(record(101)); second.analysisError = 'max-tokens';
  await engine.markRead({ id: first.id });
  await engine.retry({ id: first.id }); await engine.active.promise;
  assert.deepEqual(analyzed, [first.id]); assert.equal(first.analysisError, null); assert.ok(first.readAt); assert.equal(second.analysisError, 'max-tokens');
  assert.equal(engine.store.data.jobs.at(-1).options.maxAnalysis, 1); assert.equal(engine.store.data.jobs.at(-1).options.maxVision, 1);
  await assert.rejects(engine.retry({ id: 'missing' }), /没有找到/);
});

test('可疑与其它只统计当前已分析结果；材料不足保留原因，待分析和已阅不混入', async t => {
  const engine = await fixture(t, {});
  const rows=[]; for(let n=200;n<205;n++) rows.push(await engine.store.upsert(record(n)));
  for(const [index,decision] of ['review','normal','uncertain'].entries()) {
    rows[index].analysis=result({decision,reason:decision==='uncertain'?'缺少关键配图':'测试'});
    rows[index].analysisKey=engine.model.cacheKey(rows[index],engine.store.data.settings);
  }
  rows[3].analysis=result(); rows[3].analysisKey='旧规则';
  await engine.markRead({id:rows[4].id});
  assert.equal(engine.state().counts.suspicious,1); assert.equal(engine.state().counts.other,2); assert.equal(engine.state().counts.pending,1);
  assert.deepEqual(engine.results({filter:'suspicious'}).items.map(i=>i.id),[rows[0].id]);
  const others=engine.results({filter:'other'}); assert.equal(others.total,2); assert.ok(others.items.every(i=>i.inspectionResult==='other'));
  assert.equal(others.items.find(i=>i.id===rows[2].id).analysis.reason,'缺少关键配图');
  assert.equal(engine.results({filter:'unanalyzed'}).items[0].inspectionResult,null);
});

test('停止的分析可继续，成功结果与已阅保留，只补剩余内容且遵守原每轮上限', async t => {
  let calls=0, blocked; const entered=new Promise(r=>blocked=r); let firstPhase=true;
  const engine=await fixture(t,{}, {async analyze(item,options,signal){
    calls++;
    if(firstPhase && calls===2){blocked();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}
    return result();
  }});
  for(let n=210;n<215;n++) await engine.store.upsert(record(n));
  const read=engine.store.data.items[0];await engine.markRead({id:read.id});
  await engine.start({maxAnalysis:2},'analyze');await entered;await engine.stop();
  const stopped=engine.store.data.jobs.at(-1);assert.equal(stopped.status,'cancelled');assert.equal(stopped.analyzed,1);
  const finished=engine.store.data.items.find(i=>i.analysis);const original=structuredClone(finished.analysis);
  firstPhase=false;await engine.resume({jobId:stopped.id});await engine.active.promise;
  assert.equal(calls,4);assert.deepEqual(finished.analysis,original);assert.ok(read.readAt);
  assert.equal(engine.store.data.jobs.at(-1).options.maxAnalysis,2);assert.equal(engine.store.data.jobs.at(-1).analyzed,2);
  assert.equal(engine.state().counts.pending,1);
  await assert.rejects(engine.resume(),/没有可继续/);
});

test('继续已完成分析不会重新读取配图；中断状态在重启后也可继续', async t => {
  let images=0,analyses=0;
  const engine=await fixture(t,{}, {visionKey:()=> 'new-vision', async readImages(){images++;return {pages:[],complete:false};}, async analyze(){analyses++;return result();}});
  const done=await engine.store.upsert({...record(220),kind:'note',coverage:{imageCount:1}});
  done.analysis=result();done.analysisKey=engine.model.cacheKey(done,engine.store.data.settings);
  await engine.store.upsert(record(221));
  engine.store.data.jobs.push({id:'interrupted-job',status:'running',mode:'analyze',options:{maxAnalysis:1}});await engine.store.save();
  const resumed=await new PatrolEngine(new Store(engine.store.root),engine.browser,engine.model).init();
  await resumed.resume({jobId:'interrupted-job'});await resumed.active.promise;
  assert.equal(images,0);assert.equal(analyses,1);assert.equal(resumed.state().counts.pending,0);
});

test('登录暂停继续原采集任务，不因其它待分析记录改成分析任务', async t => {
  let attempts=0;
  const engine=await fixture(t,{async *collect(){attempts++;if(attempts===1)throw new NeedsAttention('请登录');yield {...record(230),kind:'note'};}});
  await engine.store.upsert(record(231));
  await engine.start({maxNotes:1});await engine.active.promise;assert.equal(engine.store.data.jobs.at(-1).status,'paused');
  await engine.resume();await engine.active.promise;
  assert.equal(engine.store.data.jobs.at(-1).mode,'scan');assert.equal(attempts,2);
});
