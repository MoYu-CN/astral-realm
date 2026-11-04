/* sfx.js — 音效状态与调度层
 *
 * 全程只有三声清脆铃：导航星①、导航星②、第三颗星（Logo 落点）。收场无声。
 * 音色在 sfx-bell.js（纯模块、零依赖），这里只管配置、播放与启动节拍。
 */

import { state, bus, persist } from './core.js'
import { BUILDERS, SFX_NAMES, SCORE } from './sfx-bell.js'
export { renderOffline } from './sfx-bell.js'

const DEFAULTS = { enabled: true, startup: true, volume: 0.5 }
const scheduled = []
let ctx = null
let master = null

export function config () {
  const raw = state.settings && state.settings.sfx
  return { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
}

export function setConfig (patch = {}) {
  if (!state.settings) state.settings = {}
  state.settings.sfx = { ...config(), ...patch }
  applyVolume()
  persist.settings()
  bus.emit('sfx:changed')
  return state.settings.sfx
}

function applyVolume () {
  if (!ctx || !master) return
  const c = config()
  master.gain.setTargetAtTime(c.enabled ? Math.max(0, Math.min(1, Number(c.volume) || 0)) : 0, ctx.currentTime, 0.02)
}

function ensure () {
  if (ctx) return ctx
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return null
  try {
    ctx = new AC()
    master = ctx.createGain()
    master.gain.value = config().enabled ? (Number(config().volume) || 0) : 0
    /* 限幅器：一串铃叠加时避免爆音 */
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -10
    limiter.knee.value = 12
    limiter.ratio.value = 8
    master.connect(limiter)
    limiter.connect(ctx.destination)
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  } catch {
    ctx = null
    master = null
  }
  return ctx
}

export function play (name, delaySec = 0) {
  const cfg = config()
  if (!cfg.enabled || !BUILDERS[name]) return false
  const c = ensure()
  if (!c || !master) return false
  try {
    BUILDERS[name](c, c.currentTime + Math.max(0, delaySec), master)
    scheduled.push({ name, at: Date.now() })
    if (scheduled.length > 200) scheduled.shift()
    return true
  } catch {
    return false
  }
}

/* 启动动画专属：单独关掉「启动动画」开关时，连收场飞行与落地也不该响 */
export function playStartup (name) {
  const cfg = config()
  if (!cfg.enabled || !cfg.startup) return false
  return play(name)
}

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/* 启动节拍：三声都在彗星航程内；Logo 飞到左上角的收场不触发任何音效 */
export function startSplashScore (originTs) {
  const cfg = config()
  if (!cfg.enabled || !cfg.startup || reduced()) return []
  if (!ensure()) return []
  const elapsed = Math.max(0, performance.now() - (Number(originTs) || performance.now()))
  const out = []
  for (const [ms, name] of SCORE) {
    const delay = ms - elapsed
    if (delay < -120) continue
    setTimeout(() => playStartup(name), Math.max(0, delay))
    out.push({ name, ms, delay: Math.max(0, Math.round(delay)) })
  }
  return out
}

export function debug () {
  return {
    ctxState: ctx ? ctx.state : 'none',
    scheduled: scheduled.slice(),
    names: SFX_NAMES.slice(),
    config: config()
  }
}

/* 只保证无用户手势时音频上下文可用；不订阅任何界面事件，不产生额外声音 */
export function mountSfx () {
  ensure()
  const resume = () => {
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {})
  }
  addEventListener('pointerdown', resume, { once: true })
  addEventListener('keydown', resume, { once: true })
  bus.on('sfx:changed', applyVolume)
}
