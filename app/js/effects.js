/* effects.js — 主题注入与星野背景 */

import { state, bus } from './core.js'
import { onWindowActivity, windowActive } from './activity.js'

export function currentTheme () {
  return state.themes.find((t) => t.id === (state.settings.theme || 'astral')) || state.themes[0] || null
}

/* 主题快照：pretheme.js 与本文件共用同一个 key（那个是同步脚本，不能 import） */
const THEME_CACHE_KEY = 'astral.theme.snapshot'

function readThemeCache () {
  try {
    const data = JSON.parse(localStorage.getItem(THEME_CACHE_KEY) || 'null')
    if (!data || !data.tokens) return null
    return data
  } catch {
    return null
  }
}

/* 启动专用解析：插件主题要等插件加载后才注册，而插件在 splash 之后才跑。
   pretheme.js 已经把上次生效的 token 预置到 :root，这里沿用同一份快照，
   否则 applyTheme 会在启动动画中途把它改回默认主题——紫蓝一闪就是这么来的。
   插件注册完成后，plugins.js 会立刻用正式主题对象重新 applyTheme。 */
export function bootTheme () {
  const id = state.settings.theme || 'astral'
  const found = state.themes.find((t) => t.id === id)
  if (found) return found
  const cached = readThemeCache()
  if (cached && cached.id === id) {
    return {
      id: cached.id,
      name: cached.id,
      desc: '',
      fromCache: true,
      tokens: cached.tokens,
      light: Boolean(cached.light),
      art: cached.art || null,
      motion: cached.motion || null
    }
  }
  return state.themes[0] || null
}

export function effectiveArt () {
  const theme = currentTheme()
  const base = (theme && theme.art) || { starfield: true, aurora: true, grain: true }
  return { ...base, ...(state.settings.appearance || {}) }
}

/* 上一套主题写进 :root 的内联变量。切换主题时必须先清掉，
   否则 A（浅色，显式覆盖 surface/line/plane）→ B（只带核心 token）会把
   A 的残留值压在 B 的底色上，出现两套主题混合。 */
let appliedTokenKeys = []

/* 把生效的主题写进 localStorage，供 js/pretheme.js 在下次启动首帧前预置。
   插件主题比 splash 注册得晚，只有缓存下来，启动动画才能用上它的配色。 */
function cacheTheme (theme) {
  if (!theme || !theme.tokens) return
  try {
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({
      id: theme.id,
      light: Boolean(theme.light),
      tokens: theme.tokens,
      art: theme.art || null,
      motion: theme.motion || null
    }))
  } catch { /* 存储不可用不影响主题生效 */ }
}

export function applyTheme (theme = currentTheme(), settings = state.settings) {
  const root = document.documentElement
  for (const key of appliedTokenKeys) root.style.removeProperty(key)
  appliedTokenKeys = []
  if (theme && theme.tokens) {
    for (const [key, value] of Object.entries(theme.tokens)) {
      root.style.setProperty(key, value)
      appliedTokenKeys.push(key)
    }
  }
  if (theme && theme.id) document.body.dataset.theme = theme.id
  /* 浅色主题：CSS 侧有一块 body.theme-light 补丁，把写死的白色高光翻成深色 */
  document.body.classList.toggle('theme-light', Boolean(theme && theme.light))
  cacheTheme(theme)

  const art = effectiveArt()
  document.body.classList.toggle('no-stars', art.starfield === false)
  document.body.classList.toggle('no-aurora', art.aurora === false)
  document.body.classList.toggle('no-grain', art.grain === false)
  document.body.classList.toggle('reduced-motion', Boolean(art.reducedMotion))

  const speed = (settings && settings.motion && settings.motion.speed) ||
    (theme && theme.motion && theme.motion.speed) || 1
  root.style.setProperty('--speed', String(speed))

  if (art.starfield === false) stopStars()
  else startStars(art.reducedMotion ? 0 : speed)

  /* 隔离插件的 iframe 共享同一套主题变量；换主题时把新变量推给它们。 */
  bus.emit('theme:applied', theme)
}

/* ---------------------------------------------------------- starfield */

/* 星野配色：鼠标掠过时逐颗点亮，颜色从这套色板里取，冷调为主、少量暖色点缀 */
export const PALETTE = [
  [150, 190, 255], // 冰蓝
  [104, 240, 214], // 薄荷青
  [255, 194, 108], // 暖金
  [255, 132, 166], // 玫瑰
  [190, 148, 255], // 薰衣草
  [255, 236, 178]  // 米金
]

let canvas = null
let ctx = null
let rafId = null
let stars = []
let size = { w: 0, h: 0, dpr: 1 }
let pointer = { x: 0, y: 0 }
let cursor = { x: -9999, y: -9999, inside: false }
let drift = 1
let bound = false
let lastT = 0
let angle = 0
let accentRgb = [139, 156, 255]
let running = false
let pausedByHide = false

function toRgb (value, fallback) {
  const text = String(value || '').trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text)
  if (hex) {
    const raw = hex[1].length === 3
      ? hex[1].split('').map((c) => c + c).join('')
      : hex[1]
    return [parseInt(raw.slice(0, 2), 16), parseInt(raw.slice(2, 4), 16), parseInt(raw.slice(4, 6), 16)]
  }
  const rgb = /rgba?\(([^)]+)\)/i.exec(text)
  if (rgb) {
    const parts = rgb[1].split(',').map((n) => parseFloat(n))
    if (parts.length >= 3) return parts.slice(0, 3).map((n) => Math.round(n))
  }
  return fallback
}

