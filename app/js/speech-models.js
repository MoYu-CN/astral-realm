/* speech-models.js — 用户自备的 SenseVoice 本地模型管理 */

import { state, toast, persist } from './core.js'

export const SPEECH_MODEL_PAGE = 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/tree/main'

export function speechModels () {
  const speech = state.settings.speech || (state.settings.speech = {})
  if (!Array.isArray(speech.localModels)) speech.localModels = []
  return speech.localModels
}

export function selectedSpeechModel () {
  const speech = state.settings.speech || {}
  const list = speechModels()
  return list.find((model) => model.id === speech.localModelId) || list[0] || null
}

export function setSelectedSpeechModel (id) {
  const speech = state.settings.speech || (state.settings.speech = {})
  if (!speechModels().some((model) => model.id === id)) return null
  speech.localModelId = id
  persist.settings()
  return selectedSpeechModel()
}

export function removeSpeechModel (id) {
  const speech = state.settings.speech || (state.settings.speech = {})
  const list = speechModels()
  const idx = list.findIndex((model) => model.id === id)
  if (idx < 0) return
  list.splice(idx, 1)
  if (speech.localModelId === id) {
    speech.localModelId = list[0] ? list[0].id : ''
  }
  persist.settings()
}

function recordFromModel (model) {
  const now = Date.now()
  return {
    id: `sv_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: model.name || 'SenseVoice',
    dir: model.dir,
    modelFile: model.modelFile,
    tokensFile: model.tokensFile,
    size: model.size || 0,
    addedAt: now
  }
}

export async function addSpeechModelFromDialog () {
  if (!window.astral || !window.astral.pickSpeechModel) {
    toast('当前环境无法选择模型文件夹', 'err')
    return null
  }
  let res
  try {
    res = await window.astral.pickSpeechModel()
  } catch (err) {
    toast(err.message || '选择模型失败', 'err')
    return null
  }
  if (!res || res.canceled) return null
  if (!res.ok) {
    toast(res.error || '模型目录不可用', 'err')
    return null
  }
  const speech = state.settings.speech || (state.settings.speech = {})
  const list = speechModels()
  const existing = list.find((model) => String(model.dir).toLowerCase() === String(res.model.dir).toLowerCase())
  let record
  if (existing) {
    record = existing
    Object.assign(existing, {
      name: res.model.name,
      modelFile: res.model.modelFile,
      tokensFile: res.model.tokensFile,
      size: res.model.size || 0
    })
  } else {
    record = recordFromModel(res.model)
    list.push(record)
  }
  speech.localModelId = record.id
  persist.settings()
  toast(`语音模型已添加：${record.name}`, 'ok')
  return record
}

export async function inspectSelectedSpeechModel () {
  const model = selectedSpeechModel()
  if (!model) return { available: false, error: '尚未安装语音模型', missing: true }
  if (!window.astral || !window.astral.senseVoiceInfo) {
    return { available: false, error: '当前环境不支持 SenseVoice', missing: false }
  }
  try {
    const info = await window.astral.senseVoiceInfo({ modelDir: model.dir })
    return info || { available: false, error: '无法检查语音模型' }
  } catch (err) {
    return { available: false, error: err.message || '无法检查语音模型' }
  }
}

export async function openSpeechModelPage () {
  if (!window.astral || !window.astral.openExternal) {
    toast('当前环境无法打开下载页', 'err')
    return
  }
  const res = await window.astral.openExternal(SPEECH_MODEL_PAGE)
  if (res && res.ok === false) toast(res.error || '打开下载页失败', 'err')
}
