import { randomUUID } from 'node:crypto';
import { startSchema, settingsSchema, reviewSchema, resumeSchema, readSchema, importSchema, validateNoteUrl } from './schema.js';
import { NeedsAttention } from './browser.js';
import { BROWSER_DISABLED_MESSAGE } from './disabled-browser.js';
import { loadEvaluationCases, evaluationItem, summarizeEvaluation } from './evaluation.js';
import { analysisMaterial, imageContext } from './images.js';
import { hash } from './store.js';
import { backgroundStartSchema, backgroundUpdateSchema, readingMaterial, backgroundHash, activeBackground, publicProfile, backgroundReadingKey, parseReading } from './background.js';

import { communityBackgroundInfo } from './community-background.js';
import { discussionHash, discussionBatches } from './discussion.js';
import { BUILTIN_DS_CONTEXT, CONTEXT_TEMPLATE, CONTEXT_JSON_SCHEMA, parseContext, loadedContext, topicInput, createConfigBackground, exportContext, contextView } from './topic-context.js';
import { discussionUnits, findUnit } from './units.js';
import { SEARCH_OPTIONS, searchSummary } from './search-options.js';

export class PatrolEngine {
  constructor(store, browser, model, apiCollector = null) { this.store = store; this.browser = browser; this.model = model; this.apiCollector = apiCollector; this.active = null; }
  async init() { await this.store.init(); await this.apiCollector?.init(); return this; }
  itemOptions(item, options) { const unit = findUnit(item, this.store.data.items); const records = unit && !unit.standalone ? unit.records : null; return records ? { ...options, discussionHash: discussionHash(records) } : options; }
  isStale(item) { return !!item.analysis && !!this.model.cacheKey && item.analysisKey !== this.model.cacheKey(item, this.itemOptions(item, this.analysisSettings(this.store.data.settings))); }
  analysisSettings(settings) { return { ...settings, backgroundContext: activeBackground(this.store.data), topicContext: topicInput(this.store.data.context?.active) }; }
  unitView(unit) {
    const settings = this.analysisSettings(this.store.data.settings);
    if (!unit.standalone) settings.discussionHash = discussionHash(unit.records);
    const entries = unit.members.map(({ history, ...item }) => {
      const analysisStale = !!item.analysis && !!this.model.cacheKey && item.analysisKey !== this.model.cacheKey(item, settings);
      // Changed context is informational. Only a missing/failed result enters
      // the ordinary queue; recomputing a saved result requires an explicit retry.
      return { ...item, analysisStale, inspectionResult: !item.analysis || item.analysisError ? null : item.analysis.decision === 'review' ? 'suspicious' : 'other' };
    });
    const read = entries.every(i => !!i.readAt);
    const activeEntries = read ? entries : entries.filter(i => !i.readAt);
    const suspicious = activeEntries.filter(i => i.inspectionResult === 'suspicious');
    const other = activeEntries.filter(i => i.inspectionResult === 'other');
    const pending = activeEntries.filter(i => !i.inspectionResult);
    const inspectionResult = suspicious.length ? 'suspicious' : pending.length ? null : 'other';
    const summary = { commentsRead: unit.comments.length, complete: !!unit.records[0].discussion?.complete,
      limitations: unit.records[0].discussion?.limitations || [], pending: pending.length, suspicious: suspicious.length, other: other.length,
      total: entries.length, standalone: unit.standalone };
    const representative = unit.note || unit.members[0];
    return { ...representative, kind: unit.standalone ? representative.kind : 'discussion', entries,
      noteId: unit.note?.id || null, readAt: read ? representative.readAt || entries[0].readAt : null,
      inspectionResult, analysisStale: entries.some(i => i.analysisStale), discussionSummary: summary };
  }
  unitViews() { return discussionUnits(this.store.data.items).map(unit => this.unitView(unit)); }
  state() {
    const data = this.store.data, units = this.unitViews(), unread = units.filter(i => !i.readAt);
    const entries = unread.flatMap(i => i.entries.filter(e => !e.readAt));
    const suspicious = unread.filter(i => i.inspectionResult === 'suspicious').length;
    return { settings: data.settings, searchOptions: SEARCH_OPTIONS, policy: { version: 'community-environment-v8', contextGuide: this.store.data.context?.active?.config.interpretationNotes.join('\n') || '' }, context: contextView(data), dataService: { configured: !!this.apiCollector?.hasKey }, jobs: data.jobs.slice(-20).reverse(), counts: {
      total: units.length, unread: unread.length, read: units.length - unread.length, review: suspicious, suspicious,
      other: unread.filter(i => i.entries.some(e => !e.readAt && e.inspectionResult === 'other')).length,
      uncertain: unread.filter(i => i.entries.some(e => e.inspectionResult === 'other' && e.analysis?.decision === 'uncertain')).length,
      pending: unread.filter(i => i.entries.some(e => !e.readAt && !e.inspectionResult)).length,
      analysisFailed: unread.reduce((n, i) => n + i.entries.filter(e => !e.readAt && !!e.analysisError).length, 0),
      analysisFailedNotes: unread.filter(i => i.entries.some(e => !e.readAt && !!e.analysisError)).length,
      retainedResults: entries.filter(e => e.analysisStale && !!e.inspectionResult).length,
      entries: { unread: entries.length, suspicious: entries.filter(e => e.inspectionResult === 'suspicious').length,
        other: entries.filter(e => e.inspectionResult === 'other').length, pending: entries.filter(e => !e.inspectionResult).length },
      records: data.items.length, notes: data.items.filter(i => i.kind === 'note').length, comments: data.items.filter(i => i.kind === 'comment').length,
      discussions: units.filter(i => i.kind === 'discussion').length, standalone: units.filter(i => i.discussionSummary.standalone).length,
      unit: 'discussion',
    }, seenCache: { count: data.seenCache.ids.length, lastClearedAt: data.seenCache.clearedAt, canRestore: !!data.seenCache.previousIds?.length },
    collection: { canClear: !!data.items.length || !!data.seenCache.ids.length || data.jobs.some(j => j.mode === 'scan' || j.mode === 'analyze' || j.mode?.startsWith('item:')), canRestore: !!data.collectionTrash, backupRecords: data.collectionTrash?.items?.length || 0, clearedAt: data.collectionTrash?.clearedAt || null },
    background: { enabled: data.background.enabled, activeId: data.background.active?.id || null, articlesRead: data.background.active?.readings.length || 0 }, browserOpen: false, browserEnabled: false, activeJob: this.active?.job.id || null };
  }
  results({ filter = 'all', limit = 50, offset = 0 } = {}) {
    const archive = filter === 'read' || filter === 'reviewed';
    const items = this.unitViews().filter(item => archive ? !!item.readAt : !item.readAt &&
      (filter === 'all' || filter === 'unread' || (filter === 'unanalyzed' ? item.entries.some(e => !e.readAt && !e.inspectionResult) :
        filter === 'suspicious' || filter === 'review' ? item.inspectionResult === 'suspicious' :
        filter === 'other' || filter === 'normal' ? item.entries.some(e => !e.readAt && e.inspectionResult === 'other') :
        filter === 'uncertain' && item.entries.some(e => e.inspectionResult === 'other' && e.analysis?.decision === 'uncertain'))));
    return { total: items.length, unit: 'discussion', items: items.slice(offset, offset + limit) };
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
  async clearCollection() {
    if (this.active) throw new Error('任务进行中，请先停止任务再清空采集记录');
    const cleared = await this.store.clearCollection();
    return { cleared: cleared.count, message: cleared.changed ? `已清空${cleared.count}条采集记录、对应巡查任务及已查缓存。模型、规则、背景和密钥保留，可撤销本次清空。` : '采集记录已经为空。' };
  }
  async restoreCollection() {
    if (this.active) throw new Error('任务进行中，请先停止任务再撤销采集记录清空');
    const restored = await this.store.restoreCollection();
    return { restored, message: `已撤销采集记录清空，恢复${restored}条原记录；清空后新采集的内容保留。` };
  }
  async settings(input) {
    if (this.active) throw new Error('任务进行中，请先停止任务再修改设置');
    if (input.collectionSource === 'browser') throw new Error(BROWSER_DISABLED_MESSAGE);
    const previous = this.store.data.settings;
    this.store.data.settings = settingsSchema.parse({ ...input, collectionSource: 'socialdatax' });
    try { await this.store.save(); } catch (error) { this.store.data.settings = previous; throw error; }
    return this.state();
  }
  async dataKey(input) {
    if (this.active) throw new Error('任务进行中，请先停止任务再修改数据服务密钥');
    if (!this.apiCollector) throw new Error('当前宿主未启用数据服务');
    if (typeof input.apiKey !== 'string') throw new Error('请输入数据服务 API Key');
    await this.apiCollector.setKey(input.apiKey);
    return { message: input.apiKey.trim() ? '数据服务密钥已保存在本机；未发起付费调用。' : '数据服务密钥已清除。', configured: this.apiCollector.hasKey };
  }
  async *collectRecords(options, signal, progress) {
    if (options.collectionSource !== 'socialdatax') throw new Error(BROWSER_DISABLED_MESSAGE);
    if (!this.apiCollector) throw new Error('当前宿主未启用数据服务');
    for await (const bundle of this.apiCollector.collect(options, signal, progress)) {
      // Save comments before committing the note's complete snapshot and seen-cache entry.
      for (const comment of bundle.comments) yield comment; if (bundle.note) yield bundle.note;
    }
  }
  async retry(input) {
    const { id, backgroundExpanded } = readSchema.parse(input);
    if (!this.store.data.items.some(i => i.id === id)) throw new Error('没有找到这条记录');
    const item = this.store.data.items.find(i => i.id === id);
    const unit = findUnit(item, this.store.data.items);
    return this.start({ maxAnalysis: 1, discussionNoteLimit: 1, ...(unit?.standalone ? { maxVision: 1 } : {}), backgroundExpanded }, `item:${id}`);
  }
  async markRead(input) {
    const data = readSchema.parse(input);
    const item = this.store.data.items.find(i => i.id === data.id);
    if (!item) throw new Error('没有找到这条记录');
    const unit = findUnit(item, this.store.data.items), members = unit?.members || [item];
    const previous = members.map(i => i.readAt), now = new Date().toISOString();
    for (const member of members) member.readAt = data.read ? member.readAt || now : null;
    try { await this.store.save(); } catch (error) { members.forEach((i, n) => { i.readAt = previous[n]; }); throw error; }
    return { id: item.id, readAt: item.readAt, message: data.read ? '整篇已阅，正文及已保存评论已从当前列表移除。可在“已阅”中查看。' : '整篇已恢复到未阅列表。' };
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
  async start(input = {}, mode = 'scan', backgroundPlan = null, resumeOnlyPending = false, remainingTargetIds) {
    if (this.active) throw new Error('已有任务运行中，请先停止或等待完成');
    const options = this.analysisSettings(this.options(input));
    const needsCollection = mode === 'scan' || mode === 'background' && (backgroundPlan?.source !== 'existing' || backgroundPlan?.refreshSources && backgroundPlan?.urls?.length);
    if (needsCollection && options.collectionSource !== 'socialdatax') throw new Error(BROWSER_DISABLED_MESSAGE);
    if (needsCollection && !this.apiCollector?.hasKey) throw new Error('请先在“规则与设置”填写 SocialDataX API Key，或导入原文进行离线分析');
    const job = { id: randomUUID(), mode, resumeOnlyPending, ...(remainingTargetIds ? { remainingTargetIds: [...remainingTargetIds] } : {}), status: 'running', startedAt: new Date().toISOString(),
      options: { ...options, backgroundContext: undefined }, backgroundId: options.backgroundContext?.id || null, backgroundPlan, backgroundRead: 0, backgroundCached: 0, backgroundCalls: 0, backgroundErrors: 0, searchSummary: searchSummary(options), notesAttempted: 0, notesRead: 0, notesExcluded: 0, skippedNotes: [], collected: 0, analyzed: 0, cached: 0, failed: 0, verificationCalls: 0, quoteRepairCalls: 0, discussionCalls: 0, apiRequests: 0, apiCostCents: 0, apiUnconfirmed: 0, discussionGaps: [], visionRead: 0, visionCached: 0, visionFailed: 0, imagesMissing: 0, messages: [], message: mode === 'background' ? '正在准备背景阅读' : mode === 'scan' ? '正在启动采集' : '正在分析未处理记录' };
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
      if (event.type === 'api') { job.apiRequests = event.attempts; job.apiCostCents = event.costCents; job.apiUnconfirmed = event.unknown; }
      if (event.type === 'api-stop') job.apiStopReason = event.message;
      job.message = message; job.messages.push({ at: new Date().toISOString(), message }); job.messages = job.messages.slice(-100); };
    let analysisUsed = 0, standaloneUsed = 0, visionUsed = 0;
    let discussionsUsed = 0;
    const discussionCap = options.discussionNoteLimit || 5;
    const preparedNotes = new Set();
    const prepareImages = async item => {
      if (!item.coverage?.imageCount || preparedNotes.has(item.id)) return;
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
      // Ordinary runs never broaden into recomputing saved conclusions, even
      // when images, background, rules or the selected model have changed.
      if ((!mode.startsWith('item:') || job.resumeOnlyPending) && item.analysis && !item.analysisError) { job.cached++; return; }
      if (standaloneUsed < options.maxAnalysis) { await prepareImages(item); await prepareContext(item); }
      if (options.backgroundExpanded !== undefined) item.backgroundExpanded = options.backgroundExpanded;
      const key = this.model.cacheKey(item, options);
      if (!options.analyze || standaloneUsed >= options.maxAnalysis) return;
      if (item.analysis) item.history = [...(item.history || []), { text: item.text, analysis: item.analysis, review: item.review, readAt: item.readAt, at: new Date().toISOString(), reason: '重新分析' }].slice(-5);
      analysisUsed++; standaloneUsed++;
      progress(`单独导入分析第 ${standaloneUsed} 条／上限 ${options.maxAnalysis}`);
      try {
        // A picture-only note needs a successful visual reading first.
        if (!analysisMaterial(item).text.trim() && !item.vision?.pages?.length) {
          item.analysis = { decision: 'uncertain', categories: ['信息不足'], reason: '未读到文字，图片内容尚未识别。', evidence: [], uncertainties: ['图片文字未识别'], confidence: 0, analyzedAt: new Date().toISOString() };
        } else item.analysis = await this.model.analyze(item, options, signal, { onVerification: () => job.verificationCalls++, onRepair: () => { job.quoteRepairCalls++; progress('模型引文校验未通过，单独修复一次；严格校验仍保留，模型费用另计'); } });
        item.analysisKey = key; item.analysisError = null; job.analyzed++;
      } catch (error) {
        if (signal.aborted) throw error;
        job.failed++; item.analysisError = error.message;
        progress(`分析失败：${error.message}`);
        // Keep a previous conclusion on failed explicit recomputation. The
        // error remains pending and the UI identifies the saved conclusion.
      }
      await this.store.save();
    };
    const processedDiscussions = new Set();
    const processDiscussion = async (item, force = false) => {
      let unit = findUnit(item, this.store.data.items);
      if (!unit || unit.standalone) return process(item);
      if (processedDiscussions.has(unit.key)) return; processedDiscussions.add(unit.key);
      if (!options.analyze) return;
      if (!this.model.analyzeDiscussion) throw new Error('当前模型适配器不支持整篇讨论分析');
      const candidates = unit.members.filter(i => mode.startsWith('item:') || !i.readAt);
      if (!candidates.length) return;
      let records = unit.records;
      const pending = candidates.filter(i => {
        if (!force && i.analysis && !i.analysisError && !job.remainingTargetIds?.includes(i.id)) { job.cached++; return false; }
        return true;
      });
      if (!pending.length) return;
      if (discussionsUsed >= discussionCap) { job.analysisDeferred = true; return; }
      discussionsUsed++; job.discussionsAttempted = discussionsUsed;
      if (force) { job.remainingTargetIds = pending.map(i => i.id); await this.store.save(); }
      for (const record of unit.members) {
        if (force && this.apiCollector?.retrySavedImages) {
          const recovered = await this.apiCollector.retrySavedImages(record, signal);
          if (recovered) { progress(`重新下载已保存链接中的配图 ${recovered} 张；未重新查询数据 API`); await this.store.save(); }
        }
        await prepareImages(record);
      }
      const note = unit.note;
      for (const comment of unit.comments) comment.coverage = { ...comment.coverage,
        contextImagesUnread: !!note?.coverage?.imageCount && !note.vision?.complete,
        contextMediaUnread: !!note?.coverage?.unsupportedMedia,
        discussionIncomplete: !records[0].discussion?.complete };
      unit = findUnit(item, this.store.data.items); records = unit.records;
      const settings = { ...options, discussionHash: discussionHash(records) };
      for (const i of pending) {
        if (options.backgroundExpanded !== undefined) i.backgroundExpanded = options.backgroundExpanded;
      }
      let processed = 0;
      for (const targets of discussionBatches(pending)) {
        signal.throwIfAborted(); analysisUsed += targets.length;
        progress(`整篇分析第 ${discussionsUsed} 篇／上限 ${discussionCap}：“${records[0].title}”及${unit.comments.length}条已保存评论，已处理${processed}／${pending.length}条；本批${targets.length}条${targets.some(i => i.analysisError) ? '，失败项单独重试' : ''}`);
        let results;
        try { results = await this.model.analyzeDiscussion(records, targets, settings, signal, { onVerification: () => job.verificationCalls++, onRepair: () => { job.quoteRepairCalls++; progress('模型引文校验未通过，单独修复一次；严格校验仍保留，模型费用另计'); }, onDiscussionCall: () => job.discussionCalls++ }); }
        catch (error) { if (signal.aborted) throw error; results = targets.map(i => ({ id: i.id, error: error.message })); }
        for (const target of targets) {
          const row = results.find(r => r.id === target.id);
          if (target.analysis) target.history = [...(target.history || []), { text: target.text, analysis: target.analysis, review: target.review, images: target.images, vision: target.vision, readAt: target.readAt, at: new Date().toISOString(), reason: '结合整篇讨论重新分析' }].slice(-5);
          if (row?.analysis) { target.analysis = row.analysis; target.analysisKey = this.model.cacheKey(target, settings); target.analysisError = null; job.analyzed++; if (job.remainingTargetIds) job.remainingTargetIds = job.remainingTargetIds.filter(id => id !== target.id); }
          else { target.analysisError = row?.error || '整篇讨论分析遗漏本条'; job.failed++; }
        }
        processed += targets.length;
        await this.store.save();
      }
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
            try { row.analysis = await this.model.analyze(evaluationItem(sample), options, signal, { onVerification: () => job.verificationCalls++, onRepair: () => { job.quoteRepairCalls++; progress('模型引文校验未通过，单独修复一次；严格校验仍保留，模型费用另计'); } }); job.analyzed++; }
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
        const notes = [];
        for await (const record of this.collectRecords({ ...options, excludedNoteIds }, signal, progress)) {
          job.collected++; if (record.kind === 'note') { job.notesRead++; if (record.discussion && !record.discussion.complete) job.discussionGaps.push({ title: record.title, limitations: record.discussion.limitations }); }
          const item = await this.store.upsert(record, { persist: options.collectionSource !== 'socialdatax' });
          notes.push(item);
          if (options.collectionSource !== 'socialdatax' || record.kind === 'note' || job.collected % 20 === 0) await this.store.save();
        }
        for (const note of notes) await processDiscussion(note);
        if (job.collected === 0 && job.notesExcluded > 0 && job.skippedNotes.length === 0) {
          job.status = 'completed'; progress(`本次搜索范围内没有发现新笔记，已排除 ${job.notesExcluded} 篇查过的笔记。可换关键词，或取消“排除已查过的笔记”重新检查正文及新评论。`); return;
        }
        if (job.collected === 0) throw new Error(`检查 ${job.notesAttempted} 篇，未读到可分析内容，${job.skippedNotes.length} 篇未读取。请查看漏采原因，或在 App 中复制原文导入。`);
      } else {
        const candidates = mode.startsWith('item:') ? this.store.data.items.filter(i => i.id === mode.slice(5)) : [...this.store.data.items];
        candidates.sort((a, b) => (a.kind === 'note' ? 0 : 1) - (b.kind === 'note' ? 0 : 1));
        for (const item of candidates) await processDiscussion(item, mode.startsWith('item:') && !job.resumeOnlyPending);
      }
      job.status = job.skippedNotes.length || job.failed || job.imagesMissing || job.discussionGaps.length || job.apiStopReason || job.analysisDeferred ? 'partial' : 'completed';
      const deferred = job.analysisDeferred ? '达到本轮按篇分析上限，剩余篇目可继续分析。' : '';
      const coverage = mode === 'scan' ? `排除已查 ${job.notesExcluded} 篇；检查 ${job.notesAttempted} 篇，读到 ${job.notesRead} 篇，${job.skippedNotes.length} 篇未读取。` : '';
      progress(`${job.status === 'partial' ? '部分完成' : '完成'}：${coverage}${deferred}整篇分析 ${discussionsUsed} 篇；采集 ${job.collected} 条，分析 ${job.analyzed} 条，复用 ${job.cached} 条，失败 ${job.failed} 条；疑似问题证据核对 ${job.verificationCalls} 次；引文修复 ${job.quoteRepairCalls} 次；配图读取 ${job.visionRead} 篇、复用 ${job.visionCached} 篇、失败 ${job.visionFailed} 篇、不完整 ${job.imagesMissing} 篇。`);
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
  context() { return contextView(this.store.data); }
  contextFormat() { return { template: CONTEXT_TEMPLATE, jsonSchema: CONTEXT_JSON_SCHEMA, format: 'whale-watch-context', schemaVersion: 1, maxBytes: 300000, limits: { sources: 100, glossary: 100, memoChars: 24000 }, instructions: '背景sources的ref为B1、B2等，包含title、summary、可选url/observations/uncertainties/excerpts；glossary每项含term、meaning，可选aliases、usageNotes、status(source_claim/confirmed/uncertain)、sourceRefs、sources网址；interpretationNotes为字符串数组。只包含背景和术语；未知字段拒绝导入。confirmed仅是配置作者标注。' }; }
  exportContext() { return exportContext(this.store.data); }
  exportRecords() { return { exportedAt: new Date().toISOString(), rules: this.store.data.settings.rules, background: this.store.data.background, items: this.store.data.items }; }
  async readSavedImage(id, index) {
    const item = this.store.data.items.find(i => i.id === id);
    const image = item?.images?.find(i => i.index === index);
    if (!image?.attachment || !this.model.ctx?.attachments) throw new Error('配图未保存');
    return this.model.ctx.attachments.readImage(image.attachment);
  }
  async patchSettings(input) {
    const unknown = Object.keys(input).filter(key => !Object.hasOwn(settingsSchema.shape, key));
    if (unknown.length) throw new Error(`未知设置字段：${unknown.join('、')}`);
    for (const [provider, model] of [['provider', 'model'], ['visionProvider', 'visionModel']]) {
      if (Object.hasOwn(input, provider) !== Object.hasOwn(input, model)) throw new Error(`${provider} 与 ${model} 必须一起提供；都留空表示跟随默认模型`);
      if (Object.hasOwn(input, provider) && (!!input[provider] !== !!input[model])) throw new Error(`${provider} 与 ${model} 应一起填写或一起留空`);
    }
    return this.settings({ ...this.store.data.settings, ...input });
  }
  builtinContext() { return structuredClone(BUILTIN_DS_CONTEXT); }
  draftContext() { if (!this.store.data.context.draft) throw new Error('还没有配置草稿'); return structuredClone(this.store.data.context.draft.config); }
  validateContext(input) {
    const config = parseContext(input.configJson ?? input.config);
    return { config, name: config.name, sources: config.background.sources.length, terms: config.glossary.length, message: `格式校验通过：${config.name}，${config.background.sources.length}篇来源，${config.glossary.length}个术语。格式校验不验证来源事实。` };
  }
  async saveContextDraft(input) {
    const { config } = this.validateContext(input), c = this.store.data.context, previous = c.draft;
    c.draft = loadedContext(config, 'agent-draft');
    try { await this.store.save(); } catch (error) { c.draft = previous; throw error; }
    return { message: `已保存“${config.name}”配置草稿，尚未启用；可在专题页查看并点击“采用这份配置”。`, downloadPath: '/plugins/dafeiyu-patrol/api/context/draft/export', ...this.context() };
  }
  async importContext(input, origin = 'file') {
    if (this.active) throw new Error('任务进行中，请先停止或等待完成再切换专题');
    const { config } = this.validateContext(input), data = this.store.data;
    const previous = { context: data.context, background: data.background };
    const b = data.background;
    data.context = { active: loadedContext(config, origin), draft: null, previous: { active: data.context.active, draft: data.context.draft, background: structuredClone(b) } };
    data.background = { enabled: true, active: createConfigBackground(config), draft: null, history: [...b.history, ...(b.active ? [structuredClone(b.active)] : [])].slice(-3) };
    try { await this.store.save(); } catch (error) { Object.assign(data, previous); throw error; }
    return { message: `已载入“${config.name}”：背景和术语一同启用；记录、规则和旧分析保留，没有启动采集或模型调用。可撤销本次切换。`, ...this.context() };
  }
  contextDocument() { return { config: this.exportContext(), baseHash: this.store.data.context.active?.hash || null, backgroundId: this.store.data.background.active?.id || null }; }
  async editContext(input) {
    if (this.active) throw new Error('任务进行中，请先停止或等待完成再编辑专题');
    const data = this.store.data;
    if (input.baseHash !== (data.context.active?.hash || null) || input.backgroundId !== (data.background.active?.id || null)) throw new Error('专题已发生变化，请重新打开编辑资料');
    const { config } = this.validateContext(input);
    // The form edits material only; preserve provenance and local source bodies.
    const current = this.exportContext();
    if (config.id !== current.id || JSON.stringify(config.background.sources) !== JSON.stringify(current.background.sources)) throw new Error('编辑资料不能替换来源，请通过更换专题导入');
    const previous = { context: data.context, background: data.background };
    data.context = { active: loadedContext(config, 'edited'), draft: data.context.draft, previous: { active: data.context.active, draft: data.context.draft, background: structuredClone(data.background) } };
    const profile = data.background.active;
    data.background = { ...data.background, enabled: true, draft: null,
      active: profile ? { ...structuredClone(profile), id: randomUUID(), memo: config.background.memo, editedAt: new Date().toISOString() } : createConfigBackground(config) };
    if (data.background.active) data.background.active.hash = backgroundHash(data.background.active);
    try { await this.store.save(); } catch (error) { Object.assign(data, previous); throw error; }
    return { message: '专题资料已保存，背景和术语一同用于后续分析。', ...this.context() };
  }
  async useBuiltinContext() { return this.importContext({ config: BUILTIN_DS_CONTEXT }, 'builtin'); }
  async applyContextDraft() { return this.importContext({ config: this.draftContext() }, 'agent-draft'); }
  async unloadContext() {
    if (this.active) throw new Error('任务进行中，请先停止或等待完成再卸下专题');
    const data = this.store.data, previous = { context: data.context, background: data.background };
    data.context = { active: null, draft: data.context.draft, previous: { active: data.context.active, draft: data.context.draft, background: structuredClone(data.background) } };
    data.background = { ...data.background, active: null, draft: null };
    try { await this.store.save(); } catch (error) { Object.assign(data, previous); throw error; }
    return { message: '已卸下专题及背景；原文、规则和已保存结果保留。可撤销本次操作。', ...this.context() };
  }
  async undoContext() {
    if (this.active) throw new Error('任务进行中，请先停止或等待完成再撤销');
    const data = this.store.data, undo = data.context.previous;
    if (!undo) throw new Error('没有可撤销的专题修改');
    const previous = { context: data.context, background: data.background };
    data.context = { active: undo.active, draft: undo.draft || null, previous: null }; data.background = undo.background;
    try { await this.store.save(); } catch (error) { Object.assign(data, previous); throw error; }
    return { message: '已撤销上次修改，恢复原专题资料。', ...this.context() };
  }
  async useCommunityBackground() { return this.useBuiltinContext(); }
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
      for await (const record of this.collectRecords({ ...options, excludedNoteIds: [] }, signal, progress)) {
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
    if (!job || !(['paused', 'cancelled', 'interrupted'].includes(job.status) || job.status === 'partial' && job.analysisDeferred)) throw new Error('没有可继续的已停止、暂停或达到分析篇数上限的任务');
    if (job.mode === 'background') throw new Error('旧背景阅读已停用，请到专题页编辑资料或让 AI 制作配置');
    if (job.mode === 'evaluate') throw new Error('评估任务请到“示例评估”重新运行');
    const { keywords, urls, maxNotes, maxComments, maxAnalysis, analyze, excludeSeen, readImages, maxImagesPerNote, maxVision, backgroundExpanded, collectionSource, apiBudgetYuan, discussionAnalysisLimit, discussionNoteLimit, noteSort, publishTimeRange, noteType, commentSort } = job.options;
    const options = { ...(urls?.length ? { urls } : keywords?.length ? { keywords } : {}), maxNotes, maxComments, maxAnalysis, analyze, excludeSeen, readImages, maxImagesPerNote, maxVision, backgroundExpanded, collectionSource, apiBudgetYuan, discussionAnalysisLimit, discussionNoteLimit, noteSort: noteSort || 'time_descending', publishTimeRange: publishTimeRange || 'all', noteType: noteType || 'all', commentSort: commentSort || 'default' };
    // Stopped scans may already have saved records that their seen-note cache would skip.
    const mode = job.mode === 'scan' && job.status !== 'paused' && analyze && this.state().counts.pending > 0 ? 'analyze' : job.mode;
    let remainingTargetIds = job.remainingTargetIds;
    if (mode.startsWith('item:') && !Array.isArray(remainingTargetIds)) {
      // Upgrade interrupted explicit recomputations created before target
      // snapshots existed, using actual saved analysis timestamps.
      const item = this.store.data.items.find(i => i.id === mode.slice(5));
      const members = item ? findUnit(item, this.store.data.items)?.members || [item] : [];
      remainingTargetIds = members.filter(i => i.analysisError || !i.analysis?.analyzedAt || i.analysis.analyzedAt < job.startedAt).map(i => i.id);
    }
    const result = await this.start(options, mode, job.backgroundPlan, true, remainingTargetIds);
    return { ...result, message: mode === 'analyze' || mode.startsWith('item:') ? '已继续上次任务尚未完成和失败的内容，本次任务已完成的结果不会重复重算；仍遵守原范围和每轮上限。' : mode === 'scan' ? '已按原范围继续采集；已查笔记去重，已有成功结论不会重算。' : '任务已继续，已保存的结果保留。' };
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
