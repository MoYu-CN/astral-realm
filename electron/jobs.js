'use strict'

/* jobs.js — 持久化长任务
 *
 * 一条长任务由多个“步骤”组成；每个步骤对应一次普通星界回合。
 * 主进程只负责保存状态，真正执行由渲染层在用户点击开始/继续后驱动。
 * 应用如果在 running 状态退出，下次启动会把任务标成 interrupted。
 */

const fs = require('node:fs')
const path = require('node:path')

const MAX_JOBS = 60
const STATUS = new Set(['idle', 'scheduled', 'running', 'paused', 'interrupted', 'completed', 'failed'])

function now () { return Date.now() }

function createJobStore ({ configDir }) {
  const file = path.join(configDir, 'jobs.json')
  let data = { version: 1, jobs: [] }

  function read () {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (parsed && Array.isArray(parsed.jobs)) data = { version: 1, jobs: parsed.jobs }
    } catch { /* first run */ }
  }

  function write () {
    fs.mkdirSync(configDir, { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  }

  function normalize (job) {
    if (!job || typeof job !== 'object') return null
    const steps = Array.isArray(job.steps)
      ? job.steps.map((step, index) => ({
        id: String(step.id || `step_${index + 1}`),
        title: String(step.title || step.prompt || `步骤 ${index + 1}`),
        prompt: String(step.prompt || ''),
        status: ['pending', 'running', 'done', 'failed', 'cancelled'].includes(step.status) ? step.status : 'pending',
        attempts: Number(step.attempts) || 0,
        result: String(step.result || ''),
        error: String(step.error || ''),
        runId: String(step.runId || '')
      }))
      : []
    return {
      id: String(job.id || ''),
      title: String(job.title || '未命名长任务'),
      projectId: String(job.projectId || ''),
      projectName: String(job.projectName || ''),
      status: STATUS.has(job.status) ? job.status : 'idle',
      currentStep: Math.max(0, Math.min(steps.length, Number(job.currentStep) || 0)),
      schedule: job.schedule && typeof job.schedule === 'object'
        ? {
          repeat: job.schedule.repeat === 'daily' ? 'daily' : 'none',
          time: String(job.schedule.time || ''),
          at: String(job.schedule.at || '')
        }
        : null,
      nextRunAt: Number(job.nextRunAt) || 0,
      steps,
      createdAt: Number(job.createdAt) || now(),
      updatedAt: Number(job.updatedAt) || now()
    }
  }

  function init () {
    read()
    let changed = false
    for (const job of data.jobs) {
      if (!job || job.status !== 'running') continue
      job.status = 'interrupted'
      job.updatedAt = now()
      for (const step of job.steps || []) {
        if (step && step.status === 'running') step.status = 'cancelled'
      }
      changed = true
    }
    if (changed) write()
  }

  function list ({ projectId = '', limit = MAX_JOBS } = {}) {
    const jobs = data.jobs
      .filter((job) => !projectId || job.projectId === projectId)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, Math.max(1, Math.min(MAX_JOBS, Number(limit) || MAX_JOBS)))
    return { ok: true, jobs }
  }

  function get (id) {
    return data.jobs.find((job) => job.id === id) || null
  }

  function create (payload = {}) {
    const steps = Array.isArray(payload.steps) ? payload.steps : []
    if (!steps.length) return { ok: false, error: '长任务至少需要一个步骤' }
    const job = normalize({
      id: `job_${now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      title: payload.title,
      projectId: payload.projectId,
      projectName: payload.projectName,
      status: payload.nextRunAt ? 'scheduled' : 'idle',
      currentStep: 0,
      schedule: payload.schedule || null,
      nextRunAt: Number(payload.nextRunAt) || 0,
      steps: steps.map((step, index) => ({
        id: `step_${index + 1}_${Math.random().toString(36).slice(2, 5)}`,
        title: step.title || step.prompt,
        prompt: step.prompt,
        status: 'pending',
        attempts: 0
      })),
      createdAt: now(),
      updatedAt: now()
    })
    data.jobs.unshift(job)
    data.jobs = data.jobs.slice(0, MAX_JOBS)
    write()
    return { ok: true, job }
  }

  function update (id, patch = {}) {
    const job = get(id)
    if (!job) return { ok: false, error: '找不到长任务' }
    if (patch.status && STATUS.has(patch.status)) job.status = patch.status
    if (patch.currentStep !== undefined) {
      job.currentStep = Math.max(0, Math.min(job.steps.length, Number(patch.currentStep) || 0))
    }
    if (patch.schedule !== undefined) {
      job.schedule = patch.schedule && typeof patch.schedule === 'object'
        ? {
          repeat: patch.schedule.repeat === 'daily' ? 'daily' : 'none',
          time: String(patch.schedule.time || ''),
          at: String(patch.schedule.at || '')
        }
        : null
    }
    if (patch.nextRunAt !== undefined) job.nextRunAt = Number(patch.nextRunAt) || 0
    if (Array.isArray(patch.steps)) {
      job.steps = patch.steps.map((step, index) => ({
        id: String(step.id || `step_${index + 1}`),
        title: String(step.title || step.prompt || `步骤 ${index + 1}`),
        prompt: String(step.prompt || ''),
        status: ['pending', 'running', 'done', 'failed', 'cancelled'].includes(step.status) ? step.status : 'pending',
        attempts: Number(step.attempts) || 0,
        result: String(step.result || ''),
        error: String(step.error || ''),
        runId: String(step.runId || '')
      })).slice(0, 40)
    }
    if (patch.title) job.title = String(patch.title)
    job.updatedAt = now()
    write()
    return { ok: true, job }
  }

  function remove (id) {
    const before = data.jobs.length
    data.jobs = data.jobs.filter((job) => job.id !== id)
    if (data.jobs.length === before) return { ok: false, error: '找不到长任务' }
    write()
    return { ok: true }
  }

  init()

  return { init, list, get, create, update, remove, file }
}

module.exports = { createJobStore }

