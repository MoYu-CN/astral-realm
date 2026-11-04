'use strict'

/* diagnostics.js — 导出可发给维护者的脱敏诊断包。
 * 不打包会话正文、API Key、bridge token 或插件源码，只保留运行状态与文件大小。 */

const fs = require('node:fs')
const path = require('node:path')

const SECRET_KEYS = /token|apiKey|apikey|password|secret|authorization|credential/i

function redact (value, key = '') {
  if (SECRET_KEYS.test(String(key))) return '[redacted]'
  if (Array.isArray(value)) return value.map((item) => redact(item))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [childKey, childValue] of Object.entries(value)) out[childKey] = redact(childValue, childKey)
    return out
  }
  return value
}

function readJson (file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function fileInfo (file) {
  try {
    const stat = fs.statSync(file)
    return { exists: true, bytes: stat.size, updatedAt: stat.mtime.toISOString() }
  } catch {
    return { exists: false, bytes: 0, updatedAt: '' }
  }
}

function listPlugins (configDir) {
  const out = []
  for (const [dir, scope] of [[path.join(__dirname, '..', 'app', 'plugins'), 'app'], [path.join(configDir, 'plugins'), 'user']]) {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const manifest = readJson(path.join(dir, entry.name, 'plugin.json'), null)
      if (!manifest || !manifest.id) continue
      out.push({
        id: String(manifest.id),
        name: String(manifest.name || manifest.id),
        version: String(manifest.version || ''),
        scope,
        runtime: String(manifest.runtime || 'legacy'),
        defaultEnabled: manifest.defaultEnabled !== false,
        permissions: Array.isArray(manifest.permissions) ? manifest.permissions : null,
        hasError: false
      })
    }
  }
  return out
}

function createDiagnostics ({ configDir, appInfo, toolGateway, runStore, jobStore }) {
  const providersFile = path.join(configDir, 'providers.json')
  const settingsFile = path.join(configDir, 'settings.json')
  const projectsFile = path.join(configDir, 'projects.json')

  function collect () {
    const settings = readJson(settingsFile, {})
    if (settings.bridge) {
      settings.bridge = { enabled: settings.bridge.enabled !== false, port: Number(settings.bridge.port) || 0 }
    }
    const providers = readJson(providersFile, { providers: [] })
    const projects = readJson(projectsFile, { projects: [] })
    const runs = runStore && typeof runStore.list === 'function' ? runStore.list({ limit: 50 }).runs || [] : []
    const jobs = jobStore && typeof jobStore.list === 'function' ? jobStore.list({ limit: 60 }).jobs || [] : []
    const audit = toolGateway && typeof toolGateway.list === 'function' ? toolGateway.list({ limit: 50 }).entries || [] : []

    return redact({
      generatedAt: new Date().toISOString(),
      app: appInfo,
      configDir: '[local path omitted]',
      files: {
        settings: fileInfo(settingsFile),
        providers: fileInfo(providersFile),
        projects: fileInfo(projectsFile),
        session: fileInfo(path.join(configDir, 'session.json')),
        jobs: fileInfo(path.join(configDir, 'jobs.json')),
        runs: fileInfo(path.join(configDir, 'runs', 'index.json')),
        credentials: fileInfo(path.join(configDir, 'credentials.json'))
      },
      settings,
      providers: (Array.isArray(providers.providers) ? providers.providers : []).map((provider) => ({
        id: provider.id,
        name: provider.name,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        enabled: provider.enabled !== false,
        hasKey: Boolean(provider.hasKey),
        models: Array.isArray(provider.models) ? provider.models : []
      })),
      projects: (Array.isArray(projects.projects) ? projects.projects : []).map((project) => ({
        id: project.id,
        name: project.name,
        hasRoot: Boolean(project.rootPath),
        agents: Array.isArray(project.roster && project.roster.agents) ? project.roster.agents.length : 0,
        updatedAt: project.updatedAt || 0
      })),
      plugins: listPlugins(configDir),
      runs: runs.map((run) => ({
        id: run.id,
        status: run.status,
        agentName: run.agentName,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        error: run.error || ''
      })),
      jobs: jobs.map((job) => ({
        id: job.id,
        title: job.title,
        status: job.status,
        currentStep: job.currentStep,
        steps: Array.isArray(job.steps) ? job.steps.length : 0,
        updatedAt: job.updatedAt
      })),
      audit: audit.map((entry) => ({
        ts: entry.ts,
        tool: entry.tool,
        agentId: entry.agentId,
        allowed: entry.allowed,
        reason: entry.reason,
        capabilities: entry.capabilities,
        durationMs: entry.durationMs
      })),
      logs: (() => {
        try {
          return fs.readdirSync(path.join(configDir, 'logs'), { withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => ({ name: entry.name, ...fileInfo(path.join(configDir, 'logs', entry.name)) }))
        } catch { return [] }
      })()
    })
  }

  function exportPackage () {
    const dir = path.join(configDir, 'diagnostics')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = path.join(dir, `astral-diagnostics-${stamp}.json`)
    const data = collect()
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true, path: file, bytes: fs.statSync(file).size }
  }

  return { collect, exportPackage }
}

module.exports = { createDiagnostics }
