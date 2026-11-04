#!/usr/bin/env node
'use strict'

/* verify-promo.js — 核对宣传片：容器/轨道/时长/音轨电平，并抽帧存 PNG */
const path = require('node:path')
const fs = require('node:fs')

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const r = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit' })
  process.exit(r.status == null ? 1 : r.status)
}

const { app, BrowserWindow, ipcMain } = require('electron')
const ROOT = path.join(__dirname, '..')
const video = path.resolve(ROOT, process.argv[2] || 'promo/星界-宣传片.mp4')
const framesDir = path.join(ROOT, 'promo', 'frames')

/* ---------- 容器层：时长、轨道、编码 ---------- */
function readBoxes (buf, start, end) {
  const out = []
  let p = start
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p)
    const type = buf.toString('ascii', p + 4, p + 8)
    let head = 8
    if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); head = 16 } else if (size === 0) size = end - p
    if (size < head || p + size > end) break
    out.push({ type, start: p + head, end: p + size })
    p += size
  }
  return out
}
function findBox (buf, start, end, type) {
  for (const b of readBoxes(buf, start, end)) {
    if (b.type === type) return b
    const inner = findBox(buf, b.start, b.end, type)
    if (inner) return inner
  }
  return null
}
function inspect (file) {
  const buf = fs.readFileSync(file)
  const top = readBoxes(buf, 0, buf.length)
  const moov = top.find((b) => b.type === 'moov')
  if (!moov) throw new Error('找不到 moov')
  const mvhd = findBox(buf, moov.start, moov.end, 'mvhd')
  if (!mvhd) throw new Error('找不到 mvhd')
  const version = buf[mvhd.start]
  const timescale = version === 1 ? buf.readUInt32BE(mvhd.start + 20) : buf.readUInt32BE(mvhd.start + 12)
  const duration = version === 1
    ? Number(buf.readBigUInt64BE(mvhd.start + 24))
    : buf.readUInt32BE(mvhd.start + 16)
  const traks = readBoxes(buf, moov.start, moov.end).filter((b) => b.type === 'trak').map((t) => {
    const hdlr = findBox(buf, t.start, t.end, 'hdlr')
    const stsd = findBox(buf, t.start, t.end, 'stsd')
    return {
      handler: hdlr ? buf.toString('ascii', hdlr.start + 8, hdlr.start + 12) : '????',
      codec: stsd ? buf.toString('ascii', stsd.start + 12, stsd.start + 16) : '????'
    }
  })
  return { bytes: buf.length, seconds: timescale ? duration / timescale : 0, traks }
}

let container = null
try {
  container = inspect(video)
  console.log(`[verify] 容器 ${(container.bytes / 1024 / 1024).toFixed(2)} MB · 时长 ${container.seconds.toFixed(2)}s`)
  console.log('[verify] 轨道 ' + container.traks.map((t) => `${t.handler}/${t.codec}`).join(' · '))
} catch (err) {
  console.error('[verify] 容器解析失败：' + err.message)
  process.exit(1)
}
if (!container.traks.some((t) => t.handler === 'vide')) { console.error('[verify] 缺少视频轨'); process.exit(1) }
if (!container.traks.some((t) => t.handler === 'soun')) { console.error('[verify] 缺少音频轨'); process.exit(1) }
if (container.seconds < 15.8 || container.seconds > 17.2) { console.error('[verify] 时长超出预期'); process.exit(1) }

/* ---------- 解码层：首帧尺寸、音轨电平、起音、抽帧 ---------- */
app.whenReady().then(() => {
  fs.mkdirSync(framesDir, { recursive: true })
  const win = new BrowserWindow({
    width: 1280, height: 720, show: false,
    webPreferences: { preload: path.join(__dirname, 'promo-preload.js'), contextIsolation: true }
  })
  let finished = false
  const finish = (code) => {
    if (finished) return
    finished = true
    try { win.destroy() } catch { /* 已关闭 */ }
    app.exit(code)
  }
  ipcMain.handle('promo:read', (_e, file) => {
    const b = fs.readFileSync(file)
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  })
  ipcMain.once('promo:meta', (_e, info) => {
    if (info.error) { console.error('[verify]', info.error); return finish(1) }
    console.log(`[verify] 解码 ${info.duration.toFixed(2)}s · ${info.width}x${info.height}`)
    const audio = info.audio || {}
    if (audio.error) { console.error('[verify] 音轨解码失败：' + audio.error); return finish(1) }
    console.log(`[verify] 音轨 ${audio.seconds.toFixed(2)}s · 峰值 ${audio.peak.toFixed(3)} · RMS ${audio.rms.toFixed(4)}`)
    console.log('[verify] 起音 ' + audio.onsets.slice(0, 12).join(' '))
    if (audio.peak < 0.3) { console.error('[verify] 音轨过轻'); return finish(1) }
    const first = audio.onsets[0]
    if (first == null || first < 0.08 || first > 0.5) { console.error('[verify] 音轨起始偏移异常：' + first); return finish(1) }
    console.log('[verify] 首次起音 ' + (first * 1000).toFixed(0) + 'ms（预期 ≈240ms，含 80ms 预卷）')
  })
  ipcMain.on('promo:frame', (_e, t, dataUrl) => {
    const file = path.join(framesDir, `t${String(t).replace('.', '_')}s.png`)
    fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'))
    console.log(`[verify] 抽帧 ${path.basename(file)}`)
  })
  ipcMain.once('promo:done', () => finish(0))
  win.loadFile(path.join(ROOT, 'promo', '_verify.html'), {
    query: {
      src: encodeURIComponent('file:///' + video.replace(/\\/g, '/')),
      file: encodeURIComponent(video),
      ts: process.argv[3] || '1.2,4.2,7.6,11.6,14.8'
    }
  }).catch((err) => { console.error('[verify]', err.message); finish(1) })
  setTimeout(() => { console.error('[verify] 超时'); finish(1) }, 90000)
})
