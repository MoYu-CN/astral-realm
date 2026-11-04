/* popover.js — 带进出动画的锚定浮层 */

import { h } from './core.js'

let host = null
let openEl = null
let openAnchor = null
let cleanup = null

function ensureHost () {
  if (host && document.body.contains(host)) return host
  host = document.createElement('div')
  host.className = 'popover-root'
  host.id = 'popover-root'
  document.body.append(host)
  return host
}

export function closePopover () {
  if (!openEl) return
  const el = openEl
  openEl = null
  openAnchor = null
  if (cleanup) { cleanup(); cleanup = null }
  el.classList.remove('open')
  setTimeout(() => el.remove(), 170)
  document.querySelectorAll('.tool.active').forEach((b) => b.classList.remove('active'))
}

export function isPopoverOpen (anchor) {
  return Boolean(openAnchor && openAnchor === anchor)
}

export function togglePopover (options) {
  if (isPopoverOpen(options.anchor)) {
    closePopover()
    return null
  }
  return openPopover(options)
}

export function openPopover ({ anchor, content, width = 268, align = 'left', id = '' }) {
  closePopover()
  const root = ensureHost()

  const panel = h('div', { class: 'popover', dataset: { anchor: id } })
  panel.style.width = `${width}px`
  panel.append(content)
  root.append(panel)

  const rect = anchor.getBoundingClientRect()
  const margin = 10
  const panelRect = panel.getBoundingClientRect()

  let left = align === 'right' ? rect.right - panelRect.width : rect.left
  left = Math.min(Math.max(margin, left), window.innerWidth - panelRect.width - margin)

  let top = rect.top - panelRect.height - 10
  if (top < margin) top = Math.min(rect.bottom + 10, window.innerHeight - panelRect.height - margin)

  panel.style.left = `${Math.round(left)}px`
  panel.style.top = `${Math.round(top)}px`

  requestAnimationFrame(() => panel.classList.add('open'))
  anchor.classList.add('active')
  openEl = panel
  openAnchor = anchor

  const onPointerDown = (event) => {
    if (panel.contains(event.target) || anchor.contains(event.target)) return
    closePopover()
  }
  const onKey = (event) => {
    if (event.key === 'Escape') closePopover()
  }
  const onResize = () => closePopover()

  setTimeout(() => {
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
  }, 0)

  cleanup = () => {
    document.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('keydown', onKey)
    window.removeEventListener('resize', onResize)
  }

  return panel
}

export function popoverSection (title) {
  return h('div', { class: 'popover-title', text: title })
}

export function popoverItem ({ icon = null, label, desc = '', active = false, onClick, trailing = null }) {
  return h('button', {
    class: 'popover-item' + (active ? ' active' : ''),
    onclick: onClick
  },
  icon,
  h('span', { class: 'popover-item-body' },
    h('span', { class: 'popover-item-label', text: label }),
    desc ? h('span', { class: 'popover-item-desc', text: desc }) : null
  ),
  trailing || (active ? h('span', { class: 'popover-item-check' }, '✓') : null)
  )
}
