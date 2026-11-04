/* team-builder.js — 新对话组队
 *
 * 三条路径：
 *   1. 沿用当前项目团队，只清空对话；
 *   2. 选一个已保存的团队模板，复制成新项目；
 *   3. 把计划书交给规划模型，让它决定人数、角色、模型与分工，预览可改后建项目。
 *
 * 模板的长期管理仍在 设置 → 团队模板；这里生成的结果可以顺手存成模板，
 * 之后在那边继续改提示词、技能与权限。
 */

import { state, h, uid, toast, bus, persist } from './core.js'
import { openModal, closeModal, field, switchRow } from './modal.js'
import { confirmAction } from './confirm.js'
import { instantiateTemplate, roleLabel, templateSummary } from './team-templates.js'
import { createProject, setProjectWorkMode } from './projects.js'
import { submit, clearSession } from './orchestrator.js'
import { setView } from './viewswitch.js'
import {
  ROLES, COLORS, GLYPHS, PLAN_LIMIT,
  usableProviders, modelValue, parseModelValue, defaultPlanner,
  defaultPrompt, assignReports, generateTeam, applyTeamToProject
} from './team-runtime.js'

const byteLength = (text) => new TextEncoder().encode(String(text || '')).length

/* ------------------------------------------------------------- 模板保存 */

function saveTemplate (team) {
  const clone = JSON.parse(JSON.stringify(team))
  clone.id = uid('tpl')
  clone.updatedAt = Date.now()
  clone.createdAt = Date.now()
  const names = new Set((state.teamTemplates || []).map((t) => t.name))
  let name = clone.name || 'AI 团队模板'
  if (names.has(name)) name = `${name} · AI`
  let index = 2
  while (names.has(name)) name = `${clone.name || 'AI 团队模板'} · AI${index++}`
  clone.name = name
  state.teamTemplates.push(clone)
  persist.templates()
  bus.emit('templates:changed')
  return clone
}

/* --------------------------------------------------------------- 界面 */

function tabButton (id, label, hint, draft, repaint) {
  return h('button', {
    class: 'newconvo-tab' + (draft.tab === id ? ' active' : ''),
    onclick: () => { draft.tab = id; repaint() }
  },
  h('b', { text: label }),
  h('span', { text: hint })
  )
}

function currentTeamSummary () {
  const agents = ((state.roster && state.roster.agents) || []).filter((agent) => agent.enabled !== false)
  const counts = { commander: 0, deputy: 0, executor: 0 }
  for (const agent of agents) counts[agent.role] = (counts[agent.role] || 0) + 1
  return { agents, counts }
}

function teamChips (members) {
  return h('div', { class: 'team-preview-chips' }, members.map((member) => h('span', {
    class: 'template-chip',
    title: [member.duty, member.model].filter(Boolean).join(' · ')
  },
  h('i', { style: { background: member.color || 'var(--accent)' } }),
  `${member.name}${member.role === 'executor' ? '' : ` · ${roleLabel(member.role)}`}`
  )))
}

/* 计划书输入：文件选择 + 粘贴，两者共用一个 draft.planText */
function planPanel (draft, repaint) {
  const card = h('div', { class: 'newconvo-card' })
  const status = h('div', { class: 'hint', text: '' })

  const paintStatus = () => {
    if (draft.planName) {
      status.textContent = `${draft.planName} · ${(byteLength(draft.planText) / 1024).toFixed(1)}KB${draft.planText.length > PLAN_LIMIT ? '（超出部分不会交给规划模型）' : ''}`
    } else {
      status.textContent = draft.planText.trim() ? `已粘贴 ${draft.planText.length} 字符` : '支持 txt / md / json 等文本文件；PDF / Word 请先粘贴正文'
    }
  }

  const pick = async () => {
    if (!window.astral.pickDataFile) { toast('当前环境不支持选择文件', 'err'); return }
    try {
      const picked = await window.astral.pickDataFile()
      if (!picked) return
      if (picked.kind !== 'text' || typeof picked.text !== 'string') {
        toast('这份文档不是纯文本，暂时读不了；请把正文粘贴到下面的输入框', 'err')
        return
      }
      draft.planText = picked.text
      draft.planName = picked.name || '计划书'
      draft.planPath = ''
      draft.planSize = Number(picked.size) || byteLength(picked.text)
      repaint()
    } catch (err) {
      toast(err.message || '读取文件失败', 'err')
    }
  }

  const area = h('textarea', {
    class: 'textarea plan-textarea',
    placeholder: '把计划书粘贴到这里，或点上面的「选择文档」…',
    oninput: (e) => {
      draft.planText = e.target.value
      if (!draft.planName) draft.planName = '计划书.md'
      paintStatus()
    }
  })
  area.value = draft.planText

  card.append(
    h('div', { class: 'newconvo-card-head' },
      h('div', {}, h('div', { class: 'card-title', text: '计划书' }), status),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn ghost', onclick: pick }, '选择文档'),
        draft.planText
          ? h('button', { class: 'btn ghost', onclick: () => {
              draft.planText = ''
              draft.planName = ''
              draft.planPath = ''
              draft.planSize = 0
              repaint()
            } }, '清空')
          : null
      )
    ),
    area
  )
  paintStatus()
  return card
}

