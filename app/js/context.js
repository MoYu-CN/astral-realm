/* context.js — 上下文预算与压缩
 *
 * 目标不是把历史全部塞给模型，而是：
 *   1. 近期消息完整保留到预算上限；
 *   2. 更早的消息压成可读摘要，标明已压缩条数；
 *   3. 单个工具结果超限时截断，避免一次读文件吃掉整个窗口。
 *
 * 这里是规则压缩，不额外调用模型，成本为 0、结果可复现。
 */

import { estimateTextTokens } from './core.js'

export const DEFAULT_CONTEXT_TOKENS = 12000
export const DEFAULT_HISTORY_LIMIT = 24
export const DEFAULT_TOOL_RESULT_TOKENS = 6000
/* 手动上限；设成 0 或超过这个值都视为「不设上限」 */
export const MAX_CONTEXT_TOKENS = 64000

export function contextTokenBudget (settings) {
  const raw = settings && settings.context ? settings.context.maxTokens : undefined
  if (raw === 0 || raw === null) return Number.POSITIVE_INFINITY
  const value = Number(raw)
  if (!Number.isFinite(value)) return DEFAULT_CONTEXT_TOKENS
  /* 兼容旧配置里为了「不限制」而填的超大数字 */
  if (value > MAX_CONTEXT_TOKENS) return Number.POSITIVE_INFINITY
  return Math.min(MAX_CONTEXT_TOKENS, Math.max(2000, Math.round(value)))
}

export function contextHistoryLimit (settings) {
  const value = Number(settings && settings.context && settings.context.historyLimit)
  if (!Number.isFinite(value)) return DEFAULT_HISTORY_LIMIT
  return Math.min(80, Math.max(2, Math.round(value)))
}

function clip (text, maxChars) {
  const source = String(text || '').replace(/\s+/g, ' ').trim()
  if (source.length <= maxChars) return source
  return `${source.slice(0, maxChars)}…`
}

function summaryLine (omitted) {
  if (!omitted.length) return ''
  const users = omitted.filter((item) => item.who === '用户').slice(-3).map((item) => clip(item.text, 120))
  const agents = [...new Set(omitted.map((item) => item.who).filter((who) => who && who !== '用户'))].slice(0, 6)
  const parts = [`【已压缩 ${omitted.length} 条较早消息】`]
  if (users.length) parts.push(`用户此前要求：${users.join('；')}`)
  if (agents.length) parts.push(`涉及成员：${agents.join('、')}`)
  return parts.join('\n')
}

/**
 * @param {{who:string,text:string}[]} messages 旧 → 新
 * @param {{budgetTokens?:number,maxRecent?:number,channel?:string}} options
 */
export function compactTranscript (messages, options = {}) {
  const entries = (messages || [])
    .filter((item) => item && String(item.text || '').trim())
    .map((item) => ({ who: item.who || 'Agent', text: String(item.text) }))
  if (!entries.length) return ''
  const budget = Math.max(300, Number(options.budgetTokens) || DEFAULT_CONTEXT_TOKENS)
  const maxRecent = Math.max(2, Number(options.maxRecent) || DEFAULT_HISTORY_LIMIT)
  const candidates = entries.slice(-maxRecent)
  const selected = []
  let used = 0
  for (let index = candidates.length - 1; index >= 0; index--) {
    const item = candidates[index]
    const line = `${item.who}：${clip(item.text, 1200)}`
    const cost = estimateTextTokens(line) + 2
    if (selected.length && used + cost > budget) break
    selected.unshift(line)
    used += cost
  }
  const omitted = entries.slice(0, Math.max(0, entries.length - selected.length))
  const summary = summaryLine(omitted)
  const header = options.channel === 'agent' ? '【协作区近期往来】' : '【近期对话】'
  return [header, summary, ...selected].filter(Boolean).join('\n')
}

export function compactToolResult (text, options = {}) {
  const source = String(text == null ? '' : text)
  const budget = Math.max(200, Number(options.budgetTokens) || DEFAULT_TOOL_RESULT_TOKENS)
  const tokens = estimateTextTokens(source)
  if (tokens <= budget || !source) return source
  const headChars = Math.max(200, Math.floor(budget * 2 * 0.72))
  const tailChars = Math.max(120, Math.floor(budget * 2 * 0.18))
  const head = source.slice(0, headChars)
  const tail = source.slice(-tailChars)
  return `${head}\n……（工具结果已压缩：原约 ${Math.round(tokens)} tokens，省略中间部分，保留开头与结尾）……\n${tail}`
}
