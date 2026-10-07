import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocialDataX } from '../src/socialdatax.js';
import { Store, defaultSettings } from '../src/store.js';
import { PatrolEngine } from '../src/engine.js';
import { DshModel } from '../src/model.js';
import { discussionInput, discussionHash } from '../src/discussion.js';
import { parseAnalysis, settingsSchema, startSchema } from '../src/schema.js';
import { SEARCH_OPTIONS, DEFAULT_SEARCH_SETTINGS } from '../src/search-options.js';

const noteId = '6ac119d5000000001500fd74', url = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=fixture`;
const key = 'fixture-private-key';
const note = { note_id: noteId, note_url: url, title: '创作讨论', content: '这是文章正文', note_type: 'image', image_items: [], comment_count: 4, author: { name: '帖主' }, points: { cost: 10 } };
const c = (n, extras = {}) => ({ comment_id: `c${n}`, note_id: noteId, content: `评论${n}`, content_type: 'text', image_items: [], reply_count: 0, parent_comment_id: null, author: { name: `读者${n}` }, ...extras });
const page = (items, next = '') => ({ items, next_page_token: next, points: { cost: 10 } });
const options = extra => ({ ...defaultSettings(), collectionSource: 'socialdatax', urls: [url], keywords: [], excludedNoteIds: [], ...extra });
async function root(t) { const r = await mkdtemp(join(tmpdir(), 'whale-api-')); t.after(() => rm(r, { recursive: true, force: true })); return r; }
async function adapter(t, reply) {
  const calls = [], r = await root(t);
  const source = await new SocialDataX(r, null, async (address, input) => {
    assert.equal(new URL(address).origin, 'https://mcp.socialdatax.com'); assert.equal(input.headers.Authorization, `Bearer ${key}`);
    const body = JSON.parse(input.body); calls.push({ path: new URL(address).pathname, body });
    const value = await reply(new URL(address).pathname.replace('/socialdatax/api/v1/xhs', ''), body, calls.length);
    return Response.json(value);
  }).init(); await source.setKey(key);
  return { source, calls, r };
}
const normal = text => ({ targetQuote: text, interpretation: '正常讨论自己的观点', decision: 'normal', categories: ['正常讨论'], reason: '结合上下文未见不合理行为', evidence: [], findings: [], uncertainties: [], confidence: .8 });
async function* output(value) { yield { type: 'text-delta', index: 0, text: JSON.stringify(value) }; yield { type: 'finish', reason: { kind: 'stop' } }; }

test('分页读取一级评论及回复，去重、保留父评论与完整链接，密钥不进入材料', async t => {
  const { source, calls } = await adapter(t, (path, body) => {
    if (path === '/note/detail') return note;
    if (path === '/note/comment/list') return body.page_token ? page([c(1, { reply_count: 2 }), c(2)]) : page([c(1, { reply_count: 2 })], 'top-next');
    if (path === '/note/comment/sub/list') return body.page_token ? page([c(3), c(4)]) : page([c(3)], 'reply-next');
    throw new Error('未知接口');
  });
  const bundles = []; for await (const b of source.collect(options(), new AbortController().signal, () => {})) bundles.push(b);
  assert.equal(calls.length, 5); assert.equal(bundles.length, 1);
  const b = bundles[0]; assert.equal(b.note.discussion.complete, true); assert.equal(b.comments.length, 4);
  assert.equal(b.comments.find(c => c.commentId === 'c3').parentCommentId, 'c1');
  assert.match(b.comments.find(c => c.commentId === 'c3').context, /上级评论（读者1）：评论1/);
  assert.equal(b.note.url, url); assert.equal(JSON.stringify(b).includes(key), false);
});

test('预算包括正文与评论分页，到限保留已读取内容，部分评论不进入已查缓存', async t => {
  const { source, calls, r } = await adapter(t, path => path === '/note/detail' ? note : page([c(1)], 'more'));
  const engine = await new PatrolEngine(new Store(r), { close: async () => {} }, {}, source).init();
  await engine.start({ ...options({ apiBudgetYuan: .2 }), analyze: false }); await engine.active.promise;
  const job = engine.store.data.jobs.at(-1);
  assert.equal(calls.length, 2); assert.equal(job.apiCostCents, 20); assert.equal(job.status, 'partial');
  assert.equal(engine.store.data.items.length, 2); assert.equal(engine.store.data.seenCache.ids.length, 0);
  assert.match(job.discussionGaps[0].limitations.join(''), /费用上限/);
});

test('遇到业务错误不重试，密钥单独保存且状态、任务、导出对象中不包含密钥', async t => {
  const { source, calls, r } = await adapter(t, () => ({ code: 2001, message: `故意返回${key}` }));
  const engine = await new PatrolEngine(new Store(r), {}, {}, source).init();
  await engine.start({ ...options(), analyze: false }); await engine.active.promise;
  assert.equal(calls.length, 1); assert.equal(engine.store.data.jobs.at(-1).status, 'failed');
  assert.equal(JSON.stringify(engine.state()).includes(key), false); assert.equal(JSON.stringify(engine.store.data).includes(key), false);
  assert.equal((await stat(source.credentialsPath)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(source.credentialsPath, 'utf8')).apiKey, key);
  await source.setKey(''); assert.equal(source.hasKey, false);
});

test('用户在评论分页途中停止，保留付费读取的正文与评论，不再发起请求', async t => {
  const { source, calls } = await adapter(t, path => path === '/note/detail' ? note : page([c(1)], 'more'));
  const controller = new AbortController(), bundles = [];
  await assert.rejects(async () => { for await (const b of source.collect(options(), controller.signal, e => { if (e.type === 'discussion') controller.abort(); })) bundles.push(b); });
  assert.equal(calls.length, 2); assert.equal(bundles[0].comments.length, 1); assert.equal(bundles[0].note.discussion.complete, false);
});

test('发现单价变更停止后续调用，搜索与指定链接去重；不回退浏览器', async t => {
  const { source, calls } = await adapter(t, path => path === '/note/search' ? { items: [{ note_id: noteId, note_url: url }], next_page_token: '', points: { cost: 20 } } : note);
  await assert.rejects(async () => { for await (const b of source.collect(options({ urls: [], keywords: ['创作'] }), new AbortController().signal, () => {})) void b; }, /价格/);
  assert.equal(calls.length, 1);
  for await (const b of source.collect(options({ excludedNoteIds: [noteId] }), new AbortController().signal, () => {})) assert.fail('已查笔记不应读取');
  assert.equal(calls.length, 1);
});

test('同批分析先收到完整已保存讨论，证据核对仍带相同讨论，不能借用邻居原文', async () => {
  const records = [{ id: 'note', kind: 'note', text: '文章', title: '创作', context: '', coverage: {}, discussion: { complete: true, sourceKeys: ['c1','c2'] } },
    { id: 'a', kind: 'comment', text: '去骚扰她', context: '', coverage: {}, commentId: 'c1', threadRootId: 'c1' },
    { id: 'b', kind: 'comment', text: '我反对', context: '', coverage: {}, commentId: 'c2', parentCommentId: 'c1', threadRootId: 'c1' }];
  const finding = { category: '骚扰动员', quote: '去骚扰她', target: '她', behavior: '号召骚扰' };
  const review = { ...normal('去骚扰她'), decision: 'review', categories: ['骚扰动员'], evidence: ['去骚扰她'], findings: [finding] };
  const calls = [];
  const model = new DshModel({ agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'text' }) }, llm: { stream: request => {
    calls.push(request); return output(calls.length === 1 ? { results: [{ id: 'a', analysis: review }, { id: 'b', analysis: { ...normal('我反对'), evidence: ['去骚扰她'] } }] }
      : { verdict: 'supported', reason: '依据属于目标发言', findings: [finding] });
  } } });
  const rows = await model.analyzeDiscussion(records, records.slice(1), defaultSettings(), new AbortController().signal);
  assert.equal(rows[0].analysis.decision, 'review'); assert.match(rows[1].error, /原文不符/);
  const first = JSON.parse(calls[0].messages[0].content[0].text), check = JSON.parse(calls[1].messages[0].content[0].text);
  assert.equal(first.discussion.comments.length, 2); assert.deepEqual(check.background.discussion, first.discussion);
  assert.equal(rows[0].analysis.discussionUsed.contextScope, 'full-saved-discussion');
});

test('未知、重复或遗漏目标不能成为整篇讨论结论；过长讨论明确标注范围并保留上级', async () => {
  const records = [{ id: 'note', kind: 'note', text: '文章', coverage: {}, discussion: { complete: true } },
    { id: 'parent', kind: 'comment', text: '上级', commentId: 'c1', threadRootId: 'c1', coverage: {} },
    { id: 'reply', kind: 'comment', text: '回复', commentId: 'c2', parentCommentId: 'c1', threadRootId: 'c1', coverage: {} },
    ...Array.from({ length: 100 }, (_, n) => ({ id: `other-${n}`, kind: 'comment', text: '无关讨论'.repeat(300), commentId: `other-${n}`, threadRootId: `other-${n}`, coverage: {} }))];
  const material = discussionInput(records, [records[2]]);
  assert.equal(material.contextScope, 'related-discussion-threads'); assert.ok(material.comments.some(i => i.id === 'parent')); assert.ok(material.omittedComments > 0);
  const model = new DshModel({ agentDefaultModel: { currentSelection: () => ({}) }, llm: { stream: () => output({ results: [{ id: 'unexpected', analysis: normal('回复') }] }) } });
  await assert.rejects(model.analyzeDiscussion(records, [records[2]], defaultSettings(), new AbortController().signal), /未知或重复/);
});

test('采集整篇后才分析，离线重试不访问数据商；邻居变化使旧分析失效', async t => {
  const { source, calls, r } = await adapter(t, path => path === '/note/detail' ? { ...note, comment_count: 2 } : page([c(1), c(2)]));
  const seen = [];
  const model = { cacheKey: (item, settings) => item.contentHash + settings.discussionHash, async analyzeDiscussion(records, targets) {
    seen.push(records.map(i => i.text)); assert.equal(records.length, 3);
    return targets.map(i => ({ id: i.id, analysis: normal(i.text) }));
  } };
  const engine = await new PatrolEngine(new Store(r), { close: async () => {}, collect() { assert.fail('不得浏览器回退'); } }, model, source).init();
  await engine.start(options()); await engine.active.promise;
  assert.equal(calls.length, 2); assert.equal(seen.length, 1); assert.equal(engine.state().counts.pending, 0);
  assert.equal(engine.store.data.seenCache.ids.length, 1);
  await engine.start({ ...options(), excludeSeen: false }); await engine.active.promise;
  assert.equal(calls.length, 4); assert.equal(seen.length, 1, '相同讨论重新读取不重复调用模型');
  const item = engine.store.data.items.find(i => i.commentId === 'c2');
  await engine.retry({ id: item.id }); await engine.active.promise; assert.equal(calls.length, 4); assert.equal(seen.length, 2);
  const parent = engine.store.data.items.find(i => i.kind === 'note'), before = discussionHash([parent, ...engine.store.data.items.filter(i => i.kind === 'comment')]);
  engine.store.data.items.find(i => i.commentId === 'c1').text = '邻居已经修改';
  assert.notEqual(before, discussionHash([parent, ...engine.store.data.items.filter(i => i.kind === 'comment')])); assert.equal(engine.isStale(item), true);
});

test('省略单轮参数时继承已保存的数据来源和预算，到限尚有整篇未读时不能显示完整完成', async t => {
  const { source, calls, r } = await adapter(t, path => path === '/note/detail' ? { ...note, comment_count: 0 } : page([]));
  const engine = await new PatrolEngine(new Store(r), {}, {}, source).init();
  engine.store.data.settings = { ...defaultSettings(), collectionSource: 'socialdatax', apiBudgetYuan: .2, discussionAnalysisLimit: 37 };
  assert.equal(engine.options({}).apiBudgetYuan, .2); assert.equal(engine.options({}).discussionAnalysisLimit, 37);
  await engine.start({ urls: [url, 'https://www.xiaohongshu.com/explore/6ac119d5000000001500fd75'], analyze: false }); await engine.active.promise;
  const job = engine.store.data.jobs.at(-1);
  assert.equal(calls.length, 2); assert.equal(job.status, 'partial'); assert.match(job.apiStopReason, /另有1篇/);
  assert.equal(engine.store.data.items.length, 1); assert.equal(engine.store.data.seenCache.ids.length, 1);
});

test('抓取时间不使讨论判断失效，存储快照编号不挤占模型讨论输入', () => {
  const records = [{ id: 'note', kind: 'note', text: '正文', discussion: { complete: true, fetchedAt: '旧时间', sourceKeys: Array.from({ length: 2000 }, (_, n) => `comment:${noteId}:comment-id-${n}`) } }];
  const before = discussionHash(records); records[0].discussion.fetchedAt = '新时间';
  assert.equal(discussionHash(records), before); assert.equal(discussionInput(records, records).contextScope, 'full-saved-discussion');
  assert.equal(discussionInput(records, records).collection.sourceKeys, undefined);
});

test('同样文字但回复对象或作者变化时更新已存归属，不能复用旧判断', async t => {
  const store = await new Store(await root(t)).init();
  const record = { kind: 'comment', sourceKey: `comment:${noteId}:c1`, discussionNoteId: noteId, text: '我赞同', context: '', author: '甲', parentCommentId: 'parent1', threadRootId: 'parent1', coverage: {} };
  const item = await store.upsert(record), before = item.contentHash; item.analysis = normal(record.text); item.readAt = '已阅';
  await store.upsert({ ...record, author: '乙', parentCommentId: 'parent2', threadRootId: 'parent2' });
  assert.notEqual(item.contentHash, before); assert.equal(item.author, '乙'); assert.equal(item.parentCommentId, 'parent2'); assert.equal(item.analysis, null); assert.equal(item.readAt, null);
});

test('笔记图像或视频缺失属于评论背景缺口，依赖它的评论不能被判正常', async t => {
  const { source, r } = await adapter(t, path => path === '/note/detail' ? { ...note, comment_count: 1, note_type: 'video', image_items: [{ image_url: 'https://sns-webpic-qc.xhscdn.com/fixture' }] } : page([c(1)]));
  let checked = false;
  const model = { cacheKey: () => 'fixture', async analyzeDiscussion(records, targets) {
    const comment = records[1]; assert.equal(comment.coverage.contextImagesUnread, true); assert.equal(comment.coverage.contextMediaUnread, true);
    assert.equal(parseAnalysis(JSON.stringify({ ...normal(comment.text), missingContextAffectsDecision: true }), comment).decision, 'uncertain');
    assert.equal(parseAnalysis(JSON.stringify(normal(comment.text)), comment).decision, 'normal', '独立评论不会仅因背景缺图一律降级');
    checked = true; return targets.map(i => ({ id: i.id, analysis: normal(i.text) }));
  } };
  const engine = await new PatrolEngine(new Store(r), {}, model, source).init();
  await engine.start({ ...options(), readImages: false }); await engine.active.promise; assert.equal(checked, true);
});

test('分块UTF8响应可解析，网络失败费用保持待确认且不重复请求', async t => {
  const r = await root(t); let calls = 0;
  const source = await new SocialDataX(r, null, async () => {
    calls++; if (calls > 1) throw new Error(`连接错误包含${key}`);
    const bytes = Buffer.from(JSON.stringify(note));
    return new Response(new ReadableStream({ start(controller) { for (let n = 0; n < bytes.length; n++) controller.enqueue(bytes.subarray(n, n + 1)); controller.close(); } }));
  }).init(); await source.setKey(key);
  const engine = await new PatrolEngine(new Store(r), {}, {}, source).init();
  await engine.start({ ...options(), analyze: false }); await engine.active.promise;
  const job = engine.store.data.jobs.at(-1);
  assert.equal(calls, 2); assert.equal(job.apiCostCents, 10); assert.equal(job.apiUnconfirmed, 1); assert.equal(job.status, 'partial');
  assert.equal(engine.store.data.items.find(i => i.kind === 'note').text, note.content);
  assert.equal(JSON.stringify(engine.store.data).includes(key), false);
});


test('搜索筛选与评论排序穿透每一页请求；分页令牌只复用同一查询，视频明确有内容缺口', async t => {
  for (let n=0;n<5;n++) {
    const selected=Object.fromEntries(Object.entries(SEARCH_OPTIONS).map(([key,option])=>[key,option.choices[n%option.choices.length][0]]));
    const {source,calls}=await adapter(t,(path,body)=>{
      if(path==='/note/search')return {items:[{note_id:body.page_token?noteId:'6ac119d5000000001500fd75',note_url:url}],next_page_token:body.page_token?'':'search-chain-token',points:{cost:10}};
      if(path==='/note/detail')return {...note,note_type:selected.noteType==='video'?'video':'image',comment_count:2};
      if(path==='/note/comment/list')return body.page_token?page([c(2)]):page([c(1)],'comments-chain-token');
      throw new Error('未知接口');
    });
    const bundles=[];for await(const b of source.collect(options({urls:[],keywords:['社区讨论'],maxNotes:1,excludedNoteIds:['6ac119d5000000001500fd75'],...selected}),new AbortController().signal,()=>{}))bundles.push(b);
    const queries=calls.filter(c=>c.path.endsWith('/note/search'));
    assert.equal(queries.length,2);
    assert.deepEqual(queries.map(c=>c.body),['','search-chain-token'].map(page_token=>({keyword:'社区讨论',sort_type:selected.noteSort,publish_time_range:selected.publishTimeRange,note_type:selected.noteType,page_token})));
    const comments=calls.filter(c=>c.path.endsWith('/note/comment/list'));
    assert.deepEqual(comments.map(c=>c.body),['','comments-chain-token'].map(page_token=>({note_id:noteId,sort_type:selected.commentSort,page_token})));
    assert.equal(bundles.length,1);assert.equal(bundles[0].comments.length,2);
    assert.equal(bundles[0].note.coverage.unsupportedMedia,selected.noteType==='video');
  }
});

test('所有公开搜索选项可保存，非法或自造时间范围拒绝；未传本轮选项不覆盖默认',()=>{
  const parsed = startSchema.parse({});
  for (const key of Object.keys(SEARCH_OPTIONS)) assert.equal(parsed[key], undefined);
  for(const [key,option]of Object.entries(SEARCH_OPTIONS)) {
    for(const[value]of option.choices)assert.equal(settingsSchema.parse({...defaultSettings(),[key]:value})[key],value);
    assert.throws(()=>startSchema.parse({[key]:'unsupported'}));
  }
  assert.throws(()=>startSchema.parse({publishTimeRange:'30_days'}));
});

test('默认筛选持久化，单轮覆盖不修改默认；继续任务沿用原筛选，旧任务恢复旧行为',async t=>{
  const r=await root(t),e=await new PatrolEngine(new Store(r),{},{}).init();
  const chosen={noteSort:'comment_count_descending',publishTimeRange:'week',noteType:'image',commentSort:'like_count_descending'};
  await e.settings({...e.store.data.settings,...chosen});
  const restarted=await new Store(r).init();
  for(const[key,value]of Object.entries(chosen))assert.equal(restarted.data.settings[key],value);
  assert.equal(e.options({}).publishTimeRange,'week');
  assert.equal(e.options({publishTimeRange:'day'}).publishTimeRange,'day');
  assert.equal(e.store.data.settings.publishTimeRange,'week');
  await e.start({},'analyze');await e.active.promise;
  const job=e.store.data.jobs.at(-1);job.status='cancelled';
  await e.settings({...e.store.data.settings,...DEFAULT_SEARCH_SETTINGS});
  await e.resume({jobId:job.id});await e.active.promise;
  for(const[key,value]of Object.entries(chosen))assert.equal(e.store.data.jobs.at(-1).options[key],value);
  assert.match(e.store.data.jobs.at(-1).searchSummary,/最多评论.*一周内/);
  job.status='cancelled';for(const key of Object.keys(chosen))delete job.options[key];
  await e.settings({...e.store.data.settings,...chosen});
  await e.resume({jobId:job.id});await e.active.promise;
  for(const[key,value]of Object.entries(DEFAULT_SEARCH_SETTINGS))assert.equal(e.store.data.jobs.at(-1).options[key],value);
});