/* 规划模型选择 */
function plannerSelect (draft, repaint) {
  const providers = usableProviders()
  if (!providers.length) {
    return h('div', { class: 'newconvo-empty' },
      h('b', { text: '还没有可用的模型供应商' }),
      h('span', { text: '先到 设置 → 模型供应商 填好 API Key，或接一个本地 Ollama，再回来组队。' })
    )
  }
  const current = modelValue(draft.planner.providerId, draft.planner.model)
  const options = providers.map((provider) => h('optgroup', { label: provider.name },
    provider.models.map((model) => h('option', {
      value: modelValue(provider.id, model),
      selected: current === modelValue(provider.id, model)
    }, model))
  ))
  const select = h('select', {
    class: 'select',
    onchange: (e) => {
      const next = parseModelValue(e.target.value)
      draft.planner = next
      repaint()
    }
  }, ...options)
  return field('规划模型', select, '只用于读计划书和生成团队结构；生成后每个成员的模型可以单独改。')
}

/* 生成后的成员编辑器 */
function teamPreview (draft, repaint, options = {}) {
  if (!draft.team) return null
  const team = draft.team
  const providers = usableProviders()
  const counts = { commander: 0, deputy: 0, executor: 0 }
  const countsEl = h('div', { class: 'team-counts' })
  const refreshCounts = () => {
    counts.commander = 0
    counts.deputy = 0
    counts.executor = 0
    for (const member of team.members) counts[member.role] = (counts[member.role] || 0) + 1
    countsEl.textContent = ''
    countsEl.append(
      h('span', { text: `总指挥 ${counts.commander}` }),
      h('span', { text: `副指挥 ${counts.deputy}` }),
      h('span', { text: `成员 ${counts.executor}` }),
      h('span', { text: `共 ${team.members.length} 人` })
    )
  }

  const list = h('div', { class: 'team-preview-list' })
  const paintMembers = () => {
    refreshCounts()
    list.textContent = ''
    team.members.forEach((member, index) => {
      const roleSelect = h('select', {
        class: 'select team-role',
        onchange: (e) => {
          member.role = e.target.value
          if (member.role === 'commander') {
            for (const other of team.members) {
              if (other !== member && other.role === 'commander') other.role = 'deputy'
            }
          }
          if (!member.title || member.title === roleLabel('commander') || member.title === roleLabel('deputy') || member.title === roleLabel('executor')) {
            member.title = roleLabel(member.role)
          }
          assignReports(team.members)
          paintMembers()
        }
      }, ...ROLES.map((role) => h('option', { value: role, selected: member.role === role }, roleLabel(role))))

      const nameInput = h('input', {
        class: 'input',
        value: member.name || '',
        maxlength: '12',
        oninput: (e) => { member.name = e.target.value }
      })
      const titleInput = h('input', {
        class: 'input',
        value: member.title || '',
        placeholder: '头衔',
        oninput: (e) => { member.title = e.target.value }
      })
      const dutyInput = h('input', {
        class: 'input',
        value: member.duty || '',
        placeholder: '负责什么、交付什么',
        oninput: (e) => { member.duty = e.target.value }
      })

      const modelOptions = providers.map((provider) => h('optgroup', { label: provider.name },
        provider.models.map((model) => h('option', {
          value: modelValue(provider.id, model),
          selected: member.providerId === provider.id && member.model === model
        }, model))
      ))
      const modelSelect = h('select', {
        class: 'select team-model',
        onchange: (e) => {
          const next = parseModelValue(e.target.value)
          member.providerId = next.providerId
          member.model = next.model
        }
      }, ...modelOptions)

      list.append(h('div', { class: 'team-member' },
        h('div', { class: 'team-member-head' },
          roleSelect,
          nameInput,
          titleInput
        ),
        h('div', { class: 'team-member-body' },
          dutyInput,
          modelSelect,
          h('button', {
            class: 'btn ghost danger-text team-remove',
            title: '移除这个成员',
            disabled: team.members.length <= 1,
            onclick: () => {
              if (team.members.length <= 1) return
              team.members.splice(index, 1)
              assignReports(team.members)
              paintMembers()
            }
          }, '移除')
        )
      ))
    })
  }
  paintMembers()

  const addMember = (role) => {
    if (team.members.length >= 8) { toast('一个团队最多 8 名成员', 'err'); return }
    const index = team.members.length
    const provider = providers[0] || null
    if (role === 'commander') {
      for (const member of team.members) {
        if (member.role === 'commander') member.role = 'deputy'
      }
    }
    team.members.push({
      id: uid('tmpl_member'),
      role,
      name: `新成员${index + 1}`,
      short: '',
      title: roleLabel(role),
      duty: '',
      bio: '',
      glyph: GLYPHS[index % GLYPHS.length],
      color: COLORS[index % COLORS.length],
      prompt: defaultPrompt(role),
      skills: [],
      providerId: provider ? provider.id : '',
      model: provider ? provider.models[0] : '',
      temperature: 0.7,
      reportsTo: null
    })
    assignReports(team.members)
    paintMembers()
  }

  return h('div', { class: 'newconvo-card team-preview' },
    h('div', { class: 'newconvo-card-head' },
      h('div', {},
        h('div', { class: 'card-title', text: '团队预览' }),
        h('div', { class: 'hint', text: [templateSummary(team), draft.team.description].filter(Boolean).join(' · ') })
      ),
      countsEl
    ),
    options.upgrade
      ? field('团队名称', h('input', {
          class: 'input',
          value: team.name,
          oninput: (e) => { team.name = e.target.value }
        }))
      : h('div', { class: 'field-row-2' },
          field('团队名称', h('input', {
            class: 'input',
            value: team.name,
            oninput: (e) => { team.name = e.target.value }
          })),
          field('项目名称', h('input', {
            class: 'input',
            value: draft.projectName,
            placeholder: '新项目的名称',
            oninput: (e) => { draft.projectName = e.target.value }
          }))
        ),
    h('div', { class: 'team-member-list' }, list),
    h('div', { class: 'team-add-row' },
      h('button', { class: 'btn ghost', onclick: () => addMember('deputy') }, '+ 副指挥'),
      h('button', { class: 'btn ghost', onclick: () => addMember('executor') }, '+ AI 成员'),
      counts.commander
        ? null
        : h('button', { class: 'btn ghost', onclick: () => addMember('commander') }, '+ 总指挥')
    ),
    h('div', { class: 'hint', text: options.templateOnly
      ? '保存后到 设置 → 团队模板 里还能改提示词、技能与权限。'
      : '成员的角色、模型、分工都可以直接改；更细的提示词与技能到 设置 → 团队模板 里改。' })
  )
}

