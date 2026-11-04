'use strict'

/* sensevoice.js — SenseVoice 本地转写（运行时随应用，模型由用户安装）
 *
 * 运行时：vendor/sherpa-onnx/node_modules/sherpa-onnx-node（约 23MB）
 * 模型：不随应用发布。用户在设置中导入一个包含 model.int8.onnx 与 tokens.txt
 *       的目录，或自行下载后选择该目录；模型路径通过 IPC 传入。
 */

const fs = require('node:fs')
const path = require('node:path')

const RUNTIME_CANDIDATES = [
  process.env.ASTRAL_SHERPA_NODE,
  path.join(__dirname, '..', 'vendor', 'sherpa-onnx', 'node_modules', 'sherpa-onnx-node'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DSH NEXT', 'resources', 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-node')
].filter(Boolean)

let runtimePath = ''

function findRuntime () {
  if (runtimePath) return runtimePath
  for (const candidate of RUNTIME_CANDIDATES) {
    if (fs.existsSync(path.join(candidate, 'package.json')) &&
        fs.existsSync(path.join(candidate, 'sherpa-onnx.js'))) {
      runtimePath = candidate
      break
    }
  }
  return runtimePath
}

function inspectModel (modelDir) {
  const dir = String(modelDir || '').trim()
  if (!dir) return { ok: false, error: '还没有选择 SenseVoice 模型', model: null }
  if (!fs.existsSync(dir)) return { ok: false, error: '模型目录不存在', model: null }

  let stat
  try { stat = fs.statSync(dir) } catch (err) { return { ok: false, error: err.message, model: null } }
  if (!stat.isDirectory()) return { ok: false, error: '请选择模型所在文件夹，而不是单个文件', model: null }

  const modelNames = ['model.int8.onnx', 'model.onnx']
  const modelFile = modelNames.map((name) => path.join(dir, name)).find((file) => fs.existsSync(file))
  const tokensFile = path.join(dir, 'tokens.txt')
  if (!modelFile) return { ok: false, error: '目录里没有 model.int8.onnx 或 model.onnx', model: null }
  if (!fs.existsSync(tokensFile)) return { ok: false, error: '目录里没有 tokens.txt', model: null }

  let size = 0
  try { size = fs.statSync(modelFile).size } catch { /* ignore */ }
  return {
    ok: true,
    error: '',
    model: {
      dir: path.resolve(dir),
      name: path.basename(path.resolve(dir)),
      modelFile,
      tokensFile,
      size
    }
  }
}

const recognizers = new Map()

async function getRecognizer (assets) {
  const key = assets.model.modelFile
  if (recognizers.has(key)) return recognizers.get(key)
  const promise = (async () => {
    const runtime = require(assets.runtime)
    const recognizer = await runtime.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        senseVoice: {
          model: assets.model.modelFile,
          language: 'auto',
          useInverseTextNormalization: 1
        },
        tokens: assets.model.tokensFile,
        numThreads: 2,
        debug: 0,
        provider: 'cpu'
      }
    })
    return { runtime, recognizer }
  })().catch((err) => {
    recognizers.delete(key)
    throw err
  })
  recognizers.set(key, promise)
  return promise
}

function decodeSamples (base64) {
  const bytes = Buffer.from(String(base64 || ''), 'base64')
  if (!bytes.length) throw new Error('录音内容为空')
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return new Float32Array(buffer)
}

async function transcribe (payload = {}) {
  const runtime = findRuntime()
  if (!runtime) return { ok: false, error: '找不到语音识别运行时，请重新安装应用' }
  const inspected = inspectModel(payload.modelDir)
  if (!inspected.ok) return { ok: false, error: inspected.error }

  let samples
  try {
    samples = decodeSamples(payload.samples)
  } catch (err) {
    return { ok: false, error: err.message }
  }
  if (!samples.length) return { ok: false, error: '录音内容为空' }
  if (samples.length > 16000 * 600) return { ok: false, error: '录音超过 10 分钟上限' }

  try {
    const assets = { runtime, model: inspected.model }
    const { recognizer } = await getRecognizer(assets)
    const inputRate = Number(payload.sampleRate) || 16000
    let audio = samples
    if (inputRate !== 16000) {
      const { LinearResampler } = require(runtime)
      const resampler = new LinearResampler(inputRate, 16000)
      audio = resampler.flush(samples)
    }
    const stream = recognizer.createStream()
    stream.acceptWaveform({ samples: audio, sampleRate: 16000 })
    const result = await recognizer.decodeAsync(stream)
    return {
      ok: true,
      text: String((result && result.text) || '').trim(),
      language: String((result && result.lang) || ''),
      emotion: String((result && result.emotion) || ''),
      event: String((result && result.event) || ''),
      samples: audio.length
    }
  } catch (err) {
    return { ok: false, error: err.message || 'SenseVoice 转写失败' }
  }
}

function info (modelDir) {
  const runtime = findRuntime()
  const inspected = inspectModel(modelDir)
  return {
    available: Boolean(runtime && inspected.ok),
    runtimeAvailable: Boolean(runtime),
    runtimePath: runtime || '',
    error: !runtime ? '缺少语音识别运行时' : (inspected.ok ? '' : inspected.error),
    model: inspected.model || null,
    engine: 'sensevoice-onnx'
  }
}

module.exports = { info, transcribe, inspectModel, findRuntime }
