import { chromium } from 'playwright-core';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { validateNoteUrl } from './schema.js';
import { captureImages } from './images.js';

export class NoteUnavailable extends Error { constructor(message, code = 'unreadable') { super(message); this.name = 'NoteUnavailable'; this.code = code; } }
// Access prompts are not note text. A normal download/share QR beside readable content is harmless.
export function accessProblem({ text, readable, login, challenge, path = '' }) {
  if (challenge || /captcha|verify/.test(path) || (!readable && /安全验证|请完成验证|访问频次异常|滑动.*验证|网络环境存在风险/.test(text))) return { kind: 'pause', message: '小红书要求验证。请在采集浏览器完成验证，然后点击“继续任务”。' };
  if (login || (!readable && /登录后.{0,8}(查看|浏览)|登录后可查看/.test(text))) return { kind: 'pause', message: '需要登录小红书。请在采集浏览器登录，然后点击“继续任务”。' };
  if (!readable && /扫码.{0,40}(查看|阅读|浏览)|(?:打开|使用|前往).{0,15}(?:APP|App|app|小红书).{0,20}(?:查看|阅读|浏览)|(?:APP|App|app)内.{0,15}(?:查看|阅读|浏览)/s.test(text)) return { kind: 'skip', code: 'app_required', message: '网页要求扫码或使用小红书 App 查看，未获取正文；此篇未分析。' };
  if (!readable && /笔记不存在|笔记已被删除|内容无法展示|页面不见了/.test(text)) return { kind: 'skip', code: 'unavailable', message: '小红书笔记不可访问，可能已删除或链接失效' };
  return null;
}
// Search cards can expose an unsigned fallback and a usable signed link for the same note.
// Keep the exact site-rendered URL; never generate tokens or call signed private APIs.
export function mergeNoteLinks(existing, candidates) {
  const notes = new Map();
  for (const link of [...existing, ...candidates]) {
    try {
      const validated = validateNoteUrl(link), url = new URL(validated);
      const identity = url.pathname.match(/[a-f0-9]{24}/i)?.[0]?.toLowerCase() || validated;
      const old = notes.get(identity);
      if (!old || (!new URL(old).searchParams.get('xsec_token') && url.searchParams.get('xsec_token'))) notes.set(identity, validated);
    } catch {}
  }
  return [...notes.values()];
}
export function noteId(url) { return new URL(url).pathname.match(/[a-f0-9]{24}/i)?.[0]?.toLowerCase() || null; }
export function excludeKnownLinks(links, knownIds) {
  const urls = [], excluded = new Set();
  for (const link of mergeNoteLinks([], links)) {
    const id = noteId(link);
    if (id && knownIds.has(id)) excluded.add(id);
    else urls.push(link);
  }
  return { urls, excluded: [...excluded] };
}
export class NeedsAttention extends Error { constructor(message) { super(message); this.name = 'NeedsAttention'; } }
export async function findBrowserExecutable() {
  const candidates = [process.env.PATROL_CHROME_PATH, chromium.executablePath(),
    ...(process.platform === 'linux' ? ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
      : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : [join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
        join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')])].filter(Boolean);
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch {} }
  throw new Error('未找到 Chrome 或 Chromium。请安装浏览器，或通过 PATROL_CHROME_PATH 指定路径。');
}
const sleep = async (ms, signal) => {
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); }
    signal?.addEventListener('abort', abort, { once: true });
  });
};

