/* newconversation.js — 新会话：模式 + 工作目录 + 团队
 *
 * 每个新会话都是一个独立项目记录，拥有自己的会话文件：
 *   - 单独对话：复制当前智能体为一个独立单聊会话；
 *   - 团队模式：复制当前项目团队，或使用一个团队模板；
 *   - 插件制作模式：复制当前智能体，使用插件专用提示词。
 * 创建新会话不会覆盖当前会话；左侧会话列表负责切换和归档。
 */

import {
  state, $, h, bus, toast, agentById, commander, activeProject,
  channelOf, normalizeConversationTitle, saveProjectSessionNow, saveProjectsNow, persist,
  conversationIsTeam
} from './core.js'
import { openModal, closeModal, field } from './modal.js'
import { setView } from './viewswitch.js'
import { createProject } from './projects.js'

const MODES = [
  { id: 'solo', name: '单独对话', desc: '只和当前助手直聊，不派单' },
  { id: 'team', name: '团队模式', desc: '套用团队模板或当前团队' },
  { id: 'plugin', name: '插件制作模式', desc: '使用插件官方提示词' }
]

function clone (value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

function currentAgent () {
  const selected = state.activeAgentId ? agentById(state.activeAgentId) : null
  if (selected) return selected
  const project = activeProject()
  if (project && project.soloAgentId) {
    const solo = agentById(project.soloAgentId)
    if (solo) return solo
  }
  return commander() ||
    ((state.roster && state.roster.agents) || []).find((agent) => agent && agent.enabled !== false) ||
    null
}

function conversationCount () {
  return (state.messages || []).filter((msg) => channelOf(msg) === 'user' &&
    msg.kind !== 'handoff' && msg.kind !== 'tool' && msg.kind !== 'system').length
}

function enabledTeam (project) {
  const roster = (project && project.roster) || state.roster || { agents: [] }
  return (roster.agents || []).filter((agent) => agent && agent.enabled !== false)
}

/* 默认团队优先取当前项目；当前是单聊时，取同工作目录里的团队；
   最后回退到任意一个仍有团队编制的会话，保证单聊里也能直接新建团队会话。 */
function defaultTeamRoster (project) {
  if (enabledTeam(project).length >= 2) return clone(project.roster)
  const rootPath = String((project && project.rootPath) || '')
  const sameRoot = state.projects
    .filter((item) => !item.archivedAt && item.id !== (project && project.id) &&
      String(item.rootPath || '') === rootPath && enabledTeam(item).length >= 2)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  if (sameRoot.length) return clone(sameRoot[0].roster)
  const fallback = state.projects
    .filter((item) => !item.archivedAt && item.id !== (project && project.id) && enabledTeam(item).length >= 2)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  return fallback.length ? clone(fallback[0].roster) : null
}

function teamChoiceLabel (choice, templates, project) {
  if (choice === '__default__') return `团队 · ${(project && project.name) || '默认'}`
  const template = templates.find((item) => item.id === choice)
  return template ? `团队 · ${template.name}` : '团队会话'
}

export function openNewConversationDialog (options = {}) {
  if (state.busy) {
    toast('协作进行中，等这一轮结束后再开新会话', 'err')
    return
  }
  if (state.view === 'agent') setView('user')

  const project = activeProject()
  const agent = currentAgent()
  const count = conversationCount()
  const templates = Array.isArray(state.teamTemplates) ? state.teamTemplates : []
  const defaultRoster = defaultTeamRoster(project)
  const defaultTeam = defaultRoster ? enabledTeam({ roster: defaultRoster }) : []
  const hasDefaultTeam = defaultTeam.length >= 2
  const requestedMode = options && (options.mode === 'team' || options.mode === 'plugin') ? options.mode : 'solo'
  let mode = requestedMode
  let teamChoice = hasDefaultTeam ? '__default__' : ((templates[0] && templates[0].id) || '__default__')
  let name = String(options && options.name ? options.name : '')
  let workDir = String(options && options.workDir ? options.workDir : (project && project.rootPath) || '')

  openModal({
    title: '新会话',
    sub: 'NEW CONVERSATION · 独立会话 · 工作目录 · 对话模式',
    width: 640,
    render: (body) => {
      const input = h('input', {
        class: 'input',
        maxlength: '60',
        value: name,
        placeholder: '留空则用你发送的第一句话命名',
        oninput: (e) => { name = e.target.value }
      })

      const workDirInput = h('input', {
        class: 'input',
        value: workDir,
        placeholder: '选择这个会话绑定的工作目录',
        oninput: (e) => { workDir = e.target.value }
      })
      const workDirPick = h('button', {
        class: 'btn ghost',
        type: 'button',
        onclick: async () => {
          if (!window.astral.pickFolder) return
          try {
            const picked = await window.astral.pickFolder()
            if (picked) {
              workDir = picked
              workDirInput.value = picked
            }
          } catch (err) {
            toast('选择工作目录失败：' + err.message, 'err')
          }
        }
      }, '选择文件夹')
      const workDirField = field('工作目录', h('div', { class: 'input-with-btn' }, workDirInput, workDirPick),
        '每个会话独立绑定一个工作目录；切换左侧会话即可切换上下文和工作目录。')

      const modeGrid = h('div', { class: 'newconvo-tabs newconvo-mode-grid' })
      const modeButtons = {}
      const teamSelect = h('select', { class: 'input' })
      if (hasDefaultTeam) {
        teamSelect.append(h('option', { value: '__default__' }, `当前团队 · ${defaultTeam.length} 人（默认）`))
      } else {
        teamSelect.append(h('option', { value: '__default__', disabled: 'disabled' }, '当前团队（不足 2 人）'))
      }
      for (const template of templates) {
        const countMembers = (template.members || []).length
        teamSelect.append(h('option', { value: template.id }, `${template.name} · ${countMembers} 人`))
      }
      teamSelect.value = teamChoice
      teamSelect.onchange = () => { teamChoice = teamSelect.value }

      const teamField = field('团队模板', teamSelect,
        '默认复制当前团队；也可以使用你在团队模板里保存的团队。')
      const teamEmpty = h('div', {
        class: 'hint newconvo-team-empty',
        text: '当前没有可用团队。请先在设置 → 团队模板里创建，或让当前项目至少有 2 名成员。'
      })
      const pluginNote = h('div', {
        class: 'newconvo-mode-note',
        text: '插件制作模式使用插件专用提示词，不套用团队；创建后不可在输入区临时切换。'
      })
      const nameField = field('会话名称（可选）', input, '单独会话和插件制作模式可以命名；团队会话不显示名称。')

      const submit = h('button', { class: 'btn-primary', type: 'button' })
      let creating = false

      function paintMode () {
        for (const item of MODES) {
          const button = modeButtons[item.id]
          if (!button) continue
          const active = mode === item.id
          button.classList.toggle('active', active)
          button.setAttribute('aria-pressed', String(active))
        }
        teamField.hidden = mode !== 'team'
        pluginNote.hidden = mode !== 'plugin'
        nameField.hidden = mode === 'team'
        teamEmpty.hidden = mode !== 'team' || hasDefaultTeam || templates.length > 0
        submit.textContent = mode === 'plugin'
          ? '创建插件会话'
          : mode === 'team'
            ? '创建团队会话'
            : '创建单独会话'
      }

      for (const item of MODES) {
        const button = h('button', {
          type: 'button',
          class: 'newconvo-tab',
          'aria-pressed': String(mode === item.id),
          onclick: () => {
            mode = item.id
            paintMode()
          }
        },
        h('b', { text: item.name }),
        h('span', { text: item.desc })
        )
        modeButtons[item.id] = button
        modeGrid.append(button)
      }

      submit.onclick = async () => {
        if (creating) return
        const rootPath = String(workDir || '').trim()
        if (!rootPath) {
          toast('请选择工作目录后再创建会话', 'err')
          workDirInput.focus()
          return
        }
        if (mode === 'team' && teamChoice === '__default__' && !hasDefaultTeam) {
          toast('团队模式至少需要 2 名可用成员', 'err')
          return
        }
        if (mode === 'team' && teamChoice !== '__default__') {
          const template = templates.find((item) => item.id === teamChoice)
          if (!template || !(template.members || []).length) {
            toast('该团队模板没有可用成员', 'err')
            return
          }
          if ((template.members || []).length < 2) {
            toast('团队模式至少需要 2 名成员，请换一个模板', 'err')
            return
          }
        }
        creating = true
        submit.disabled = true
        try {
          /* 先把当前会话与项目元数据落盘，再创建新项目；切换失败也不会丢旧会话。 */
          if (project) {
            await saveProjectSessionNow(project.id)
            await saveProjectsNow()
          }
          const cleanName = normalizeConversationTitle(name, 60)
          let projectName = ''
          let roster = null
          let templateId = ''
          let autoName = false

          if (mode === 'team') {
            projectName = teamChoiceLabel(teamChoice, templates, project)
            if (teamChoice === '__default__') {
              roster = clone(defaultRoster || (project && project.roster) || state.roster)
            } else {
              templateId = teamChoice
            }
          } else {
            projectName = cleanName || (mode === 'plugin' ? '新插件会话' : '新单独会话')
            autoName = !cleanName
            const baseAgent = agent ? clone(agent) : null
            if (baseAgent) {
              roster = {
                agents: [baseAgent],
                globalSkills: clone((project && project.roster && project.roster.globalSkills) || []),
                globalNotes: (project && project.roster && project.roster.globalNotes) || ''
              }
            } else {
              roster = clone((project && project.roster) || state.roster)
            }
          }

          const created = await createProject({
            name: projectName,
            rootPath,
            description: mode === 'plugin' ? '插件制作会话' : mode === 'team' ? '团队会话' : '单独会话',
            templateId,
            roster,
            workMode: mode === 'team' ? 'team' : 'solo',
            conversationMode: mode,
            autoName
          })
          if (!created) return

          if (mode !== 'team' && agent) {
            const target = (created.roster.agents || []).find((item) => item.name === agent.name) ||
              (created.roster.agents || [])[0]
            if (target) {
              created.soloAgentId = target.id
              state.activeAgentId = target.id
              bus.emit('active:agent', target.id)
            }
          }

          state.conversationMode = mode
          const title = mode === 'team' ? '' : cleanName
          state.conversationTitle = title
          bus.emit('conversation:title', title)
          bus.emit('conversation:mode', mode)
          persist.session()
          await saveProjectSessionNow()
          await saveProjectsNow()
          closeModal()
          setView('user')
          setTimeout(() => { const el = $('#input'); if (el) el.focus() }, 60)
          const label = mode === 'plugin' ? '插件制作会话' : mode === 'team' ? '团队会话' : '单独会话'
          toast(title ? `${label}「${title}」已创建` : `${label}已创建`, 'ok')
        } catch (err) {
          toast(`创建会话失败：${(err && err.message) || err}`, 'err')
        } finally {
          creating = false
          submit.disabled = false
        }
      }

      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        submit.click()
      })

      body.append(
        h('div', { class: 'newconvo-brief' },
          h('div', {},
            h('span', { class: 'newconvo-k', text: '当前会话' }),
            h('b', { text: project ? project.name : '未选择会话' })
          ),
          h('div', {},
            h('span', { class: 'newconvo-k', text: '智能体' }),
            h('b', { text: agent
              ? `${agent.name}${conversationIsTeam() && agent.title ? ` · ${agent.title}` : ''}`
              : '未绑定' })
          )
        ),
        workDirField,
        h('div', { class: 'label', text: '对话模式' }),
        modeGrid,
        teamField,
        teamEmpty,
        pluginNote,
        nameField,
        h('div', {
          class: 'newconvo-bounds',
          text: count
            ? `当前会话已有 ${count} 条消息；新会话会独立保存，不会覆盖当前会话。`
            : '当前会话还没有消息；新会话会独立保存。'
        }),
        h('div', { class: 'newconvo-actions' },
          h('button', { class: 'btn ghost', onclick: () => closeModal() }, '取消'),
          submit
        )
      )

      paintMode()
      setTimeout(() => { if (mode === 'team') submit.focus(); else workDirInput.focus() }, 80)
    }
  })
}
