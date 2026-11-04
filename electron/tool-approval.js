'use strict'

/* tool-approval.js — 工具审批令牌
 *
 * 主进程在用户确认（或命中 autoApprove / 完全授权）后签发一次性令牌。
 * 令牌绑定到具体调用：serverId / tool / args / agentId / projectId / runId。
 * 执行端只接受令牌，不再接受渲染层传来的 approved 布尔值。
 *
 * 令牌只在主进程内存中存在，不下发给渲染层；单次使用、默认 60 秒过期。
 * 即使令牌泄漏，也无法换参数、换工具、换成员或重复使用。
 */

const crypto = require('node:crypto')

function stableStringify (value) {
  if (value === null || value === undefined) return String(value)
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function canonicalCall (call = {}) {
  return {
    serverId: String(call.serverId || ''),
    tool: String(call.tool || ''),
    args: call.args && typeof call.args === 'object' ? call.args : {},
    agentId: String(call.agentId || ''),
    projectId: String(call.projectId || ''),
    runId: String(call.runId || '')
  }
}

function fingerprint (call = {}) {
  return crypto.createHash('sha256')
    .update(stableStringify(canonicalCall(call)))
    .digest('hex')
}

function createToolApprovals ({ ttlMs = 60000, maxEntries = 512, now = () => Date.now() } = {}) {
  const lifeMs = Math.max(1, Number(ttlMs) || 60000)
  const limit = Math.max(1, Number(maxEntries) || 512)
  const entries = new Map()

  function sweep (ts) {
    for (const [token, record] of entries) {
      if (record.expiresAt <= ts) entries.delete(token)
    }
  }

  function issue (call = {}, meta = {}) {
    const ts = now()
    sweep(ts)
    while (entries.size >= limit) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
    const token = crypto.randomBytes(32).toString('base64url')
    const id = crypto.randomBytes(8).toString('hex')
    const record = {
      id,
      fingerprint: fingerprint(call),
      source: String(meta.source || 'once'),
      createdAt: ts,
      expiresAt: ts + lifeMs
    }
    entries.set(token, record)
    return { token, id: record.id, source: record.source, createdAt: ts, expiresAt: record.expiresAt }
  }

  function consume (token, call = {}) {
    const key = String(token || '')
    const record = entries.get(key)
    if (!record) return { ok: false, reason: 'unknown', error: '审批令牌无效或已使用' }
    /* 先删除再校验：不匹配的尝试也会烧掉令牌，避免拿同一个令牌反复试探。 */
    entries.delete(key)
    if (record.expiresAt <= now()) {
      return { ok: false, reason: 'expired', error: '审批令牌已过期' }
    }
    if (record.fingerprint !== fingerprint(call)) {
      return { ok: false, reason: 'mismatch', error: '审批令牌与工具调用不匹配' }
    }
    return { ok: true, id: record.id, source: record.source, expiresAt: record.expiresAt }
  }

  function size () {
    sweep(now())
    return entries.size
  }

  return { issue, consume, size, ttlMs: lifeMs, maxEntries: limit }
}

module.exports = { createToolApprovals, canonicalCall, fingerprint, stableStringify }
