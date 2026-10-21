import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULT_RULES } from './rules.js';
import { BUILTIN_DS_CONTEXT, loadedContext } from './topic-context.js';
import { DEFAULT_SEARCH_SETTINGS } from './search-options.js';
export const hash = text => createHash('sha256').update(text).digest('hex');
export const defaultSettings = () => ({ ...DEFAULT_SEARCH_SETTINGS, collectionSource: 'socialdatax', apiBudgetYuan: 5, discussionAnalysisLimit: 500, discussionNoteLimit: 5, keywords: ['大肥鱼', 'DeepSeek拟人'], provider: '', model: '', maxNotes: 5, maxComments: 10, maxAnalysis: 55, readImages: true, visionProvider: '', visionModel: '', maxImagesPerNote: 18, maxVision: 5, rules: DEFAULT_RULES });
function collectedNoteId(item) {
  return item.kind === 'note' && (item.coverage?.source === 'rendered-dom' || item.coverage?.source === 'socialdatax' && item.discussion?.complete)
    ? item.sourceKey?.match(/^note:([a-f0-9]{24})$/i)?.[1]?.toLowerCase() : null;
}

export class Store {
  constructor(root) { this.root = root; this.path = join(root, 'state.json'); this.queue = Promise.resolve(); }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let existing = true;
    try { this.data = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('巡查数据文件无法读取，请保留原文件检查，未覆盖旧数据');
      existing = false;
      this.data = { version: 1, settings: defaultSettings(), items: [], jobs: [] };
    }
    if (this.data.version !== 1 || !Array.isArray(this.data.items) || !Array.isArray(this.data.jobs)) throw new Error('巡查数据格式不受支持');
    // Browser automation is disabled by product policy until risk controls are resolved.
    this.data.settings.collectionSource = 'socialdatax';
    this.data.settings = { ...defaultSettings(), ...this.data.settings };
    if (!this.data.defaultsRevision) {
      if (this.data.settings.maxNotes === 5 && this.data.settings.maxComments === 10 && this.data.settings.maxAnalysis === 15) this.data.settings.maxAnalysis = 55;
      this.data.defaultsRevision = 1;
    }
    for (const item of this.data.items) if (!Object.hasOwn(item, 'readAt')) item.readAt = ['confirmed', 'dismissed', 'uncertain'].includes(item.review?.verdict) ? item.review.at || item.capturedAt || new Date().toISOString() : null;
    if (!this.data.background) this.data.background = { enabled: true, active: null, draft: null, history: [] };
    // Older releases always supplied DS terminology. Preserve that environment
    // without replacing the user's background, rules, or saved analyses.
    if (!this.data.context) this.data.context = { active: existing ? loadedContext(BUILTIN_DS_CONTEXT, 'legacy') : null, draft: null, previous: null };
    // Migrate once. An explicitly empty cache must stay empty after a restart.
    if (!Object.hasOwn(this.data, 'seenCache')) this.data.seenCache = {
      ids: [...new Set(this.data.items.map(collectedNoteId).filter(Boolean))], clearedAt: null, previousIds: null,
    };
    const cache = this.data.seenCache;
    if (!cache || !Array.isArray(cache.ids) || !cache.ids.every(id => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id))
      || (cache.previousIds !== null && (!Array.isArray(cache.previousIds) || !cache.previousIds.every(id => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id))))) throw new Error('已查缓存格式不受支持，未覆盖旧数据');
    for (const job of this.data.jobs) if (['running', 'queued'].includes(job.status)) {
      job.status = 'interrupted'; job.message = 'DSH 上次退出时任务中断，可重新发起；已保存的结果仍可复核。'; job.endedAt = new Date().toISOString();
    }
    if (['reading', 'summarizing'].includes(this.data.background.draft?.status) && !this.data.jobs.some(j => j.id === this.data.background.draft.jobId && j.status === 'running')) { this.data.background.draft.status = 'interrupted'; this.data.background.draft.error = '上次背景阅读中断，旧背景保留；可以重新发起。'; }
    await this.save(); return this;
  }
  save() {
    const snapshot = JSON.stringify(this.data, null, 2);
    const next = this.queue.then(async () => {
      const temp = this.path + '.tmp';
      await writeFile(temp, snapshot, { mode: 0o600 }); await rename(temp, this.path);
    });
    this.queue = next.catch(() => {}); return next;
  }
  async clearSeenCache() {
    const cache = this.data.seenCache, count = cache.ids.length;
    if (count) {
      this.data.seenCache = { ids: [], clearedAt: new Date().toISOString(), previousIds: [...cache.ids] };
      try { await this.save(); } catch (error) { this.data.seenCache = cache; throw error; }
    }
    return count;
  }
  async restoreSeenCache() {
    const cache = this.data.seenCache;
    if (!cache.previousIds?.length) throw new Error('没有可撤销的缓存清理');
    const next = { ids: [...new Set([...cache.ids, ...cache.previousIds])], clearedAt: cache.clearedAt, previousIds: null };
    this.data.seenCache = next;
    try { await this.save(); } catch (error) { this.data.seenCache = cache; throw error; }
    return next.ids.length;
  }
  async clearAnalysisCache(targets) {
    const data = this.data, selected = new Map(targets.map(row => [row.id, row.sourceHash]));
    const entries = data.items.filter(item => item.analysis && selected.has(item.id)).map(item => ({
      id: item.id, sourceHash: selected.get(item.id),
      result: Object.fromEntries(['analysis', 'analysisKey', 'analysisError'].filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]])),
    }));
    if (!entries.length) return { count: 0, unreadCount: 0 };
    const ids = new Set(entries.map(row => row.id)), items = data.items, previous = data.analysisCacheTrash;
    const hadPrevious = Object.hasOwn(data, 'analysisCacheTrash');
    data.analysisCacheTrash = { clearedAt: new Date().toISOString(), entries };
    data.items = items.map(item => ids.has(item.id) ? { ...item, analysis: null, analysisKey: null, analysisError: null } : item);
    try { await this.save(); } catch (error) {
      data.items = items;
      if (hadPrevious) data.analysisCacheTrash = previous; else delete data.analysisCacheTrash;
      throw error;
    }
    return { count: entries.length, unreadCount: items.filter(item => ids.has(item.id) && !item.readAt).length };
  }
  async restoreAnalysisCache(sourceHashes) {
    const data = this.data, trash = data.analysisCacheTrash;
    if (!trash?.entries?.length) throw new Error('没有可撤销的旧结论清理');
    if (!Array.isArray(trash.entries) || trash.entries.some(row => !row?.id || typeof row.sourceHash !== 'string' || !row.result?.analysis)) {
      throw new Error('旧结论备份格式不受支持，未覆盖现有结果');
    }
    const backup = new Map(trash.entries.map(row => [row.id, row])), items = data.items;
    let count = 0;
    data.items = items.map(item => {
      const row = backup.get(item.id);
      // Restore only untouched cleared slots. A new result, failure, changed
      // discussion or newly captured record always wins over the backup.
      if (!row || item.analysis !== null || item.analysisKey !== null || item.analysisError !== null || sourceHashes.get(item.id) !== row.sourceHash) return item;
      const restored = { ...item };
      for (const key of ['analysis', 'analysisKey', 'analysisError']) delete restored[key];
      Object.assign(restored, row.result); count++; return restored;
    });
    data.analysisCacheTrash = null;
    try { await this.save(); } catch (error) { data.items = items; data.analysisCacheTrash = trash; throw error; }
    return { count, skipped: trash.entries.length - count };
  }
  async clearCollection() {
    const data = this.data;
    const isCollectionJob = j => j.mode === 'scan' || j.mode === 'analyze' || j.mode?.startsWith('item:');
    const jobs = data.jobs.filter(isCollectionJob), count = data.items.length;
    if (!count && !jobs.length && !data.seenCache.ids.length) return { count: 0, changed: false };
    const previous = { items: data.items, jobs: data.jobs, seenCache: data.seenCache, collectionTrash: data.collectionTrash };
    data.collectionTrash = { items: data.items, jobs, seenCache: data.seenCache, clearedAt: new Date().toISOString() };
    data.items = []; data.jobs = data.jobs.filter(j => !isCollectionJob(j));
    data.seenCache = { ids: [], clearedAt: data.collectionTrash.clearedAt, previousIds: null };
    try { await this.save(); } catch (error) { Object.assign(data, previous); throw error; }
    return { count, changed: true };
  }
  async restoreCollection() {
    const data = this.data, trash = data.collectionTrash;
    if (!trash) throw new Error('没有可撤销的采集记录清空');
    if (!Array.isArray(trash.items) || !Array.isArray(trash.jobs) || !Array.isArray(trash.seenCache?.ids)) throw new Error('采集记录备份格式不受支持，未覆盖现有数据');
    const previous = { items: data.items, jobs: data.jobs, seenCache: data.seenCache, collectionTrash: trash };
    // New captures win by ID. Restoring must not discard newer text or analysis.
    const ids = new Set(data.items.map(i => i.id)), restored = trash.items.filter(i => !ids.has(i.id));
    data.items = [...data.items, ...restored];
    const jobIds = new Set(data.jobs.map(j => j.id));
    data.jobs = [...data.jobs, ...trash.jobs.filter(j => !jobIds.has(j.id))].sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || '')).slice(-100);
    data.seenCache = { ...data.seenCache, ids: [...new Set([...data.seenCache.ids, ...trash.seenCache.ids])],
      previousIds: data.seenCache.previousIds ?? trash.seenCache.previousIds ?? null };
    data.collectionTrash = null;
    try { await this.save(); } catch (error) { Object.assign(data, previous); throw error; }
    return restored.length;
  }
  async upsert(record, { persist = true } = {}) {
    const identity = record.sourceKey || hash(record.url + '\n' + record.kind + '\n' + record.text + '\n' + record.context);
    const id = hash(identity).slice(0, 24);
    const existing = this.data.items.find(item => item.id === id);
    const contentHash = hash(JSON.stringify([record.kind, record.title, record.text, record.context, record.coverage, (record.images || []).map(i => [i.index, i.attachment?.attachmentId || null, i.error || null]), record.discussion ? { ...record.discussion, fetchedAt: undefined } : undefined,
      record.discussionNoteId ? [record.author, record.parentCommentId, record.threadRootId] : undefined]));
    const now = new Date().toISOString();
    const noteId = collectedNoteId(record);
    if (noteId && !this.data.seenCache.ids.includes(noteId)) this.data.seenCache.ids.push(noteId);
    if (existing) {
      if (existing.contentHash !== contentHash) {
        const history = [...(existing.history || []), { text: existing.text, analysis: existing.analysis, review: existing.review, images: existing.images, vision: existing.vision, readAt: existing.readAt, at: now }].slice(-5);
        Object.assign(existing, record, { contentHash, analysis: null, analysisKey: null, analysisError: null, review: { verdict: 'pending', note: '' }, history, vision: null, readAt: null });
      }
      existing.lastSeenAt = now; if (record.images) existing.images = record.images; existing.url = record.url; if (persist) await this.save(); return existing;
    }
    const item = { ...record, id, contentHash, capturedAt: now, lastSeenAt: now, analysis: null, readAt: null, review: { verdict: 'pending', note: '' } };
    this.data.items.unshift(item); if (persist) await this.save(); return item;
  }
}
