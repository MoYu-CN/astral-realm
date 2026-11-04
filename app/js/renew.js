/* renew.js — 会话革新（总结 → 新会话 → 上下文重置）
 *
 * 只作用于「当前智能体的这条 user 线程」：
 *   1. 用当前模型把这条线程压缩成一份交接摘要；
 *   2. 归档原消息（最多两份，只用于回看，不参与任何上下文组装）；
 *   3. 清空这条线程，只留一条 handoff 卡片作为新会话的起点。
 *
 * 其他成员的线程、AI↔AI 协作日志、编制、技能、项目设置都不动。
 */

import {
  state, bus, h, uid, toast, agentById, commander, activeProject,
  channelOf, messagesOf, estimateTextTokens, saveProjectSessionNow, persist
} from './core.js'
import { callModel } from './llm.js'
import { openModal, closeModal } from './modal.js'
import { confirmAction } from './confirm.js'

const SUMMARY_SYSTEM = [
  '你是严谨的会话交接编辑。把用户与 AI 的会话压缩成一份交接摘要，',
  '供同一个 AI 在没有任何历史消息的新会话里继续工作。',
  '',
  '输出要求：',
  '- 使用 Markdown，固定分节：## 会话目标 / ## 已完成 / ## 关键结论与决策 / ## 待办与下一步 / ## 重要约束与偏好',
  '- 只保留对后续工作有用的事实：目标、结论、决定、文件路径、参数、未完成事项、用户偏好。',
  '- 不要寒暄，不要复述过程，不要编造会话里没有出现的信息。',
  '- 总长度 600–1200 字；没有内容的小节写「无」。',
  '- 最后单独一行写「交接完成度：…」，说明哪些信息可能缺失。'
].join('\n')

const SUMMARY_CHAR_BUDGET = 28000
const SUMMARY_ITEM_LIMIT = 3000

function enabledAgents () {
  const roster = (state.roster && state.roster.agents) || []
  return roster.filter((agent) => agent && agent.enabled !== false)
}

/* 当前会话属于谁：显式选中的成员优先，其次项目的标准会话成员，最后总指挥/第一位成员 */
export function currentRenewAgent () {
  const project = activeProject()
  const selected = state.activeAgentId ? agentById(state.activeAgentId) : null
  if (selected) return selected
  if (project && project.soloAgentId) {
    const solo = agentById(project.soloAgentId)
    if (solo) return solo
  }
  return commander() || enabledAgents()[0] || null
}

function threadOf (agent) {
  return (agent && agent.id) || 'commander'
}

function sessionMessages (agent) {
  const thread = threadOf(agent)
  return state.messages
    .filter((msg) => channelOf(msg) === 'user' && (msg.thread || 'commander') === thread)
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
}

function sessionStats (messages) {
  let tokens = 0
  let mine = 0
  let ai = 0
  for (const msg of messages) {
    if (msg.kind === 'user') mine += 1
    if (msg.kind === 'agent') ai += 1
    tokens += estimateTextTokens(msg.text || '')
    for (const file of msg.files || []) {
      tokens += Number(file.tokens) || estimateTextTokens(file.text || '')
    }
  }
  return { count: messages.length, mine, ai, tokens: Math.round(tokens) }
}

function formatTokens (value) {
  const n = Number(value) || 0
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`
  return String(Math.round(n))
}

function roleLabel (msg) {
  if (msg.kind === 'handoff') return '上一段会话交接摘要'
  if (msg.kind === 'user') return '用户'
  if (msg.kind === 'plan') return msg.name || '派单'
  if (msg.kind === 'system') return '系统'
  return msg.name || 'AI'
}

/* 从最近的消息往前装，保证新内容优先；超出预算就停，避免总结请求本身爆上下文 */
function transcriptForSummary (messages) {
  const picked = []
  let used = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.kind === 'system' || msg.kind === 'tool') continue
    const text = String(msg.text || '').trim()
    if (!text) continue
    const body = text.length > SUMMARY_ITEM_LIMIT
      ? `${text.slice(0, SUMMARY_ITEM_LIMIT)}…（后略）`
      : text
    if (used + body.length > SUMMARY_CHAR_BUDGET && picked.length) break
    picked.push(`### ${roleLabel(msg)}\n${body}`)
    used += body.length
  }
  return picked.reverse().join('\n\n')
}

