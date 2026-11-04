/* speech.js — 功能条语音转写
 *
 * 交互（不再需要弹层里再点一次“开始录音”）：
 *   idle --点击按钮--> recording（按钮立刻显示“正在录音”）
 *   recording --再点一次--> converting --完成--> 填入输入框 --回到 idle
 *
 * 引擎：
 *   sensevoice：复用 DSH 的 SenseVoice 本地模型（默认优先，离线、质量高）
 *   windows：Windows 本机 System.Speech（兜底）
 *   browser：浏览器 Web Speech（部分环境可用）
 *   server ：MediaRecorder 录音 + OpenAI 兼容 /audio/transcriptions
 */

import { state, $, bus, h, toast, providerById } from './core.js'
import { isReadonlyView } from './viewswitch.js'
import { openModal, closeModal } from './modal.js'
import {
  selectedSpeechModel, addSpeechModelFromDialog, openSpeechModelPage
} from './speech-models.js'

const REC_EXT = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav'
}

let active = null
let voiceButton = null

export function speechSettings () {
  if (!state.settings.speech) state.settings.speech = {}
  const s = state.settings.speech
  if (!s.engine) s.engine = 'auto'
  if (!s.lang) s.lang = 'zh-CN'
  if (!s.model) s.model = 'whisper-1'
  return s
}

export function hasBrowserEngine () {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
}

export function hasWindowsEngine () {
  return Boolean(window.astral && typeof window.astral.speechStart === 'function')
}

export function hasSenseVoiceEngine () {
  return Boolean(window.astral && typeof window.astral.senseVoiceTranscribe === 'function')
}

/* 服务端转写首选用户在设置里指定的供应商，否则取第一个可用的 openai 兼容供应商 */
export function transcribeProvider () {
  const s = speechSettings()
  const forced = s.providerId ? providerById(s.providerId) : null
  if (forced && forced.enabled !== false) return forced
  const list = (state.providers.providers || []).filter((p) => p.enabled !== false)
  return list.find((p) => p.kind === 'openai' && p.hasKey) ||
    list.find((p) => p.kind === 'ollama') ||
    null
}

function chooseEngine () {
  const pref = speechSettings().engine || 'auto'
  const model = selectedSpeechModel()
  const senseVoice = hasSenseVoiceEngine() && Boolean(model)
  if (pref === 'sensevoice') return senseVoice ? 'sensevoice' : null
  if (pref === 'windows') return hasWindowsEngine() ? 'windows' : null
  if (pref === 'browser') return hasBrowserEngine() ? 'browser' : null
  if (pref === 'server') return transcribeProvider() ? 'server' : null
  if (senseVoice) return 'sensevoice'
  return null
}

function humanizeError (message) {
  const text = String(message || '')
  if (/no-recognizer/i.test(text)) return 'Windows 没有安装可用的中文语音识别器'
  if (/audio-capture|no-mic|not-allowed|NotFoundError|PermissionDenied/i.test(text)) {
    return '没有可用的麦克风，或系统未允许访问麦克风'
  }
  if (/powershell-start-failed/i.test(text)) return 'Windows 本机语音服务启动失败'
  if (/start-failed/i.test(text)) return `本机语音识别启动失败：${text.replace(/^start-failed:\s*/i, '')}`
  if (/SenseVoice|sherpa-onnx|OfflineRecognizer/i.test(text)) return `本地语音模型不可用：${text}`
  if (/no-speech/i.test(text)) return '没有听到声音'
  if (/network/i.test(text)) return '语音服务不可达'
  if (/没有可用于转写的供应商/.test(text)) return text
  return text || '语音转换失败'
}

function labelOf (btn) {
  return btn && (btn.querySelector('.tool-label') || btn)
}