function blend (a, b, t) {
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`
}

function seed () {
  /* 星星撒在「覆盖整个视口的外接圆」内：
     旋转时任何角度都不会露出空白角落，也不需要跨边界回收 */
  const radius = Math.hypot(size.w, size.h) / 2 + 30
  const count = Math.min(520, Math.round((Math.PI * radius * radius) / 6000))

  stars = Array.from({ length: count }, () => {
    const z = Math.random()
    return {
      rad: Math.sqrt(Math.random()) * radius,
      ang: Math.random() * Math.PI * 2,
      z,
      r: 0.35 + z * 1.15,
      phase: Math.random() * Math.PI * 2,
      speed: 0.35 + z * 0.9,
      color: PALETTE[(Math.random() * PALETTE.length) | 0],
      wake: 0
    }
  })
}

function resize () {
  if (!canvas) return
  size.dpr = Math.min(window.devicePixelRatio || 1, 2)
  size.w = canvas.clientWidth || window.innerWidth
  size.h = canvas.clientHeight || window.innerHeight
  canvas.width = Math.floor(size.w * size.dpr)
  canvas.height = Math.floor(size.h * size.dpr)
  if (ctx) ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0)
  seed()
}

function frame (t) {
  /* 收起窗口后可能还有一帧在路上，这里二次确认，避免循环被重新点着 */
  if (!ctx || pausedByHide || !windowActive()) return

  const dt = Math.min(64, t - lastT) / 1000
  lastT = t

  ctx.clearRect(0, 0, size.w, size.h)
  accentRgb = toRgb(style().accent, accentRgb)

  const cx = size.w / 2
  const cy = size.h / 2

  /* 星空转速：0 = 静止，越大整片星野绕中心转得越快（rad/s） */
  const spinSpeed = Number((state.settings.appearance || {}).starSpin ?? 0.25)
  if (spinSpeed > 0 && drift > 0) angle += spinSpeed * dt

  for (const star of stars) {
    if (drift > 0) star.ang += star.speed * 0.004 * drift * dt * 60

    const a = star.ang + angle
    const baseX = cx + Math.cos(a) * star.rad
    const baseY = cy + Math.sin(a) * star.rad

    const depth = 6 + star.z * 18
    const px = baseX + pointer.x * depth
    const py = baseY + pointer.y * depth

    /* 指针扰动：近处星星苏醒，颜色从主题色过渡到自己的色相 */
    let target = 0
    if (cursor.inside) {
      const dx = px - cursor.x
      const dy = py - cursor.y
      const dist = Math.hypot(dx, dy)
      const influence = 220
      if (dist < influence) target = 1 - dist / influence
    }
    star.wake += (target - star.wake) * Math.min(1, dt * (target > star.wake ? 9 : 0.95))

    const twinkle = 0.42 + 0.58 * Math.abs(Math.sin(t * 0.00042 * star.speed + star.phase))
    const alpha = Math.min(1, twinkle * (0.22 + star.z * 0.7) + star.wake * 0.85)

    /* 颜色快速切到自身色相：线性慢混会经过灰区，看起来发脏 */
    const tint = Math.min(1, star.wake * 2.4)

    ctx.beginPath()
    ctx.fillStyle = blend(accentRgb, star.color, tint)
    ctx.globalAlpha = alpha
    ctx.arc(px, py, star.r * (1 + star.wake * 0.6), 0, Math.PI * 2)
    ctx.fill()

    /* 被点亮的星星加一圈同色柔光 */
    if (star.wake > 0.05) {
      ctx.beginPath()
      ctx.fillStyle = blend(accentRgb, star.color, Math.min(1, star.wake * 3))
      ctx.globalAlpha = star.wake * 0.2
      ctx.arc(px, py, star.r * 4, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  ctx.globalAlpha = 1
  rafId = requestAnimationFrame(frame)
}

function style () {
  const cs = getComputedStyle(document.documentElement)
  return {
    accent: cs.getPropertyValue('--accent').trim() || '#8b9cff',
    accent2: cs.getPropertyValue('--accent-2').trim() || '#b98bff'
  }
}

export function startStars (speed = 1) {
  running = true
  drift = speed
  if (rafId) return
  canvas = document.getElementById('fx-stars')
  if (!canvas) return
  ctx = canvas.getContext('2d')
  resize()
  lastT = performance.now()
  if (windowActive()) rafId = requestAnimationFrame(frame)
  else pausedByHide = true

  if (bound) return
  bound = true

  window.addEventListener('resize', resize)

  window.addEventListener('pointermove', (e) => {
    pointer.x = (e.clientX / window.innerWidth - 0.5) * 2
    pointer.y = (e.clientY / window.innerHeight - 0.5) * 2
    cursor.x = e.clientX
    cursor.y = e.clientY
    cursor.inside = true
  }, { passive: true })

  window.addEventListener('pointerleave', () => { cursor.inside = false })
  document.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget) cursor.inside = false
  })

  window.__astralFx = () => ({ angle, stars: stars.length })
}

export function stopStars () {
  running = false
  pausedByHide = false
  if (rafId) cancelAnimationFrame(rafId)
  rafId = null
  if (ctx) ctx.clearRect(0, 0, size.w, size.h)
}

/* 窗口收起/最小化时彻底停帧，回来再点火；定时器不受影响 */
onWindowActivity((activeNow) => {
  if (!activeNow) {
    pausedByHide = true
    if (rafId) cancelAnimationFrame(rafId)
    rafId = null
    return
  }
  if (!pausedByHide) return
  pausedByHide = false
  if (!running || rafId || !canvas || !ctx) return
  lastT = performance.now()
  rafId = requestAnimationFrame(frame)
})
