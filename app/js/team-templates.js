/* team-templates.js — 自定义团队模板：保存、编辑、实例化 */

import { state, h, uid, persist, activeProject, toast, bus } from './core.js'
import { field } from './modal.js'
import { confirmAction } from './confirm.js'
import { applyDefaultPerms } from './permissions.js'
import { resolvePromptVars, PROMPT_VARS } from './llm.js'

export const TEMPLATE_ROLE_LABEL = { commander: '总指挥', deputy: '副指挥', executor: 'AI 成员' }
const ROLE_ORDER = ['commander', 'deputy', 'executor']

export function roleLabel (role) {
  return TEMPLATE_ROLE_LABEL[role] || TEMPLATE_ROLE_LABEL.executor
}

export function templateCounts (template) {
  const counts = { commander: 0, deputy: 0, executor: 0 }
  for (const m of (template && template.members) || []) counts[m.role] = (counts[m.role] || 0) + 1
  return counts
}

export function templateSummary (template) {
  if (!template) return '空白团队'
  const c = templateCounts(template)
  if (!template.members || !template.members.length) return '空白团队 · 不预置成员'
  const bits = []
  if (c.commander) bits.push(`总指挥 ${c.commander}`)
  if (c.deputy) bits.push(`副指挥 ${c.deputy}`)
  if (c.executor) bits.push(`AI 成员 ${c.executor}`)
  if (!c.commander && !c.deputy) bits.unshift('无指挥结构')
  return bits.join(' · ')
}

function emptyTemplate () {
  return {
    id: uid('tpl'),
    name: '新团队模板',
    description: '',
    globalSkills: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    members: []
  }
}

function newMember (members, role = 'executor') {
  const commander = members.find((m) => m.role === 'commander')
  const deputy = members.find((m) => m.role === 'deputy')
  return {
    id: uid('tmpl_member'),
    role,
    name: '新成员',
    short: '',
    title: roleLabel(role),
    duty: roleLabel(role),
    bio: '',
    glyph: '○',
    color: '#8b9cff',
    prompt: role === 'executor'
      ? '你是「{{name}}」，{{title}}。你负责：{{duty}}。接到任务后直接产出结果。'
      : '你是「{{name}}」，{{title}}。你负责：{{duty}}。判断目标、拆解任务，并把子任务交给合适的人。',
    skills: [],
    providerId: '',
    model: '',
    temperature: 0.7,
    reportsTo: role === 'deputy' ? (commander ? commander.id : null) : (role === 'executor' ? ((deputy || commander) ? (deputy || commander).id : null) : null)
  }
}

function inferReports (members) {
  const commander = members.find((m) => m.role === 'commander')
  const deputy = members.find((m) => m.role === 'deputy')
  for (const m of members) {
    if (m.role === 'commander') m.reportsTo = null
    if (m.reportsTo && !members.some((x) => x.id === m.reportsTo && x !== m)) m.reportsTo = null
    if (!m.reportsTo) {
      if (m.role === 'deputy' && commander) m.reportsTo = commander.id
      else if (m.role === 'executor') m.reportsTo = (deputy || commander) ? (deputy || commander).id : null
    }
  }
}

function cleanTemplate (draft) {
  const template = {
    id: draft.id || uid('tpl'),
    name: String(draft.name || '').trim() || '未命名团队模板',
    description: String(draft.description || '').trim(),
    globalSkills: [...(draft.globalSkills || [])],
    createdAt: draft.createdAt || Date.now(),
    updatedAt: Date.now(),
    members: (draft.members || []).map((m) => ({
      id: m.id || uid('tmpl_member'),
      role: ROLE_ORDER.includes(m.role) ? m.role : 'executor',
      name: String(m.name || '').trim() || '未命名成员',
      short: String(m.short || '').trim(),
      title: String(m.title || '').trim(),
      duty: String(m.duty || '').trim(),
      bio: String(m.bio || '').trim(),
      glyph: m.glyph || '○',
      color: m.color || '#8b9cff',
      prompt: String(m.prompt || ''),
      skills: [...(m.skills || [])],
      providerId: m.providerId || '',
      model: m.model || '',
      temperature: Number.isFinite(Number(m.temperature)) ? Number(m.temperature) : 0.7,
      reportsTo: m.reportsTo || null
    }))
  }
  inferReports(template.members)
  return template
}

