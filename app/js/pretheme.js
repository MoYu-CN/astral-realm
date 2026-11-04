/* pretheme.js — 首帧前预置上次生效的主题
 *
 * 为什么需要它：
 * 1. 主题 token 由主进程 boot 后才注入，而启动动画从页面加载就开始播，
 *    中间这段时间只能吃 tokens.css 的默认值（深空）。
 * 2. 插件主题（如「星砂」）要等 splash 结束、插件加载后才注册，
 *    启动时 currentTheme() 查不到就回退到 themes[0]，整个动画都在用深空的色。
 *
 * 所以由 effects.js 每次 applyTheme 时把生效的 token 写进 localStorage，
 * 这里在本文件被同步加载的瞬间抢先写到 :root，启动动画第一帧就是用户选的配色。
 * 这是纯预置：boot 完成后 applyTheme 会再写一遍，值不同会被纠正。
 */
(function () {
  var KEY = 'astral.theme.snapshot'
  try {
    var raw = localStorage.getItem(KEY)
    if (!raw) return
    var data = JSON.parse(raw)
    if (!data || !data.tokens) return
    var root = document.documentElement
    Object.keys(data.tokens).forEach(function (key) {
      if (key.indexOf('--') !== 0) return
      var value = data.tokens[key]
      if (typeof value === 'string' && value) root.style.setProperty(key, value)
    })
    if (data.id && document.body) document.body.dataset.theme = data.id
    if (data.light && document.body) document.body.classList.add('theme-light')
    /* 留个标记，便于自检确认它确实在 boot 之前跑过 */
    root.dataset.pretheme = String(data.id || '1')
  } catch (err) {
    /* 缓存损坏或被禁用时静默跳过，按默认主题启动即可 */
  }
})()
