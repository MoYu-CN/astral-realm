/* filepreview.js — 文件预览（渲染进右侧预览栏）

   读接口走主进程 astral:readFilePreview：
   - 图片 → data URL
   - 文本 → 512KB 截断
   - HTML → astral://preview 沙箱托管（同目录相对资源可加载）
   这里只负责把内容画进给定容器，容器由 dock.js 提供。 */

import { h } from './core.js'

export function baseName (p) {
  const text = String(p || '').trim()
  const parts = text.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : text
}

function sizeText (bytes) {
  const n = Number(bytes || 0)
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

function iconBtn (label, title, onclick) {
  return h('button', { class: 'preview-btn', type: 'button', title, onclick }, label)
}

function errorBox (text) {
  return h('div', { class: 'preview-error' }, text)
}

/**
 * 把某个文件渲染进 host。
 * @param {HTMLElement} host 预览容器（会被清空）
 * @param {string} target 文件路径
 * @param {{ onClose?: Function }} opts
 */
export async function renderPreview (host, target, opts = {}) {
  const targetPath = String(target || '').trim()
  host.textContent = ''

  const actions = h('div', { class: 'preview-actions' })
  const body = h('div', { class: 'preview-body' })
  host.append(
    h('div', { class: 'preview-head' },
      h('div', { class: 'preview-title' },
        h('span', { class: 'preview-name', text: baseName(targetPath) }),
        h('span', { class: 'preview-path', text: targetPath, title: targetPath })
      ),
      actions
    ),
    body
  )

  actions.append(iconBtn('系统打开', '用系统程序打开', () => window.astral.openFile(targetPath)))
  if (opts.onClose) actions.append(iconBtn('✕', '关闭预览', opts.onClose))

  if (!targetPath) {
    body.append(errorBox('没有指定文件'))
    return
  }
  if (!window.astral.readFilePreview) {
    body.append(errorBox('当前环境不支持文件预览'))
    return
  }

  body.append(h('div', { class: 'preview-loading' }, h('i', { class: 'spin' }), h('span', { text: '正在读取…' })))

  const res = await window.astral.readFilePreview({ path: targetPath }).catch(() => null)
  body.textContent = ''

  if (!res || res.ok === false) {
    body.append(errorBox(`无法预览：${(res && res.error) || '读取失败'}`))
    return
  }

  if (res.kind === 'image') {
    body.append(h('img', { class: 'preview-image', src: res.dataUrl, alt: baseName(targetPath) }))
  } else if (res.kind === 'html') {
    /* 沙箱：脚本能跑出网页效果，但拿不到应用的 window / 存储 */
    const frame = h('iframe', {
      class: 'preview-frame',
      src: res.url,
      sandbox: 'allow-scripts allow-forms allow-modals allow-popups',
      referrerpolicy: 'no-referrer'
    })
    body.classList.add('html-mode')
    body.append(frame)
    actions.prepend(iconBtn('刷新', '重新加载页面', () => {
      frame.src = `${res.url}?t=${Date.now()}`
    }))
  } else {
    body.append(h('pre', { class: 'preview-text', text: res.text || '（空文件）' }))
  }

  body.append(h('div', { class: 'preview-foot' },
    h('span', {
      class: 'preview-meta',
      text: `${sizeText(res.size)}${res.truncated ? ' · 仅显示前 512KB' : ''}`
    })
  ))
}
