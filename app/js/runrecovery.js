/* runrecovery.js — 启动时处理上次未完成的运行 */

import { activeProject, h, toast } from './core.js'
import { openModal, closeModal } from './modal.js'
import { recoverableRuns, abandonRun } from './runs.js'
import { submit } from './orchestrator.js'

function timeLabel (ts) {
  if (!ts) return ''
  const date = new Date(ts)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString('zh-CN', { hour12: false })
}

export async function mountRunRecovery () {
  const all = await recoverableRuns()
  if (!all.length) return
  const project = activeProject()
  const runs = all.filter((run) => !run.projectId || !project || run.projectId === project.id)
  if (!runs.length) return

  const list = h('div', { class: 'run-recovery-list' })
  for (const run of runs) {
    const retry = h('button', {
      class: 'btn ghost',
      type: 'button',
      text: '重试',
      onclick: async () => {
        await abandonRun(run.id)
        closeModal()
        const res = await submit(run.prompt || '')
        if (res && res.ok === false && res.message) toast(res.message, 'err')
      }
    })
    const abandon = h('button', {
      class: 'btn ghost',
      type: 'button',
      text: '放弃',
      onclick: async () => {
        await abandonRun(run.id)
        run.el.remove()
        if (!list.querySelector('.run-recovery-item')) closeModal()
      }
    })
    const item = h('div', { class: 'run-recovery-item' },
      h('div', { class: 'run-recovery-main' },
        h('div', { class: 'run-recovery-title', text: run.agentName || run.projectName || '未命名运行' }),
        h('div', { class: 'run-recovery-meta', text: `${timeLabel(run.startedAt)} · ${run.projectName || '默认项目'}` }),
        h('div', { class: 'run-recovery-prompt', text: String(run.prompt || '').slice(0, 300) })
      ),
      h('div', { class: 'run-recovery-actions' }, retry, abandon)
    )
    run.el = item
    list.append(item)
  }

  const close = h('button', { class: 'btn ghost', type: 'button', text: '稍后处理', onclick: () => closeModal() })
  const allAbandon = h('button', {
    class: 'btn ghost',
    type: 'button',
    text: '全部放弃',
    onclick: async () => {
      for (const run of runs) await abandonRun(run.id)
      closeModal()
    }
  })

  openModal({
    title: '上次运行没有完成',
    sub: '应用退出时这些任务仍在运行',
    width: 720,
    render: (body) => {
      body.append(
        h('div', { class: 'hint', style: { lineHeight: '1.75' }, text: '这不是模型回复失败，而是应用在任务完成前退出了。可以重试原任务，或放弃这些记录。' }),
        list,
        h('div', { class: 'btn-row', style: { marginTop: '14px', justifyContent: 'flex-end' } }, allAbandon, close)
      )
    }
  })
}
