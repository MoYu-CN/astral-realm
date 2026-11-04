/* contextmeter.js — 会话上下文用量环与上下文规格选择 */

import {
  state, $, bus, h, commander, agentById, providerById,
  estimateTextTokens, normalizeContextSpec, saveProjectSessionNow, channelOf
} from './core.js'
import { buildSystemPrompt } from './llm.js'
import { togglePopover, openPopover, closePopover, popoverSection, popoverItem } from './popover.js'

const FALLBACK_WINDOW = 128000
const RADIUS = 12.7
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

function numericWindow (value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

function activeModel () {
  const override = state.settings.chatModel
  if (override && override.model) {
    return { providerId: override.providerId || '', model: override.model }
  }
  const agent = state.activeAgentId ? agentById(state.activeAgentId) : commander()
  if (!agent) return { providerId: '', model: '' }
  return { providerId: agent.providerId || '', model: agent.model || '' }
}

function modelMetaWindow (provider, model) {
  if (!provider) return 0
  const direct = numericWindow(provider.contextWindow) ||
    numericWindow(provider.context_window) ||
    numericWindow(provider.contextLength)
  if (direct) return direct

  const table = provider.modelContext || provider.modelsMeta || provider.model_info || null
  if (table && typeof table === 'object') {
    const entry = table[model]
    const fromTable = typeof entry === 'number'
      ? numericWindow(entry)
      : numericWindow(entry && (entry.contextWindow || entry.context_length || entry.contextLength))
    if (fromTable) return fromTable
  }

  const list = Array.isArray(provider.models) ? provider.models : []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const id = item.id || item.name
    if (id !== model) continue
    const fromItem = numericWindow(item.contextWindow || item.context_length || item.contextLength)
    if (fromItem) return fromItem
  }
  return 0
}

export function defaultContextTokens () {
  const { providerId, model } = activeModel()
  const provider = providerById(providerId)
  return modelMetaWindow(provider, model) || FALLBACK_WINDOW
}

export function contextTotalTokens () {
  const spec = normalizeContextSpec(state.contextSpec)
  if (spec === '300k') return 300000
  if (spec === '1m') return 1000000
  return defaultContextTokens()
}

/* 当前看到的是哪一条会话：用户↔AI 看的是当前成员那条线程，
   AI↔AI 看的是整个协作区通道。两者各自独立计数。 */
function contextScope () {
  const agent = state.activeAgentId ? agentById(state.activeAgentId) : commander()
  const channel = state.view === 'agent' ? 'agent' : 'user'
  const thread = (agent && agent.id) || 'commander'
  return { agent, channel, thread }
}

let sysCache = { key: '', tokens: 0 }

/* 该成员这一轮实际会带上的系统提示词（编制、技能、权限、数据清单…） */
function systemPromptTokens (agent, channel) {
  if (!agent) return 0
  const perms = state.settings.permissions || {}
  const key = [
    agent.id, channel, agent.name, agent.title, agent.duty, agent.prompt, agent.soloPrompt,
    (state.roster.agents || []).length,
    (state.roster.globalNotes || '').length,
    Object.keys(perms).filter((k) => perms[k]).join(','),
    state.activeProjectId || ''
  ].join('|')
  if (sysCache.key === key) return sysCache.tokens
  let text = ''
  try { text = buildSystemPrompt(agent, { channel }) } catch { text = '' }
  sysCache = { key, tokens: estimateTextTokens(text) }
  return sysCache.tokens
}

export function usedContextTokens () {
  const { agent, channel, thread } = contextScope()
  let used = 0
  for (const msg of state.messages || []) {
    /* 关键：只统计当前这条会话。以前不分线程，所以切到谁都显示同一个数 */
    if (channelOf(msg) !== channel) continue
    if (channel === 'user' && (msg.thread || 'commander') !== thread) continue
    used += estimateTextTokens(msg.text || '')
    if (msg.kind === 'plan') {
      used += estimateTextTokens(msg.brief || '')
      for (const task of msg.tasks || []) {
        used += estimateTextTokens(task.text || '')
        used += estimateTextTokens(task.result || '')
        used += 12
      }
    }
    for (const file of msg.files || []) {
      if (Number.isFinite(Number(file.tokens)) && Number(file.tokens) > 0) used += Number(file.tokens)
      else if (typeof file.text === 'string' && file.text) used += estimateTextTokens(file.text)
    }
    used += 6
  }
  used += systemPromptTokens(agent, channel)
  return Math.max(0, Math.round(used))
}

