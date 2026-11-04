/* jobs.js — 持久化长任务的渲染层执行器 */

import { state, activeProject, bus, toast, commander } from './core.js'
import { submit, cancelCurrentTurn } from './orchestrator.js'
import { callModel } from './llm.js'

let runningJobId = ''
let pauseRequested = false

const STATUS_LABEL = {
  idle: '待开始',
  scheduled: '定时等待',
  running: '执行中',
  paused: '已暂停',
  interrupted: '上次中断',
  completed: '已完成',
  failed: '失败'
}
let schedulerTimer = null
let schedulerBusy = false

function nextDailyAt (time) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''))
  if (!match) return 0
  const now = new Date()
  const next = new Date(now)
  next.setHours(Number(match[1]), Number(match[2]), 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime()
}

function nextRunForSchedule (schedule) {
  if (!schedule) return 0
  if (schedule.at) {
    const at = Date.parse(schedule.at)
    return Number.isFinite(at) ? at : 0
  }
  if (schedule.repeat === 'daily') return nextDailyAt(schedule.time)
  return 0
}

export function jobStatusLabel (status) {
  return STATUS_LABEL[status] || status || '未知'
}

export function activeJobId () {
  return runningJobId
}

export async function loadJobs () {
  if (!window.astral || typeof window.astral.jobList !== 'function') return []
  const project = activeProject()
  try {
    const res = await window.astral.jobList({ projectId: project ? project.id : '' })
    state.jobs = (res && Array.isArray(res.jobs) ? res.jobs : [])
  } catch {
    state.jobs = []
  }
  bus.emit('jobs:changed')
  return state.jobs
}

function upsertLocal (job) {
  if (!job) return
  const index = state.jobs.findIndex((item) => item.id === job.id)
  if (index >= 0) state.jobs[index] = job
  else state.jobs.unshift(job)
}

async function persistJob (job, patch = {}) {
  Object.assign(job, patch, { updatedAt: Date.now() })
  upsertLocal(job)
  bus.emit('jobs:changed')
  if (!window.astral || typeof window.astral.jobUpdate !== 'function') return job
  try {
    const res = await window.astral.jobUpdate({
      id: job.id,
      status: job.status,
      currentStep: job.currentStep,
      schedule: job.schedule,
      nextRunAt: job.nextRunAt,
      steps: job.steps
    })
    if (res && res.ok && res.job) upsertLocal(res.job)
  } catch { /* 本地状态已经更新，落盘失败只影响下次启动 */ }
  return job
}

export async function decomposeGoal (objective) {
  const goal = String(objective || '').trim()
  if (!goal) throw new Error('目标不能为空')
  const base = commander() || state.roster.agents.find((agent) => agent.enabled !== false)
  if (!base) throw new Error('编制里没有可用成员，无法调用拆解模型')
  const override = state.settings.chatModel
  const agent = override
    ? { ...base, providerId: override.providerId, model: override.model }
    : base
  const messages = [
    {
      role: 'system',
      content: [
        '你是任务拆解器。把用户目标拆成 2-6 个按顺序执行的步骤。',
        '每一步都必须是一条可以直接交给 AI 执行的具体指令，不要写“思考”“分析一下”这种空步骤。',
        '只输出 JSON 数组，元素格式：{"title":"短标题","prompt":"完整可执行指令"}。',
        '不要输出 markdown 代码块，不要输出解释。'
      ].join('\n')
    },
    { role: 'user', content: goal }
  ]
  const raw = await callModel(agent, messages, { maxTokens: 1200, temperature: 0.2 })
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  let parsed = null
  try { parsed = JSON.parse(text) } catch {
    const match = /\[[\s\S]*\]/.exec(text)
    if (match) {
      try { parsed = JSON.parse(match[0]) } catch { /* handled below */ }
    }
  }
  if (!Array.isArray(parsed)) throw new Error('拆解模型没有返回合法 JSON 数组')
  const steps = parsed
    .map((step, index) => {
      if (typeof step === 'string') return { title: `步骤 ${index + 1}`, prompt: step.trim() }
      if (!step || typeof step !== 'object') return null
      const prompt = String(step.prompt || step.task || step.text || '').trim()
      if (!prompt) return null
      return { title: String(step.title || `步骤 ${index + 1}`).trim(), prompt }
    })
    .filter(Boolean)
    .slice(0, 8)
  if (!steps.length) throw new Error('拆解结果里没有可执行步骤')
  return steps
}

export async function createJob ({ title, steps, schedule = null, nextRunAt = 0 }) {
  const project = activeProject()
  const prompts = (steps || []).map((step) => String(step.prompt || step || '').trim()).filter(Boolean)
  if (!prompts.length) {
    toast('长任务至少需要一个步骤', 'err')
    return null
  }
  if (!window.astral || typeof window.astral.jobCreate !== 'function') {
    toast('长任务存储不可用', 'err')
    return null
  }
  const plannedAt = Number(nextRunAt) || nextRunForSchedule(schedule)
  if (schedule && !plannedAt) {
    toast('定时时间无效', 'err')
    return null
  }
  try {
    const res = await window.astral.jobCreate({
      title: String(title || '').trim() || '未命名长任务',
      projectId: project ? project.id : '',
      projectName: project ? project.name : '',
      schedule: schedule || null,
      nextRunAt: plannedAt,
      steps: prompts.map((prompt, index) => ({ title: `步骤 ${index + 1}`, prompt }))
    })
    if (!res || res.ok === false) {
      toast(res && res.error ? res.error : '创建长任务失败', 'err')
      return null
    }
    upsertLocal(res.job)
    bus.emit('jobs:changed')
    return res.job
  } catch (err) {
    toast(`创建长任务失败：${err.message}`, 'err')
    return null
  }
}

