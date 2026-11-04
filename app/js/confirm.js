/* confirm.js — 应用内主题化确认框
 *
 * 不调用浏览器原生 confirm；使用独立于 modal-root 的遮罩层，
 * 因此可以在设置页、任务面板等已有弹层之上继续弹出。
 */

import { h } from './core.js'

let active = null

const safeText = (value) => String(value === undefined || value === null ? '' : value)

export function confirmAction ({
  title = '确认操作',
  message = '',
  detail = '',
  confirmText = '确认',
  cancelText = '取消',
  danger = false
} = {}) {
  if (active) return Promise.resolve(false)
  return new Promise((resolve) => {
    const finish = (value) => {
      if (!active || active.root !== root) return
      document.removeEventListener('keydown', onKey, true)
      active = null
      root.classList.add('leaving')
      const remove = () => { if (root.isConnected) root.remove() }
      if (document.body.classList.contains('reduced-motion')) remove()
      else setTimeout(remove, 160)
      resolve(Boolean(value))
    }

    const cancel = h('button', {
      class: 'btn ghost astral-confirm-cancel',
      type: 'button',
      text: cancelText,
      onclick: () => finish(false)
    })
    const accept = h('button', {
      class: 'btn ' + (danger ? 'danger' : 'primary') + ' astral-confirm-ok',
      type: 'button',
      text: confirmText,
      onclick: () => finish(true)
    })
    const panel = h('div', {
      class: 'astral-confirm-panel' + (danger ? ' is-danger' : ''),
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': title
    },
    h('div', { class: 'astral-confirm-head' },
      h('span', { class: 'astral-confirm-icon' + (danger ? ' danger' : ''), text: danger ? '!' : '?' }),
      h('div', { class: 'astral-confirm-title', text: safeText(title) })
    ),
    message ? h('div', { class: 'astral-confirm-message', text: safeText(message) }) : null,
    detail ? h('pre', { class: 'astral-confirm-detail', text: safeText(detail) }) : null,
    h('div', { class: 'astral-confirm-actions' }, cancel, accept)
    )
    const root = h('div', { class: 'astral-confirm-root' },
      h('div', { class: 'astral-confirm-backdrop', onclick: () => finish(false) }),
      panel
    )

    function onKey (event) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        finish(false)
      }
    }

    active = { root, finish }
    document.body.append(root)
    document.addEventListener('keydown', onKey, true)
    requestAnimationFrame(() => {
      root.classList.add('open')
      ;(danger ? cancel : accept).focus()
    })
  })
}
