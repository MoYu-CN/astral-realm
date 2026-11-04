/* activity.js — 窗口是否真的在前台

   托盘常驻模式下，窗口收起后 Chromium 仍把页面当成 visible，
   rAF 会照着 60fps 继续画星空、极光和粒子，后台白烧一整个核。
   主进程在 show/hide/minimize/restore 时广播真实状态，这里统一收口：
   动画模块据此暂停绘制，定时器与网络请求不受影响（backgroundThrottling:false）。 */

let active = typeof document === 'undefined' ? true : !document.hidden
const listeners = new Set()

export function windowActive () {
  return active
}

export function onWindowActivity (handler) {
  if (typeof handler !== 'function') return () => {}
  listeners.add(handler)
  return () => listeners.delete(handler)
}

function apply (next) {
  const value = Boolean(next)
  if (value === active) return
  active = value
  document.documentElement.classList.toggle('window-idle', !active)
  for (const handler of listeners) {
    try {
      handler(active)
    } catch (err) {
      console.error('[activity]', err)
    }
  }
}

/* 浏览器自身的可见性变化（例如系统锁屏）也并入同一套状态 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) apply(false)
  else apply(true)
})

if (window.astral && typeof window.astral.onWindowActivity === 'function') {
  window.astral.onWindowActivity((value) => apply(value))
}
