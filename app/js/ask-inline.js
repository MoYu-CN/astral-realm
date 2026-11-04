/* ask-inline.js — 对话流内的提问卡片。
 * 不使用弹窗或遮罩；选项、自由输入、提交/跳过和结果摘要都留在消息流里。
 */

import { h } from './core.js'

function cancelResult (message) {
  return { ok: false, cancelled: true, error: message }
}

export function createInlineAsk (payload) {
  const {
    id,
    agentName,
    question,
    context,
    options = [],
    multiple = false,
    allowFreeform = true,
    placeholder = '补充说明（可选）',
    resolve
  } = payload

  const selected = new Map()
  let submitting = false
  let closed = false
  let submitTimer = null

  const errorEl = h('div', { class: 'ask-error', hidden: true })
  const statusText = h('span', { text: '等待你的选择' })
  const status = h('div', { class: 'ask-status' },
    h('i', { class: 'ask-spinner', 'aria-hidden': 'true' }),
    statusText
  )
  const optionsEl = h('div', { class: 'ask-options' })
  const freeform = allowFreeform
    ? h('textarea', {
      class: 'note-area ask-freeform',
      placeholder,
      maxlength: '4000'
    })
    : null
  const submit = h('button', { class: 'btn primary', type: 'button', text: '提交回答' })
  const skip = h('button', { class: 'btn ghost', type: 'button', text: '跳过' })

  const questionEl = h('div', { class: 'ask-question', text: question })
  const contextEl = context ? h('div', { class: 'ask-context', text: context }) : null

  function setError (message) {
    errorEl.hidden = !message
    errorEl.textContent = message || ''
    status.classList.toggle('is-error', Boolean(message))
  }

  function paintOptions () {
    optionsEl.textContent = ''
    for (const option of options) {
      const on = selected.has(option.value)
      optionsEl.append(h('button', {
        class: 'ask-option' + (on ? ' is-selected' : ''),
        type: 'button',
        'aria-pressed': on ? 'true' : 'false',
        dataset: { askValue: option.value },
        onclick: () => {
          if (submitting || closed) return
          if (multiple) {
            if (selected.has(option.value)) selected.delete(option.value)
            else selected.set(option.value, option)
          } else {
            selected.clear()
            selected.set(option.value, option)
          }
          setError('')
          paintOptions()
        }
      },
      h('span', { class: 'ask-option-mark', 'aria-hidden': 'true' }, multiple ? (on ? '✓' : '') : (on ? '●' : '○')),
      h('span', { class: 'ask-option-copy' },
        h('span', { class: 'ask-option-label', text: option.label }),
        option.description ? h('span', { class: 'ask-option-desc', text: option.description }) : null
      )
      ))
    }
  }

  function doSubmit () {
    if (submitting || closed) return
    const free = freeform ? freeform.value.trim().slice(0, 4000) : ''
    const picks = [...selected.values()]
    const answer = [picks.map((option) => option.label).join('、'), free].filter(Boolean).join('\n')
    if (!picks.length && !free) {
      setError('请选择一个选项，或填写补充说明后再提交。')
      return
    }
    submitting = true
    submit.disabled = true
    skip.disabled = true
    setError('')
    status.classList.add('is-submitting')
    statusText.textContent = '正在提交…'
    const result = {
      ok: true,
      answer,
      selected: picks.map((option) => ({ label: option.label, value: option.value })),
      freeform: free,
      multiple
    }
    submitTimer = setTimeout(() => resolve(result), 90)
  }

  submit.addEventListener('click', doSubmit)
  skip.addEventListener('click', () => resolve(cancelResult('用户跳过了提问')))
  if (freeform) {
    freeform.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault()
        doSubmit()
      }
    })
  }

  const formEl = h('div', { class: 'ask-inline-form' },
    contextEl,
    questionEl,
    options.length
      ? h('div', { class: 'ask-label', text: multiple ? '可以选择多项' : '选择一个选项，或直接补充' })
      : null,
    options.length ? optionsEl : null,
    freeform
      ? h('div', { class: 'ask-freeform-wrap' },
        h('div', { class: 'ask-label', text: '补充说明' }),
        freeform)
      : null,
    errorEl,
    status,
    h('div', { class: 'btn-row ask-actions' }, skip, submit)
  )

  const node = h('div', {
    class: 'msg ask-inline',
    role: 'group',
    dataset: { askId: id }
  },
  h('div', { class: 'ask-inline-head' },
    h('span', { class: 'ask-inline-label', text: '需要你的补充' }),
    h('span', { class: 'ask-inline-agent', text: agentName || '协作成员' })
  ),
  formEl
  )

  paintOptions()
  setTimeout(() => {
    const first = optionsEl.querySelector('.ask-option') || freeform
    if (first) first.focus()
  }, 40)

  function close (result) {
    if (closed) return
    closed = true
    if (submitTimer) clearTimeout(submitTimer)
    submit.disabled = true
    skip.disabled = true
    formEl.hidden = true
    const ok = Boolean(result && result.ok)
    const canceled = Boolean(result && result.cancelled)
    const timeout = Boolean(result && result.timeout)
    const summary = ok
      ? `已回答：${String(result.answer || '').slice(0, 400)}`
      : timeout
        ? '提问已超时'
        : canceled
          ? '已跳过这个问题'
          : `提问失败：${(result && result.error) || '未知错误'}`
    node.classList.add(ok ? 'is-answered' : 'is-cancelled')
    node.append(h('div', { class: 'ask-inline-result' },
      h('span', { class: 'ask-inline-result-label', text: ok ? '已回答' : (timeout ? '超时' : '已跳过') }),
      h('span', { class: 'ask-inline-result-text', text: summary })
    ))
  }

  return { id, node, close }
}
