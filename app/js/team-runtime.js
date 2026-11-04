/* team-runtime.js — 团队生成与扩展的运行时
 *
 * 这里只负责「读计划书/对话 → 产出团队 → 写回项目」，不碰任何弹窗 DOM。
 * 编排层（orchestrator）和界面层（team-builder）共用同一套规则，
 * 避免单智能体自动扩展与手动组队出现两套逻辑。
 */

import { state, bus, uid, commander, activeProject, saveProjectsNow } from './core.js'
import { callModel } from './llm.js'
import { instantiateTemplate } from './team-templates.js'

const ROLES = ['commander', 'deputy', 'executor']
const ROLE_ALIASES = {
  总指挥: 'commander',
  副指挥: 'deputy',
  执行者: 'executor',
  成员: 'executor',
  'ai成员': 'executor',
  'ai 成员': 'executor',
  leader: 'commander',
  worker: 'executor'
}
const COLORS = ['#8b9cff', '#b98bff', '#5eead4', '#ffcf6b', '#ff8ba7', '#9ee7ff', '#c4b5fd', '#f0a67a']
const GLYPHS = ['◈', '◇', '○', '△', '✦', '⬡', '✧', '☲']
const PLAN_LIMIT = 30000

const byteLength = (text) => new TextEncoder().encode(String(text || '')).length

function usableProviders () {
  return (state.providers.providers || []).filter((provider) => {
    if (!provider || !Array.isArray(provider.models) || !provider.models.length) return false
    return provider.kind === 'ollama' || provider.hasKey !== false
  })
}

function modelValue (providerId, model) {
  return `${providerId}::${model}`
}

function parseModelValue (value) {
  const raw = String(value || '')
  const index = raw.indexOf('::')
  if (index < 0) return { providerId: '', model: '' }
  return { providerId: raw.slice(0, index), model: raw.slice(index + 2) }
}

function defaultPlanner () {
  const providers = usableProviders()
  const agent = commander()
  if (agent) {
    const provider = providers.find((p) => p.id === agent.providerId)
    if (provider) {
      const model = provider.models.includes(agent.model) ? agent.model : provider.models[0]
      return { providerId: provider.id, model }
    }
  }
  const provider = providers[0]
  return provider ? { providerId: provider.id, model: provider.models[0] } : { providerId: '', model: '' }
}

function catalogLines () {
  return usableProviders().map((provider) => `- ${provider.name}（providerId=${provider.id}，kind=${provider.kind}）：${provider.models.join(' / ')}`)
}

function skillCatalog () {
  return (state.skills || []).slice(0, 24).map((skill) => ({ id: skill.id, name: skill.name || skill.id, desc: skill.desc || '' }))
}

function systemPrompt () {
  const skills = skillCatalog()
  return [
    '你是「星界」的团队编制规划器。阅读用户的项目计划书，设计一个能真正把它执行好的 AI 团队。',
    '',
    '可用模型（只能从下面选，providerId 与 model 必须原样填写）：',
    ...catalogLines(),
    '',
    skills.length
      ? `可用技能 id（可选，最多给每人 2 个）：\n${skills.map((s) => `- ${s.id}：${s.name}${s.desc ? ` · ${s.desc}` : ''}`).join('\n')}`
      : '没有可选技能，skills 一律填空数组。',
    '',
    '组队规则：',
    '1. 总人数 1-8。简单任务 1-2 人；需要调研、写作、实现、校验并行时 3-6 人；最多 1 名总指挥、3 名副指挥、6 名执行者。',
    '2. 有 3 人以上时必须设 1 名总指挥负责收束与最终交付；2 人以下可以扁平。',
    '3. 分工按交付物划分，不要出现两个成员做同一件事。duty 用一句话写清“负责什么、交付什么”。',
    '4. 模型按任务匹配：长文写作/审校优先上下文大、表达稳的；代码与工具调用优先指令跟随强的；检索与整理可用更快的模型。同一团队可以混用不同模型。',
    '5. name 用 2-4 个汉字，title 用 4-8 个字。temperature 取 0-1，工程与核对偏低（0.2-0.5），创意偏高（0.7-0.9）。',
    '6. 只输出一个 JSON 对象，不要 markdown 代码围栏，不要解释，不要输出多余文字。',
    '',
    'JSON 结构：',
    '{"name":"团队名","summary":"一句话说明为什么这样配","members":[{"role":"commander|deputy|executor","name":"星枢","title":"总指挥","duty":"统筹目标、拆解关键路径并收束最终交付","bio":"一句话性格与风格","providerId":"deepseek","model":"deepseek-flash","temperature":0.4,"skills":[]}]}'
  ].join('\n')
}

function parseTeamJson (text) {
  const cleaned = String(text || '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('规划模型没有返回 JSON，请换一个模型再试')
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    throw new Error('规划结果不是合法 JSON，请重新生成')
  }
}

function clampTemperature (value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0.7
  return Math.min(1.2, Math.max(0, number))
}

function defaultPrompt (role) {
  if (role === 'executor') {
    return '你是「{{name}}」，{{title}}。你负责：{{duty}}。接到任务后直接产出结果，不复述任务，不写开场白。'
  }
  return '你是「{{name}}」，{{title}}。你负责：{{duty}}。先判断目标与关键路径，能自己完成就直接给出结果；需要协作时把任务交给最合适的人。'
}

