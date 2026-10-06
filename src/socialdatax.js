import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { validateNoteUrl } from './schema.js';
import { captureImages } from './images.js';

const BASE = 'https://mcp.socialdatax.com/socialdatax/api/v1/xhs';
const id = z.string().regex(/^[a-f0-9]{24}$/i);
const author = z.object({ name: z.string().max(500) }).passthrough().nullable();
const points = z.object({ cost: z.number().int().nonnegative() });
const image = z.object({ image_url: z.string().max(4000) }).passthrough();
const comment = z.object({ comment_id: z.string().min(1).max(128), note_id: id, content: z.string().max(100000),
  content_type: z.string(), image_items: z.array(image).max(100), reply_count: z.number().int().nonnegative(),
  parent_comment_id: z.string().max(128).nullable(), author }).passthrough();
const page = z.object({ items: z.array(comment).max(100), next_page_token: z.string().max(30000), points });
const detail = z.object({ note_id: id, note_url: z.string().nullable(), title: z.string().max(1000), content: z.string().max(200000),
  note_type: z.string(), image_items: z.array(image).max(100), comment_count: z.number().int().nonnegative(), author, points }).passthrough();
const search = z.object({ items: z.array(z.object({ note_id: id, note_url: z.string().nullable() }).passthrough()).max(100),
  next_page_token: z.string().max(30000), points });
const LIMIT = 2000;
const noteId = url => /\/(?:explore|discovery\/item|search_result)\/([a-f0-9]{24})/i.exec(url)?.[1]?.toLowerCase();

export class ApiLimit extends Error {}

