'use strict'

/* mp4-duration.js — 给 MediaRecorder 产出的分片 MP4 补写时长
 *
 * Chromium 录制的是 fragmented MP4：mvhd 里 duration=0，分片里才有真实时长。
 * 多数播放器（微信、系统播放器）只看 mvhd，会显示 0:00 且拖动困难。
 * 这里按 trun 的 sample_duration 求和，回填 mvhd / tkhd / mdhd 的 duration 字段。
 * 只改字段值，不改文件长度。
 */

const fs = require('node:fs')

function boxes (buf, start, end) {
  const out = []
  let p = start
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p)
    const type = buf.toString('ascii', p + 4, p + 8)
    let head = 8
    if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); head = 16 } else if (size === 0) size = end - p
    if (size < head || p + size > end) break
    out.push({ type, start: p + head, end: p + size, boxStart: p, size })
    p += size
  }
  return out
}
function find (buf, start, end, type) {
  for (const b of boxes(buf, start, end)) {
    if (b.type === type) return b
    const inner = find(buf, b.start, b.end, type)
    if (inner) return inner
  }
  return null
}
function readU64 (buf, o) { return Number(buf.readBigUInt64BE(o)) }

function patch (file) {
  const buf = fs.readFileSync(file)
  const top = boxes(buf, 0, buf.length)
  const moov = top.find((b) => b.type === 'moov')
  if (!moov) throw new Error('找不到 moov')
  const mvhd = find(buf, moov.start, moov.end, 'mvhd')
  if (!mvhd) throw new Error('找不到 mvhd')
  const mvVer = buf[mvhd.start]
  const movieTs = mvVer === 1 ? buf.readUInt32BE(mvhd.start + 20) : buf.readUInt32BE(mvhd.start + 12)

  /* 轨道：track_ID ↔ 媒体 timescale */
  const tracks = new Map()
  for (const trak of boxes(buf, moov.start, moov.end).filter((b) => b.type === 'trak')) {
    const tkhd = find(buf, trak.start, trak.end, 'tkhd')
    const mdhd = find(buf, trak.start, trak.end, 'mdhd')
    if (!tkhd || !mdhd) continue
    const tkhdVer = buf[tkhd.start]
    const idOff = tkhdVer === 1 ? 20 : 12
    const mdhdVer = buf[mdhd.start]
    const tsOff = mdhdVer === 1 ? 20 : 12
    tracks.set(buf.readUInt32BE(tkhd.start + idOff), {
      timescale: buf.readUInt32BE(mdhd.start + tsOff),
      mediaDur: 0,
      mdhd,
      tkhd,
      tkhdVer
    })
  }

  /* 分片样本时长求和 */
  for (const moof of top.filter((b) => b.type === 'moof')) {
    for (const traf of boxes(buf, moof.start, moof.end).filter((b) => b.type === 'traf')) {
      const tfhd = find(buf, traf.start, traf.end, 'tfhd')
      if (!tfhd) continue
      const tfFlags = buf.readUInt32BE(tfhd.start) & 0xffffff
      const trackId = buf.readUInt32BE(tfhd.start + 4)
      if (!tracks.has(trackId)) continue
      let p = tfhd.start + 8
      if (tfFlags & 0x1) p += 8
      if (tfFlags & 0x2) p += 4
      let defDur = null
      if (tfFlags & 0x8) { defDur = buf.readUInt32BE(p); p += 4 }
      if (tfFlags & 0x10) p += 4
      if (tfFlags & 0x20) p += 4
      let total = 0
      for (const trun of boxes(buf, traf.start, traf.end).filter((b) => b.type === 'trun')) {
        const ver = buf[trun.start]
        const flags = buf.readUInt32BE(trun.start) & 0xffffff
        const count = buf.readUInt32BE(trun.start + 4)
        let q = trun.start + 8
        if (flags & 0x1) q += 4
        if (flags & 0x4) q += 4
        const hasDur = Boolean(flags & 0x100)
        const hasSize = Boolean(flags & 0x200)
        const hasFlags = Boolean(flags & 0x400)
        const hasCto = Boolean(flags & 0x800)
        for (let i = 0; i < count; i++) {
          if (hasDur) { total += buf.readUInt32BE(q); q += 4 } else if (defDur != null) total += defDur
          if (hasSize) q += 4
          if (hasFlags) q += 4
          if (hasCto) q += ver === 0 ? 4 : 8
        }
      }
      tracks.get(trackId).mediaDur += total
    }
  }

  let seconds = 0
  for (const t of tracks.values()) {
    if (t.timescale) seconds = Math.max(seconds, t.mediaDur / t.timescale)
  }
  if (!seconds) throw new Error('分片里没有可用的样本时长')

  if (mvVer === 1) buf.writeBigUInt64BE(BigInt(Math.round(seconds * movieTs)), mvhd.start + 24)
  else buf.writeUInt32BE(Math.round(seconds * movieTs), mvhd.start + 16)

  for (const t of tracks.values()) {
    /* tkhd 的 duration 用影片 timescale */
    if (t.tkhdVer === 1) buf.writeBigUInt64BE(BigInt(Math.round(seconds * movieTs)), t.tkhd.start + 28)
    else buf.writeUInt32BE(Math.round(seconds * movieTs), t.tkhd.start + 20)
    /* mdhd 用媒体 timescale */
    if (t.timescale) {
      const v = buf[t.mdhd.start]
      if (v === 1) buf.writeBigUInt64BE(BigInt(Math.round(seconds * t.timescale)), t.mdhd.start + 24)
      else buf.writeUInt32BE(Math.round(seconds * t.timescale), t.mdhd.start + 16)
    }
  }
  fs.writeFileSync(file, buf)
  return { seconds, tracks: [...tracks.values()].map((t) => Math.round(t.mediaDur / t.timescale * 100) / 100) }
}

module.exports = { patch }

if (require.main === module) {
  const file = process.argv[2]
  if (!file) { console.error('用法：node scripts/mp4-duration.js <file.mp4>'); process.exit(1) }
  try {
    const r = patch(file)
    console.log(`[mp4] 已写入时长 ${r.seconds.toFixed(2)}s · 各轨 ${r.tracks.join(' / ')}s`)
  } catch (err) {
    console.error('[mp4] 补写失败：' + err.message)
    process.exit(1)
  }
}
