/* wintransition.js — 切换窗口时的入场动效 */

import { state } from './core.js'

export const TRANSITIONS = [
  { id: 'slide', label: '左滑', desc: '像手机主屏一样从右侧横向推入' },
  { id: 'rise', label: '上滑', desc: '像安卓应用一样自下而上推入' },
  { id: 'carousel', label: '轮盘', desc: '先转出去再从另一侧转回，像换了一格' },
  { id: 'rotate', label: '轮转', desc: '整块像卡片一样绕 Y 轴转进来' },
  { id: 'zoom', label: '缩放', desc: '从略小放大到位' },
  { id: 'fade', label: '淡入', desc: '整体从暗处淡入，最克制' },
  { id: 'none', label: '关闭', desc: '不做动画' }
]

const CLASSES = TRANSITIONS.map((t) => `win-${t.id}`)
let shell = null
let timer = null

function current () {
  const id = (state.settings.appearance || {}).winTransition || 'fade'
  return TRANSITIONS.some((t) => t.id === id) ? id : 'fade'
}

export function playWindowEnter (type = current()) {
  if (type === 'none') return
  if (document.body.classList.contains('reduced-motion')) return

  if (!shell || !shell.isConnected) shell = document.querySelector('.shell')
  if (!shell) return

  shell.classList.remove('win-enter', ...CLASSES)
  void shell.offsetWidth // 强制重排，让同一个动画能连续重播
  shell.classList.add('win-enter', `win-${type}`)

  clearTimeout(timer)
  timer = setTimeout(() => {
    shell.classList.remove('win-enter', `win-${type}`)
  }, 1000)
}

/* 通用：给任意元素播一次转场（会话切换、面板换页都用它） */
export function playViewTransition (el, type = current()) {
  if (!el || type === 'none') return
  if (document.body.classList.contains('reduced-motion')) return

  el.classList.remove('vt-enter', ...CLASSES.map((c) => `vt-${c.slice(4)}`))
  void el.offsetWidth
  el.classList.add('vt-enter', `vt-${type}`)
  clearTimeout(el.__vtTimer)
  el.__vtTimer = setTimeout(() => {
    el.classList.remove('vt-enter', `vt-${type}`)
  }, 1000)
}

export function mountWindowTransition () {
  /* 只在应用真正“首次进入”时播一次入场动效。
     不监听 window focus：从其他窗口切回本应用、最小化恢复、点任务栏回来
     都会触发 focus，但那是恢复焦点，不是一次新的窗口切换。
     用户主动切换视图/会话仍走 playViewTransition。 */
  requestAnimationFrame(() => playWindowEnter())
}
