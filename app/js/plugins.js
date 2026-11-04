/* plugins.js — 插件清单、权限、设置与可卸载生命周期
 *
 * 外部插件不受来源限制：放在 config/plugins 的第三方插件可以正常加载。
 * 唯一限制的是「旧版运行时」：
 *   isolated —— 无同源权限的 iframe 沙箱，唯一支持的运行时；
 *   legacy   —— 旧版渲染层运行时已限制，不再执行，面板只显示迁移提示。
 *
 * 隔离插件的 UI 常驻在一个固定的 surface 容器里；dock 切换面板只移动槽位，
 * 不移动 iframe，避免 iframe 被反复插入 DOM 导致重载、状态丢失与钩子重复注册。
 */

import { state, bus, toast, h, persist, activeProject } from './core.js'
import { applyTheme, currentTheme } from './effects.js'

const hooks = new Map()
const dockPanes = new Map()
const loaded = new Map()

let stylesPromise = null

export function pluginEnabled (manifest) {
  const setting = state.settings.plugins && state.settings.plugins[manifest.id]
  if (setting && typeof setting.enabled === 'boolean') return setting.enabled
  return manifest.defaultEnabled !== false
}

export function setPluginEnabled (manifest, enabled) {
  if (!state.settings.plugins) state.settings.plugins = {}
  state.settings.plugins[manifest.id] = {
    ...(state.settings.plugins[manifest.id] || {}),
    enabled: Boolean(enabled)
  }
  persist.settings()
}

export function pluginConfig (manifest) {
  const stored = state.settings.plugins?.[manifest.id]?.config || {}
  const config = { ...stored }
  for (const field of manifest.settings || []) {
    if (config[field.key] === undefined) config[field.key] = field.default
  }
  return config
}

export function savePluginSettings (manifest, patch = {}) {
  if (!state.settings.plugins) state.settings.plugins = {}
  const current = state.settings.plugins[manifest.id] || {}
  const config = { ...pluginConfig(manifest), ...(patch || {}) }
  state.settings.plugins[manifest.id] = { ...current, config }
  persist.settings()
  if (window.astral && typeof window.astral.saveConfig === 'function') {
    window.astral.saveConfig('settings.json', state.settings).catch(() => {})
  }
  bus.emit('plugin:settings:changed', { id: manifest.id, config: { ...config } })
  return config
}

/* 仅用于插件面板展示；旧版运行时本身已经不可加载。 */
export function isLegacyRuntime (manifest) {
  return Boolean(manifest) && manifest.runtime !== 'isolated'
}

function permissionsOf (manifest) {
  return Array.isArray(manifest.permissions) ? manifest.permissions : ['*']
}

function hasPermission (manifest, permission) {
  const list = permissionsOf(manifest)
  return list.includes('*') || list.includes(permission)
}

function requirePermission (manifest, permission) {
  if (!hasPermission(manifest, permission)) {
    throw new Error(`插件「${manifest.id}」未声明 ${permission} 权限`)
  }
}

export function pluginDockPanes () {
  return [...dockPanes.values()].sort((a, b) => (a.order || 100) - (b.order || 100))
}

export function registerDockPane (pane, pluginId) {
  if (!pane || !pane.id || typeof pane.render !== 'function') throw new Error('ui.registerDockPane 需要 id 与 render')
  dockPanes.set(pane.id, {
    id: pane.id,
    label: pane.label || pane.id,
    order: Number(pane.order) || 100,
    render: pane.render,
    pluginId
  })
  bus.emit('dock:panes:changed')
  return () => {
    if (!dockPanes.has(pane.id)) return
    dockPanes.delete(pane.id)
    bus.emit('dock:panes:changed')
  }
}

export function addHook (event, fn) {
  if (!hooks.has(event)) hooks.set(event, new Set())
  hooks.get(event).add(fn)
  return () => hooks.get(event).delete(fn)
}

export async function runHook (event, payload) {
  const set = hooks.get(event)
  if (!set || !set.size) return payload
  let current = payload
  for (const fn of [...set]) {
    try {
      const out = await fn(current)
      if (out !== undefined && out !== null) current = out
    } catch (err) {
      console.error(`[hook:${event}]`, err)
    }
  }
  return current
}

