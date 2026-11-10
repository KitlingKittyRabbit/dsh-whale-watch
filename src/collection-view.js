import { keywordHits } from './user-search.js';

export function latestCollectionJob(jobs) {
  return jobs.findLast(job => job.mode === 'scan' && Array.isArray(job.collectedItemIds));
}
export function orderCollectionViews(views, jobs) {
  const membership = new Map();
  for (const job of [...jobs].reverse()) if (job.mode === 'scan' && Array.isArray(job.collectedItemIds))
    job.collectedItemIds.forEach((id, index) => { if (!membership.has(id)) membership.set(id, { job, index }); });
  return views.map(view => {
    const batch = membership.get(view.noteId || view.id) || view.entries.map(entry => membership.get(entry.id)).find(Boolean);
    if (!batch) return { view, time: Date.parse(view.capturedAt) || 0 };
    // Older jobs recorded member IDs but not the query that returned each note.
    // Their literal hits can be checked locally; query provenance stays unknown.
    const collection = view.collection || { source: 'saved', query: null, keywords: batch.job.options?.keywords || [],
      matchedKeywords: keywordHits({ title: view.title, content: view.text }, batch.job.options?.keywords || []) };
    return { view: { ...view, collection, collectionBatch: { id: batch.job.id, startedAt: batch.job.startedAt },
      entries: view.entries.map(entry => entry.id === view.noteId ? { ...entry, collection } : entry) },
      ...batch, time: Date.parse(batch.job.startedAt) || Date.parse(view.capturedAt) || 0 };
  }).sort((a, b) => {
    if (a.job && a.job === b.job) {
      if (a.job.options?.noteSort === 'time_descending') {
        const dateOrder = (Date.parse(b.view.publishedAt) || 0) - (Date.parse(a.view.publishedAt) || 0);
        if (dateOrder) return dateOrder;
      }
      return a.index - b.index;
    }
    return b.time - a.time;
  }).map(entry => entry.view);
}