function paintButton (stage) {
  const btn = voiceButton
  if (!btn) return
  const label = labelOf(btn)
  btn.classList.remove('active', 'recording', 'busy')
  if (stage === 'recording') {
    btn.classList.add('active', 'recording')
    label.textContent = '正在录音'
    btn.title = '正在录音，点击结束并转写'
  } else if (stage === 'converting') {
    btn.classList.add('active', 'busy')
    label.textContent = '转换中…'
    btn.title = '正在转换语音，请稍候'
  } else {
    label.textContent = '语音'
    const pref = speechSettings().engine || 'auto'
    const needsModel = pref === 'auto' || pref === 'sensevoice'
    if (needsModel && !selectedSpeechModel()) btn.title = '点击安装本地语音模型'
    else btn.title = chooseEngine() ? '点击开始语音转写' : '当前没有可用的语音识别引擎'
  }
}

function updateLiveTitle (session) {
  if (!voiceButton || active !== session) return
  const tail = (session.live || session.final || '').slice(-46)
  voiceButton.title = tail
    ? `正在录音：${tail} · 点击结束并转写`
    : '正在录音，点击结束并转写'
}

function insertVoiceText (text) {
  const input = $('#input')
  if (!input || input.disabled || isReadonlyView()) {
    toast('当前视图只读，无法填入转写结果', 'err')
    return false
  }
  const clean = String(text || '').trim()
  if (!clean) return false
  input.focus()
  const at = input.value.length
  const sep = input.value && !/\s$/.test(input.value) ? ' ' : ''
  input.setRangeText(sep + clean, at, at, 'end')
  input.dispatchEvent(new Event('input'))
  toast('语音已转写，已填入输入框', 'ok')
  return true
}

function cleanupSession (session) {
  if (!session) return
  if (session.stopTimer) { clearTimeout(session.stopTimer); session.stopTimer = null }
  if (session.recognition) {
    try { session.recognition.stop() } catch { /* ignore */ }
    session.recognition = null
  }
  if (session.recorder && session.recorder.state !== 'inactive') {
    try { session.recorder.stop() } catch { /* ignore */ }
  }
  session.recorder = null
  if (session.stream) {
    session.stream.getTracks().forEach((track) => track.stop())
    session.stream = null
  }
}

function finishSuccess (session, text) {
  if (!active || active !== session) return
  const clean = String(text || '').trim()
  active = null
  cleanupSession(session)
  paintButton('idle')
  if (!clean) {
    toast('没有识别到内容，请再说一次', 'err')
    return
  }
  insertVoiceText(clean)
}

function finishError (session, message) {
  if (!active || active !== session) return
  const wasWindows = session.engine === 'windows'
  active = null
  cleanupSession(session)
  paintButton('idle')
  if (wasWindows && window.astral.speechStop) {
    window.astral.speechStop({ sessionId: session.id }).catch(() => {})
  }
  toast(`语音转换失败：${humanizeError(message)}`, 'err')
}

function abortActive () {
  const session = active
  if (!session) return
  active = null
  cleanupSession(session)
  if (session.engine === 'windows' && window.astral.speechStop) {
    window.astral.speechStop({ sessionId: session.id }).catch(() => {})
  }
  paintButton('idle')
}

/* ------------------------------------------------------ Windows 本机 */

async function startWindows (session) {
  session.startPromise = window.astral.speechStart({ language: speechSettings().lang || 'zh-CN' })
  let result = null
  try {
    result = await session.startPromise
  } catch (err) {
    finishError(session, err.message)
    return
  }
  if (active !== session) return
  if (!result || !result.ok) {
    finishError(session, result && result.error)
    return
  }
  session.id = Number(result.sessionId) || 0
}

