/* bridge.js — 外部 MCP / HTTP 调用的入口 */

import { state, persist, agentById } from './core.js'
import { submit } from './orchestrator.js'
import { applyTheme } from './effects.js'
import { emitEvent, listEvents, config as triggerConfig } from './triggers.js'

const METHODS = {
  'astral.status': () => ({
    busy: state.busy,
    agents: state.roster.agents.length,
    theme: state.settings.theme || 'astral',
    bridge: { port: state.bridge.port }
  }),

  'astral.list_agents': () => ({
    agents: state.roster.agents.map((a) => ({
      id: a.id,
      name: a.name,
      title: a.title,
      role: a.role,
      reportsTo: a.reportsTo,
      providerId: a.providerId,
      model: a.model,
      skills: a.skills || [],
      enabled: a.enabled !== false
    }))
  }),

  'astral.get_messages': (params) => {
    const limit = Math.max(1, Math.min(200, Number(params.limit || 30)))
    return {
      messages: state.messages.slice(-limit).map((m) => ({
        id: m.id,
        kind: m.kind,
        from: m.kind === 'user' ? 'user' : m.name || null,
        text: m.text || m.brief || '',
        ts: m.ts
      }))
    }
  },

  'astral.send_message': async (params) => {
    const text = String(params.text || '').trim()
    if (!text) throw new Error('text 不能为空')
    if (state.busy) throw new Error('星界正在处理上一轮指令，请稍后再试')
    let payload = text
    if (params.agentId) {
      const agent = agentById(params.agentId)
      if (!agent) throw new Error(`未知成员：${params.agentId}`)
      payload = `@${agent.name} ${text}`
    }
    const res = await submit(payload)
    return { ok: res.ok !== false, reply: res.text || '' }
  },

  /* 外部事件入口：只做规则判定与入队，立刻返回，不等待一整轮任务 */
  'astral.emit_event': (params) => emitEvent(params || {}),

  'astral.list_events': (params) => ({
    mode: triggerConfig().mode,
    events: listEvents(Number(params.limit) || 30).map((e) => ({
      id: e.id,
      eventId: e.eventId,
      source: e.source,
      type: e.type,
      threadId: e.threadId,
      text: String(e.text || '').slice(0, 200),
      ts: e.ts,
      status: e.status,
      reason: e.reason
    }))
  }),

  'astral.update_agent': (params) => {
    const agent = agentById(params.id)
    if (!agent) throw new Error(`未知成员：${params.id}`)
    const allowed = ['name', 'title', 'role', 'reportsTo', 'glyph', 'color', 'providerId', 'model', 'temperature', 'prompt', 'skills', 'enabled']
    const patch = params.patch || {}
    for (const key of allowed) {
      if (key in patch) agent[key] = patch[key]
    }
    if (patch.notes !== undefined) {
      agent.context = agent.context || { notes: '', historyLimit: 16 }
      agent.context.notes = patch.notes
    }
    persist.roster()
    return { ok: true, agent: { id: agent.id, name: agent.name, role: agent.role } }
  },

  'astral.set_context': (params) => {
    if (params.agentId) {
      const agent = agentById(params.agentId)
      if (!agent) throw new Error(`未知成员：${params.agentId}`)
      agent.context = agent.context || { notes: '', historyLimit: 16 }
      agent.context.notes = String(params.notes || '')
    } else {
      state.roster.globalNotes = String(params.notes || '')
    }
    persist.roster()
    return { ok: true }
  },

  'astral.set_theme': (params) => {
    const theme = state.themes.find((t) => t.id === params.id)
    if (!theme) throw new Error(`未知主题：${params.id}`)
    state.settings.theme = theme.id
    persist.settings()
    applyTheme(theme, state.settings)
    return { ok: true, theme: theme.id }
  },

  'astral.list_themes': () => ({ themes: state.themes.map((t) => ({ id: t.id, name: t.name, desc: t.desc || '' })) })
}

export function mountBridge () {
  window.astral.onBridgeRequest(async ({ id, method, params }) => {
    let outcome
    try {
      const handler = METHODS[method]
      if (!handler) throw new Error(`未知方法：${method}`)
      outcome = { result: await handler(params || {}) }
    } catch (err) {
      outcome = { error: { code: -32603, message: err.message || String(err) } }
    }
    window.astral.replyBridge(id, outcome)
  })
}
