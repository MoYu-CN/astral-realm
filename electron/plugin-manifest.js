'use strict'

/**
 * 插件清单归一化与运行时判定。
 *
 * 放在独立模块里，主进程与测试共用；不依赖 Electron，便于纯 Node 测试。
 *
 * 策略：
 *   isolated —— 唯一支持的运行时：无同源权限的 iframe 沙箱。
 *   legacy   —— 旧版渲染层运行时，已限制：没有沙箱、能直接读主界面 DOM，
 *               不再执行；旧 manifest 会被识别并给出迁移提示。
 *
 * 这条限制只针对「旧版运行时」，不针对「外部插件」：
 * 放在 config/plugins 的第三方插件不受来源限制，声明 runtime: "isolated"
 * 即可正常加载。
 */

const RUNTIME_ISOLATED = 'isolated'
const RUNTIME_LEGACY = 'legacy'
const SUPPORTED_RUNTIMES = [RUNTIME_ISOLATED]
const LEGACY_RUNTIME_ERROR = '旧版插件运行时已限制：请把 plugin.json 的 runtime 改为 "isolated" 并按沙箱 API 迁移；外部插件使用 isolated 不受限制'
const INVALID_RUNTIME_ERROR = '不支持的插件运行时：只支持 "isolated"'

function normalizeRuntime (raw) {
  const value = raw === undefined || raw === null ? '' : String(raw).trim()
  if (value === RUNTIME_ISOLATED) {
    return { runtime: RUNTIME_ISOLATED, isolated: true, error: '' }
  }
  if (!value) {
    return { runtime: RUNTIME_LEGACY, isolated: false, error: LEGACY_RUNTIME_ERROR }
  }
  if (value === RUNTIME_LEGACY) {
    return { runtime: RUNTIME_LEGACY, isolated: false, error: LEGACY_RUNTIME_ERROR }
  }
  return { runtime: RUNTIME_LEGACY, isolated: false, error: `${INVALID_RUNTIME_ERROR}（收到：${value}）` }
}

function normalizePluginManifest (manifest, scope, dirName) {
  const source = manifest && typeof manifest === 'object' ? manifest : {}
  const runtime = normalizeRuntime(source.runtime)
  const out = {
    ...source,
    id: String(source.id || '').trim(),
    name: String(source.name || source.id || '未命名插件'),
    version: String(source.version || '0.0.0'),
    description: String(source.description || ''),
    author: String(source.author || ''),
    entry: String(source.entry || 'plugin.js'),
    apiVersion: Number(source.apiVersion || 1),
    defaultEnabled: source.defaultEnabled !== false,
    runtime: runtime.runtime,
    isolated: runtime.isolated,
    scope,
    dir: dirName,
    manifestError: runtime.error
  }
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(out.id)) out.manifestError = '插件 id 只能包含字母、数字、下划线和短横线'
  else if (!/^[A-Za-z0-9_.-]+$/.test(out.entry) || out.entry.includes('..')) out.manifestError = '插件 entry 必须是插件目录内的文件名'
  else if (out.apiVersion !== 1) out.manifestError = `不支持的插件 API 版本：${out.apiVersion}`
  if (Array.isArray(source.permissions)) {
    out.permissions = source.permissions.map(String).filter(Boolean)
    out.legacyPermissions = false
  } else {
    /* 外部插件没有声明权限时保持全权限兼容；面板会标「旧版权限」。 */
    out.permissions = ['*']
    out.legacyPermissions = true
  }
  out.settings = Array.isArray(source.settings)
    ? source.settings
      .filter((field) => field && typeof field.key === 'string' && field.key.trim())
      .map((field) => ({
        key: field.key.trim(),
        label: String(field.label || field.key),
        type: ['text', 'number', 'boolean', 'select', 'path'].includes(field.type) ? field.type : 'text',
        default: field.default,
        hint: String(field.hint || ''),
        options: Array.isArray(field.options) ? field.options.map((option) => ({
          value: String(option && option.value !== undefined ? option.value : option),
          label: String(option && option.label !== undefined ? option.label : option)
        })) : []
      }))
    : []
  return out
}

module.exports = {
  RUNTIME_ISOLATED,
  RUNTIME_LEGACY,
  SUPPORTED_RUNTIMES,
  LEGACY_RUNTIME_ERROR,
  INVALID_RUNTIME_ERROR,
  normalizeRuntime,
  normalizePluginManifest
}
