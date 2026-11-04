'use strict'

/* run-store.js — 持久化运行记录
 *
 * 运行（run）是一次用户指令触发的完整协作过程。它不属于某条消息，
 * 而是独立于 UI 的生命周期：开始、事件、结束、异常、中断。
 * 应用崩溃后下一次启动会把残留的 running 标记为 interrupted，并交给 UI 恢复。
 *
 * 文件：
 *   <config>/runs/index.json
 *   <config>/runs/events/<runId>.jsonl
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const STATUSES = new Set(['running', 'completed', 'failed', 'cancelled', 'interrupted', 'abandoned'])
const MAX_RUNS = 80
const MAX_EVENTS = 500

function safeId (value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120)
}

function atomicWriteJson (file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

function createRunStore ({ configDir }) {
  const root = path.join(configDir, 'runs')
  const eventsDir = path.join(root, 'events')
  const indexFile = path.join(root, 'index.json')
  let runs = []

  function loadIndex () {
    try {
      const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
      runs = Array.isArray(parsed && parsed.runs) ? parsed.runs : []
    } catch {
      runs = []
    }
  }

  function saveIndex () {
    atomicWriteJson(indexFile, { version: 1, runs })
  }

  function eventFile (id) {
    return path.join(eventsDir, `${safeId(id)}.jsonl`)
  }

  function appendEvent (id, type, data = {}) {
    const run = runs.find((item) => item.id === id)
    if (!run) return null
    const event = {
      ts: Date.now(),
      type: String(type || 'event').slice(0, 80),
      data: data && typeof data === 'object' ? data : { value: data }
    }
    try {
      fs.mkdirSync(eventsDir, { recursive: true })
      fs.appendFileSync(eventFile(id), `${JSON.stringify(event)}\n`, 'utf8')
    } catch {
      /* 事件写失败不阻塞运行；记录本身仍在 */
    }
    run.eventCount = (run.eventCount || 0) + 1
    run.updatedAt = event.ts
    run.lastEvent = event.type
    saveIndex()
    return event
  }

  function prune () {
    const keep = new Set(runs.slice(0, MAX_RUNS).map((run) => run.id))
    for (const run of runs.slice(MAX_RUNS)) {
      try { fs.rmSync(eventFile(run.id), { force: true }) } catch { /* ignore */ }
    }
    runs = runs.filter((run) => keep.has(run.id))
  }

  function init () {
    loadIndex()
    fs.mkdirSync(eventsDir, { recursive: true })
    let changed = false
    const now = Date.now()
    for (const run of runs) {
      if (run.status !== 'running') continue
      run.status = 'interrupted'
      run.interruptedAt = now
      run.updatedAt = now
      changed = true
      try {
        fs.appendFileSync(eventFile(run.id), `${JSON.stringify({
          ts: now,
          type: 'run_interrupted',
          data: { reason: '应用退出后未收到完成事件' }
        })}\n`, 'utf8')
      } catch { /* ignore */ }
    }
    if (changed) saveIndex()
    return runs
  }

  function start (payload = {}) {
    loadIndex()
    const now = Date.now()
    const id = `run_${now.toString(36)}_${crypto.randomBytes(4).toString('hex')}`
    const run = {
      id,
      projectId: safeId(payload.projectId),
      projectName: String(payload.projectName || '').slice(0, 120),
      agentId: String(payload.agentId || '').slice(0, 120),
      agentName: String(payload.agentName || '').slice(0, 120),
      thread: String(payload.thread || '').slice(0, 120),
      channel: payload.channel === 'agent' ? 'agent' : 'user',
      ownerTrust: String(payload.ownerTrust || '').slice(0, 40),
      prompt: String(payload.prompt || '').slice(0, 12000),
      status: 'running',
      startedAt: now,
      updatedAt: now,
      finishedAt: 0,
      eventCount: 0,
      lastEvent: 'run_started',
      error: ''
    }
    runs.unshift(run)
    prune()
    saveIndex()
    appendEvent(id, 'run_started', { agentName: run.agentName })
    return run
  }

  function event (id, type, data = {}) {
    loadIndex()
    return appendEvent(safeId(id), type, data)
  }

  function finish (id, status, extra = {}) {
    loadIndex()
    const run = runs.find((item) => item.id === safeId(id))
    if (!run) return null
    const next = STATUSES.has(status) ? status : 'failed'
    run.status = next
    run.updatedAt = Date.now()
    run.finishedAt = run.updatedAt
    if (extra && extra.error) run.error = String(extra.error).slice(0, 2000)
    if (next === 'interrupted') run.interruptedAt = run.updatedAt
    saveIndex()
    appendEvent(run.id, 'run_finished', {
      status: next,
      error: run.error,
      durationMs: Math.max(0, run.finishedAt - run.startedAt)
    })
    return { ...run }
  }

  function abandon (id) {
    loadIndex()
    const run = runs.find((item) => item.id === safeId(id))
    if (!run) return null
    run.status = 'abandoned'
    run.updatedAt = Date.now()
    run.finishedAt = run.updatedAt
    saveIndex()
    appendEvent(run.id, 'run_abandoned', {})
    return { ...run }
  }

  function list ({ limit = 20 } = {}) {
    loadIndex()
    return {
      ok: true,
      runs: runs
        .slice(0, Math.max(1, Math.min(MAX_RUNS, Number(limit) || 20)))
        .map((run) => ({ ...run }))
    }
  }

  function get (id) {
    loadIndex()
    const run = runs.find((item) => item.id === safeId(id))
    if (!run) return { ok: false, error: '没有这条运行记录' }
    const events = []
    try {
      const text = fs.readFileSync(eventFile(run.id), 'utf8')
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        try { events.push(JSON.parse(line)) } catch { /* ignore broken line */ }
        if (events.length >= MAX_EVENTS) break
      }
    } catch { /* 没有事件文件也返回记录 */ }
    return { ok: true, run: { ...run }, events }
  }

  init()
  return { start, event, finish, abandon, list, get, init }
}

module.exports = { createRunStore }
