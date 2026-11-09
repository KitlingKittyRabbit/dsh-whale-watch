import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocialDataX } from '../src/socialdatax.js';
import { PatrolEngine } from '../src/engine.js';
import { Store, defaultSettings } from '../src/store.js';
import { settingsSchema, startSchema } from '../src/schema.js';
import { matchesKeywords, matchesUserFilters, userReference } from '../src/user-search.js';

const uid = '111111111111111111111111', other = '222222222222222222222222';
const nid = n => n.toString(16).padStart(24, '0');
const profile = id => `https://www.xiaohongshu.com/user/profile/${id}?xsec_token=fixture&xsec_source=app_share`;
const note = (n, text = '普通正文', userId = uid) => ({ note_id: nid(n), note_url: `https://www.xiaohongshu.com/explore/${nid(n)}`,
  title: `笔记${n}`, content: text, note_type: 'image', publish_time: Math.floor(Date.now() / 1000), author: { user_id: userId, name: '作者' },
  image_items: [], comment_count: 0, points: { cost: 10 } });
const page = (items, token = '') => ({ items, next_page_token: token, points: { cost: 10 } });
const opts = extra => ({ ...defaultSettings(), urls: [], keywords: [], users: [], excludedNoteIds: [], ...extra });
async function fixture(t, reply) {
  const root = await mkdtemp(join(tmpdir(), 'whale-users-')); t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], events = [];
  const api = await new SocialDataX(root, null, async (address, input) => {
    assert.equal(new URL(address).origin, 'https://mcp.socialdatax.com');
    assert.equal(input.headers.Authorization, 'Bearer fixture-only');
    const path = new URL(address).pathname.replace('/socialdatax/api/v1/xhs', ''), body = JSON.parse(input.body);
    calls.push({ path, body });
    return Response.json(await reply(path, body, calls));
  }).init();
  await api.setKey('fixture-only');
  const collect = async extra => {
    const bundles = [];
    for await (const value of api.collect(opts(extra), new AbortController().signal, event => events.push(event))) bundles.push(value);
    return bundles;
  };
  return { root, api, calls, events, collect };
}

test('指定用户身份只接受公开主页或用户ID，拒绝昵称、笔记链接及伪装域名', () => {
  const alphaId = 'abcdefabcdefabcdefabcdef';
  assert.equal(userReference(alphaId.toUpperCase()).userId, alphaId);
  assert.deepEqual(userReference(profile(uid)).params, { profile_url: profile(uid) });
  assert.deepEqual(settingsSchema.parse({ ...defaultSettings(), users: [profile(uid)], keywords: [] }).keywords, []);
  for (const bad of ['用户名', 'red_id', 'https://xiaohongshu.com.evil.test/user/profile/' + uid,
    `http://www.xiaohongshu.com/user/profile/${uid}`, `https://name:pass@www.xiaohongshu.com/user/profile/${uid}`,
    `https://www.xiaohongshu.com/explore/${uid}`, `https://www.xiaohongshu.com:443/user/profile/${uid}#bad`]) {
    assert.throws(() => startSchema.parse({ users: [bad] }), /主页链接|用户 ID/);
  }
  assert.throws(() => startSchema.parse({ users: Array(6).fill(uid) }));
  assert.throws(() => startSchema.parse({ userKeywordMode: 'xor' }));
});

test('用户分页原样保留主页参数与令牌，空页仍续页，同一用户的ID和主页入口合并去重', async t => {
  const a = note(1), f = await fixture(t, (path, body) => {
    if (path === '/user/note/list') return body.page_token ? page([a]) : page([], 'user-chain-token');
    if (path === '/note/detail') return a;
    if (path === '/note/comment/list') return page([]);
    throw new Error(path);
  });
  const result = await f.collect({ users: [profile(uid), uid], maxNotes: 1 });
  assert.equal(result.length, 1); assert.equal(result[0].note.authorId, uid);
  assert.deepEqual(f.calls.filter(c => c.path === '/user/note/list').map(c => c.body), ['', 'user-chain-token'].map(page_token => ({ profile_url: profile(uid), page_token })));
  assert.ok(!f.calls.some(c => c.path === '/note/search' || c.path === '/user/info'));
});

