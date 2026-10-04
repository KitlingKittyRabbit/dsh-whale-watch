import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureImages, validateImageUrl, parseImageReading, analysisMaterial } from '../src/images.js';
import { DshModel } from '../src/model.js';
import { Store, defaultSettings } from '../src/store.js';
import { PatrolEngine } from '../src/engine.js';
import { parseAnalysis } from '../src/schema.js';
const ref = { attachmentId: 'sha256:test', mediaType: 'image/png', bytes: 10, width: 100, height: 100 };
const noteId = '6ac119d5000000001500fd74';
const note = { kind: 'note', sourceKey: `note:${noteId}`, text: '讨论作品', title: '测试', context: '', url: '', coverage: { imageCount: 1, imagesUnread: true }, images: [{ index: 1, attachment: ref }], vision: { pages: [{ index: 1, text: '我反对骚扰', description: '一张文字截图', uncertain: false }], complete: true } };
const normal = { targetQuote: '我反对骚扰', interpretation: '本条反对骚扰', findings: [], missingContextAffectsDecision: false, decision: 'normal', categories: ['正常讨论'], reason: '反对骚扰', evidence: ['我反对骚扰'], uncertainties: [], confidence: .8 };
async function* output(value) { yield { type: 'text-delta', index: 0, text: JSON.stringify(value) }; yield { type: 'finish', reason: { kind: 'stop' } }; }
async function fixture(t, model) {
  const root = await mkdtemp(join(tmpdir(), 'patrol-images-')); t.after(() => rm(root, { recursive: true, force: true }));
  return new PatrolEngine(new Store(root), { close: async () => {} }, model).init();
}
test('配图下载限定公开图片域名；失败保留页码，停止后不继续下载', async () => {
  assert.ok(validateImageUrl('https://sns-webpic-qc.xhscdn.com/a'));
  for (const url of ['http://sns.xhscdn.com/a', 'https://xhscdn.com.evil.example/a', 'https://127.0.0.1/a', 'https://u:p@xhscdn.com/a', 'https://xhscdn.com:8000/a']) assert.throws(() => validateImageUrl(url));
  let saves = 0;
  const images = await captureImages([{ index: 1, url: 'good' }, { index: 2, url: 'bad' }], { saveImage: async input => { assert.equal(input.data[0], 1); saves++; return ref; } }, null, async url => { if (url === 'bad') throw new Error('下载失败'); return { data: Buffer.from([1]), mediaType: 'image/png' }; });
  assert.equal(saves, 1); assert.equal(images[0].attachment, ref); assert.match(images[1].error, /下载失败/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(captureImages([{ index: 1, url: 'good' }], {}, controller.signal));
});
test('看图页码必须与真实附件对应，少页或模糊不能宣称完整', () => {
  const pages = note.vision.pages;
  assert.equal(parseImageReading(JSON.stringify({ pages }), note.images, 1).complete, true);
  assert.equal(parseImageReading(JSON.stringify({ pages }), note.images, 2).complete, false);
  assert.equal(parseImageReading(JSON.stringify({ pages: [{ ...pages[0], uncertain: true }] }), note.images, 1).complete, false);
  assert.throws(() => parseImageReading(JSON.stringify({ pages: [pages[0], pages[0]] }), note.images, 2));
  assert.throws(() => parseImageReading(JSON.stringify({ pages: [{ ...pages[0], index: 2 }] }), note.images, 1));
});
test('模型发送真实图片附件，绑定相同模型配置；纯文字模型在调用前拒绝', async () => {
  let sent, calls = 0;
  const ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'vision' }) }, llm: { prepareCall: async config => ({ config, inputModalities: ['text', 'image'], stream: options => { sent = options; assert.equal(options.maxTokens, config.maxTokens); assert.equal(options.model, config.model); calls++; return output({ pages: note.vision.pages }); } }) } };
  const model = new DshModel(ctx); const read = await model.readImages(note, defaultSettings());
  assert.equal(read.complete, true); assert.equal(calls, 1);
  assert.deepEqual(sent.messages[0].content.find(b => b.type === 'image').attachment, ref);
  ctx.llm.prepareCall = async () => ({ inputModalities: ['text'], stream: () => { calls++; return output({}); } });
  await assert.rejects(model.readImages(note, defaultSettings()), /图片能力/); assert.equal(calls, 1);
});
test('配图文字可作为笔记依据并标注来源，不能冒充评论原文或编造画面页码', async () => {
  const model = new DshModel({ agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'text' }) }, llm: { stream: () => output(normal) } });
  const result = await model.analyze(note, defaultSettings()); assert.match(result.evidenceSources[0], /配图1/); assert.equal(result.decision, 'normal');
  const comment = { ...note, kind: 'comment', text: '评论', coverage: {} };
  await assert.rejects(model.analyze(comment, defaultSettings()), /原文/);
  assert.throws(() => parseAnalysis(JSON.stringify({ ...normal, decision: 'review', evidence: [], imageEvidence: [{ index: 2, observation: '未提供的画面' }] }), analysisMaterial(note)), /图像依据/);
  const visual = { ...normal, decision: 'review', evidence: [], imageEvidence: [{ index: 1, observation: '具体画面' }] };
  assert.equal(parseAnalysis(JSON.stringify(visual), analysisMaterial(note)).decision, 'review');
  const blurred = { ...note, vision: { pages: [{ ...note.vision.pages[0], uncertain: true }], complete: false } };
  const uncertain = parseAnalysis(JSON.stringify(visual), analysisMaterial(blurred)); assert.equal(uncertain.decision, 'uncertain'); assert.equal(uncertain.imageEvidence[0].uncertain, true);
});
test('先读取所属配图再分析评论，重跑复用配图，规则变化不重复付费看图', async t => {
  let calls = 0; const observed = [];
  const model = { visionKey: () => 'images-key', readImages: async () => { calls++; return note.vision; }, cacheKey: (item, settings) => JSON.stringify([item.text, item.vision, item.context, settings.rules]), analyze: async item => { observed.push(structuredClone(item)); return { ...normal, evidence: [] }; } };
  const engine = await fixture(t, model);
  const stored = await engine.store.upsert({ ...note, vision: null });
  await engine.store.upsert({ kind: 'comment', sourceKey: `comment:${noteId}:c1`, text: '我同意', context: '所属笔记：讨论作品', title: '测试评论', url: '', coverage: {} });
  await engine.start({ maxAnalysis: 2 }, 'analyze'); await engine.active.promise;
  assert.equal(calls, 1); assert.equal(observed[0].kind, 'note'); assert.match(observed[1].context, /我反对骚扰/); assert.equal(observed[1].coverage.contextImagesUnread, false);
  engine.store.data.settings.rules += '\n补充规则';
  await engine.start({ maxAnalysis: 2 }, 'analyze'); await engine.active.promise;
  assert.equal(calls, 1); assert.equal(engine.store.data.jobs.at(-1).visionCached, 1); assert.equal(stored.vision.complete, true);
});
test('看图失败也占用额度，剩余笔记标记缺图；仅采集不调用看图', async t => {
  let calls = 0;
  const engine = await fixture(t, { visionKey: () => 'key', readImages: async () => { calls++; throw new Error('不支持图片'); }, cacheKey: item => item.contentHash, analyze: async () => normal });
  await engine.store.upsert({ ...note, vision: null }); await engine.store.upsert({ ...note, sourceKey: 'note:6ac119d5000000001500fd75', vision: null });
  await engine.start({ maxVision: 1 }, 'analyze'); await engine.active.promise;
  const job = engine.store.data.jobs.at(-1); assert.equal(calls, 1); assert.equal(job.visionFailed, 1); assert.equal(job.imagesMissing, 2); assert.equal(job.status, 'partial');
  await engine.start({ analyze: false }, 'analyze'); await engine.active.promise; assert.equal(calls, 1);
});
test('只升级旧默认5/10/15，保留自定义数量和清空后的历史缓存', async t => {
  const engine = await fixture(t, {}); const data = engine.store.data;
  delete data.defaultsRevision; data.settings.maxAnalysis = 15;
  await engine.store.save(); await new Store(engine.store.root).init();
  let store = await new Store(engine.store.root).init(); assert.equal(store.data.settings.maxAnalysis, 55); assert.equal(store.data.seenCache.ids.length, 0);
  delete store.data.defaultsRevision; store.data.settings.maxAnalysis = 20; await store.save();
  store = await new Store(engine.store.root).init(); assert.equal(store.data.settings.maxAnalysis, 20);
});

