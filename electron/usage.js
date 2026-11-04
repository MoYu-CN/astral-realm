'use strict'

/* usage.js — 从供应商流式响应中合并真实 token 用量
 *
 * 支持：
 *   OpenAI 兼容   usage.prompt_tokens / completion_tokens / total_tokens
 *   Anthropic     message_start.message.usage / message_delta.usage
 *   Ollama        prompt_eval_count / eval_count
 *
 * 合并采用逐字段取最大值：流式事件会重复/分段上报，不能累加。
 */

function mergeUsage (current, json, kind) {
  if (!json || typeof json !== 'object') return current
  let input = 0
  let output = 0
  let total = 0
  let seen = false
  const take = (source) => {
    if (!source || typeof source !== 'object') return
    const i = Number(source.input_tokens ?? source.prompt_tokens)
    const o = Number(source.output_tokens ?? source.completion_tokens)
    const t = Number(source.total_tokens)
    if (![i, o, t].some((value) => Number.isFinite(value))) return
    if (Number.isFinite(i)) input = Math.max(input, i)
    if (Number.isFinite(o)) output = Math.max(output, o)
    if (Number.isFinite(t)) total = Math.max(total, t)
    seen = true
  }
  take(json.usage)
  if (kind === 'anthropic' && json.message) take(json.message.usage)
  if (kind === 'ollama') {
    const i = Number(json.prompt_eval_count)
    const o = Number(json.eval_count)
    if (Number.isFinite(i) || Number.isFinite(o)) {
      if (Number.isFinite(i)) input = Math.max(input, i)
      if (Number.isFinite(o)) output = Math.max(output, o)
      seen = true
    }
  }
  if (!seen) return current
  const usage = current || { input: 0, output: 0, total: 0 }
  usage.input = Math.max(usage.input || 0, input)
  usage.output = Math.max(usage.output || 0, output)
  usage.total = Math.max(usage.total || 0, total, usage.input + usage.output)
  usage.reported = true
  return usage
}

function costOf (usage, pricing) {
  if (!usage || !pricing) return { cost: 0, currency: '', priced: false }
  const inputPrice = Number(pricing.inputPerMillion)
  const outputPrice = Number(pricing.outputPerMillion)
  if (!Number.isFinite(inputPrice) || !Number.isFinite(outputPrice)) {
    return { cost: 0, currency: '', priced: false }
  }
  const cost = (Number(usage.input || 0) / 1000000) * inputPrice +
    (Number(usage.output || 0) / 1000000) * outputPrice
  return {
    cost,
    currency: String(pricing.currency || 'USD').toUpperCase(),
    priced: true
  }
}

module.exports = { mergeUsage, costOf }