/* --------------------------------------------------------------- 组装 */

function openComposer ({ templateOnly = false, upgrade = false, seedText = '', onSaved = null } = {}) {
  const draft = {
    tab: templateOnly || upgrade ? 'ai' : 'current',
    upgrade,
    planText: upgrade ? seedText : '',
    planName: upgrade ? '当前对话' : '',
    planPath: '',
    planSize: 0,
    planner: defaultPlanner(),
    templateId: (state.teamTemplates[0] && state.teamTemplates[0].id) || '',
    team: null,
    projectName: '',
    generating: false,
    progress: '',
    error: '',
    autoStart: true,
    saveTemplate: false,
    soloAgentId: state.activeAgentId || ''
  }

  openModal({
    title: upgrade ? '扩展为团队' : templateOnly ? 'AI 生成团队模板' : '新对话',
    sub: upgrade
      ? '读当前对话 · 生成编制 · 应用到本项目'
      : templateOnly
        ? '读计划书 · 推荐模型与分工 · 存为可复用编制'
        : '选择团队 · 开始一轮新的协作',
    width: 880,
    render: (body) => {
      const root = h('div', { class: 'newconvo' })
      body.append(root)

      const paint = () => {
        root.textContent = ''

        if (!templateOnly && !upgrade) {
          root.append(h('div', { class: 'newconvo-tabs' },
            tabButton('solo', '标准会话', '与一名智能体单独对话', draft, paint),
            tabButton('current', '沿用当前团队', '只清空本项目对话', draft, paint),
            tabButton('template', '使用已有编制', '复制一个模板到新项目', draft, paint),
            tabButton('ai', '让 AI 组队', '读计划书决定人数与模型', draft, paint)
          ))
        }

        if (draft.tab === 'solo') {
          const agents = ((state.roster && state.roster.agents) || []).filter((agent) => agent.enabled !== false)
          if (!agents.length) {
            root.append(h('div', { class: 'newconvo-empty' },
              h('b', { text: '当前项目还没有可用成员' }),
              h('span', { text: '先到 设置 → 编制 里添加一个成员，或使用「让 AI 组队」生成一个团队。' })
            ))
            return
          }
          const selected = agents.find((agent) => agent.id === draft.soloAgentId) ||
            agents.find((agent) => agent.role === 'commander') ||
            agents[0]
          draft.soloAgentId = selected.id
          const select = agents.length > 1
            ? field('会话成员', h('select', {
                class: 'select',
                onchange: (e) => { draft.soloAgentId = e.target.value; paint() }
              }, ...agents.map((agent) => h('option', {
                value: agent.id,
                selected: agent.id === selected.id
              }, `${agent.name}${agent.title ? ` · ${agent.title}` : ''}`))), '只由这一位成员回答；标准会话不会调用其他成员。')
            : null

          root.append(
            h('div', { class: 'newconvo-card' },
              h('div', { class: 'newconvo-card-head' },
                h('div', {}, h('div', { class: 'card-title', text: '标准会话' }), h('div', { class: 'hint', text: '你与这名智能体直接对话，不派单、不生成计划；只有你明确要求时，它才会申请扩展为团队。' })),
                h('div', { class: 'tag', text: '轻量' })
              ),
              select,
              h('div', { class: 'team-preview-chips' },
                h('span', { class: 'template-chip' },
                  h('i', { style: { background: selected.color || 'var(--accent)' } }),
                  `${selected.name} · ${selected.model || '默认模型'}`
                )
              ),
              h('div', { class: 'hint', text: `在当前项目「${activeProjectName()}」里开启新对话；团队编制不会被删除，随时可以切回团队。` })
            ),
            h('div', { class: 'newconvo-actions newconvo-footer' },
              h('button', { class: 'btn ghost', onclick: () => closeModal() }, '取消'),
              h('button', { class: 'btn-primary', onclick: async () => {
                if (state.busy) { toast('协作进行中，暂时不能开始新对话', 'err'); return }
                if (state.messages.length) {
                  const ok = await confirmAction({
                    title: '清空当前会话？',
                    message: `清空当前项目「${activeProjectName()}」的对话记录？编制与配置不受影响。`,
                    confirmText: '清空并开始',
                    danger: true
                  })
                  if (!ok) return
                }
                state.activeAgentId = selected.id
                bus.emit('active:agent', selected.id)
                const res = setProjectWorkMode('solo')
                if (!res.ok) { toast(res.error || '切换失败', 'err'); return }
                setView('user')
                clearSession()
                closeModal()
                toast(`已开始与 ${selected.name} 的标准会话`)
              } }, '开始标准会话')
            )
          )
          return
        }

        if (draft.tab === 'current') {
          const { agents, counts } = currentTeamSummary()
          root.append(h('div', { class: 'newconvo-card' },
            h('div', { class: 'card-title' }, '当前团队', h('span', { class: 'tag', text: activeTeamName() })),
            h('div', { class: 'hint', text: `总指挥 ${counts.commander} · 副指挥 ${counts.deputy} · AI 成员 ${counts.executor}。清空后团队、配置和项目都不变。` }),
            agents.length ? teamChips(agents) : h('div', { class: 'hint', text: '当前项目还没有成员。' }),
            h('div', { class: 'newconvo-actions' },
              h('button', { class: 'btn ghost', onclick: () => closeModal() }, '取消'),
              h('button', { class: 'btn-primary', onclick: async () => {
                if (state.busy) { toast('协作进行中，暂时不能清空对话', 'err'); return }
                if (state.messages.length) {
                  const ok = await confirmAction({
                    title: '清空当前会话？',
                    message: `清空当前项目「${activeProjectName()}」的对话记录？配置与编制不受影响。`,
                    confirmText: '清空并继续',
                    danger: true
                  })
                  if (!ok) return
                }
                setView('user')
                clearSession()
                closeModal()
                toast('已为当前项目开启新对话')
              } }, '清空对话并继续')
            )
          ))
          return
        }

        if (draft.tab === 'template') {
          const templates = state.teamTemplates || []
          if (!templates.length) {
            root.append(h('div', { class: 'newconvo-empty' },
              h('b', { text: '还没有已保存的编制' }),
              h('span', { text: '可以先让 AI 读计划书生成一个，或到 设置 → 团队模板 手动新建。' }),
              h('div', { class: 'btn-row', style: { marginTop: '10px' } },
                h('button', { class: 'btn ghost', onclick: () => { draft.tab = 'ai'; paint() } }, '去 AI 组队')
              )
            ))
            return
          }
          const template = templates.find((t) => t.id === draft.templateId) || templates[0]
          draft.templateId = template.id
          if (!draft.projectName) draft.projectName = template.name
          const select = h('select', {
            class: 'select',
            onchange: (e) => {
              draft.templateId = e.target.value
              const next = templates.find((t) => t.id === draft.templateId)
              draft.projectName = next ? next.name : draft.projectName
              paint()
            }
          }, ...templates.map((t) => h('option', { value: t.id, selected: t.id === template.id }, t.name)))

          root.append(
            h('div', { class: 'newconvo-card' },
              h('div', { class: 'newconvo-card-head' },
                h('div', {}, h('div', { class: 'card-title', text: '选择编制' }), h('div', { class: 'hint', text: templateSummary(template) })),
                h('div', { class: 'tag', text: template.name })
              ),
              field('团队模板', select, '会被复制成新项目独有的一份成员，模板本身不会被改动。'),
              template.members && template.members.length
                ? teamChips(template.members.map((m) => ({ ...m, name: m.name })))
                : h('div', { class: 'hint', text: '这个模板是空的，创建后项目里没有成员。' })
            ),
            planPanel(draft, paint),
            h('div', { class: 'field-row-2' },
              field('项目名称', h('input', {
                class: 'input',
                value: draft.projectName,
                oninput: (e) => { draft.projectName = e.target.value }
              })),
              switchRow('创建后立即开始协作', draft.autoStart && Boolean(draft.planText.trim()), (on) => {
                draft.autoStart = on
                paint()
              }, draft.planText.trim() ? '把计划书作为附件发给总指挥' : '先填计划书才能自动开始')
            )
          )
          root.append(h('div', { class: 'newconvo-actions newconvo-footer' },
            h('button', { class: 'btn ghost', onclick: () => closeModal() }, '取消'),
            h('button', { class: 'btn-primary', onclick: async () => {
              if (state.busy) { toast('协作进行中，暂时不能新建项目', 'err'); return }
              const project = await createProject({
                name: draft.projectName.trim() || template.name,
                templateId: template.id,
                workMode: 'team',
                silent: true
              })
              if (!project) return
              setView('user')
              closeModal()
              toast(`已创建「${project.name}」并切换到新对话`, 'ok')
              if (draft.planText.trim() && draft.autoStart && (template.members || []).length) await startWithPlan(draft)
            } }, '用这个编制开始')
          ))
          return
        }

        /* AI 组队 */
        root.append(
          h('div', { class: 'newconvo-card' },
            h('div', { class: 'newconvo-card-head' },
              h('div', {}, h('div', { class: 'card-title', text: upgrade ? '让 AI 读当前对话组队' : '让 AI 读计划书组队' }), h('div', { class: 'hint', text: upgrade ? '它会根据当前对话判断需要哪些角色、几个人、用哪个模型；应用后本项目切换为团队。' : '它会决定需要几个 AI、各自角色、用哪个模型，以及怎么分工；确认后会新建一个项目。' })),
              h('div', { class: 'tag on', text: 'AI 推荐' })
            ),
            plannerSelect(draft, paint),
            h('div', { class: 'hint', text: '生成只会调用一次规划模型：读计划书、输出团队 JSON，不会开始正式协作。' })
          ),
          planPanel(draft, paint)
        )

        if (draft.error) {
          root.append(h('div', { class: 'newconvo-error', text: draft.error }))
        }

        if (draft.generating) {
          root.append(h('div', { class: 'newconvo-loading' },
            h('i', { class: 'spin' }),
            h('span', { text: draft.progress ? `正在读计划书… 已接收 ${draft.progress.length} 字符` : '正在读计划书并设计团队…' })
          ))
        }

        if (draft.team) {
          root.append(teamPreview(draft, paint, { templateOnly, upgrade }))
          if (!templateOnly) {
            root.append(h('div', { class: 'newconvo-card' },
              h('div', { class: 'mini-row' },
                h('div', {}, h('div', { text: '同时保存为团队模板' }), h('div', { class: 'hint', text: '以后可以在「设置 → 团队模板」里复用它。' })),
                h('div', {
                  class: 'switch' + (draft.saveTemplate ? ' on' : ''),
                  onclick: (e) => {
                    draft.saveTemplate = !draft.saveTemplate
                    e.currentTarget.classList.toggle('on', draft.saveTemplate)
                  }
                })
              ),
              upgrade
                ? null
                : h('div', { class: 'mini-row' },
                    h('div', {}, h('div', { text: '创建后立即开始协作' }), h('div', { class: 'hint', text: draft.planText.trim() ? '把计划书作为附件发给总指挥' : '先填计划书才能自动开始' })),
                    h('div', {
                      class: 'switch' + (draft.autoStart && draft.planText.trim() ? ' on' : ''),
                      onclick: (e) => {
                        if (!draft.planText.trim()) { toast('先填计划书', 'err'); return }
                        draft.autoStart = !draft.autoStart
                        e.currentTarget.classList.toggle('on', draft.autoStart)
                      }
                    })
                  )
            ))
          }
        }

        root.append(h('div', { class: 'newconvo-actions newconvo-footer' },
          h('button', { class: 'btn ghost', onclick: () => closeModal() }, '取消'),
          draft.team
            ? h('button', { class: 'btn ghost', onclick: () => runGeneration(draft, paint) }, '重新生成')
            : null,
          ...(draft.team
            ? [templateOnly
                ? h('button', {
                    class: 'btn-primary',
                    onclick: () => {
                      const saved = saveTemplate(draft.team)
                      closeModal()
                      toast(`已保存模板「${saved.name}」`, 'ok')
                      if (onSaved) onSaved(saved)
                    }
                  }, '保存为模板')
                : upgrade
                  ? h('button', { class: 'btn-primary', onclick: () => finishUpgrade(draft) }, '应用到当前项目')
                  : h('button', { class: 'btn-primary', onclick: () => finishProject(draft) }, '创建项目并开始')]
            : [h('button', {
                class: 'btn-primary',
                disabled: draft.generating || !draft.planner.providerId,
                onclick: () => runGeneration(draft, paint)
              }, draft.generating ? '生成中…' : '让 AI 组队')])
        ))
      }

      paint()
    }
  })
}