function assignReports (members) {
  const boss = members.find((m) => m.role === 'commander')
  const deputies = members.filter((m) => m.role === 'deputy')
  for (const member of members) {
    if (member.role === 'commander') member.reportsTo = null
    else if (member.role === 'deputy') member.reportsTo = boss ? boss.id : null
  }
  /* 执行者均分到各副指挥；没有副指挥就直接向总指挥汇报。
     否则多个副指挥时只有第一个能派单，协作层级会断。 */
  const managers = deputies.length ? deputies : (boss ? [boss] : [])
  const executors = members.filter((m) => m.role === 'executor')
  executors.forEach((member, index) => {
    member.reportsTo = managers.length ? managers[index % managers.length].id : null
  })
}

function normalizeTeam (data, planner) {
  const sourceData = data && typeof data === 'object' ? data : {}
  const providers = usableProviders()
  const fallbackProvider = providers.find((p) => p.id === planner.providerId) || providers[0] || null
  const rawMembers = Array.isArray(sourceData.members) ? sourceData.members.slice(0, 8) : []
  if (!rawMembers.length) throw new Error('规划结果里没有成员，请重新生成')

  const usedSkills = new Set((state.skills || []).map((s) => s.id))
  let commanderSeen = false
  const members = rawMembers.map((item, index) => {
    const source = item && typeof item === 'object' ? item : {}
    const rawRole = String(source.role || '').trim()
    const roleKey = rawRole.toLowerCase()
    let role = ROLES.includes(roleKey) ? roleKey : (ROLE_ALIASES[rawRole] || 'executor')
    if (role === 'commander') {
      if (commanderSeen) role = 'deputy'
      else commanderSeen = true
    }
    const provider = providers.find((p) => p.id === (source.providerId || source.provider)) || fallbackProvider
    const wantedModel = String(source.model || '').trim()
    const model = provider
      ? (provider.models.includes(wantedModel)
          ? wantedModel
          : provider.models.find((name) => wantedModel.endsWith(name)) || provider.models[0])
      : (wantedModel || planner.model || '')
    return {
      id: uid('tmpl_member'),
      role,
      name: String(source.name || '').trim().slice(0, 12) || `成员${index + 1}`,
      short: '',
      title: String(source.title || '').trim().slice(0, 16) || roleLabel(role),
      duty: String(source.duty || '').trim().slice(0, 120),
      bio: String(source.bio || '').trim().slice(0, 160),
      glyph: GLYPHS[index % GLYPHS.length],
      color: COLORS[index % COLORS.length],
      prompt: defaultPrompt(role),
      skills: (Array.isArray(source.skills) ? source.skills : []).filter((id) => usedSkills.has(id)).slice(0, 2),
      providerId: provider ? provider.id : '',
      model,
      temperature: clampTemperature(source.temperature),
      reportsTo: null
    }
  })

  if (!commanderSeen && members.length > 1) {
    members[0].role = 'commander'
    members[0].title = roleLabel('commander')
    members[0].prompt = defaultPrompt('commander')
  }
  assignReports(members)

  return {
    id: uid('tpl'),
    name: String(sourceData.name || '').trim().slice(0, 40) || 'AI 推荐团队',
    description: String(sourceData.summary || '').trim().slice(0, 160),
    globalSkills: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    members
  }
}

async function generateTeam (planText, planner, onProgress) {
  if (!planner.providerId || !planner.model) throw new Error('还没有可用的规划模型')
  let received = ''
  let lastPaint = 0
  const text = await callModel(
    { providerId: planner.providerId, model: planner.model, temperature: 0.2 },
    [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: `项目计划书如下：\n\n${planText.slice(0, PLAN_LIMIT)}` }
    ],
    {
      maxTokens: 3200,
      temperature: 0.2,
      onDelta: (delta) => {
        received += delta
        const now = Date.now()
        if (onProgress && now - lastPaint > 160) {
          lastPaint = now
          onProgress(received)
        }
      }
    }
  )
  return normalizeTeam(parseTeamJson(text || received), planner)
}

/* 把生成的团队写回当前项目；soloAgent 会把原来的单智能体提升为总指挥，
   保留它的 id（会话线程不断）与模型，只补角色和汇报关系。 */
export function applyTeamToProject (team, { soloAgent = null } = {}) {
  const project = activeProject()
  if (!project || !team) return null
  const roster = instantiateTemplate(team)
  let agents = roster.agents
  if (soloAgent) {
    const promoted = {
      ...soloAgent,
      role: 'commander',
      reportsTo: null,
      enabled: true
    }
    if (!promoted.title || promoted.title === '执行者' || promoted.title === 'AI 成员') {
      promoted.title = '总指挥'
    }
    const generatedCommander = agents.find((agent) => agent.role === 'commander')
    if (generatedCommander && !promoted.duty) promoted.duty = generatedCommander.duty
    agents = [promoted, ...agents.filter((agent) => agent.role !== 'commander')]
  }
  agents = agents.slice(0, 8)
  assignReports(agents)
  project.roster = {
    agents,
    globalSkills: [...new Set([...(project.roster && project.roster.globalSkills || []), ...(roster.globalSkills || [])])],
    globalNotes: (project.roster && project.roster.globalNotes) || ''
  }
  project.workMode = 'team'
  project.teamTemplateId = ''
  project.updatedAt = Date.now()
  state.roster = project.roster
  saveProjectsNow()
  bus.emit('roster:changed')
  bus.emit('project:mode', 'team')
  bus.emit('projects:changed', project)
  return { project, agents, team }
}

export {
  ROLES, COLORS, GLYPHS, PLAN_LIMIT,
  usableProviders, modelValue, parseModelValue, defaultPlanner,
  defaultPrompt, assignReports, generateTeam
}
