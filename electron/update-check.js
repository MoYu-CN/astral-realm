'use strict'

/* update-check.js — 检查 GitHub 上有没有新版本。
 *
 * 判定顺序：
 *   1) /releases/latest   有正式发布时以 tag 为准
 *   2) 仓库还没有 release  回落到 main 分支 package.json 的 version，并附上最新提交
 *
 * 只做「检查」：不下载、不替换文件，真正的更新由用户去 GitHub 取。
 *
 * 网络走 Electron 的 net.fetch（Chromium 网络栈，自动跟随系统代理），
 * 不用 Node 原生 fetch —— 后者不认系统代理，配了代理的用户会连不上。
 * electron 只在真正发请求时才 require，这样本模块能被纯 Node 的单测直接引入。
 */

const DEFAULT_REPO = { owner: 'MoYu-CN', repo: 'astral-realm' }
const API = 'https://api.github.com'
const CACHE_TTL = 10 * 60 * 1000

let cache = null

function normalizeVersion (value) {
  return String(value === undefined || value === null ? '' : value).trim().replace(/^v/i, '')
}

function splitVersion (value) {
  const raw = normalizeVersion(value)
  const dash = raw.indexOf('-')
  const core = dash >= 0 ? raw.slice(0, dash) : raw
  const pre = dash >= 0 ? raw.slice(dash + 1) : ''
  const nums = core.split('.').map((part) => {
    const matched = /^\d+/.exec(part)
    return matched ? Number(matched[0]) : 0
  })
  while (nums.length < 3) nums.push(0)
  return { nums, pre }
}

/* 返回 -1 / 0 / 1；0.1.0 与 v0.1.0 视为相等，0.2.0 > 0.2.0-beta。 */
function compareVersions (a, b) {
  const left = splitVersion(a)
  const right = splitVersion(b)
  const length = Math.max(left.nums.length, right.nums.length)
  for (let i = 0; i < length; i += 1) {
    const x = left.nums[i] || 0
    const y = right.nums[i] || 0
    if (x !== y) return x > y ? 1 : -1
  }
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre > right.pre ? 1 : -1
}

const HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'AstralRealm-Updater'
}

function parseJson (text) {
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

async function fetchViaNode (url, signal) {
  const res = await fetch(url, { headers: HEADERS, signal })
  return { status: res.status, data: parseJson(await res.text()) }
}

async function fetchViaChromium (url, signal) {
  const { net } = require('electron')
  const res = await net.fetch(url, { headers: HEADERS, signal })
  return { status: res.status, data: parseJson(await res.text()) }
}

/* 两条网络栈并行赛跑，谁先拿到响应用谁：
 *   - Chromium（net.fetch）跟随系统代理，挂着代理的用户要靠它；
 *   - Node（undici）的握手特征不一样，直连时反而不会被重置。
 * 实测同一台机器上 Chromium 访问 api.github.com 会超时，undici 472ms 就返回 200，
 * 所以不能只挑一条。两边都失败才算失败。 */
async function raceOnce (url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  /* 纯 Node 下没有 net，Chromium 那条会直接 reject，Promise.any 会忽略它 */
  const attempts = [fetchViaNode(url, controller.signal), fetchViaChromium(url, controller.signal)]
  try {
    return await Promise.any(attempts)
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

/* GitHub 在国内是时通时断的，偶发一次失败不代表真连不上，隔 700ms 再试一轮。 */
async function defaultFetchJson (url, { timeoutMs = 7000 } = {}) {
  try {
    return await raceOnce(url, timeoutMs)
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 700))
    try {
      return await raceOnce(url, timeoutMs)
    } catch {
      throw new Error('连接 GitHub 超时（网络或代理不通）')
    }
  }
}

function decodeContents (payload) {
  const raw = String((payload && payload.content) || '').replace(/\s+/g, '')
  if (!raw) return ''
  return Buffer.from(raw, 'base64').toString('utf8')
}

async function checkForUpdate ({
  currentVersion = '0.0.0',
  repo = DEFAULT_REPO,
  force = false,
  fetchJson = defaultFetchJson,
  now = Date.now()
} = {}) {
  const current = normalizeVersion(currentVersion)
  const repoUrl = `https://github.com/${repo.owner}/${repo.repo}`

  if (!force && cache && cache.current === current && now - cache.at < CACHE_TTL) {
    return { ...cache.result, cached: true }
  }

  const base = `${API}/repos/${repo.owner}/${repo.repo}`

  try {
    let latest = ''
    let source = 'release'
    let url = `${repoUrl}/releases`
    let notes = ''
    let publishedAt = ''
    let commit = null

    const release = await fetchJson(`${base}/releases/latest`)

    if (release.status === 200 && release.data && release.data.tag_name) {
      latest = normalizeVersion(release.data.tag_name)
      url = release.data.html_url || url
      notes = String(release.data.body || '').trim()
      publishedAt = release.data.published_at || ''
    } else if (release.status === 404) {
      /* 仓库刚起步、还没有发布 release：退回到 main 分支的 package.json。 */
      source = 'main'
      const pkg = await fetchJson(`${base}/contents/package.json?ref=main`)
      if (pkg.status !== 200 || !pkg.data || !pkg.data.content) {
        throw new Error(pkg.status === 404 ? '仓库里找不到 package.json' : `读取版本文件失败（HTTP ${pkg.status}）`)
      }
      let parsed = null
      try { parsed = JSON.parse(decodeContents(pkg.data)) } catch { parsed = null }
      if (!parsed || !parsed.version) throw new Error('package.json 里没有 version 字段')
      latest = normalizeVersion(parsed.version)
      url = `${repoUrl}/blob/main/package.json`

      const head = await fetchJson(`${base}/commits/main`)
      if (head.status === 200 && head.data && head.data.sha) {
        const info = head.data.commit || {}
        commit = {
          sha: String(head.data.sha).slice(0, 7),
          message: String(info.message || '').split('\n')[0].slice(0, 140),
          date: (info.author && info.author.date) || ''
        }
      }
    } else if (release.status === 403 || release.status === 429) {
      throw new Error('GitHub 接口被限流，过几分钟再试')
    } else {
      throw new Error(`读取 GitHub 失败（HTTP ${release.status}）`)
    }

    if (!latest) throw new Error('没能解析出最新版本号')

    const result = {
      ok: true,
      current,
      latest,
      hasUpdate: compareVersions(latest, current) > 0,
      source,
      url,
      repoUrl,
      notes: notes.slice(0, 1400),
      publishedAt,
      commit,
      checkedAt: now,
      cached: false
    }
    cache = { at: now, current, result }
    return result
  } catch (err) {
    return {
      ok: false,
      error: (err && err.message) || String(err),
      current,
      latest: '',
      hasUpdate: false,
      source: '',
      url: `${repoUrl}/releases`,
      repoUrl,
      checkedAt: now,
      cached: false
    }
  }
}

module.exports = {
  GITHUB_REPO: DEFAULT_REPO,
  CACHE_TTL,
  compareVersions,
  splitVersion,
  normalizeVersion,
  checkForUpdate
}