function activeProjectName () {
  const project = (state.projects || []).find((p) => p.id === state.activeProjectId)
  return project ? project.name : '当前项目'
}

function activeTeamName () {
  const project = (state.projects || []).find((p) => p.id === state.activeProjectId)
  const template = project && (state.teamTemplates || []).find((t) => t.id === project.teamTemplateId)
  return template ? template.name : '项目自有编制'
}

async function runGeneration (draft, paint) {
  if (draft.generating) return
  if (!usableProviders().length) { toast('没有可用模型，请先配置供应商', 'err'); return }
  if (!draft.planText.trim()) {
    draft.error = '请先选择计划书文件，或把计划书正文粘贴到下面的输入框。'
    paint()
    return
  }
  draft.generating = true
  draft.error = ''
  draft.progress = ''
  paint()
  let generated = false
  try {
    const team = await generateTeam(draft.planText, draft.planner, (text) => {
      draft.progress = text
    })
    draft.team = team
    if (!draft.projectName.trim()) draft.projectName = team.name
    generated = true
  } catch (err) {
    draft.error = err.message || '生成失败'
  } finally {
    draft.generating = false
    paint()
    if (generated) {
      /* 生成后把预览滚进视野：上面的计划书和模型选择已经看过，不用再占屏幕 */
      requestAnimationFrame(() => {
        const preview = document.querySelector('.modal .team-preview')
        if (preview) preview.scrollIntoView({ block: 'start', behavior: 'smooth' })
      })
    }
  }
}

