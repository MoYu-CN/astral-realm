/* knowledge-onboarding.js — 首次启动时询问是否启用知识库插件 */

import { state, h } from './core.js'
import { openModal, closeModal } from './modal.js'

function settingFor (id) {
  if (!state.settings.plugins) state.settings.plugins = {}
  return state.settings.plugins[id] || {}
}

export function maybeAskKnowledgePlugin () {
  const manifest = (state.plugins || []).find((plugin) => plugin.id === 'knowledge')
  if (!manifest) return Promise.resolve(false)
  if (!state.settings.onboarding) state.settings.onboarding = {}
  if (state.settings.onboarding.knowledgePrompted) return Promise.resolve(false)

  const current = settingFor('knowledge')
  const defaultOn = typeof current.enabled === 'boolean'
    ? current.enabled
    : manifest.defaultEnabled !== false

  return new Promise((resolve) => {
    let settled = false

    const finish = async (enabled) => {
      if (settled) return
      settled = true
      state.settings.plugins.knowledge = {
        ...(state.settings.plugins.knowledge || {}),
        enabled: Boolean(enabled)
      }
      state.settings.onboarding.knowledgePrompted = true
      closeModal()
      try {
        await window.astral.saveConfig('settings.json', state.settings)
      } catch {
        /* 内存状态已足够本次启动；下一次仍以文件为准 */
      }
      resolve(Boolean(enabled))
    }

    const enable = h('button', {
      class: 'btn primary',
      type: 'button',
      text: '启用知识库',
      onclick: () => finish(true)
    })
    const disable = h('button', {
      class: 'btn ghost',
      type: 'button',
      text: '暂不启用',
      onclick: () => finish(false)
    })

    openModal({
      title: '启用内置知识库？',
      sub: '首次启动 · 知识库插件',
      width: 640,
      onClose: () => { finish(defaultOn) },
      render: (body) => {
        body.append(
          h('div', { class: 'onboarding-knowledge' },
            h('div', { class: 'kb-onboarding-mark', text: '◈' }),
            h('div', { class: 'kb-onboarding-copy' },
              h('p', { text: '星界内置知识库插件，用来按项目沉淀资料、可复用方法和踩过的坑。' }),
              h('p', { class: 'hint', text: '启用后，右侧会多出一个「知识库」面板：可以新建、搜索、编辑条目，也可以把条目引用到输入框。' }),
              h('p', { class: 'hint', text: '默认建议开启；选择「暂不启用」后插件保持关闭，之后可以在右侧「插件」面板手动启用。' })
            )
          ),
          h('div', { class: 'btn-row', style: { marginTop: '18px', justifyContent: 'flex-end' } }, enable, disable)
        )
      }
    })
  })
}