export function formatTokenCount (value) {
  const n = Number(value) || 0
  if (n >= 1000000) return `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}K`
  return String(Math.round(n))
}

function specLabel (spec) {
  const normalized = normalizeContextSpec(spec)
  if (normalized === '300k') return '300K'
  if (normalized === '1m') return '1M'
  return '模型默认'
}

function safePercent (used, total) {
  if (!total) return 0
  return Math.max(0, (used / total) * 100)
}

function buildPanel (paint) {
  const used = usedContextTokens()
  const total = contextTotalTokens()
  const percent = safePercent(used, total)
  const panel = h('div', { class: 'ctx-panel' },
    popoverSection('上下文用量'),
    h('div', { class: 'ctx-panel-meta' },
      h('span', { text: `${formatTokenCount(used)} / ${formatTokenCount(total)}` }),
      h('b', { text: `${percent.toFixed(percent >= 10 ? 0 : 1)}%` })
    ),
    h('div', { class: 'ctx-panel-hint', text: '只统计当前这条会话（这个成员的这条线）与它自己的系统提示词；切换成员或视图会看到各自的用量。' }),
    popoverSection('上下文规格'),
    popoverItem({
      label: '模型默认上下文',
      desc: `${formatTokenCount(defaultContextTokens())} · 当前模型${modelMetaWindow(providerById(activeModel().providerId), activeModel().model) ? '已声明' : '未声明，按 128K 估算'}`,
      active: normalizeContextSpec(state.contextSpec) === 'auto',
      onClick: () => { setSpec('auto', paint) }
    }),
    popoverItem({
      label: '300K',
      desc: '300,000 tokens',
      active: normalizeContextSpec(state.contextSpec) === '300k',
      onClick: () => { setSpec('300k', paint) }
    }),
    popoverItem({
      label: '1M',
      desc: '1,000,000 tokens',
      active: normalizeContextSpec(state.contextSpec) === '1m',
      onClick: () => { setSpec('1m', paint) }
    })
  )
  return panel
}

async function setSpec (spec, paint) {
  state.contextSpec = normalizeContextSpec(spec)
  paint()
  try { await saveProjectSessionNow() } catch { /* 会话保存失败时仍保留本次内存选择 */ }
  closePopover()
}

export function mountContextMeter () {
  const meter = $('#ctx-meter')
  const fill = $('#ctx-fill')
  const valueEl = $('#ctx-meter-value')
  if (!meter || !fill) return

  fill.style.strokeDasharray = `${CIRCUMFERENCE} ${CIRCUMFERENCE}`
  let raf = 0

  const paint = () => {
    raf = 0
    const used = usedContextTokens()
    const total = contextTotalTokens()
    const percent = safePercent(used, total)
    const clamped = Math.min(100, percent)
    fill.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - clamped / 100))
    if (valueEl) valueEl.textContent = `${Math.round(percent)}%`
    meter.classList.toggle('warn', percent >= 70 && percent < 85)
    meter.classList.toggle('danger', percent >= 85)
    meter.title = `上下文 ${formatTokenCount(used)} / ${formatTokenCount(total)} · ${percent.toFixed(percent >= 10 ? 0 : 1)}%`
    meter.setAttribute('aria-label', `上下文用量 ${Math.round(percent)}%，点击选择上下文规格`)
  }

  const schedule = () => {
    if (raf) return
    raf = requestAnimationFrame(paint)
  }

  meter.addEventListener('click', () => {
    togglePopover({
      anchor: meter,
      width: 292,
      align: 'right',
      id: 'ctx-spec',
      content: buildPanel(paint)
    })
  })

  bus.on('message:add', schedule)
  bus.on('message:delta', schedule)
  bus.on('message:update', schedule)
  bus.on('message:done', schedule)
  bus.on('message:remove', schedule)
  bus.on('task:update', schedule)
  bus.on('messages:reload', schedule)
  bus.on('session:clear', schedule)
  bus.on('project:changed', schedule)
  bus.on('roster:changed', schedule)
  bus.on('active:agent', schedule)
  /* 切到 AI↔AI 或切回来时，两条通道的用量不同，必须重算 */
  bus.on('view:changed', schedule)
  bus.on('model:changed', schedule)
  bus.on('context:spec', schedule)

  paint()
}

export { specLabel }