async function finishProject (draft) {
  if (!draft.team) return
  if (state.busy) { toast('协作进行中，暂时不能新建项目', 'err'); return }
  let savedTemplateId = ''
  if (draft.saveTemplate) savedTemplateId = saveTemplate(draft.team).id
  const roster = instantiateTemplate(draft.team)
  const project = await createProject({
    name: draft.projectName.trim() || draft.team.name,
    description: draft.team.description || '',
    roster,
    templateId: savedTemplateId,
    workMode: 'team',
    silent: true
  })
  if (!project) return
  setView('user')
  closeModal()
  toast(`已创建「${project.name}」并切换到新对话`, 'ok')
  if (draft.planText.trim() && draft.autoStart) await startWithPlan(draft)
}

/* 把生成结果应用到当前项目：原单智能体提升为总指挥，其余成员按角色补入 */
function finishUpgrade (draft) {
  if (!draft.team) return
  if (state.busy) { toast('协作进行中，暂时不能切换团队', 'err'); return }
  if (draft.saveTemplate) saveTemplate(draft.team)
  const agents = state.roster.agents || []
  const solo = (state.activeAgentId && agents.find((agent) => agent.id === state.activeAgentId)) ||
    agents.find((agent) => agent.role === 'commander') ||
    agents.find((agent) => agent.enabled !== false) ||
    null
  const applied = applyTeamToProject(draft.team, { soloAgent: solo })
  if (!applied) { toast('扩展失败：当前没有活动项目', 'err'); return }
  setView('user')
  closeModal()
  toast(`已扩展为团队（${applied.agents.length} 人），下一条指令由团队接手`, 'ok')
}

