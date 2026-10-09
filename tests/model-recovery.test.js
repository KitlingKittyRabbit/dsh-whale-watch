import test from 'node:test';
import assert from 'node:assert/strict';
import { DshModel } from '../src/model.js';
import { defaultSettings } from '../src/store.js';

const item = { id: 'comment', kind: 'comment', text: '原始短评', title: '所属笔记', coverage: {} };
const note = { id: 'note', kind: 'note', title: '讨论', text: '另一位作者的文字', coverage: {}, discussion: { complete: true } };
const good = { targetQuote: item.text, interpretation: '解释当前短评', decision: 'normal', categories: ['正常讨论'], reason: '正常表达', evidence: [], findings: [], uncertainties: [], confidence: .8 };
const bad = { ...good, evidence: [note.text] };
const finding = { category: '人身攻击', quote: item.text, target: '回复对象', behavior: '测试模型提出的行为' };
function model(reply) {
  return new DshModel({ agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'test' }) }, llm: { stream: request => (async function* () {
    const response = reply(request);
    yield { type: 'text-delta', index: 0, text: JSON.stringify(response.value) };
    yield { type: 'finish', reason: { kind: response.finish || 'stop', ...(response.failure ? { failure: response.failure } : {}) } };
  })() } });
}

test('整篇目标单列自己的原文，串用引文最多修复一次，修复使用完整讨论', async () => {
  const requests = []; let repairs = 0;
  const m = model(request => { requests.push(request); return { value: requests.length === 1 ? { results: [{ id: item.id, analysis: bad }] } : good }; });
  const rows = await m.analyzeDiscussion([note, item], [item], defaultSettings(), new AbortController().signal, { onRepair: () => repairs++ });
  assert.equal(rows[0].analysis.decision, 'normal'); assert.equal(repairs, 1); assert.equal(requests.length, 2);
  assert.equal(JSON.parse(requests[0].messages[0].content[0].text).targets[0].text, item.text);
  const retry = JSON.parse(requests[1].messages[0].content[0].text);
  assert.equal(retry.target.text, item.text); assert.equal(retry.background.discussion.note.text, note.text);
  assert.ok(rows[0].analysis.quoteRepair);
});

test('二次引文仍不实必须失败，不降级成其它，不循环付费', async () => {
  let calls = 0;
  const m = model(() => ({ value: ++calls === 1 ? { results: [{ id: item.id, analysis: bad }] } : bad }));
  const rows = await m.analyzeDiscussion([note, item], [item], defaultSettings(), new AbortController().signal);
  assert.equal(calls, 2); assert.equal(rows[0].analysis, undefined); assert.match(rows[0].error, /引文与原文不符/);
});

test('修复后提出的指控仍须证据核对，核对有独立三分钟和32768额度', async t => {
  const timeouts = [], calls = [];
  t.mock.method(AbortSignal, 'timeout', ms => { timeouts.push(ms); return new AbortController().signal; });
  const reviewed = { ...good, decision: 'review', categories: ['人身攻击'], evidence: [item.text], findings: [finding] };
  const m = model(request => {
    calls.push(request);
    if (calls.length === 1) return { value: { results: [{ id: item.id, analysis: bad }] } };
    if (calls.length === 2) return { value: reviewed };
    return { value: { verdict: 'unsupported', reason: '测试核对否决初判', findings: [] } };
  });
  const rows = await m.analyzeDiscussion([note, item], [item], defaultSettings(), new AbortController().signal);
  assert.equal(rows[0].analysis.decision, 'normal'); assert.equal(calls.length, 3);
  assert.deepEqual(timeouts, [180000, 180000, 180000]); assert.equal(calls[2].maxTokens, 32768);
  assert.equal(calls[2].messages[0].source.kind, 'dafeiyu-patrol-evidence-check');
});

test('截断的引文修复和证据核对均不采纳，不继续加额度重试', async () => {
  for (const stage of ['repair', 'check']) {
    let calls = 0;
    const reviewed = { ...good, decision: 'review', categories: ['人身攻击'], evidence: [item.text], findings: [finding] };
    const m = model(() => ++calls === 1 ? { value: { results: [{ id: item.id, analysis: stage === 'repair' ? bad : reviewed }] } } : { value: {}, finish: 'max-tokens' });
    const rows = await m.analyzeDiscussion([note, item], [item], defaultSettings(), new AbortController().signal);
    assert.equal(calls, 2); assert.equal(rows[0].analysis, undefined); assert.match(rows[0].error, /未完成：max-tokens/);
  }
});

test('批内短编号严格映射回原目标，不能把平台ID或重复别名悄悄认作另一条', async () => {
  let answer = { results: [{ id: 'T1', analysis: good }] };
  const m = model(request => {
    const input = JSON.parse(request.messages[0].content[0].text);
    assert.equal(input.targets[0].outputId,'T1'); assert.equal(input.targets[0].id,item.id);
    return { value: answer };
  });
  assert.equal((await m.analyzeDiscussion([note,item],[item],defaultSettings()))[0].id,item.id);
  answer = { results: [{ id:'T1',analysis:good },{ id:item.id,analysis:good }] };
  await assert.rejects(m.analyzeDiscussion([note,item],[item],defaultSettings()),/未知或重复目标/);
  answer = { results: [{ id:'platform-comment-id',analysis:good }] };
  await assert.rejects(m.analyzeDiscussion([note,item],[item],defaultSettings()),/未知或重复目标/);
});

test('模型服务失败保留错误码和HTTP状态，不暴露服务原始响应', async () => {
  const m = model(() => ({ value: {}, finish: 'error', failure: { code: 'RATE_LIMITED', status: 429, message: 'secret upstream response' } }));
  for (const run of [() => m.analyzeDiscussion([note,item],[item],defaultSettings()), () => m.analyze(item,defaultSettings())]) {
    await assert.rejects(run(), error => /RATE_LIMITED，HTTP 429/.test(error.message) && !error.message.includes('secret'));
  }
  const unsafe = model(() => ({ value: {}, finish: 'error', failure: { code: 'token=secret', status: 600, message: 'secret' } }));
  await assert.rejects(unsafe.analyzeDiscussion([note,item],[item],defaultSettings()), error => /未正常完成：error，/.test(error.message) && !error.message.includes('secret'));
});
