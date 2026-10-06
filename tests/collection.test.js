import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, defaultSettings } from '../src/store.js';
import { PatrolEngine } from '../src/engine.js';
import { DisabledBrowser } from '../src/disabled-browser.js';
const n = '0123456789abcdef01234567';
const record = (id = n, text = '原文') => ({ kind: 'note', sourceKey: `note:${id}`, title: '测试', text, coverage: { source: 'socialdatax' }, discussion: { complete: true, sourceKeys: [] } });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'patrol-clear-')); t.after(() => rm(dir, { recursive: true, force: true }));
  return new PatrolEngine(new Store(dir), new DisabledBrowser(), {}).init();
}
test('清空采集及巡查任务、已查缓存，保留模型规则背景和评估；重启可恢复原文、判断及已阅', async t => {
  const e = await fixture(t), item = await e.store.upsert(record());
  item.analysis = { decision: 'normal' }; item.readAt = '已阅'; item.history = [{ text: '旧文' }];
  e.store.data.jobs = [{ id: 'scan', mode: 'scan' }, { id: 'background', mode: 'background' }, { id: 'analysis', mode: 'analyze' }];
  e.store.data.background.active = { id: 'b', memo: '背景', readings: [{ text: '已读资料' }] }; e.store.data.evaluation = { rows: ['样例'] };
  const original = structuredClone(e.store.data), answer = await e.clearCollection();
  assert.equal(answer.cleared, 1); assert.equal(e.state().counts.total, 0); assert.equal(e.state().collection.canRestore, true);
  assert.deepEqual(e.store.data.settings, original.settings); assert.deepEqual(e.store.data.background, original.background);
  assert.deepEqual(e.store.data.evaluation, original.evaluation); assert.deepEqual(e.store.data.jobs.map(j => j.id), ['background']);
  assert.deepEqual(e.store.data.seenCache.ids, []);
  const restarted = await new PatrolEngine(new Store(e.store.root), new DisabledBrowser(), {}).init();
  await restarted.restoreCollection();
  assert.deepEqual(restarted.store.data.items, original.items); assert.equal(restarted.store.data.items[0].readAt, '已阅');
  assert.deepEqual(new Set(restarted.store.data.jobs.map(j => j.id)), new Set(original.jobs.map(j => j.id)));
  assert.deepEqual(restarted.store.data.seenCache.ids, original.seenCache.ids);
  assert.equal(restarted.state().collection.canRestore, false);
});
test('重复清空空记录不丢撤销机会；恢复保留新采集与新判断，不覆盖同编号新原文', async t => {
  const e = await fixture(t); await e.store.upsert(record()); await e.store.upsert(record('1123456789abcdef01234567', '第二篇'));
  await e.clearCollection(); const clearedAt = e.store.data.collectionTrash.clearedAt;
  await e.clearCollection(); assert.equal(e.store.data.collectionTrash.clearedAt, clearedAt);
  const fresh = await e.store.upsert(record(n, '修改后的原文')); fresh.analysis = { decision: 'review' };
  await e.store.upsert(record('2123456789abcdef01234567', '第三篇'));
  await e.restoreCollection(); assert.equal(e.store.data.items.length, 3);
  assert.equal(e.store.data.items.find(i => i.id === fresh.id).text, '修改后的原文'); assert.equal(fresh.analysis.decision, 'review');
  assert.equal(e.store.data.seenCache.ids.length, 3);
});
test('本机写入失败时清空和恢复均回滚，旧文件及撤销备份不被丢弃', async t => {
  const e = await fixture(t); await e.store.upsert(record()); const save = e.store.save.bind(e.store);
  const before = JSON.stringify(e.store.data), file = await readFile(e.store.path, 'utf8');
  e.store.save = async () => { throw new Error('磁盘错误'); };
  await assert.rejects(e.clearCollection(), /磁盘错误/); assert.equal(JSON.stringify(e.store.data), before); assert.equal(await readFile(e.store.path, 'utf8'), file);
  e.store.save = save; await e.clearCollection(); const cleared = JSON.stringify(e.store.data);
  e.store.save = async () => { throw new Error('磁盘错误'); };
  await assert.rejects(e.restoreCollection(), /磁盘错误/); assert.equal(JSON.stringify(e.store.data), cleared);
});
test('运行中不允许清空及撤销；没有清空备份时不能恢复', async t => {
  const e = await fixture(t); e.active = { job: { id: 'busy' } };
  await assert.rejects(e.clearCollection(), /任务进行中/); await assert.rejects(e.restoreCollection(), /任务进行中/);
  e.active = null; await assert.rejects(e.restoreCollection(), /没有可撤销/);
});
test('升级浏览器配置为API，扫描/背景刷新/旧采集任务不能绕过停用，离线已有材料可以分析', async t => {
  const e = await fixture(t); e.store.data.settings.collectionSource = 'browser'; await e.store.save();
  const restarted = await new Store(e.store.root).init(); assert.equal(restarted.data.settings.collectionSource, 'socialdatax');
  let browsed = 0, api = 0;
  e.browser = { context: {}, async *collect() { browsed++; }, close: async () => {} };
  e.apiCollector = { hasKey: true, async *collect() { api++; } };
  await assert.rejects(e.start({ collectionSource: 'browser' }), /浏览器采集已停用/);
  await assert.rejects(e.settings({ ...defaultSettings(), collectionSource: 'browser' }), /浏览器采集已停用/);
  await assert.rejects(async () => { for await (const r of e.collectRecords({ collectionSource: 'browser' })) {} }, /浏览器采集已停用/);
  await assert.rejects(e.start({ collectionSource: 'browser' }, 'background', { source: 'existing', refreshSources: true, urls: ['x'] }), /浏览器采集已停用/);
  e.store.data.jobs.push({ id: 'legacy', mode: 'scan', status: 'paused', options: { collectionSource: 'browser' } });
  await assert.rejects(e.resume({ jobId: 'legacy' }), /浏览器采集已停用/);
  assert.equal(browsed, 0); assert.equal(api, 0); assert.equal(e.state().browserEnabled, false);
  const item = await e.store.upsert({ kind: 'comment', text: '手动导入', coverage: {} }); e.model = { cacheKey: () => 'key', analyze: async () => ({ decision: 'normal' }) };
  await e.start({ collectionSource: 'browser' }, 'analyze'); await e.active.promise;
  assert.equal(item.analysis.decision, 'normal'); assert.equal(browsed, 0); assert.equal(api, 0);
});
test('禁用适配器不提供自动登录、导航或采集', async () => {
  const browser = new DisabledBrowser();
  await assert.rejects(browser.login(), /已停用/); await assert.rejects(browser.openNote('x'), /已停用/);
  await assert.rejects(async () => { for await (const item of browser.collect()) {} }, /已停用/);
  await browser.close(); assert.equal(browser.context, null);
});