function recentConversationText (limit = 10) {
  return (state.messages || [])
    .filter((msg) => msg && msg.kind !== 'system' && msg.kind !== 'tool' && String(msg.text || '').trim())
    .slice(-limit)
    .map((msg) => `${msg.kind === 'user' ? '用户' : (msg.name || 'AI')}：${String(msg.text).slice(0, 1500)}`)
    .join('\n\n')
}

async function startWithPlan (draft) {
  try {
    await new Promise((resolve) => setTimeout(resolve, 260))
    state.pendingFiles = [{
      name: draft.planName || '计划书.md',
      path: draft.planPath || '',
      size: byteLength(draft.planText),
      /* 超长计划书只随首条消息带前 20 万字符，避免把会话文件撑爆 */
      text: draft.planText.slice(0, 200000)
    }]
    bus.emit('attachments:changed')
    await submit('请依据这份计划书开始协作：先说明团队分工与执行顺序，然后按计划推进。')
  } catch (err) {
    toast(`自动开始失败：${err.message}`, 'err')
  }
}

export function openTeamFromDocument (options = {}) {
  openComposer({ templateOnly: true, onSaved: options.onSaved || null })
}

export function openTeamUpgradeDialog (options = {}) {
  const seed = String(options.seedText || '').trim() || recentConversationText()
  openComposer({
    upgrade: true,
    seedText: seed || '当前对话还没有内容。请在这里描述任务，再让 AI 根据它设计团队。'
  })
}
