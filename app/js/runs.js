/* runs.js — 渲染层的运行生命周期与取消信号 */

import { state, activeProject, bus } from './core.js'
import { cancelAllModels } from './llm.js'

let current = null
let cancelled = false

export function activeRun () {
  return current
}

export function runCancelled () {
  return cancelled
}

export async function beginRun (payload = {}) {
  cancelled = false
  if (!window.astral || typeof window.astral.runStart !== 'function') return null
  const project = activeProject()
  try {
    const res = await window.astral.runStart({
      ...payload,
      projectId: payload.projectId || (project ? project.id : ''),
      projectName: payload.projectName || (project ? project.name : '')
    })
    if (!res || res.ok === false) return null
    current = res.run
    state.currentRunId = current.id
    state.currentRunCapability = current.runCapability || ''
    bus.emit('run:changed', { run: current })
    return current
  } catch {
    return null
  }
}

export function recordRun (type, data = {}) {
  if (!current || !window.astral || typeof window.astral.runEvent !== 'function') return
  try {
    window.astral.runEvent({ id: current.id, type, data }).catch(() => {})
  } catch { /* 运行日志不能阻塞主流程 */ }
}

export async function finishRun (status = 'completed', extra = {}) {
  if (!current) return null
  const run = current
  current = null
  state.currentRunId = ''
  state.currentRunCapability = ''
  try {
    await window.astral.runFinish({ id: run.id, status, error: extra.error || '' })
  } catch { /* ignore */ }
  bus.emit('run:changed', { run: null, status })
  return run
}

export function requestCancel () {
  if (!current) return false
  if (cancelled) return true
  cancelled = true
  bus.emit('run:cancelling', { id: current.id })
  recordRun('cancel_requested', {})
  cancelAllModels().catch(() => {})
  return true
}

export async function recoverableRuns () {
  if (!window.astral || typeof window.astral.runList !== 'function') return []
  try {
    const res = await window.astral.runList({ limit: 20 })
    return (res && Array.isArray(res.runs) ? res.runs : []).filter((run) => run.status === 'interrupted')
  } catch {
    return []
  }
}

export async function abandonRun (id) {
  if (!window.astral || typeof window.astral.runAbandon !== 'function') return false
  try {
    const res = await window.astral.runAbandon({ id })
    return Boolean(res && res.ok)
  } catch {
    return false
  }
}
