import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { backgroundHash } from './background.js';

const preset = JSON.parse(readFileSync(new URL('./community-background.json', import.meta.url), 'utf8'));
export const communityBackgroundInfo = { revision: preset.revision, title: preset.title, ...preset.researchStats };

// The package contains summaries and source links. Original text stays in the local store.
export function createCommunityBackground(items, previousActive = null) {
  const now = new Date().toISOString();
  const readings = preset.readings.map(source => {
    const note = items.find(i => i.kind === 'note' && i.sourceKey === source.sourceKey);
    const previous = previousActive?.readings.find(r => r.sourceKey === source.sourceKey);
    const comments = items.filter(i => i.kind === 'comment' && i.sourceKey?.startsWith(`comment:${source.sourceKey.slice(5)}:`)).slice(0, source.commentsRead);
    const parts = previous?.parts ? structuredClone(previous.parts) : [];
    if (!parts.length && note) {
      parts.push({ label: '标题', text: note.title || '' }, { label: '正文', text: note.text || '' });
      for (const p of note.vision?.pages || []) parts.push({ label: `配图${p.index}文字`, text: p.text || '', uncertain: p.uncertain }, { label: `配图${p.index}画面`, text: p.description || '', uncertain: p.uncertain });
      for (const [n, c] of comments.entries()) parts.push({ label: `评论${n + 1}`, text: c.text, author: c.author || '', context: c.context?.slice(0, 3000) });
    }
    // Explicitly distinguish editor notes from quoted original content.
    parts.unshift({ label: '阅读整理（非原文）', text: source.summary, sourceKind: 'curated-summary' });
    return { ...structuredClone(source), parts: parts.filter(p => p.text), itemId: note?.id || null,
      contentHash: note?.contentHash || preset.revision, capturedAt: note?.capturedAt || null, origin: preset.origin,
      coverage: { ...note?.coverage, source: note ? 'local-record-with-curated-summary' : 'curated-summary',
        humanImagesReviewed: source.reviewedImages, imageTextUnavailable: source.sourceImageCount > 0 && !note?.vision?.complete,
        imagesUnread: source.reviewedImages < source.sourceImageCount, localOriginalAvailable: !!note },
      localCommentsProvided: previous?.commentsRead ?? comments.length };
  });
  const profile = { id: randomUUID(), status: 'ready', origin: preset.origin, presetRevision: preset.revision,
    createdAt: now, completedAt: now, requestedCount: readings.length, source: 'curated-community',
    readings, researchStats: preset.researchStats, memo: preset.memo, errors: [], previousActiveId: previousActive?.id || null };
  profile.hash = backgroundHash(profile);
  return profile;
}
