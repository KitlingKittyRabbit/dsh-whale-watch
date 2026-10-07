// Options verified against SocialDataX's public XHS OpenAPI contract.
export const SEARCH_OPTIONS = {
  noteSort: { label: '笔记排序', default: 'time_descending', choices: [
    ['general', '综合'], ['time_descending', '最新发布'], ['like_count_descending', '最多点赞'],
    ['comment_count_descending', '最多评论'], ['collect_count_descending', '最多收藏'],
  ] },
  publishTimeRange: { label: '发布时间范围', default: 'all', choices: [
    ['all', '不限'], ['day', '一天内'], ['week', '一周内'], ['half_year', '半年内'],
  ] },
  noteType: { label: '笔记类型', default: 'all', choices: [['all', '不限'], ['image', '图文'], ['video', '视频']] },
  commentSort: { label: '评论排序', default: 'default', choices: [
    ['default', '综合'], ['time_descending', '最新评论'], ['like_count_descending', '最多点赞'],
  ] },
};
export const DEFAULT_SEARCH_SETTINGS = Object.fromEntries(Object.entries(SEARCH_OPTIONS).map(([key, option]) => [key, option.default]));
export function searchSummary(settings) {
  return Object.entries(SEARCH_OPTIONS).map(([key, option]) => `${option.label}：${option.choices.find(([value]) => value === settings[key])?.[1] || option.choices.find(([value]) => value === option.default)[1]}`).join(' · ');
}
