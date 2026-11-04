/* viewswitch.js — 两条会话线之间的切换（用户↔AI / AI↔AI）
   切换只影响「看哪一条线」，不影响任何正在跑的编排任务。 */

import { state, bus, $, h, persist } from './core.js'
import { playViewTransition } from './wintransition.js'

export const VIEWS = [
  { id: 'user', label: '用户 ↔ AI', desc: '你与成员之间的对话' },
  { id: 'agent', label: 'AI ↔ AI', desc: '成员之间的派单与交付，只读' }
]

/* 各视图各自的滚动位置，切走再切回来停在原处 */
const scrollMemo = new Map()
let mounted = false

export function currentView () {
  return state.view === 'agent' ? 'agent' : 'user'
}

export function isReadonlyView () {
  return currentView() === 'agent'
}

function rememberScroll () {
  const el = $('#stream')
  if (el) scrollMemo.set(currentView(), el.scrollTop)
}

function restoreScroll (fallbackBottom = true) {
  const el = $('#stream')
  if (!el) return
  const saved = scrollMemo.get(currentView())
  if (typeof saved === 'number') el.scrollTop = saved
  else if (fallbackBottom) el.scrollTop = el.scrollHeight
}

function paintTabs () {
  const root = $('#view-switch')
  if (!root) return
  const view = currentView()
  for (const tab of root.querySelectorAll('.view-tab')) {
    const on = tab.dataset.view === view
    tab.classList.toggle('active', on)
    tab.setAttribute('aria-selected', on ? 'true' : 'false')
  }
  const indicator = root.querySelector('.view-indicator')
  const active = root.querySelector('.view-tab.active')
  if (indicator && active) {
    indicator.style.width = `${active.offsetWidth}px`
    indicator.style.transform = `translateX(${active.offsetLeft}px)`
  }
}

export function setView (view, opts = {}) {
  const next = view === 'agent' ? 'agent' : 'user'
  if (next === currentView() && !opts.force) return

  rememberScroll()
  state.view = next
  if (state.settings) {
    state.settings.view = next
    persist.settings()
  }

  const stream = $('#stream')
  paintTabs()
  bus.emit('view:changed', next)

  /* 切回来时先恢复位置，再播转场，避免动画期间跳动 */
  if (stream) {
    restoreScroll()
    playViewTransition(stream, opts.transition)
  }
}

export function mountViewSwitch () {
  const root = $('#view-switch')
  if (!root || mounted) return
  mounted = true

  const saved = (state.settings && state.settings.view) || 'user'
  state.view = saved === 'agent' ? 'agent' : 'user'

  for (const tab of root.querySelectorAll('.view-tab')) {
    tab.addEventListener('click', () => setView(tab.dataset.view))
  }

  paintTabs()
  window.addEventListener('resize', paintTabs, { passive: true })

  /* 键盘：Alt+1 / Alt+2 */
  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return
    if (e.key === '1') { e.preventDefault(); setView('user') }
    if (e.key === '2') { e.preventDefault(); setView('agent') }
  })

  bus.on('session:clear', () => {
    scrollMemo.clear()
  })

  bus.on('project:changed', () => {
    /* 两个项目的滚动位置不能互相复用 */
    scrollMemo.clear()
  })
}

/* 给「AI ↔ AI」空态用的一段说明，避免空数组时渲染出白屏 */
export function agentEmptyNode () {
  return h('div', { class: 'stream-empty' },
    h('div', { class: 'glyph' }, '⇄'),
    h('h2', {}, '还没有协作记录'),
    h('p', { text: '当成员之间派单、交付结果时，往来内容会按时间顺序出现在这里。' }),
    h('p', { class: 'empty-hint', text: '这一区对你只读：你不能直接发言，成员也看不到你在另一条线里说过什么——两条会话的上下文严格分开。' })
  )
}
