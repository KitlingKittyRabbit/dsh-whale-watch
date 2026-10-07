import test from 'node:test';
import assert from 'node:assert/strict';
import { DshModel } from '../src/model.js';
import { defaultSettings } from '../src/store.js';
import { DISCUSSION_TIMEOUT_MS } from '../src/discussion.js';

const records = [{ id: 'note', kind: 'note', text: '正常讨论', coverage: {}, discussion: { complete: true } }];
function model() {
  return new DshModel({ agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'text' }) },
    llm: { async *stream(request) { request.signal.throwIfAborted(); } } });
}

test('整篇初判有独立3分钟时限，超时可理解且不接受半截结果', async t => {
  let requested;
  t.mock.method(AbortSignal, 'timeout', ms => { requested = ms; return AbortSignal.abort(new DOMException('timeout', 'TimeoutError')); });
  await assert.rejects(model().analyzeDiscussion(records, records, defaultSettings(), new AbortController().signal), /超过3分钟.*失败项会单独重试/);
  assert.equal(requested, DISCUSSION_TIMEOUT_MS); assert.equal(requested, 180000);
});

test('用户停止保持用户取消原因，不误报为模型超时', async t => {
  t.mock.method(AbortSignal, 'timeout', () => new AbortController().signal);
  const reason = new Error('用户停止任务');
  await assert.rejects(model().analyzeDiscussion(records, records, defaultSettings(), AbortSignal.abort(reason)), error => error === reason);
});