test('给思考与最终JSON保留8192回复额度，截断结果不采纳且不自动循环重试', async () => {
  let calls = 0;
  const model = new DshModel({ agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'thinking' }) }, llm: { stream: options => { assert.equal(options.maxTokens, 8192); calls++; return (async function* () { yield { type: 'text-delta', index: 0, text: JSON.stringify(normal) }; yield { type: 'finish', reason: { kind: 'max-tokens' } }; })(); } } });
  await assert.rejects(model.analyze(note, defaultSettings()), /8,192.*重试这条/); assert.equal(calls, 1);
});
test('真实模型输入隔离目标与背景，拒收只谈背景或无具体问题依据的回复', async () => {
  let sent, answer = { ...normal, targetQuote: '正义补档', interpretation: '表示支持补档', evidence: [] };
  const model = new DshModel({ agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'text' }) }, llm: { stream: options => { sent = options; return output(answer); } } });
  const item = { kind: 'comment', text: '正义补档', title: '所属笔记标题', context: '所属笔记在溯源营销号', coverage: { contextImagesUnread: true } };
  assert.equal((await model.analyze(item, defaultSettings())).decision, 'normal');
  const input = JSON.parse(sent.messages[0].content[0].text);
  assert.equal(input.target.text, item.text); assert.equal(input.target.title, undefined);
  assert.equal(input.background.noteTitle, item.title); assert.equal(input.background.context, item.context);
  answer = { ...answer, interpretation: '' };
  await assert.rejects(model.analyze(item, defaultSettings()), /未解释本条/);
  answer = { ...answer, interpretation: '表示支持补档', decision: 'review', categories: ['骚扰动员'], evidence: ['正义补档'] };
  await assert.rejects(model.analyze(item, defaultSettings()), /具体问题对象和行为/);
});
test('疑似指控必须另行核对：无具体骚扰退回正常，真正侮辱保留，核对失败不采纳初判', async () => {
  let calls = 0, checks = 0;
  const item = { kind: 'comment', text: '勇士们，出战！', context: '宣传活动，未读取外链', coverage: {}, title: '测试' };
  const finding = { category: '骚扰动员', quote: item.text, target: '猜测的对立群体', behavior: '可能导致围攻' };
  let initial = { ...normal, targetQuote: item.text, interpretation: '宣传号召', decision: 'review', categories: ['骚扰动员'], evidence: [item.text], findings: [finding] };
  let verified = { verdict: 'unsupported', reason: '只有出战修辞，没有指向现实人的骚扰行为', findings: [] };
  let checkFinish = 'stop';
  const model = new DshModel({ agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'text' }) }, llm: { stream: options => {
    calls++; const isCheck = options.messages[0].source.kind === 'dafeiyu-patrol-evidence-check';
    return (async function* () { yield { type: 'text-delta', index: 0, text: JSON.stringify(isCheck ? verified : initial) }; yield { type: 'finish', reason: { kind: isCheck ? checkFinish : 'stop' } }; })();
  } } });
  const run = () => model.analyze(item, defaultSettings(), undefined, { onVerification: () => checks++ });
  const dismissed = await run(); assert.equal(dismissed.decision, 'normal'); assert.equal(dismissed.findings.length, 0); assert.equal(dismissed.verification.verdict, 'unsupported');
  assert.equal(calls, 2); assert.equal(checks, 1);
  item.text = '你就是个脑残'; const insult = { category: '人身攻击', quote: item.text, target: '被回复的现实讨论者', behavior: '直接侮辱智力' };
  initial = { ...initial, targetQuote: item.text, evidence: [item.text], categories: ['人身攻击'], findings: [insult] };
  verified = { verdict: 'supported', reason: '直接辱骂现实讨论者', findings: [insult] };
  assert.equal((await run()).decision, 'review');
  verified = { verdict: 'needs_context', reason: '上级缺失无法知道对象是否是现实人', findings: [] };
  assert.equal((await run()).decision, 'uncertain');
  checkFinish = 'max-tokens'; await assert.rejects(run(), /证据核对未完成/);
  assert.equal(calls, 8); assert.equal(checks, 4);
});
test('笔记自己的标题可以作为依据，评论所属标题不能作为评论原文', () => {
  const item = { kind: 'note', title: '你就是个脑残', text: '看标题', coverage: {} };
  const answer = { ...normal, targetQuote: item.title, evidence: [item.title] };
  assert.equal(parseAnalysis(JSON.stringify(answer), item).decision, 'normal');
  assert.throws(() => parseAnalysis(JSON.stringify(answer), { ...item, kind: 'comment' }), /本条原文/);
});
test('多图单次读取预留文字与思考额度，小图沿用原限额；绑定配置与实际发送一致',async()=>{
 const configs=[];const sends=[];
 const model=new DshModel({agentDefaultModel:{currentSelection:()=>({provider:'fixture',model:'vision'})},llm:{prepareCall:async config=>{configs.push(config);return {config,inputModalities:['text','image'],stream:options=>{sends.push(options);return output({pages:options.messages[0].content.filter(b=>b.type==='image').map((_,i)=>({index:i+1,text:'测试文字',description:'测试图',uncertain:false}))});}};}}});
 const images=Array.from({length:7},(_,i)=>({index:i+1,attachment:ref}));
 await model.readImages({...note,images:images.slice(0,1),coverage:{imageCount:1}},defaultSettings());
 await model.readImages({...note,images,coverage:{imageCount:7}},defaultSettings());
 assert.deepEqual(configs.map(c=>c.maxTokens),[8000,32768]);assert.deepEqual(sends.map(c=>c.maxTokens),[8000,32768]);
});