export function snapshotActiveTeam () {
  const project = activeProject()
  const agents = (state.roster && state.roster.agents) || []
  const tplId = uid('tpl')
  const map = new Map()
  const members = agents.map((agent) => {
    const id = uid('tmpl_member')
    map.set(agent.id, id)
    return {
      id,
      role: ROLE_ORDER.includes(agent.role) ? agent.role : 'executor',
      name: agent.name || '成员',
      short: agent.short || '',
      title: agent.title || '',
      duty: agent.duty || '',
      bio: agent.bio || '',
      glyph: agent.glyph || '○',
      color: agent.color || '#8b9cff',
      prompt: agent.prompt || '',
      skills: [...(agent.skills || [])],
      providerId: agent.providerId || '',
      model: agent.model || '',
      temperature: Number(agent.temperature ?? 0.7),
      reportsTo: null,
      sourceAgentId: agent.id
    }
  })
  for (const member of members) {
    const source = agents.find((a) => a.id === member.sourceAgentId)
    member.reportsTo = source && source.reportsTo ? (map.get(source.reportsTo) || null) : null
  }
  for (const member of members) delete member.sourceAgentId
  return {
    id: tplId,
    name: `${(project && project.name) || '当前项目'} 团队`,
    description: '从当前项目团队保存的自定义模板',
    globalSkills: [...(state.roster.globalSkills || [])],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    members
  }
}

export function instantiateTemplate (template) {
  const sourceMembers = (template && template.members) || []
  const providers = (state.providers && state.providers.providers) || []
  const defaultProvider = providers[0] || null
  const ids = new Map()
  const agents = sourceMembers.map((member) => {
    const id = uid('agent')
    ids.set(member.id, id)
    const provider = providers.find((p) => p.id === member.providerId) || defaultProvider
    const agent = {
      id,
      name: member.name || '成员',
      title: member.title || roleLabel(member.role),
      role: ROLE_ORDER.includes(member.role) ? member.role : 'executor',
      reportsTo: null,
      glyph: member.glyph || '○',
      short: member.short || '',
      avatar: '',
      bio: member.bio || '',
      duty: member.duty || '',
      traits: [],
      traitNote: '',
      color: member.color || '#8b9cff',
      providerId: provider ? provider.id : (member.providerId || ''),
      model: member.model || ((provider && provider.models && provider.models[0]) || ''),
      temperature: Number.isFinite(Number(member.temperature)) ? Number(member.temperature) : 0.7,
      enabled: true,
      prompt: member.prompt || (member.role === 'executor'
        ? '你是一个可靠的执行者。接到任务后直接产出结果。'
        : '你负责判断目标、拆解任务，并把子任务交给合适的人。'),
      skills: [...(member.skills || [])],
      context: { notes: '', historyLimit: 16 }
    }
    applyDefaultPerms(agent)
    return agent
  })
  for (const agent of agents) {
    const source = sourceMembers.find((m) => ids.get(m.id) === agent.id)
    agent.reportsTo = source && source.reportsTo ? (ids.get(source.reportsTo) || null) : null
  }
  return {
    agents,
    globalSkills: [...((template && template.globalSkills) || [])],
    globalNotes: ''
  }
}

/* ---------------------------------------------------------- 设置页内嵌编辑器 */

