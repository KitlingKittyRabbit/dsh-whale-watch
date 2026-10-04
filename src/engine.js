import { randomUUID } from 'node:crypto';
import { startSchema, settingsSchema, reviewSchema, resumeSchema, readSchema, importSchema, validateNoteUrl } from './schema.js';
import { NeedsAttention } from './browser.js';
import { loadEvaluationCases, evaluationItem, summarizeEvaluation } from './evaluation.js';
import { analysisMaterial, imageContext } from './images.js';
import { hash } from './store.js';
import { backgroundStartSchema, backgroundUpdateSchema, readingMaterial, backgroundHash, activeBackground, publicProfile, backgroundReadingKey, parseReading } from './background.js';

import { communityBackgroundInfo, createCommunityBackground } from './community-background.js';

export class PatrolEngine {
  constructor(store, browser, model) { this.store = store; this.browser = browser; this.model = model; this.active = null; }
  async init() { await this.store.init(); return this; }
  isStale(item) { return !!item.analysis && !!this.model.cacheKey && item.analysisKey !== this.model.cacheKey(item, this.analysisSettings(this.store.data.settings)); }
  analysisSettings(settings) { return { ...settings, backgroundContext: activeBackground(this.store.data) }; }
  state() {
    const data = this.store.data;
    const unread = data.items.filter(i => !i.readAt);
    const classified = unread.filter(i => i.analysis && !this.isStale(i));
    return { settings: data.settings, jobs: data.jobs.slice(-20).reverse(), counts: {
      total: data.items.length, unread: unread.length, read: data.items.length - unread.length, review: classified.filter(i => i.analysis.decision === 'review').length,
      suspicious: classified.filter(i => i.analysis.decision === 'review').length,
      other: classified.filter(i => i.analysis.decision !== 'review').length,
      uncertain: classified.filter(i => i.analysis.decision === 'uncertain').length,
      pending: unread.length - classified.length,
    }, seenCache: { count: data.seenCache.ids.length, lastClearedAt: data.seenCache.clearedAt, canRestore: !!data.seenCache.previousIds?.length },
    background: { enabled: this.store.data.background.enabled, activeId: this.store.data.background.active?.id || null, articlesRead: this.store.data.background.active?.readings.length || 0 }, browserOpen: !!this.browser.context, activeJob: this.active?.job.id || null };
  }
  results({ filter = 'all', limit = 50, offset = 0 } = {}) {
    const archive = filter === 'read' || filter === 'reviewed';
    const items = this.store.data.items.filter(item => archive ? !!item.readAt : !item.readAt &&
      (filter === 'all' || filter === 'unread' || (filter === 'unanalyzed' ? !item.analysis || this.isStale(item) : !!item.analysis && !this.isStale(item) && (filter === 'suspicious' ? item.analysis.decision === 'review' : filter === 'other' ? item.analysis.decision !== 'review' : item.analysis.decision === filter))));
    return { total: items.length, items: items.slice(offset, offset + limit).map(({ history, ...item }) => ({ ...item, analysisStale: this.isStale(item), inspectionResult: !item.analysis || this.isStale(item) ? null : item.analysis.decision === 'review' ? 'suspicious' : 'other' })) };
  }
  evaluation() { return this.store.data.evaluation || null; }
  async clearSeenCache() {
    if (this.active) throw new Error('任务进行中，请先停止任务再清空已查缓存');
    const cleared = await this.store.clearSeenCache();
    return { cleared, message: cleared ? `已清空 ${cleared} 篇笔记的已查缓存，旧帖可再次查找。原文、分析及复核结果保留；未变化的文字仍复用已有分析。` : '已查缓存已经为空。' };
  }
  async restoreSeenCache() {
    if (this.active) throw new Error('任务进行中，请先停止任务再撤销缓存清理');
    const count = await this.store.restoreSeenCache();
    return { count, message: `已撤销清理，已查缓存现有 ${count} 篇笔记。` };
  }
  async settings(input) {
    if (this.active) throw new Error('任务进行中，请先停止任务再修改设置');
    this.store.data.settings = settingsSchema.parse(input); await this.store.save(); return this.state();
  }
  async retry(input) {
    const { id, backgroundExpanded } = readSchema.parse(input);
    if (!this.store.data.items.some(i => i.id === id)) throw new Error('没有找到这条记录');
    return this.start({ maxAnalysis: 1, maxVision: 1, backgroundExpanded }, `item:${id}`);
  }
  async markRead(input) {
    const data = readSchema.parse(input);
    const item = this.store.data.items.find(i => i.id === data.id);
    if (!item) throw new Error('没有找到这条记录');
    const previous = item.readAt;
    item.readAt = data.read ? item.readAt || new Date().toISOString() : null;
    try { await this.store.save(); } catch (error) { item.readAt = previous; throw error; }
    return { id: item.id, readAt: item.readAt, message: data.read ? '已阅，已从当前列表移除。可在“已阅”中查看。' : '已恢复到未阅列表。' };
  }
  async review(input) {
    const data = reviewSchema.parse(input);
    const item = this.store.data.items.find(i => i.id === data.id);
    if (!item) throw new Error('没有找到这条记录');
    item.review = { verdict: data.verdict, note: data.note, at: new Date().toISOString() };
    await this.store.save(); return item;
  }
  options(input) {
    const requested = startSchema.parse(input);
    const urls = (requested.urls || []).map(validateNoteUrl);
    const settings = this.store.data.settings;
    return { ...settings, ...requested, urls, keywords: urls.length && !requested.keywords ? [] : requested.keywords || settings.keywords, analyze: requested.analyze ?? true };
  }
  async start(input = {}, mode = 'scan', backgroundPlan = null) {
    if (this.active) throw new Error('已有任务运行中，请先停止或等待完成');
    const options = this.analysisSettings(this.options(input));
    const job = { id: randomUUID(), mode, status: 'running', startedAt: new Date().toISOString(),
      options: { ...options, backgroundContext: undefined }, backgroundId: options.backgroundContext?.id || null, backgroundPlan, backgroundRead: 0, backgroundCached: 0, backgroundCalls: 0, backgroundErrors: 0, notesAttempted: 0, notesRead: 0, notesExcluded: 0, skippedNotes: [], collected: 0, analyzed: 0, cached: 0, failed: 0, verificationCalls: 0, visionRead: 0, visionCached: 0, visionFailed: 0, imagesMissing: 0, messages: [], message: mode === 'background' ? '正在准备背景阅读' : mode === 'scan' ? '正在启动采集' : '正在分析未处理记录' };
    this.store.data.jobs.push(job);
    this.store.data.jobs = this.store.data.jobs.slice(-100);
    const controller = new AbortController();
    this.active = { job, controller, promise: null };
    try { await this.store.save(); } catch (error) { this.active = null; throw error; }
    const promise = this.run(job, options, mode, controller.signal).catch(error => {
      // Background persistence errors must not become unhandled rejections in DSH.
      job.status = 'failed'; job.message = '任务或本地保存失败：' + error.message;
      job.endedAt = new Date().toISOString();
    }).finally(() => { if (this.active?.job.id === job.id) this.active = null; });
    this.active.promise = promise;
    return { jobId: job.id, message: '任务已启动，请在巡查面板查看进度', panelPath: '/plugins/dafeiyu-patrol' };
  }
  async run(job, options, mode, signal) {
    const progress = event => {
      const message = typeof event === 'string' ? event : event.message;
      if (event.type === 'attempt') job.notesAttempted++;
      if (event.type === 'excluded') job.notesExcluded += event.count;
      if (event.type === 'skip') job.skippedNotes.push({ url: event.url, code: event.code, reason: event.reason });
      job.message = message; job.messages.push({ at: new Date().toISOString(), message }); job.messages = job.messages.slice(-100); };
    let analysisUsed = 0, visionUsed = 0;
    const preparedNotes = new Set();
    const prepareImages = async item => {
      if (item.kind !== 'note' || !item.coverage?.imageCount || preparedNotes.has(item.id)) return;
      preparedNotes.add(item.id);
      if (!options.analyze || !options.readImages) return;
      const key = this.model.visionKey?.(item, options);
      if (key && item.vision?.key === key && !item.vision.error) { job.visionCached++; }
      else if (visionUsed < options.maxVision) {
        visionUsed++; progress(`读取第 ${visionUsed} 篇配图／上限 ${options.maxVision}`);
        try { item.vision = { ...await this.model.readImages(item, options, signal), key }; job.visionRead++; }
        catch (error) {
          if (signal.aborted) throw error;
          item.vision = { pages: [], complete: false, error: error.message, key }; job.visionFailed++; progress(`图片读取失败：${error.message}`);
        }
        await this.store.save();
      }
      if (!item.vision?.complete) job.imagesMissing++;
    };
    const prepareContext = async item => {
      if (item.kind !== 'comment') return;
      const noteId = /^comment:([a-f0-9]{24}):/i.exec(item.sourceKey || '')?.[1];
      const parent = noteId && this.store.data.items.find(i => i.kind === 'note' && i.sourceKey === `note:${noteId}`);
      if (!parent) return;
      await prepareImages(parent);
      const marker = '\n\n【所属笔记配图补充】\n';
      item.context = (item.context || '').split(marker)[0] + (parent.coverage?.imageCount ? marker + imageContext(parent, 6000) : '');
      item.coverage.contextImagesUnread = !!parent.coverage?.imageCount && !parent.vision?.complete;
    };
    const process = async item => {
      signal.throwIfAborted();
      if (!options.analyze || (item.readAt && !mode.startsWith('item:'))) return;
      // Continuing analysis must skip finished items before any repeated image work.
      if (mode === 'analyze' && item.analysis && !item.analysisError && !this.isStale(item)) { job.cached++; return; }
      if (analysisUsed < options.maxAnalysis) { await prepareImages(item); await prepareContext(item); }
      if (options.backgroundExpanded !== undefined) item.backgroundExpanded = options.backgroundExpanded;
      const key = this.model.cacheKey(item, options);
      if (item.analysis && item.analysisKey === key && !mode.startsWith('item:')) { job.cached++; return; }
      if (!options.analyze || analysisUsed >= options.maxAnalysis) return;
      if (item.analysis) item.history = [...(item.history || []), { text: item.text, analysis: item.analysis, review: item.review, readAt: item.readAt, at: new Date().toISOString(), reason: '重新分析' }].slice(-5);
      analysisUsed++;
      progress(`模型分析第 ${analysisUsed} 条／上限 ${options.maxAnalysis}`);
      try {
        // A picture-only note needs a successful visual reading first.
        if (!analysisMaterial(item).text.trim() && !item.vision?.pages?.length) {
          item.analysis = { decision: 'uncertain', categories: ['信息不足'], reason: '未读到文字，图片内容尚未识别。', evidence: [], uncertainties: ['图片文字未识别'], confidence: 0, analyzedAt: new Date().toISOString() };
        } else item.analysis = await this.model.analyze(item, options, signal, { onVerification: () => job.verificationCalls++ });
        item.analysisKey = key; item.analysisError = null; job.analyzed++;
      } catch (error) {
        if (signal.aborted) throw error;
        job.failed++; item.analysisError = error.message;
        progress(`分析失败：${error.message}`);
        // An outdated result must not look like the output of the current rubric/model.
        item.analysis = null; item.analysisKey = null;
      }
      await this.store.save();
    };
    try {
      if (mode === 'background') {
        await this.runBackground(job, options, signal, progress, prepareImages);
        job.status = job.backgroundErrors || job.skippedNotes.length || job.imagesMissing ? 'partial' : 'completed';
        progress(`背景阅读完成：已读 ${job.backgroundRead} 篇，背景文字调用 ${job.backgroundCalls} 次，复用背景 ${job.backgroundCached} 篇，阅读失败 ${job.backgroundErrors} 篇；看图读取 ${job.visionRead} 篇、复用 ${job.visionCached} 篇、失败 ${job.visionFailed} 篇。未进行内容分类。`);
        return;
      } else if (mode === 'evaluate') {
        const fixture = await loadEvaluationCases();
        const report = { jobId: job.id, fixtureVersion: fixture.version, fixtureHash: hash(JSON.stringify(fixture)),
          description: fixture.description, startedAt: job.startedAt, rules: options.rules, rulesHash: hash(options.rules),
          route: this.model.selection?.(options) || null, background: options.backgroundContext ? publicProfile(options.backgroundContext) : null, rows: [], complete: false };
        this.store.data.evaluation = report;
        try {
          for (const sample of fixture.cases) {
            signal.throwIfAborted();
            if (analysisUsed >= options.maxAnalysis) break;
            analysisUsed++; progress(`示例评估 ${analysisUsed}／${fixture.cases.length}：${sample.label}`);
            const row = { ...sample };
            try { row.analysis = await this.model.analyze(evaluationItem(sample), options, signal, { onVerification: () => job.verificationCalls++ }); job.analyzed++; }
            catch (error) { if (signal.aborted) throw error; row.error = error.message; job.failed++; }
            report.verificationCalls = job.verificationCalls; report.rows.push(row); report.summary = summarizeEvaluation(report.rows, fixture.cases.length);
            await this.store.save();
          }
          report.complete = report.rows.length === fixture.cases.length;
        } finally {
          report.summary = summarizeEvaluation(report.rows, fixture.cases.length);
          report.verificationCalls = job.verificationCalls; report.endedAt = new Date().toISOString();
        }
      } else if (mode === 'scan') {
        const excludedNoteIds = options.excludeSeen ? [...this.store.data.seenCache.ids] : [];
        for await (const record of this.browser.collect({ ...options, excludedNoteIds }, signal, progress)) {
          job.collected++; if (record.kind === 'note') job.notesRead++; const item = await this.store.upsert(record); await process(item); await this.store.save();
        }
        if (job.collected === 0 && job.notesExcluded > 0 && job.skippedNotes.length === 0) {
          job.status = 'completed'; progress(`本次搜索范围内没有发现新笔记，已排除 ${job.notesExcluded} 篇查过的笔记。可换关键词，或取消“排除已查过的笔记”重新检查正文及新评论。`); return;
        }
        if (job.collected === 0) throw new Error(`检查 ${job.notesAttempted} 篇，未读到可分析内容，${job.skippedNotes.length} 篇未读取。请查看漏采原因，或在 App 中复制原文导入。`);
      } else {
        const candidates = mode.startsWith('item:') ? this.store.data.items.filter(i => i.id === mode.slice(5)) : [...this.store.data.items];
        candidates.sort((a, b) => (a.kind === 'note' ? 0 : 1) - (b.kind === 'note' ? 0 : 1));
        for (const item of candidates) { if (analysisUsed >= options.maxAnalysis) break; await process(item); }
      }
      job.status = job.skippedNotes.length || job.failed || job.imagesMissing ? 'partial' : 'completed';
      const coverage = mode === 'scan' ? `排除已查 ${job.notesExcluded} 篇；检查 ${job.notesAttempted} 篇，读到 ${job.notesRead} 篇，${job.skippedNotes.length} 篇未读取。` : '';
      progress(`${job.status === 'partial' ? '部分完成' : '完成'}：${coverage}采集 ${job.collected} 条，分析 ${job.analyzed} 条，复用 ${job.cached} 条，失败 ${job.failed} 条；疑似问题证据核对 ${job.verificationCalls} 次；配图读取 ${job.visionRead} 篇、复用 ${job.visionCached} 篇、失败 ${job.visionFailed} 篇、不完整 ${job.imagesMissing} 篇。`);
    } catch (error) {
      job.status = signal.aborted ? 'cancelled' : error instanceof NeedsAttention ? 'paused' : 'failed';
      if (mode === 'background' && this.store.data.background.draft?.jobId === job.id) Object.assign(this.store.data.background.draft, { status: job.status, error: error.message });
      progress(signal.aborted ? '任务已停止，已保存的内容仍可复核。' : error.message);
    } finally { job.endedAt = new Date().toISOString(); await this.store.save(); }
  }
  background() {
    const b = this.store.data.background;
    return { preset: communityBackgroundInfo, enabled: b.enabled, active: publicProfile(b.active), draft: publicProfile(b.draft),
      history: b.history.map(p => ({ id: p.id, createdAt: p.createdAt, articlesRead: p.readings.length })),
      articles: this.store.data.items.filter(i => i.kind === 'note').map(i => ({ id: i.id, title: i.title, url: i.url, imageCount: i.coverage?.imageCount || 0, savedImages: i.images?.filter(p => p.attachment).length || 0, capturedAt: i.capturedAt })) };
  }
  async useCommunityBackground() {
    if (this.active) throw new Error('任务进行中，请先停止或等待完成');
    const previous = structuredClone(this.store.data.background);
    const b = this.store.data.background;
    const profile = createCommunityBackground(this.store.data.items, b.active);
    if (b.active) b.history = [...b.history, structuredClone(b.active)].slice(-3);
    b.active = profile; b.draft = null; b.enabled = true;
    try { await this.store.save(); } catch (error) { this.store.data.background = previous; throw error; }
    return { message: '已使用36篇材料的扩大阅读整理；后续分析会携带该背景，旧背景已保留。', ...this.background() };
  }
  async updateBackground(input) {
    if (this.active) throw new Error('任务进行中，请先停止或等待完成');
    const change = backgroundUpdateSchema.parse(input); const b = this.store.data.background;
    const previous = structuredClone(b);
    if (change.memo !== undefined) {
      if (!b.active) throw new Error('请先完成一次背景阅读');
      if (b.active.memo !== change.memo) {
        b.history = [...b.history, structuredClone(b.active)].slice(-3);
        b.active = { ...b.active, id: randomUUID(), memo: change.memo, editedAt: new Date().toISOString() };
        b.active.hash = backgroundHash(b.active);
      }
    }
    if (change.enabled !== undefined) b.enabled = change.enabled;
    try { await this.store.save(); } catch (error) { this.store.data.background = previous; throw error; }
    return { message: '背景设置已保存；后续分析将使用当前背景。', ...this.background() };
  }
  async startBackground(input) {
    const plan = backgroundStartSchema.parse(input);
    if (plan.source === 'existing') {
      const notes = this.store.data.items.filter(i => i.kind === 'note');
      if (plan.ids?.some(id => !notes.some(n => n.id === id))) throw new Error('所选背景文章不存在');
      plan.ids = (plan.ids || notes.slice(0, plan.count).map(n => n.id)).slice(0, plan.count);
      if (!plan.ids.length) throw new Error('请先采集文章，或改用指定链接/关键词');
      plan.urls = plan.refreshSources ? plan.ids.map(id => notes.find(n => n.id === id)?.url).filter(Boolean) : [];
    }
    if (plan.source === 'urls' && !plan.urls.length) throw new Error('请提供背景文章链接');
    return this.start({ urls: plan.urls, ...(plan.source === 'search' ? { keywords: plan.keywords || this.store.data.settings.keywords } : {}),
      maxNotes: plan.count, maxComments: Math.min(10, this.store.data.settings.maxComments), readImages: true, maxVision: plan.count, analyze: true, excludeSeen: false }, 'background', plan);
  }
  async runBackground(job, options, signal, progress, prepareImages) {
    const plan = job.backgroundPlan; const b = this.store.data.background;
    const cachedReadings = [b.active, ...(b.history || []), b.draft].filter(Boolean).flatMap(p => p.readings || []);
    const draft = { id: randomUUID(), jobId: job.id, status: 'reading', createdAt: new Date().toISOString(), requestedCount: plan.count,
      source: plan.source, readings: [], errors: [], memo: '', previousActiveId: b.active?.id || null };
    b.draft = draft; await this.store.save();
    const notes = new Map(); const refreshedKeys = new Set();
    if (plan.source === 'existing') for (const id of plan.ids) { const note = this.store.data.items.find(i => i.id === id); notes.set(note.sourceKey || note.id, note); }
    if (plan.source !== 'existing' || plan.refreshSources && plan.urls.length) {
      for await (const record of this.browser.collect({ ...options, excludedNoteIds: [] }, signal, progress)) {
        job.collected++; const item = await this.store.upsert(record);
        if (item.kind === 'note') { job.notesRead++; notes.set(item.sourceKey || item.id, item); refreshedKeys.add(item.sourceKey || item.id); }
        await this.store.save();
      }
    }
    const selected = [...notes.values()].slice(0, plan.count);
    if (!selected.length) throw new Error('未读到可用的背景文章；之前的背景保留');
    for (const [index, note] of selected.entries()) {
      signal.throwIfAborted(); await prepareImages(note);
      const noteId = /^note:([a-f0-9]{24})$/i.exec(note.sourceKey || '')?.[1];
      const comments = noteId ? this.store.data.items.filter(i => i.kind === 'comment' && i.sourceKey?.startsWith(`comment:${noteId}:`)) : [];
      const material = readingMaterial(note, comments);
      const refreshed = refreshedKeys.has(note.sourceKey || note.id);
      if (plan.source === 'existing' && plan.refreshSources && !refreshed) material.coverage.sourceRefreshMissing = true;
      const ref = `B${index + 1}`;
      progress(`背景阅读 ${index + 1}／${selected.length}：${note.title}`);
      try {
        const route = this.model.selection?.(options);
        const readingKey = backgroundReadingKey(material, route);
        const previous = cachedReadings.find(r => r.route && backgroundReadingKey(r, r.route) === readingKey);
        let reading;
        if (previous) {
          try { reading = { ...parseReading(JSON.stringify(previous), material), route: previous.route, usage: previous.usage, reusedFrom: previous.itemId }; } catch { /* Invalid cached quotes require a fresh bounded call. */ }
        }
        if (reading) job.backgroundCached++;
        else { job.backgroundCalls++; reading = await this.model.readBackground(material, options, signal); }

        draft.readings.push({ ...reading, ...material, ref, itemId: note.id, sourceKey: note.sourceKey, title: note.title, url: note.url, contentHash: note.contentHash, refreshed, capturedAt: note.lastSeenAt || note.capturedAt });
        job.backgroundRead++;
      } catch (error) {
        if (signal.aborted) throw error;
        job.backgroundErrors++; draft.errors.push({ ref, itemId: note.id, title: note.title, error: error.message }); progress(`背景阅读失败：${error.message}`);
      }
      await this.store.save();
    }
    if (!draft.readings.length) throw new Error('背景文章均未成功理解；之前的背景保留');
    signal.throwIfAborted(); draft.status = 'summarizing'; job.backgroundCalls++; progress('正在整理有来源的背景笔记'); await this.store.save();
    const summary = await this.model.summarizeBackground(draft.readings, options, signal); signal.throwIfAborted();
    Object.assign(draft, summary, { generatedMemo: summary.memo, status: 'ready', completedAt: new Date().toISOString() });
    draft.hash = backgroundHash(draft);
    if (b.active) b.history = [...b.history, structuredClone(b.active)].slice(-3);
    b.active = structuredClone(draft); b.enabled = true; await this.store.save();
  }
  async stop() {
    if (!this.active) return { message: '没有正在运行的任务' };
    const active = this.active; active.controller.abort(new Error('用户停止任务')); await active.promise;
    return { message: '任务已停止' };
  }
  async resume(input = {}) {
    if (this.active) throw new Error('已有任务运行中，请先停止或等待完成');
    const { jobId } = resumeSchema.parse(input);
    const job = jobId ? this.store.data.jobs.find(j => j.id === jobId) : this.store.data.jobs.at(-1);
    if (!job || !['paused', 'cancelled', 'interrupted'].includes(job.status)) throw new Error('没有可继续的已停止或暂停任务');
    if (job.mode === 'evaluate') throw new Error('评估任务请到“示例评估”重新运行');
    const { keywords, urls, maxNotes, maxComments, maxAnalysis, analyze, excludeSeen, readImages, maxImagesPerNote, maxVision, backgroundExpanded } = job.options;
    const options = { ...(urls?.length ? { urls } : keywords?.length ? { keywords } : {}), maxNotes, maxComments, maxAnalysis, analyze, excludeSeen, readImages, maxImagesPerNote, maxVision, backgroundExpanded };
    // Stopped scans may already have saved records that their seen-note cache would skip.
    const mode = job.mode === 'scan' && job.status !== 'paused' && analyze && this.state().counts.pending > 0 ? 'analyze' : job.mode;
    const result = await this.start(options, mode, job.backgroundPlan);
    return { ...result, message: mode === 'analyze' ? '已继续分析未完成内容，跳过已阅和当前规则下已完成的分析；仍遵守每轮上限。' : mode === 'scan' ? '已按原范围继续采集；已查笔记去重，已有分析可复用。' : '任务已继续，已保存的结果保留。' };
  }
  async import(input) {
    if (this.active) throw new Error('请等当前任务结束后再导入');
    const data = importSchema.parse(input);
    if (data.url) data.url = validateNoteUrl(data.url);
    const item = await this.store.upsert({ ...data, author: '', coverage: { source: 'manual', imagesUnread: false, textTruncated: false, parentMissing: false } });
    if (data.analyze) await this.start({ maxAnalysis: 1 }, `item:${item.id}`);
    return { id: item.id, message: data.analyze ? '已导入，正在分析' : '已导入' };
  }
  async dispose() { await this.stop(); await this.browser.close(); }
}
