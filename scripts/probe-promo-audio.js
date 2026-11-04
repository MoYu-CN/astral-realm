#!/usr/bin/env node
'use strict'

/* probe-promo-audio.js — 读宣传片音轨 WAV，报告电平、包络与起音时刻
 * 用法：npm run probe:promo-audio -- [wav路径]
 * 只依赖 node:fs，不引第三方库。
 */
const fs = require('node:fs')
const path = require('node:path')

const file = path.resolve(process.argv[2] || 'promo/星界-宣传片-音轨.wav')
const buf = fs.readFileSync(file)
if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
  console.error('[wav] 不是 WAV 文件'); process.exit(1)
}
let p = 12
let fmt = null
let data = null
while (p + 8 <= buf.length) {
  const id = buf.toString('ascii', p, p + 4)
  const size = buf.readUInt32LE(p + 4)
  if (id === 'fmt ') {
    fmt = {
      format: buf.readUInt16LE(p + 8),
      channels: buf.readUInt16LE(p + 10),
      rate: buf.readUInt32LE(p + 12),
      bits: buf.readUInt16LE(p + 22)
    }
  } else if (id === 'data') {
    data = buf.subarray(p + 8, p + 8 + size)
  }
  p += 8 + size + (size % 2)
}
if (!fmt || !data) { console.error('[wav] 缺少 fmt/data 块'); process.exit(1) }
const bytes = fmt.bits / 8
const frames = Math.floor(data.length / (bytes * fmt.channels))
const seconds = frames / fmt.rate
const chans = []
for (let ch = 0; ch < fmt.channels; ch++) chans.push(new Float32Array(frames))
for (let i = 0; i < frames; i++) {
  for (let ch = 0; ch < fmt.channels; ch++) {
    const o = (i * fmt.channels + ch) * bytes
    chans[ch][i] = fmt.bits === 16 ? data.readInt16LE(o) / 32768 : data.readFloatLE(o)
  }
}

let peak = 0
let sum = 0
let clip = 0
const mono = new Float32Array(frames)
for (let i = 0; i < frames; i++) {
  let v = 0
  for (let ch = 0; ch < fmt.channels; ch++) v += chans[ch][i]
  v /= fmt.channels
  mono[i] = v
  const a = Math.abs(v)
  if (a > peak) peak = a
  if (a >= 0.999) clip++
  sum += v * v
}
const rms = Math.sqrt(sum / frames)
const db = (x) => (x <= 0 ? -Infinity : 20 * Math.log10(x))

/* 20ms 窗包络 + 起音检测（相对峰值 -22dB，且比前 120ms 抬升 8dB） */
const win = Math.round(fmt.rate * 0.02)
const env = []
for (let i = 0; i < frames; i += win) {
  let m = 0
  for (let j = i; j < Math.min(i + win, frames); j++) m = Math.max(m, Math.abs(mono[j]))
  env.push(m)
}
const floor = peak * 0.08
const onsets = []
let quiet = 0
for (let i = 1; i < env.length; i++) {
  if (env[i] > floor && env[i] > env[i - 1] * 1.8) {
    const t = i * win / fmt.rate
    if (!onsets.length || t - onsets[onsets.length - 1] > 0.09) onsets.push(t)
    quiet = 0
  } else if (env[i] <= floor) quiet++
}
const silentRatio = env.filter((v) => v < peak * 0.01).length / env.length

console.log(`[wav] ${path.basename(file)}`)
console.log(`[wav] ${seconds.toFixed(2)}s · ${fmt.channels}ch · ${fmt.rate}Hz · ${fmt.bits}bit`)
console.log(`[wav] 峰值 ${peak.toFixed(3)} (${db(peak).toFixed(1)} dBFS) · RMS ${rms.toFixed(4)} (${db(rms).toFixed(1)} dBFS) · 削波 ${clip}`)
console.log(`[wav] 静音占比 ${(silentRatio * 100).toFixed(0)}% · 起音 ${onsets.length} 处`)
console.log('[wav] 起音时刻 ' + onsets.map((t) => t.toFixed(2)).join(' '))

const bad = []
if (peak > 0.99) bad.push('峰值过高，可能削波')
if (peak < 0.35) bad.push('整体过轻')
if (rms < 0.012) bad.push('RMS 过低，像没出声')
if (seconds < 15.5) bad.push('音轨短于画面')
if (bad.length) { console.error('[wav] 问题：' + bad.join('；')); process.exit(1) }
console.log('[wav] 电平检查通过')
