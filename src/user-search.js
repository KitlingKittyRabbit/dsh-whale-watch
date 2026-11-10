// Public user identities only. Nicknames and red_id are not stable user_id values.
const USER_ID = /^[a-f0-9]{24}$/i;
export const USER_KEYWORD_MODES = [['and', '且：指定用户中匹配关键词'], ['or', '或：指定用户与关键词结果合并']];
export function userReference(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (USER_ID.test(value)) return { userId: value.toLowerCase(), params: { user_id: value.toLowerCase() } };
  try {
    const url = new URL(value);
    const match = /^\/user\/profile\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
        ['www.xiaohongshu.com', 'xiaohongshu.com'].includes(url.hostname) && match) {
      return { userId: USER_ID.test(match[1]) ? match[1].toLowerCase() : null, params: { profile_url: url.href } };
    }
  } catch {}
  throw new Error('指定用户请填写小红书完整主页链接或24位用户 ID；不能填写昵称、小红书号或笔记链接');
}
export function keywordHits(note, keywords) {
  const text = `${note.title || ''}\n${note.content || ''}`.normalize('NFKC').toLocaleLowerCase('und');
  return keywords.filter(word => text.includes(word.normalize('NFKC').toLocaleLowerCase('und')));
}
export function matchesKeywords(note, keywords) { return keywordHits(note, keywords).length > 0; }
export function matchesUserFilters(note, options, now = Date.now()) {
  if (options.noteType !== 'all' && note.note_type !== options.noteType) return false;
  if (options.publishTimeRange === 'all') return true;
  const days = { day: 1, week: 7, half_year: 183 }[options.publishTimeRange];
  return Number.isFinite(note.publish_time) && note.publish_time > 0 && note.publish_time * 1000 >= now - days * 86400000;
}
export async function* alternate(sources) {
  const active = [...sources];
  try {
    while (active.length) {
      for (let i = 0; i < active.length;) {
        const row = await active[i].next();
        if (row.done) active.splice(i, 1);
        else { yield row.value; i++; }
      }
    }
  } finally { for (const source of active) await source.return?.(); }
}
