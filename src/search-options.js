// Options verified against SocialDataX's public XHS OpenAPI contract.
import { keywordStopEnabled } from './search-results.js';
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
  const scope = settings.urls?.length ? `指定笔记 ${settings.urls.length} 篇` : settings.users?.length ? `指定用户 ${settings.users.length} 个${settings.keywords?.length ? settings.userKeywordMode === 'or' ? ' 或 关键词' : ' 且 关键词（标题／正文）' : '（不限制关键词）'}` : '关键词搜索';
  return [scope, ...(settings.readComments === false ? ['只看笔记（不读取或分析评论）'] : []), ...(keywordStopEnabled(settings) ? ['关键词遇旧即停（各词独立）'] : []), ...Object.entries(SEARCH_OPTIONS).map(([key, option]) => `${option.label}：${option.choices.find(([value]) => value === settings[key])?.[1] || option.choices.find(([value]) => value === option.default)[1]}`)].join(' · ');
}
