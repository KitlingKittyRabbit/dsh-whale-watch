// A saved note and its comments form one work unit. Old samples remain samples:
// grouping never invents missing text, reply relationships or full coverage.
export function noteIdentity(item) {
  const key = /^(?:note|comment):([a-f0-9]{24})(?::|$)/i.exec(item.sourceKey || '')?.[1];
  if (key) return key.toLowerCase();
  if (/^[a-f0-9]{24}$/i.test(item.discussionNoteId || '')) return item.discussionNoteId.toLowerCase();
  try {
    const url = new URL(item.url);
    if (url.protocol === 'https:' && ['www.xiaohongshu.com', 'xiaohongshu.com'].includes(url.hostname))
      return /^\/(?:explore|discovery\/item|search_result)\/([a-f0-9]{24})\/?$/i.exec(url.pathname)?.[1]?.toLowerCase() || null;
  } catch {}
  return null;
}

export function discussionUnits(items) {
  const map = new Map();
  for (const item of items) {
    const noteId = noteIdentity(item), key = noteId ? `note:${noteId}` : `item:${item.id}`;
    if (!map.has(key)) map.set(key, { key, noteId, members: [] });
    map.get(key).members.push(item);
  }
  return [...map.values()].map(unit => {
    const note = unit.members.find(i => i.kind === 'note');
    const representative = note || unit.members[0];
    const comments = unit.members.filter(i => i.kind === 'comment');
    const saved = note?.discussion;
    // A committed API snapshot controls membership; samples from an earlier
    // capture are not silently mixed into the latest complete snapshot.
    const snapshot = saved && Array.isArray(saved.sourceKeys);
    const members = snapshot ? [note, ...saved.sourceKeys.map(k => comments.find(i => i.sourceKey === k)).filter(Boolean)] : unit.members;
    const missingSavedComments = snapshot && saved.sourceKeys.length !== members.length - 1;
    const complete = !!saved?.complete && !missingSavedComments;
    const limitations = [...(saved?.limitations || [])];
    if (!saved && unit.noteId) limitations.push('旧版浏览器采样：仅保留当时采到的正文及评论，不是完整评论区；未保存的回复关系不能还原。');
    if (!note && unit.noteId) limitations.push('未保存所属笔记正文；没有从评论中编造正文。');
    if (missingSavedComments) limitations.push('快照中的部分评论记录缺失。');
    const discussion = { ...saved, complete, commentsRead: members.filter(i => i.kind === 'comment').length,
      source: saved?.source || note?.coverage?.source || 'saved-sample', limitations,
      sourceKeys: members.filter(i => i.kind === 'comment').map(i => i.sourceKey) };
    const head = note ? { ...note, discussion } : { id: `missing:${unit.key}`, kind: 'note', title: representative.title || '所属笔记未保存',
      text: '', context: '', coverage: { parentMissing: true }, discussion, synthetic: true };
    return { ...unit, id: representative.id, note, members, comments: members.filter(i => i.kind === 'comment'),
      standalone: !unit.noteId && members.length === 1, records: [head, ...members.filter(i => i.kind === 'comment')] };
  });
}

export function findUnit(item, items) {
  return discussionUnits(items).find(unit => unit.members.some(i => i.id === item.id));
}
