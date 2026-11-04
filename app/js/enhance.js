/* enhance.js — 提示词强化：调用模型扩写，预览后一键应用到输入框 */

import { state, $, h, toast, agentById, commander, messagesOf } from './core.js'
import { openModal } from './modal.js'
import { callModel } from './llm.js'

const SYSTEM = [
  '你是提示词工程师。把用户给的这段话改写成一条更清晰、更可执行的指令。',
  '你会收到最近几轮对话上下文。它的用途只有一个：补全原文里的指代、术语和用户已经明确说过的约束。',
  '要求：',
  '- 保留原意与全部约束，不新增需求，不臆造背景。',
  '- 上下文只作为参考，不得把上下文中没有被原文要求的背景、事实或交付物写进结果。',
  '- 如果上下文与原文无关，完全忽略上下文，只按原文强化。',
  '- 如果原文与上下文冲突，以原文为准。',
  '- 补全缺失的关键要素：目标、输入、交付形式、验收标准、约束边界。',
  '- 结构清楚，可直接粘贴给另一个模型执行。',
  '- 只输出改写后的指令正文，不要解释、不要开场白、不要前后对比。',
  '- 如果原文已经足够清晰，只做最小改动。'
].join('\n')

const CONTEXT_MAX_MESSAGES = 6
const CONTEXT_MAX_CHARS = 3200

/* 只取当前会话最近几轮，带上限；不会为了强化再调用一次摘要模型。 */
export function buildEnhanceContext ({ maxMessages = CONTEXT_MAX_MESSAGES, maxChars = CONTEXT_MAX_CHARS } = {}) {
  const channel = state.view === 'agent' ? 'agent' : 'user'
  const agent = state.activeAgentId ? agentById(state.activeAgentId) : commander()
  const thread = (agent && agent.id) || 'commander'
  let list = messagesOf(channel)
  if (channel === 'user') list = list.filter((msg) => (msg.thread || 'commander') === thread)
  list = list.filter((msg) => msg && !msg.streaming &&
    (msg.kind === 'user' || msg.kind === 'agent') &&
    String(msg.text || '').trim())

  const picked = []
  let used = 0
  for (let index = list.length - 1; index >= 0 && picked.length < maxMessages; index -= 1) {
    const label = list[index].kind === 'user'
      ? '用户'
      : (list[index].name || list[index].short || '助手')
    const overhead = label.length + 4
    const room = maxChars - used - overhead
    if (room < 20) break
    const raw = String(list[index].text || '').trim()
    const body = raw.length > room ? `${raw.slice(0, Math.max(0, room - 1))}…` : raw
    picked.unshift({ label, body })
    used += body.length + overhead
  }

  return {
    channel,
    thread,
    count: picked.length,
    chars: used,
    text: picked.map((msg) => `【${msg.label}】\n${msg.body}`).join('\n\n')
  }
}

function replaceInput (text) {
  const input = $('#input')
  if (!input) return false
  input.focus()
  if (input.disabled) { toast('当前视图只读，无法应用', 'err'); return false }
  input.select()
  document.execCommand('insertText', false, text)
  input.dispatchEvent(new Event('input'))
  return true
}

function resolveModel () {
  const target = agentById(state.activeAgentId) || commander()
  const override = state.settings.chatModel
  return {
    agent: target,
    providerId: override ? override.providerId : target && target.providerId,
    model: override ? override.model : target && target.model
  }
}

export function mountEnhance (btn) {
  if (!btn) return
  btn.addEventListener('click', () => { openEnhance() })
}

export function openEnhance () {
  const input = $('#input')
  const source = (input && input.value ? input.value : '').trim()
  if (!source) {
    toast('先写点内容再强化')
    if (input) input.focus()
    return
  }

  const { providerId, model } = resolveModel()
  if (!providerId || !model) {
    toast('没有可用的模型，先到设置里配置', 'err')
    return
  }
  const context = buildEnhanceContext()
  const contextHint = context.count
    ? `参考最近 ${context.count} 条对话 · 约 ${context.chars} 字`
    : '未找到可用历史，只按原文强化'

  const status = h('div', { class: 'enhance-status loading' }, h('i', { class: 'spin' }), h('span', { text: '优化中…' }))
  const slot = h('div', {})
  const { close } = openModal({
    title: '提示词强化',
    sub: 'PROMPT ENHANCE · 预览后再应用',
    width: 700,
    render: (body) => { body.append(status, slot) }
  })

  const setState = (kind, text) => {
    status.className = `enhance-status ${kind}`
    status.textContent = ''
    if (kind === 'loading') status.append(h('i', { class: 'spin' }))
    status.append(h('span', { text }))
  }

  const paintResult = (result) => {
    const orig = h('textarea', { class: 'textarea', readonly: true })
    orig.value = source
    const area = h('textarea', { class: 'textarea enhance-out' })
    area.value = result
    slot.textContent = ''
    slot.append(
      h('div', { class: 'enhance-grid' },
        h('div', { class: 'field' },
          h('label', { class: 'label', text: '原文' }),
          orig
        ),
        h('div', { class: 'field' },
          h('label', { class: 'label', text: '强化后（可再编辑）' }),
          area
        )
      ),
      h('div', { class: 'hint', style: { marginTop: '7px' }, text: contextHint })
    )

    slot.append(h('div', { class: 'btn-row', style: { marginTop: '14px', flexWrap: 'wrap' } },
      h('button', { class: 'btn', onclick: () => {
        if (replaceInput(area.value.trim())) { toast('已应用到输入框 · Ctrl+Z 可撤销', 'ok'); close() }
      } }, '一键应用'),
      h('button', { class: 'btn ghost', onclick: () => {
        navigator.clipboard && navigator.clipboard.writeText(area.value.trim())
        toast('已复制', 'ok')
      } }, '复制'),
      h('button', { class: 'btn ghost', onclick: () => { run() } }, '重新生成'),
      h('button', { class: 'btn ghost', onclick: () => close() }, '取消')
    ))
  }

  const paintError = (message) => {
    slot.textContent = ''
    slot.append(
      h('div', { class: 'enhance-error', text: message }),
      h('div', { class: 'btn-row', style: { marginTop: '14px' } },
        h('button', { class: 'btn', onclick: () => run() }, '重试'),
        h('button', { class: 'btn ghost', onclick: () => close() }, '关闭')
      )
    )
  }

  const run = async () => {
    slot.textContent = ''
    setState('loading', contextHint)
    try {
      const userContent = context.count
        ? [
            '以下是当前会话最近几轮上下文，仅用于理解指代和已有约束；它不是要改写的原文。',
            context.text,
            '',
            '要强化的原文：',
            source
          ].join('\n')
        : source
      const text = await callModel(
        { providerId, model, temperature: 0.2 },
        [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userContent }
        ],
        { maxTokens: 900 }
      )
      const next = String(text || '').trim()
      if (!next) throw new Error('模型没有返回内容')
      setState('done', `已生成，确认后应用 · ${contextHint}`)
      paintResult(next)
    } catch (err) {
      setState('error', '强化失败')
      paintError(err.message || '未知错误')
    }
  }

  run()
}
