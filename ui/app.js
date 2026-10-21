const BASE = '/plugins/dafeiyu-patrol/api';
const $ = id => document.getElementById(id);
const requestedTab = new URLSearchParams(location.search).get('tab');
const initialTab = requestedTab === 'topic' ? 'context' : requestedTab;
let state, catalog, filter = 'all', offset = 0, total = 0, activeTab = ['results', 'context', 'settings'].includes(initialTab) ? initialTab : 'results', lastResults = '', initialized = false;
let topicEditing = null, materialHash = null, topicLoading = false;
let actionBusy = false;
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
  for (const t of ['results', 'settings', 'context']) $('tab-' + t).hidden = t !== name;
  document.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === name));
  $('page-title').textContent = { results: '鲸声守望', settings: '设置', context: '专题' }[name];
  $('masthead').classList.toggle('masthead-scene', name === 'results');
  $('masthead').classList.toggle('masthead-compact', name !== 'results');
  $('page-description').textContent = { results: '', settings: '管理模型、判断规则与费用额度。', context: '管理背景、术语与讨论语境。' }[name];
  $('page-description').hidden = name === 'results';
}
function fillModels() {
  const provider = $('provider').value;
  $('model').replaceChildren(el('option', provider ? '请选择模型' : '跟随默认模型'));
  $('model').firstElementChild.value = '';
  const selected = catalog?.providers.find(p => p.id === provider);
  for (const model of selected?.models || []) { const option = el('option', model.name || model.id); option.value = model.id; $('model').append(option); }
  $('model').disabled = !provider;
}
function searchSelection() { return Object.fromEntries(Object.keys(state.searchOptions || {}).map(key => [key, $('search-' + key).value])); }
function searchForm() {
  const root = $('search-options'); root.replaceChildren();
  for (const [key, option] of Object.entries(state.searchOptions || {})) {
    const label = el('label', option.label), select = el('select'); select.id = 'search-' + key;
    for (const [value, text] of option.choices) { const choice = el('option', text); choice.value = value; select.append(choice); }
    select.value = state.settings[key] || option.default; label.append(select); root.append(label);
  }
}
function settingsForm() {
  const s = state.settings;
  searchForm();
  $('keywords').value = s.keywords.join('，');
  for (const key of ['maxNotes', 'maxComments', 'maxAnalysis', 'rules']) $(key).value = s[key];
  $('provider').value = s.provider; fillModels();
  if (s.model && !$('model').querySelector(`option[value="${CSS.escape(s.model)}"]`)) { const option = el('option', s.model); option.value = s.model; $('model').append(option); }
  $('model').value = s.model;
}
function analysisCacheControls() {
  const cache = state?.analysisCache, disabled = actionBusy || !!state?.activeJob;
  $('analysis-cache-count').textContent = cache ? `可清空旧结论：${cache.count} 条，其中未阅 ${cache.unreadCount} 条${cache.canRestore ? `；可撤销上次清空的 ${cache.backupCount} 条` : ''}` : '更新后重启 DSH 可启用此功能';
  $('clear-analysis-cache').disabled = disabled || !cache?.count;
  $('restore-analysis-cache').hidden = !cache?.canRestore;
  $('restore-analysis-cache').disabled = disabled || !cache?.canRestore;
}
async function refresh() {
  state = await api('/status');
  $('hero-topic').textContent = state.background?.activeId && state.background.enabled ? state.context?.active?.name || '自定义资料' : '未选择专题';
  for (const key of ['total', 'suspicious', 'other', 'pending']) {
    const category = key === 'total' ? 'unread' : key;
    $('count-' + key).textContent = `${state.counts[category]}篇`;
    $('count-' + key + '-entries').textContent = `${state.counts.entries?.[category] ?? 0}条`;
  }
  const pending = state.counts.entries?.pending || 0, failed = state.counts.analysisFailed || 0;
  const retained = state.counts.retainedResults || 0;
  $('analysis-failures').hidden = !pending && !retained;
  $('analysis-failures').textContent = `待分析 ${pending} 条 ＝ 仍失败 ${failed} 条 ＋ 尚未分析 ${Math.max(0, pending - failed)} 条。保留旧结论 ${retained} 条（材料、规则或模型已变化），不计入待分析，不会自动重算。${state.activeJob ? '任务正在继续处理，无需重复点击。' : '分析未阅只处理尚未分析和失败内容。重新分析整篇才会重算已保存的结果，模型费用另计。'}上方失败数只统计本轮尝试。`;
  renderContext();
  const s = state.settings;
  if (catalog) {
    const route = s.provider ? s : catalog.current;
    $('model-current').textContent = catalog.mode === 'offline' ? '独立预览：请在 DSH 内使用模型分析' : `分析模型：${route.provider} / ${route.model}`;
  }
  $('limits').textContent = `本轮上限：${s.maxNotes} 篇笔记 · 评论及回复自动分页读取，受费用上限限制 · ${s.discussionNoteLimit} 篇整篇分析。结果按当前搜索排序读取。`;
  const running = !!state.activeJob;
  $('data-key-status').textContent = state.dataService?.configured ? '数据密钥已配置。' : '尚未配置数据密钥；可先导入原文或分析已保存内容。';
  $('data-key').disabled = running;
  $('save-data-key').disabled = running || !$('data-key').value.trim();
  $('clear-data-key').hidden = !state.dataService?.configured;
  $('clear-data-key').disabled = running;
  $('job-box').classList.toggle('running', running);
  $('job-spinner').hidden = !running; $('job-live-badge').hidden = !running; $('job-waiting').hidden = !running;
  $('clear-collection').disabled = running || !state.collection?.canClear;
  $('restore-collection').hidden = !state.collection?.canRestore; $('restore-collection').disabled = running;
  analysisCacheControls();
  $('seen-cache-count').textContent = `已查缓存：${state.seenCache?.count || 0} 篇`;
  $('clear-seen-cache').disabled = running || !state.seenCache?.count;
  $('restore-seen-cache').hidden = !state.seenCache?.canRestore; $('restore-seen-cache').disabled = running;
  for (const key of Object.keys(state.searchOptions || {})) { const input = $('search-' + key); if (input) input.disabled = running; }
  $('save-search-options').disabled = running;
  for (const id of ['start', 'analyze']) $(id).disabled = running;
  $('stop').hidden = !running;
  const job = state.jobs[0];
  $('job-box').hidden = !job;
  $('resume').hidden = running || !(['paused', 'cancelled', 'interrupted'].includes(job?.status) || job?.status === 'partial' && job.analysisDeferred) || job?.mode === 'evaluate';
  if (job) {
    const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(job.startedAt)) / 1000));
    $('job-waiting').textContent = `已运行 ${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒 · 等待本批结果时，完成数会暂时不变。`;
    $('job-status').textContent = job.status === 'running' && job.mode !== 'scan' ? '正在分析' : statuses[job.status] || job.status;
    $('job-message').textContent = job.message + (job.searchSummary ? '\n' + job.searchSummary : '');
    $('job-counts').textContent = `${job.notesAttempted === undefined ? '' : `排除已查 ${job.notesExcluded || 0} 篇 · 检查 ${job.notesAttempted} 篇 · 读到 ${job.notesRead} 篇 · 未读取 ${job.skippedNotes?.length || 0} 篇 · `}本轮：采集 ${job.collected} · 新分析 ${job.analyzed} · 复用 ${job.cached} · 失败 ${job.failed}`;
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
  $('result-total').textContent = `${total} 篇`;
  $('results').replaceChildren();
  if (!result.items.length) {
    const empty = el('div', undefined, 'empty');
    empty.append(el('div', '◡', 'symbol'), el('strong', total ? '这一页没有记录' : '这里还没有内容'), el('p', state.counts.total ? '切换筛选条件查看其他记录。' : '配置数据 API 发起一次巡查，或展开“导入原文”试一段文字。'));
    $('results').append(empty);
  }
  for (const item of result.items) $('results').append(card(item));
  $('pager').hidden = total <= pageSize;
  $('prev').disabled = offset === 0; $('next').disabled = offset + pageSize >= total;
  $('page-number').textContent = `${Math.floor(offset / pageSize) + 1} / ${Math.max(1, Math.ceil(total / pageSize))}`;
}
function card(item, embedded = false) {
  if (item.kind === 'discussion') return discussionCard(item);
  const analysis = item.analysis;
  const card = el('article', undefined, 'card ' + (analysis?.decision || ''));
  const head = el('div', undefined, 'card-head');
  const info = el('div'); info.append(el('h3', item.title || '无标题'));
  info.append(el('div', `${item.kind === 'comment' ? '评论' : '笔记'} · ${item.author || (item.coverage?.source === 'manual' ? '手动导入' : '作者未读取')} · ${new Date(item.capturedAt).toLocaleString('zh-CN')}`, 'card-meta'));
  head.append(info, el('span', analysis ? (item.analysisStale || item.analysisError ? '旧结论 · ' : '') + names[analysis.decision] : '未做模型分析', 'badge')); card.append(head);
  card.append(el('div', item.text || '没有读取到文字；这可能是一篇图片笔记。', 'raw'));
  if (item.url) {

    const source = el('a', '手动打开原帖 ↗'); source.href = item.url; source.target = '_blank'; source.rel = 'noopener noreferrer'; card.append(source);
  }
  if (analysis && (item.analysisStale || item.analysisError)) card.append(el('p', '保留旧结论：尚未依据当前材料、规则与模型重新分析。普通续跑不会重算已成功的结果。', 'hint'));
  if (analysis) {
    const details = el('div', undefined, 'assessment');
    details.append(el('p', analysis.categories.join(' · '), 'categories'), el('p', analysis.reason));
    if (analysis.evidence.length) { const quotes = el('div', undefined, 'quotes'); quotes.append(...analysis.evidence.map(q => el('p', '“' + q + '”'))); details.append(quotes); }
    if (analysis.uncertainties.length) details.append(el('div', analysis.uncertainties.join('；'), 'uncertainties'));
    card.append(details);
  }
  if (item.analysisError) { card.append(el('p', '分析失败：' + item.analysisError, 'uncertainties')); const retry = el('button', '重试这条'); retry.disabled = !!state.activeJob; retry.addEventListener('click', () => action(retry, '/analyze/item', { id: item.id })); if (!embedded) card.append(retry); }
  if (item.coverage?.imagesUnread) card.append(el('p', '配图详情与机器识别请在 DSH 原生巡查面板查看。', 'uncertainties'));
  if (item.context) { const detail = el('details'); detail.append(el('summary', '查看上下文'), el('div', item.context, 'context')); card.append(detail); }
  const read = el('button', item.readAt ? '恢复未阅' : '已阅');
  read.addEventListener('click', () => action(read, '/read', { id: item.id, read: !item.readAt }));
  if (!embedded) card.append(read); return card;
}
function discussionCard(item) {
  const node = el('article', undefined, 'card');
  node.append(el('h3', item.title), el('span', item.inspectionResult === 'suspicious' ? '可疑' : item.inspectionResult === 'other' ? '其它' : '待分析', 'badge'));
  node.append(el('p', `一篇笔记＋${item.discussionSummary.commentsRead}条已保存评论 · 可疑${item.discussionSummary.suspicious}条 · 其它${item.discussionSummary.other}条 · 待分析${item.discussionSummary.pending}条`));
  const pending = item.entries.filter(i => !i.readAt && !i.inspectionResult);
  const failed = pending.filter(i => i.analysisError).length;
  const retained = item.entries.filter(i => !i.readAt && i.analysisStale && i.inspectionResult).length;
  if (pending.length) node.append(el('p', `待分析组成：${failed}条失败 · ${pending.length - failed}条尚未分析。`, 'hint'));
  if (retained) node.append(el('p', `${retained}条保留旧结论（材料、规则或模型已变化），不计入待分析，不会自动重算。`, 'hint'));
  for (const text of item.discussionSummary.limitations) node.append(el('p', text, 'uncertainties'));
  const detail = el('details'); detail.append(el('summary', '查看正文、配图提示及评论判断'));
  for (const entry of item.entries) detail.append(card(entry, true));
  node.append(detail);
  const read = el('button', item.readAt ? '整篇恢复未阅' : '整篇已阅');
  read.disabled = !!state.activeJob;
  read.addEventListener('click', () => action(read, '/read', { id: item.id, read: !item.readAt }));
  const retry = el('button', `重新分析整篇（${item.entries.length}条，模型费用另计）`); retry.disabled = !!state.activeJob;
  retry.addEventListener('click', () => action(retry, '/analyze/item', { id: item.id }));
  node.append(read, retry); return node;
}
async function action(button, path, data = {}) {
  if (path.startsWith('/analysis-cache/') && (actionBusy || state?.activeJob || !state?.analysisCache || path.endsWith('/clear') && !state.analysisCache.count || path.endsWith('/restore') && !state.analysisCache.canRestore)) return;
  actionBusy = true; button.disabled = true; analysisCacheControls();
  try { const result = await api(path, data); if (path === '/data-key') $('data-key').value = ''; notice(result.message || '操作完成'); await refresh(); }
  catch (error) { notice(error.message, true); }
  finally { actionBusy = false; button.disabled = false; analysisCacheControls(); }
}
$('data-key').addEventListener('input', () => { $('save-data-key').disabled = !!state?.activeJob || !$('data-key').value.trim(); });
$('data-key-form').addEventListener('submit', async event => { event.preventDefault(); if (!state || state.activeJob || !$('data-key').value.trim()) return; await action($('save-data-key'), '/data-key', { apiKey: $('data-key').value }); $('save-data-key').disabled = !!state.activeJob || !$('data-key').value.trim(); });
$('clear-data-key').addEventListener('click', () => action($('clear-data-key'), '/data-key', { apiKey: '' }));
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => { tab(button.dataset.tab); if (activeTab === 'results') refreshResults(true).catch(e => notice(e.message, true)); }));
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { filter = button.dataset.filter; offset = 0; document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('selected', b === button)); refreshResults(true).catch(e => notice(e.message, true)); }));
$('save-search-options').addEventListener('click', () => action($('save-search-options'), '/settings', { ...state.settings, ...searchSelection() }));
$('start').addEventListener('click', () => { const urls = $('urls').value.split('\n').map(s => s.trim()).filter(Boolean); action($('start'), '/start', { ...(urls.length ? { urls } : { keywords: split($('keywords').value) }), excludeSeen: $('exclude-seen').checked, ...searchSelection() }); });
for (const id of ['analyze', 'stop', 'resume']) $(id).addEventListener('click', () => action($(id), '/' + id));
$('clear-seen-cache').addEventListener('click', () => action($('clear-seen-cache'), '/cache/clear'));
$('restore-seen-cache').addEventListener('click', () => action($('restore-seen-cache'), '/cache/restore'));
$('clear-analysis-cache').addEventListener('click', () => action($('clear-analysis-cache'), '/analysis-cache/clear'));
$('restore-analysis-cache').addEventListener('click', () => action($('restore-analysis-cache'), '/analysis-cache/restore'));
$('provider').addEventListener('change', fillModels);
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const provider = $('provider').value, model = provider ? $('model').value : '';
  if (provider && !model) { notice('请选择分析模型', true); return; }
  try { await api('/settings', { ...state.settings, ...searchSelection(), keywords: split($('keywords').value), provider, model, maxNotes: Number($('maxNotes').value), maxComments: Number($('maxComments').value), maxAnalysis: Number($('maxAnalysis').value), rules: $('rules').value }); notice('设置已保存。已有判断保留，重新分析时会使用新规则。'); await refresh(); }
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

