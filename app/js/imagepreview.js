/* imagepreview.js — 对话图片缩略图、Markdown 图片增强与全屏预览
 *
 * 本地图片经主进程 readFilePreview 转成 data URL；https 图片直接交给 img。
 * 所有图片入口（用户附件、工具截图、AI Markdown）共用这里的缩略图与预览弹层。
 */

import { h, toast } from './core.js'
import { openModal, closeModal } from './modal.js'

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|svg)(?:[?#].*)?$/i
const imageCache = new Map()
const MAX_CACHE = 40

export function isImageFile (fileOrPath, name = '') {
  if (fileOrPath && typeof fileOrPath === 'object') {
    return IMAGE_RE.test(String(fileOrPath.path || fileOrPath.name || fileOrPath.src || ''))
  }
  return IMAGE_RE.test(String(fileOrPath || name || ''))
}

function fileUrlToPath (raw) {
  try {
    const url = new URL(raw)
    let pathname = decodeURIComponent(url.pathname || '')
    if (url.hostname) pathname = `//${url.hostname}${pathname}`
    if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1)
    return pathname.replace(/\//g, '\\')
  } catch {
    return ''
  }
}

export function resolveImageSource (input) {
  if (input && typeof input === 'object' && !(input instanceof Node)) {
    if (input.dataUrl) return { kind: 'data', dataUrl: String(input.dataUrl), path: input.path || '', url: '' }
    if (input.url) return { kind: 'url', url: String(input.url), path: '', dataUrl: '' }
    if (input.path) return resolveImageSource(input.path)
    if (input.src) return resolveImageSource(input.src)
  }

  const raw = String(input || '').trim()
  if (!raw) return { kind: 'error', error: '图片地址为空', path: '', url: '', dataUrl: '' }
  if (/^data:image\//i.test(raw)) return { kind: 'data', dataUrl: raw, path: '', url: '' }
  if (/^https:\/\//i.test(raw)) return { kind: 'url', url: raw, path: '', dataUrl: '' }
  if (/^http:\/\//i.test(raw)) return { kind: 'http', url: raw, path: '', dataUrl: '' }
  if (/^file:\/\//i.test(raw)) {
    const path = fileUrlToPath(raw)
    return path ? { kind: 'path', path, url: '', dataUrl: '' } : { kind: 'error', error: '文件路径无效', path: '', url: '', dataUrl: '' }
  }
  if (/^astral:\/\//i.test(raw)) return { kind: 'url', url: raw, path: '', dataUrl: '' }
  return { kind: 'path', path: raw, url: '', dataUrl: '' }
}

function cacheImage (key, value) {
  if (!key) return
  if (imageCache.has(key)) imageCache.delete(key)
  imageCache.set(key, value)
  while (imageCache.size > MAX_CACHE) imageCache.delete(imageCache.keys().next().value)
}

export async function loadImageSource (input) {
  const source = resolveImageSource(input)
  if (source.kind === 'data') return { ok: true, dataUrl: source.dataUrl, url: '', path: '', size: 0 }
  if (source.kind === 'url') return { ok: true, dataUrl: '', url: source.url, path: '', size: 0 }
  if (source.kind === 'http') return { ok: false, error: '仅支持 https 图片链接', path: source.url }
  if (source.kind === 'error') return { ok: false, error: source.error, path: '' }

  const path = source.path
  if (imageCache.has(path)) return imageCache.get(path)
  if (!window.astral || !window.astral.readFilePreview) {
    return { ok: false, error: '当前环境不支持本地图片预览', path }
  }
  let result
  try {
    result = await window.astral.readFilePreview({ path })
  } catch (err) {
    result = { ok: false, error: err.message }
  }
  if (!result || result.ok === false) {
    return { ok: false, error: (result && result.error) || '图片读取失败', path }
  }
  if (result.kind !== 'image' || !result.dataUrl) {
    return { ok: false, error: '这个文件不是可预览的图片', path }
  }
  const value = { ok: true, dataUrl: result.dataUrl, url: '', path: result.path || path, size: result.size || 0 }
  cacheImage(path, value)
  return value
}

/* 供用户附件、工具结果、Markdown 图片复用的小缩略图。 */
export function createImageThumb (input, opts = {}) {
  const source = resolveImageSource(input)
  const alt = opts.alt || opts.caption || '图片'
  const label = opts.caption || alt
  const button = h('button', {
    type: 'button',
    class: 'image-thumb' + (opts.className ? ` ${opts.className}` : ''),
    title: source.path || source.url || alt,
    'aria-label': `预览图片 ${alt}`
  })
  const state = h('span', { class: 'image-thumb-state', text: '图片' })
  button.append(state)

  button.addEventListener('click', (event) => {
    event.stopPropagation()
    openImagePreview(input, { alt, caption: label })
  })
  button.addEventListener('dblclick', (event) => event.stopPropagation())

  loadImageSource(input).then((result) => {
    if (!button.isConnected) return
    if (!result.ok) {
      button.classList.add('error')
      state.textContent = '无法预览'
      button.title = result.error || '图片无法加载'
      return
    }
    button.textContent = ''
    const img = h('img', {
      alt,
      src: result.dataUrl || result.url,
      loading: 'lazy',
      referrerpolicy: 'no-referrer'
    })
    img.addEventListener('error', () => {
      button.classList.add('error')
      button.textContent = ''
      button.append(h('span', { class: 'image-thumb-state', text: '无法预览' }))
    })
    button.append(img)
    if (label) button.append(h('span', { class: 'image-thumb-caption', text: label }))
    button.classList.add('loaded')
  })

  return button
}

function imageButton (result, alt) {
  const img = h('img', {
    class: 'image-preview-full',
    alt,
    src: result.dataUrl || result.url,
    referrerpolicy: 'no-referrer'
  })
  img.addEventListener('click', () => img.classList.toggle('zoomed'))
  img.addEventListener('error', () => {
    img.replaceWith(h('div', { class: 'image-preview-error', text: '图片加载失败，可能已被移动或删除。' }))
  })
  return img
}

export function openImagePreview (input, opts = {}) {
  const alt = opts.alt || opts.caption || '图片预览'
  const source = resolveImageSource(input)
  const sub = source.path || source.url || ''
  const modal = openModal({
    title: alt,
    sub,
    width: 960,
    render: (body) => {
      const stage = h('div', { class: 'image-preview-stage' },
        h('div', { class: 'image-preview-loading', text: '正在加载图片…' })
      )
      const meta = h('div', { class: 'image-preview-meta' })
      const actions = h('div', { class: 'image-preview-actions' })

      const close = () => closeModal()
      actions.append(
        h('button', {
          class: 'btn ghost',
          type: 'button',
          onclick: () => close()
        }, '关闭')
      )

      if (source.kind === 'path') {
        actions.prepend(
          h('button', {
            class: 'btn ghost',
            type: 'button',
            onclick: async () => {
              const res = await window.astral.openFile(source.path)
              if (res && res.ok === false) toast(res.error || '打开失败', 'err')
            }
          }, '用系统程序打开'),
          h('button', {
            class: 'btn ghost',
            type: 'button',
            onclick: () => {
              navigator.clipboard && navigator.clipboard.writeText(source.path)
              toast('图片路径已复制', 'ok')
            }
          }, '复制路径')
        )
      } else if (source.url) {
        actions.prepend(h('button', {
          class: 'btn ghost',
          type: 'button',
          onclick: () => {
            navigator.clipboard && navigator.clipboard.writeText(source.url)
            toast('图片链接已复制', 'ok')
          }
        }, '复制链接'))
      }

      body.append(stage, meta, actions)

      loadImageSource(input).then((result) => {
        if (!body.isConnected) return
        if (!result.ok) {
          stage.textContent = ''
          stage.append(h('div', { class: 'image-preview-error', text: result.error || '图片加载失败' }))
          return
        }
        stage.textContent = ''
        stage.append(imageButton(result, alt))
        meta.textContent = result.path
          ? `${result.path}${result.size ? ` · ${(result.size / 1024).toFixed(0)}KB` : ''}`
          : (source.url ? '远程图片' : '')
      })
    }
  })
  return modal
}

/* 把 core.md() 生成的 <span class="md-image" data-src> 占位换成真实图片。 */
export function enhanceMarkdownImages (root) {
  if (!root) return
  for (const holder of root.querySelectorAll('.md-image[data-src]')) {
    if (holder.dataset.enhanced === '1' || holder.dataset.enhancing === '1') continue
    holder.dataset.enhancing = '1'
    const src = holder.dataset.src || ''
    const alt = holder.dataset.alt || '图片'
    loadImageSource(src).then((result) => {
      if (!holder.isConnected) return
      holder.dataset.enhancing = ''
      if (!result.ok) {
        holder.classList.add('error')
        holder.textContent = '图片无法加载'
        holder.title = result.error || '图片无法加载'
        return
      }
      holder.dataset.enhanced = '1'
      holder.classList.add('loaded')
      holder.textContent = ''
      holder.append(imageButton(result, alt))
      holder.addEventListener('click', (event) => {
        event.stopPropagation()
        openImagePreview(src, { alt })
      })
      holder.addEventListener('dblclick', (event) => event.stopPropagation())
      holder.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          openImagePreview(src, { alt })
        }
      })
    })
  }
}
