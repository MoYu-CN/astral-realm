/* scenestars.js — 任务轨迹面板内的局部星野

   与主界面 fx-stars 共用同一套星色与视差手感，但这里刻意不做整体旋转：
   星点在面板矩形内随机散布，各自以不同的速度与方向缓慢漂移；亮度用逐颗
   独立的相位与频率闪烁，互不同步。接近边缘时淡出、在随机位置淡入重生，
   所以既没有同步循环，也看不出接缝或重复的图案。
   鼠标在面板附近移动时，整片星野按深度产生几像素的视差偏移，离开后缓归。 */

import { PALETTE } from './effects.js'
import { onWindowActivity, windowActive } from './activity.js'

const lerp = (a, b, t) => a + (b - a) * t

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

export function mountSceneStars (canvas, options = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') return { destroy () {} }
  const ctx = canvas.getContext('2d')
  if (!ctx) return { destroy () {} }

  /* 星色默认用主界面那套冷调色板；启动动画会传一套主题色进来 */
  const palette = Array.isArray(options.palette) && options.palette.length ? options.palette : PALETTE

  let w = 0
  let h = 0
  let dpr = 1
  let stars = []
  let raf = 0
  let lastT = 0
  let alive = true
  let accent = [139, 156, 255]
  const pointer = { x: 0, y: 0 }
  const target = { x: 0, y: 0 }

  const rand = (a, b) => a + Math.random() * (b - a)

  function spawn (initial) {
    const z = Math.random()
    /* 漂移方向完全随机、速度逐颗不同：没有统一的旋转或流向 */
    const ang = Math.random() * Math.PI * 2
    const speed = rand(1.2, 4.2) * (0.4 + z * 0.9)
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed,
      z,
      r: 0.35 + z * 1.2,
      base: rand(0.14, 0.4) + z * 0.34,
      phase: Math.random() * Math.PI * 2,
      tw: rand(0.00016, 0.00058),
      color: palette[(Math.random() * palette.length) | 0],
      /* 一半偏主题色、一半偏自身色相，和主界面一致 */
      tint: Math.random() < 0.5 ? rand(0.2, 0.9) : rand(0, 0.18),
      fade: initial ? 1 : 0,
      rise: initial ? 0 : rand(0.5, 1.4)
    }
  }

  function seed () {
    const count = Math.max(24, Math.min(150, Math.round((w * h) / 2400)))
    stars = Array.from({ length: count }, () => spawn(true))
  }

  function resize () {
    const rect = canvas.getBoundingClientRect()
    const nw = Math.round(rect.width)
    const nh = Math.round(rect.height)
    if (!nw || !nh) {
      w = 0
      h = 0
      return false
    }
    if (nw === w && nh === h) return true
    w = nw
    h = nh
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    seed()
    return true
  }

  function draw (t) {
    if (!alive || paused) return
    raf = requestAnimationFrame(draw)
    if (!w || !h || document.hidden) {
      lastT = t
      return
    }

    const dt = Math.min(48, Math.max(0, t - lastT)) / 1000
    lastT = t
    const reduced = document.body.classList.contains('reduced-motion')
    const step = reduced ? 0 : dt

    accent = toRgb(getComputedStyle(document.documentElement).getPropertyValue('--accent'), accent)

    /* 视差缓动：停手不生硬，指针离开面板范围后缓缓归位 */
    const ease = Math.min(1, dt * 3.2)
    pointer.x = lerp(pointer.x, reduced ? 0 : target.x, ease)
    pointer.y = lerp(pointer.y, reduced ? 0 : target.y, ease)

    ctx.clearRect(0, 0, w, h)

    for (let i = 0; i < stars.length; i++) {
      const s = stars[i]

      s.x += s.vx * step
      s.y += s.vy * step

      /* 越界一个边距后换个随机位置带淡入重生，杜绝整片回卷的痕迹 */
      if (s.x < -30 || s.x > w + 30 || s.y < -30 || s.y > h + 30) {
        stars[i] = spawn(false)
        continue
      }
      if (s.fade < 1) s.fade = Math.min(1, s.fade + step / s.rise)

      /* 靠近边缘时自然变暗，避免星点在边框处硬切 */
      const edge = Math.min(s.x, w - s.x, s.y, h - s.y)
      const edgeAlpha = edge < 42 ? Math.max(0, edge / 42) : 1

      const px = s.x + pointer.x * (4 + s.z * 12)
      const py = s.y + pointer.y * (4 + s.z * 12)
      const twinkle = 0.5 + 0.5 * Math.sin(t * s.tw + s.phase)
      const alpha = Math.min(1, s.base * (0.45 + twinkle * 0.85) * s.fade * edgeAlpha)

      ctx.beginPath()
      ctx.fillStyle = blend(accent, s.color, s.tint)
      ctx.globalAlpha = alpha
      ctx.arc(px, py, s.r, 0, Math.PI * 2)
      ctx.fill()

      /* 少量近处星点带一层很淡的柔光，拉开层次 */
      if (s.z > 0.82) {
        ctx.globalAlpha = alpha * 0.16
        ctx.beginPath()
        ctx.arc(px, py, s.r * 4.5, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1
  }

  function onPointer (event) {
    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) {
      target.x = 0
      target.y = 0
      return
    }
    const nx = (event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2)
    const ny = (event.clientY - (rect.top + rect.height / 2)) / (rect.height / 2)
    /* 指针离面板太远就不参与，避免整个窗口都在晃 */
    if (Math.abs(nx) > 1.6 || Math.abs(ny) > 1.6) {
      target.x = 0
      target.y = 0
      return
    }
    target.x = Math.max(-1.2, Math.min(1.2, nx))
    target.y = Math.max(-1.2, Math.min(1.2, ny))
  }

  resize()
  lastT = performance.now()
  let paused = false
  if (windowActive()) raf = requestAnimationFrame(draw)
  else paused = true

  window.addEventListener('pointermove', onPointer, { passive: true })
  window.addEventListener('resize', resize)

  /* 收起窗口时不画帧；恢复时从当前时间重新计时，避免 dt 跳变 */
  const offActivity = onWindowActivity((activeNow) => {
    if (!alive) return
    if (!activeNow) {
      paused = true
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      return
    }
    if (!paused) return
    paused = false
    if (!raf) {
      lastT = performance.now()
      raf = requestAnimationFrame(draw)
    }
  })

  const observer = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => { resize() })
    : null
  if (observer) observer.observe(canvas)

  /* 调试/自检用：读取当前星点位置，验证有漂移且无整体旋转 */
  canvas.__sceneStars = () => stars.map((s) => ({ x: Math.round(s.x), y: Math.round(s.y), z: Number(s.z.toFixed(2)) }))

  return {
    destroy () {
      alive = false
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      offActivity()
      window.removeEventListener('pointermove', onPointer)
      window.removeEventListener('resize', resize)
      if (observer) observer.disconnect()
      delete canvas.__sceneStars
    }
  }
}
