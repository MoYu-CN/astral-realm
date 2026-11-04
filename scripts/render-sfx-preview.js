#!/usr/bin/env node
'use strict'

/* render-sfx-preview.js — 把铃铛版启动组曲离线渲染成 WAV，供直接试听
 * 用法：npm run sfx:preview
 * 直接从 app/js/sfx-bell.js 读源码注入页面，音色永远与产品里的一致，不会出现第二份分叉。
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const r = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit' })
  process.exit(r.status == null ? 1 : r.status)
}

const { app, BrowserWindow, ipcMain } = require('electron')
const ROOT = path.join(__dirname, '..')
const out = path.resolve(ROOT, process.argv[2] || 'promo/启动音效-铃铛版.wav')

app.whenReady().then(() => {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'js', 'sfx-bell.js'), 'utf8')
    .replace(/^export\s+/gm, '')
  const page = `<!doctype html><meta charset="utf-8"><title>铃铛音效离线渲染</title>
<script>${src}</script>
<script>
(async () => {
  const rate = 44100, DUR = 3.2
  const oc = new OfflineAudioContext(1, Math.ceil(rate * DUR), rate)
  const bus = oc.createGain()
  bus.gain.value = 0.62
  bus.connect(oc.destination)
  /* 三声全在 SCORE 的彗星航程内；收场（Logo 飞到左上角）不渲染任何声音 */
  for (const [ms, name] of SCORE) BUILDERS[name](oc, ms / 1000, bus)
  const rendered = await oc.startRendering()
  const pcm = rendered.getChannelData(0)
  const n = pcm.length
  const bytes = new ArrayBuffer(44 + n * 2)
  const dv = new DataView(bytes)
  const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true)
  dv.setUint16(22, 1, true); dv.setUint32(24, rate, true)
  dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true)
  str(36, 'data'); dv.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]))
    dv.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7FFF, true)
  }
  window.promo.save(bytes)
})().catch((e) => console.error('[sfx-preview]', e.message))
</script>`

  const tempHtml = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'astral-sfx-')), 'render.html')
  fs.writeFileSync(tempHtml, page, 'utf8')

  const win = new BrowserWindow({
    width: 400, height: 300, show: false,
    webPreferences: { preload: path.join(__dirname, 'promo-preload.js'), contextIsolation: true }
  })
  let done = false
  const finish = (code, msg) => {
    if (done) return
    done = true
    if (msg) console.log(msg)
    try { win.destroy() } catch { /* 已关闭 */ }
    try { fs.rmSync(path.dirname(tempHtml), { recursive: true, force: true }) } catch { /* ignore */ }
    app.exit(code)
  }
  ipcMain.once('promo:save', (_e, data) => {
    try {
      const buf = Buffer.from(data)
      fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.writeFileSync(out, buf)
      if (buf.length < 100000) return finish(1, `[sfx-preview] 输出异常小：${buf.length}`)
      finish(0, `[sfx-preview] 已保存 ${out} (${(buf.length / 1024 / 1024).toFixed(2)} MB · 3.2s · 彗星航程内三声 · 收场静音 · 44.1kHz 单声道)`)
    } catch (err) {
      finish(1, `[sfx-preview] 写文件失败：${err.message}`)
    }
  })
  win.webContents.on('console-message', (_e, level, text) => {
    if (text.startsWith('[sfx-preview]')) console.error(text)
  })
  win.loadFile(tempHtml).catch((err) => finish(1, `[sfx-preview] 加载失败：${err.message}`))
  setTimeout(() => finish(1, '[sfx-preview] 渲染超时'), 60000)
})
