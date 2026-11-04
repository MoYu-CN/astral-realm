#!/usr/bin/env node
'use strict'

/* render-promo.js — 用 Electron 的 MediaRecorder 把 Canvas 宣传动画录成 WebM
 * 用法：npm run promo -- [html路径] [输出webm] [秒数]
 */
const path = require('node:path')
const fs = require('node:fs')

/* 用普通 node 启动时自举到 Electron，并清掉宿主 IDE 注入的 ELECTRON_RUN_AS_NODE */
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const r = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit' })
  process.exit(r.status == null ? 1 : r.status)
}

const ROOT = path.join(__dirname, '..')
const html = path.resolve(ROOT, process.argv[2] || 'promo/index.html')
const mode = process.argv[5] === 'wav' ? 'wav' : 'video'
const out = path.resolve(ROOT, process.argv[3] || (mode === 'wav' ? 'promo/星界-宣传片-音轨.wav' : 'promo/星界-宣传片.mp4'))
const seconds = Math.max(1, Number(process.argv[4]) || 16.4)

const { app, BrowserWindow, ipcMain } = require('electron')

/* 无人值守录制：AudioContext 不能被自动播放策略挂起 */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    show: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'promo-preload.js'),
      contextIsolation: true,
      backgroundThrottling: false
    }
  })
  /* 移到屏幕外，保持窗口可见以避免 Chromium 节流 rAF */
  win.setPosition(-3200, -3200)
  win.setAlwaysOnTop(false)

  let done = false
  const finish = (code, message) => {
    if (done) return
    done = true
    if (message) console.log(message)
    try { win.destroy() } catch { /* 已关闭 */ }
    app.exit(code)
  }

  ipcMain.once('promo:save', (_event, data) => {
    try {
      const buf = Buffer.from(data)
      fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.writeFileSync(out, buf)
      if (buf.length < 10000) return finish(1, `[promo] 输出异常小：${buf.length} 字节`)
      let extra = ''
      if (mode === 'video' && out.toLowerCase().endsWith('.mp4')) {
        try {
          const { patch } = require('./mp4-duration')
          const info = patch(out)
          extra = ` · 时长 ${info.seconds.toFixed(2)}s`
        } catch (err) {
          console.error('[promo] 时长补写失败：' + err.message)
        }
      }
      finish(0, `[promo] 已保存 ${out} (${(buf.length / 1024 / 1024).toFixed(2)} MB${extra})`)
    } catch (err) {
      finish(1, `[promo] 写文件失败：${err.message}`)
    }
  })

  win.webContents.on('console-message', (_e, level, text) => {
    if (text.startsWith('[promo]') || text.startsWith('[mime]')) console.log('[promo:page]', text)
    else if (level >= 2 && !text.includes('Security Warning') && !text.includes('console-message')) console.error('[promo:page]', text)
  })

  win.loadFile(html, { query: { dur: String(seconds), mode } }).catch((err) => {
    finish(1, `[promo] 页面加载失败：${err.message}`)
  })

  setTimeout(() => finish(1, '[promo] 录制超时，未收到视频数据'), (seconds + 30) * 1000)
})
