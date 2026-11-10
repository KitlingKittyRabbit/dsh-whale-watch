// Numeric sorts can be merged across keyword streams. General relevance scores
// are not comparable across queries, so those streams take turns instead.
export const SORT_FIELDS = {
  time_descending: 'publish_time', like_count_descending: 'like_count',
  comment_count_descending: 'comment_count', collect_count_descending: 'collect_count',
};
export function keywordStopEnabled(options) {
  return options.stopOnSeen === true && options.excludeSeen !== false && !options.urls?.length &&
    options.keywords?.length > 0 && (!options.users?.length || options.userKeywordMode === 'or');
}
const rank = (item, field) => Number.isFinite(item[field]) && item[field] >= 0 ? item[field] : -1;
export function sortCandidates(items, sort) {
  const field = SORT_FIELDS[sort];
  return field ? [...items].sort((a, b) => rank(b, field) - rank(a, field)) : items;
}
export async function* mergeKeywordCandidates(sources, sort) {
  const active = [], field = SORT_FIELDS[sort];
  try {
    // Read each query's first candidate before applying the shared note cap.
    // Requests stay sequential and share the collector's existing budget.
    for (const source of sources) {
      const next = await source.next();
      if (!next.done) active.push({ source, value: next.value });
    }
    while (active.length) {
      let selected = 0;
      if (field) for (let n = 1; n < active.length; n++)
        if (rank(active[n].value, field) > rank(active[selected].value, field)) selected = n;
      const entry = active.splice(selected, 1)[0];
      yield entry.value;
      const next = await entry.source.next();
      if (!next.done) active.push({ source: entry.source, value: next.value });
    }
  } finally {
    for (const source of sources) await source.return?.();
  }
}
export function publishedAt(seconds) {
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 253402300799
    ? new Date(seconds * 1000).toISOString() : null;
}