test('加密主页先解析真实用户ID，再限定作者；解析同样计入本轮费用', async t => {
  const link = profile('encrypted_profile_identity'), a = note(1);
  const f = await fixture(t, path => path === '/user/info' ? { user_id: uid, points: { cost: 10 } } : path === '/user/note/list' ? page([a]) : path === '/note/detail' ? a : page([]));
  const result = await f.collect({ users: [link], maxNotes: 1 });
  assert.equal(result.length, 1);
  assert.deepEqual(f.calls[0], { path: '/user/info', body: { profile_url: link } });
  assert.deepEqual(f.calls[1].body, { user_id: uid, page_token: '' });
  assert.equal(f.events.filter(e => e.type === 'api').at(-1).costCents, 40);
});

test('且模式逐篇读取全文后筛选任一关键词，不以摘要漏掉正文命中，不抓未命中笔记的评论', async t => {
  const notes = [note(1, '无关正文'), note(2, '后文包含 ＤＥＥＰＳＥＥＫ 的讨论'), note(3, '也无关')];
  notes[2].comment_count = 1;
  const f = await fixture(t, (path, body) => {
    if (path === '/user/note/list') return page(notes.map(n => ({ ...n, summary: '摘要没有关键词' })));
    if (path === '/note/detail') return notes.find(n => n.note_id === body.note_id);
    if (path === '/note/comment/list') { assert.equal(body.note_id, nid(2)); return page([]); }
    throw new Error(path);
  });
  const result = await f.collect({ users: [uid], keywords: ['不存在的词', 'deepseek'], userKeywordMode: 'and' });
  assert.deepEqual(result.map(b => b.note.discussionNoteId), [nid(2)]);
  assert.equal(f.events.filter(e => e.type === 'filtered').length, 2);
  assert.equal(f.calls.filter(c => c.path === '/note/detail').length, 3);
  assert.ok(!f.calls.some(c => c.path === '/note/search'));
  assert.equal(matchesKeywords({ title: '深蓝', content: '正文' }, ['深蓝']), true);
});

test('或模式交替选择用户与关键词候选、跨来源去重；同一个用户的非关键词笔记仍保留', async t => {
  const notes = [note(1), note(2, '关键词结果', other), note(3)];
  const f = await fixture(t, (path, body) => {
    if (path === '/user/note/list') return page([notes[0], notes[2]]);
    if (path === '/note/search') return page([notes[0], notes[1]]);
    if (path === '/note/detail') return notes.find(n => n.note_id === body.note_id);
    if (path === '/note/comment/list') return page([]);
    throw new Error(path);
  });
  const result = await f.collect({ users: [uid], keywords: ['关键词'], userKeywordMode: 'or', maxNotes: 3 });
  assert.deepEqual(result.map(b => b.note.discussionNoteId), [nid(1), nid(2), nid(3)]);
  assert.equal(f.calls.filter(c => c.path === '/note/detail').length, 3);
  assert.equal(new Set(result.map(b => b.note.sourceKey)).size, 3);
  assert.deepEqual((await f.collect({ users: [uid], keywords: ['关键词'], userKeywordMode: 'or', maxNotes: 2 })).map(b => b.note.discussionNoteId), [nid(1), nid(2)]);
});

test('或模式不会被用户列表占满名额，多个用户也轮换读取', async t => {
  const a = note(1), b = note(2, '第二个用户', other), k = note(3, '关键词', other);
  const f = await fixture(t, (path, body) => path === '/user/note/list' ? page([body.user_id === uid ? a : b]) : path === '/note/search' ? page([k]) : path === '/note/detail' ? [a, b, k].find(n => n.note_id === body.note_id) : page([]));
  const result = await f.collect({ users: [uid, other], keywords: ['关键词'], userKeywordMode: 'or', maxNotes: 3 });
  assert.deepEqual(result.map(b => b.note.discussionNoteId), [nid(1), nid(3), nid(2)]);
  assert.equal(f.calls.filter(c => c.path === '/note/search').length, 1);
});