function compactSummary (text) {
  return String(text || '')
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
}

async function generateSummary (agent, messages, onDelta) {
  const transcript = transcriptForSummary(messages)
  if (!transcript) throw new Error('这条会话没有可总结的正文')
  let received = ''
  const text = await callModel(
    { ...agent, temperature: 0.2 },
    [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `以下是需要交接的会话原文：\n\n${transcript}` }
    ],
    {
      maxTokens: 1800,
      channel: 'user',
      onDelta: (delta) => {
        received += delta
        if (onDelta) onDelta(received)
      }
    }
  )
  const clean = compactSummary(text || received)
  if (!clean) throw new Error('模型没有返回摘要内容')
  return clean
}

function archiveSession (agent, messages, summaryTokens) {
  const stats = sessionStats(messages)
  const archive = {
    id: uid('archive'),
    ts: Date.now(),
    thread: threadOf(agent),
    agentId: agent.id,
    agentName: agent.name,
    model: agent.model || '',
    count: stats.count,
    tokens: stats.tokens,
    reason: 'renew',
    messages: messages.map((msg) => ({ ...msg }))
  }
  state.archives = [archive, ...(state.archives || [])].slice(0, 2)
  return { archive, stats, summaryTokens }
}

/* 真正落地：先归档，再清空这条线程，最后放一张 handoff 卡片 */
async function applyRenew (agent, messages, summary) {
  const clean = compactSummary(summary)
  if (!clean) throw new Error('摘要为空，无法开始新会话')

  const { archive, stats } = archiveSession(agent, messages, estimateTextTokens(clean))
  const thread = threadOf(agent)

  state.messages = state.messages.filter((msg) => !(
    channelOf(msg) === 'user' && (msg.thread || 'commander') === thread
  ))

  const handoff = {
    id: uid('msg'),
    ts: Date.now(),
    thread,
    channel: 'user',
    kind: 'handoff',
    text: clean,
    agentId: agent.id,
    name: agent.name,
    short: agent.short || '',
    title: agent.title || '',
    glyph: agent.glyph || '◇',
    color: agent.color || 'var(--accent)',
    meta: {
      archiveId: archive.id,
      count: stats.count,
      tokens: stats.tokens,
      summaryTokens: estimateTextTokens(clean),
      model: agent.model || '',
      providerId: agent.providerId || '',
      at: Date.now()
    }
  }
  state.messages.push(handoff)

  /* 上下文与运行态一起归零：下一轮只带 handoff 与摘要之后的对话 */
  state.tasks = []
  state.pendingFiles = []
  state.usage = null
  state.currentRunId = ''
  state.currentRunCapability = ''
  persist.session()
  await saveProjectSessionNow()
  bus.emit('session:clear')
  bus.emit('session:renewed', handoff)
  bus.emit('usage:changed', null)
  bus.emit('attachments:changed')
  bus.emit('status', '新会话已开始 · 上下文已重置')
  return handoff
}

/* ------------------------------------------------------------ 弹窗 */

