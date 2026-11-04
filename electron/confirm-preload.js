'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('astralConfirm', {
  ready: () => ipcRenderer.send('astral:confirm:ready'),
  respond: (id, choice) => ipcRenderer.send('astral:confirm:respond', { id, choice }),
  onPayload: (handler) => {
    if (typeof handler !== 'function') return
    ipcRenderer.on('astral:confirm:payload', (_event, payload) => handler(payload))
  }
})