$('clear-collection').addEventListener('click', () => action($('clear-collection'), '/collection/clear'));
$('restore-collection').addEventListener('click', () => action($('restore-collection'), '/collection/restore'));

function renderContext() {
  const c = state.context, running = !!state.activeJob;
  $('context-current').textContent = c.active?.name || '选择一个专题';
  $('context-undo').hidden = !c.canUndo; $('context-unload').hidden = !c.active && !c.hasBackground;
  for (const id of ['context-switch', 'context-edit', 'context-builtin', 'context-file', 'context-undo', 'context-unload', 'context-apply-draft']) $(id).disabled = running;
  $('context-draft').hidden = !c.draft; $('context-draft-name').textContent = c.draft ? `AI 草稿：${c.draft.name} · ${c.draft.terms} 个术语` : '';
  const hash = c.active?.hash || 'none';
  if (!topicLoading && hash !== materialHash) {
    topicLoading = true;
    api('/context/document').then(doc => {
      const root = $('context-material'); root.replaceChildren(el('h3', '背景'), el('p', doc.config.background.memo || '还没有背景说明。', 'raw'));
      const terms = el('details'); terms.append(el('summary', `术语解释（${doc.config.glossary.length} 个）`));
      for (const term of doc.config.glossary) terms.append(el('strong', term.term), el('p', term.meaning), el('p', term.usageNotes, 'hint'));
      root.append(terms); materialHash = hash;
    }).catch(e => notice(e.message, true)).finally(() => { topicLoading = false; });
  }
}
async function contextAction(path, data = {}) {
  try { const out = await api('/context/' + path, data); notice(out.message); materialHash = null; await refresh(); return out; }
  catch (e) { notice(e.message, true); }
}
$('context-switch').addEventListener('click', () => { $('context-switch-panel').hidden = !$('context-switch-panel').hidden; });
$('context-file').addEventListener('change', async e => {
  try { const file = e.target.files[0]; if (!file) return; if (file.size > 300000) throw new Error('配置文件不能超过300 KB'); if (await contextAction('import', { configJson: await file.text() })) $('context-switch-panel').hidden = true; }
  catch (error) { notice(error.message, true); } e.target.value = '';
});
for (const [id, action] of [['context-builtin', 'builtin'], ['context-undo', 'undo'], ['context-unload', 'unload'], ['context-apply-draft', 'apply-draft']]) $(id).addEventListener('click', async () => {
  if (await contextAction(action)) { $('context-switch-panel').hidden = true; $('context-editor').hidden = true; topicEditing = null; }
});
$('context-builder').addEventListener('click', () => notice('请从 DSH 左侧“鲸声守望 → 专题”打开制作助手。当前是独立预览页面。'));
$('context-preview-draft').addEventListener('click', async () => {
  const root = $('context-draft-preview'); if (!root.hidden) { root.hidden = true; return; }
  try { const doc = await api('/context/draft/export'); root.replaceChildren(el('p', doc.background.memo, 'raw'), ...doc.glossary.map(t => el('p', t.term + '：' + t.meaning))); root.hidden = false; } catch (e) { notice(e.message, true); }
});
function termForm() {
  const root = $('context-term-editor'); root.replaceChildren();
  topicEditing.config.glossary.forEach((term, index) => {
    const row = el('div');
    for (const [key, title] of [['term', '术语'], ['aliases', '别名（逗号分隔）'], ['meaning', '含义'], ['usageNotes', '用法说明']]) {
      const label = el('label', title), input = el(key === 'meaning' || key === 'usageNotes' ? 'textarea' : 'input');
      input.value = key === 'aliases' ? term.aliases.join('，') : term[key]; input.required = ['term', 'meaning'].includes(key);
      input.addEventListener('input', () => { term[key] = key === 'aliases' ? split(input.value) : input.value; }); label.append(input); row.append(label);
    }
    const remove = el('button', '删除此术语'); remove.type = 'button'; remove.addEventListener('click', () => { topicEditing.config.glossary.splice(index, 1); termForm(); }); row.append(remove); root.append(row);
  });
}
$('context-edit').addEventListener('click', async () => {
  try { topicEditing = await api('/context/document'); $('context-name').value = topicEditing.config.name; $('context-memo').value = topicEditing.config.background.memo; termForm(); $('context-editor').hidden = false; }
  catch (e) { notice(e.message, true); }
});
$('context-add-term').addEventListener('click', () => { if (topicEditing.config.glossary.length >= 100) return; topicEditing.config.glossary.push({ term: '', aliases: [], meaning: '', usageNotes: '', status: 'source_claim', sourceRefs: [], sources: [] }); termForm(); });
$('context-cancel').addEventListener('click', () => { $('context-editor').hidden = true; topicEditing = null; });
$('context-editor').addEventListener('submit', async e => {
  e.preventDefault(); topicEditing.config.name = $('context-name').value; topicEditing.config.background.memo = $('context-memo').value;
  if (await contextAction('edit', topicEditing)) { $('context-editor').hidden = true; topicEditing = null; }
});

tab(activeTab);