export function openRenewDialog () {
  if (state.busy) {
    toast('协作进行中，等这一轮结束后再革新', 'err')
    return
  }
  if (state.view === 'agent') {
    toast('请切回「用户 ↔ AI」再革新', 'err')
    return
  }
  const agent = currentRenewAgent()
  if (!agent) {
    toast('当前项目没有可用的智能体', 'err')
    return
  }
  const messages = sessionMessages(agent)
  const stats = sessionStats(messages)
  if (!messages.some((msg) => msg.kind === 'user' || msg.kind === 'agent')) {
    toast('这条会话还没有可总结的内容', 'err')
    return
  }

  const draft = {
    step: 'intro',
    summary: '',
    generating: false,
    progress: '',
    chars: 0,
    error: '',
    closed: false,
    progressEl: null
  }
  let paint = () => {}

  const runSummary = async () => {
    if (draft.generating) return
    draft.generating = true
    draft.error = ''
    draft.summary = ''
    draft.progress = '正在读取会话…'
    draft.chars = 0
    paint()
    try {
      const text = await generateSummary(agent, messages, (received) => {
        draft.chars = received.length
        draft.progress = `正在总结… 已接收 ${received.length} 字`
        /* 流式期间只改进度文字，不整块重绘：否则按钮和焦点会反复重建 */
        if (draft.closed) return
        if (draft.progressEl && draft.progressEl.isConnected) {
          draft.progressEl.textContent = draft.progress
        } else {
          paint()
        }
      })
      draft.summary = text
      draft.step = 'preview'
    } catch (err) {
      draft.error = err.message || '总结失败'
      draft.step = 'intro'
    } finally {
      draft.generating = false
      if (!draft.closed) paint()
    }
  }

  const startBlank = async () => {
    if (draft.generating) return
    const ok = await confirmAction({
      title: '不生成摘要直接归档？',
      message: '这条会话会直接归档并从零开始，新会话没有任何历史信息。',
      confirmText: '归档并重置',
      danger: true
    })
    if (!ok) return
    try {
      await applyRenew(agent, messages, `（上一段会话未生成摘要，已归档 ${stats.count} 条消息。）`)
      draft.closed = true
      closeModal()
      toast('已归档上一段会话，上下文已重置', 'ok')
    } catch (err) {
      draft.error = err.message || '归档失败'
      paint()
    }
  }

  const confirmRenew = async () => {
    if (draft.generating) return
    if (!draft.summary.trim()) {
      toast('摘要不能为空', 'err')
      return
    }
    try {
      await applyRenew(agent, messages, draft.summary)
      draft.closed = true
      closeModal()
      toast('革新完成：新会话从干净上下文开始', 'ok')
    } catch (err) {
      draft.error = err.message || '革新失败'
      paint()
    }
  }

  const resetPanel = (body) => {
    body.textContent = ''
    draft.progressEl = null
    body.append(
      h('div', { class: 'renew-head' },
        h('div', {},
          h('div', { class: 'renew-title', text: `与 ${agent.name} 的会话` }),
          h('div', { class: 'renew-meta', text: `${stats.count} 条消息（你 ${stats.mine} / AI ${stats.ai}）· 约 ${formatTokens(stats.tokens)} tokens · ${agent.model || '未绑定模型'}` })
        ),
        h('span', { class: 'renew-badge', text: '革新' })
      ),
      h('div', { class: 'renew-steps' },
        h('div', { class: 'renew-step' }, h('b', { text: '1' }), h('span', { text: '当前智能体把这段会话压缩成一份交接摘要（额外 1 次模型请求）' })),
        h('div', { class: 'renew-step' }, h('b', { text: '2' }), h('span', { text: '清空这条会话的消息与上下文，只保留摘要作为新会话的起点' })),
        h('div', { class: 'renew-step' }, h('b', { text: '3' }), h('span', { text: '旧会话归档，可从交接卡片回看；编制、技能、项目设置不变' }))
      ),
      h('div', { class: 'renew-bounds' },
        h('div', { class: 'renew-bounds-title', text: '边界' }),
        h('div', { class: 'hint', text: '· 只影响你与这个智能体的这条会话；其他成员的线程、AI↔AI 协作日志不受影响。' }),
        h('div', { class: 'hint', text: '· 摘要由模型生成，可能遗漏细节；确认前可以手动修改。' }),
        h('div', { class: 'hint', text: '· 附件正文不会进入新会话，只保留在归档里。' })
      )
    )

    /* 原生 append 会把 null 转成字符串 "null"，条件节点必须单独追加 */
    if (draft.error) body.append(h('div', { class: 'newconvo-error', text: draft.error }))

    if (draft.generating) {
      const progressText = h('span', { text: draft.progress || '正在总结…' })
      draft.progressEl = progressText
      body.append(
        h('div', { class: 'renew-progress' },
          h('i', { class: 'renew-spin', 'aria-hidden': 'true' }),
          progressText
        ),
        h('div', { class: 'hint', text: '总结期间可以继续看原文；关闭弹窗不会丢失当前会话。' })
      )
    }

    body.append(h('div', { class: 'renew-actions' },
      h('button', { class: 'btn ghost', onclick: () => { draft.closed = true; closeModal() } }, '取消'),
      h('button', { class: 'btn ghost', onclick: startBlank, disabled: draft.generating }, '直接清空（不总结）'),
      h('button', { class: 'btn-primary', onclick: runSummary, disabled: draft.generating }, draft.generating ? '正在总结…' : '开始总结')
    ))
  }

  const previewPanel = (body) => {
    body.textContent = ''
    draft.progressEl = null
    const area = h('textarea', {
      class: 'input renew-summary',
      spellcheck: 'false',
      oninput: (e) => { draft.summary = e.target.value }
    })
    area.value = draft.summary
    body.append(
      h('div', { class: 'renew-head' },
        h('div', {},
          h('div', { class: 'renew-title', text: '交接摘要' }),
          h('div', { class: 'renew-meta', text: `将作为新会话的唯一历史 · 约 ${formatTokens(estimateTextTokens(draft.summary))} tokens · 可编辑` })
        ),
        h('span', { class: 'renew-badge ok', text: '待确认' })
      ),
      area
    )
    if (draft.error) body.append(h('div', { class: 'newconvo-error', text: draft.error }))
    body.append(
      h('div', { class: 'renew-bounds' },
        h('div', { class: 'renew-bounds-title', text: '确认后' }),
        h('div', { class: 'hint', text: `原 ${stats.count} 条消息会归档；这条会话只剩上面这份摘要，统计与上下文用量从 0 重新计算。` })
      ),
      h('div', { class: 'renew-actions' },
        h('button', { class: 'btn ghost', onclick: () => { draft.step = 'intro'; paint() } }, '返回'),
        h('button', { class: 'btn ghost', onclick: runSummary, disabled: draft.generating }, '重新总结'),
        h('button', { class: 'btn-primary', onclick: confirmRenew, disabled: draft.generating }, '确认并开始新会话')
      )
    )
    area.style.height = 'min(46vh, 420px)'
    area.focus({ preventScroll: true })
  }

  openModal({
    title: '革新当前会话',
    sub: 'RENEW · 总结这段会话，开启干净上下文的新会话',
    width: 760,
    onClose: () => { draft.closed = true },
    render: (body) => {
      paint = () => {
        if (draft.closed) return
        if (draft.step === 'preview') previewPanel(body)
        else resetPanel(body)
      }
      paint()
    }
  })
}