test('用户笔记逐条筛选时间和类型，不因旧置顶笔记停止读取后续新笔记', async t => {
  const old = { ...note(1), is_pinned: true, publish_time: 1 }, video = { ...note(2), note_type: 'video' }, fresh = note(3);
  const f = await fixture(t, (path, body) => path === '/user/note/list' ? body.page_token ? page([fresh]) : page([old, video], 'next-user-page') : path === '/note/detail' ? fresh : page([]));
  const result = await f.collect({ users: [uid], noteType: 'image', publishTimeRange: 'week', maxNotes: 1 });
  assert.deepEqual(result.map(b => b.note.discussionNoteId), [nid(3)]);
  assert.equal(f.calls.filter(c => c.path === '/note/detail').length, 1);
  assert.equal(f.events.filter(e => e.type === 'filtered').length, 2);
  assert.equal(matchesUserFilters({ note_type: 'image', publish_time: 0 }, { noteType: 'all', publishTimeRange: 'week' }), false);
});

test('费用在筛选阶段耗尽时不抓评论、不调用模型，不把未查完显示成零结果完成', async t => {
  const a = note(1), b = note(2);
  const f = await fixture(t, (path, body) => path === '/user/note/list' ? page([a, b]) : path === '/note/detail' ? a : assert.fail(path));
  const engine = await new PatrolEngine(new Store(f.root), {}, { cacheKey() { throw new Error('不应调用模型'); } }, f.api).init();
  await engine.start({ users: [uid], keywords: ['不命中'], apiBudgetYuan: .2, analyze: false }); await engine.active.promise;
  const job = engine.store.data.jobs.at(-1);
  assert.equal(job.apiRequests, 2); assert.equal(job.apiCostCents, 20);
  assert.equal(job.status, 'partial'); assert.equal(job.notesFiltered, 1);
  assert.match(job.apiStopReason, /费用上限/); assert.equal(engine.store.data.items.length, 0);
  assert.equal(f.calls.length, 2);
});

test('用户列表和详情都严格核对作者，不能把其他人的笔记当成目标用户', async t => {
  for (const badList of [true, false]) {
    const a = note(1, '关键词'), wrong = note(1, '关键词', other);
    const f = await fixture(t, path => path === '/user/note/list' ? page([badList ? wrong : a]) : path === '/note/detail' ? wrong : assert.fail(path));
    await assert.rejects(f.collect({ users: [uid] }), /作者与指定用户不符/);
  }
});

test('分页保护范围显示部分完成；已查结果不再抓正文；正常无匹配不是采集错误', async t => {
  const a = note(1);
  const f = await fixture(t, (_path, _body, calls) => page([a], `page-${calls.length}`));
  const engine = await new PatrolEngine(new Store(f.root), {}, {}, f.api).init();
  await engine.store.upsert({ kind: 'note', sourceKey: `note:${nid(1)}`, text: '已保存', coverage: { source: 'socialdatax' }, discussion: { complete: true } });
  await engine.start({ users: [uid], analyze: false }); await engine.active.promise;
  const job = engine.store.data.jobs.at(-1);
  assert.equal(job.status, 'partial'); assert.equal(job.notesExcluded, 1); assert.equal(job.apiRequests, 5);
  assert.match(job.searchLimits[0], /5页/); assert.ok(f.calls.every(c => c.path === '/user/note/list'));
  const empty = await fixture(t, () => page([]));
  const e = await new PatrolEngine(new Store(empty.root), {}, {}, empty.api).init();
  await e.start({ users: [uid], analyze: false }); await e.active.promise;
  assert.equal(e.store.data.jobs.at(-1).status, 'completed');
});