function createApi (manifest, track) {
  const api = {
    version: state.version,
    manifest,
    log: (...args) => console.log(`%c[${manifest.id}]`, 'color:#8b9cff', ...args),
    bus,
    h,
    getState: () => state,
    toast,
    on (event, fn) {
      requirePermission(manifest, 'hooks')
      const dispose = addHook(event, fn)
      track(dispose)
      return dispose
    },
    ui: {
      registerDockPane (pane) {
        requirePermission(manifest, 'ui.dock')
        const dispose = registerDockPane(pane, manifest.id)
        track(dispose)
        return dispose
      }
    },
    settings: {
      get () {
        requirePermission(manifest, 'settings')
        return pluginConfig(manifest)
      },
      set (patch) {
        requirePermission(manifest, 'settings')
        return savePluginSettings(manifest, patch)
      },
      onChange (fn) {
        requirePermission(manifest, 'settings')
        const listener = (event) => {
          if (event && event.id === manifest.id) fn(event.config || {})
        }
        bus.on('plugin:settings:changed', listener)
        track(() => bus.off('plugin:settings:changed', listener))
      }
    },
    skills: {
      register ({ id, name, desc = '', body = '' }) {
        requirePermission(manifest, 'skills')
        if (!id || !body) throw new Error('skills.register 需要 id 与 body')
        if (state.skills.some((s) => s.id === id)) return
        state.skills.push({ id, name: name || id, desc, body, builtin: false, from: manifest.id })
        track(() => {
          const index = state.skills.findIndex((skill) => skill.id === id && skill.from === manifest.id)
          if (index >= 0) state.skills.splice(index, 1)
        })
      }
    },
    themes: {
      register (theme) {
        requirePermission(manifest, 'themes')
        if (!theme || !theme.id) throw new Error('themes.register 需要 id')
        const index = state.themes.findIndex((t) => t.id === theme.id)
        const previous = index >= 0 ? state.themes[index] : null
        if (index >= 0) state.themes[index] = theme
        else state.themes.push(theme)
        /* 插件主题注册晚于 boot 的 applyTheme：如果用户选的正是这套主题，
           boot 时会因查不到而回退到别的主题，这里注册完成立即纠正。 */
        if (state.settings.theme === theme.id) applyTheme(theme, state.settings)
        track(() => {
          const current = state.themes.findIndex((t) => t.id === theme.id)
          if (current < 0) return
          if (previous) state.themes[current] = previous
          else state.themes.splice(current, 1)
          /* 卸载的正是当前主题：回退到现有主题，别让界面挂在残留 token 上。 */
          if (state.settings.theme === theme.id && !state.themes.some((t) => t.id === theme.id)) {
            applyTheme(currentTheme(), state.settings)
          }
        })
      }
    },
    messages: {
      inject (text, kind = 'system') {
        requirePermission(manifest, 'messages')
        bus.emit('message:add', {
          id: `plugin_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          kind,
          text: String(text),
          ts: Date.now(),
          streaming: false,
          error: false
        })
      }
    }
  }
  return api
}

/* -------------------------------------------------- 隔离插件宿主 */

function themeVarsText () {
  try {
    const cs = getComputedStyle(document.documentElement)
    const vars = []
    for (let i = 0; i < cs.length; i++) {
      const name = cs[i]
      if (!name.startsWith('--')) continue
      vars.push(`${name}:${cs.getPropertyValue(name)};`)
    }
    return vars.length ? `:root{${vars.join('')}}` : ''
  } catch {
    return ''
  }
}

/* tokens.css 提供全局重置与变量，app.css 提供组件类；两者都注入后，
 * 插件面板的外观与主界面一致。只抓一次，多个插件共用。 */
function loadUiStyles () {
  if (!stylesPromise) {
    stylesPromise = Promise.all([
      fetch('astral://app/css/tokens.css').then((res) => res.text()).catch(() => ''),
      fetch('astral://app/css/app.css').then((res) => res.text()).catch(() => '')
    ]).then(([tokens, app]) => `${tokens}\n${app}`)
  }
  return stylesPromise
}

function projectSnapshot () {
  const project = activeProject()
  return {
    id: project ? project.id : '',
    name: project ? project.name || '未命名项目' : '默认项目'
  }
}

function hideSurface (entry) {
  if (!entry.surface) return
  entry.surface.style.display = 'none'
  entry.surface.style.pointerEvents = 'none'
}

function positionSurface (entry) {
  if (!entry.surface) return
  if (entry.sheet) {
    entry.surface.style.display = 'block'
    entry.surface.style.left = '0px'
    entry.surface.style.top = '0px'
    entry.surface.style.width = '100vw'
    entry.surface.style.height = '100vh'
    entry.surface.style.zIndex = '45'
    entry.surface.style.pointerEvents = 'auto'
    return
  }
  /* dock-swap 动画期间 slot 的 rect 是 3D 变换后的临时值，不能用来定位；
     等动画结束后再量，避免 surface 覆盖标签栏或点击区域错位。 */
  const dockBody = document.querySelector('#dock-body')
  if (dockBody && dockBody.classList.contains('dock-swap')) {
    if (entry.swapTimer) return
    entry.swapTimer = setTimeout(() => {
      entry.swapTimer = 0
      positionSurface(entry)
    }, 480)
    return
  }
  const slot = entry.slot
  if (!slot || !slot.isConnected || !entry.paneVisible || document.body.classList.contains('dock-collapsed')) {
    hideSurface(entry)
    return
  }
  const rect = slot.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) {
    hideSurface(entry)
    return
  }
  entry.surface.style.display = 'block'
  entry.surface.style.left = `${Math.round(rect.left)}px`
  entry.surface.style.top = `${Math.round(rect.top)}px`
  entry.surface.style.width = `${Math.round(rect.width)}px`
  entry.surface.style.height = `${Math.round(rect.height)}px`
  entry.surface.style.zIndex = '30'
  entry.surface.style.pointerEvents = 'auto'
}

function schedulePosition (entry) {
  if (entry.positionRaf) return
  entry.positionRaf = requestAnimationFrame(() => {
    entry.positionRaf = 0
    positionSurface(entry)
  })
}

function playPaneAnimation (entry) {
  if (!entry.surface) return
  entry.surface.classList.remove('pane-enter')
  void entry.surface.offsetWidth
  entry.surface.classList.add('pane-enter')
  if (entry.paneAnimTimer) clearTimeout(entry.paneAnimTimer)
  entry.paneAnimTimer = setTimeout(() => {
    entry.paneAnimTimer = 0
    if (entry.surface) entry.surface.classList.remove('pane-enter')
  }, 420)
}

async function loadIsolatedPlugin (manifest, entry, source, styles) {
  const channel = `iso_${manifest.id}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
  const config = pluginConfig(manifest)
  const track = (fn) => {
    if (typeof fn === 'function') entry.disposers.push(fn)
  }

  const pending = new Map()
  let seq = 0
  let iframe = null
  let slot = null
  let observer = null
  let settled = false
  let readyResolve
  let readyReject
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })

  const surface = document.createElement('div')
  surface.className = 'plugin-surface'
  surface.dataset.pluginId = manifest.id
  surface.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:30;display:none;overflow:hidden;pointer-events:none;background:transparent'
  iframe = document.createElement('iframe')
  iframe.setAttribute('sandbox', 'allow-scripts allow-modals')
  iframe.setAttribute('aria-label', `${manifest.name || manifest.id} 插件面板`)
  iframe.style.cssText = 'display:block;width:100%;height:100%;border:0;background:transparent'
  iframe.src = 'astral://app/plugin-host.html'
  surface.append(iframe)
  document.body.append(surface)
  entry.surface = surface
  entry.iframe = iframe
  entry.sheet = false
  entry.paneVisible = false

  const sendInit = () => {
    if (!iframe || !iframe.contentWindow) return
    try {
      iframe.contentWindow.postMessage({
        channel,
        kind: 'init',
        source,
        config,
        styles,
        styleText: themeVarsText(),
        project: projectSnapshot(),
        manifest: { id: manifest.id, name: manifest.name, version: manifest.version }
      }, '*')
    } catch (err) {
      if (!settled) {
        settled = true
        readyReject(new Error(`插件沙箱初始化失败：${err.message}`))
      }
    }
  }

  const ask = (event, payload) => new Promise((resolve, reject) => {
    if (!iframe || !iframe.contentWindow) {
      reject(new Error('插件沙箱不可用'))
      return
    }
    const id = `h${++seq}`
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('插件钩子超时'))
    }, 15000)
    pending.set(id, { resolve, reject, timer })
    iframe.contentWindow.postMessage({ channel, kind: 'hook', id, event, payload }, '*')
  })

  const reply = (id, result, error) => {
    if (!iframe || !iframe.contentWindow) return
    const payload = { channel, kind: 'request-result', id }
    if (error !== undefined) payload.error = String(error)
    else payload.result = result
    iframe.contentWindow.postMessage(payload, '*')
  }

  const postActivePane = (id) => {
    if (!iframe || !iframe.contentWindow) return
    /* 宿主侧 pane key 是「插件id:面板id」，沙箱里注册的 id 只有「面板id」；
       发给 iframe 前必须还原成插件内部 id，否则 iframe 永远匹配不到并保持 hidden。 */
    const raw = String(id || '')
    const inner = raw.startsWith(`${manifest.id}:`) ? raw.slice(manifest.id.length + 1) : raw
    iframe.contentWindow.postMessage({ channel, kind: 'pane-active', id: inner }, '*')
  }

  const mountSlot = (paneKey) => (host) => {
    if (slot) slot.remove()
    slot = document.createElement('div')
    slot.className = 'plugin-pane-slot'
    slot.style.cssText = 'flex:1 1 auto;min-height:0;width:100%'
    host.append(slot)
    entry.slot = slot
    entry.paneVisible = true
    entry.activePane = paneKey
    postActivePane(paneKey)
    /* dock-swap 动画开始前先按最终布局定位，动画结束后再校准；
       立即定位可以避免等 480ms 期间出现空白和“卡一下”。 */
    positionSurface(entry)
    playPaneAnimation(entry)
    if (!observer) observer = new ResizeObserver(() => schedulePosition(entry))
    observer.disconnect()
    observer.observe(slot)
    schedulePosition(entry)
  }

  const onMessage = async (event) => {
    if (!iframe || event.source !== iframe.contentWindow) return
    const data = event.data
    if (!data || data.channel !== channel) return
    if (data.kind === 'ready') {
      if (settled) return
      settled = true
      readyResolve()
      return
    }
    if (data.kind === 'error') {
      if (settled) return
      settled = true
      readyReject(new Error(String(data.error || '插件沙箱启动失败')))
      return
    }
    if (data.kind === 'hook-result') {
      const item = pending.get(data.id)
      if (!item) return
      clearTimeout(item.timer)
      pending.delete(data.id)
      item.resolve(data.result)
      return
    }
    if (data.kind === 'sheet') {
      entry.sheet = Boolean(data.open)
      schedulePosition(entry)
      return
    }
    if (data.kind === 'knowledge' || data.kind === 'knowledge-pick-dir' || data.kind === 'clipboard' || data.kind === 'settings-set') {
      try {
        let result
        if (data.kind === 'knowledge-pick-dir') {
          requirePermission(manifest, 'knowledge')
          result = await window.astral.pickKnowledgeDir()
        } else if (data.kind === 'knowledge') {
          requirePermission(manifest, 'knowledge')
          const project = activeProject()
          result = await window.astral.knowledgeCall({
            action: data.action,
            args: data.args || {},
            project: {
              projectId: (project && project.id) || 'default',
              projectName: (project && project.name) || '默认项目',
              projectRoot: (project && project.rootPath) || ''
            }
          })
        } else if (data.kind === 'clipboard') {
          requirePermission(manifest, 'clipboard')
          result = await window.astral.writeClipboard(String(data.text ?? ''))
        } else {
          requirePermission(manifest, 'settings')
          result = savePluginSettings(manifest, data.patch || {})
        }
        reply(data.id, result)
      } catch (err) {
        reply(data.id, undefined, err.message || String(err))
      }
      return
    }
    if (data.kind === 'submit') {
      try {
        requirePermission(manifest, 'chat')
        if (!window.Astral || typeof window.Astral.submit !== 'function') throw new Error('主界面尚未就绪')
        const text = String(data.text || '')
        if (!text.trim()) throw new Error('提交内容不能为空')
        window.Astral.submit(text)
      } catch (err) {
        toast(`插件提交失败：${err.message || String(err)}`, 'err')
      }
      return
    }
    try {
      if (data.kind === 'theme') api.themes.register(data.theme)
      else if (data.kind === 'skill') api.skills.register(data.skill)
      else if (data.kind === 'message') api.messages.inject(data.text, data.messageKind === 'agent' ? 'agent' : 'system')
      else if (data.kind === 'toast') toast(String(data.text || ''))
      else if (data.kind === 'log') console.log(`%c[${manifest.id}:sandbox]`, 'color:#8b9cff', ...(data.args || []))
      else if (data.kind === 'subscribe') {
        requirePermission(manifest, 'hooks')
        const eventName = String(data.event || '')
        const dispose = addHook(eventName, async (payload) => ask(eventName, payload))
        track(dispose)
      } else if (data.kind === 'pane') {
        requirePermission(manifest, 'ui.dock')
        const pane = data.pane || {}
        if (!pane.id) return
        const paneKey = `${manifest.id}:${pane.id}`
        const previous = entry.paneDisposers.get(paneKey)
        if (previous) {
          try { previous() } catch { /* ignore */ }
          entry.paneDisposers.delete(paneKey)
        }
        entry.paneKeys.add(paneKey)
        const dispose = registerDockPane({
          id: paneKey,
          label: pane.label || manifest.name,
          order: Number(pane.order) || 100,
          render: mountSlot(paneKey)
        }, manifest.id)
        entry.paneDisposers.set(paneKey, dispose)
        track(dispose)
        /* 插件可能在自动打开面板之后才注册 pane；注册完成时补发当前激活面板，
           否则 iframe 里的 pane 会一直保持 hidden。 */
        if (entry.activePane === paneKey) postActivePane(paneKey)
      } else if (data.kind === 'pane-remove') {
        const paneKey = `${manifest.id}:${data.id}`
        const dispose = entry.paneDisposers.get(paneKey)
        if (!dispose) return
        try { dispose() } catch { /* ignore */ }
        entry.paneDisposers.delete(paneKey)
        entry.paneKeys.delete(paneKey)
        if (entry.activePane === paneKey) {
          entry.activePane = ''
          entry.paneVisible = false
          hideSurface(entry)
        }
      } else if (data.kind === 'pane-visible') {
        /* 沙箱确认某个面板已经显示；测试和调试可据此判断 iframe 不是空白。 */
        if (entry.surface) entry.surface.dataset.activePane = String(data.id || '')
        entry.paneVisible = true
      }
    } catch (err) {
      console.error(`[${manifest.id}:sandbox]`, err)
    }
  }

  const api = createApi(manifest, track)

  const onSettings = (event) => {
    if (!iframe || !iframe.contentWindow || !event || event.id !== manifest.id) return
    iframe.contentWindow.postMessage({ channel, kind: 'settings', config: event.config || {} }, '*')
  }

  const onProject = () => {
    if (!iframe || !iframe.contentWindow) return
    iframe.contentWindow.postMessage({ channel, kind: 'project', project: projectSnapshot() }, '*')
  }

  const onTheme = () => {
    if (!iframe || !iframe.contentWindow) return
    iframe.contentWindow.postMessage({ channel, kind: 'style', styleText: themeVarsText() }, '*')
  }

  const onDockPane = (name) => {
    if (!entry.paneKeys.has(name)) {
      entry.paneVisible = false
      if (!entry.sheet) hideSurface(entry)
      return
    }
    entry.paneVisible = true
    entry.activePane = name
    postActivePane(name)
    schedulePosition(entry)
    /* dock-body 有 440ms 的 dock-swap 3D 动画；动画期间 getBoundingClientRect
       是变换后的尺寸，直接定位会让 surface 偏移并挡住标签栏。等动画结束再量一次。 */
    setTimeout(() => schedulePosition(entry), 480)
  }

  const onResize = () => schedulePosition(entry)

  iframe.addEventListener('load', sendInit)
  window.addEventListener('message', onMessage)
  window.addEventListener('resize', onResize)
  bus.on('plugin:settings:changed', onSettings)
  bus.on('project:changed', onProject)
  bus.on('theme:applied', onTheme)
  bus.on('dock:pane:changed', onDockPane)
  track(() => window.removeEventListener('message', onMessage))
  track(() => window.removeEventListener('resize', onResize))
  track(() => bus.off('plugin:settings:changed', onSettings))
  track(() => bus.off('project:changed', onProject))
  track(() => bus.off('theme:applied', onTheme))
  track(() => bus.off('dock:pane:changed', onDockPane))

  entry.cleanup = () => {
    settled = true
    if (readyReject) readyReject(new Error('插件已卸载'))
    for (const [id, item] of pending) {
      clearTimeout(item.timer)
      item.reject(new Error('插件已卸载'))
      pending.delete(id)
    }
    if (entry.positionRaf) cancelAnimationFrame(entry.positionRaf)
    entry.positionRaf = 0
    if (entry.paneAnimTimer) clearTimeout(entry.paneAnimTimer)
    entry.paneAnimTimer = 0
    if (entry.swapTimer) clearTimeout(entry.swapTimer)
    entry.swapTimer = 0
    if (observer) observer.disconnect()
    observer = null
    if (slot) slot.remove()
    slot = null
    entry.slot = null
    if (iframe) iframe.remove()
    if (surface) surface.remove()
    entry.iframe = null
    entry.surface = null
  }

  setTimeout(sendInit, 600)
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true
      readyReject(new Error('插件沙箱启动超时'))
    }
  }, 8000)
  try {
    await ready
  } finally {
    clearTimeout(timer)
  }
  return { ok: true, api }
}

