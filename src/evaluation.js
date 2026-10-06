import { readFile } from 'node:fs/promises';
import { hash } from './store.js';

export async function loadEvaluationCases() {
  return JSON.parse(await readFile(new URL('../evaluation/cases.zh.json', import.meta.url), 'utf8'));
}
export function evaluationItem(sample) {
  // Labels and expected decisions belong in the report, never in the model's surrounding note title.
  const item = { kind: sample.kind || 'comment', title: sample.noteTitle || sample.title || '构造语境样例（未提供真实标题）', text: sample.text, context: sample.context || '',
    coverage: { source: 'synthetic-evaluation', imagesUnread: false, parentMissing: false, textTruncated: false, ...sample.coverage } };
  item.contentHash = hash(JSON.stringify(item));
  return item;
}
export function summarizeEvaluation(rows, total) {
  const decisions = ['normal', 'review', 'uncertain'];
  const matrix = Object.fromEntries(decisions.map(d => [d, Object.fromEntries([...decisions, 'error'].map(p => [p, 0]))]));
  let agreed = 0, errors = 0;
  for (const row of rows) {
    const actual = row.error ? 'error' : row.analysis.decision;
    matrix[row.expected][actual]++;
    if (actual === row.expected) agreed++;
    if (actual === 'error') errors++;
  }
  return { total, attempted: rows.length, agreed, errors, unattempted: total - rows.length,
    agreement: rows.length ? agreed / rows.length : null,
    falseAlerts: matrix.normal.review, missedReviews: matrix.review.normal, matrix };
}
