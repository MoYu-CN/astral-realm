/* confirm-window.js — 主进程可信的主题化确认窗口
 *
 * 用于工具授权、发起成员确认、构建更新等必须由主进程最终确认的决策。
 * 页面运行在独立 BrowserWindow 中，带 preload 且 contextIsolation/sandbox，
 * 不允许 main renderer 伪造结果；主进程会校验 sender 与一次性 id。
 */

'use strict'

const { BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')

let serial = 0

function normalizeActions (actions) {
  const list = Array.isArray(actions) ? actions : []
  return list
    .filter((item) => item && Number.isInteger(Number(item.value)))
    .slice(0, 3)
    .map((item) => ({
      value: Number(item.value),
      label: String(item.label || '确定'),
      style: item.style === 'danger' || item.style === 'primary' || item.style === 'ghost'
        ? item.style
        : 'ghost'
    }))
}

function showThemedConfirm ({
  parent = null,
  title = '确认操作',
  message = '',
  detail = '',
  actions = [],
  cancelValue = null,
  themeTokens = {},
  width = 560,
  height = 0
} = {}) {
  const choices = normalizeActions(actions)
  if (!choices.length) return Promise.resolve(cancelValue)

  const id = `confirm_${Date.now().toString(36)}_${serial++}`
  const owner = parent && !parent.isDestroyed() ? parent : null
  const contentHeight = height || Math.min(720, 370 + Math.min(280, Math.ceil(String(detail || '').length / 64) * 17))
  const theme = themeTokens && typeof themeTokens === 'object' ? themeTokens : {}
  const win = new BrowserWindow({
    parent: owner || undefined,
    modal: Boolean(owner),
    width,
    height: contentHeight,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    center: true,
    backgroundColor: theme['--bg-1'] || '#0a0c18',
    webPreferences: {
      preload: path.join(__dirname, 'confirm-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  return new Promise((resolve) => {
    let settled = false

    const cleanup = () => {
      ipcMain.removeListener('astral:confirm:respond', onResponse)
    }

    const finish = (choice) => {
      if (settled) return
      settled = true
      cleanup()
      if (win && !win.isDestroyed()) win.close()
      resolve(choice)
    }

    const onResponse = (event, payload = {}) => {
      if (!win || win.isDestroyed() || event.sender.id !== win.webContents.id) return
      if (String(payload.id || '') !== id) return
      const value = Number(payload.choice)
      if (!choices.some((choice) => choice.value === value)) {
        finish(cancelValue)
        return
      }
      finish(value)
    }

    win.webContents.on('render-process-gone', () => finish(cancelValue))
    win.webContents.on('did-fail-load', () => finish(cancelValue))
    win.on('closed', () => {
      if (!settled) {
        settled = true
        cleanup()
        resolve(cancelValue)
      }
    })

    ipcMain.on('astral:confirm:respond', onResponse)
    win.webContents.on('did-finish-load', () => {
      if (!win || win.isDestroyed()) return
      win.webContents.send('astral:confirm:payload', {
        id,
        title: String(title || ''),
        message: String(message || ''),
        detail: String(detail || ''),
        actions: choices,
        cancelValue,
        theme
      })
    })
    win.loadFile(path.join(__dirname, '..', 'app', 'confirm.html')).catch(() => finish(cancelValue))
    win.once('ready-to-show', () => {
      if (!win || win.isDestroyed()) return
      win.show()
      win.focus()
    })
  })
}

module.exports = { showThemedConfirm }
