import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { extractNote, findBrowserExecutable } from '../src/browser.js';

test('浏览器提取保留回复上下文，避免把子回复并入上级原文', async t => {
  const browser = await chromium.launch({ executablePath: await findBrowserExecutable(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://**', route => route.abort());
  await page.setContent(`<div class="note-container"><div id="detail-title">测试笔记</div><div id="detail-desc">讨论作品</div><div class="swiper-slide" data-swiper-slide-index="0"><img src="https://fe-platform.xhscdn.com/platform/loading-logo" width="48" height="48"><img src="https://sns.xhscdn.com/real-picture" width="50" height="50" alt="图片"></div>
  <div class="comment-item" id="c1"><div class="author"><span class="name">甲</span></div><div class="content"><span class="note-text">去骚扰她</span></div>
  <div class="replies"><div class="comment-item" id="c2"><div class="author"><span class="name">乙</span></div><div class="content"><span class="note-text">我反对骚扰</span></div></div></div></div></div>`);
  // location.href is a local test page; a browser test passes a deterministic note URL.
  const data = await page.evaluate(({ source }) => {
    const extract = (0, eval)(`(${source})`);
    return extract(document, 'https://www.xiaohongshu.com/explore/6ac119d5000000001500fd74', 10);
  }, { source: extractNote.toString() });
  assert.equal(data.note.text, '测试笔记\n讨论作品');
  assert.equal(data.note.coverage.imagesUnread, true);
  assert.equal(data.note.coverage.imageCount, 1); assert.deepEqual(data.imageSources, [{ index: 1, url: 'https://sns.xhscdn.com/real-picture' }]);
  assert.equal(data.comments.length, 2);
  assert.equal(data.comments[0].text, '去骚扰她');
  assert.equal(data.comments[1].text, '我反对骚扰');
  assert.match(data.comments[1].context, /上级评论：去骚扰她/);
  assert.equal(data.comments[1].coverage.parentMissing, false);
  await page.setContent(`<div class="note-container"><div id="detail-title">长背景</div><div id="detail-desc">${'甲'.repeat(6001)}</div><div class="comment-item" id="short"><div class="content">辛苦帖主</div></div></div>`);
  const longBackground = await page.evaluate(({ source }) => (0, eval)(`(${source})`)(document, 'https://www.xiaohongshu.com/explore/6ac119d5000000001500fd74', 10), { source: extractNote.toString() });
  assert.equal(longBackground.comments[0].text, '辛苦帖主');
  assert.equal(longBackground.comments[0].coverage.textTruncated, false);
  assert.equal(longBackground.comments[0].coverage.contextTextTruncated, true);
});
test('访问提示区分登录、验证和App限制，不误报正文旁的分享二维码', async t => {
  const { accessProblem, XhsBrowser, NeedsAttention, NoteUnavailable } = await import('../src/browser.js');
  assert.equal(accessProblem({ text: '扫码使用小红书App查看完整内容', readable: false }).code, 'app_required');
  assert.equal(accessProblem({ text: '小红书App内查看', readable: false }).code, 'app_required');
  assert.equal(accessProblem({ text: '登录后查看搜索结果 可用小红书扫码', readable: false }).kind, 'pause');
  assert.equal(accessProblem({ text: '扫码查看', readable: false, challenge: true }).kind, 'pause');
  assert.equal(accessProblem({ text: '普通正文 扫码查看', readable: true }), null);
  const browser = await chromium.launch({ executablePath: await findBrowserExecutable(), headless: true });
  t.after(() => browser.close()); const page = await browser.newPage(); const collector = new XhsBrowser('unused');
  await page.setContent('<div class="note-item">残留搜索卡片</div><div id="detail-desc"></div><div>扫码使用小红书App查看完整内容</div>');
  await assert.rejects(collector.gate(page, true), error => error instanceof NoteUnavailable && error.code === 'app_required');
  await page.setContent('<div id="detail-desc">真实正文</div><div>扫码查看</div>');
  await collector.gate(page, true);
  await page.setContent('<div class="login-container">登录后查看，扫码登录</div>');
  await assert.rejects(collector.gate(page, true), NeedsAttention);
});
test('原帖在已有采集登录环境打开，拒绝非小红书地址', async () => {
  const { XhsBrowser } = await import('../src/browser.js');
  const collector = new XhsBrowser('unused'); let openings = 0, brought = false;
  const source = 'https://www.xiaohongshu.com/explore/6ac119d5000000001500fd74?xsec_token=fixture';
  collector.context = { async newPage() { openings++; return { async goto(url) { assert.equal(url, source); }, url: () => source, async bringToFront() { brought = true; } }; } };
  await assert.rejects(collector.openNote('https://evil.example/'), /小红书/);
  assert.equal(openings, 0); await collector.openNote(source); assert.equal(openings, 1); assert.equal(brought, true);
});
test('同一搜索卡片优先保留页面实际提供的带参数链接，跨路径同篇去重', async () => {
  const { mergeNoteLinks } = await import('../src/browser.js');
  const id = '6ac119d5000000001500fd74';
  const unsigned = `https://www.xiaohongshu.com/explore/${id}`;
  const signed = `https://www.xiaohongshu.com/search_result/${id}?xsec_token=site-supplied&xsec_source=pc_search`;
  assert.deepEqual(mergeNoteLinks([], [unsigned, signed, unsigned, 'https://evil.example/']), [signed]);
  assert.deepEqual(mergeNoteLinks([unsigned], [signed]), [signed]);
  assert.deepEqual(mergeNoteLinks([signed], [unsigned]), [signed]);
});
test('历史笔记按编号跨链接参数去重，重复结果只计一次；未查过的保留', async () => {
  const { excludeKnownLinks } = await import('../src/browser.js');
  const id = '6ac119d5000000001500fd74', next = '6ac119d5000000001500fd75';
  const links = [`https://www.xiaohongshu.com/explore/${id}`, `https://www.xiaohongshu.com/search_result/${id}?xsec_token=changed`, `https://www.xiaohongshu.com/explore/${next}?xsec_token=new`];
  const selected = excludeKnownLinks(links, new Set([id]));
  assert.deepEqual(selected.excluded, [id]); assert.deepEqual(selected.urls, [links[2]]);
});
test('指定链接全已查过时不启动浏览器，也不读取旧帖', async () => {
  const { XhsBrowser } = await import('../src/browser.js'); const browser = new XhsBrowser('unused');
  browser.open = async () => { throw new Error('不应打开浏览器'); };
  const id = '6ac119d5000000001500fd74', events = [], records = [];
  for await (const r of browser.collect({ urls: [`https://www.xiaohongshu.com/explore/${id}`], keywords: [], excludedNoteIds: [id] }, new AbortController().signal, e => events.push(e))) records.push(r);
  assert.equal(records.length, 0); assert.equal(events[0].type, 'excluded'); assert.equal(events[0].count, 1);
});
