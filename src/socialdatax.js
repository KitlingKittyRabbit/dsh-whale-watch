import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { validateNoteUrl } from './schema.js';
import { captureImages } from './images.js';
import { DEFAULT_SEARCH_SETTINGS } from './search-options.js';
import { alternate, matchesKeywords, matchesUserFilters, userReference } from './user-search.js';

const BASE = 'https://mcp.socialdatax.com/socialdatax/api/v1/xhs';
const id = z.string().regex(/^[a-f0-9]{24}$/i);
const author = z.object({ name: z.string().max(500), user_id: id.optional() }).passthrough().nullable();
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
const userInfo = z.object({ user_id: id, points }).passthrough();
const userNotes = z.object({ items: z.array(z.object({ note_id: id, note_url: z.string().nullable(), note_type: z.enum(['image', 'video']),
  publish_time: z.number().int().nonnegative(), author: z.object({ user_id: id }).passthrough() }).passthrough()).max(100),
  next_page_token: z.string().max(30000), points });
const LIMIT = 2000;
const noteId = url => /\/(?:explore|discovery\/item|search_result)\/([a-f0-9]{24})/i.exec(url)?.[1]?.toLowerCase();

export class ApiLimit extends Error {}

export class SocialDataX {
  constructor(root, attachments, fetcher = fetch, imageLoader) {
    this.credentialsPath = join(root, 'socialdatax-key.json'); this.attachments = attachments; this.fetcher = fetcher; this.imageLoader = imageLoader; this.hasKey = false;
  }
  async retrySavedImages(item, signal) {
    // Explicit whole-discussion retries may recover failed CDN downloads using
    // already saved URLs. Never re-query the paid API or exceed saved page caps.
    const missing = (item.images || []).filter(image => !image.attachment && image.sourceUrl);
    if (!missing.length) return 0;
    const savedBytes = item.images.reduce((n, image) => n + (image.attachment?.bytes || 0), 0);
    const recovered = await captureImages(missing.map(image => ({ index: image.index, url: image.sourceUrl })), this.attachments, signal, this.imageLoader, savedBytes);
    for (const image of recovered) item.images[item.images.findIndex(old => old.index === image.index)] = image;
    return recovered.filter(image => image.attachment).length;
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
    options = { ...DEFAULT_SEARCH_SETTINGS, users: [], userKeywordMode: 'and', ...options };
    const referenceMap = new Map();
    for (const value of options.users) {
      const ref = userReference(value), identity = ref.userId || new URL(ref.params.profile_url).pathname;
      if (!referenceMap.has(identity)) referenceMap.set(identity, ref);
    }
    const references = [...referenceMap.values()];
    if (references.length && options.urls.length) throw new Error('指定笔记链接与指定用户不能同时使用');
    if (!this.hasKey) throw new Error('请先在“规则与设置”填写 SocialDataX API Key；不会自动改用浏览器采集');
    const session = { attempts: 0, costCents: 0, unknown: 0, budget: options.apiBudgetYuan, maxRequests: Math.floor(options.apiBudgetYuan * 10 + 1e-8) };
    const excluded = new Set(options.excludedNoteIds || []), reported = new Set(), queued = new Set(), resolvedUsers = new Set(), readNotes = new Set();
    const explicitNotes = new Set(options.urls.map(url => noteId(url) || url));
    const accept = entry => {
      const key = entry.note_id?.toLowerCase() || noteId(entry.note_url);
      if (key && excluded.has(key)) { if (!reported.has(key)) { reported.add(key); progress({ type: 'excluded', count: 1, message: '已排除查过的笔记' }); } return false; }
      const identity = key || entry.note_url;
      if (queued.has(identity)) return false;
      queued.add(identity); return true;
    };
    const filtered = message => progress({ type: 'filtered', count: 1, message });
    const pages = async function* (source, path, params, schema) {
      let token = ''; const tokens = new Set();
      for (let n = 0; n < 5; n++) {
        const found = await source.request(path, { ...params, page_token: token }, schema, session, signal, progress);
        for (const row of found.items) yield row;
        token = found.next_page_token;
        if (!token) return;
        if (tokens.has(token)) { progress({ type: 'search-limit', message: '候选笔记分页令牌重复，搜索范围未读完' }); return; }
        tokens.add(token);
      }
      progress({ type: 'search-limit', message: '达到每个用户或关键词最多5页的候选查找上限，搜索范围未读完' });
    };
    const userCandidates = async function* (source, reference) {
      const userId = (reference.userId || (await source.request('/user/info', reference.params, userInfo, session, signal, progress)).user_id).toLowerCase();
      if (resolvedUsers.has(userId)) return;
      resolvedUsers.add(userId);
      // Keep full supplied profile URLs. Encrypted profile identities are resolved once first.
      const params = reference.userId ? reference.params : { user_id: userId };
      for await (const row of pages(source, '/user/note/list', params, userNotes)) {
        if (row.author.user_id.toLowerCase() !== userId) throw new Error('用户笔记列表的作者与指定用户不符，结果未采纳');
        yield { ...row, expectedUserId: userId };
      }
    };
    const keywordCandidates = async function* (source) {
      for (const keyword of options.keywords) yield* pages(source, '/note/search', { keyword, sort_type: options.noteSort,
        publish_time_range: options.publishTimeRange, note_type: options.noteType }, search);
    };
    const source = this;
    const eligible = async function* (entries) {
      for await (const entry of entries) {
        if (!accept(entry)) continue;
        if (entry.expectedUserId && !matchesUserFilters(entry, options)) { filtered('指定用户的候选笔记不符合时间或类型条件，已筛除'); continue; }
        yield entry;
      }
    };
    const candidates = async function* () {
      for (const url of options.urls) { const entry = { note_url: validateNoteUrl(url) }; if (accept(entry)) yield entry; }
      if (references.length) {
        const users = alternate(references.map(ref => eligible(userCandidates(source, ref))));
        if (options.keywords.length && options.userKeywordMode === 'or') yield* alternate([users, eligible(keywordCandidates(source))]);
        else yield* users;
      } else yield* eligible(keywordCandidates(source));
    };
    let collected = 0;
    try {
    for await (const entry of candidates()) {
      if (session.attempts >= session.maxRequests) {
        const remaining = !references.length && !options.keywords.length ? Math.max(1, Math.min(options.maxNotes - collected, explicitNotes.size - collected - reported.size)) : null;
        throw new ApiLimit(`本轮数据费用上限已到，${remaining ? `另有${remaining}篇候选笔记未读取` : '候选笔记尚未全部检查'}`);
      }
      signal.throwIfAborted(); progress({ type: 'attempt', message: options.readComments === false ? '正在读取笔记，跳过评论区' : '正在读取整篇笔记和评论区' });
      const data = await this.request('/note/detail', entry.note_id ? { note_id: entry.note_id } : { note_url: entry.note_url }, detail, session, signal, progress);
      const key = data.note_id.toLowerCase();
      const expectedId = entry.note_id || noteId(entry.note_url || '');
      if (expectedId && expectedId.toLowerCase() !== key) throw new Error('数据服务返回的正文不属于请求的笔记，结果未采纳');
      if (excluded.has(key)) { progress({ type: 'excluded', count: 1, message: '分享链接解析后发现是已查笔记，已跳过' }); continue; }
      if (readNotes.has(key)) continue;
      readNotes.add(key);
      if (entry.expectedUserId && data.author?.user_id?.toLowerCase() !== entry.expectedUserId) throw new Error('笔记正文的作者与指定用户不符，结果未采纳');
      if (entry.expectedUserId && !matchesUserFilters({ ...entry, ...data }, options)) { filtered('指定用户的笔记详情不符合时间或类型条件，已筛除'); continue; }
      if (entry.expectedUserId && options.userKeywordMode === 'and' && options.keywords.length && !matchesKeywords(data, options.keywords)) {
        filtered('指定用户的笔记标题和正文未命中任一关键词，已筛除；未读取评论或调用模型'); continue;
      }
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
      if (options.readComments !== false) try {
        topComplete = await readPages('/note/comment/list', { note_id: key, sort_type: options.commentSort });
        repliesComplete = topComplete;
        for (const row of [...rows.values()].filter(r => !r.parent_comment_id && r.reply_count > 0)) {
          if (!await readPages('/note/comment/sub/list', { note_id: key, comment_id: row.comment_id }, row.comment_id)) repliesComplete = false;
        }
      } catch (error) { repliesComplete = false; limits.push(error instanceof ApiLimit ? error.message : signal.aborted ? '用户停止，评论区未读取完' : error.message); }
      const totalReported = data.comment_count;
      if (options.readComments !== false && rows.size < totalReported) limits.push(`接口标注${totalReported}条评论，实际返回${rows.size}条；隐藏、删除或不可返回内容无法确认`);
      let complete = options.readComments === false || topComplete && repliesComplete && !limits.length;
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
          parentCommentId: row.parent_comment_id, threadRootId: row.threadRootId, text, title: data.title, author: row.author?.name || '', authorId: row.author?.user_id || '', url,
          context: `所属笔记：${data.title}\n${data.content.slice(0, 15000)}` + (parent ? `\n\n上级评论（${parent.author?.name || '作者未读取'}）：${parent.content.slice(0, 15000)}` : ''),
          images: ownImages, coverage: { source: 'socialdatax', imageCount: ownSources.length, imagesUnread: ownSources.length > 0,
            textTruncated: row.content.length > text.length, contextTextTruncated: data.content.length > 15000 || !!parent && parent.content.length > 15000,
            parentMissing: !!row.parent_comment_id && !parent, unsupportedMedia: row.content_type === 'voice', discussionIncomplete: !complete } });
      }
      const note = { kind: 'note', sourceKey: `note:${key}`, discussionNoteId: key, text: data.content.slice(0, 15000), title: data.title, author: data.author?.name || '', authorId: data.author?.user_id || '', url, context: '', images,
        discussion: { ...(options.readComments === false ? { scope: 'note' } : {}), sourceKeys: comments.map(c => c.sourceKey), complete, limitations: limits, reportedComments: totalReported, commentsRead: rows.size, commentPages, replyPages, fetchedAt: new Date().toISOString() },
        coverage: { source: 'socialdatax', imageCount: sources.length, imagesUnread: sources.length > 0, textTruncated: data.content.length > 15000,
          discussionIncomplete: !complete, unsupportedMedia: data.note_type === 'video' } };
      if (signal.aborted) { complete = false; note.discussion.complete = false; note.coverage.discussionIncomplete = true; for (const comment of comments) comment.coverage.discussionIncomplete = true; }
      note.lastCapture = { scope: options.readComments === false ? 'note' : 'discussion', complete, fetchedAt: note.discussion.fetchedAt };
      yield { note, comments };
      collected++;
      if (signal.aborted) signal.throwIfAborted();
      if (collected >= options.maxNotes) return;
      if (limits.some(v => /数据服务|响应|所属笔记/.test(v))) {
        progress({ type: 'api-stop', message: '已停止后续数据读取：评论服务异常，尚未继续检查其他候选笔记' });
        return;
      }
    }
    } catch (error) {
      if (!(error instanceof ApiLimit)) throw error;
      progress({ type: 'api-stop', message: error.message + '；已保存的笔记保留，未宣称覆盖全部结果' });
    }
  }
}
