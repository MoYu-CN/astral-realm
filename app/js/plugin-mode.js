/* plugin-mode.js — 插件制作对话的提示与开发文档入口
 *
 * 插件制作不再是输入区的临时开关：模式只在新对话创建时选择，
 * 并随会话保存。这里只负责判断当前会话是否处于插件模式、输入提示，
 * 以及打开插件开发文档。
 */

import { state, bus } from './core.js'
import { openPreview } from './dock.js'

const PLACEHOLDER = '描述你要做的插件：用途、触发时机、想要的界面…'

export function pluginModeOn () {
  return state.conversationMode === 'plugin'
}

/* 文档随 app 目录分发，开发版与打包版路径不同，统一按 dirs.app 拼 */
export function pluginGuidePath () {
  const app = (state.dirs && state.dirs.app) || ''
  if (!app) return 'docs/plugin-guide.md'
  const sep = app.includes('\\') ? '\\' : '/'
  return `${app}${sep}docs${sep}plugin-guide.md`
}

export function openPluginGuide () {
  openPreview(pluginGuidePath())
}

export function mountPluginGuide () {
  bus.on('plugin:open-guide', () => openPluginGuide())
}

export function pluginPlaceholder () {
  return PLACEHOLDER
}