export async function startJob (id) {
  const job = state.jobs.find((item) => item.id === id)
  if (!job) {
    toast('找不到这条长任务', 'err')
    return false
  }
  if (runningJobId) {
    toast('已有长任务在执行', 'err')
    return false
  }
  if (state.busy) {
    toast('当前有回合正在进行，结束或暂停后再开始长任务', 'err')
    return false
  }
  const project = activeProject()
  if (job.projectId && project && job.projectId !== project.id) {
    toast('这条长任务属于其他项目，请先切回对应项目', 'err')
    return false
  }

  runningJobId = job.id
  pauseRequested = false
  await persistJob(job, { status: 'running' })

  try {
    for (;;) {
      if (pauseRequested || job.status === 'paused') break
      const currentProject = activeProject()
      if (job.projectId && currentProject && job.projectId !== currentProject.id) {
        await persistJob(job, { status: 'paused' })
        break
      }
      if (job.currentStep >= job.steps.length) {
        await persistJob(job, { status: 'completed' })
        break
      }
      const step = job.steps[job.currentStep]
      if (!step || !String(step.prompt || '').trim()) {
        step.status = 'failed'
        step.error = '步骤内容为空'
        await persistJob(job, { status: 'failed' })
        break
      }
      step.status = 'running'
      step.error = ''
      await persistJob(job, { status: 'running' })
      bus.emit('status', `长任务：${job.title} · ${step.title}`)

      const res = await submit(step.prompt)
      if (pauseRequested) {
        step.status = 'cancelled'
        await persistJob(job, { status: 'paused' })
        break
      }
      if (res && res.status === 'cancelled') {
        step.status = 'cancelled'
        await persistJob(job, { status: 'paused' })
        break
      }
      if (!res || res.ok === false || (res.status && res.status !== 'completed')) {
        step.attempts = (Number(step.attempts) || 0) + 1
        const maxAttempts = Math.max(1, Math.min(5, Number(state.settings.jobs && state.settings.jobs.stepAttempts) || 2))
        if (step.attempts < maxAttempts && !pauseRequested) {
          step.status = 'pending'
          step.error = res && res.message ? res.message : '步骤执行失败'
          await persistJob(job, { status: 'running' })
          bus.emit('status', `长任务重试：${job.title} · ${step.title} · 第 ${step.attempts + 1} 次`)
          await new Promise((resolve) => setTimeout(resolve, 600 * step.attempts))
          continue
        }
        step.status = 'failed'
        step.error = res && res.message ? res.message : '步骤执行失败'
        await persistJob(job, { status: 'failed' })
        break
      }
      step.status = 'done'
      step.result = String(res.text || '').slice(0, 2000)
      job.currentStep += 1
      await persistJob(job, { status: 'running' })
    }
  } catch (err) {
    await persistJob(job, { status: 'failed' })
    toast(`长任务失败：${err.message}`, 'err')
  } finally {
    if (!pauseRequested && job.status === 'completed') toast(`长任务完成：${job.title}`, 'ok')
    runningJobId = ''
  }
  const completed = job.status === 'completed'
  if (completed && job.schedule && job.schedule.repeat === 'daily') {
    for (const step of job.steps) {
      step.status = 'pending'
      step.attempts = 0
      step.result = ''
      step.error = ''
    }
    job.currentStep = 0
    job.nextRunAt = nextDailyAt(job.schedule.time)
    await persistJob(job, { status: 'scheduled' })
    toast(`长任务已排到下次：${job.title}`, 'ok')
  }
  return completed
}

export async function startAllInterrupted () {
  if (runningJobId || state.busy) return false
  const pending = state.jobs.filter((job) => job.status === 'interrupted' || job.status === 'paused')
  if (!pending.length) return false
  for (const job of pending) {
    if (runningJobId || state.busy) break
    const ok = await startJob(job.id)
    if (!ok) break
  }
  return true
}

export async function checkScheduledJobs () {
  if (runningJobId || state.busy || schedulerBusy) return false
  const due = state.jobs.find((job) => job.status === 'scheduled' && job.nextRunAt && job.nextRunAt <= Date.now())
  if (!due) return false
  schedulerBusy = true
  try {
    await startJob(due.id)
  } finally {
    schedulerBusy = false
  }
  return true
}

export function startJobScheduler () {
  if (schedulerTimer) return
  schedulerTimer = setInterval(() => { checkScheduledJobs().catch(() => {}) }, 20000)
  checkScheduledJobs().catch(() => {})
}

export function stopJobScheduler () {
  if (!schedulerTimer) return
  clearInterval(schedulerTimer)
  schedulerTimer = null
}

export async function maybeResumeJobs () {
  const cfg = state.settings.jobs || {}
  if (!cfg.autoResume) return false
  return startAllInterrupted()
}

export async function pauseJob (id) {
  const job = state.jobs.find((item) => item.id === id)
  if (!job) return false
  pauseRequested = true
  if (runningJobId === id) {
    if (state.busy) cancelCurrentTurn()
    await persistJob(job, { status: 'paused' })
  } else {
    await persistJob(job, { status: 'paused' })
  }
  return true
}

export async function removeJob (id) {
  if (runningJobId === id) {
    pauseRequested = true
    if (state.busy) cancelCurrentTurn()
  }
  if (window.astral && typeof window.astral.jobRemove === 'function') {
    await window.astral.jobRemove(id)
  }
  state.jobs = state.jobs.filter((job) => job.id !== id)
  bus.emit('jobs:changed')
  return true
}
