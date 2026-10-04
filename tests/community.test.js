import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, defaultSettings } from '../src/store.js';
import { PatrolEngine } from '../src/engine.js';
import { DshModel } from '../src/model.js';
import { backgroundInput } from '../src/background.js';
import { createCommunityBackground } from '../src/community-background.js';
import { GROUP_RESPECT_GUIDE } from '../src/rules.js';
import { parseAnalysis } from '../src/schema.js';

for (const verdict of ['supported', 'unsupported']) {
  test(`群体不尊重两轮标准一致，兼容旧标签，核对结论${verdict}被保留`, async () => {
    const text = '鄙视画师是正常的';
    const item = { kind: 'comment', text, title: '没有产粮的必要', context: '上级评论：别管了，再怎么管鄙视链依旧存在', coverage: {} };
    const finding = { category: '群体敌意', quote: text, target: '画师群体', behavior: '认可鄙视整个群体' };
    const first = { targetQuote: text, interpretation: '作者认可对画师群体的鄙视', decision: 'review', categories: ['群体敌意'], reason: '认可群体贬损', evidence: [text], findings: [finding], uncertainties: [], confidence: .8 };
    const calls = [];
    const settings = { ...defaultSettings(), backgroundContext: createCommunityBackground([]) };
    const model = new DshModel({ agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'text' }) }, llm: {
      stream: options => (async function* () {
        calls.push(options);
        const value = calls.length === 1 ? first : { verdict, reason: '测试核对返回值', findings: verdict === 'supported' ? [finding] : [] };
        yield { type: 'text-delta', index: 0, text: JSON.stringify(value) }; yield { type: 'finish', reason: { kind: 'stop' } };
      })()
    } });
    const out = await model.analyze(item, settings);
    assert.equal(out.decision, verdict === 'supported' ? 'review' : 'normal');
    assert.deepEqual(out.verification.proposedCategories, ['群体不尊重或地图炮']);
    assert.deepEqual(out.categories, verdict === 'supported' ? ['群体不尊重或地图炮'] : ['正常讨论']);
    for (const call of calls) { assert.ok(call.system.includes(GROUP_RESPECT_GUIDE)); assert.ok(call.system.includes(settings.rules)); }
    const [initial, check] = calls.map(call => JSON.parse(call.messages[0].content[0].text));
    assert.deepEqual(check.target, initial.target); assert.deepEqual(check.background, initial.background);
    assert.equal(check.background.context, item.context); assert.equal(check.background.environment.catalog.length, 36);
  });
}

test('旧群体标签兼容不放宽引文归属检查', () => {
  const result = { targetQuote: '好', interpretation: '回应', decision: 'review', categories: ['群体敌意'], reason: '测试', evidence: ['上级说的话'], findings: [{ category: '群体敌意', quote: '上级说的话', target: '画师群体', behavior: '测试' }], uncertainties: [], confidence: .8 };
  assert.throws(() => parseAnalysis(JSON.stringify(result), { kind: 'comment', text: '好', context: '上级说的话' }), /不符/);
});

for (const category of ['普通创作区引战', '牵连无关角色或圈子']) {
  test(`${category}经过分析及二次核对后可保留，不会被旧五类白名单丢弃`, async () => {
    const text = category === '普通创作区引战' ? '你先表态支持哪边，再把另一边切割掉。' : '结城理也该一起被踩。';
    const finding = { category, quote: text, target: category === '普通创作区引战' ? '普通同框作品作者及创作评论区' : '结城理', behavior: '明确表达的侵扰行为' };
    const item = { kind: 'comment', text, title: '普通创作', context: '作者展示双人创作，没有邀请争议。', coverage: {} };
    const first = { targetQuote: text, interpretation: '解释目标评论自己的主张', decision: 'review', categories: [category], reason: '按社区规则检查', evidence: [text], findings: [finding], uncertainties: [], confidence: .8 };
    const calls = [];
    const settings = { ...defaultSettings(), rules: defaultSettings().rules + '\n补充：对普通创作区采用相同标准。' };
    const model = new DshModel({ agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'text' }) }, llm: {
      stream: options => (async function* () {
        calls.push(options); const isCheck = options.messages[0].source.kind === 'dafeiyu-patrol-evidence-check';
        const value = isCheck ? { verdict: 'supported', reason: '依据与场景对应', findings: [finding] } : first;
        yield { type: 'text-delta', index: 0, text: JSON.stringify(value) }; yield { type: 'finish', reason: { kind: 'stop' } };
      })()
    } });
    const out = await model.analyze(item, settings);
    assert.equal(out.decision, 'review'); assert.deepEqual(out.categories, [category]); assert.equal(calls.length, 2);
    assert.ok(calls[1].system.includes(settings.rules));
  });
}

test('扩大阅读背景接入模型输入，能关联本机原文，缺失原文不冒充已采集', () => {
  const sourceKey = 'note:6abe770c00000000150116a6';
  const note = { id: 'local-note', kind: 'note', sourceKey, title: '没有产粮的必要', text: '真实采集的正文', coverage: { imageCount: 1 }, contentHash: 'local-hash' };
  const profile = createCommunityBackground([note]);
  assert.equal(profile.origin, 'curated-review'); assert.equal(profile.readings.length, 36);
  assert.equal(profile.readings.reduce((n, r) => n + r.commentsRead, 0), 533);
  const reading = profile.readings.find(r => r.sourceKey === sourceKey);
  assert.ok(reading.parts.some(p => p.label === '正文' && p.text === note.text));
  assert.equal(reading.coverage.imageTextUnavailable, true);
  const input = backgroundInput({ text: '同框产粮', sourceKey: 'comment:6abe770c00000000150116a6:test' }, profile);
  assert.equal(input.references[0].ref, reading.ref); assert.equal(input.catalog.length, 36);
  assert.ok(input.memo.includes('发归途')); assert.equal(profile.readings.find(r => r.ref === 'B1').coverage.localOriginalAvailable, false);
});

test('启用整理背景保留旧背景与记录，重启持久化；不发起模型或自动重新分析', async t => {
  const root = await mkdtemp(join(tmpdir(), 'whale-community-')); t.after(() => rm(root, { recursive: true, force: true }));
  const model = { analyze() { throw new Error('不得自动分析'); } };
  const engine = await new PatrolEngine(new Store(root), {}, model).init();
  const item = await engine.store.upsert({ kind: 'note', title: '原文', text: '保留', context: '' });
  const previous = { id: 'old', createdAt: 'old', readings: [], memo: '旧背景' };
  engine.store.data.background.active = previous; engine.store.data.background.draft = previous;
  const originals = structuredClone(engine.store.data.items);
  await engine.useCommunityBackground();
  assert.deepEqual(engine.store.data.items, originals); assert.equal(engine.store.data.background.history.at(-1).id, 'old');
  assert.equal(engine.store.data.background.draft, null); assert.equal(engine.store.data.jobs.length, 0);
  assert.equal(engine.analysisSettings(defaultSettings()).backgroundContext.readings.length, 36);
  const restarted = await new Store(root).init(); assert.equal(restarted.data.background.active.hash, engine.store.data.background.active.hash);
  engine.active = {}; await assert.rejects(engine.useCommunityBackground(), /任务进行中/);
});