/* ------------------------------------------------------------ 归档回看 */

export function openArchive (archiveId) {
  const archive = (state.archives || []).find((item) => item.id === archiveId)
  if (!archive) {
    toast('找不到这段会话的归档', 'err')
    return
  }
  const messages = (archive.messages || []).slice()
  const body = h('div', { class: 'archive-body' })
  let shown = 0
  for (const msg of messages) {
    if (msg.kind === 'system' || msg.kind === 'tool') continue
    shown += 1
    const mine = msg.kind === 'user'
    body.append(h('div', { class: 'archive-item' + (mine ? ' mine' : '') },
      h('div', { class: 'archive-who', text: mine ? '你' : (msg.name || archive.agentName || 'AI') }),
      h('div', { class: 'archive-text', text: msg.text || '（无正文）' })
    ))
  }
  if (!shown) body.append(h('div', { class: 'hint', text: '这段归档没有可显示的正文。' }))

  let text = ''
  openModal({
    title: `上一段会话 · ${archive.agentName || '归档'}`,
    sub: `ARCHIVE · ${archive.count || messages.length} 条消息 · 约 ${formatTokens(archive.tokens)} tokens · 只读`,
    width: 760,
    render: (host) => {
      host.append(
        h('div', { class: 'hint', text: '归档只用于回看，不会进入当前上下文，也不会被模型读取。' }),
        h('div', { class: 'archive-scroll' }, body),
        h('div', { class: 'renew-actions' },
          h('button', { class: 'btn ghost', onclick: () => {
            text = messages.map((m) => `【${roleLabel(m)}】\n${m.text || ''}`).join('\n\n')
            navigator.clipboard.writeText(text).then(
              () => toast('归档内容已复制', 'ok'),
              () => toast('复制失败', 'err')
            )
          } }, '复制全部'),
          h('button', { class: 'btn-primary', onclick: () => closeModal() }, '关闭')
        )
      )
    }
  })
}
