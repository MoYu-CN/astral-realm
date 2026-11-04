/* layout.js — 分栏拖拽与尺寸持久化 */

import { state, persist } from './core.js'

const LIMITS = {
  rail: { min: 220, max: 480, def: 288, cssVar: '--rail-w', key: 'railWidth' },
  dock: { min: 260, max: 640, def: 340, cssVar: '--dock-w', key: 'dockWidth' }
}

const CENTER_MIN = 420
let drag = null

function cssWidth (name) {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0
}

function setWidth (side, px, save = false) {
  const cfg = LIMITS[side]
  if (!cfg) return
  const value = Math.round(px)
  document.documentElement.style.setProperty(cfg.cssVar, `${value}px`)
  if (save) {
    const layout = state.settings.layout || (state.settings.layout = {})
    layout[cfg.key] = value
    persist.settings()
  }
}

function clamp (side, px) {
  const cfg = LIMITS[side]
  const dockCollapsed = document.body.classList.contains('dock-collapsed')

  const other = side === 'rail'
    ? (dockCollapsed ? 0 : cssWidth('--dock-w'))
    : cssWidth('--rail-w')

  const gutters = cssWidth('--split-w') * (dockCollapsed ? 1 : 2)
  const room = window.innerWidth - other - gutters - CENTER_MIN
  const max = Math.max(cfg.min, Math.min(cfg.max, room))

  return Math.min(Math.max(px, cfg.min), max)
}

const current = (side) => cssWidth(LIMITS[side].cssVar)

function onPointerDown (event) {
  const side = event.currentTarget.dataset.target
  if (!LIMITS[side] || event.button !== 0) return
  if (side === 'dock' && document.body.classList.contains('dock-collapsed')) return

  event.preventDefault()
  try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* 合成事件可能没有真实指针 */ }
  drag = { side, startX: event.clientX, startW: current(side), el: event.currentTarget }

  document.body.classList.add('resizing')
  event.currentTarget.classList.add('active')
}

function onPointerMove (event) {
  if (!drag) return
  const dx = event.clientX - drag.startX
  const raw = drag.side === 'rail' ? drag.startW + dx : drag.startW - dx
  setWidth(drag.side, clamp(drag.side, raw))
}

function onPointerUp (event) {
  if (!drag) return
  const { side, el } = drag
  try { el.releasePointerCapture(event.pointerId) } catch { /* ignore */ }
  el.classList.remove('active')
  document.body.classList.remove('resizing')
  setWidth(side, clamp(side, current(side)), true)
  drag = null
}

function reset (side) {
  const cfg = LIMITS[side]
  if (!cfg) return
  const layout = state.settings.layout || (state.settings.layout = {})
  delete layout[cfg.key]
  setWidth(side, autoWidth(side))
  persist.settings()
}

function autoWidth (side) {
  const cfg = LIMITS[side]
  const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1
  return clamp(side, cfg.def * scale)
}

export function applyUiScale () {
  const manual = Number(state.settings.uiScale)
  const scale = manual > 0
    ? manual
    : Math.min(1, Math.max(0.86, 0.7 + window.innerWidth / 6400))
  document.documentElement.style.setProperty('--ui-scale', scale.toFixed(3))
  return scale
}

export function mountLayout () {
  const layout = state.settings.layout || (state.settings.layout = {})
  applyUiScale()
  setWidth('rail', layout.railWidth ? clamp('rail', layout.railWidth) : autoWidth('rail'))
  setWidth('dock', layout.dockWidth ? clamp('dock', layout.dockWidth) : autoWidth('dock'))

  for (const el of document.querySelectorAll('.resizer')) {
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('dblclick', () => reset(el.dataset.target))
  }

  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerUp)

  let raf = null
  window.addEventListener('resize', () => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = null
      applyUiScale()
      setWidth('rail', layout.railWidth ? clamp('rail', layout.railWidth) : autoWidth('rail'))
      setWidth('dock', layout.dockWidth ? clamp('dock', layout.dockWidth) : autoWidth('dock'))
    })
  })
}

export function resetLayout () {
  reset('rail')
  reset('dock')
}
