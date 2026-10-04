import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULT_RULES } from './rules.js';
export const hash = text => createHash('sha256').update(text).digest('hex');
export const defaultSettings = () => ({ keywords: ['大肥鱼', 'DeepSeek拟人'], provider: '', model: '', maxNotes: 5, maxComments: 10, maxAnalysis: 55, readImages: true, visionProvider: '', visionModel: '', maxImagesPerNote: 18, maxVision: 5, rules: DEFAULT_RULES });
function collectedNoteId(item) {
  return item.kind === 'note' && item.coverage?.source === 'rendered-dom'
    ? item.sourceKey?.match(/^note:([a-f0-9]{24})$/i)?.[1]?.toLowerCase() : null;
}

export class Store {
  constructor(root) { this.root = root; this.path = join(root, 'state.json'); this.queue = Promise.resolve(); }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try { this.data = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('巡查数据文件无法读取，请保留原文件检查，未覆盖旧数据');
      this.data = { version: 1, settings: defaultSettings(), items: [], jobs: [] };
    }
    if (this.data.version !== 1 || !Array.isArray(this.data.items) || !Array.isArray(this.data.jobs)) throw new Error('巡查数据格式不受支持');
    this.data.settings = { ...defaultSettings(), ...this.data.settings };
    if (!this.data.defaultsRevision) {
      if (this.data.settings.maxNotes === 5 && this.data.settings.maxComments === 10 && this.data.settings.maxAnalysis === 15) this.data.settings.maxAnalysis = 55;
      this.data.defaultsRevision = 1;
    }
    for (const item of this.data.items) if (!Object.hasOwn(item, 'readAt')) item.readAt = ['confirmed', 'dismissed', 'uncertain'].includes(item.review?.verdict) ? item.review.at || item.capturedAt || new Date().toISOString() : null;
    if (!this.data.background) this.data.background = { enabled: true, active: null, draft: null, history: [] };
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
  async upsert(record) {
    const identity = record.sourceKey || hash(record.url + '\n' + record.kind + '\n' + record.text + '\n' + record.context);
    const id = hash(identity).slice(0, 24);
    const existing = this.data.items.find(item => item.id === id);
    const contentHash = hash(JSON.stringify([record.kind, record.title, record.text, record.context, record.coverage, (record.images || []).map(i => [i.index, i.attachment?.attachmentId || null, i.error || null])]));
    const now = new Date().toISOString();
    const noteId = collectedNoteId(record);
    if (noteId && !this.data.seenCache.ids.includes(noteId)) this.data.seenCache.ids.push(noteId);
    if (existing) {
      if (existing.contentHash !== contentHash) {
        const history = [...(existing.history || []), { text: existing.text, analysis: existing.analysis, review: existing.review, images: existing.images, vision: existing.vision, readAt: existing.readAt, at: now }].slice(-5);
        Object.assign(existing, record, { contentHash, analysis: null, analysisKey: null, analysisError: null, review: { verdict: 'pending', note: '' }, history, vision: null, readAt: null });
      }
      existing.lastSeenAt = now; if (record.images) existing.images = record.images; existing.url = record.url; await this.save(); return existing;
    }
    const item = { ...record, id, contentHash, capturedAt: now, lastSeenAt: now, analysis: null, readAt: null, review: { verdict: 'pending', note: '' } };
    this.data.items.unshift(item); await this.save(); return item;
  }
}
