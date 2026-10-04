import { z } from 'zod';
import { CATEGORIES, canonicalCategory } from './rules.js';

export const settingsSchema = z.object({
  keywords: z.array(z.string().trim().min(1).max(80)).min(1).max(5),
  provider: z.string().trim().max(100), model: z.string().trim().max(150),
  maxNotes: z.number().int().min(1).max(30),
  maxComments: z.number().int().min(0).max(50),
  maxAnalysis: z.number().int().min(1).max(100),
  readImages: z.boolean().default(true),
  visionProvider: z.string().trim().max(100).default(''), visionModel: z.string().trim().max(150).default(''),
  maxImagesPerNote: z.number().int().min(1).max(18).default(18),
  maxVision: z.number().int().min(1).max(30).default(5),
  rules: z.string().trim().min(20).max(12000),
});
export const startSchema = z.object({
  keywords: settingsSchema.shape.keywords.optional(),
  urls: z.array(z.string().max(2000)).max(30).optional(),
  maxNotes: settingsSchema.shape.maxNotes.optional(),
  maxComments: settingsSchema.shape.maxComments.optional(),
  maxAnalysis: settingsSchema.shape.maxAnalysis.optional(),
  analyze: z.boolean().optional(),
  readImages: z.boolean().optional(),
  maxImagesPerNote: settingsSchema.shape.maxImagesPerNote.optional(),
  maxVision: settingsSchema.shape.maxVision.optional(),
  backgroundExpanded: z.boolean().optional(),
  excludeSeen: z.boolean().default(true),
});
export const analysisSchema = z.object({
  decision: z.enum(['normal', 'review', 'uncertain']),
  categories: z.array(z.enum(CATEGORIES)).min(1).max(CATEGORIES.length),
  reason: z.string().min(1).max(3000),
  evidence: z.array(z.string().min(1).max(1200)).max(8),
  uncertainties: z.array(z.string().max(1200)).max(8),
  imageEvidence: z.array(z.object({ index: z.number().int().min(1).max(18), observation: z.string().min(1).max(1200) })).max(18).default([]),
  targetQuote: z.string().max(1200).optional(),
  interpretation: z.string().max(1500).optional(),
  missingContextAffectsDecision: z.boolean().default(false),
  findings: z.array(z.object({ category: z.enum(CATEGORIES), quote: z.string().min(1).max(1200), target: z.string().min(1).max(500), behavior: z.string().min(1).max(1000) })).max(8).optional(),
  confidence: z.number().min(0).max(1),
});
export const resumeSchema = z.object({ jobId: z.string().min(1).max(100).optional() });
export const readSchema = z.object({ id: z.string().min(1).max(100), read: z.boolean().default(true), backgroundExpanded: z.boolean().optional() });
export const reviewSchema = z.object({
  id: z.string().max(100),
  verdict: z.enum(['confirmed', 'dismissed', 'uncertain', 'pending']),
  note: z.string().max(2000).default(''),
});
export const importSchema = z.object({
  text: z.string().trim().min(1).max(15000),
  context: z.string().max(15000).default(''),
  title: z.string().max(500).default('手动导入'),
  url: z.string().max(2000).default(''),
  kind: z.enum(['note', 'comment']).default('comment'),
  analyze: z.boolean().default(true),
});

export function validateNoteUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('请输入小红书 HTTPS 笔记链接');
  const hosts = ['www.xiaohongshu.com', 'xiaohongshu.com'];
  if (hosts.includes(url.hostname) && /^\/(explore|discovery\/item|search_result)\/[a-f0-9]{24}(?:\/)?$/i.test(url.pathname)) return url.href;
  if (['xhslink.cn', 'xhslink.com'].includes(url.hostname) && /^\/[A-Za-z0-9/_-]+$/.test(url.pathname)) return url.href;
  throw new Error('链接必须指向小红书笔记，或小红书分享短链接');
}

export function parseAnalysis(output, item) {
  let text = output.trim();
  if (text.startsWith('```')) text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const raw = JSON.parse(text);
  if (Array.isArray(raw.categories)) raw.categories = raw.categories.map(canonicalCategory);
  if (Array.isArray(raw.findings)) raw.findings = raw.findings.map(f => ({ ...f, category: canonicalCategory(f.category) }));
  const result = analysisSchema.parse(raw);
  const ownText = item.text + (item.kind === 'note' ? '\n' + (item.title || '') : '');
  // Evidence belongs to this item's own text, not the parent or another comment.
  if (result.targetQuote && !ownText.includes(result.targetQuote)) throw new Error('模型分析对象引文不属于本条原文，结果未采纳');
  if (result.findings?.some(f => !ownText.includes(f.quote) || !result.categories.includes(f.category))) throw new Error('模型问题依据与本条原文或类别不符，结果未采纳');
  if (result.evidence.some(quote => !ownText.includes(quote))) throw new Error('模型引文与原文不符，结果未采纳');
  if (result.imageEvidence.some(e => item.kind !== 'note' || !item.images?.some(i => i.index === e.index && i.attachment) || !item.vision?.pages?.some(p => p.index === e.index))) throw new Error('图像依据没有对应的已读取配图，结果未采纳');
  const uncertainImages = result.imageEvidence.filter(e => item.vision?.pages?.find(p => p.index === e.index)?.uncertain);
  if (uncertainImages.length) {
    result.imageEvidence = result.imageEvidence.map(e => ({ ...e, uncertain: uncertainImages.includes(e) }));
    result.uncertainties.push('引用的画面识别存在不确定内容，必须对照原图核对。');
    if (result.decision === 'review' && result.evidence.length === 0) { result.decision = 'uncertain'; result.categories = [...new Set([...result.categories, '信息不足'])]; }
  }
  if (result.decision === 'review' && result.evidence.length === 0 && result.imageEvidence.length === 0) throw new Error('模型建议复核却没有原文依据，结果未采纳');
  const missingOwnContent = !!(item.coverage?.imagesUnread || item.coverage?.textTruncated);
  const missingBackground = !!(item.coverage?.parentMissing || item.coverage?.contextImagesUnread || item.coverage?.contextTextTruncated);
  if (missingOwnContent || missingBackground) {
    const limitation = missingOwnContent ? '本条自身的配图或后文未完整读取，结论仅覆盖已读取内容。' : '所属笔记文字/配图或上级评论未完整读取；这不自动表示本评论有问题。';
    result.uncertainties = [...new Set([...result.uncertainties, limitation])];
    if (result.decision === 'normal' && (missingOwnContent || (missingBackground && result.missingContextAffectsDecision))) {
      result.decision = 'uncertain';
      result.categories = [...new Set([...result.categories, '信息不足'])];
    }
  }
  return result;
}
