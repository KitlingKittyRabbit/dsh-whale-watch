import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEvaluationCases, summarizeEvaluation } from '../src/evaluation.js';
import { PatrolEngine } from '../src/engine.js';
import { Store } from '../src/store.js';

test('评估将失败计入分母，分别显示误报、漏报与未评估', () => {
  const rows = [ { expected: 'normal', analysis: { decision: 'review' } },
    { expected: 'review', analysis: { decision: 'normal' } }, { expected: 'uncertain', error: 'timeout' },
    { expected: 'normal', analysis: { decision: 'normal' } } ];
  const result = summarizeEvaluation(rows, 12);
  assert.equal(result.agreement, .25); assert.equal(result.errors, 1);
  assert.equal(result.unattempted, 8); assert.equal(result.falseAlerts, 1); assert.equal(result.missedReviews, 1);
});
test('评估遵守分析额度，不污染巡查记录；报告保存实际错误', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'patrol-eval-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const engine = await new PatrolEngine(new Store(dir), {}, { selection: () => ({ provider: 'test', model: 'fixture' }),
    async analyze() { calls++; if (calls === 2) throw new Error('model timeout');
      return { decision: 'normal', categories: ['正常讨论'], reason: '测试替身', evidence: [], uncertainties: [] }; }
  }).init();
  await engine.start({ maxAnalysis: 3 }, 'evaluate'); await engine.active.promise;
  assert.equal(calls, 3); assert.equal(engine.store.data.items.length, 0);
  assert.equal(engine.evaluation().complete, false); assert.equal(engine.evaluation().summary.errors, 1);
  assert.equal(engine.evaluation().summary.unattempted, 29); assert.equal(engine.evaluation().rows[1].error, 'model timeout');
});
test('停止评估保留部分报告，不伪称全部完成', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'patrol-eval-stop-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let enter; const started = new Promise(r => { enter = r; });
  const engine = await new PatrolEngine(new Store(dir), {}, { selection: () => ({ provider: 'test', model: 'fixture' }),
    async analyze(item, settings, signal) { enter(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
  }).init();
  await engine.start({}, 'evaluate'); await started; await engine.stop();
  assert.equal(engine.evaluation().complete, false); assert.equal(engine.evaluation().summary.attempted, 0);
  assert.equal(engine.store.data.jobs.at(-1).status, 'cancelled');
});
test('公开样例覆盖正常、复核、缺失语境，编号唯一', async () => {
  const fixture = await loadEvaluationCases();
  assert.equal(fixture.cases.length, 32); assert.equal(new Set(fixture.cases.map(c => c.id )).size, 32);
  assert.deepEqual(new Set(fixture.cases.map(c => c.expected)), new Set(['normal', 'review', 'uncertain']));
});
