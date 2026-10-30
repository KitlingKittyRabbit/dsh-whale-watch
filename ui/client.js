/* Browser module: official DSH slots; no iframe, DOM sidebar patching, or extra React runtime. */
window.__ModuleLoader__.load({ id: 'dsh-dafeiyu-patrol', factory: require => {
  const React = require('react');
  const { useState, useEffect, useRef, useCallback } = React;
  const h = React.createElement;
  const PANEL_ID = 'dafeiyu-patrol';
  const BASE = '/plugins/dafeiyu-patrol/api';
  const decisions = { normal: '其它', review: '可疑', uncertain: '其它' };
  const statuses = { running: '正在处理', completed: '任务完成', partial: '部分完成，请查看任务详情', paused: '等待你处理', failed: '任务未完成', cancelled: '已停止', interrupted: '上次任务中断' };
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
  function WatchIcon({ size = 20 }) {
    return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, style: { display: 'block', flexShrink: 0 } },
      h('path', { d: 'M10 16H7l-3 3V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v2' }),
      h('circle', { cx: 16, cy: 15, r: 4 }), h('path', { d: 'm19 18 3 3' }));
  }
  function DeskArtwork() {
    return h('figure', { className: 'patrol-desk-art', 'aria-hidden': true });
  }
  function Button({ children, primary, ...props }) {
    return h('button', { type: 'button', ...props, className: 'patrol-button' + (primary ? ' patrol-primary' : '') + (props.className ? ' ' + props.className : '') }, children);
  }
  const Hint = ({ children }) => h('p', { className: 'patrol-hint' }, children);
  const Box = ({ title, children, className = '', ...props }) => h('section', { ...props, className: 'patrol-box ' + className }, title && h('h2', null, title), children);
  function Field({ label, children }) { return h('label', { className: 'patrol-field' }, h('span', null, label), children); }
  const searchValues = (settings, options) => Object.fromEntries(Object.entries(options || {}).map(([key, option]) => [key, settings[key] || option.default]));
  function SearchControls({ options, values, disabled, onChange }) {
    return h('div', { className: 'patrol-grid-two' }, ...Object.entries(options || {}).map(([key, option]) =>
      h(Field, { key, label: option.label }, h('select', { value: values[key] || option.default, disabled, onChange: e => onChange(key, e.target.value) },
        ...option.choices.map(([value, label]) => h('option', { key: value, value }, label))))));
  }
  function RecordCard({ item, busy, running, act, hasBackground, embedded = false }) {
    const a = item.analysis;
    return h('article', { className: 'patrol-record', 'aria-label': item.title || '内容记录' },
      h('div', { className: 'patrol-card-head' }, h('div', null,
        h('h3', null, item.title || '无标题'),
        h('p', { className: 'patrol-meta' }, `${item.kind === 'comment' ? '评论' : '笔记'} · ${item.author || '手动导入或作者未读取'} · ${stamp(item.capturedAt)}`)),
      h('span', { className: 'patrol-badge ' + (a?.decision === 'review' ? 'review' : a ? 'normal' : '') }, a ? (item.analysisStale || item.analysisError ? '旧结论 · ' : '') + decisions[a.decision] : '未做模型分析')),
      h('div', { className: 'patrol-raw' }, item.text || '没有读到正文文字，请查看配图。'),
      item.discussion && h('div', null,
        h(Hint, null, `已保存 ${item.discussion.commentsRead} 条评论${item.discussion.reportedComments != null ? `／接口标注 ${item.discussion.reportedComments} 条` : ''} · ${item.discussion.complete ? '接口分页已读取完毕' : '评论区未完整读取'}`),
        ...(item.discussion.limitations || []).map((text, i) => h(Hint, { key: i }, text))),
      item.url && h('div', { className: 'patrol-actions' }, h('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer' }, '手动打开原帖 ↗')),
      item.context && h('details', { className: 'patrol-context' }, h('summary', null, '查看上下文'), h('div', { className: 'patrol-raw' }, item.context)),
      a && (item.analysisStale || item.analysisError) && h(Hint, null, '保留旧结论：尚未依据当前材料、规则与模型重新分析。普通续跑不会重算已成功的结果。'),
      a && h('div', { className: 'patrol-assessment' },
        a.interpretation && h('p', null, '本条含义：' + a.interpretation),
        a.categories.some(c => !['正常讨论', '信息不足'].includes(c)) && h('strong', null, a.categories.filter(c => !['正常讨论', '信息不足'].includes(c)).join(' · ')), h('p', null, a.reason),
        ...a.evidence.map((quote, i) => h('blockquote', { key: i }, h('small', null, a.evidenceSources?.[i] || '正文'), h('div', null, quote))),
        ...(a.imageEvidence || []).map((e, i) => h('blockquote', { key: 'image-' + i }, `配图${e.index}画面依据（${e.uncertain ? '识别不确定，' : ''}须人工核对）：${e.observation}`)),
        a.uncertainties.length > 0 && h(Hint, null, '判断局限：' + a.uncertainties.join('；')),
        a.contextUsed && h(Hint, null, `专题配置：${a.contextUsed.name}（分析时使用的版本）。`),
        a.backgroundUsed && h(Hint, null, `已读背景 ${a.backgroundUsed.articlesRead} 篇；本次带入 ${a.backgroundUsed.sourceRefs.join('、')} 材料${a.backgroundUsed.expanded ? '（已补读更多）' : ''}。`),
        a.discussionUsed && h(Hint, null, `结合所属笔记及 ${a.discussionUsed.commentsRead} 条已保存评论分析；${a.discussionUsed.contextScope === 'full-saved-discussion' ? '本次模型收到全部已保存讨论' : `讨论过长，本次提供相关讨论，未带入 ${a.discussionUsed.omittedComments} 条`}。${a.discussionUsed.complete ? '' : '采集有缺口，不能视作整个评论区。'}`),
        !embedded && a.decision === 'uncertain' && hasBackground && !item.backgroundExpanded && h(Button, { disabled: busy || running, onClick: () => act('/analyze/item', { id: item.id, backgroundExpanded: true }) }, '补读更多背景后重试'),
        a.route && h('p', { className: 'patrol-meta' }, `分析模型：${a.route.provider} / ${a.route.model} · ${stamp(a.analyzedAt)}`)),
      !embedded && item.analysisStale && h(Button, { disabled: busy || running, onClick: () => act('/analyze/item', { id: item.id }) }, '重新分析这条（模型费用另计）'),
      item.analysisError && h('div', null, h('p', { className: 'patrol-error' }, '分析失败：' + item.analysisError), !embedded && h(Button, { disabled: busy || running, onClick: () => act('/analyze/item', { id: item.id }) }, '重试这条')),
      !!item.coverage?.imageCount && h('details', { className: 'patrol-context' }, h('summary', null, `查看配图与机器识别：${item.vision?.pages?.length || 0} / ${item.coverage.imageCount} 张`),
        h(Hint, null, item.vision?.complete ? '配图已读取。机器识别可能出错，请对照原图复核。' : '配图尚未完整读取，当前判断仅覆盖已读取内容。'),
        item.vision?.error && h('p', { className: 'patrol-error' }, item.vision.error),
        ...(item.images || []).map(image => h('div', { key: image.index, className: 'patrol-image-page' }, h('strong', null, `配图${image.index}`),
          image.attachment ? h('a', { href: `${BASE}/image/${item.id}/${image.index}`, target: '_blank', rel: 'noopener noreferrer' }, h('img', { src: `${BASE}/image/${item.id}/${image.index}`, alt: `配图${image.index}原图`, loading: 'lazy', style: { maxWidth: '100%', maxHeight: '360px', objectFit: 'contain', display: 'block' } })) : h(Hint, null, image.error || '原图未保存'),
          ...(item.vision?.pages || []).filter(p => p.index === image.index).map(p => h('div', { key: p.index }, h('p', { className: 'patrol-raw' }, p.text || '没有识别到文字'), h('p', null, '画面：' + p.description), p.uncertain && h(Hint, null, '这一张存在模糊或不确定内容。'))))),
        item.vision?.route && h(Hint, null, `看图模型：${item.vision.route.provider} / ${item.vision.route.model}`)),
      item.coverage?.imagesUnread && !item.vision?.complete && !item.coverage?.imageCount && h(Hint, null, '配图尚未读取，当前判断仅覆盖已采集内容。'),
      !embedded && h('div', { className: 'patrol-actions' },
        h(Button, { disabled: busy, primary: !item.readAt, onClick: () => act('/read', { id: item.id, read: !item.readAt }) }, item.readAt ? '恢复未阅' : '已阅')));

  }
  function DiscussionCard({ item, busy, running, act, hasBackground }) {
    if (item.kind !== 'discussion') return h(RecordCard, { item, busy, running, act, hasBackground });
    const summary = item.discussionSummary, note = item.entries.find(i => i.id === item.noteId);
    const comments = item.entries.filter(i => i.kind === 'comment');
    const suspicious = comments.filter(i => i.inspectionResult === 'suspicious');
    const others = comments.filter(i => i.inspectionResult !== 'suspicious');
    const pending = item.entries.filter(i => !i.readAt && !i.inspectionResult);
    const failed = pending.filter(i => i.analysisError).length;
    const retained = item.entries.filter(i => !i.readAt && i.analysisStale && i.inspectionResult).length;
    const props = { busy, running, act, hasBackground, embedded: true };
    return h('article', { className: 'patrol-record', 'aria-label': '整篇讨论：' + item.title },
      h('div', { className: 'patrol-card-head' }, h('h3', null, item.title || '无标题笔记'),
        h('span', { className: 'patrol-badge ' + (item.inspectionResult === 'suspicious' ? 'review' : item.inspectionResult ? 'normal' : '') },
          item.inspectionResult === 'suspicious' ? '可疑' : item.inspectionResult === 'other' ? '其它' : '待分析')),
      h(Hint, null, `一篇笔记＋${summary.commentsRead}条已保存评论 · 可疑${summary.suspicious}条 · 其它${summary.other}条 · 待分析${summary.pending}条`),
      pending.length > 0 && h(Hint, null, `待分析组成：${failed}条失败 · ${pending.length - failed}条尚未分析。`),
      retained > 0 && h(Hint, null, `${retained}条保留旧结论（材料、规则或模型已变化），不计入待分析，不会自动重算。`),
      ...summary.limitations.map((text, i) => h(Hint, { key: i }, text)),
      note ? h('details', null, h('summary', null, '查看笔记正文、配图及作者判断'), h(RecordCard, { ...props, item: note }))
        : h(Hint, null, '所属笔记正文未保存，仅保留已有评论。'),
      item.url && h('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer' }, '打开原笔记 ↗'),
      suspicious.length > 0 && h('div', null, h('h4', null, '可疑评论'), ...suspicious.map(c => h(RecordCard, { ...props, item: c, key: c.id }))),
      others.length > 0 && h('details', null, h('summary', null, `查看其它及待分析评论（${others.length}条）`), ...others.map(c => h(RecordCard, { ...props, item: c, key: c.id }))),
      h('div', { className: 'patrol-actions' },
        h(Button, { primary: !item.readAt, disabled: busy || running, onClick: () => act('/read', { id: item.id, read: !item.readAt }) }, item.readAt ? '整篇恢复未阅' : '整篇已阅'),
        h(Button, { disabled: busy || running, onClick: () => act('/analyze/item', { id: item.id }) }, `重新分析整篇（${item.entries.length}条，模型费用另计）`)));
  }
  function Topic({ context, busy, running, act, openBuilder }) {
    const [panel, setPanel] = useState(null), [document, setDocument] = useState(null), [editing, setEditing] = useState(null);
    const [error, setError] = useState(''), [loading, setLoading] = useState(false), [preview, setPreview] = useState(null), [aliases, setAliases] = useState([]);
    const active = context?.active, disabled = busy || running || loading;
    useEffect(() => {
      const controller = new AbortController();
      api('/context/document', undefined, controller.signal).then(setDocument).catch(e => { if (!controller.signal.aborted) setError(e.message); });
      return () => controller.abort();
    }, [active?.hash, context?.hasBackground]);
    async function edit() {
      setLoading(true); setError('');
      try { const doc = await api('/context/document'); setDocument(doc); setEditing(structuredClone(doc)); setAliases(doc.config.glossary.map(t => t.aliases.join('，'))); setPanel('edit'); }
      catch (e) { setError(e.message); } finally { setLoading(false); }
    }
    async function importFile(e) {
      const file = e.target.files?.[0]; if (!file) return;
      setError(''); setLoading(true);
      try {
        if (file.size > 300000) throw new Error('配置文件不能超过300 KB');
        const result = await act('/context/import', { configJson: await file.text() });
        if (result) { setPanel(null); setEditing(null); }
      } catch (e) { setError(e.message); } finally { setLoading(false); e.target.value = ''; }
    }
    const change = (key, value) => setEditing(prev => ({ ...prev, config: { ...prev.config, [key]: value } }));
    const changeTerm = (index, key, value) => change('glossary', editing.config.glossary.map((t, i) => i === index ? { ...t, [key]: value } : t));
    const config = editing?.config, material = document?.config;
    return h(Box, { title: active?.name || '选择一个专题' },
      h(Hint, null, '背景和术语帮助 AI 理解讨论；判断标准在“设置”中。'),
      h(Hint, null, '“让 AI 制作”打开配置制作助手，只保存草稿；采用配置和巡查可在本页或“鲸声守望”对话中操作。'),
      h('div', { className: 'patrol-actions patrol-topic-actions' },
        h(Button, { disabled, onClick: () => { setPanel(panel === 'switch' ? null : 'switch'); setError(''); } }, '更换专题'),
        h(Button, { disabled, onClick: edit }, '编辑资料'),
        h(Button, { primary: true, disabled, onClick: async () => { setLoading(true); setError(''); try { await openBuilder(); } catch (e) { setError(e.message); } finally { setLoading(false); } } }, '让 AI 制作')),
      error && h('p', { className: 'patrol-error', role: 'alert' }, error),
      panel === 'switch' && h('div', { className: 'patrol-topic-section' },
        h(Button, { disabled, onClick: async () => { if (await act('/context/builtin')) setPanel(null); } }, '使用内置 DS 拟人争议'),
        h(Field, { label: '导入专题文件' }, h('input', { type: 'file', accept: '.json,application/json', disabled, onChange: importFile })),
        h(Hint, null, '选择文件后自动检查并载入。切换后可在“更多”中撤销。')),
      panel === 'edit' && config && h('form', { className: 'patrol-topic-section', onSubmit: async e => { e.preventDefault(); if (await act('/context/edit', { ...editing, config: { ...config, glossary: config.glossary.map((t, i) => ({ ...t, aliases: split(aliases[i] || '') })) } })) { setPanel(null); setEditing(null); } } },
        h(Field, { label: '专题名称' }, h('input', { value: config.name, required: true, maxLength: 100, disabled, onChange: e => change('name', e.target.value) })),
        h(Field, { label: '背景说明' }, h('textarea', { value: config.background.memo, rows: 10, maxLength: 24000, disabled, onChange: e => change('background', { ...config.background, memo: e.target.value }) })),
        h('h3', null, '术语解释'),
        ...config.glossary.map((t, i) => h('div', { key: i, className: 'patrol-topic-term' },
          h('div', { className: 'patrol-grid-two' },
            h(Field, { label: `术语 ${i + 1}` }, h('input', { value: t.term, required: true, maxLength: 100, disabled, onChange: e => changeTerm(i, 'term', e.target.value) })),
            h(Field, { label: `别名 ${i + 1}（逗号分隔）` }, h('input', { value: aliases[i] || '', disabled, onChange: e => setAliases(prev => prev.map((v, n) => n === i ? e.target.value : v)) }))),
          h(Field, { label: `含义 ${i + 1}` }, h('textarea', { value: t.meaning, required: true, rows: 3, maxLength: 1800, disabled, onChange: e => changeTerm(i, 'meaning', e.target.value) })),
          h('details', null, h('summary', null, '用法说明'), h(Field, { label: `用法说明 ${i + 1}` }, h('textarea', { value: t.usageNotes, rows: 3, maxLength: 2000, disabled, onChange: e => changeTerm(i, 'usageNotes', e.target.value) }))),
          h(Button, { disabled, onClick: () => { change('glossary', config.glossary.filter((_, n) => n !== i)); setAliases(prev => prev.filter((_, n) => n !== i)); } }, '删除此术语'))),
        h(Button, { disabled: disabled || config.glossary.length >= 100, onClick: () => { change('glossary', [...config.glossary, { term: '', aliases: [], meaning: '', usageNotes: '', status: 'source_claim', sourceRefs: [], sources: [] }]); setAliases(prev => [...prev, '']); } }, '添加术语'),
        h('details', null, h('summary', null, '语境说明'), ...config.interpretationNotes.map((text, i) => h(Field, { key: i, label: `语境说明 ${i + 1}` }, h('textarea', { value: text, rows: 4, maxLength: 4000, disabled, onChange: e => change('interpretationNotes', config.interpretationNotes.map((v, n) => n === i ? e.target.value : v)) })))),
        h('div', { className: 'patrol-actions' }, h(Button, { type: 'submit', primary: true, disabled }, '保存资料'), h(Button, { disabled, onClick: () => { setPanel(null); setEditing(null); } }, '取消'))),
      context?.draft && h('div', { className: 'patrol-topic-section' }, h('h3', null, `AI 草稿：${context.draft.name}`),
        h(Hint, null, `${context.draft.sources} 篇来源 · ${context.draft.terms} 个术语 · 尚未启用`),
        h('div', { className: 'patrol-actions' }, h(Button, { disabled, onClick: async () => { try { setPreview(preview ? null : await api('/context/draft/export')); } catch (e) { setError(e.message); } } }, preview ? '收起草稿' : '查看草稿'),
          h(Button, { primary: true, disabled, onClick: async () => { if (await act('/context/apply-draft')) setPreview(null); } }, '采用这份配置')),
        preview && h('div', null, h('p', { className: 'patrol-raw' }, preview.background.memo), ...preview.glossary.map(t => h('p', { key: t.term }, h('strong', null, t.term + '：'), t.meaning)))),
      panel !== 'edit' && material && h('div', { className: 'patrol-topic-section' },
        h('p', { className: 'patrol-meta' }, `${material.background.sources.length} 篇来源 · ${material.glossary.length} 个术语`),
        h('h3', null, '背景'), h('p', { className: 'patrol-raw' }, material.background.memo ? material.background.memo.slice(0, 360) + (material.background.memo.length > 360 ? '…' : '') : '还没有背景说明。'),
        material.background.memo.length > 360 && h('details', null, h('summary', null, '完整背景'), h('p', { className: 'patrol-raw' }, material.background.memo)),
        material.glossary.length > 0 && h('details', null, h('summary', null, '术语解释'), ...material.glossary.map(t => h('div', { key: t.term, className: 'patrol-background-entry' }, h('strong', null, t.term), h('p', null, t.meaning), t.usageNotes && h(Hint, null, t.usageNotes)))),
        material.background.sources.length > 0 && h('details', null, h('summary', null, '来源'), ...material.background.sources.map(s => h('div', { key: s.ref, className: 'patrol-background-entry' }, h('strong', null, `[${s.ref}] ${s.title}`), h('p', null, s.summary), s.url && h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, '查看来源 ↗'))))),
      h('details', { className: 'patrol-topic-more' }, h('summary', null, '更多'),
        h('div', { className: 'patrol-actions' }, h('a', { href: BASE + '/context/export', download: true }, '导出专题文件'),
          context?.canUndo && h(Button, { disabled, onClick: async () => { if (await act('/context/undo')) { setPanel(null); setEditing(null); setPreview(null); } } }, '撤销上次修改'),
          (active || context?.hasBackground) && h(Button, { disabled, onClick: async () => { if (await act('/context/unload')) { setPanel(null); setEditing(null); } } }, '卸下专题'))));
  }
  function Workbench({ openConversation, openBuilder }) {
    const [tab, setTab] = useState('results');
    const [state, setState] = useState(null), [catalog, setCatalog] = useState(null);
    const [results, setResults] = useState({ total: 0, items: [] });
    const [filter, setFilter] = useState('all'), [offset, setOffset] = useState(0);
    const [notice, setNotice] = useState(null), [busy, setBusy] = useState(false);
    const [draft, setDraft] = useState(null), [keywords, setKeywords] = useState(''), [urls, setUrls] = useState('');
    const [searchDraft, setSearchDraft] = useState({});
    const [collectOnly, setCollectOnly] = useState(false), [excludeSeen, setExcludeSeen] = useState(true);
    const collectionSource = 'socialdatax'; const [dataKey, setDataKey] = useState('');
    const [input, setInput] = useState({ kind: 'comment', title: '', text: '', context: '', url: '' });
    const lifecycle = useRef(null), requestId = useRef(0), initialized = useRef(false);
    const refresh = useCallback(async signal => {
      const id = ++requestId.current;
      const [next, records] = await Promise.all([api('/status', undefined, signal),
        api(`/results?filter=${filter}&offset=${offset}&limit=20`, undefined, signal)]);
      if (signal.aborted || id !== requestId.current) return;
      setState(next);
      if (offset > 0 && records.total <= offset) { setOffset(Math.max(0, Math.floor((records.total - 1) / 20) * 20)); } else setResults(records);
      if (!initialized.current) { initialized.current = true; setDraft(next.settings); setSearchDraft(searchValues(next.settings, next.searchOptions)); setKeywords(next.settings.keywords.join('，')); }
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
        if (path === '/data-key') setDataKey('');
        if (path === '/settings') { setDraft(result.settings); setSearchDraft(searchValues(result.settings, result.searchOptions)); }
        await refresh(controller.signal);
        return result;
      } catch (error) { if (!controller.signal.aborted) setNotice({ error: true, text: error.message }); }
      finally { if (!controller.signal.aborted) setBusy(false); }
    }
    const running = !!state?.activeJob;
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
      if (!running) return;
      setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(timer);
    }, [running]);
    const job = state?.jobs[0];
    const elapsed = Math.max(0, Math.floor((now - Date.parse(job?.startedAt || new Date(now).toISOString())) / 1000));
    const runningLabel = job?.mode === 'background' ? '正在阅读背景' : job?.mode === 'evaluate' ? '正在评估示例' : job?.mode === 'scan' ? job.options?.analyze ? '正在采集与分析' : '正在采集' : '正在分析';
    const pendingEntries = state?.counts.entries?.pending || 0;
    const failedEntries = state?.counts.analysisFailed || 0;
    const retainedEntries = state?.counts.retainedResults || 0;
    const canContinue = !!job && (['paused', 'cancelled', 'interrupted'].includes(job.status) || job.status === 'partial' && job.analysisDeferred) && job.mode !== 'evaluate';
    const continueLabel = job?.mode === 'analyze' || job?.mode === 'scan' && job.status !== 'paused' && job.options?.analyze && state?.counts.pending > 0 ? '继续分析剩余篇目' : job?.mode === 'scan' ? '继续采集' : '继续任务';
    const route = state?.settings.provider ? state.settings : catalog?.current;
    const topicName = !state ? '正在读取专题…' : state.background?.activeId && state.background.enabled ? state.context?.active?.name || '自定义资料' : '未选择专题';
    const updateDraft = key => e => setDraft(prev => ({ ...prev, [key]: e.target.value }));
    const updateInput = key => e => setInput(prev => ({ ...prev, [key]: e.target.value }));
    return h('div', { className: 'patrol-native', 'data-patrol-native': true },
      h('div', { className: 'patrol-workbench' },
        h('header', { className: 'patrol-header patrol-masthead ' + (tab === 'results' ? 'patrol-masthead-scene' : 'patrol-masthead-compact') },
          tab === 'results' && h(DeskArtwork),
          h('div', { className: 'patrol-brand-copy' },
            h('div', { className: 'patrol-title' }, h(WatchIcon, { size: 26 }), h('h1', null, '鲸声守望')),
            tab !== 'results' && h('p', { className: 'patrol-tagline' }, tab === 'topic' ? '管理背景、术语与讨论语境。' : '管理模型、判断规则与费用额度。'),
            h('p', { className: 'patrol-hero-topic' }, h('span', null, '当前专题'), h('strong', null, topicName)),
            h('div', { className: 'patrol-actions' }, h('a', { href: BASE + '/export', download: true, className: 'patrol-button' }, '导出记录 ↓'), h(Button, { onClick: openConversation }, '回到对话')))),
        h('nav', { className: 'patrol-tabs', 'aria-label': '巡查工作台导航' }, ...[['results', '巡查'], ['topic', '专题'], ['settings', '设置']].map(([id, label]) =>
          h(Button, { key: id, 'aria-pressed': tab === id, onClick: () => setTab(id) }, label))),
        notice && h('div', { className: 'patrol-notice' + (notice.error ? ' patrol-error' : ''), role: notice.error ? 'alert' : 'status' }, notice.text),
        !state ? h(Box, { title: '正在连接巡查服务…' }, h(Hint, null, '如果连接失败，可刷新 DSH 后重试。')) : h(React.Fragment, null,
          job && (running || canContinue) && h(Box, { className: running ? 'patrol-running-task' : '',
            title: running ? h('span', { className: 'patrol-running-heading' }, h('span', { className: 'patrol-spinner', 'aria-hidden': true }), runningLabel, h('span', { className: 'patrol-running-badge' }, '运行中')) : statuses[job.status] },
            running && h('p', { className: 'patrol-running-explainer' }, `已运行 ${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒 · 等待本批结果时，完成数会暂时不变。`),
            h('p', { role: 'status' }, job.message), job.searchSummary && h(Hint, null, job.searchSummary), h(Hint, null, `本轮：采集 ${job.collected} · 新分析 ${job.analyzed} · 复用 ${job.cached} · 失败 ${job.failed}`),
            job.apiRequests > 0 && h(Hint, null, `数据读取 ${job.apiRequests} 次 · 已确认 ¥${(job.apiCostCents / 100).toFixed(2)}${job.apiUnconfirmed ? ` · ${job.apiUnconfirmed} 次费用尚未确认` : ''} · 本轮数据上限 ¥${job.options.apiBudgetYuan}（模型另计）`),
            h('div', { className: 'patrol-actions' }, running && h(Button, { disabled: busy, onClick: () => act('/stop') }, '停止任务'),
              !running && canContinue && h(Button, { primary: true, disabled: busy, onClick: () => act('/resume', { jobId: job.id }) }, continueLabel))),
          tab === 'results' && h(React.Fragment, null,
            !(state.background?.activeId && state.background.enabled) && h(Hint, null, '请到“专题”选择或编辑背景和术语。'),
            h('div', { className: 'patrol-stats' }, ...[['未阅讨论', 'unread'], ['可疑', 'suspicious'], ['其它', 'other'], ['待分析', 'pending']].map(([label, key]) =>
              h('div', { key }, h('span', null, label), h('strong', null, `${state.counts[key]}篇`), h('span', { className: 'patrol-stat-entries' }, `${state.counts.entries?.[key] ?? 0}条`)))),
            h(Hint, null, `当前保存 ${state.counts.discussions} 篇笔记讨论${state.counts.standalone ? `，另有 ${state.counts.standalone} 条单独导入` : ''}；原始记录共 ${state.counts.records} 条，已归并显示。`),
            h(Hint, null, '按正文与评论统计条数；同一篇可包含多类结果，篇数不互斥。'),
            pendingEntries > 0 && h('div', { className: 'patrol-pending-summary' },
              h('p', null, h('strong', null, `待分析 ${pendingEntries} 条`), ` ＝ 仍失败 ${failedEntries} 条 ＋ 尚未分析 ${Math.max(0, pendingEntries - failedEntries)} 条。`),
              h(Hint, null, `保留旧结论 ${retainedEntries} 条：材料、规则或模型已变化，结果尚未重算。不计入待分析；需要重算时，请使用对应篇目的“重新分析整篇”。`),
              h(Hint, null, running ? '任务正在继续处理待分析内容，无需重复点击。上方“本轮失败”只统计本次尝试；这里“仍失败”统计所有保存内容。' : '“分析未阅篇目”只处理尚未分析和失败内容，保留已成功的结果。重新分析整篇会重算该篇所有已保存条目，模型费用另计。')),
            pendingEntries === 0 && retainedEntries > 0 && h(Hint, null, `保留 ${retainedEntries} 条旧结论；如需按新资料重算，点击对应篇目的“重新分析整篇”。`),
            h('details', { className: 'patrol-box' }, h('summary', null, '记录管理'),
              h('p', { className: 'patrol-meta' }, state.analysisCache ? `可清空旧结论：${state.analysisCache.count} 条，其中未阅 ${state.analysisCache.unreadCount} 条${state.analysisCache.canRestore ? `；可撤销上次清空的 ${state.analysisCache.backupCount} 条` : ''}` : '更新后重启 DSH 可启用此功能'),
              h(Hint, null, '只清除标为“旧结论”的正文、评论分析；原文、配图及识图缓存、已阅状态和有效新结论保留。清理本身不调用模型；之后点击“分析未阅篇目”才会重新分析未阅内容并产生模型费用。'),
              h('div', { className: 'patrol-actions' },
                h(Button, { disabled: busy || running || !state.analysisCache?.count, onClick: () => act('/analysis-cache/clear') }, '清空旧结论缓存'),
                state.analysisCache?.canRestore && h(Button, { disabled: busy || running, onClick: () => act('/analysis-cache/restore') }, '撤销清空旧结论')),
              h(Hint, null, '清空正文、评论、分析、已阅记录、对应巡查任务及已查缓存；模型、规则、背景和密钥保留。可撤销最近一次清空。'),
              h('div', { className: 'patrol-actions' },
                h(Button, { disabled: busy || running || !state.collection?.canClear, onClick: () => act('/collection/clear') }, '清空采集记录'),
                state.collection?.canRestore && h(Button, { disabled: busy || running, onClick: () => act('/collection/restore') }, '撤销清空采集记录'))),
            h(Box, { title: '发起一次巡查' }, h('p', { className: 'patrol-meta' }, `分析模型：${route?.provider || '读取中'} / ${route?.model || ''}`),
              h(Hint, null, '读取方式：数据 API。浏览器自动采集已停用，待风控问题解决后再考虑恢复；也可直接导入原文。'),
              collectionSource === 'socialdatax' && h(Hint, null, state.dataService?.configured ? `数据密钥已配置。按当前单价限制本轮数据请求，额度 ¥${state.settings.apiBudgetYuan}，模型费用另计。` : '先到“设置”填写 SocialDataX API Key。此方式不需要登录小红书。'),
              h(Field, { label: '关键词' }, h('input', { value: keywords, onChange: e => setKeywords(e.target.value), placeholder: '大肥鱼，DeepSeek拟人' })),
              h('details', null, h('summary', null, '搜索选项'),
              h(SearchControls, { options: state.searchOptions, values: searchDraft, disabled: busy || running, onChange: (key, value) => { setSearchDraft(prev => ({ ...prev, [key]: value })); setDraft(prev => ({ ...prev, [key]: value })); } }),
              h('div', { className: 'patrol-actions' }, h(Button, { disabled: busy || running, onClick: () => act('/settings', { ...state.settings, ...searchDraft }) }, '保存搜索选项为默认')),
              h(Hint, null, '选择立即用于下一次巡查；保存为默认后刷新也会保留。指定链接时笔记排序、时间及类型筛选不适用，评论排序仍有效；分析未阅不会重新搜索。'),
              h(Hint, null, '视频选项只读取接口提供的文字、配图和评论，不识别视频画面或音频。时间范围只提供接口支持的一天、一周、半年。多个关键词依次搜索，找到本轮数量即停止，不是合并后的全局热度排名。'),
              h('details', null, h('summary', null, '或指定笔记链接'), h(Field, { label: '每行一个链接' }, h('textarea', { value: urls, onChange: e => setUrls(e.target.value), rows: 3, placeholder: '小红书笔记或分享链接' }))),
              h('label', null, h('input', { type: 'checkbox', checked: excludeSeen, onChange: e => setExcludeSeen(e.target.checked) }), ' 排除已查过的笔记'),
              h(Hint, null, '按笔记编号跨任务去重，只读新笔记。要更新旧帖正文或新评论，请取消勾选。未读成功的笔记仍会重试。'),
              h('div', { className: 'patrol-actions' }, h('span', { className: 'patrol-meta' }, `已查缓存：${state.seenCache?.count || 0} 篇`),
                h(Button, { disabled: busy || running || !state.seenCache?.count, onClick: () => act('/cache/clear') }, '清空已查缓存'),
                state.seenCache?.canRestore && h(Button, { disabled: busy || running, onClick: () => act('/cache/restore') }, '撤销上次清理')),
              h(Hint, null, '清空后旧帖可再次查找；原文、分析和人工复核保留。相同文字仍复用已有分析。')),
              h('label', null, h('input', { type: 'checkbox', checked: collectOnly, onChange: e => setCollectOnly(e.target.checked) }), ' 仅采集，暂不调用模型'),
              h('div', { className: 'patrol-actions' }, h(Button, { primary: true, disabled: busy || running, onClick: () => {
                const list = urls.split('\n').map(s => s.trim()).filter(Boolean); act('/start', { ...(list.length ? { urls: list } : { keywords: split(keywords) }), collectionSource, analyze: !collectOnly, excludeSeen, ...searchDraft });
              } }, '按篇读取并分析'),
              h(Button, { disabled: busy || running, onClick: () => act('/analyze') }, '分析未阅篇目')),
              h(Hint, null, `本轮最多 ${state.settings.maxNotes} 篇，分页读取评论及回复，直到读完或费用上限。先收集再结合讨论分析，本轮最多分析 ${state.settings.discussionNoteLimit} 篇，篇内分批输出具体依据；超出篇目可继续分析。另最多看图 ${state.settings.maxVision} 条笔记或评论。`),
              h(Hint, null, '只读取接口返回的公开内容，不保证包含隐藏或删除的评论。读取不完整会显示原因；不会自动回退到浏览器。第三方 API 不等于平台官方授权。')),
            job && !running && !canContinue && h(Box, { title: statuses[job.status] || job.status }, h('p', null, job.message), job.searchSummary && h(Hint, null, job.searchSummary),
              job.apiRequests > 0 && h(Hint, null, `数据读取 ${job.apiRequests} 次 · 已确认 ¥${(job.apiCostCents / 100).toFixed(2)}${job.apiUnconfirmed ? ` · ${job.apiUnconfirmed} 次费用尚未确认` : ''}（模型另计）`),
              ...(job.discussionGaps || []).map((gap, i) => h(Hint, { key: i }, `${gap.title}：${gap.limitations.join('；')}`)),
              job.notesAttempted !== undefined && h(Hint, null, `排除已查 ${job.notesExcluded || 0} 篇 · 检查 ${job.notesAttempted} 篇 · 读到 ${job.notesRead} 篇 · 未读取 ${job.skippedNotes?.length || 0} 篇`),
              (job.skippedNotes || []).length > 0 && h('details', { open: true }, h('summary', null, '未读取的笔记'), ...job.skippedNotes.map((entry, i) => h('div', { key: i }, h('p', null, entry.reason), h('a', { href: entry.url, target: '_blank', rel: 'noopener noreferrer' }, '手动打开原帖 ↗')))),
              h('details', null, h('summary', null, '查看任务日志'), h('ol', null, ...job.messages.map((log, i) => h('li', { key: i }, stamp(log.at) + ' · ' + log.message))))),
            h('div', { className: 'patrol-result-header' }, h('h2', null, '笔记与评论区'), h('span', { className: 'patrol-meta' }, results.total + ' 篇')),
            h('div', { className: 'patrol-actions patrol-filters', role: 'group', 'aria-label': '筛选结果' }, ...[['all', '未阅'], ['suspicious', '可疑'], ['other', '其它'], ['unanalyzed', '待分析'], ['read', '已阅']].map(([id, label]) =>
              h(Button, { key: id, 'aria-pressed': filter === id, onClick: () => { setFilter(id); setOffset(0); } }, label))),
            results.items.length ? results.items.map(item => h(DiscussionCard, { key: item.id, item, busy, running, act, hasBackground: !!state.background?.activeId && state.background.enabled })) : h(Box, { title: filter === 'read' ? '还没有已阅记录' : '当前列表没有未阅内容' }, h(Hint, null, filter === 'read' ? '在内容卡片点击“已阅”，之后可以在这里找回。' : '已阅内容在“已阅”中保留；可以换个筛选或继续巡查。')),
            results.total > 20 && h('div', { className: 'patrol-actions' }, h(Button, { disabled: offset === 0, onClick: () => setOffset(n => Math.max(0, n - 20)) }, '上一页'),
              h('span', null, `${Math.floor(offset / 20) + 1} / ${Math.ceil(results.total / 20)}`), h(Button, { disabled: offset + 20 >= results.total, onClick: () => setOffset(n => n + 20) }, '下一页'))),
          tab === 'results' && h('details', { className: 'patrol-box' }, h('summary', null, '导入原文'), h(Box, { title: '导入一段原文' }, h(Hint, null, '原文和上下文将发送到当前模型服务。不需要登录小红书。'),
            h('form', { onSubmit: async e => { e.preventDefault(); await act('/import', { ...input, title: input.title || '手动导入' }); } },
              h('div', { className: 'patrol-grid-two' }, h(Field, { label: '类型' }, h('select', { value: input.kind, onChange: updateInput('kind') }, h('option', { value: 'comment' }, '评论'), h('option', { value: 'note' }, '笔记'))),
                h(Field, { label: '标题' }, h('input', { value: input.title, onChange: updateInput('title'), maxLength: 500 }))),
              h(Field, { label: '原文' }, h('textarea', { value: input.text, onChange: updateInput('text'), required: true, rows: 7, maxLength: 15000 })),
              h(Field, { label: '上下文' }, h('textarea', { value: input.context, onChange: updateInput('context'), rows: 4, maxLength: 15000, placeholder: '上级评论、所属笔记，或这句话在回应谁…' })),
              h(Field, { label: '原帖链接（可选）' }, h('input', { value: input.url, onChange: updateInput('url'), maxLength: 2000 })),
              h('div', { className: 'patrol-actions' }, h(Button, { primary: true, type: 'submit', disabled: busy || running }, '导入并分析'),
                h(Button, { onClick: () => setInput({ kind: 'comment', title: '语境校准示例（非真实帖子）', url: '', text: '有人说“去把她开盒，让她退网”，我反对这种做法。讨论作品可以，骚扰作者不行。', context: '这是引用和明确反驳。' }) }, '填入示例'),
                h(Button, { onClick: () => setTab('results') }, '查看巡查记录'))))),
          tab === 'settings' && draft && h('form', { onSubmit: e => {
            e.preventDefault(); if (draft.visionProvider && !draft.visionModel) { setNotice({ error: true, text: '请选择看图模型。' }); return; } if (draft.provider && !draft.model) { setNotice({ error: true, text: '请选择分析模型。' }); return; }
            act('/settings', { ...draft, keywords: split(keywords), apiBudgetYuan: Number(draft.apiBudgetYuan), discussionNoteLimit: Number(draft.discussionNoteLimit), maxNotes: Number(draft.maxNotes), maxComments: Number(draft.maxComments), maxAnalysis: Number(draft.maxAnalysis), maxVision: Number(draft.maxVision), maxImagesPerNote: Number(draft.maxImagesPerNote) });
          } }, h(Box, { title: '数据来源与费用' },
              h(Hint, null, '仅支持数据 API 采集。浏览器自动浏览、登录和原帖跳转接口均已停用；可离线导入或分析已保存内容。'),
              h('div', { className: 'patrol-grid-two' }, h(Field, { label: '本轮数据额度（元，按当前单价）' }, h('input', { type: 'number', min: 0.1, max: 100, step: 0.1, value: draft.apiBudgetYuan, required: true, onChange: updateDraft('apiBudgetYuan') })),
                h(Field, { label: '每轮最多分析的篇数（含已保存评论）' }, h('input', { type: 'number', min: 1, max: 30, value: draft.discussionNoteLimit, required: true, onChange: updateDraft('discussionNoteLimit') }))),
              h(Hint, null, '按当前0.10元/次限制请求总量，搜索、正文、一级评论和回复分页均计入。连接失败也保守占用名额，不自动重试；发现价格变化则停止。模型及看图费用另计。'),
              h(Hint, null, state.dataService?.configured ? 'SocialDataX 密钥已配置。留空不会覆盖已保存密钥。' : '尚未配置 SocialDataX 密钥。'),
              h(Field, { label: 'SocialDataX API Key（保存在本机）' }, h('input', { type: 'password', value: dataKey, autoComplete: 'new-password', maxLength: 512, onChange: e => setDataKey(e.target.value) })),
              h('div', { className: 'patrol-actions' }, h(Button, { disabled: busy || running || !dataKey.trim(), onClick: () => act('/data-key', { apiKey: dataKey }) }, '保存数据密钥'),
                state.dataService?.configured && h(Button, { disabled: busy || running, onClick: () => act('/data-key', { apiKey: '' }) }, '清除数据密钥'),
                h('a', { href: 'https://socialdatax.com/ai/', target: '_blank', rel: 'noopener noreferrer' }, '获取 API Key ↗'))),
            h(Box, { title: '默认搜索选项' }, h(SearchControls, { options: state.searchOptions, values: draft, disabled: busy || running, onChange: (key, value) => { setDraft(prev => ({ ...prev, [key]: value })); setSearchDraft(prev => ({ ...prev, [key]: value })); } }), h(Hint, null, '保存规则与设置后作为后续巡查的默认选择。')) ,
            h(Box, { title: '模型与分析范围' }, h(Hint, null, '复用 DSH 已配置的模型和凭据，不另存模型密钥。整篇分析按上面的篇数控制；单独导入和样例评估使用各自上限。'),
              h('div', { className: 'patrol-grid-two' }, h(Field, { label: '模型服务' }, h('select', { value: draft.provider, onChange: e => setDraft(prev => ({ ...prev, provider: e.target.value, model: '' })) },
                h('option', { value: '' }, '跟随 DSH 默认模型'), ...(catalog?.providers || []).map(p => h('option', { key: p.id, value: p.id }, p.name || p.id)))),
                h(Field, { label: '分析模型' }, h('select', { value: draft.model, disabled: !draft.provider, onChange: updateDraft('model') },
                  h('option', { value: '' }, draft.provider ? '请选择模型' : '跟随默认模型'),
                  ...(catalog?.providers.find(p => p.id === draft.provider)?.models || []).map(m => h('option', { key: m.id, value: m.id }, m.name || m.id))))),
              h('div', { className: 'patrol-grid-three' }, ...[['maxNotes', '每轮笔记上限', 1, 30], ['maxAnalysis', '单独导入及示例分析上限', 1, 100]].map(([id, label, min, max]) =>
                h(Field, { key: id, label }, h('input', { type: 'number', value: draft[id], min, max, required: true, onChange: updateDraft(id) })))),
              h(Hint, null, `API每轮最多读取 ${draft.maxNotes} 篇，评论及回复自动分页，受数据额度和采集保护上限限制。正文和已保存评论合并分析，每轮最多 ${draft.discussionNoteLimit} 篇；单独导入及示例评估上限 ${draft.maxAnalysis} 条。篇内分批判断，疑似问题另核对，模型费用另计。`)),
            h(Box, { title: '配图读取' },
              h('label', null, h('input', { type: 'checkbox', checked: draft.readImages, onChange: e => setDraft(prev => ({ ...prev, readImages: e.target.checked })) }), ' 分析时读取配图文字和画面'),
              h(Hint, null, '保存读取到的笔记和评论原图。看图另计调用，识别结果供整篇讨论分析使用；失败、漏图、模糊会提示。仅采集不会调用模型。'),
              h('div', { className: 'patrol-grid-two' }, h(Field, { label: '看图服务' }, h('select', { value: draft.visionProvider, onChange: e => setDraft(prev => ({ ...prev, visionProvider: e.target.value, visionModel: '' })) },
                h('option', { value: '' }, '跟随内容分析模型'), ...(catalog?.providers || []).map(p => h('option', { key: p.id, value: p.id }, p.name || p.id)))),
                h(Field, { label: '看图模型' }, h('select', { value: draft.visionModel, disabled: !draft.visionProvider, onChange: updateDraft('visionModel') },
                  h('option', { value: '' }, draft.visionProvider ? '请选择支持图片的模型' : '跟随内容分析模型'),
                  ...(catalog?.providers.find(p => p.id === draft.visionProvider)?.models || []).filter(m => m.inputModalities?.includes('image')).map(m => h('option', { key: m.id, value: m.id }, m.name || m.id))))),
              h('div', { className: 'patrol-grid-two' }, ...[['maxVision', '每轮看图内容上限', 1, 30], ['maxImagesPerNote', '每条内容配图上限', 1, 18]].map(([id, label, min, max]) => h(Field, { key: id, label }, h('input', { type: 'number', value: draft[id], min, max, required: true, onChange: updateDraft(id) })))),
              h(Hint, null, '看图每条内容输出最多32,768 token，图片输入也可能收费。以上是调用上限，不是金额预算。正文模型可继续使用现有模型；看图模型必须支持图片。')),
            h(Box, { title: '判断规则' }, h(Hint, null, '按具体行为维护社区环境：人身侮辱、地图炮、普通创作区引战、牵连无关角色、威胁开盒、骚扰报复、造谣冒充。对不同立场使用相同标准，可以修改。'),
              h(Field, { label: '判断规则' }, h('textarea', { value: draft.rules, onChange: updateDraft('rules'), rows: 16, required: true, minLength: 20, maxLength: 12000 }))),
            h(Button, { type: 'submit', primary: true, disabled: busy || running }, '保存设置')),
          tab === 'topic' && h(Topic, { context: state.context, busy, running, act, openBuilder })),
        h('footer', { className: 'patrol-footer' }, '鲸声守望 0.8.9（实验版） · 判断依据是具体言行和语境 · 配图机器识别须核对 · 记录保存在本机')));
  }
  return { name: 'dafeiyu-patrol-client', inject: ['slots', 'layout', 'sessions', 'remote', 'remote.agentPresets', 'uiWorkspace'], apply(ctx) {
    // Only our stylesheet is added to the document, with an explicit disposer.
    ctx.effect(() => {
      const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/plugins/dafeiyu-patrol/native.css?v=0.8.9-desk8';
      document.head.append(link); return () => link.remove();
    }, 'patrol native stylesheet');
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID,
      inject: () => ({ openConversation: () => ctx.layout.selectPanel(null), openBuilder: async () => {
        const id = await ctx.sessions.create();
        const result = await ctx.remote.agentPresets.select(id, 'whale-watch-context-builder');
        if (!result.ok) throw new Error(result.error.message || '无法打开配置制作助手');
        ctx.uiWorkspace.openSession(id);
      } }) }, Workbench));
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: '鲸声守望' }, WatchIcon));
  } };
} });
