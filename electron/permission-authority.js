'use strict'

/* permission-authority.js — 主进程侧的权限权威
 *
 * 渲染层仍然负责展示权限，但不能决定工具到底能不能执行。
 * 主进程按 projects.json 里的当前项目 roster 和 settings.json 的全局权限重新计算。
 */

const fs = require('node:fs')
const path = require('node:path')

const PERM_KEYS = ['readFiles', 'writeFiles', 'runCommands', 'network', 'tools', 'memory']

function readJson (file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function createPermissionAuthority ({ configDir }) {
  const settingsFile = path.join(configDir, 'settings.json')
  const projectsFile = path.join(configDir, 'projects.json')

  function resolve (payload = {}) {
    const settings = readJson(settingsFile, {})
    const projects = readJson(projectsFile, { projects: [] })
    const list = Array.isArray(projects.projects) ? projects.projects : []
    const activeId = String(projects.activeProjectId || '')
    const requestedId = String(payload.projectId || '')
    if (requestedId && activeId && requestedId !== activeId) {
      return { ok: false, error: '工具调用项目与当前项目不一致', reason: 'project-mismatch' }
    }
    const projectId = activeId || requestedId
    const project = list.find((item) => item && item.id === projectId) || null
    if (!project) {
      return { ok: false, error: '找不到当前项目，无法验证工具权限', reason: 'project-not-found' }
    }
    const roster = project.roster || {}
    const agents = Array.isArray(roster.agents) ? roster.agents : []
    const agentId = String(payload.agentId || '')
    const agent = agents.find((item) => item && item.id === agentId) || null
    if (!agent) {
      return { ok: false, error: '找不到调用工具的成员，无法验证权限', reason: 'agent-not-found' }
    }
    if (agent.enabled === false) {
      return { ok: false, error: '该成员已停用，不能调用工具', reason: 'agent-disabled' }
    }

    const global = settings.permissions || {}
    const full = Boolean(global.full)
    const defaults = settings.agentDefaults && settings.agentDefaults.permissions
    const hasDefaults = defaults && typeof defaults === 'object' && Object.keys(defaults).length > 0
    const own = agent.permissions && typeof agent.permissions === 'object'
      ? agent.permissions
      : (hasDefaults ? defaults : global)

    const permissions = { full }
    for (const key of PERM_KEYS) {
      permissions[key] = full ? true : Boolean(global[key]) && Boolean(own[key])
    }

    return {
      ok: true,
      permissions,
      agent: { id: agent.id, name: agent.name || '', enabled: agent.enabled !== false },
      project: { id: project.id, name: project.name || '', rootPath: project.rootPath || '' },
      source: 'main'
    }
  }

  return { resolve }
}

function intersectPermissions (left = {}, right = {}) {
  const a = left && typeof left === 'object' ? left : {}
  const b = right && typeof right === 'object' ? right : {}
  const full = a.full === true && b.full === true
  const permissions = { full }
  for (const key of PERM_KEYS) permissions[key] = full ? true : Boolean(a[key]) && Boolean(b[key])
  return permissions
}

module.exports = { createPermissionAuthority, intersectPermissions, PERM_KEYS }