function onSpeechEvent (event) {
  const session = active
  if (!session || session.engine !== 'windows' || !event) return
  if (session.id && event.sessionId && Number(event.sessionId) !== session.id) return
  if (event.type === 'partial') {
    session.live = String(event.text || '')
    updateLiveTitle(session)
  } else if (event.type === 'final') {
    session.final = String(event.transcript || (session.final + String(event.text || '')))
    session.live = ''
    updateLiveTitle(session)
  } else if (event.type === 'done') {
    if (event.transcript) session.final = String(event.transcript)
  } else if (event.type === 'error') {
    if (session.stage === 'recording') finishError(session, event.message)
    else session.error = event.message
  } else if (event.type === 'ended') {
    if (session.stage === 'recording') {
      const text = session.final || session.live || event.text || ''
      if (text) finishSuccess(session, text)
      else finishError(session, '本机语音识别已结束')
    }
  }
}

async function stopWindows (session) {
  if (session.startPromise) {
    try { await session.startPromise } catch { /* handled by start */ }
  }
  if (active !== session) return
  let result = null
  try {
    result = await window.astral.speechStop({ sessionId: session.id || 0 })
  } catch (err) {
    finishError(session, err.message)
    return
  }
  if (active !== session) return
  const text = session.final || session.live || (result && result.text) || ''
  if (result && result.ok === false) finishError(session, result.error)
  else finishSuccess(session, text)
}

/* ------------------------------------------------------ 浏览器识别 */

function browserErrorMessage (code) {
  return ({
    'not-allowed': '麦克风权限被拒绝，请在系统设置里允许后重试',
    'service-not-allowed': '系统未提供浏览器语音服务',
    network: '语音服务不可达',
    'no-speech': '没有听到声音',
    'audio-capture': '没有可用的麦克风'
  })[code] || `识别失败：${code}`
}

function startBrowser (session) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!Recognition) { finishError(session, '浏览器识别不可用'); return }
  let recognition
  try { recognition = new Recognition() } catch (err) { finishError(session, err.message); return }
  session.recognition = recognition
  recognition.lang = speechSettings().lang || 'zh-CN'
  recognition.interimResults = true
  recognition.continuous = true

  let finalText = ''
  recognition.onresult = (event) => {
    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const piece = event.results[i][0].transcript
      if (event.results[i].isFinal) finalText += piece
      else interim += piece
    }
    session.final = finalText
    session.live = (finalText + interim).trim()
    updateLiveTitle(session)
  }
  recognition.onerror = (event) => {
    if (active !== session) return
    if (session.stage === 'converting') {
      finishSuccess(session, session.final || session.live)
    } else {
      finishError(session, browserErrorMessage(event.error))
    }
  }
  recognition.onend = () => {
    if (active !== session) return
    if (session.stage === 'converting') finishSuccess(session, session.final || session.live)
    else if (session.stage === 'recording') finishError(session, '识别已结束')
  }
  try {
    recognition.start()
  } catch (err) {
    finishError(session, err.message)
  }
}

function stopBrowser (session) {
  if (!session.recognition) {
    finishSuccess(session, session.final || session.live)
    return
  }
  try { session.recognition.stop() } catch { /* ignore */ }
  session.stopTimer = setTimeout(() => {
    if (active === session && session.stage === 'converting') {
      finishSuccess(session, session.final || session.live)
    }
  }, 1400)
}

/* ------------------------------------------------------ 录音与离线转写 */

function blobToBase64 (blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '')
    reader.onerror = () => reject(new Error('读取录音数据失败'))
    reader.readAsDataURL(blob)
  })
}

function float32ToBase64 (samples) {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

async function blobTo16kSamples (blob) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext
  if (!AudioCtx) throw new Error('当前环境无法解码录音')
  const arrayBuffer = await blob.arrayBuffer()
  const ctx = new AudioCtx()
  let decoded
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer)
  } finally {
    try { await ctx.close() } catch { /* ignore */ }
  }
  if (!decoded || !decoded.length) throw new Error('录音解码失败')
  const frames = Math.max(1, Math.ceil(decoded.duration * 16000))
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext
  if (!OfflineCtx) throw new Error('当前环境无法重采样录音')
  const offline = new OfflineCtx(1, frames, 16000)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start(0)
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0)
}

