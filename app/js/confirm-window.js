/* confirm-window.js — 确认窗口页面逻辑（无 Node 权限，只负责渲染与回传） */

'use strict'

const titleEl = document.getElementById('confirm-title')
const messageEl = document.getElementById('confirm-message')
const detailEl = document.getElementById('confirm-detail')
const actionsEl = document.getElementById('confirm-actions')
const iconEl = document.getElementById('confirm-icon')
const closeEl = document.getElementById('confirm-x')

let current = null
let responded = false

function respond (choice) {
  if (responded || !current) return
  responded = true
  window.astralConfirm.respond(current.id, choice)
}

function applyTheme (tokens) {
  if (!tokens || typeof tokens !== 'object') return
  const root = document.documentElement
  for (const [key, value] of Object.entries(tokens)) {
    if (!/^--[a-z0-9-]+$/i.test(key)) continue
    if (typeof value !== 'string' && typeof value !== 'number') continue
    root.style.setProperty(key, String(value))
  }
}

function render (payload) {
  current = payload
  applyTheme(payload.theme)
  const actions = Array.isArray(payload.actions) ? payload.actions : []
  const cancelAction = actions.find((action) => action.value === payload.cancelValue)
  const danger = actions.some((action) => action.style === 'danger')

  document.title = `${payload.title || '确认操作'} · 星界`
  titleEl.textContent = payload.title || '确认操作'
  messageEl.textContent = payload.message || ''
  detailEl.textContent = payload.detail || ''
  detailEl.hidden = !payload.detail
  iconEl.textContent = danger ? '!' : '?'
  iconEl.classList.toggle('danger', danger)
  document.body.classList.toggle('is-danger', danger)

  actionsEl.textContent = ''
  const buttons = []
  for (const action of actions) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `confirm-btn ${action.style || 'ghost'}`
    button.textContent = action.label || '确定'
    button.addEventListener('click', () => respond(action.value))
    actionsEl.append(button)
    buttons.push({ action, button })
  }
  if (!buttons.length) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'confirm-btn ghost'
    button.textContent = '关闭'
    button.addEventListener('click', () => respond(cancelAction ? cancelAction.value : payload.cancelValue))
    actionsEl.append(button)
    buttons.push({ action: cancelAction, button })
  }
  closeEl.onclick = () => respond(payload.cancelValue)

  /* 默认焦点放在取消动作，避免回车误授权；没有取消动作则放主操作。 */
  const focusTarget = cancelAction
    ? buttons.find((item) => item.action && item.action.value === cancelAction.value)?.button
    : (buttons.find((item) => item.action && item.action.style === 'primary') || buttons[0])?.button
  if (focusTarget) setTimeout(() => focusTarget.focus(), 30)
}

window.astralConfirm.onPayload((payload) => {
  if (!payload || typeof payload !== 'object') return
  render(payload)
})
window.astralConfirm.ready()

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    if (current) respond(current.cancelValue)
  }
})

window.addEventListener('error', () => {
  if (current) respond(current.cancelValue)
})
