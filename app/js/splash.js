/* splash.js — 启动动画的收场控制

   动画本体是纯 CSS（index.html 里的 #splash），这里只负责三件事：
   1. 启动过程中更新状态文案；
   2. boot 完成后走「飞入品牌位」的衔接：流星从屏幕中心飞到左侧栏
      品牌标记的精确位置，背景与字标淡去，主界面从下方浮起；
   3. 启动失败时把错误留在 splash 上，不让它盖住 stream 里的报错。 */

import { mountSceneStars } from './scenestars.js'

/* 导出给音效组曲做时间轴对齐：CSS 动画从页面加载就开始，boot 读完配置才启动声音 */
export const shownAt = performance.now()
/* 彗星航程 1150ms + Logo 分层组装与字标扫光，完整播完约 3s，闪一下就消失会显得廉价 */
const MIN_VISIBLE = 3200
/* 收场飞行时长：与 .splash-meteor 的 transition 时长保持一致，快而不赶 */
const FLIGHT_MS = 520
const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let splashStars = null

/* 彗星最后一段要精准落进流星中心：CSS 只能写死 vw/vh，这里实测后写变量，
   同时把第二段尾迹线的终点校准到同一个点。 */
function aimComet () {
  const splash = document.getElementById('splash')
  const meteor = splash && splash.querySelector('.splash-meteor')
  if (!splash || !meteor) return
  const r = meteor.getBoundingClientRect()
  if (!r.width) return
  const cx = r.left + r.width / 2
  const cy = r.top + r.height / 2
  splash.style.setProperty('--comet-end-x', `${(cx - innerWidth / 2).toFixed(1)}px`)
  splash.style.setProperty('--comet-end-y', `${(cy - innerHeight / 2).toFixed(1)}px`)
  const t2 = splash.querySelector('.splash-trail .t2')
  if (t2) {
    t2.setAttribute('x2', `${(cx / innerWidth * 100).toFixed(2)}%`)
    t2.setAttribute('y2', `${(cy / innerHeight * 100).toFixed(2)}%`)
  }
}

/* 启动星野的星色也跟着主题走：从 --accent / --accent-2 / --fg-0 派生一组。
   以前固定用主界面那套冷调色板，非蓝色主题下会飘一片不属于它的星点。 */
function themeStarPalette () {
  const css = getComputedStyle(document.documentElement)
  const toRgb = (value, fallback) => {
    const text = String(value || '').trim()
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text)
    if (hex) {
      const raw = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1]
      return [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16))
    }
    const rgb = /rgba?\(([^)]+)\)/i.exec(text)
    if (rgb) return rgb[1].split(',').slice(0, 3).map((n) => Math.round(parseFloat(n)))
    return fallback
  }
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t))
  const accent = toRgb(css.getPropertyValue('--accent'), [139, 156, 255])
  const accent2 = toRgb(css.getPropertyValue('--accent-2'), [185, 139, 255])
  /* 浅色主题的 --fg-0 是深色（正文色），拿它调星色会变成一片黑点，改用白 */
  const light = document.body.classList.contains('theme-light')
  const base = light ? [255, 255, 255] : toRgb(css.getPropertyValue('--fg-0'), [242, 245, 255])
  return [
    mix(accent, base, 0.55),
    mix(accent2, base, 0.5),
    mix(accent, accent2, 0.5),
    mix(accent2, base, 0.15),
    mix(accent, base, 0.82)
  ]
}

function mountSplashStars () {
  const splash = document.getElementById('splash')
  const canvas = document.getElementById('splash-stars-canvas')
  if (!splash || !canvas || splashStars) return
  splashStars = mountSceneStars(canvas, { palette: themeStarPalette() })
  if (typeof canvas.__sceneStars === 'function') splash.classList.add('stars-live')
}

function destroySplashStars () {
  if (!splashStars) return
  splashStars.destroy()
  splashStars = null
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    mountSplashStars()
    aimComet()
  }, { once: true })
} else {
  mountSplashStars()
  aimComet()
}
/* 启动期间窗口被拖动/缩放时重新瞄准，彗星飞到一半才校准也来得及（终段 1s 后才开始） */
addEventListener('resize', aimComet)

export function setSplashStatus (text) {
  const el = document.getElementById('splash-status')
  if (el) el.textContent = text
}

export function failSplash (err) {
  const splash = document.getElementById('splash')
  if (!splash) return
  splash.classList.add('failed')
  setSplashStatus(`启动失败：${(err && err.message) || err}`)
}

export async function dismissSplash () {
  const splash = document.getElementById('splash')
  if (!splash) return

  /* boot 很快时也要让动画读完；boot 慢时这里不再额外等待 */
  const elapsed = performance.now() - shownAt
  const minVisible = REDUCED ? 500 : MIN_VISIBLE
  if (elapsed < minVisible) await sleep(minVisible - elapsed)

  setSplashStatus('就绪')

  if (REDUCED) {
    splash.classList.add('leaving')
    document.body.classList.remove('booting')
    await sleep(480)
    destroySplashStars()
    splash.remove()
    return
  }

  const meteor = splash.querySelector('.splash-meteor')
  const brand = document.querySelector('.brand-mark')

  splash.classList.add('leaving')
  document.body.classList.remove('booting')
  /* 收场：Logo 飞到左上角、落地交接都不发声 */
  if (meteor && brand) {
    /* 飞行期间藏住品牌位的图标：壳层正在淡入，不藏的话屏幕上会出现两个 Logo */
    document.body.classList.add('splash-flying')
    /* 入场动画 fill:forwards 会压住内联 transform，先摘掉；
       且必须在量起点之前摘——动画若停在 0%（scale .9）会把起点量小，落点跟着缩偏 */
    meteor.style.animation = 'none'
    const from = meteor.getBoundingClientRect()
    const to = brand.getBoundingClientRect()
    /* 此刻壳层还停在 booting 的 translateY 过渡上，量到的品牌位比最终位置
       低了这段位移；落点必须先扣掉，否则最后错开半个图标对不齐 */
    let ox = 0
    let oy = 0
    const shell = document.querySelector('.shell')
    if (shell) {
      try {
        const m = new DOMMatrixReadOnly(getComputedStyle(shell).transform)
        ox = m.m41 || 0
        oy = m.m42 || 0
      } catch { /* transform: none 时构造函数会抛错，视作无位移 */ }
    }
    const dx = to.left + to.width / 2 - ox - (from.left + from.width / 2)
    const dy = to.top + to.height / 2 - oy - (from.top + from.height / 2)
    const scale = to.width / from.width
    requestAnimationFrame(() => {
      meteor.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${scale.toFixed(3)})`
    })
    await sleep(FLIGHT_MS)
    /* 流星已精确落在品牌位，此刻揭开品牌图标：两个完全重合，
       随后品牌位播放一段轻快的入场动画完成交接 */
    document.body.classList.remove('splash-flying')
    document.body.classList.add('brand-in')
    await sleep(140)
  } else {
    document.body.classList.add('brand-in')
    await sleep(620)
  }
  destroySplashStars()
  splash.remove()
}
