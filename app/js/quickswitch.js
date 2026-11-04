/* quickswitch.js — 右侧会话快切：悬停把手弹出全部会话，点一下就切过去。
   只做“看与切”两件事：不复制 projects.js 的切换逻辑，也不接管新建流程。 */

import { state, bus, h, $, normalizeConversationMode } from './core.js'
import { switchProject } from './projects.js'
import { openNewConversationDialog } from './newconversation.js'

const MODE_ORDER = [
  ['team', '团队会话'],
  ['solo', '单独会话'],
  ['plugin', '插件制作']
]

function modeOf (project) {
  return normalizeConversationMode(
    project && project.conversationMode,
    project && project.workMode === 'team' ? 'team' : 'solo'
  )
}

function relTime (ts) {
  const time = Number(ts) || 0
  if (!time) return ''
  const diff = Date.now() - time
  if (diff < 0) return '刚刚'
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  const date = new Date(time)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

export function mountQuickSwitch () {
  if ($('#qs-root')) return null

  let open = false
  let showTimer = 0
  let hideTimer = 0

  const countEl = h('small', { class: 'qs-count', text: '0' })
  const listEl = h('div', { class: 'qs-list' })

  const panel = h('div', {
    class: 'qs-panel',
    id: 'qs-panel',
    role: 'dialog',
    'aria-label': '快速切换会话'
  },
  h('div', { class: 'qs-head' },
    h('div', { class: 'qs-title' },
      h('span', { class: 'qs-title-text', text: '会话快切' }),
      countEl
    ),
    h('button', {
      class: 'qs-new',
      type: 'button',
      title: '新建会话',
      'aria-label': '新建会话',
      onclick: () => { setOpen(false); openNewConversationDialog() }
    }, '＋')
  ),
  listEl,
  h('div', { class: 'qs-foot', text: '点击切换 · Esc 关闭' })
  )

  const tab = h('button', {
    class: 'qs-tab',
    type: 'button',
    title: '快速切换会话',
    'aria-label': '快速切换会话',
    'aria-expanded': 'false',
    'aria-controls': 'qs-panel'
  },
  h('span', { class: 'qs-tab-label', text: '会话' }),
  h('i', { class: 'qs-chev', text: '‹' })
  )

  const root = h('div', { class: 'qs-root', id: 'qs-root' }, tab, panel)
  document.body.append(root)

  function render () {
    const projects = (state.projects || []).filter((project) => project && !project.archivedAt)
    countEl.textContent = String(projects.length)
    listEl.textContent = ''

    if (!projects.length) {
      listEl.append(h('div', { class: 'qs-empty', text: '还没有会话。点右上角 ＋ 新建一个。' }))
      return
    }

    for (const [mode, label] of MODE_ORDER) {
      const group = projects
        .filter((project) => modeOf(project) === mode)
        .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
      if (!group.length) continue
      listEl.append(h('div', { class: 'qs-group', text: label }))
      for (const project of group) {
        const active = project.id === state.activeProjectId
        listEl.append(h('button', {
          class: 'qs-row mode-' + mode + (active ? ' active' : ''),
          type: 'button',
          title: `${project.name || '未命名会话'}${project.rootPath ? ' · ' + project.rootPath : ''}`,
          dataset: { id: project.id },
          onclick: async () => {
            if (active) { setOpen(false); return }
            setOpen(false)
            await switchProject(project.id)
          }
        },
        h('i', { class: 'qs-dot' }),
        h('span', { class: 'qs-name', text: project.name || '未命名会话' }),
        h('span', { class: 'qs-time', text: active ? '当前' : relTime(project.updatedAt) })
        ))
      }
    }
  }

  function setOpen (next) {
    const value = Boolean(next)
    if (value === open) {
      if (value) render()
      return
    }
    open = value
    root.classList.toggle('open', open)
    tab.setAttribute('aria-expanded', open ? 'true' : 'false')
    if (open) {
      render()
      requestAnimationFrame(() => {
        const current = listEl.querySelector('.qs-row.active')
        if (current) current.scrollIntoView({ block: 'nearest' })
      })
    }
  }

  function openNow () {
    clearTimeout(showTimer)
    clearTimeout(hideTimer)
    setOpen(true)
  }

  function closeSoon () {
    clearTimeout(showTimer)
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => setOpen(false), 220)
  }

  /* 把手只负责“悬停等一小下”，避免鼠标划过去就闪一下；
     进了面板就取消关闭计时，移出再延时收起。 */
  tab.addEventListener('mouseenter', () => {
    clearTimeout(hideTimer)
    clearTimeout(showTimer)
    if (open) return
    showTimer = setTimeout(() => setOpen(true), 120)
  })
  tab.addEventListener('mouseleave', () => {
    if (!open) clearTimeout(showTimer)
    closeSoon()
  })
  tab.addEventListener('focus', openNow)
  panel.addEventListener('mouseenter', openNow)
  panel.addEventListener('mouseleave', closeSoon)
  tab.addEventListener('click', () => {
    if (open) setOpen(false)
    else openNow()
  })

  document.addEventListener('keydown', (event) => {
    if (!open || event.key !== 'Escape') return
    setOpen(false)
    tab.blur()
  })

  bus.on('project:changed', () => { if (open) render() })
  bus.on('projects:changed', () => { if (open) render() })

  render()
  return { open: () => setOpen(true), close: () => setOpen(false) }
}
