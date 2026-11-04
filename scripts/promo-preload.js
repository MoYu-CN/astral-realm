'use strict'
/* 宣传片录制与核对：视频/音轨回传主进程落盘，核对时按需读取本地文件 */
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('promo', {
  save: (buffer) => ipcRenderer.send('promo:save', buffer),
  ready: () => ipcRenderer.send('promo:ready'),
  meta: (info) => ipcRenderer.send('promo:meta', info),
  frame: (t, dataUrl) => ipcRenderer.send('promo:frame', t, dataUrl),
  done: () => ipcRenderer.send('promo:done'),
  read: (file) => ipcRenderer.invoke('promo:read', file)
})