export function renderTeamTemplates (body, options = {}) {
  const paintList = () => {
    body.textContent = ''
    body.append(
      h('div', { class: 'pane-title', text: '自定义团队模板' }),
      h('div', { class: 'hint', text: '模板是可复用的团队结构：可以包含总指挥、副指挥和 AI 成员，也可以只有 AI 成员。新建项目时选择一个模板，会复制出一份只属于该项目的成员。' }),
      h('div', { class: 'btn-row', style: { marginTop: '14px', flexWrap: 'wrap' } },
        h('button', { class: 'btn-primary', onclick: () => paintEditor(emptyTemplate(), true) }, '+ 新建空白模板'),
        h('button', { class: 'btn ghost', onclick: () => {
          if (!activeProject()) { toast('请先选择一个项目', 'err'); return }
          paintEditor(snapshotActiveTeam(), true)
        } }, '从当前项目保存模板'),
        options.onGenerate
          ? h('button', { class: 'btn ghost', onclick: options.onGenerate }, '从计划书生成')
          : null
      )
    )

    const list = h('div', { class: 'template-list' })
    if (!state.teamTemplates.length) {
      list.append(h('div', { class: 'template-empty' },
        h('div', { class: 'glyph' }, '◇'),
        h('b', { text: '还没有团队模板' }),
        h('span', { text: '新建一个空白模板，或把当前项目的团队保存下来复用。' })
      ))
    }
    for (const template of state.teamTemplates) {
      const members = template.members || []
      const models = [...new Set(members.map((m) => m.model).filter(Boolean))]
      list.append(h('div', { class: 'template-card' },
        h('div', { class: 'template-main' },
          h('div', { class: 'template-name', text: template.name }),
          h('div', { class: 'template-desc', text: template.description || '未填写说明' }),
          h('div', { class: 'template-summary', text: templateSummary(template) }),
          models.length
            ? h('div', { class: 'template-models', text: `模型：${models.join(' · ')}` })
            : null,
          h('div', { class: 'template-members' }, members.length
            ? members.map((m) => h('span', { class: 'template-chip' },
              h('i', { style: { background: m.color || 'var(--accent)' } }),
              `${m.name}${m.role === 'executor' ? '' : ` · ${roleLabel(m.role)}`}`))
            : [h('span', { class: 'hint', text: '空模板（创建后可添加成员）' })]
          )
        ),
        h('div', { class: 'template-actions' },
          h('button', { class: 'btn ghost', onclick: () => paintEditor(JSON.parse(JSON.stringify(template)), false) }, '编辑'),
          h('button', { class: 'btn ghost danger-text', onclick: async () => {
            const ok = await confirmAction({
              title: '删除团队模板？',
              message: `删除团队模板「${template.name}」？已经创建的项目不会受影响。`,
              confirmText: '删除',
              danger: true
            })
            if (!ok) return
            state.teamTemplates = state.teamTemplates.filter((t) => t.id !== template.id)
            persist.templates()
            bus.emit('templates:changed')
            toast('团队模板已删除')
            paintList()
          } }, '删除')
        )
      ))
    }
    body.append(list)
  }

  const paintEditor = (draft, isNew) => {
    body.textContent = ''
    const memberBox = h('div', { class: 'template-editor-members' })

    const paintMembers = () => {
      memberBox.textContent = ''
      if (!draft.members.length) {
        memberBox.append(h('div', { class: 'template-empty small' },
          h('span', { text: '模板里还没有成员。可以保存空模板，或添加成员。' })
        ))
      }
      draft.members.forEach((member, index) => {
        const refreshPreview = () => {
          const sample = {
            name: member.name,
            short: member.short,
            title: member.title,
            role: member.role,
            duty: member.duty,
            bio: member.bio,
            skills: member.skills || []
          }
          previewEl.textContent = resolvePromptVars(member.prompt || '', sample) || '（还没有填写提示词）'
        }

        const roleSelect = h('select', { class: 'select', onchange: (e) => {
          member.role = e.target.value
          if (!member.title || member.title === '总指挥' || member.title === '副指挥' || member.title === 'AI 成员' || member.title === '执行者') {
            member.title = roleLabel(member.role)
          }
          if (member.role === 'commander') member.reportsTo = null
          paintMembers()
        } },
        ...ROLE_ORDER.map((role) => h('option', { value: role, selected: member.role === role }, roleLabel(role))))

        const nameInput = h('input', { class: 'input', value: member.name || '', oninput: (e) => { member.name = e.target.value; refreshPreview() } })
        const shortInput = h('input', { class: 'input', maxlength: '6', value: member.short || '', placeholder: '消息里显示', oninput: (e) => { member.short = e.target.value; refreshPreview() } })
        const titleInput = h('input', { class: 'input', value: member.title || '', oninput: (e) => { member.title = e.target.value; refreshPreview() } })
        const dutyInput = h('input', { class: 'input', value: member.duty || '', placeholder: '例如：资料检索与事实核对', oninput: (e) => { member.duty = e.target.value; refreshPreview() } })

        const bioArea = h('textarea', { class: 'textarea', style: { minHeight: '54px' }, placeholder: '一句话介绍它：擅长什么、负责哪块、说话什么风格。', oninput: (e) => { member.bio = e.target.value; refreshPreview() } })
        bioArea.value = member.bio || ''

        const reportOptions = draft.members.filter((m) => m.id !== member.id)
        const reportSelect = h('select', { class: 'select', onchange: (e) => { member.reportsTo = e.target.value || null } },
          h('option', { value: '', selected: !member.reportsTo }, '无 / 不指定'),
          ...reportOptions.map((m) => h('option', { value: m.id, selected: member.reportsTo === m.id }, m.name || '未命名成员'))
        )

        const promptArea = h('textarea', { class: 'textarea', style: { minHeight: '86px' }, oninput: (e) => { member.prompt = e.target.value; refreshPreview() } })
        promptArea.value = member.prompt || ''

        const insertVar = (key) => {
          const token = `{{${key}}}`
          const start = promptArea.selectionStart ?? promptArea.value.length
          const end = promptArea.selectionEnd ?? start
          promptArea.value = promptArea.value.slice(0, start) + token + promptArea.value.slice(end)
          member.prompt = promptArea.value
          promptArea.focus()
          promptArea.selectionStart = promptArea.selectionEnd = start + token.length
          refreshPreview()
        }

        const varChips = h('div', { class: 'prompt-vars' },
          h('span', { class: 'prompt-vars-label', text: '插入变量' }),
          ...PROMPT_VARS.map((item) => h('button', {
            class: 'prompt-var',
            type: 'button',
            title: item.desc,
            onclick: () => insertVar(item.key)
          }, `{{${item.key}}}`))
        )

        const previewEl = h('pre', { class: 'prompt-preview' })

        const skillList = h('div', { class: 'trait-chips' })
        for (const skill of state.skills || []) {
          const on = (member.skills || []).includes(skill.id)
          skillList.append(h('button', {
            class: 'trait-chip' + (on ? ' on' : ''),
            type: 'button',
            onclick: (event) => {
              const set = new Set(member.skills || [])
              if (set.has(skill.id)) set.delete(skill.id)
              else set.add(skill.id)
              member.skills = [...set]
              event.currentTarget.classList.toggle('on')
            }
          }, skill.name))
        }
        if (!skillList.childElementCount) {
          skillList.append(h('span', { class: 'hint', text: '还没有可用技能文件（app/skills 或 config/skills）' }))
        }

        memberBox.append(h('div', { class: 'template-member-editor' },
          h('div', { class: 'template-member-head' },
            h('span', { class: 'template-member-index', text: String(index + 1).padStart(2, '0') }),
            h('span', { class: 'template-member-role', text: roleLabel(member.role) }),
            h('button', { class: 'icon-btn', title: '移除成员', onclick: () => {
              draft.members = draft.members.filter((m) => m.id !== member.id)
              paintMembers()
            } }, '✕')
          ),
          h('div', { class: 'field-row-3' },
            field('角色', roleSelect),
            field('名字', nameInput),
            field('简称', shortInput)
          ),
          h('div', { class: 'field-row-3' },
            field('头衔 / 职位', titleInput),
            field('职能', dutyInput, '会写进团队编制，所有成员都能看到'),
            field('汇报给', reportSelect, '可选；不指定时按角色自动推断')
          ),
          field('简介', bioArea, '显示在成员资料与对话空态里，也会写进提示词'),
          field('专属技能', skillList, '来自 app/skills/ 或 config/skills/，创建成员时一并带上'),
          field('动态提示词', promptArea, '支持变量，发送时按当前编制实时解析'),
          varChips,
          h('div', { class: 'prompt-preview-wrap' },
            h('div', { class: 'prompt-preview-title', text: '解析预览' }),
            previewEl
          )
        ))
        refreshPreview()
      })
    }

    const addMember = h('button', { class: 'btn ghost', onclick: () => {
      draft.members.push(newMember(draft.members, 'executor'))
      paintMembers()
    } }, '+ 添加成员')

    body.append(
      h('div', { class: 'template-editor-head' },
        h('button', { class: 'btn ghost', onclick: paintList }, '← 返回模板列表'),
        h('span', { class: 'hint', text: isNew ? '新建团队模板' : '编辑团队模板' })
      ),
      h('div', { class: 'field-row-2', style: { marginTop: '14px' } },
        field('模板名称', h('input', { class: 'input', value: draft.name || '', oninput: (e) => { draft.name = e.target.value } })),
        field('说明', h('input', { class: 'input', value: draft.description || '', placeholder: '这个团队适合什么项目', oninput: (e) => { draft.description = e.target.value } }))
      ),
      h('div', { class: 'btn-row', style: { marginTop: '16px' } },
        h('b', { text: '成员结构' }),
        h('span', { class: 'hint', text: '总指挥/副指挥都可以留空' })
      ),
      memberBox,
      addMember,
      h('div', { class: 'btn-row', style: { marginTop: '18px' } },
        h('button', { class: 'btn-primary', onclick: () => {
          const cleaned = cleanTemplate(draft)
          const idx = state.teamTemplates.findIndex((t) => t.id === cleaned.id)
          if (idx >= 0) state.teamTemplates[idx] = cleaned
          else state.teamTemplates.push(cleaned)
          persist.templates()
          bus.emit('templates:changed')
          toast(isNew ? '团队模板已创建' : '团队模板已保存', 'ok')
          paintList()
        } }, isNew ? '创建模板' : '保存模板'),
        h('button', { class: 'btn ghost', onclick: paintList }, '取消')
      )
    )
    paintMembers()
  }

  paintList()
}
