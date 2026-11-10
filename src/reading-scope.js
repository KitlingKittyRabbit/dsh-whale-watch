import { noteIdentity } from './units.js';

// A note-only view must not send previously saved comments to the model.
export function scopedRecords(unit, options) {
  if (options.readComments !== false) return unit.records;
  if (!unit.note) return [];
  const note = unit.records[0];
  return [{ ...note, coverage: { ...note.coverage, discussionIncomplete: false },
    discussion: { ...note.discussion, scope: 'note', complete: true, sourceKeys: [],
      commentsRead: 0, commentPages: 0, replyPages: 0, limitations: [] } }];
}

export function captureComplete(note, options) {
  return options.readComments === false && note.lastCapture?.scope === 'note'
    ? !!note.lastCapture.complete : !!note.discussion?.complete;
}

export function excludedNotes(store, options) {
  if (!options.excludeSeen) return [];
  if (options.readComments === false) return [...store.data.seenCache.ids];
  // Reading just a note must not prevent a later request for its comments.
  const needsComments = new Set(store.data.items.filter(i => i.kind === 'note' &&
    (i.discussion?.scope === 'note' || i.discussion?.complete === false)).map(noteIdentity));
  return store.data.seenCache.ids.filter(id => !needsComments.has(id));
}
