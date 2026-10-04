const BASE = '/plugins/dafeiyu-patrol/api';
const $ = id => document.getElementById(id);
let state, catalog, filter = 'all', offset = 0, total = 0, activeTab = 'results', lastResults = '', initialized = false;
const pageSize = 20;
const names = { normal: '其它', review: '可疑', uncertain: '其它' };
const statuses = { running: '正在巡查', completed: '任务完成', partial: '部分完成', paused: '等待你处理', failed: '任务未完成', cancelled: '已停止', interrupted: '上次任务中断' };
function notice(text, error = false) { $('notice').hidden = !text; $('notice').textContent = text; $('notice').classList.toggle('error', error); }
async function api(path, data) {
  const response = await fetch(BASE + path, data === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败：${response.status}`);
  return result;
}
const split = text => text.split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function tab(name) {
  activeTab = name;
  for (const t of ['results', 'settings', 'import']) $('tab-' + t).hidden = t !== name;
  document.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === name));
  $('page-title').textContent = { results: '巡查结果', settings: '规则与设置', import: '导入文字' }[name];
}
function fillModels() {
  const provider = $('provider').value;
  $('model').replaceChildren(el('option', provider ? '请选择模型' : '跟随默认模型'));
  $('model').firstElementChild.value = '';
  const selected = catalog?.providers.find(p => p.id === provider);
  for (const model of selected?.models || []) { const option = el('option', model.name || model.id); option.value = model.id; $('model').append(option); }
  $('model').disabled = !provider;
}
function settingsForm() {
  const s = state.settings;
  $('keywords').value = s.keywords.join('，');
  for (const key of ['maxNotes', 'maxComments', 'maxAnalysis', 'rules']) $(key).value = s[key];
  $('provider').value = s.provider; fillModels();
  if (s.model && !$('model').querySelector(`option[value="${CSS.escape(s.model)}"]`)) { const option = el('option', s.model); option.value = s.model; $('model').append(option); }
  $('model').value = s.model;
}
async function refresh() {
  state = await api('/status');
  for (const key of ['total', 'suspicious', 'other', 'pending']) $('count-' + key).textContent = state.counts[key === 'total' ? 'unread' : key];
  const s = state.settings;
  if (catalog) {
    const route = s.provider ? s : catalog.current;
    $('model-current').textContent = catalog.mode === 'offline' ? '独立预览：请在 DSH 内使用模型分析' : `分析模型：${route.provider} / ${route.model}`;
  }
  $('limits').textContent = `本轮上限：${s.maxNotes} 篇笔记 · 每篇 ${s.maxComments} 条可见评论 · ${s.maxAnalysis} 条模型分析。结果按当前搜索排序读取。`;
  const running = !!state.activeJob;
  $('seen-cache-count').textContent = `已查缓存：${state.seenCache?.count || 0} 篇`;
  $('clear-seen-cache').disabled = running || !state.seenCache?.count;
  $('restore-seen-cache').hidden = !state.seenCache?.canRestore; $('restore-seen-cache').disabled = running;
  for (const id of ['start', 'login', 'analyze']) $(id).disabled = running;
  $('stop').hidden = !running;
  const job = state.jobs[0];
  $('job-box').hidden = !job;
  $('resume').hidden = running || !['paused', 'cancelled', 'interrupted'].includes(job?.status) || job?.mode === 'evaluate';
  if (job) {
    $('job-status').textContent = job.status === 'running' && job.mode !== 'scan' ? '正在分析' : statuses[job.status] || job.status;
    $('job-message').textContent = job.message;
    $('job-counts').textContent = `${job.notesAttempted === undefined ? '' : `排除已查 ${job.notesExcluded || 0} 篇 · 检查 ${job.notesAttempted} 篇 · 读到 ${job.notesRead} 篇 · 未读取 ${job.skippedNotes?.length || 0} 篇 · `}采集 ${job.collected} · 分析 ${job.analyzed} · 复用 ${job.cached} · 失败 ${job.failed}`;
    $('job-log').replaceChildren(...job.messages.slice(-30).map(log => el('li', new Date(log.at).toLocaleTimeString('zh-CN') + ' · ' + log.message)));
  }
  if (!initialized && catalog) { settingsForm(); initialized = true; }
  if (activeTab === 'results') await refreshResults();
}
async function refreshResults(force = false) {
  const result = await api(`/results?filter=${filter}&limit=${pageSize}&offset=${offset}`);
  const serialized = JSON.stringify(result);
  if (!force && serialized === lastResults) return;
  // Preserve unfinished review notes while background progress changes.
  if (!force && document.activeElement?.classList.contains('review-note')) return;
  lastResults = serialized; total = result.total;
  $('result-total').textContent = `${total} 条记录`;
  $('results').replaceChildren();
  if (!result.items.length) {
    const empty = el('div', undefined, 'empty');
    empty.append(el('div', '◡', 'symbol'), el('strong', total ? '这一页没有记录' : '这里还没有内容'), el('p', state.counts.total ? '切换筛选条件查看其他记录。' : '先登录小红书发起一次巡查，或在“导入文字”中试一段原文。'));
    $('results').append(empty);
  }
  for (const item of result.items) $('results').append(card(item));
  $('pager').hidden = total <= pageSize;
  $('prev').disabled = offset === 0; $('next').disabled = offset + pageSize >= total;
  $('page-number').textContent = `${Math.floor(offset / pageSize) + 1} / ${Math.max(1, Math.ceil(total / pageSize))}`;
}
function card(item) {
  const analysis = item.analysisStale ? null : item.analysis;
  const card = el('article', undefined, 'card ' + (analysis?.decision || ''));
  const head = el('div', undefined, 'card-head');
  const info = el('div'); info.append(el('h3', item.title || '无标题'));
  info.append(el('div', `${item.kind === 'comment' ? '评论' : '笔记'} · ${item.author || (item.coverage?.source === 'manual' ? '手动导入' : '作者未读取')} · ${new Date(item.capturedAt).toLocaleString('zh-CN')}`, 'card-meta'));
  head.append(info, el('span', analysis ? names[analysis.decision] : '未做模型分析', 'badge')); card.append(head);
  card.append(el('div', item.text || '没有读取到文字；这可能是一篇图片笔记。', 'raw'));
  if (item.url) {
    const open = el('button', '在采集浏览器查看'); open.addEventListener('click', () => action(open, '/source', { url: item.url })); card.append(open);
    const source = el('a', '用当前浏览器打开 ↗'); source.href = item.url; source.target = '_blank'; source.rel = 'noopener noreferrer'; card.append(source);
  }
  if (analysis) {
    const details = el('div', undefined, 'assessment');
    details.append(el('p', analysis.categories.join(' · '), 'categories'), el('p', analysis.reason));
    if (analysis.evidence.length) { const quotes = el('div', undefined, 'quotes'); quotes.append(...analysis.evidence.map(q => el('p', '“' + q + '”'))); details.append(quotes); }
    if (analysis.uncertainties.length) details.append(el('div', analysis.uncertainties.join('；'), 'uncertainties'));
    card.append(details);
  }
  if (item.analysisError) { card.append(el('p', '分析失败：' + item.analysisError, 'uncertainties')); const retry = el('button', '重试这条'); retry.disabled = !!state.activeJob; retry.addEventListener('click', () => action(retry, '/analyze/item', { id: item.id })); card.append(retry); }
  if (item.coverage?.imagesUnread) card.append(el('p', '配图详情与机器识别请在 DSH 原生巡查面板查看。', 'uncertainties'));
  if (item.context) { const detail = el('details'); detail.append(el('summary', '查看上下文'), el('div', item.context, 'context')); card.append(detail); }
  const read = el('button', item.readAt ? '恢复未阅' : '已阅');
  read.addEventListener('click', () => action(read, '/read', { id: item.id, read: !item.readAt }));
  card.append(read); return card;
}
async function action(button, path, data = {}) {
  button.disabled = true;
  try { const result = await api(path, data); notice(result.message || '操作完成'); await refresh(); }
  catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
}
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => { tab(button.dataset.tab); if (activeTab === 'results') refreshResults(true).catch(e => notice(e.message, true)); }));
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { filter = button.dataset.filter; offset = 0; document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('selected', b === button)); refreshResults(true).catch(e => notice(e.message, true)); }));
$('start').addEventListener('click', () => { const urls = $('urls').value.split('\n').map(s => s.trim()).filter(Boolean); action($('start'), '/start', { ...(urls.length ? { urls } : { keywords: split($('keywords').value) }), excludeSeen: $('exclude-seen').checked }); });
for (const id of ['login', 'analyze', 'stop', 'resume']) $(id).addEventListener('click', () => action($(id), '/' + id));
$('clear-seen-cache').addEventListener('click', () => action($('clear-seen-cache'), '/cache/clear'));
$('restore-seen-cache').addEventListener('click', () => action($('restore-seen-cache'), '/cache/restore'));
$('provider').addEventListener('change', fillModels);
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const provider = $('provider').value, model = provider ? $('model').value : '';
  if (provider && !model) { notice('请选择分析模型', true); return; }
  try { await api('/settings', { ...state.settings, keywords: split($('keywords').value), provider, model, maxNotes: Number($('maxNotes').value), maxComments: Number($('maxComments').value), maxAnalysis: Number($('maxAnalysis').value), rules: $('rules').value }); notice('设置已保存。已有判断保留，重新分析时会使用新规则。'); await refresh(); }
  catch (error) { notice(error.message, true); }
});
$('import-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.target.querySelector('[type="submit"]'); button.disabled = true;
  try { await api('/import', { text: $('import-text').value, context: $('import-context').value, title: $('import-title').value || '手动导入', url: $('import-url').value, kind: $('import-kind').value }); notice('原文已导入，正在分析。'); tab('results'); filter = 'all'; offset = 0; document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('selected', b.dataset.filter === filter)); await refresh(); }
  catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
});
$('sample').addEventListener('click', () => { $('import-title').value = '语境校准示例（非真实帖子）'; $('import-text').value = '有人说“去把她开盒，让她退网”，我反对这种做法。讨论作品可以，骚扰作者不行。'; $('import-context').value = '这是对开盒言论的引用和明确反驳，请区分被引用的话与作者自己的立场。'; });
$('prev').addEventListener('click', () => { offset = Math.max(0, offset - pageSize); refreshResults(true).catch(e => notice(e.message, true)); });
$('next').addEventListener('click', () => { offset += pageSize; refreshResults(true).catch(e => notice(e.message, true)); });
async function boot() {
  try {
    catalog = await api('/models');
    for (const provider of catalog.providers) { const option = el('option', provider.name || provider.id); option.value = provider.id; $('provider').append(option); }
    await refresh();
    const route = state.settings.provider ? state.settings : catalog.current;
    $('model-current').textContent = catalog.mode === 'offline' ? '独立预览：请在 DSH 内使用模型分析' : `分析模型：${route.provider} / ${route.model}`;
  } catch (error) { notice('无法连接插件：' + error.message, true); }
}
await boot();
let refreshing = false;
setInterval(async () => { if (document.hidden || refreshing) return; refreshing = true; try { await refresh(); } catch (error) { notice(error.message, true); } finally { refreshing = false; } }, 2500);
