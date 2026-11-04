/* sfx-bell.js — 铃铛音色（纯模块，零依赖）
 *
 * 只要三声清脆的铃：导航星①、导航星②、第三颗星（Logo 落点）。
 * 收场把 Logo 送到左上角时完全安静，不叠和弦、不加铃串、不做界面音。
 * 每声是一个铃体：非谐泛音模态 + 1.5ms 起音 + 6ms 敲击瞬态 + 自然余韵，
 * 没有持续白噪声、没有低频垫音、没有 whoosh、没有第二记回响。
 *
 * builder 签名 (ctx, t, dest)，可用 OfflineAudioContext 离线渲染自检。
 */

export const SFX_NAMES = ['waypoint1', 'waypoint2', 'merge']

/* 三声全部在彗星航程内，对齐 spCometRun 的 32% / 66% / 95% 三个落点 */
export const SCORE = [
  [368, 'waypoint1'],
  [759, 'waypoint2'],
  [1093, 'merge']
]

const noiseCache = new WeakMap()

function noiseBuffer (c) {
  let buf = noiseCache.get(c)
  if (buf) return buf
  buf = c.createBuffer(1, Math.ceil(c.sampleRate * 0.2), c.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  noiseCache.set(c, buf)
  return buf
}

function route (c, node, dest, pan) {
  if (pan && c.createStereoPanner) {
    const p = c.createStereoPanner()
    p.pan.value = Math.max(-1, Math.min(1, pan))
    node.connect(p)
    p.connect(dest)
  } else {
    node.connect(dest)
  }
}

/* 铃体模态：倍率 / 振幅 / 相对衰减（高频先消失才有金属感） */
const MODES = [
  { r: 1.00, a: 1.00, decay: 1.00 },
  { r: 2.00, a: 0.55, decay: 0.72 },
  { r: 2.76, a: 0.40, decay: 0.58 },
  { r: 4.16, a: 0.26, decay: 0.42 },
  { r: 5.43, a: 0.16, decay: 0.32 },
  { r: 8.21, a: 0.09, decay: 0.24 }
]

function bell (c, t, o) {
  const dest = o.dest
  const f = o.f
  const dur = o.dur
  const peak = o.gain
  const pan = o.pan || 0
  const nyquist = c.sampleRate * 0.45

  for (const m of MODES) {
    const d = Math.max(0.12, dur * m.decay)
    const amp = peak * m.a
    const detunes = m.r <= 2.76 ? [1, 1.0034] : [1]
    for (const de of detunes) {
      const osc = c.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(Math.min(nyquist, f * m.r * de), t)
      const g = c.createGain()
      const share = detunes.length === 2 ? (de === 1 ? 0.62 : 0.38) : 1
      g.gain.setValueAtTime(0.0001, t)
      g.gain.linearRampToValueAtTime(Math.max(0.0002, amp * share), t + 0.0015)
      g.gain.exponentialRampToValueAtTime(0.0001, t + d)
      route(c, g, dest, pan)
      osc.connect(g)
      osc.start(t)
      osc.stop(t + d + 0.02)
    }
  }

  /* 敲击瞬态：6ms 高通噪声，只给「碰到」的质感 */
  const src = c.createBufferSource()
  src.buffer = noiseBuffer(c)
  src.loop = true
  const hp = c.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 5200
  const g = c.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.linearRampToValueAtTime(peak * 0.28, t + 0.001)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.006)
  src.connect(hp)
  hp.connect(g)
  route(c, g, dest, pan)
  src.start(t)
  src.stop(t + 0.008)
}

export const BUILDERS = {
  /* 第一声：导航星①，E6 */
  waypoint1 (c, t, dest) {
    bell(c, t, { dest, f: 1318.51, gain: 0.16, dur: 1.0, pan: -0.25 })
  },
  /* 第二声：导航星②，A6，更高更亮 */
  waypoint2 (c, t, dest) {
    bell(c, t, { dest, f: 1760, gain: 0.17, dur: 1.05, pan: 0.25 })
  },
  /* 第三声：彗星抵达第三颗星（Logo 落点，1093ms），C7 */
  merge (c, t, dest) {
    bell(c, t, { dest, f: 2093, gain: 0.17, dur: 1.25 })
  }
}

/* 离线渲染 + 波形指标：确认快起音 / 有余韵 / 高频丰富 */
export async function renderOffline (name, seconds = 2) {
  const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext
  if (!OC || !BUILDERS[name]) return null
  const rate = 44100
  const len = Math.ceil(rate * seconds)
  const oc = new OC(1, len, rate)
  BUILDERS[name](oc, 0, oc.destination)
  const buf = await oc.startRendering()
  const d = buf.getChannelData(0)
  let peak = 0
  let sum = 0
  for (let i = 0; i < d.length; i++) {
    const v = Math.abs(d[i])
    if (v > peak) peak = v
    sum += d[i] * d[i]
  }
  let attackIdx = 0
  let lastLoud = 0
  let diff = 0
  let cross = 0
  for (let i = 0; i < d.length; i++) {
    const v = Math.abs(d[i])
    if (attackIdx === 0 && v >= peak * 0.2) attackIdx = i
    if (v > peak * 0.05) lastLoud = i
    if (i) {
      const dv = d[i] - d[i - 1]
      diff += dv * dv
      if ((d[i - 1] < 0) !== (d[i] < 0)) cross++
    }
  }
  return {
    rms: Math.sqrt(sum / d.length),
    peak,
    samples: d.length,
    attackMs: attackIdx / rate * 1000,
    tailMs: Math.max(0, (lastLoud - attackIdx) / rate * 1000),
    zcr: cross / seconds,
    hf: sum > 0 ? diff / sum : 0
  }
}