test('指定用户可保存为默认；显式单轮用户不混入默认关键词；继续保留原范围而非当前设置', async t => {
  const a = note(1), k = note(2, '原关键词', other);
  const f = await fixture(t, (path, body) => path === '/user/note/list' ? (assert.equal(body.user_id, uid), page([a])) : path === '/note/search' ? (assert.equal(body.keyword, '原关键词'), page([k])) : path === '/note/detail' ? [a, k].find(n => n.note_id === body.note_id) : page([]));
  const e = await new PatrolEngine(new Store(f.root), {}, {}, f.api).init();
  assert.deepEqual(e.options({ users: [uid] }).keywords, []);
  await e.settings({ ...defaultSettings(), users: [other], keywords: [] });
  assert.deepEqual((await new Store(f.root).init()).data.settings.users, [other]);
  assert.deepEqual(e.options({ keywords: ['新词'] }).users, []);
  assert.deepEqual(e.options({ urls: [a.note_url] }).users, []);
  assert.throws(() => e.options({ users: [uid], urls: [a.note_url] }), /不能同时使用/);
  await assert.rejects(e.start({ users: [], keywords: [] }), /至少填写/);
  e.store.data.jobs.push({ id: 'stopped-user-job', status: 'interrupted', mode: 'scan', options: opts({ users: [uid], keywords: ['原关键词'], userKeywordMode: 'or', analyze: false, maxNotes: 2 }) });
  await e.resume({ jobId: 'stopped-user-job' }); await e.active.promise;
  const resumed = e.store.data.jobs.at(-1);
  assert.deepEqual(resumed.options.users, [uid]); assert.deepEqual(resumed.options.keywords, ['原关键词']);
  assert.equal(resumed.options.userKeywordMode, 'or'); assert.equal(resumed.status, 'completed');
  assert.equal(resumed.notesRead, 2); assert.equal(resumed.analyzed, 0);
});

test('停止的指定用户巡查继续剩余采集，只分析本轮篇目，不串入其它未阅或超过原篇数上限', async t => {
  const root = await mkdtemp(join(tmpdir(), 'whale-user-resume-')); t.after(() => rm(root, { recursive: true, force: true }));
  const record = n => ({ kind: 'note', sourceKey: `note:${nid(n)}`, discussionNoteId: nid(n), title: 'DeepSeek', text: `原文${n}`, author: '模拟作者', coverage: { source: 'socialdatax' }, discussion: { complete: true, sourceKeys: [] } });
  let round = 0, reached;
  const waiting = new Promise(resolve => { reached = resolve; }), selections = [], analyzed = [];
  const api = { hasKey: true, init: async () => {}, async *collect(options, signal) {
    selections.push(options); round++;
    if (round === 1) {
      yield { note: record(1), comments: [] };
      reached(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      signal.throwIfAborted();
    } else {
      assert.equal(options.maxNotes, 1); assert.ok(options.excludedNoteIds.includes(nid(1)));
      yield { note: record(2), comments: [] };
    }
  } };
  const model = { cacheKey: item => item.contentHash, analyzeDiscussion: async (_records, targets) => {
    analyzed.push(...targets.map(i => i.sourceKey));
    return targets.map(i => ({ id: i.id, analysis: { decision: 'normal', categories: ['正常讨论'], reason: '构造结果', evidence: [], uncertainties: [], confidence: 1 } }));
  } };
  const e = await new PatrolEngine(new Store(root), {}, model, api).init();
  const outside = await e.store.upsert(record(99));
  const first = await e.start({ users: [uid], keywords: ['DeepSeek'], userKeywordMode: 'and', maxNotes: 2, discussionNoteLimit: 1, excludeSeen: false, readImages: false });
  await waiting; await e.stop();
  assert.equal(e.store.data.jobs.at(-1).status, 'cancelled');
  await e.resume({ jobId: first.jobId }); await e.active.promise;
  assert.equal(selections.length, 2); assert.deepEqual(selections[1].users, [uid]);
  const deferred = e.store.data.jobs.at(-1);
  assert.equal(deferred.analysisDeferred, true); assert.equal(analyzed.length, 1);
  await e.resume({ jobId: deferred.id }); await e.active.promise;
  assert.equal(selections.length, 2, '采集已完成时只继续本轮剩余分析，不重复采集');
  assert.deepEqual(new Set(analyzed), new Set([`note:${nid(1)}`, `note:${nid(2)}`]));
  assert.equal(outside.analysis, null); assert.equal(e.store.data.items.length, 3);
});