/* -------------------------------------------------- 生命周期 */

async function loadOne (manifest) {
  if (loaded.has(manifest.id)) return { ok: true }
  if (manifest.manifestError) {
    manifest.error = manifest.manifestError
    manifest.loaded = false
    manifest.disabled = true
    return { ok: false, error: manifest.manifestError }
  }
  if (manifest.runtime !== 'isolated') {
    /* 防御性检查：主进程已把旧版 manifest 标成 manifestError，这里不执行任何动态 import。 */
    const message = '旧版插件运行时已限制：请改用 runtime: "isolated"（外部插件使用 isolated 不受限制）'
    manifest.loaded = false
    manifest.disabled = true
    manifest.error = message
    return { ok: false, error: message }
  }
  const entry = { disposers: [], cleanup: null, api: null, surface: null, iframe: null, slot: null, activePane: '', paneVisible: false, paneKeys: new Set(), paneDisposers: new Map() }
  loaded.set(manifest.id, entry)
  try {
    const source = await (await fetch(manifest.entryUrl)).text()
    const styles = await loadUiStyles()
    await loadIsolatedPlugin(manifest, entry, source, styles)
    manifest.loaded = true
    manifest.disabled = false
    manifest.error = ''
    return { ok: true }
  } catch (err) {
    try {
      if (entry.cleanup) await entry.cleanup()
      for (const dispose of entry.disposers.reverse()) {
        try { dispose() } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    loaded.delete(manifest.id)
    manifest.loaded = false
    manifest.error = err.message || String(err)
    return { ok: false, error: manifest.error }
  }
}

async function unloadOne (manifest) {
  const entry = loaded.get(manifest.id)
  if (!entry) {
    manifest.loaded = false
    return { ok: true }
  }
  const errors = []
  try {
    if (entry.cleanup) await entry.cleanup()
  } catch (err) {
    errors.push(err.message || String(err))
  }
  for (const dispose of entry.disposers.reverse()) {
    try { dispose() } catch (err) { errors.push(err.message || String(err)) }
  }
  loaded.delete(manifest.id)
  manifest.loaded = false
  manifest.disabled = true
  if (errors.length) manifest.error = errors.join('；')
  return { ok: errors.length === 0, error: errors.join('；') }
}

export async function setPluginEnabledLive (manifest, enabled) {
  setPluginEnabled(manifest, enabled)
  if (window.astral && typeof window.astral.saveConfig === 'function') {
    window.astral.saveConfig('settings.json', state.settings).catch(() => {})
  }
  const result = enabled ? await loadOne(manifest) : await unloadOne(manifest)
  bus.emit('plugins:changed')
  return result
}

export async function loadPlugins () {
  for (const manifest of state.plugins) {
    if (!pluginEnabled(manifest)) {
      manifest.loaded = false
      manifest.disabled = true
      manifest.error = manifest.manifestError || ''
      continue
    }
    if (manifest.manifestError) {
      manifest.loaded = false
      manifest.disabled = true
      manifest.error = manifest.manifestError
      continue
    }
    manifest.disabled = false
    await loadOne(manifest)
  }
  bus.emit('plugins:changed')
}
