/* triggers.js — 事件触发器：观察收件箱、逐条批准、任务单与忙时排队 */

import { state, bus, persist, toast, uid } from './core.js'
import { submit } from './orchestrator.js'
import {
  MAX_EVENTS, MODES, normalizeConfig, evaluateEvent,
  makeEvent, makeMandate, capEvents, mergeIntoThread, threadBlock
} from './triggers-core.js'

const queue = []
let draining = false
let mounted = false

export function config () {
  const raw = state.settings.triggers
  if (!raw || typeof raw !== 'object') {
    state.settings.triggers = normalizeConfig(null)
    return state.settings.triggers
  }
  /* 补齐旧配置缺的字段，但保留 events 原数组引用，避免调用方持有失效引用 */
  const next = normalizeConfig(raw)
  next.events = Array.isArray(raw.events) ? raw.events : []
  state.settings.triggers = next
  return next
}

export function events () {
  const c = config()
  if (!Array.isArray(c.events)) c.events = []
  return c.events
}

export function listEvents (limit = MAX_EVENTS) {
  return events().slice(-Math.max(1, Math.min(MAX_EVENTS, Number(limit) || MAX_EVENTS)))
}

export function saveConfig (patch = {}) {
  const current = config()
  const next = normalizeConfig({ ...current, ...patch })
  next.events = current.events
  state.settings.triggers = next
  persist.settings()
  bus.emit('triggers:changed')
  return next
}

export function setMode (mode) {
  if (!MODES.includes(mode)) return config()
  return saveConfig({ mode })
}

function commit () {
  const c = config()
  c.events = capEvents(c.events, MAX_EVENTS)
  persist.settings()
  bus.emit('triggers:changed')
}

/* 外部事件入口。返回判定结果，不等待一整轮任务执行，避免 /rpc 被长任务拖到超时。 */
function seenIds () {
  const ids = new Set()
  for (const e of events()) {
    ids.add(e.eventId)
    for (const item of (e.threadItems || [])) ids.add(item.eventId)
  }
  return ids
}

export function emitEvent (params, opts = {}) {
  const decision = evaluateEvent({
    cfg: config(),
    params,
    seen: seenIds(),
    now: Date.now(),
    busy: state.busy,
    isTest: Boolean(opts.isTest)
  })

  /* 同一线索的后续事件补给最近一张待批准候选，不新开卡片、不新开任务单 */
  if (decision.status === 'observed' && decision.params.threadId) {
    const target = [...events()].reverse().find(
      (e) => e.status === 'observed' && e.threadId === decision.params.threadId
    )
    if (target) {
      Object.assign(target, mergeIntoThread(target, decision.params))
      commit()
      return {
        ok: true, status: 'observed', merged: true, id: target.id,
        eventId: decision.params.eventId, reason: target.reason,
        threadCount: target.threadCount
      }
    }
  }

  const ev = makeEvent({
    params: decision.params,
    status: decision.status,
    reason: decision.reason,
    id: uid('ev')
  })
  events().push(ev)
  if (decision.status === 'auto' || decision.status === 'queued') enqueue(ev)
  commit()
  return {
    ok: decision.status !== 'rejected',
    status: decision.status,
    eventId: ev.eventId,
    id: ev.id,
    reason: ev.reason
  }
}

export function approveEvent (id) {
  const ev = events().find((e) => e.id === id)
  if (!ev) return { ok: false, error: '事件不存在' }
  if (ev.status !== 'observed') return { ok: false, error: '该事件不在待批准状态' }
  ev.mandate = makeMandate(ev)
  ev.status = 'queued'
  ev.reason = '已批准，等待执行'
  commit()
  enqueue(ev)
  return { ok: true, status: 'queued', mandate: ev.mandate }
}

export function ignoreEvent (id) {
  const ev = events().find((e) => e.id === id)
  if (!ev) return { ok: false, error: '事件不存在' }
  if (ev.status !== 'observed') return { ok: false, error: '该事件不在待批准状态' }
  ev.status = 'ignored'
  ev.reason = '已忽略'
  commit()
  return { ok: true, status: 'ignored' }
}

export function clearEvents () {
  config().events = []
  commit()
  toast('事件记录已清空', 'ok')
  return { ok: true }
}

function enqueue (ev) {
  if (queue.some((q) => q.id === ev.id)) return
  queue.push(ev)
  setTimeout(drain, 0)
}

/* 队列严格串行：一次只放行一张单，绝不引入第二个并发 run。 */
async function drain () {
  if (draining || state.busy || !queue.length) return
  draining = true
  const ev = queue.shift()
  try {
    await execute(ev)
  } finally {
    draining = false
    setTimeout(drain, 0)
  }
}

async function execute (ev) {
  const mandate = ev.mandate || makeMandate(ev)
  ev.mandate = mandate
  ev.status = 'executing'
  ev.reason = '正在执行'
  ev.attempts = (ev.attempts || 0) + 1
  commit()

  const payload = [
    `[事件单 ${mandate.id}]`,
    `来源：${ev.source} · 类型：${ev.type}${ev.threadId ? ' · 线程：' + ev.threadId : ''}`,
    '',
    ev.text,
    threadBlock(ev)
  ].filter(Boolean).join('\n')

  try {
    const res = await submit(payload)
    if (res && res.ok === false) {
      if (ev.attempts >= 3) {
        ev.status = 'failed'
        ev.reason = '应用持续忙碌，已放弃本单'
      } else {
        ev.status = 'queued'
        ev.reason = '应用忙，稍后重试'
        enqueue(ev)
      }
      commit()
      return
    }
    ev.status = 'executed'
    ev.reason = '已执行 · 1 次调用'
  } catch (err) {
    ev.status = 'failed'
    ev.reason = `执行失败：${String((err && err.message) || err).slice(0, 120)}`
  }
  commit()
}

export function queueLength () {
  return queue.length
}

export function mountTriggers () {
  if (mounted) return
  mounted = true
  config()
  /* 重启后不自动重跑未完成的单，避免半截任务自己接着跑 */
  for (const ev of events()) {
    if (ev.status === 'queued' || ev.status === 'executing') {
      ev.status = 'interrupted'
      ev.reason = '应用重启，未自动重跑'
    }
  }
  commit()
  bus.on('busy', (busy) => { if (!busy) setTimeout(drain, 0) })
}