// Reads only rendered page DOM. No private application state, signed APIs, or cookie export.
export function extractNote(input, url, limit = 10) {
  const document = input?.querySelectorAll ? input : globalThis.document;
  if (!input?.querySelectorAll) { url = globalThis.location.href; limit = input.limit; }
  const visible = el => !!el && !!(el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
  const pick = (root, selectors) => {
    for (const selector of selectors) {
      const el = [...root.querySelectorAll(selector)].find(visible);
      const value = el?.innerText?.trim(); if (value) return value;
    }
    return '';
  };
  const noteRoot = document.querySelector('#noteContainer, .note-container, .note-detail-mask') || document;
  const title = pick(noteRoot, ['#detail-title', '.note-content .title', '.note-detail .title']);
  const text = pick(noteRoot, ['#detail-desc', '.note-content .desc', '.note-content .content', '.note-detail .desc']);
  const author = pick(noteRoot, ['.author-wrapper .username', '.author-container .username', '.author .name']);
  const slides = [...noteRoot.querySelectorAll('.swiper-slide')].filter(visible);
  const slideKeys = [...new Set(slides.map((slide, n) => slide.getAttribute('data-swiper-slide-index') || String(n)))];
  const images = [...noteRoot.querySelectorAll('.swiper-slide img, .note-slider img, .note-image img, .media-container img')].filter(visible).filter(image => {
    const source = image.currentSrc || image.getAttribute('src') || image.getAttribute('data-src') || '';
    // The page inserts its 48px loading logo beside the actual photo. It is UI, not a note page.
    return !source.startsWith('https://fe-platform.xhscdn.com/platform/') && !image.closest('.loading-container, .loading-mask');
  });
  const imageSources = []; const imagePages = new Set();
  for (const image of images) {
    const url = image.currentSrc || image.getAttribute('src') || image.getAttribute('data-src') || '';
    const slide = image.closest('.swiper-slide');
    const rawIndex = slide?.getAttribute('data-swiper-slide-index');
    const index = rawIndex !== null && rawIndex !== undefined && /^\d+$/.test(rawIndex) ? Number(rawIndex) + 1 : slide ? slides.indexOf(slide) + 1 : imageSources.length + 1;
    if (imagePages.has(index)) continue;
    imagePages.add(index); imageSources.push({ index, url });
  }
  const imageTotal = Math.max(imageSources.length, ...imageSources.map(i => i.index), slideKeys.length, noteRoot.querySelectorAll('.swiper-pagination-bullet').length);
  const imageAlts = images.map(img => img.getAttribute('alt') || '').filter(Boolean).slice(0, 12);
  const noteKey = new URL(url).pathname.match(/[a-f0-9]{24}/i)?.[0] || url;
  const bodyText = [title, text].filter(Boolean).join('\n');
  const note = { kind: 'note', sourceKey: `note:${noteKey}`, url, title: title || '无标题笔记', author,
    text: bodyText.slice(0, 15000), context: '',
    coverage: { imagesUnread: imageTotal > 0, imageCount: imageTotal, imageAlts, textTruncated: bodyText.length > 15000, parentMissing: false, source: 'rendered-dom' } };
  const rows = [...noteRoot.querySelectorAll('.comment-item')].filter(visible);
  const comments = [];
  const seen = new Set();
  for (const row of rows) {
    // A top-level row can contain nested reply rows. Only read its own content.
    const ownPick = selectors => {
      for (const selector of selectors) for (const el of row.querySelectorAll(selector)) {
        if (el.closest('.comment-item') !== row || !visible(el)) continue;
        const value = el.innerText?.trim(); if (value) return value;
      }
      return '';
    };
    const content = ownPick(['.content .note-text', '.content', '.comment-content']);
    if (!content) continue;
    const username = ownPick(['.author .name', '.user-name', '.name']);
    const id = row.getAttribute('id') || row.getAttribute('data-id');
    const key = id || `${username}:${content}`;
    if (seen.has(key)) continue; seen.add(key);
    const thread = row.closest('.parent-comment, .comment-thread');
    const ancestor = row.parentElement?.closest('.comment-item');
    const firstInThread = thread?.querySelector('.comment-item');
    const parent = ancestor || (firstInThread !== row ? firstInThread : null);
    const parentText = parent ? pick(parent, ['.content .note-text', '.content']) : '';
    const isReply = !!parent || !!row.closest('.reply-container, .reply-item, .sub-comment') || /回复/.test(ownPick(['.content']));
    const context = [`所属笔记：${title}\n${text.slice(0, 6000)}`, parentText ? `上级评论：${parentText.slice(0, 2000)}` : ''].filter(Boolean).join('\n\n');
    comments.push({ kind: 'comment', sourceKey: `comment:${noteKey}:${key}`, url, title: title || '笔记评论', author: username,
      text: content.slice(0, 15000), context,
      coverage: { imagesUnread: false, textTruncated: content.length > 15000, contextTextTruncated: text.length > 6000 || parentText.length > 2000, parentMissing: isReply && !parentText, source: 'rendered-dom' } });
    if (comments.length >= limit) break;
  }
  return { note, imageSources, comments: limit === 0 ? [] : comments, commentsVisible: rows.length };
}

export class XhsBrowser {
  constructor(root, attachments = null) { this.attachments = attachments; this.root = root; this.context = null; this.launching = null; this.pausedPage = null; }
  async open() {
    if (this.context) return this.context;
    if (this.launching) return this.launching;
    this.launching = this.launch();
    try { return await this.launching; } finally { this.launching = null; }
  }
  async launch() {
    const executablePath = await findBrowserExecutable();
    this.context = await chromium.launchPersistentContext(join(this.root, 'xhs-browser'), {
      executablePath, headless: false, viewport: { width: 1280, height: 900 }, locale: 'zh-CN',
    });
    this.context.on('close', () => { this.context = null; this.pausedPage = null; });
    return this.context;
  }
  async login() {
    const context = await this.open();
    const page = this.pausedPage && !this.pausedPage.isClosed() ? this.pausedPage : context.pages()[0] || await context.newPage();
    if (!/^https:\/\/(www\.)?xiaohongshu\.com\//.test(page.url())) await page.goto('https://www.xiaohongshu.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.bringToFront();
    return { message: '已打开独立采集浏览器。请在这个窗口登录小红书，登录完成后回到巡查面板开始扫描。登录状态只保存在本机。' };
  }
  async openNote(url) {
    const validated = validateNoteUrl(url);
    const context = await this.open();
    const page = await context.newPage();
    try {
      await page.goto(validated, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!['xiaohongshu.com', 'www.xiaohongshu.com', 'xhslink.cn', 'xhslink.com'].includes(new URL(page.url()).hostname)) throw new Error('链接跳转到了小红书以外的网站');
      await page.bringToFront();
      return { message: '已在保留登录状态的采集浏览器打开原帖。若仍要求 App 扫码，网页版不能读取该内容。' };
    } catch (error) { await page.close().catch(() => {}); throw error; }
  }
  async gate(page, detail = false) {
    const login = await page.locator('.login-container:visible, .login-modal:visible, .login-modal-mask:visible, .login-box:visible').count();
    const text = (await page.locator('body').innerText()).slice(0, 30000);
    const challenge = await page.locator('.captcha-container:visible, .captcha-modal:visible, .verify-container:visible').count();
    const readable = await page.locator(detail ? '#detail-desc, .note-content .desc, .note-detail .desc, .swiper-slide img, .note-slider img, .note-image img, .media-container img' : '.note-item').evaluateAll(elements => elements.some(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && (el.tagName === 'IMG' || el.innerText?.trim())));
    const problem = accessProblem({ text, readable, login, challenge, path: new URL(page.url()).pathname });
    if (problem?.kind === 'pause') { await page.bringToFront(); throw new NeedsAttention(problem.message); }
    if (problem) throw new NoteUnavailable(problem.message, problem.code);
  }
  async navigate(page, url, signal, detail = false) {
    signal.throwIfAborted();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const hostname = new URL(page.url()).hostname;
    if (!['xiaohongshu.com', 'www.xiaohongshu.com', 'xhslink.cn', 'xhslink.com'].includes(hostname)) throw new Error('分享链接跳转到了小红书以外的网站，已停止采集');
    await sleep(1800, signal); await this.gate(page, detail);
  }
  async *collect(options, signal, progress) {
    const knownIds = new Set(options.excludedNoteIds || []), reported = new Set();
    const exclude = links => {
      const result = excludeKnownLinks(links, knownIds);
      const newlyExcluded = result.excluded.filter(id => !reported.has(id));
      for (const id of newlyExcluded) reported.add(id);
      if (newlyExcluded.length) progress({ type: 'excluded', count: newlyExcluded.length, message: `已排除 ${reported.size} 篇查过的笔记，不重复采集` });
      return result.urls;
    };
    let urls = exclude(options.urls);
    if (options.urls.length && !options.keywords.length && !urls.length) return;
    const context = await this.open();
    if (this.pausedPage) { await this.pausedPage.close().catch(() => {}); this.pausedPage = null; }
    const page = await context.newPage();
    const abort = () => { page.close().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    const visited = new Set();
    let keepPage = false;
    try {
      for (const keyword of options.keywords) {
        signal.throwIfAborted(); if (urls.length >= options.maxNotes) break;
        progress(`正在搜索：${keyword}`);
        await this.navigate(page, `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_explore_feed`, signal);
        let unchanged = 0;
        const discovered = new Set();
        const quota = Math.min(options.maxNotes, urls.length + Math.ceil(options.maxNotes / Math.max(1, options.keywords.length)));
        for (let step = 0; step < 5 && urls.length < quota; step++) {
          await this.gate(page);
          const links = await page.locator('section.note-item a[href], .note-item a[href]').evaluateAll(anchors => anchors.map(a => a.href).filter(href => /\/(explore|search_result)\/[a-f0-9]{24}/i.test(href)));
          const before = discovered.size;
          for (const link of links) discovered.add(noteId(link) || link);
          urls = mergeNoteLinks(urls, exclude(links)).slice(0, quota);
          unchanged = discovered.size === before ? unchanged + 1 : 0;
          if (unchanged >= 2) break;
          await page.mouse.wheel(0, 700); await sleep(1200, signal);
        }
      }
      if (!urls.length && reported.size) return;
      if (!urls.length) throw new NeedsAttention('搜索没有读到笔记。请检查浏览器是否登录或出现验证，也可以在面板直接粘贴笔记链接。');
      for (const url of urls.slice(0, options.maxNotes)) {
        signal.throwIfAborted();
        const key = new URL(url).pathname.match(/[a-f0-9]{24}/i)?.[0]?.toLowerCase() || url;
        if (visited.has(key)) continue; visited.add(key);
        progress({ type: 'attempt', message: `正在读取第 ${visited.size} 篇笔记` });
        try {
          await this.navigate(page, validateNoteUrl(url), signal, true);
          // A share short-link cannot be identified until its normal browser redirect.
          const resolvedId = noteId(page.url());
          if (resolvedId && knownIds.has(resolvedId)) { exclude([page.url()]); continue; }
          const read = () => page.evaluate(extractNote, { limit: options.maxComments });
          let extracted = await read();
          const allComments = new Map(extracted.comments.map(c => [c.sourceKey, c]));
          for (let step = 0; step < 4 && allComments.size < options.maxComments; step++) {
            const reply = page.getByText(/展开\s*\d+\s*条回复|展开更多回复/).first();
            if (await reply.isVisible().catch(() => false)) await reply.click({ timeout: 1500 }).catch(() => {});
            const comment = page.locator('.comments-container, .note-scroller, .note-container').first();
            if (await comment.count()) { await comment.hover().catch(() => {}); await page.mouse.wheel(0, 650); }
            await sleep(700, signal); await this.gate(page, true);
            extracted = await read();
            const before = allComments.size;
            for (const c of extracted.comments) allComments.set(c.sourceKey, c);
            if (allComments.size === before && step >= 1) break;
          }
          if (!extracted.note.text && !extracted.note.coverage.imagesUnread) throw new Error('没有读到正文，页面结构可能变化，未把空页面当成有效笔记');
          const images = await captureImages(extracted.imageSources.slice(0, options.maxImagesPerNote || 18), this.attachments, signal);
          yield { ...extracted.note, images };

          if (resolvedId) knownIds.add(resolvedId);
          for (const comment of [...allComments.values()].slice(0, options.maxComments)) yield comment;
          progress(`第 ${visited.size} 篇读取完成：${allComments.size} 条可见评论（并非全部评论）`);
        } catch (error) {
          if (error instanceof NeedsAttention || signal.aborted) throw error;
          progress({ type: 'skip', url, code: error.code || 'unreadable', reason: error.message, message: `跳过第 ${visited.size} 篇：${error.message}` });
        }
        await sleep(1000, signal);
      }
    } catch (error) {
      keepPage = error instanceof NeedsAttention;
      if (keepPage) this.pausedPage = page;
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      // Keep a verification/login tab visible on pause; close normal finished scan tabs.
      if (!keepPage || signal.aborted) await page.close().catch(() => {});
    }
  }
  async close() {
    if (this.launching) await this.launching.catch(() => {});
    const context = this.context; this.context = null; if (context) await context.close();
  }
}
