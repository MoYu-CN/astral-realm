'use strict'

/* secrets.js — API Key 的落盘加密与主进程持有
 *
 * providers.json 只保存供应商配置；API Key 用 Electron safeStorage 加密后
 * 写 config/credentials.json（Windows 下走 DPAPI）。
 *
 * boot 返回给渲染层的 provider 只带 hasKey，不返回 apiKey。
 * 模型请求、测试、语音转写都由主进程按 provider id 取 Key。
 */

const fs = require('node:fs')
const path = require('node:path')
const { safeStorage } = require('electron')

const ASYNC_TIMEOUT_MS = 2500

function atomicWrite (file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

async function withTimeout (promise, ms, fallback) {
  let timer = null
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function createSecrets ({ configDir }) {
  const providersFile = path.join(configDir, 'providers.json')
  const credentialsFile = path.join(configDir, 'credentials.json')
  let lastError = ''

  async function encryptionAvailable () {
    try {
      if (typeof safeStorage.isAsyncEncryptionAvailable === 'function') {
        const result = await withTimeout(safeStorage.isAsyncEncryptionAvailable(), ASYNC_TIMEOUT_MS, '__timeout__')
        if (result !== '__timeout__') return Boolean(result)
      }
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  function readStore () {
    try {
      const data = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'))
      return {
        version: 1,
        providers: data && data.providers && typeof data.providers === 'object' ? data.providers : {}
      }
    } catch {
      return { version: 1, providers: {} }
    }
  }

  function writeStore (store) {
    atomicWrite(credentialsFile, store)
  }

  async function encrypt (value) {
    if (typeof safeStorage.encryptStringAsync === 'function') {
      const result = await withTimeout(safeStorage.encryptStringAsync(value), ASYNC_TIMEOUT_MS, null)
      if (result) return result.toString('base64')
    }
    return safeStorage.encryptString(value).toString('base64')
  }

  async function decrypt (value) {
    if (!value) return { value: '', reencrypt: false }
    if (typeof safeStorage.decryptStringAsync === 'function') {
      const result = await withTimeout(safeStorage.decryptStringAsync(Buffer.from(value, 'base64')), ASYNC_TIMEOUT_MS, null)
      if (result) return { value: result.result, reencrypt: Boolean(result.shouldReEncrypt) }
    }
    return { value: safeStorage.decryptString(Buffer.from(value, 'base64')), reencrypt: false }
  }

  function sanitize (data, store) {
    const source = data && Array.isArray(data.providers) ? data : { providers: [] }
    return {
      ...source,
      providers: source.providers.map((provider) => {
        const copy = { ...provider }
        delete copy.apiKey
        delete copy.clearApiKey
        copy.hasKey = Boolean(provider.id && store.providers[String(provider.id)]?.value)
        return copy
      })
    }
  }

  /* 启动时：迁移旧明文 Key，然后只返回 hasKey，不把 Key 交给渲染层。 */
  async function hydrateProviders (data) {
    const source = data && Array.isArray(data.providers) ? data : { providers: [] }
    const store = readStore()
    const available = await encryptionAvailable()
    let storeChanged = false
    let plaintextChanged = false
    for (const provider of source.providers) {
      if (!provider || typeof provider !== 'object') continue
      const id = String(provider.id || '')
      if (!id) continue
      const plaintext = typeof provider.apiKey === 'string' ? provider.apiKey.trim() : ''
      if (plaintext) {
        if (!available) {
          lastError = '系统加密存储不可用'
          continue
        }
        try {
          store.providers[id] = { value: await encrypt(plaintext), updatedAt: Date.now() }
          storeChanged = true
          plaintextChanged = true
        } catch (err) {
          lastError = err.message
        }
      }
    }
    if (storeChanged) {
      try { writeStore(store) } catch (err) { lastError = err.message }
    }
    const safe = sanitize(source, store)
    if (plaintextChanged) {
      try { atomicWrite(providersFile, safe) } catch (err) { lastError = err.message }
    }
    return safe
  }

  /* 保存供应商配置：保留未显式替换的 Key，不把渲染层的空 apiKey 当成清除。 */
  async function saveProviders (data) {
    if (!await encryptionAvailable()) {
      return { ok: false, message: '系统加密存储不可用，供应商配置尚未保存' }
    }
    try {
      const source = data && Array.isArray(data.providers) ? data : { providers: [] }
      const store = readStore()
      const ids = new Set()
      for (const provider of source.providers) {
        if (!provider || typeof provider !== 'object' || !provider.id) continue
        const id = String(provider.id)
        ids.add(id)
        if (provider.clearApiKey) {
          delete store.providers[id]
          continue
        }
        const key = typeof provider.apiKey === 'string' ? provider.apiKey.trim() : ''
        if (key) store.providers[id] = { value: await encrypt(key), updatedAt: Date.now() }
      }
      for (const id of Object.keys(store.providers)) {
        if (!ids.has(id)) delete store.providers[id]
      }
      writeStore(store)
      const safe = sanitize(source, store)
      atomicWrite(providersFile, safe)
      return { ok: true, providers: safe.providers }
    } catch (err) {
      lastError = err.message
      return { ok: false, message: err.message }
    }
  }

  async function getKey (id) {
    const providerId = String(id || '')
    if (!providerId) return ''
    if (!await encryptionAvailable()) throw new Error('系统加密存储不可用')
    const store = readStore()
    const entry = store.providers[providerId]
    if (!entry || !entry.value) return ''
    const decrypted = await decrypt(entry.value)
    if (decrypted.reencrypt) {
      try {
        store.providers[providerId] = { value: await encrypt(decrypted.value), updatedAt: Date.now() }
        writeStore(store)
      } catch { /* 下次再迁移 */ }
    }
    return decrypted.value
  }

  async function setKey (id, key) {
    const providerId = String(id || '')
    const value = String(key || '').trim()
    if (!providerId) return { ok: false, error: '缺少供应商 id' }
    if (!value) return { ok: false, error: 'API Key 为空' }
    if (!await encryptionAvailable()) return { ok: false, error: '系统加密存储不可用' }
    try {
      const store = readStore()
      store.providers[providerId] = { value: await encrypt(value), updatedAt: Date.now() }
      writeStore(store)
      return { ok: true, hasKey: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }

  async function clearKey (id) {
    const providerId = String(id || '')
    if (!providerId) return { ok: false, error: '缺少供应商 id' }
    try {
      const store = readStore()
      delete store.providers[providerId]
      writeStore(store)
      return { ok: true, hasKey: false }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }

  async function hasKey (id) {
    const providerId = String(id || '')
    if (!providerId) return false
    const store = readStore()
    return Boolean(store.providers[providerId]?.value)
  }

  return {
    hydrateProviders,
    saveProviders,
    getKey,
    setKey,
    clearKey,
    hasKey,
    encryptionAvailable,
    get lastError () { return lastError }
  }
}

module.exports = { createSecrets }
