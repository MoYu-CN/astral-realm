/* ask.js — 模型向用户发起结构化提问的本地工具。
 *
 * 提问以对话流内联卡片呈现，不打开弹窗/遮罩；同一时刻只允许一个问题。
 * 问题与选项由 chat.js 的 ask:show 监听器渲染，这里只负责协议、等待、取消和超时。
 */

import { bus } from './core.js'
import { ASK_LIMITS, askText as text, normalizeOptions } from './ask-spec.js'

const MAX_QUESTION = ASK_LIMITS.question
const MAX_CONTEXT = ASK_LIMITS.context
const TIMEOUT_MS = 10 * 60 * 1000

let active = null

function cancelResult (message = '用户取消了提问') {
  return { ok: false, cancelled: true, error: message }
}

function errorResult (message) {
  return { ok: false, error: message }
}

export async function askUserQuestion (raw = {}, agent = null) {
  if (active) return errorResult('已经有一个待回答的问题，请先处理当前问题')
  const args = raw && typeof raw === 'object' ? raw : {}
  const question = text(args.question, MAX_QUESTION)
  if (!question) return errorResult('提问内容为空')
  const options = normalizeOptions(args.options)
  const allowFreeform = args.allowFreeform !== false
  const multiple = Boolean(args.multiple) && options.length > 1
  const context = text(args.context, MAX_CONTEXT)
  const placeholder = text(args.placeholder, 200) || '补充说明（可选）'
  if (!options.length && !allowFreeform) return errorResult('没有选项时必须允许自由输入')
  if (!document.querySelector('#stream')) return errorResult('对话流不可用，无法显示提问')

  const id = `ask_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
  return new Promise((resolve) => {
    let settled = false
    let timeoutTimer = null
    const listeners = []

    const finish = (result) => {
      if (settled) return
      settled = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      for (const off of listeners) {
        try { off() } catch { /* ignore */ }
      }
      active = null
      bus.emit('ask:close', { id, result })
      resolve(result)
    }

    const cancel = (message) => finish(cancelResult(message))
    listeners.push(bus.on('run:cancelling', () => cancel('用户取消了本轮')))
    listeners.push(bus.on('session:clear', () => cancel('会话已清空')))
    listeners.push(bus.on('project:changed', () => cancel('已切换项目')))

    active = {
      id,
      question,
      cancel: () => cancel()
    }
    timeoutTimer = setTimeout(() => finish({
      ok: false,
      timeout: true,
      error: '等待用户回答超时'
    }), TIMEOUT_MS)

    bus.emit('ask:show', {
      id,
      agentName: agent && (agent.name || agent.short) ? agent.name || agent.short : '协作成员',
      question,
      context,
      options,
      multiple,
      allowFreeform,
      placeholder,
      resolve: finish
    })
  })
}

export function normalizeAskOptions (input) {
  return normalizeOptions(input)
}
