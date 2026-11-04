/* search.js — 当前项目会话搜索 */

import { state, bus, h, channelOf } from './core.js'
import { openModal, closeModal } from './modal.js'
import { setView, currentView } from './viewswitch.js'

const MAX_RESULTS = 80

function messageText (msg) {
  if (!msg) return ''
  if (typeof msg.text === 'string' && msg.text.trim()) return msg.text
  if (msg.kind === 'plan' && Array.isArray(msg.tasks)) {
    return [msg.brief || '', ...msg.tasks.map((task) => `${task.to || ''} ${task.task || ''}`)].join('\n')
  }
  if (msg.kind === 'tool') return [msg.toolLabel || '', msg.detail || ''].join('\n')
  return ''
}

function who (msg) {
  if (msg.kind === 'user') return '你'
  if (msg.kind === 'tool') return '工具'
  return msg.name || '成员'
}

function time (ts) {
  if (!ts) return ''
  try { return new Date(ts).toLocaleString('zh-CN', { hour12: false }) } catch { return '' }
}

function snippet (text, query) {
  const source = String(text || '').replace(/\s+/g, ' ').trim()
  const index = source.toLowerCase().indexOf(query.toLowerCase())
  if (index < 0) return source.slice(0, 160)
  const start = Math.max(0, index - 45)
  const end = Math.min(source.length, index + query.length + 110)
  return `${start ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`
}

function jumpToMessage (msg) {
  const channel = channelOf(msg) === 'agent' ? 'agent' : 'user'
  if (channel === 'user') {
    state.activeAgentId = msg.thread && msg.thread !== 'commander' ? msg.thread : null
  }
  setView(channel, { force: true })
  if (channel === 'user') bus.emit('active:agent', state.activeAgentId)
  closeModal()
  requestAnimationFrame(() => {
    const node = Array.from(document.querySelectorAll('.msg')).find((el) => el.dataset.id === msg.id)
    if (!node) return
    node.scrollIntoView({ block: 'center', behavior: 'smooth' })
    node.classList.add('search-hit')
    setTimeout(() => node.classList.remove('search-hit'), 2200)
  })
}

export function mountSearch () {
  const button = document.getElementById('btn-search')
  button?.addEventListener('click', openSearch)
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      openSearch()
    }
  })
}

export function openSearch () {
  const input = h('input', {
    class: 'input search-input',
    type: 'search',
    placeholder: '搜索当前项目里的指令、回复、计划和工具记录…',
    autocomplete: 'off'
  })
  const list = h('div', { class: 'search-results' })
  const count = h('div', { class: 'search-count', text: '' })

  const matches = (query) => {
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    return state.messages
      .filter((msg) => {
        const text = messageText(msg)
        return text && text.toLowerCase().includes(needle)
      })
      .slice(-MAX_RESULTS)
      .reverse()
  }

  const paint = () => {
    const query = input.value.trim()
    list.textContent = ''
    const rows = matches(query)
    count.textContent = query ? `${rows.length} 条匹配` : ''
    if (!query) {
      list.append(h('div', { class: 'dock-empty', text: '输入关键词开始搜索；匹配范围为当前项目已加载的会话。' }))
      return
    }
    if (!rows.length) {
      list.append(h('div', { class: 'dock-empty', text: '没有匹配的消息。' }))
      return
    }
    for (const msg of rows) {
      const row = h('button', {
        class: 'search-result',
        type: 'button',
        onclick: () => jumpToMessage(msg)
      },
      h('div', { class: 'search-result-head' },
        h('span', { class: 'search-result-who', text: `${who(msg)} · ${channelOf(msg) === 'agent' ? 'AI ↔ AI' : '用户 ↔ AI'}` }),
        h('span', { class: 'search-result-time', text: time(msg.ts) })
      ),
      h('div', { class: 'search-result-text', text: snippet(messageText(msg), query) })
      )
      list.append(row)
    }
  }

  input.addEventListener('input', paint)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const rows = matches(input.value)
      if (rows[0]) jumpToMessage(rows[0])
    }
  })

  openModal({
    title: '搜索会话',
    sub: 'Ctrl+K · 当前项目 · 点击结果跳到原消息',
    width: 760,
    render: (body) => {
      body.append(input, count, list)
      paint()
      setTimeout(() => input.focus(), 30)
    }
  })
}