/**
 * 启动 MediaRecorder；服务端转写和 SenseVoice 共用。
 * onStop 收到已经停止麦克风的 Blob，由调用者决定上传或本地推理。
 */
async function beginMediaRecording (session, onStop) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    finishError(session, '当前环境无法访问麦克风')
    return false
  }
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (err) {
    finishError(session, err.name === 'NotAllowedError' ? '麦克风权限被拒绝' : (err.message || '无法访问麦克风'))
    return false
  }
  if (active !== session) {
    stream.getTracks().forEach((track) => track.stop())
    return false
  }
  session.stream = stream

  const mime = ['audio/webm', 'audio/ogg', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || ''
  let recorder
  try {
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
  } catch {
    try {
      recorder = new MediaRecorder(stream)
    } catch (err) {
      finishError(session, err.message)
      return false
    }
  }
  session.recorder = recorder
  const chunks = []
  recorder.ondataavailable = (event) => { if (event.data && event.data.size) chunks.push(event.data) }
  recorder.onerror = () => finishError(session, '录音失败')
  recorder.onstop = async () => {
    if (session.stream) {
      session.stream.getTracks().forEach((track) => track.stop())
      session.stream = null
    }
    if (active !== session) return
    if (!chunks.length) { finishError(session, '没有录到声音'); return }
    session.stage = 'converting'
    paintButton('converting')
    const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' })
    try {
      await onStop(session, blob, recorder)
    } catch (err) {
      finishError(session, err.message)
    }
  }

  try {
    recorder.start()
  } catch (err) {
    finishError(session, err.message)
    return false
  }
  if (session.stopRequested || active !== session) {
    try { recorder.stop() } catch { /* ignore */ }
  }
  return true
}

function stopMediaRecording (session) {
  if (session.recorder && session.recorder.state !== 'inactive') {
    try { session.recorder.stop() } catch { /* ignore */ }
  } else if (!session.recorder) {
    session.stopRequested = true
  }
}

/* ------------------------------------------------------ SenseVoice 本地 */

async function startSenseVoice (session) {
  const started = await beginMediaRecording(session, async (s, blob, recorder) => {
    const samples = await blobTo16kSamples(blob)
    if (active !== s) return
    const res = await window.astral.senseVoiceTranscribe({
      samples: float32ToBase64(samples),
      sampleRate: 16000,
      language: 'auto',
      modelDir: s.modelDir
    })
    if (active !== s) return
    if (!res || !res.ok) throw new Error((res && res.error) || 'SenseVoice 转写失败')
    finishSuccess(s, String(res.text || '').trim())
  })
  if (!started) return
}

/* ------------------------------------------------------ 服务端转写 */

async function startServer (session) {
  const provider = transcribeProvider()
  if (!provider) {
    finishError(session, '没有可用于转写的供应商，请到设置 → 权限与数据配置')
    return
  }

  await beginMediaRecording(session, async (s, blob, recorder) => {
    const audio = await blobToBase64(blob)
    const ext = REC_EXT[(recorder.mimeType || '').split(';')[0]] || 'webm'
    const res = await window.astral.transcribe({
      provider: {
        id: provider.id,
        kind: provider.kind,
        baseUrl: provider.baseUrl
      },
      model: speechSettings().model || 'whisper-1',
      audio,
      ext,
      mime: (recorder.mimeType || 'audio/webm').split(';')[0],
      language: (speechSettings().lang || 'zh-CN').slice(0, 2)
    })
    if (!res || !res.ok) throw new Error((res && res.error) || '转写失败')
    finishSuccess(s, String(res.text || '').trim())
  })
}

/* ---------------------------------------------------------- 对外入口 */

