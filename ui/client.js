/* Browser module: official DSH slots; no iframe, DOM sidebar patching, or extra React runtime. */
window.__ModuleLoader__.load({ id: 'dsh-dafeiyu-patrol', factory: require => {
  const React = require('react');
  const { useState, useEffect, useRef, useCallback } = React;
  const h = React.createElement;
  const PANEL_ID = 'dafeiyu-patrol';
  const BASE = '/plugins/dafeiyu-patrol/api';
  const decisions = { normal: '其它', review: '可疑', uncertain: '其它' };
  const statuses = { running: '正在处理', completed: '任务完成', partial: '部分完成，有内容未读取或分析失败', paused: '等待你处理', failed: '任务未完成', cancelled: '已停止', interrupted: '上次任务中断' };
  const split = text => text.split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
  const stamp = text => text ? new Date(text).toLocaleString('zh-CN') : '';
  async function api(path, data, signal) {
    const response = await fetch(BASE + path, data === undefined ? { cache: 'no-store', signal }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data), signal });
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('插件连接失效，请刷新 DSH 后重试。');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `请求失败：${response.status}`);
    return result;
  }
  function WhaleIcon({ size = 20 }) {
    return h('svg', { width: size, height: size, viewBox: '0 0 100 80', fill: 'none', 'aria-hidden': true },
      h('path', { d: 'M16 43C18 16 56 9 75 30l17-10-2 21 7 7-21 3c-7 25-56 26-60-8', fill: '#6b91da' }),
      h('path', { d: 'M19 47c8-7 19-8 28 0s18 6 29 4c-8 20-49 22-57-4', fill: '#fff' }),
      h('circle', { cx: 36, cy: 35, r: 4, fill: '#182b49' }),
      h('ellipse', { cx: 27, cy: 45, rx: 6, ry: 3, fill: '#e8a6ae' }));
  }
  function Button({ children, primary, ...props }) {
    return h('button', { type: 'button', ...props, className: 'patrol-button' + (primary ? ' patrol-primary' : '') + (props.className ? ' ' + props.className : '') }, children);
  }
  const Hint = ({ children }) => h('p', { className: 'patrol-hint' }, children);
  const Box = ({ title, children, ...props }) => h('section', { ...props, className: 'patrol-box' }, title && h('h2', null, title), children);
  function Field({ label, children }) { return h('label', { className: 'patrol-field' }, h('span', null, label), children); }
  function RecordCard({ item, busy, running, act, hasBackground }) {
    const a = item.analysisStale ? null : item.analysis;
    return h('article', { className: 'patrol-record', 'aria-label': item.title || '内容记录' },
      h('div', { className: 'patrol-card-head' }, h('div', null,
        h('h3', null, item.title || '无标题'),
        h('p', { className: 'patrol-meta' }, `${item.kind === 'comment' ? '评论' : '笔记'} · ${item.author || '手动导入或作者未读取'} · ${stamp(item.capturedAt)}`)),
      h('span', { className: 'patrol-badge ' + (a?.decision === 'review' ? 'review' : a ? 'normal' : '') }, a ? decisions[a.decision] : item.analysisStale ? '需重新分析' : '未做模型分析')),
      h('div', { className: 'patrol-raw' }, item.text || '没有读到正文文字，请查看配图。'),
      item.url && h('div', { className: 'patrol-actions' }, h(Button, { disabled: busy, onClick: () => act('/source', { url: item.url }) }, '在采集浏览器查看'), h('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer' }, '用当前浏览器打开 ↗')),
      item.context && h('details', { className: 'patrol-context' }, h('summary', null, '查看上下文'), h('div', { className: 'patrol-raw' }, item.context)),
      a && h('div', { className: 'patrol-assessment' },
        a.interpretation && h('p', null, '本条含义：' + a.interpretation),
        a.categories.some(c => !['正常讨论', '信息不足'].includes(c)) && h('strong', null, a.categories.filter(c => !['正常讨论', '信息不足'].includes(c)).join(' · ')), h('p', null, a.reason),
        ...a.evidence.map((quote, i) => h('blockquote', { key: i }, h('small', null, a.evidenceSources?.[i] || '正文'), h('div', null, quote))),
        ...(a.imageEvidence || []).map((e, i) => h('blockquote', { key: 'image-' + i }, `配图${e.index}画面依据（${e.uncertain ? '识别不确定，' : ''}须人工核对）：${e.observation}`)),
        a.uncertainties.length > 0 && h(Hint, null, '判断局限：' + a.uncertainties.join('；')),
        a.backgroundUsed && h(Hint, null, `已读背景 ${a.backgroundUsed.articlesRead} 篇；本次带入 ${a.backgroundUsed.sourceRefs.join('、')} 原文${a.backgroundUsed.expanded ? '（已补读更多）' : ''}。`),
        a.decision === 'uncertain' && hasBackground && !item.backgroundExpanded && h(Button, { disabled: busy || running, onClick: () => act('/analyze/item', { id: item.id, backgroundExpanded: true }) }, '补读更多背景后重试'),
        a.route && h('p', { className: 'patrol-meta' }, `分析模型：${a.route.provider} / ${a.route.model} · ${stamp(a.analyzedAt)}`)),
      item.analysisStale && h(Button, { disabled: busy || running, onClick: () => act('/analyze/item', { id: item.id }) }, '按当前背景重新分析'),
      item.analysisError && h('div', null, h('p', { className: 'patrol-error' }, '分析失败：' + item.analysisError), h(Button, { disabled: busy || running, onClick: () => act('/analyze/item', { id: item.id }) }, '重试这条')),
      !!item.coverage?.imageCount && h('details', { className: 'patrol-context' }, h('summary', null, `查看配图与机器识别：${item.vision?.pages?.length || 0} / ${item.coverage.imageCount} 张`),
        h(Hint, null, item.vision?.complete ? '配图已读取。机器识别可能出错，请对照原图复核。' : '配图尚未完整读取，当前判断仅覆盖已读取内容。'),
        item.vision?.error && h('p', { className: 'patrol-error' }, item.vision.error),
        ...(item.images || []).map(image => h('div', { key: image.index, className: 'patrol-image-page' }, h('strong', null, `配图${image.index}`),
          image.attachment ? h('a', { href: `${BASE}/image/${item.id}/${image.index}`, target: '_blank', rel: 'noopener noreferrer' }, h('img', { src: `${BASE}/image/${item.id}/${image.index}`, alt: `配图${image.index}原图`, loading: 'lazy', style: { maxWidth: '100%', maxHeight: '360px', objectFit: 'contain', display: 'block' } })) : h(Hint, null, image.error || '原图未保存'),
          ...(item.vision?.pages || []).filter(p => p.index === image.index).map(p => h('div', { key: p.index }, h('p', { className: 'patrol-raw' }, p.text || '没有识别到文字'), h('p', null, '画面：' + p.description), p.uncertain && h(Hint, null, '这一张存在模糊或不确定内容。'))))),
        item.vision?.route && h(Hint, null, `看图模型：${item.vision.route.provider} / ${item.vision.route.model}`)),
      item.coverage?.imagesUnread && !item.vision?.complete && !item.coverage?.imageCount && h(Hint, null, '配图尚未读取，当前判断仅覆盖已采集内容。'),
      h('div', { className: 'patrol-actions' },
        h(Button, { disabled: busy, primary: !item.readAt, onClick: () => act('/read', { id: item.id, read: !item.readAt }) }, item.readAt ? '恢复未阅' : '已阅')));

  }
  function Evaluation({ report, busy, running, maxAnalysis, act }) {
    const s = report?.summary;
    return h(React.Fragment, null,
      h(Box, { title: '公开样例评估' },
        h('p', null, '用32条人工编写的样例，检查引用反驳、尖锐批评、骚扰动员及缺失上下文等情况。'),
        h(Hint, null, `点击后最多分析 ${Math.min(28, maxAnalysis)} 条内容，疑似问题各额外核对一次；失败也占用额度。样例不写入巡查记录。结果是样例符合率，不能代表真实内容准确率。`),
        h('div', { className: 'patrol-actions' },
          h(Button, { primary: true, disabled: busy || running, onClick: () => act('/evaluate') }, '运行32条示例评估'),
          report && h('a', { className: 'patrol-button', href: BASE + '/evaluation/export', download: true }, '导出评估报告 ↓'))),
      report && h(Box, { title: report.complete ? '本轮评估结果' : '本轮评估尚未完整完成' },
        h('p', null, `样例版本 ${report.fixtureVersion} · ${report.route?.provider || ''} / ${report.route?.model || ''}`),
        s && h('div', { className: 'patrol-stats' }, ...[['已尝试', `${s.attempted}/${s.total}`], ['符合预期', s.agreed], ['调用失败', s.errors], ['未评估', s.unattempted]].map(([label, value]) =>
          h('div', { key: label }, h('span', null, label), h('strong', null, value)))),
        s && h(Hint, null, `正常样例被建议复核：${s.falseAlerts}；应复核样例被判正常：${s.missedReviews}。调用失败计入已尝试，信息不足单列。预期由项目作者按公开规则编写。`),
        h('details', null, h('summary', null, '查看本轮判断规则'), h('pre', { className: 'patrol-raw' }, report.rules))),
      ...(report?.rows || []).map(row => h(Box, { key: row.id, title: row.label },
        h('p', { className: 'patrol-meta' }, `预期：${decisions[row.expected]} · 实际：${row.error ? '调用失败' : decisions[row.analysis.decision]}`),
        h('div', { className: 'patrol-raw' }, row.text),
        row.context && h('details', null, h('summary', null, '样例上下文'), h('div', { className: 'patrol-raw' }, row.context)),
        h(Hint, null, '预期理由：' + row.why),
        row.error ? h('p', { className: 'patrol-error' }, row.error) : h('div', null, h('p', null, row.analysis.reason),
          ...row.analysis.evidence.map((q, i) => h('blockquote', { key: i }, q)),
          row.analysis.uncertainties.length > 0 && h(Hint, null, row.analysis.uncertainties.join('；'))))));
  }
  function Background({ background, busy, running, act, defaultKeywords }) {
    const [source, setSource] = useState('existing'), [count, setCount] = useState(10), [links, setLinks] = useState(''), [terms, setTerms] = useState(defaultKeywords || '');
    const [selected, setSelected] = useState(null), [refreshSources, setRefreshSources] = useState(true), [memo, setMemo] = useState('');
    const memoId = useRef(null); const active = background?.active, draft = background?.draft;
    useEffect(() => { if (selected === null && background) setSelected(background.articles.slice(0, 10).map(a => a.id)); }, [background, selected]);
    useEffect(() => { if (active?.id !== memoId.current) { memoId.current = active?.id; setMemo(active?.memo || ''); } }, [active]);
    if (!background) return h(Box, { title: '正在读取背景…' });
    const pending = draft && draft.id !== active?.id ? draft : null;
    const sourceEntry = r => h('details', { key: r.ref, className: 'patrol-background-entry' },
      h('summary', null, `[${r.ref}] ${r.title}`),
      h('p', null, r.summary),
      r.url && h(Button, { disabled: busy || running, onClick: () => act('/source', { url: r.url }) }, '查看背景原帖'),
      h(Hint, null, r.origin === 'curated-review' ? `采样评论 ${r.commentsRead} 条 · 人工检视配图 ${r.reviewedImages}/${r.sourceImageCount} 张 · ${r.coverage?.localOriginalAvailable ? '已关联本机原文' : '摘要与来源链接'}${r.coverage?.imageTextUnavailable ? '；模型配图转录未完整提供' : ''}。` : `阅读材料 ${r.originalChars || 0} 字 · 可见评论 ${r.commentsRead} 条 · 配图${r.coverage?.imagesUnread ? '未完整读取' : '无缺图标记'}。`),
      r.uncertainties.length > 0 && h(Hint, null, r.uncertainties.join('；')),
      r.observations.length > 0 && h('details', null, h('summary', null, '知识点与原文依据'), ...r.observations.map((o, i) => h('div', { key: i }, h('p', null, `${o.subject}：${o.explanation}`), h('blockquote', null, `${o.sourcePart} · ${o.status === 'source_claim' ? '来源说法' : o.status === 'uncertain' ? '不确定' : '可见内容'}：${o.quote}`)))));
    return h(React.Fragment, null,
      h(Box, { title: active ? `当前背景：${background.enabled ? '已启用' : '已关闭'}` : '当前背景：尚未设置' },
        active ? h(React.Fragment, null,
          h('p', null, active.origin === 'curated-review' ? `正在使用扩大阅读整理，包含 ${active.readings.length} 篇笔记的来源索引。已准备好，可以直接回“巡查结果”分析内容。` : `正在使用模型整理的背景笔记，来源 ${active.readings.length} 篇。可以直接回“巡查结果”分析内容。`),
          active.origin === 'curated-review' && h(Hint, null, '这份整理来自此前的36篇笔记、533条采样评论、91张配图记录，并注明阅读缺口；启用它不会重新调用模型阅读。'),
          h('label', null, h('input', { type: 'checkbox', checked: background.enabled, disabled: busy || running, onChange: e => act('/background/update', { enabled: e.target.checked }) }), ' 分析时使用当前背景'),
          h(Hint, null, `更新于 ${stamp(active.editedAt || active.completedAt)}。修改背景后，旧分析需要重新运行；不会自动产生调用。`),
          h('details', null, h('summary', null, '查看和修改背景笔记'),
            h(Hint, null, '这段笔记会随每条内容一起交给模型，解释人物、黑话和事件；具体行为标准在“规则与设置”中。'),
            h(Field, { label: '背景笔记（可以纠正）' }, h('textarea', { value: memo, rows: 15, maxLength: 24000, onChange: e => setMemo(e.target.value) })),
            h(Button, { disabled: busy || running || memo.trim().length < 20 || memo === active.memo, onClick: () => act('/background/update', { memo }) }, '保存背景笔记')),
          h('details', null, h('summary', null, `查看来源（${active.readings.length}篇）`), ...active.readings.map(sourceEntry))) : h('p', null, '还没有供模型参考的背景。可以在下面启用已整理的36篇背景，也可以自行重新阅读。')),
      h(Box, { title: '它怎样参与判断' },
        h('ol', null,
          h('li', null, '规则：定义人身攻击、地图炮、普通创作区引战等七类不合理行为。'),
          h('li', null, '背景：解释人物、黑话和事件，帮助模型理解原文。'),
          h('li', null, '分析：把目标原文和上下文，与规则、当前背景笔记和来源摘要一起交给模型，通常再补充3篇相关来源的文字。')),
        h(Hint, null, '不会每次重读全部36篇，也不会自动把新巡查记录加入背景。来源里的观点仍是来源观点，不能当作已证实事实或当前作者自己的话。')),
      h(Box, { title: '更换背景（可选）' },
        h('p', null, '当前背景可正常使用时，无需操作这里。'),
        h('details', null, h('summary', null, '使用已整理的36篇背景'),
          h(Hint, null, '直接启用此前的扩大阅读整理，替换当前背景笔记；不调用模型阅读。'),
          h(Button, { disabled: busy || running || !!active && active.presetRevision === background.preset?.revision,
            onClick: () => act('/background/preset', {}) }, active && active.presetRevision === background.preset?.revision ? '当前已使用这份整理' : '切换到36篇整理背景')),
        h('details', null, h('summary', null, '让模型重新阅读并替换背景'),
          h('p', null, '选择材料后，模型会先读文章与配图，再整理一份新背景。成功后替换当前背景，旧背景保留备份；不是把材料自动追加到当前36篇中。'),
          h('div', { className: 'patrol-grid-two' }, h(Field, { label: '文章来源' }, h('select', { value: source, onChange: e => setSource(e.target.value) }, h('option', { value: 'existing' }, '选择已采集文章'), h('option', { value: 'urls' }, '指定文章链接'), h('option', { value: 'search' }, '按关键词采集文章'))),
            h(Field, { label: '本次最多阅读篇数' }, h('input', { type: 'number', min: 1, max: 20, value: count, onChange: e => setCount(e.target.value) }))),
          source === 'existing' && h('div', null,
            h('details', null, h('summary', null, `选择文章（已选${selected?.length || 0}篇）`),
              h(Hint, null, `最多阅读所选文章中的前 ${count} 篇。`),
              ...background.articles.map(a => h('label', { key: a.id, style: { display: 'block', marginBottom: '8px' } }, h('input', { type: 'checkbox', checked: !!selected?.includes(a.id), onChange: e => setSelected(prev => e.target.checked ? [...(prev || []), a.id] : prev.filter(id => id !== a.id)) }), ` ${a.title}（已保存原图 ${a.savedImages}/${a.imageCount} 张）`))),
            !background.articles.length && h(Hint, null, '没有已采集文章，请指定链接或按关键词采集。'),
            h('label', null, h('input', { type: 'checkbox', checked: refreshSources, onChange: e => setRefreshSources(e.target.checked) }), ' 刷新原帖并补采原图')),
          source === 'urls' && h(Field, { label: '文章链接，每行一个' }, h('textarea', { rows: 4, value: links, onChange: e => setLinks(e.target.value) })),
          source === 'search' && h(Field, { label: '搜索词' }, h('input', { value: terms, onChange: e => setTerms(e.target.value) })),
          h(Hint, null, `会调用模型：最多 ${count} 次文章阅读、1次整理，另最多 ${count} 次看图；失败也计入调用。此过程不判断文章是否有问题。`),
          h(Button, { primary: true, disabled: busy || running || source === 'existing' && !selected?.length,
            onClick: () => act('/background/start', { source, count: Number(count), refreshSources, ...(source === 'existing' ? { ids: selected } : source === 'urls' ? { urls: links.split('\n').map(s => s.trim()).filter(Boolean) } : { keywords: split(terms) }) }) }, active ? '重新整理并替换背景' : '整理并启用背景'))),
      pending && h(Box, { title: '新背景整理进度' },
        h('p', null, `已读 ${pending.readings.length}／${pending.requestedCount} 篇 · ${pending.status === 'summarizing' ? '正在整理' : pending.status === 'reading' ? '正在阅读' : '未完成，当前背景保留'}`),
        pending.error && h('p', { className: 'patrol-error' }, pending.error),
        ...(pending.errors || []).map(e => h('p', { key: e.ref, className: 'patrol-error' }, `${e.ref} ${e.title}：${e.error}`)),
        h('details', null, h('summary', null, '查看本次阅读记录'), ...pending.readings.map(sourceEntry))));
  }
  function Workbench({ openConversation }) {
    const [tab, setTab] = useState('results');
    const [background, setBackground] = useState(null);
    const [state, setState] = useState(null), [catalog, setCatalog] = useState(null), [report, setReport] = useState(null);
    const [results, setResults] = useState({ total: 0, items: [] });
    const [filter, setFilter] = useState('all'), [offset, setOffset] = useState(0);
    const [notice, setNotice] = useState(null), [busy, setBusy] = useState(false);
    const [draft, setDraft] = useState(null), [keywords, setKeywords] = useState(''), [urls, setUrls] = useState('');
    const [collectOnly, setCollectOnly] = useState(false), [excludeSeen, setExcludeSeen] = useState(true);
    const [input, setInput] = useState({ kind: 'comment', title: '', text: '', context: '', url: '' });
    const lifecycle = useRef(null), requestId = useRef(0), initialized = useRef(false);
    const refresh = useCallback(async signal => {
      const id = ++requestId.current;
      const [next, records, evaluation, nextBackground] = await Promise.all([api('/status', undefined, signal),
        api(`/results?filter=${filter}&offset=${offset}&limit=20`, undefined, signal), api('/evaluation', undefined, signal), api('/background', undefined, signal)]);
      if (signal.aborted || id !== requestId.current) return;
      setState(next); setReport(evaluation); setBackground(nextBackground);
      if (offset > 0 && records.total <= offset) { setOffset(Math.max(0, Math.floor((records.total - 1) / 20) * 20)); } else setResults(records);
      if (!initialized.current) { initialized.current = true; setDraft(next.settings); setKeywords(next.settings.keywords.join('，')); }
    }, [filter, offset]);
    useEffect(() => {
      const controller = new AbortController(); lifecycle.current = controller;
      api('/models', undefined, controller.signal).then(setCatalog).catch(error => { if (!controller.signal.aborted) setNotice({ error: true, text: error.message }); });
      return () => { controller.abort(); lifecycle.current = null; };
    }, []);
    useEffect(() => {
      const controller = new AbortController(); let fetching = false;
      const tick = async () => {
        if (fetching || controller.signal.aborted || document.hidden) return;
        fetching = true;
        try { await refresh(controller.signal); }
        catch (error) { if (!controller.signal.aborted) setNotice({ error: true, text: error.message }); }
        finally { fetching = false; }
      };
      tick(); const timer = setInterval(tick, 2500);
      return () => { controller.abort(); clearInterval(timer); };
    }, [refresh]);
    async function act(path, data = {}) {
      const controller = lifecycle.current;
      if (!controller || busy) return;
      setBusy(true); setNotice(null);
      try {
        const result = await api(path, data, controller.signal);
        if (controller.signal.aborted) return;
        setNotice({ text: result.message || '操作已保存。' });
        await refresh(controller.signal);
      } catch (error) { if (!controller.signal.aborted) setNotice({ error: true, text: error.message }); }
      finally { if (!controller.signal.aborted) setBusy(false); }
    }
    const running = !!state?.activeJob;
    const job = state?.jobs[0];
    const canContinue = !!job && ['paused', 'cancelled', 'interrupted'].includes(job.status) && job.mode !== 'evaluate';
    const continueLabel = job?.mode === 'analyze' || job?.mode === 'scan' && job.status !== 'paused' && job.options?.analyze && state?.counts.pending > 0 ? '继续分析剩余内容' : job?.mode === 'scan' ? '继续采集' : '继续任务';
    const route = state?.settings.provider ? state.settings : catalog?.current;
    const updateDraft = key => e => setDraft(prev => ({ ...prev, [key]: e.target.value }));
    const updateInput = key => e => setInput(prev => ({ ...prev, [key]: e.target.value }));
    return h('div', { className: 'patrol-native', 'data-patrol-native': true },
      h('div', { className: 'patrol-workbench' },
        h('header', { className: 'patrol-header' }, h('div', null,
          h('div', { className: 'patrol-title' }, h(WhaleIcon, { size: 36 }), h('h1', null, '鲸声守望'), h('span', { className: 'patrol-badge' }, '实验版 0.6.3')),
          h(Hint, null, '辅助发现不合理讨论，共同维护讨论与创作环境。')), 
          h('div', { className: 'patrol-actions' }, h('a', { href: BASE + '/export', download: true, className: 'patrol-button' }, '导出记录 ↓'), h(Button, { onClick: openConversation }, '回到对话'))),
        h('nav', { className: 'patrol-tabs', 'aria-label': '巡查工作台导航' }, ...[['results', '巡查结果'], ['background', '背景阅读'], ['import', '导入文字'], ['settings', '规则与设置'], ['evaluation', '示例评估']].map(([id, label]) =>
          h(Button, { key: id, 'aria-pressed': tab === id, onClick: () => setTab(id) }, label))),
        notice && h('div', { className: 'patrol-notice' + (notice.error ? ' patrol-error' : ''), role: notice.error ? 'alert' : 'status' }, notice.text),
        !state ? h(Box, { title: '正在连接巡查服务…' }, h(Hint, null, '如果连接失败，可刷新 DSH 后重试。')) : h(React.Fragment, null,
          job && (running || canContinue) && h(Box, { title: statuses[job.status] },
            h('p', { role: 'status' }, job.message), h(Hint, null, `采集 ${job.collected} · 分析 ${job.analyzed} · 复用 ${job.cached} · 失败 ${job.failed}`),
            h('div', { className: 'patrol-actions' }, running && h(Button, { disabled: busy, onClick: () => act('/stop') }, '停止任务'),
              !running && canContinue && h(Button, { primary: true, disabled: busy, onClick: () => act('/resume', { jobId: job.id }) }, continueLabel))),
          tab === 'results' && h(React.Fragment, null,
            h(Hint, null, state.background?.activeId && state.background.enabled ? `已启用背景笔记（来源 ${state.background.articlesRead} 篇），可直接分析；无需再运行背景阅读。` : '尚未启用背景。可先到“背景阅读”了解事件和用语，再分析内容。'),
            h('div', { className: 'patrol-stats' }, ...[['未阅内容', state.counts.unread], ['可疑', state.counts.suspicious], ['其它', state.counts.other], ['待模型分析', state.counts.pending]].map(([label, n]) =>
              h('div', { key: label }, h('span', null, label), h('strong', null, n)))),
            h(Hint, null, '结果只分“可疑”和“其它”；材料不足归入“其它”，原因仍会说明。待分析是处理状态，尚未计入结果。每次继续遵守每轮上限，跳过已完成内容。'),
            h(Box, { title: '发起一次巡查' }, h('p', { className: 'patrol-meta' }, `分析模型：${route?.provider || '读取中'} / ${route?.model || ''}`),
              h(Field, { label: '关键词' }, h('input', { value: keywords, onChange: e => setKeywords(e.target.value), placeholder: '大肥鱼，DeepSeek拟人' })),
              h('details', null, h('summary', null, '或指定笔记链接'), h(Field, { label: '每行一个链接' }, h('textarea', { value: urls, onChange: e => setUrls(e.target.value), rows: 3, placeholder: '小红书笔记或分享链接' }))),
              h('label', null, h('input', { type: 'checkbox', checked: excludeSeen, onChange: e => setExcludeSeen(e.target.checked) }), ' 排除已查过的笔记'),
              h(Hint, null, '按笔记编号跨任务去重，只读新笔记。要更新旧帖正文或新评论，请取消勾选。未读成功的笔记仍会重试。'),
              h('div', { className: 'patrol-actions' }, h('span', { className: 'patrol-meta' }, `已查缓存：${state.seenCache?.count || 0} 篇`),
                h(Button, { disabled: busy || running || !state.seenCache?.count, onClick: () => act('/cache/clear') }, '清空已查缓存'),
                state.seenCache?.canRestore && h(Button, { disabled: busy || running, onClick: () => act('/cache/restore') }, '撤销上次清理')),
              h(Hint, null, '清空后旧帖可再次查找；原文、分析和人工复核保留。相同文字仍复用已有分析。'),
              h('label', null, h('input', { type: 'checkbox', checked: collectOnly, onChange: e => setCollectOnly(e.target.checked) }), ' 仅采集，暂不调用模型'),
              h('div', { className: 'patrol-actions' }, h(Button, { primary: true, disabled: busy || running, onClick: () => {
                const list = urls.split('\n').map(s => s.trim()).filter(Boolean); act('/start', { ...(list.length ? { urls: list } : { keywords: split(keywords) }), analyze: !collectOnly, excludeSeen });
              } }, '开始巡查'), h(Button, { disabled: busy || running, onClick: () => act('/login') }, state.browserOpen ? '查看采集浏览器' : '打开采集浏览器'),
              h(Button, { disabled: busy || running, onClick: () => act('/analyze') }, '分析未阅内容')),
              h(Hint, null, `本轮最多 ${state.settings.maxNotes} 篇笔记、每篇 ${state.settings.maxComments} 条可见评论、${state.settings.maxAnalysis} 条内容分析；另最多读取 ${state.settings.maxVision} 篇配图，每篇最多 ${state.settings.maxImagesPerNote} 张。疑似问题各额外核对一次，文字模型每条最多调用两次；失败也占用额度。`),
              h(Hint, null, '只能读取网页版实际展示的内容。要求 App 扫码的笔记会列为未读取，不送模型分析；可在 App 中复制原文到“导入文字”。首次需在采集浏览器登录。配图保存供复核，支持图片的模型可读取文字和画面。')),
            job && !running && !canContinue && h(Box, { title: statuses[job.status] || job.status }, h('p', null, job.message),
              job.notesAttempted !== undefined && h(Hint, null, `排除已查 ${job.notesExcluded || 0} 篇 · 检查 ${job.notesAttempted} 篇 · 读到 ${job.notesRead} 篇 · 未读取 ${job.skippedNotes?.length || 0} 篇`),
              (job.skippedNotes || []).length > 0 && h('details', { open: true }, h('summary', null, '未读取的笔记'), ...job.skippedNotes.map((entry, i) => h('div', { key: i }, h('p', null, entry.reason), h(Button, { disabled: busy, onClick: () => act('/source', { url: entry.url }) }, '在采集浏览器查看')))),
              h('details', null, h('summary', null, '查看任务日志'), h('ol', null, ...job.messages.map((log, i) => h('li', { key: i }, stamp(log.at) + ' · ' + log.message))))),
            h('div', { className: 'patrol-result-header' }, h('h2', null, '内容记录'), h('span', { className: 'patrol-meta' }, results.total + ' 条记录')),
            h('div', { className: 'patrol-actions patrol-filters', role: 'group', 'aria-label': '筛选结果' }, ...[['all', '未阅'], ['suspicious', '可疑'], ['other', '其它'], ['unanalyzed', '待分析'], ['read', '已阅']].map(([id, label]) =>
              h(Button, { key: id, 'aria-pressed': filter === id, onClick: () => { setFilter(id); setOffset(0); } }, label))),
            results.items.length ? results.items.map(item => h(RecordCard, { key: item.id, item, busy, running, act, hasBackground: !!state.background?.activeId && state.background.enabled })) : h(Box, { title: filter === 'read' ? '还没有已阅记录' : '当前列表没有未阅内容' }, h(Hint, null, filter === 'read' ? '在内容卡片点击“已阅”，之后可以在这里找回。' : '已阅内容在“已阅”中保留；可以换个筛选或继续巡查。')),
            results.total > 20 && h('div', { className: 'patrol-actions' }, h(Button, { disabled: offset === 0, onClick: () => setOffset(n => Math.max(0, n - 20)) }, '上一页'),
              h('span', null, `${Math.floor(offset / 20) + 1} / ${Math.ceil(results.total / 20)}`), h(Button, { disabled: offset + 20 >= results.total, onClick: () => setOffset(n => n + 20) }, '下一页'))),
          tab === 'import' && h(Box, { title: '导入一段原文' }, h(Hint, null, '原文和上下文将发送到当前模型服务。不需要登录小红书。'),
            h('form', { onSubmit: async e => { e.preventDefault(); await act('/import', { ...input, title: input.title || '手动导入' }); } },
              h('div', { className: 'patrol-grid-two' }, h(Field, { label: '类型' }, h('select', { value: input.kind, onChange: updateInput('kind') }, h('option', { value: 'comment' }, '评论'), h('option', { value: 'note' }, '笔记'))),
                h(Field, { label: '标题' }, h('input', { value: input.title, onChange: updateInput('title'), maxLength: 500 }))),
              h(Field, { label: '原文' }, h('textarea', { value: input.text, onChange: updateInput('text'), required: true, rows: 7, maxLength: 15000 })),
              h(Field, { label: '上下文' }, h('textarea', { value: input.context, onChange: updateInput('context'), rows: 4, maxLength: 15000, placeholder: '上级评论、所属笔记，或这句话在回应谁…' })),
              h(Field, { label: '原帖链接（可选）' }, h('input', { value: input.url, onChange: updateInput('url'), maxLength: 2000 })),
              h('div', { className: 'patrol-actions' }, h(Button, { primary: true, type: 'submit', disabled: busy || running }, '导入并分析'),
                h(Button, { onClick: () => setInput({ kind: 'comment', title: '语境校准示例（非真实帖子）', url: '', text: '有人说“去把她开盒，让她退网”，我反对这种做法。讨论作品可以，骚扰作者不行。', context: '这是引用和明确反驳。' }) }, '填入示例'),
                h(Button, { onClick: () => setTab('results') }, '查看巡查记录')))),
          tab === 'settings' && draft && h('form', { onSubmit: e => {
            e.preventDefault(); if (draft.visionProvider && !draft.visionModel) { setNotice({ error: true, text: '请选择看图模型。' }); return; } if (draft.provider && !draft.model) { setNotice({ error: true, text: '请选择分析模型。' }); return; }
            act('/settings', { ...draft, keywords: split(keywords), maxNotes: Number(draft.maxNotes), maxComments: Number(draft.maxComments), maxAnalysis: Number(draft.maxAnalysis), maxVision: Number(draft.maxVision), maxImagesPerNote: Number(draft.maxImagesPerNote) });
          } }, h(Box, { title: '模型与扫描范围' }, h(Hint, null, '复用 DSH 已配置的模型和凭据，不在这里保存 API 密钥。'),
              h('div', { className: 'patrol-grid-two' }, h(Field, { label: '模型服务' }, h('select', { value: draft.provider, onChange: e => setDraft(prev => ({ ...prev, provider: e.target.value, model: '' })) },
                h('option', { value: '' }, '跟随 DSH 默认模型'), ...(catalog?.providers || []).map(p => h('option', { key: p.id, value: p.id }, p.name || p.id)))),
                h(Field, { label: '分析模型' }, h('select', { value: draft.model, disabled: !draft.provider, onChange: updateDraft('model') },
                  h('option', { value: '' }, draft.provider ? '请选择模型' : '跟随默认模型'),
                  ...(catalog?.providers.find(p => p.id === draft.provider)?.models || []).map(m => h('option', { key: m.id, value: m.id }, m.name || m.id))))),
              h('div', { className: 'patrol-grid-three' }, ...[['maxNotes', '每轮笔记上限', 1, 30], ['maxComments', '每篇评论上限', 0, 50], ['maxAnalysis', '每轮分析上限', 1, 100]].map(([id, label, min, max]) =>
                h(Field, { key: id, label }, h('input', { type: 'number', value: draft[id], min, max, required: true, onChange: updateDraft(id) })))),
              h(Hint, null, `这一批最多采集 ${Number(draft.maxNotes) * (1 + Number(draft.maxComments))} 条正文和评论，分析名额 ${draft.maxAnalysis} 条。疑似问题额外核对一次，文字模型每条最多调用两次；每次回复最多8,192 token，思考也可能占用回复额度。`)),
            h(Box, { title: '配图读取' },
              h('label', null, h('input', { type: 'checkbox', checked: draft.readImages, onChange: e => setDraft(prev => ({ ...prev, readImages: e.target.checked })) }), ' 分析时读取配图文字和画面'),
              h(Hint, null, '采集时保存网页展示的原图。看图另计调用，识别结果供正文和所属评论分析使用；失败、漏图、模糊会提示。仅采集不会调用模型。'),
              h('div', { className: 'patrol-grid-two' }, h(Field, { label: '看图服务' }, h('select', { value: draft.visionProvider, onChange: e => setDraft(prev => ({ ...prev, visionProvider: e.target.value, visionModel: '' })) },
                h('option', { value: '' }, '跟随内容分析模型'), ...(catalog?.providers || []).map(p => h('option', { key: p.id, value: p.id }, p.name || p.id)))),
                h(Field, { label: '看图模型' }, h('select', { value: draft.visionModel, disabled: !draft.visionProvider, onChange: updateDraft('visionModel') },
                  h('option', { value: '' }, draft.visionProvider ? '请选择支持图片的模型' : '跟随内容分析模型'),
                  ...(catalog?.providers.find(p => p.id === draft.visionProvider)?.models || []).filter(m => m.inputModalities?.includes('image')).map(m => h('option', { key: m.id, value: m.id }, m.name || m.id))))),
              h('div', { className: 'patrol-grid-two' }, ...[['maxVision', '每轮看图笔记上限', 1, 30], ['maxImagesPerNote', '每篇配图上限', 1, 18]].map(([id, label, min, max]) => h(Field, { key: id, label }, h('input', { type: 'number', value: draft[id], min, max, required: true, onChange: updateDraft(id) })))),
              h(Hint, null, '看图每篇输出最多8,000 token，图片输入也可能收费。以上是调用上限，不是金额预算。正文模型可继续使用现有模型；看图模型必须支持图片。')),
            h(Box, { title: '判断规则' }, h(Hint, null, '按具体行为维护社区环境：人身侮辱、地图炮、普通创作区引战、牵连无关角色、威胁开盒、骚扰报复、造谣冒充。对不同立场使用相同标准，可以修改。'),
              h(Field, { label: '判断规则' }, h('textarea', { value: draft.rules, onChange: updateDraft('rules'), rows: 16, required: true, minLength: 20, maxLength: 12000 }))),
            h(Button, { type: 'submit', primary: true, disabled: busy || running }, '保存设置')),
          tab === 'background' && h(Background, { background, busy, running, act, defaultKeywords: keywords }),
          tab === 'evaluation' && h(Evaluation, { report, busy, running, maxAnalysis: state.settings.maxAnalysis, act })),
        h('footer', { className: 'patrol-footer' }, '实验性内容巡查结果 · 判断依据是具体言行和语境 · 配图机器识别须核对 · 记录保存在本机')));
  }
  return { name: 'dafeiyu-patrol-client', inject: ['slots', 'layout'], apply(ctx) {
    // Only our stylesheet is added to the document, with an explicit disposer.
    ctx.effect(() => {
      const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/plugins/dafeiyu-patrol/native.css';
      document.head.append(link); return () => link.remove();
    }, 'patrol native stylesheet');
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID,
      inject: () => ({ openConversation: () => ctx.layout.selectPanel(null) }) }, Workbench));
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: '鲸声守望' }, WhaleIcon));
  } };
} });
