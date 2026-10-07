import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { systemPrompt, VERIFICATION_PROMPT, FINDING_CATEGORIES, canonicalCategory } from './rules.js';
import { parseAnalysis } from './schema.js';
import { hash } from './store.js';
import { analysisMaterial, imageContext, parseImageReading, IMAGE_PROMPT } from './images.js';
import { z } from 'zod';
import { backgroundInput, synthesisInput, parseReading, parseMemo, READING_PROMPT, MEMO_PROMPT } from './background.js';
import { randomUUID } from 'node:crypto';
import { DISCUSSION_PROMPT, discussionInput, discussionHash, DISCUSSION_TIMEOUT_MS } from './discussion.js';

export class DshModel {
  constructor(ctx) { this.ctx = ctx; this.sessionId = randomUUID(); }
  selection(settings) {
    const current = this.ctx.agentDefaultModel.currentSelection();
    return { provider: settings.provider || current.provider, model: settings.model || current.model };
  }
  async catalog() {
    const current = this.ctx.agentDefaultModel.currentSelection();
    const providers = this.ctx.llm.listProviders();
    const models = await Promise.all(providers.map(async provider => {
      try { return { ...provider, models: (await this.ctx.llm.listModels(provider.id)).map(m => ({ id: m.id, name: m.name || m.id, inputModalities: m.inputModalities || [] })) }; }
      catch { return { ...provider, models: [] }; }
    }));
    return { current, providers: models, mode: 'dsh' };
  }
  cacheKey(item, settings) { const key = [item.contentHash, item.context, item.vision, item.coverage, settings.rules, this.selection(settings), 'prompt-v9-context-files', settings.topicContext?.hash || null]; if (settings.backgroundContext) key.push(settings.backgroundContext.hash, !!item.backgroundExpanded); if (settings.discussionHash) key.push(settings.discussionHash, 'discussion-v1'); return hash(JSON.stringify(key)); }
  visionSelection(settings) {
    return settings.visionProvider ? { provider: settings.visionProvider, model: settings.visionModel } : this.selection(settings);
  }
  visionKey(item, settings) {
    return hash(JSON.stringify([item.images?.map(i => [i.index, i.attachment?.attachmentId, i.error]), item.coverage?.imageCount, this.visionSelection(settings), 'vision-v1']));
  }
  async readImages(item, settings, signal) {
    const route = this.visionSelection(settings);
    const imageCount = (item.images || []).filter(i => i.attachment).length;
    const maxTokens = imageCount > 3 ? 32768 : 8000;
    const timeoutMs = imageCount > 3 ? 180000 : 120000;
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const prepared = await this.ctx.llm.prepareCall({ ...route, maxTokens }, combined);
    if (!prepared.inputModalities?.includes('image')) throw new Error('当前看图模型未声明图片能力，请在规则与设置中选择支持图片的模型');
    const images = (item.images || []).filter(i => i.attachment);
    if (!images.length) throw new Error('没有成功保存的配图，请重新采集这篇笔记');
    const content = [{ type: 'text', text: `共${item.coverage.imageCount}张，以下实际提供${images.length}张。按每张图前标明的页码返回。` }];
    for (const image of images) content.push({ type: 'text', text: `配图页码：${image.index}` }, { type: 'image', attachment: image.attachment });
    const assembler = new BlockAssembler();
    for await (const chunk of prepared.stream({ ...prepared.config, system: IMAGE_PROMPT, messages: [createUserMessage({ content, source: { kind: 'dafeiyu-patrol-image-reading' } })], maxTokens, signal: combined, sessionId: this.sessionId })) {
      combined.throwIfAborted(); assembler.push(chunk);
    }
    combined.throwIfAborted();
    if (assembler.finish.kind !== 'stop') throw new Error(`看图模型未正常完成：${assembler.finish.kind}`);
    const output = assembler.blocks().filter(b => b.type === 'text').map(b => b.text).join('');
    return { ...parseImageReading(output, images, item.coverage.imageCount), route, readAt: new Date().toISOString(), usage: assembler.usage || null };
  }
  async backgroundCall(system, input, settings, signal, source) {
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000);
    const route = this.selection(settings); const assembler = new BlockAssembler();
    for await (const chunk of this.ctx.llm.stream({ ...route, system, messages: [createUserMessage({ content: [{ type: 'text', text: JSON.stringify(input) }], source: { kind: source } })], maxTokens: 16384, signal: combined, sessionId: this.sessionId })) { combined.throwIfAborted(); assembler.push(chunk); }
    combined.throwIfAborted();
    if (assembler.finish.kind !== 'stop') throw new Error(`背景阅读未正常完成：${assembler.finish.kind}（回复上限16,384 token，完整正文未采纳）`);
    return { text: assembler.blocks().filter(b => b.type === 'text').map(b => b.text).join(''), route, usage: assembler.usage || null };
  }
  async readBackground(material, settings, signal) {
    const out = await this.backgroundCall(READING_PROMPT, material, settings, signal, 'dafeiyu-background-reading');
    return { ...parseReading(out.text, material), route: out.route, usage: out.usage };
  }
  async summarizeBackground(readings, settings, signal) {
    const out = await this.backgroundCall(MEMO_PROMPT, synthesisInput(readings), settings, signal, 'dafeiyu-background-synthesis');
    return { memo: parseMemo(out.text, readings), route: out.route, usage: out.usage };
  }
  async analyze(item, settings, signal, { onVerification } = {}) {
    const route = this.selection(settings);
    const assembler = new BlockAssembler();
    const material = analysisMaterial(item);
    const input = JSON.stringify({ target: { kind: material.kind, text: material.text, title: material.kind === 'note' ? material.title : undefined, images: material.kind === 'note' ? imageContext(item) : undefined }, background: { topic: settings.topicContext || null, environment: backgroundInput(item, settings.backgroundContext, item.backgroundExpanded), noteTitle: material.kind === 'comment' ? material.title : undefined, context: material.context }, coverage: material.coverage });
    const timeout = AbortSignal.timeout(90000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    for await (const chunk of this.ctx.llm.stream({ ...route, system: systemPrompt(settings.rules),
      messages: [createUserMessage({ content: [{ type: 'text', text: input }], source: { kind: 'dafeiyu-patrol-analysis' } })],
      maxTokens: 8192, signal: combined, sessionId: this.sessionId,
    })) {
      combined.throwIfAborted(); assembler.push(chunk);
    }
    combined.throwIfAborted();
    if (assembler.finish.kind !== 'stop') {
      if (assembler.finish.kind === 'max-tokens') throw new Error('模型回复达到单条8,192 token上限，结果未完整生成。请点击“重试这条”，或换用其他已配置模型。');
      const detail = assembler.finish.failure?.message;
      throw new Error(`模型未正常完成：${assembler.finish.kind}${detail ? '（' + detail + '）' : ''}，请检查模型配置或重试`);
    }
    const output = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('');
    return this.finishAnalysis(item, settings, combined, { output, input, route, usage: assembler.usage }, { onVerification });
  }
  async analyzeDiscussion(records, targets, settings, signal, callbacks = {}) {
    const route = this.selection(settings);
    const discussion = discussionInput(records, targets);
    const environment = backgroundInput(records[0], settings.backgroundContext, targets.some(i => i.backgroundExpanded));
    const materials = targets.map(item => analysisMaterial(item));
    const input = JSON.stringify({ discussion, background: { topic: settings.topicContext || null, environment }, targets: materials.map(i => ({ id: i.id, kind: i.kind })) });
    const timeout = AbortSignal.timeout(DISCUSSION_TIMEOUT_MS);
    const combined = AbortSignal.any([signal, timeout]), assembler = new BlockAssembler();
    callbacks.onDiscussionCall?.();
    try {
      for await (const chunk of this.ctx.llm.stream({ ...route, system: systemPrompt(settings.rules) + '\n' + DISCUSSION_PROMPT,
        messages: [createUserMessage({ content: [{ type: 'text', text: input }], source: { kind: 'whale-watch-discussion-analysis' } })],
        maxTokens: 16384, signal: combined, sessionId: this.sessionId })) { combined.throwIfAborted(); assembler.push(chunk); }
      combined.throwIfAborted();
    } catch (error) {
      if (signal.aborted) throw error;
      if (timeout.aborted || error.name === 'TimeoutError') throw new Error('模型分析超过3分钟，本批未完成；再次分析时失败项会单独重试，已完成结果保留。');
      throw error;
    }
    if (assembler.finish.kind !== 'stop') throw new Error(`整篇讨论分析未正常完成：${assembler.finish.kind}，本批结论未采纳`);
    const text = assembler.blocks().filter(b => b.type === 'text').map(b => b.text).join('').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = z.object({ results: z.array(z.object({ id: z.string(), analysis: z.unknown() })).max(10) }).parse(JSON.parse(text));
    const wanted = new Set(targets.map(i => i.id)), seen = new Set();
    for (const row of parsed.results) { if (!wanted.has(row.id) || seen.has(row.id)) throw new Error('整篇讨论分析返回未知或重复目标，结果未采纳'); seen.add(row.id); }
    if (seen.size !== wanted.size) throw new Error('整篇讨论分析遗漏目标，结果未采纳');
    const rows = [];
    for (const item of targets) {
      signal.throwIfAborted(); const row = parsed.results.find(r => r.id === item.id);
      const target = analysisMaterial(item);
      const ownInput = JSON.stringify({ target: { kind: target.kind, text: target.text, title: target.title, images: imageContext(item) },
        background: { topic: settings.topicContext || null, environment, discussion }, coverage: target.coverage });
      try {
        const checkSignal = AbortSignal.any([signal, AbortSignal.timeout(90000)]);
        const analysis = await this.finishAnalysis(item, settings, checkSignal, { output: JSON.stringify(row.analysis), input: ownInput, route, usage: null }, callbacks);
        analysis.discussionUsed = { noteId: records[0].id, commentsRead: records.length - 1, contextScope: discussion.contextScope,
          omittedComments: discussion.omittedComments || 0, complete: !!records[0].discussion?.complete, hash: discussionHash(records) };
        rows.push({ id: item.id, analysis });
      } catch (error) { if (signal.aborted) throw error; rows.push({ id: item.id, error: error.name === 'TimeoutError' ? '证据核对超过90秒，初步指控未采纳；再次分析时本条单独重试。' : error.message }); }
    }
    return rows;
  }
  async finishAnalysis(item, settings, combined, { output, input, route, usage }, { onVerification } = {}) {
    const material = analysisMaterial(item);
    let result = parseAnalysis(output, material);
    if (!result.interpretation?.trim() || (material.text.trim() && !result.targetQuote?.trim())) throw new Error('模型未解释本条内容或未引用本条原文，结果未采纳');
    if (result.decision === 'review' && !result.findings?.length && !result.imageEvidence.length) throw new Error('模型没有给出具体问题对象和行为，结果未采纳');
    if (result.decision === 'review') {
      onVerification?.();
      const check = new BlockAssembler();
      const checkInput = JSON.stringify({ ...JSON.parse(input), proposedFindings: result.findings || [], proposedImageEvidence: result.imageEvidence });
      for await (const chunk of this.ctx.llm.stream({ ...route, system: VERIFICATION_PROMPT + `\n本次社区讨论规则：\n${settings.rules}`,
        messages: [createUserMessage({ content: [{ type: 'text', text: checkInput }], source: { kind: 'dafeiyu-patrol-evidence-check' } })],
        maxTokens: 8192, signal: combined, sessionId: this.sessionId,
      })) { combined.throwIfAborted(); check.push(chunk); }
      combined.throwIfAborted();
      if (check.finish.kind !== 'stop') throw new Error(`证据核对未完成：${check.finish.kind}，初步指控未采纳`);
      const rawCheck = check.blocks().filter(b => b.type === 'text').map(b => b.text).join('').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const verificationRaw = JSON.parse(rawCheck);
      if (Array.isArray(verificationRaw.findings)) verificationRaw.findings = verificationRaw.findings.map(f => ({ ...f, category: canonicalCategory(f.category) }));
      const verified = z.object({ verdict: z.enum(['supported', 'unsupported', 'needs_context']), reason: z.string().min(1).max(3000), findings: z.array(z.object({ category: z.enum(FINDING_CATEGORIES), quote: z.string().min(1).max(1200), target: z.string().min(1).max(500), behavior: z.string().min(1).max(1000) })).max(8), imageEvidence: z.array(z.object({ index: z.number().int().min(1).max(18), observation: z.string().min(1).max(1200) })).max(18).default([]) }).parse(verificationRaw);
      if (verified.verdict === 'supported' && !verified.findings.length && !verified.imageEvidence.length) throw new Error('证据核对未返回成立依据，初步指控未采纳');
      const proposed = result;
      const supported = verified.verdict === 'supported';
      const findings = supported ? verified.findings : [];
      result = parseAnalysis(JSON.stringify({ ...result,
        decision: supported ? 'review' : verified.verdict === 'needs_context' ? 'uncertain' : 'normal',
        categories: supported ? [...new Set(findings.map(f => f.category).concat(verified.imageEvidence.length ? result.categories.filter(c => !['正常讨论','信息不足'].includes(c)) : []))] : [verified.verdict === 'needs_context' ? '信息不足' : '正常讨论'],
        reason: verified.reason, evidence: findings.map(f => f.quote), findings,
        imageEvidence: supported ? verified.imageEvidence : [],
        missingContextAffectsDecision: verified.verdict === 'needs_context',
      }), material);
      result.verification = { ...verified, proposedCategories: proposed.categories, proposedReason: proposed.reason, proposedFindings: proposed.findings, route, usage: check.usage || null };
    }
    const evidenceSources = result.evidence.map(quote => item.text.includes(quote) ? '正文' : item.kind === 'note' && item.title?.includes(quote) ? '标题' : `配图${item.vision?.pages?.find(p => p.text.includes(quote))?.index || '?'}机器识别文字，须核对原图`);
    return { ...result, evidenceSources, contextUsed: settings.topicContext ? { id: settings.topicContext.id, name: settings.topicContext.name, hash: settings.topicContext.hash } : null, backgroundUsed: settings.backgroundContext ? { id: settings.backgroundContext.id, hash: settings.backgroundContext.hash, articlesRead: settings.backgroundContext.readings.length, sourceRefs: JSON.parse(input).background.environment.references.map(r => r.ref), expanded: !!item.backgroundExpanded } : null, policyVersion: 'community-environment-v8', route, analyzedAt: new Date().toISOString(), usage: usage || null };
  }
}
