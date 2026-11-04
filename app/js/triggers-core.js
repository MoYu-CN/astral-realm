/* triggers-core.js — 事件触发器的纯判定逻辑（无 DOM、无副作用，可单测） */

export const MAX_EVENTS = 200
export const MAX_THREAD_ITEMS = 20
export const MODES = ['off', 'observe', 'auto']

export const DEFAULT_CONFIG = {
  mode: 'observe',
  sources: [],
  keywords: [],
  dedupe: true,
  quietHours: null,
  watchdog: { enabled: true, threshold: 3 },
  events: []
}

function cleanList (value, max = 40) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((v) => String(v || '').trim()).filter(Boolean))].slice(0, max)
}

function minutesOf (hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''))
  if (!m) return -1
  return Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2]))
}

export function inQuietHours (quiet, now = Date.now()) {
  if (!quiet || quiet.enabled === false) return false
  const from = minutesOf(quiet.from)
  const to = minutesOf(quiet.to)
  if (from < 0 || to < 0 || from === to) return false
  const d = new Date(now)
  const cur = d.getHours() * 60 + d.getMinutes()
  return from < to ? (cur >= from && cur < to) : (cur >= from || cur < to)
}

export function normalizeConfig (raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const wd = src.watchdog && typeof src.watchdog === 'object' ? src.watchdog : {}
  const quiet = src.quietHours && typeof src.quietHours === 'object' ? src.quietHours : null
  const validQuiet = quiet && minutesOf(quiet.from) >= 0 && minutesOf(quiet.to) >= 0
    ? { from: String(quiet.from), to: String(quiet.to), enabled: quiet.enabled !== false }
    : null
  return {
    mode: MODES.includes(src.mode) ? src.mode : 'observe',
    sources: cleanList(src.sources),
    keywords: cleanList(src.keywords),
    dedupe: src.dedupe !== false,
    quietHours: validQuiet,
    watchdog: {
      enabled: wd.enabled !== false,
      threshold: Math.max(2, Math.min(10, Math.round(Number(wd.threshold) || 3)))
    },
    events: Array.isArray(src.events) ? src.events.slice(-MAX_EVENTS) : []
  }
}

export function normalizeParams (params, now = Date.now()) {
  const p = params && typeof params === 'object' ? params : {}
  const text = String(p.text || '').trim().slice(0, 2000)
  const source = String(p.source || '').trim().slice(0, 40)
  const eventId = String(p.eventId || '').trim().slice(0, 120) ||
    `${source || 'unknown'}:${text.slice(0, 48)}:${now}`
  return {
    source,
    eventId,
    type: String(p.type || 'event').trim().slice(0, 60),
    threadId: String(p.threadId || '').trim().slice(0, 120),
    text
  }
}

/* 返回 status：rejected 拒绝 / ignored 规则拦下 / observed 待人工批准 / queued 排队 / auto 自动执行 */
export function evaluateEvent ({ cfg, params, seen = new Set(), now = Date.now(), busy = false, isTest = false }) {
  const c = normalizeConfig(cfg)
  const p = normalizeParams(params, now)
  if (c.mode === 'off') return { status: 'rejected', reason: '触发器已关闭', params: p }
  if (!p.text) return { status: 'rejected', reason: '事件正文为空', params: p }
  if (!isTest) {
    if (!c.sources.length) return { status: 'rejected', reason: '未配置来源白名单', params: p }
    if (!c.sources.includes(p.source)) return { status: 'rejected', reason: `来源 ${p.source || '（空）'} 不在白名单`, params: p }
  }
  if (c.dedupe && seen.has(p.eventId)) return { status: 'ignored', reason: '重复事件已忽略', params: p }
  if (inQuietHours(c.quietHours, now)) return { status: 'ignored', reason: '静默时段', params: p }
  if (c.keywords.length && !c.keywords.some((k) => p.text.toLowerCase().includes(k.toLowerCase()))) {
    return { status: 'ignored', reason: '未命中关键词', params: p }
  }
  /* 界面内「投一条测试事件」永远只进候选，不自动执行 */
  if (isTest) return { status: 'observed', reason: '测试事件，等待人工批准', params: p }
  if (c.mode === 'observe') return { status: 'observed', reason: '等待人工批准', params: p }
  return { status: busy ? 'queued' : 'auto', reason: busy ? '应用忙，已排队' : '规则自动放行', params: p }
}

export function makeEvent ({ params, status, reason, now = Date.now(), id }) {
  const p = normalizeParams(params, now)
  return {
    id: id || `ev_${now.toString(36)}_${String(p.eventId || '').slice(0, 12)}`,
    ...p,
    ts: now,
    status,
    reason,
    mandate: null,
    attempts: 0,
    threadCount: 1,
    threadItems: [{ eventId: p.eventId, text: p.text, ts: now }]
  }
}

/* 不可变任务单：批准一次生成一张，扩大范围必须新开单 */
export function makeMandate (event, now = Date.now()) {
  return Object.freeze({
    id: `md_${event.id}`,
    eventId: event.eventId,
    source: event.source,
    threadId: event.threadId,
    threadCount: Number(event.threadCount) || 1,
    scope: String(event.text || '').slice(0, 300),
    createdAt: now
  })
}

export function capEvents (list, max = MAX_EVENTS) {
  const arr = Array.isArray(list) ? list : []
  return arr.length > max ? arr.slice(arr.length - max) : arr
}

export function toolFingerprint (label, args) {
  return `${String(label || '')}|${String(args || '').slice(0, 240)}`
}

/* Watchdog 判定：同一指纹累计到阈值即判无进展。抽成纯函数便于单测。 */
export function watchToolLoop (seen, fingerprint, enabled, limit) {
  if (!enabled) return { stop: false, count: 0 }
  const count = (seen.get(fingerprint) || 0) + 1
  seen.set(fingerprint, count)
  return { stop: count >= Math.max(2, limit), count }
}

/* 同一 threadId 的后续事件补给最近一张待批准候选，不再各自开一张单。
   这就是 Super-agent「Thread 订阅直通」的最小版：省掉重复候选与重复的一轮执行。 */
export function mergeIntoThread (existing, incoming, now = Date.now()) {
  const p = normalizeParams(incoming, now)
  const base = Array.isArray(existing.threadItems) && existing.threadItems.length
    ? existing.threadItems
    : [{ eventId: existing.eventId, text: existing.text, ts: existing.ts }]
  const threadItems = [...base, { eventId: p.eventId, text: p.text, ts: now }].slice(-MAX_THREAD_ITEMS)
  const threadCount = (Number(existing.threadCount) || 1) + 1
  return {
    eventId: p.eventId,
    text: p.text,
    ts: now,
    threadCount,
    threadItems,
    reason: `线索内 ${threadCount} 条事件，等待人工批准`
  }
}

/* 批准时把整条线索一起交给模型，避免后续事件丢失上下文 */
export function threadBlock (event) {
  const items = Array.isArray(event && event.threadItems) ? event.threadItems : []
  if (items.length < 2) return ''
  return [
    '## 该线索的连续事件',
    ...items.map((it, i) => `${i + 1}. ${String(it.text || '').slice(0, 300)}`)
  ].join('\n')
}