export class SocialDataX {
  constructor(root, attachments, fetcher = fetch) {
    this.credentialsPath = join(root, 'socialdatax-key.json'); this.attachments = attachments; this.fetcher = fetcher; this.hasKey = false;
  }
  async init() {
    try { const saved = JSON.parse(await readFile(this.credentialsPath, 'utf8')); this.key = saved.apiKey || ''; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('数据服务密钥文件无法读取，未覆盖'); this.key = ''; }
    this.hasKey = !!this.key; return this;
  }
  async setKey(value) {
    const key = z.string().trim().max(512).refine(v => !/\s/.test(v), '密钥不能包含空白').parse(value);
    const temp = this.credentialsPath + '.tmp';
    await writeFile(temp, JSON.stringify({ apiKey: key }), { mode: 0o600 }); await rename(temp, this.credentialsPath);
    this.key = key; this.hasKey = !!key;
  }
  async request(path, body, schema, session, signal, progress) {
    signal.throwIfAborted();
    if (session.attempts >= session.maxRequests) throw new ApiLimit('本轮数据费用上限已到，剩余评论未读取');
    session.attempts++;
    const emit = () => progress({ type: 'api', attempts: session.attempts, costCents: session.costCents, unknown: session.unknown,
      message: `数据读取 ${session.attempts} 次，已确认费用 ¥${(session.costCents / 100).toFixed(2)}／本轮上限 ¥${session.budget.toFixed(2)}` });
    session.unknown++; emit();
    const combined = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
    let response;
    try { response = await this.fetcher(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${this.key}` },
      body: JSON.stringify(body), signal: combined, redirect: 'error' }); }
    catch (error) { if (signal.aborted) throw error; throw new Error('数据服务连接失败，本次是否扣费尚未确认；未自动重试'); }
    if (!response.ok) throw new Error(`数据服务请求失败（HTTP ${response.status}），已停止，未自动重试`);
    // Read a bounded body; a paid request with an invalid response still counts toward the conservative request cap.
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) { combined.throwIfAborted(); bytes += chunk.length; if (bytes > 8 * 1024 * 1024) throw new Error('数据服务响应过大，已停止'); chunks.push(chunk); }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('数据服务响应不是有效JSON，已停止；本次费用尚未确认'); }
    if (!data || typeof data !== 'object') throw new Error('数据服务响应格式不符合文档，已停止');
    if (Object.hasOwn(data, 'code')) { session.unknown--; emit(); throw new Error(`数据服务返回业务错误（${Number.isInteger(data.code) ? data.code : '未知'}），已停止；请检查余额、权限或服务状态`); }
    if (Number.isInteger(data.points?.cost) && data.points.cost >= 0) { session.unknown--; session.costCents += data.points.cost; emit(); }
    const validation = schema.safeParse(data);
    if (!validation.success) throw new Error('数据服务响应格式不符合已核对的接口文档，已停止');
    const parsed = validation.data;
    if (parsed.points.cost !== 10) throw new Error('数据服务当前单次价格与已确认的0.10元不同，已停止后续调用');
    return parsed;
  }
  async *collect(options, signal, progress) {
    if (!this.hasKey) throw new Error('请先在“规则与设置”填写 SocialDataX API Key；不会自动改用浏览器采集');
    const session = { attempts: 0, costCents: 0, unknown: 0, budget: options.apiBudgetYuan, maxRequests: Math.floor(options.apiBudgetYuan * 10 + 1e-8) };
    const excluded = new Set(options.excludedNoteIds || []), reported = new Set(), candidates = [], queued = new Set();
    const add = entry => {
      const key = entry.note_id || noteId(entry.note_url);
      if (key && excluded.has(key)) { if (!reported.has(key)) { reported.add(key); progress({ type: 'excluded', count: 1, message: '已排除查过的笔记' }); } return; }
      const identity = key || entry.note_url;
      if (!queued.has(identity)) { candidates.push(entry); queued.add(identity); }
    };
    for (const url of options.urls) add({ note_url: validateNoteUrl(url) });
    for (const keyword of options.keywords) {
      if (candidates.length >= options.maxNotes) break;
      let token = ''; const tokens = new Set();
      for (let n = 0; n < 5 && candidates.length < options.maxNotes; n++) {
        const found = await this.request('/note/search', { keyword, sort_type: 'time_descending', page_token: token }, search, session, signal, progress);
        for (const row of found.items) add(row);
        token = found.next_page_token; if (!token || tokens.has(token)) break; tokens.add(token);
      }
    }
    const selected = candidates.slice(0, options.maxNotes);
    for (const [index, entry] of selected.entries()) {
      signal.throwIfAborted(); progress({ type: 'attempt', message: '正在读取整篇笔记和评论区' });
      const data = await this.request('/note/detail', entry.note_id ? { note_id: entry.note_id } : { note_url: entry.note_url }, detail, session, signal, progress);
      const key = data.note_id.toLowerCase();
      const expectedId = entry.note_id || noteId(entry.note_url || '');
      if (expectedId && expectedId.toLowerCase() !== key) throw new Error('数据服务返回的正文不属于请求的笔记，结果未采纳');
      if (excluded.has(key)) { progress({ type: 'excluded', count: 1, message: '分享链接解析后发现是已查笔记，已跳过' }); continue; }
      // Preserve returned full URLs. A null URL is not silently replaced with a fabricated public link.
      const url = data.note_url ? validateNoteUrl(data.note_url) : entry.note_url || '';
      const rows = new Map(), limits = []; let topComplete = false, repliesComplete = false;
      let commentPages = 0, replyPages = 0;
      const readPages = async (path, params, rootId = null) => {
        let token = ''; const tokens = new Set();
        for (;;) {
          const result = await this.request(path, { ...params, page_token: token }, page, session, signal, progress);
          if (rootId) replyPages++; else commentPages++;
          for (const row of result.items) {
            if (row.note_id.toLowerCase() !== key) throw new Error('评论所属笔记与当前笔记不符，结果未采纳');
            if (!rows.has(row.comment_id) && rows.size >= LIMIT) { limits.push(`达到本篇${LIMIT}条评论保护上限`); return false; }
            const old = rows.get(row.comment_id);
            rows.set(row.comment_id, { ...row, threadRootId: rootId || row.comment_id, parent_comment_id: row.parent_comment_id || (rootId ? rootId : null), ...old });
          }
          progress({ type: 'discussion', noteId: key, comments: rows.size, message: `已读取“${data.title}”：${rows.size}条评论（一级${commentPages}页、回复${replyPages}页）` });
          token = result.next_page_token;
          if (!token) return true;
          if (tokens.has(token)) { limits.push('评论分页令牌重复，已停止，不能确认评论区完整'); return false; }
          tokens.add(token);
        }
      };
      try {
        topComplete = await readPages('/note/comment/list', { note_id: key, sort_type: 'default' });
        repliesComplete = topComplete;
        for (const row of [...rows.values()].filter(r => !r.parent_comment_id && r.reply_count > 0)) {
          if (!await readPages('/note/comment/sub/list', { note_id: key, comment_id: row.comment_id }, row.comment_id)) repliesComplete = false;
        }
      } catch (error) { repliesComplete = false; limits.push(error instanceof ApiLimit ? error.message : signal.aborted ? '用户停止，评论区未读取完' : error.message); }
      const totalReported = data.comment_count;
      if (rows.size < totalReported) limits.push(`接口标注${totalReported}条评论，实际返回${rows.size}条；隐藏、删除或不可返回内容无法确认`);
      let complete = topComplete && repliesComplete && !limits.length;
      const sources = data.image_items.map((v, i) => ({ index: i + 1, url: v.image_url }));
      const saveImages = async sources => {
        if (signal.aborted) return [];
        try { return await captureImages(sources.slice(0, options.maxImagesPerNote), this.attachments, signal); }
        catch (error) { if (!signal.aborted) throw error; limits.push('用户停止，部分图片未保存'); return []; }
      };
      const images = await saveImages(sources);
      const comments = [];
      for (const row of rows.values()) {
        const parent = rows.get(row.parent_comment_id);
        const text = row.content.slice(0, 15000);
        const ownSources = row.image_items.map((v, i) => ({ index: i + 1, url: v.image_url }));
        const ownImages = await saveImages(ownSources);
        comments.push({ kind: 'comment', sourceKey: `comment:${key}:${row.comment_id}`, discussionNoteId: key, commentId: row.comment_id,
          parentCommentId: row.parent_comment_id, threadRootId: row.threadRootId, text, title: data.title, author: row.author?.name || '', url,
          context: `所属笔记：${data.title}\n${data.content.slice(0, 15000)}` + (parent ? `\n\n上级评论（${parent.author?.name || '作者未读取'}）：${parent.content.slice(0, 15000)}` : ''),
          images: ownImages, coverage: { source: 'socialdatax', imageCount: ownSources.length, imagesUnread: ownSources.length > 0,
            textTruncated: row.content.length > text.length, contextTextTruncated: data.content.length > 15000 || !!parent && parent.content.length > 15000,
            parentMissing: !!row.parent_comment_id && !parent, unsupportedMedia: row.content_type === 'voice', discussionIncomplete: !complete } });
      }
      const note = { kind: 'note', sourceKey: `note:${key}`, discussionNoteId: key, text: data.content.slice(0, 15000), title: data.title, author: data.author?.name || '', url, context: '', images,
        discussion: { sourceKeys: comments.map(c => c.sourceKey), complete, limitations: limits, reportedComments: totalReported, commentsRead: rows.size, commentPages, replyPages, fetchedAt: new Date().toISOString() },
        coverage: { source: 'socialdatax', imageCount: sources.length, imagesUnread: sources.length > 0, textTruncated: data.content.length > 15000,
          discussionIncomplete: !complete, unsupportedMedia: data.note_type === 'video' } };
      if (signal.aborted) { complete = false; note.discussion.complete = false; note.coverage.discussionIncomplete = true; for (const comment of comments) comment.coverage.discussionIncomplete = true; }
      yield { note, comments };
      if (signal.aborted) signal.throwIfAborted();
      if (session.attempts >= session.maxRequests || limits.some(v => /数据服务|响应|所属笔记/.test(v))) {
        if (index < selected.length - 1) progress({ type: 'api-stop', message: `已停止后续数据读取，另有${selected.length - index - 1}篇未读取；本轮请求上限或服务异常限制` });
        return;
      }
    }
  }
}