function promptSpeechModelInstall (detail = '') {
  const modal = openModal({
    title: '安装语音模型',
    sub: 'SenseVoice · 模型不随应用自带',
    width: 620,
    render: (body) => {
      body.append(
        h('div', { class: 'hint', style: { lineHeight: '1.8' }, text: detail || '本地还没有安装语音识别模型。请先下载 SenseVoice 模型，或选择已有的模型文件夹。' }),
        h('div', { class: 'hint', style: { lineHeight: '1.8', marginTop: '10px' }, text: '模型文件夹需要包含：model.int8.onnx（或 model.onnx）与 tokens.txt。' }),
        h('div', { class: 'btn-row', style: { marginTop: '16px', flexWrap: 'wrap' } },
          h('button', {
            class: 'btn primary',
            type: 'button',
            onclick: async () => {
              const record = await addSpeechModelFromDialog()
              if (!record) return
              closeModal()
              paintButton('idle')
              toast('语音模型已安装，请再次点击「语音」开始', 'ok')
            }
          }, '选择模型文件夹'),
          h('button', {
            class: 'btn ghost',
            type: 'button',
            onclick: () => openSpeechModelPage()
          }, '打开模型下载页'),
          h('button', {
            class: 'btn ghost',
            type: 'button',
            onclick: () => closeModal()
          }, '取消')
        )
      )
    }
  })
  return modal
}

async function resolveVoiceEngine () {
  const pref = speechSettings().engine || 'auto'
  if (pref === 'auto' || pref === 'sensevoice') {
    const model = selectedSpeechModel()
    if (!model) {
      promptSpeechModelInstall()
      return null
    }
    if (!hasSenseVoiceEngine()) {
      promptSpeechModelInstall('当前应用缺少 SenseVoice 运行时，请重新安装完整版本。')
      return null
    }
    let info = null
    try {
      info = await window.astral.senseVoiceInfo({ modelDir: model.dir })
    } catch (err) {
      info = { available: false, error: err.message }
    }
    if (!info || !info.available) {
      promptSpeechModelInstall(info && info.error ? `模型不可用：${info.error}` : '所选模型目录不可用，请重新选择。')
      return null
    }
    return { engine: 'sensevoice', modelDir: model.dir }
  }

  const engine = chooseEngine()
  if (!engine) {
    toast('没有可用的语音识别引擎，请检查设置 → 语音转写', 'err')
    return null
  }
  return { engine, modelDir: '' }
}

async function startVoice () {
  if (active) return
  if (isReadonlyView()) { toast('当前视图只读，无法使用语音转写', 'err'); return }
  const resolved = await resolveVoiceEngine()
  if (!resolved) return
  const { engine, modelDir } = resolved

  const session = {
    engine,
    modelDir,
    stage: 'recording',
    startedAt: Date.now(),
    final: '',
    live: '',
    id: 0,
    stopRequested: false,
    recognition: null,
    recorder: null,
    stream: null,
    startPromise: null
  }
  active = session
  paintButton('recording')

  if (engine === 'sensevoice') startSenseVoice(session)
  else if (engine === 'windows') startWindows(session)
  else if (engine === 'browser') startBrowser(session)
  else startServer(session)
}

async function stopVoice () {
  const session = active
  if (!session || session.stage === 'converting') return
  session.stage = 'converting'
  paintButton('converting')
  if (session.engine === 'windows') await stopWindows(session)
  else if (session.engine === 'browser') stopBrowser(session)
  else stopMediaRecording(session)
}

export function mountVoice (btn) {
  if (!btn) return
  voiceButton = btn
  paintButton('idle')

  btn.addEventListener('click', () => {
    if (active && active.stage === 'recording') stopVoice()
    else if (!active) startVoice()
  })

  if (window.astral.onSpeechEvent) {
    window.astral.onSpeechEvent(onSpeechEvent)
  }

  bus.on('view:changed', () => {
    if (active && isReadonlyView()) abortActive()
  })

  window.addEventListener('beforeunload', () => {
    if (active && active.engine === 'windows' && window.astral.speechStop) {
      window.astral.speechStop({ sessionId: active.id }).catch(() => {})
    }
  })
}
