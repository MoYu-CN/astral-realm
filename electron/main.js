'use strict'

const { app, BrowserWindow, Tray, Menu, nativeImage, protocol, ipcMain, shell, net, screen, dialog, desktopCapturer, clipboard } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const http = require('node:http')
const crypto = require('node:crypto')
const readline = require('node:readline')
const { spawn } = require('node:child_process')
const { POWERSHELL_SCRIPT } = require('./speech-win.js')
const sensevoice = require('./sensevoice.js')
const { createRunStore } = require('./runs.js')
const { createJobStore } = require('./jobs.js')
const { createDiagnostics } = require('./diagnostics.js')
const { createToolGateway } = require('./tool-gateway.js')
const { createToolApprovals } = require('./tool-approval.js')
const { mergeUsage } = require('./usage.js')
const { createPermissionAuthority, intersectPermissions } = require('./permission-authority.js')
const { createSecrets } = require('./secrets.js')
const { normalizePluginManifest } = require('./plugin-manifest.js')
const { buildInfo } = require('./build-info.js')
const { showThemedConfirm } = require('./confirm-window.js')

/* 启动动画音效在没有任何用户手势时就要播放；桌面应用内容全部本地，
   解除 Chromium 的自动播放限制（必须在 app ready 之前设置）。 */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const APP_STARTED_AT = Date.now()
const ROOT = path.join(__dirname, '..')
const APP_DIR = path.join(ROOT, 'app')
const DEV = !app.isPackaged

function currentBuildInfo () {
  return buildInfo({
    appDir: APP_DIR,
    startedAt: APP_STARTED_AT,
    version: app.getVersion()
  })
}

/* 便携模式：可执行文件旁边有 portable.flag 时，配置写在同目录 config/ 下，
   方便整包拷走、直接改配置。否则写到系统用户目录。 */
const EXE_DIR = (() => {
  try { return path.dirname(app.getPath('exe')) } catch { return null }
})()
const PORTABLE = Boolean(EXE_DIR && fs.existsSync(path.join(EXE_DIR, 'portable.flag')))
const CONFIG_DIR = DEV
  ? path.join(ROOT, 'config')
  : PORTABLE
    ? path.join(EXE_DIR, 'config')
    : path.join(app.getPath('userData'), 'config')
const SESSION_FILE = path.join(CONFIG_DIR, 'session.json')
const runStore = createRunStore({ configDir: CONFIG_DIR })
/* runId → 能力令牌。只在主进程内存中；渲染层从 runStart 的返回值拿到当前 run 的令牌。
   工具调用必须同时带 runId + 令牌，且 run 状态为 running。 */
const runCapabilities = new Map()
const jobStore = createJobStore({ configDir: CONFIG_DIR })
const toolGateway = createToolGateway({ configDir: CONFIG_DIR })
const diagnostics = createDiagnostics({
  configDir: CONFIG_DIR,
  appInfo: {
    get version () { return app.getVersion() },
    get electron () { return process.versions.electron || '' },
    get chrome () { return process.versions.chrome || '' },
    get node () { return process.versions.node || '' },
    get platform () { return process.platform },
    get arch () { return process.arch },
    get packaged () { return app.isPackaged }
  },
  toolGateway,
  runStore,
  jobStore
})
const permissionAuthority = createPermissionAuthority({ configDir: CONFIG_DIR })
const secrets = createSecrets({ configDir: CONFIG_DIR })
const toolApprovals = createToolApprovals({ ttlMs: 60000, maxEntries: 512 })
const llmControllers = new Map()

let knowledgeServicePromise = null
async function getKnowledgeService () {
  if (!knowledgeServicePromise) {
    const { pathToFileURL } = require('node:url')
    const moduleUrl = pathToFileURL(path.join(__dirname, 'knowledge', 'service.mjs')).href
    knowledgeServicePromise = import(moduleUrl)
      .then((mod) => mod.createKnowledgeService({ configDir: CONFIG_DIR }))
      .catch((err) => {
        knowledgeServicePromise = null
        throw err
      })
  }
  return knowledgeServicePromise
}

function knowledgePluginEnabled () {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'settings.json'), 'utf8'))
    return settings?.plugins?.knowledge?.enabled !== false
  } catch {
    return true
  }
}

/* 内置截图工具使用：只截主屏幕或星界自己的窗口，保存到配置目录的 data/screenshots。
   工具调用本身仍需经过渲染层审批；这里不做额外权限判断。 */
async function captureScreenshot ({ target = 'screen' } = {}) {
  try {
    let image
    let label
    if (target === 'window') {
      if (!mainWindow || mainWindow.isDestroyed()) throw new Error('星界窗口尚未就绪')
      image = await mainWindow.webContents.capturePage()
      label = '星界窗口'
    } else {
      const display = screen.getPrimaryDisplay()
      const factor = display.scaleFactor || 1
      let width = Math.max(1, Math.round(display.size.width * factor))
      let height = Math.max(1, Math.round(display.size.height * factor))
      const scale = Math.min(1, 2560 / width, 1600 / height)
      width = Math.max(1, Math.round(width * scale))
      height = Math.max(1, Math.round(height * scale))
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height },
        fetchWindowIcons: false
      })
      const source = sources.find((item) => String(item.display_id) === String(display.id)) || sources[0]
      if (!source || !source.thumbnail || source.thumbnail.isEmpty()) throw new Error('无法捕获主屏幕')
      image = source.thumbnail
      label = '主屏幕'
    }

    let png = image.toPNG()
    let size = image.getSize()
    if (png.length > 7.5 * 1024 * 1024) {
      const ratio = Math.sqrt((7.5 * 1024 * 1024) / png.length)
      const resized = image.resize({
        width: Math.max(1, Math.round(size.width * ratio)),
        height: Math.max(1, Math.round(size.height * ratio)),
        quality: 'good'
      })
      png = resized.toPNG()
      size = resized.getSize()
    }

    const dir = path.join(CONFIG_DIR, 'data', 'screenshots')
    await fsp.mkdir(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = path.join(dir, `astral-screenshot-${stamp}.png`)
    await fsp.writeFile(file, png)
    return {
      ok: true,
      path: file,
      width: size.width,
      height: size.height,
      bytes: png.length,
      label,
      capturedAt: new Date().toISOString()
    }
  } catch (err) {
    return { ok: false, error: err.message || '截图失败' }
  }
}

const { createMcpRegistry } = require('./mcp-client.js')
const mcpRegistry = createMcpRegistry({
  configDir: CONFIG_DIR,
  /* 内置文件工具的可写/可读范围：桌面、文档、下载 */
  allowedRoots: () => {
    const roots = []
    for (const name of ['desktop', 'documents', 'downloads']) {
      try { roots.push(app.getPath(name)) } catch { /* 某些环境没有该目录 */ }
    }
    return roots
  },
  captureScreenshot,
  knowledge: async (tool, args, project) => {
    const service = await getKnowledgeService()
    return service.runTool(tool, args, project)
  },
  knowledgeEnabled: knowledgePluginEnabled,
  /* 工具执行端只认主进程签发的一次性令牌。 */
  verifyApproval: (token, call) => toolApprovals.consume(token, call)
})

app.setName('星界')

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'astral',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
  }
])

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.avif': 'image/avif',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
}

/* HTML 预览：按目录发放一次性 token，页面里的相对路径（css/js/图片）走同一条协议解析。
   只登记被预览文件的所在目录，token 失效后立即不可访问。 */
const previewRoots = new Map()
const PREVIEW_TOKEN_LIMIT = 12

function grantPreviewRoot (dir) {
  const token = crypto.randomBytes(6).toString('hex')
  /* 统一成分隔符归一化的绝对路径，否则与 path.join 的结果比较会误判 */
  previewRoots.set(token, path.resolve(dir))
  while (previewRoots.size > PREVIEW_TOKEN_LIMIT) {
    previewRoots.delete(previewRoots.keys().next().value)
  }
  return token
}

function registerAppProtocol () {
  protocol.handle('astral', async (request) => {
    try {
      const url = new URL(request.url)

      /* astral://preview/<token>/<相对路径>：HTML 预览沙箱 */
      if (url.hostname === 'preview') {
        const parts = url.pathname.split('/').filter(Boolean)
        const root = previewRoots.get(decodeURIComponent(parts.shift() || ''))
        if (!root) return new Response('preview expired', { status: 404 })
        const rel = decodeURIComponent(parts.join('/'))
        if (!rel) return new Response('not found', { status: 404 })
        const target = path.resolve(root, path.normalize(rel))
        if (target !== root && !target.startsWith(root + path.sep)) {
          return new Response('forbidden', { status: 403 })
        }
        const data = await fsp.readFile(target)
        return new Response(data, {
          status: 200,
          headers: {
            'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
            'cache-control': 'no-cache',
            /* 预览页面运行在不透明来源（sandbox），资源需要显式放开 */
            'access-control-allow-origin': '*',
            'cross-origin-resource-policy': 'cross-origin',
            'x-content-type-options': 'nosniff'
          }
        })
      }

      const baseDir = url.hostname === 'user' ? CONFIG_DIR : APP_DIR
      let rel = decodeURIComponent(url.pathname)
      if (!rel || rel === '/') rel = '/index.html'
      const target = path.join(baseDir, path.normalize(rel))
      if (!target.startsWith(baseDir)) return new Response('forbidden', { status: 403 })
      const data = await fsp.readFile(target)
      return new Response(data, {
        status: 200,
        headers: {
          'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
          'cache-control': 'no-cache'
        }
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

/* ---------------------------------------------------------------- config */

const CONFIG_FILES = ['settings.json', 'providers.json', 'roster.json', 'projects.json', 'team-templates.json']
const PROJECT_SESSIONS_DIR = () => path.join(CONFIG_DIR, 'projects')

async function ensureConfig () {
  await fsp.mkdir(CONFIG_DIR, { recursive: true })
  for (const file of CONFIG_FILES) {
    const dest = path.join(CONFIG_DIR, file)
    if (fs.existsSync(dest)) continue
    const src = path.join(APP_DIR, 'defaults', file)
    if (fs.existsSync(src)) await fsp.copyFile(src, dest)
  }
  for (const dir of ['skills', 'themes', 'plugins', 'data', 'projects', 'knowledge']) {
    await fsp.mkdir(path.join(CONFIG_DIR, dir), { recursive: true })
  }
}

async function readJson (file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson (file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fsp.rename(tmp, file)
}

function parseFrontMatter (text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) return { meta: {}, body: text }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim()
    let val = line.slice(idx + 1).trim()
    if (/^[\[{]/.test(val)) {
      try { val = JSON.parse(val) } catch { /* keep raw */ }
    } else {
      val = val.replace(/^['"]|['"]$/g, '')
    }
    meta[key] = val
  }
  return { meta, body: match[2] }
}

async function collectSkills () {
  const out = []
  const seen = new Set()
  const dirs = [path.join(APP_DIR, 'skills'), path.join(CONFIG_DIR, 'skills')]
  for (const dir of dirs) {
    let files = []
    try { files = await fsp.readdir(dir) } catch { continue }
    for (const name of files) {
      if (!name.endsWith('.md')) continue
      const raw = await fsp.readFile(path.join(dir, name), 'utf8')
      const { meta, body } = parseFrontMatter(raw)
      const id = meta.id || path.basename(name, '.md')
      if (seen.has(id)) continue
      seen.add(id)
      out.push({
        id,
        name: meta.name || id,
        desc: meta.desc || meta.description || '',
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        body: body.trim(),
        source: dir === path.join(CONFIG_DIR, 'skills') ? 'config' : 'app',
        builtin: dir.includes('config') === false
      })
    }
  }
  return out
}

/* ---------------------------------------------------------- 技能文件管理 */

const SKILL_FILE_MAX = 512 * 1024
const SKILL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

function skillIdFromContent (raw, fileName) {
  const meta = parseFrontMatter(raw).meta || {}
  return String(meta.id || path.basename(fileName, '.md')).trim()
}

async function findConfigSkillFile (id) {
  const dir = path.join(CONFIG_DIR, 'skills')
  let files = []
  try { files = await fsp.readdir(dir) } catch { return '' }
  for (const name of files) {
    if (!name.endsWith('.md')) continue
    try {
      const raw = await fsp.readFile(path.join(dir, name), 'utf8')
      if (skillIdFromContent(raw, name) === id) return path.join(dir, name)
    } catch { /* skip unreadable */ }
  }
  return ''
}

ipcMain.handle('astral:skills:upload', async () => {
  try {
    const scriptedSource = String(process.env.ASTRAL_SKILL_UPLOAD_SOURCE || '').trim()
    let source = scriptedSource
    if (!source) {
      const result = await dialog.showOpenDialog(mainWindow || undefined, {
        title: '上传技能文件',
        properties: ['openFile'],
        filters: [{ name: 'Markdown 技能文件', extensions: ['md'] }]
      })
      if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true }
      source = result.filePaths[0]
    }
    if (path.extname(source).toLowerCase() !== '.md') return { ok: false, error: '技能文件必须是 .md 格式' }
    const stat = await fsp.stat(source)
    if (!stat.isFile()) return { ok: false, error: '请选择技能文件，而不是目录' }
    if (stat.size > SKILL_FILE_MAX) return { ok: false, error: '技能文件不能超过 512 KB' }

    const raw = await fsp.readFile(source, 'utf8')
    const id = skillIdFromContent(raw, source)
    if (!SKILL_ID_RE.test(id)) return { ok: false, error: '技能 id 只能包含字母、数字、点、横线和下划线' }

    const before = await collectSkills()
    if (before.some((skill) => skill.id === id && skill.source === 'app')) {
      return { ok: false, error: `技能 id「${id}」与内置技能冲突，请修改技能文件里的 id` }
    }

    const skillDir = path.join(CONFIG_DIR, 'skills')
    await fsp.mkdir(skillDir, { recursive: true })
    let dest = await findConfigSkillFile(id)
    if (!dest) {
      const safeName = (path.basename(source).replace(/[^A-Za-z0-9._-]/g, '_') || 'skill.md')
      const base = safeName.toLowerCase().endsWith('.md') ? safeName : `${safeName}.md`
      dest = path.join(skillDir, base)
      if (fs.existsSync(dest)) {
        dest = path.join(skillDir, `${path.basename(base, '.md')}-${Date.now()}.md`)
      }
    }
    if (path.resolve(source) !== path.resolve(dest)) await fsp.copyFile(source, dest)

    const after = await collectSkills()
    const effective = after.find((skill) => skill.id === id && skill.source === 'config')
    if (!effective) {
      /* 被同名 app 技能挡住时不要把无效文件留在 user 目录。 */
      if (path.resolve(source) !== path.resolve(dest)) await fsp.unlink(dest).catch(() => {})
      return { ok: false, error: `技能 id「${id}」未能生效，请检查是否与内置技能重名` }
    }
    return { ok: true, skills: after, id, name: effective.name }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
})

ipcMain.handle('astral:skills:delete', async (_event, payload = {}) => {
  try {
    const id = String(payload.id || '').trim()
    if (!SKILL_ID_RE.test(id)) return { ok: false, error: '技能 id 无效' }
    const file = await findConfigSkillFile(id)
    if (!file) return { ok: false, error: '只能删除 config/skills 下的自定义技能' }
    await fsp.unlink(file)
    return { ok: true, skills: await collectSkills() }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
})

async function collectThemes () {
  const out = []
  const seen = new Set()
  for (const dir of [path.join(APP_DIR, 'themes'), path.join(CONFIG_DIR, 'themes')]) {
    let files = []
    try { files = await fsp.readdir(dir) } catch { continue }
    for (const name of files) {
      if (!name.endsWith('.json')) continue
      const data = await readJson(path.join(dir, name), null)
      if (!data || !data.id || seen.has(data.id)) continue
      seen.add(data.id)
      out.push(data)
    }
  }
  /* 默认主题排最前：所有「查不到就取 themes[0]」的回退
     （渲染层 currentTheme、确认窗 dialogThemeTokens）都应回到
     出厂默认的深空，而不是碰巧排在字母序第一的主题（如 apricot）。 */
  const idx = out.findIndex((item) => item.id === 'astral')
  if (idx > 0) out.unshift(out.splice(idx, 1)[0])
  return out
}

async function collectPlugins () {
  const out = []
  const seen = new Set()
  /* 用户目录优先：同 id 时 config/ 覆盖内置 app/（与插件文档一致）。 */
  for (const [dir, scope] of [[path.join(CONFIG_DIR, 'plugins'), 'user'], [path.join(APP_DIR, 'plugins'), 'app']]) {
    let entries = []
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const manifestPath = path.join(dir, entry.name, 'plugin.json')
      const manifest = await readJson(manifestPath, null)
      if (!manifest || !manifest.id || seen.has(manifest.id)) continue
      seen.add(manifest.id)
      const normalized = normalizePluginManifest(manifest, scope, entry.name)
      out.push({
        ...normalized,
        entryUrl: scope === 'user'
          ? `astral://user/plugins/${entry.name}/${normalized.entry}`
          : `astral://app/plugins/${entry.name}/${normalized.entry}`
      })
    }
  }
  return out
}

/* ------------------------------------------------------------- llm proxy */

function parseToolArguments (raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function toAnthropicTools (tools) {
  if (!Array.isArray(tools)) return []
  return tools
    .map((tool) => tool && tool.function)
    .filter((fn) => fn && fn.name)
    .map((fn) => ({
      name: fn.name,
      description: fn.description || '',
      input_schema: fn.parameters && typeof fn.parameters === 'object'
        ? fn.parameters
        : { type: 'object', properties: {} }
    }))
}

function toAnthropicBlocks (content) {
  if (Array.isArray(content)) return content
  if (content == null || content === '') return []
  return [{ type: 'text', text: String(content) }]
}

function toAnthropicMessages (messages) {
  const out = []
  const push = (role, blocks) => {
    if (!blocks.length) return
    const last = out[out.length - 1]
    if (last && last.role === role) {
      last.content = [...toAnthropicBlocks(last.content), ...blocks]
      return
    }
    out.push({ role, content: blocks })
  }

  for (const message of messages) {
    if (!message || message.role === 'system') continue
    if (message.role === 'tool') {
      const content = typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content == null ? '' : message.content)
      push('user', [{
        type: 'tool_result',
        tool_use_id: message.tool_call_id || message.tool_use_id || '',
        content
      }])
      continue
    }
    if (message.role === 'assistant') {
      const blocks = []
      const text = typeof message.content === 'string'
        ? message.content
        : (Array.isArray(message.content) ? message.content.map((part) => part && part.text ? part.text : '').join('') : '')
      if (text) blocks.push({ type: 'text', text })
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      calls.forEach((call, index) => {
        const fn = (call && call.function) || {}
        if (!fn.name) return
        blocks.push({
          type: 'tool_use',
          id: call.id || `toolu_${Date.now().toString(36)}_${index}`,
          name: fn.name,
          input: parseToolArguments(fn.arguments)
        })
      })
      push('assistant', blocks)
      continue
    }
    push('user', toAnthropicBlocks(message.content))
  }
  return out
}

function ollamaMessages (messages) {
  const names = new Map()
  for (const message of messages) {
    if (!message || !Array.isArray(message.tool_calls)) continue
    for (const call of message.tool_calls) {
      if (call && call.id && call.function && call.function.name) names.set(call.id, call.function.name)
    }
  }
  return messages.map((message) => {
    if (message && message.role === 'tool' && !message.tool_name && names.has(message.tool_call_id)) {
      return { ...message, tool_name: names.get(message.tool_call_id) }
    }
    return message
  })
}

function buildRequest (provider, payload) {
  const kind = provider.kind || 'openai'
  const base = String(provider.baseUrl || '').replace(/\/+$/, '')
  const key = provider.apiKey || ''
  const messages = payload.messages || []
  const temperature = typeof payload.temperature === 'number' ? payload.temperature : 0.7
  const maxTokens = payload.maxTokens || 4096
  const reasoning = payload.reasoning || null
  const level = reasoning && reasoning.value

  if (kind === 'anthropic') {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const body = {
      model: payload.model,
      system,
      messages: toAnthropicMessages(messages),
      temperature,
      max_tokens: maxTokens,
      stream: true
    }
    const tools = toAnthropicTools(payload.tools)
    if (tools.length) {
      body.tools = tools
      body.tool_choice = { type: 'auto' }
    }

    /* Anthropic 的思考预算要求 temperature=1，且 max_tokens 必须大于预算 */
    if (reasoning && reasoning.mode === 'budget' && level) {
      const budget = Number(level) || 2048
      body.thinking = { type: 'enabled', budget_tokens: budget }
      body.temperature = 1
      body.max_tokens = Math.max(maxTokens, budget + 1024)
    }

    return {
      kind,
      url: `${base}/messages`,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body
    }
  }

  if (kind === 'ollama') {
    const body = {
      model: payload.model,
      messages: ollamaMessages(messages),
      stream: true,
      options: { temperature }
    }
    if (Array.isArray(payload.tools) && payload.tools.length) body.tools = payload.tools
    return {
      kind,
      url: `${base}/api/chat`,
      headers: { 'content-type': 'application/json' },
      body
    }
  }

  const body = { model: payload.model, messages, temperature, stream: true }
  /* DeepSeek V4 默认开启 thinking；在带工具的请求里它可能只返回 reasoning_content，
     没有 content/tool_calls，表现为「本轮没有产出」。工具调用本身只要求结构化输出，
     因此带工具时显式关闭 thinking；无工具请求仍保留默认 thinking。 */
  const deepseek = provider.id === 'deepseek' || /api\.deepseek\.com/i.test(base)
  if (Array.isArray(payload.tools) && payload.tools.length && deepseek) {
    body.thinking = { type: 'disabled' }
  }
  /* 让 OpenAI 兼容端点把流式 usage 放在最后一个 chunk。
     不支持该字段的端点通常只是忽略它；真实用量拿不到时前端会显示「未返回」。 */
  body.stream_options = { include_usage: true }
  if (Array.isArray(payload.tools) && payload.tools.length) {
    body.tools = payload.tools
    body.tool_choice = 'auto'
  }
  if (reasoning && reasoning.mode === 'effort' && level) {
    if (reasoning.style === 'object') {
      /* OpenRouter 契约：reasoning: { effort }，且不接受 none —— 关掉就整个字段不发 */
      if (level !== 'none') body.reasoning = { effort: level }
    } else if (level !== 'none') {
      body.reasoning_effort = level
    }
  }

  return {
    kind: 'openai',
    url: `${base}/chat/completions`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body
  }
}

function extractDelta (json, kind) {
  if (kind === 'anthropic') {
    if (json.type === 'content_block_delta') return json.delta && json.delta.text ? json.delta.text : ''
    return ''
  }
  if (kind === 'ollama') {
    return (json.message && json.message.content) || ''
  }
  const choice = json.choices && json.choices[0]
  if (!choice) return ''
  return (choice.delta && choice.delta.content) || ''
}

function extractFull (json, kind) {
  if (kind === 'anthropic') {
    return (json.content || []).map((part) => part.text || '').join('')
  }
  if (kind === 'ollama') return (json.message && json.message.content) || ''
  const choice = json.choices && json.choices[0]
  if (!choice) return ''
  return (choice.message && choice.message.content) || ''
}

/* 把流式增量里的 tool_calls 合并成完整调用。OpenAI 兼容协议会在
   delta.tool_calls 里分片下发 id / name / arguments，需要按 index 累积。 */
function collectToolCalls (json, kind, map) {
  if (!json) return

  const push = (index, id, name, args) => {
    const idx = Number.isInteger(index) ? index : 0
    const cur = map.get(idx) || { id: '', name: '', arguments: '' }
    if (id) cur.id = String(id)
    if (name) cur.name = String(name)
    if (args != null) cur.arguments += typeof args === 'string' ? args : JSON.stringify(args)
    map.set(idx, cur)
  }

  if (kind === 'anthropic') {
    if (json.type === 'content_block_start' && json.content_block && json.content_block.type === 'tool_use') {
      const block = json.content_block
      push(json.index, block.id, block.name, '')
    }
    if (json.type === 'content_block_delta' && json.delta && json.delta.type === 'input_json_delta') {
      const cur = map.get(json.index) || { id: '', name: '', arguments: '' }
      cur.arguments += json.delta.partial_json || ''
      map.set(json.index, cur)
    }
    if (Array.isArray(json.content)) {
      json.content.forEach((block, index) => {
        if (block && block.type === 'tool_use') push(index, block.id, block.name, block.input || {})
      })
    }
    return
  }

  if (kind === 'ollama') {
    const calls = (json.message && json.message.tool_calls) || []
    calls.forEach((call, i) => {
      const fn = (call && call.function) || {}
      push(i, call && call.id, fn.name, fn.arguments)
    })
    return
  }

  const choice = json.choices && json.choices[0]
  const list = (choice && choice.delta && choice.delta.tool_calls) ||
    (choice && choice.message && choice.message.tool_calls) || []
  for (const call of list) {
    const fn = (call && call.function) || {}
    push(call && call.index, call && call.id, fn.name, fn.arguments)
  }
}

function finalizeToolCalls (map) {
  const out = []
  for (const [idx, call] of map) {
    if (!call.name) continue
    out.push({
      id: call.id || `call_${idx}_${Date.now().toString(36)}`,
      type: 'function',
      function: { name: call.name, arguments: call.arguments || '{}' }
    })
  }
  return out
}

/* ------------------------------------------------- 调用重试（超时 / 断线）

   触发条件：网络错误、连接被对端关闭、空闲超时、HTTP 429/5xx。
   不重试：参数错误、鉴权失败（4xx 中的 400/401/403/404/422）与主动取消。
   退避：base * 2^(n-1)，带 ±20% 抖动，上限 maxDelayMs。 */

const RETRY_DEFAULTS = {
  enabled: true,
  maxAttempts: 3,
  timeoutMs: 60000,
  baseDelayMs: 1000,
  maxDelayMs: 8000
}

function normalizeRetry (raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const num = (value, fallback, min, max) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, Math.round(n)))
  }
  const timeoutMs = src.timeoutSec != null
    ? num(src.timeoutSec, RETRY_DEFAULTS.timeoutMs / 1000, 5, 600) * 1000
    : num(src.timeoutMs, RETRY_DEFAULTS.timeoutMs, 5000, 600000)
  return {
    enabled: src.enabled !== false,
    maxAttempts: num(src.maxAttempts, RETRY_DEFAULTS.maxAttempts, 1, 6),
    timeoutMs,
    baseDelayMs: num(src.baseDelayMs, RETRY_DEFAULTS.baseDelayMs, 200, 30000),
    maxDelayMs: num(src.maxDelayMs, RETRY_DEFAULTS.maxDelayMs, 500, 60000)
  }
}

function retryDelay (attempt, cfg) {
  /* 指数退避 + 抖动：多个成员同时撞上限流时不会一起重试 */
  const base = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * Math.pow(2, attempt - 1))
  return Math.round(base * (0.8 + Math.random() * 0.4))
}

function llmError (message, extra = {}) {
  const err = new Error(message)
  err.retryable = extra.retryable !== false
  err.status = Number(extra.status) || 0
  err.retryAfter = Number(extra.retryAfter) || 0
  return err
}

function isRetryableStatus (status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}

async function streamChat (req, onDelta, opts = {}) {
  const controller = opts.controller || new AbortController()
  const idleMs = Number(opts.idleMs) || 0
  let timedOut = false
  let timer = 0
  let terminated = false
  const toolMap = new Map()
  let usage = null

  /* 空闲超时：每收到一块数据就重置。流式回答可能很长，
     但「长时间一个字都不来」才说明连接已经废了。 */
  const arm = () => {
    if (!idleMs) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = true
      try { controller.abort() } catch { /* ignore */ }
    }, idleMs)
  }
  arm()

  try {
    const res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: controller.signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const retryAfter = Number(res.headers.get('retry-after') || 0)
      throw llmError(`HTTP ${res.status} · ${text.slice(0, 500)}`, {
        retryable: isRetryableStatus(res.status),
        status: res.status,
        retryAfter: Number.isFinite(retryAfter) ? retryAfter : 0
      })
    }
    const ctype = res.headers.get('content-type') || ''
    if (!ctype.includes('event-stream') && !ctype.includes('ndjson')) {
      const text = await res.text()
      arm()
      try {
        const json = JSON.parse(text)
        collectToolCalls(json, req.kind, toolMap)
        usage = mergeUsage(usage, json, req.kind)
        const full = extractFull(json, req.kind)
        if (full) onDelta(full)
        return { toolCalls: finalizeToolCalls(toolMap), terminated: true, usage }
      } catch {
        if (!text.trim()) throw llmError('服务端返回了空响应', { retryable: true })
        onDelta(text)
        return { toolCalls: finalizeToolCalls(toolMap), terminated: true, usage }
      }
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      arm()
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line || line.startsWith(':') || line.startsWith('event:')) continue
        const raw = line.startsWith('data:') ? line.slice(5).trim() : line
        if (!raw) continue
        if (raw === '[DONE]') { terminated = true; continue }
        let json
        try { json = JSON.parse(raw) } catch { continue }
        if (json.type === 'message_stop' || json.done === true) terminated = true
        collectToolCalls(json, req.kind, toolMap)
        usage = mergeUsage(usage, json, req.kind)
        const delta = extractDelta(json, req.kind)
        if (delta) onDelta(delta)
        const choice = json.choices && json.choices[0]
        if (choice && choice.finish_reason) terminated = true
      }
    }
    return { toolCalls: finalizeToolCalls(toolMap), terminated, usage }
  } catch (err) {
    if (timedOut) {
      throw llmError(`连接超时：${Math.round(idleMs / 1000)} 秒内没有收到任何数据`, { retryable: true })
    }
    if (err && err.retryable !== undefined) throw err
    if (err && (err.name === 'AbortError')) throw llmError('请求已取消', { retryable: false })
    throw llmError(`网络连接失败：${err && err.message ? err.message : String(err)}`, { retryable: true })
  } finally {
    clearTimeout(timer)
  }
}

async function providerWithKey (provider = {}) {
  const copy = { ...provider }
  if (copy.kind !== 'ollama' && copy.id) {
    copy.apiKey = await secrets.getKey(copy.id)
  }
  return copy
}

ipcMain.handle('astral:llm:start', async (event, payload) => {
  const id = payload.id
  const sender = event.sender
  const controller = new AbortController()
  llmControllers.set(id, controller)
  const send = (type, data) => {
    if (sender.isDestroyed()) return
    sender.send('astral:llm:event', { id, type, ...(data || {}) })
  }
  ;(async () => {
    let provider
    try {
      provider = await providerWithKey(payload.provider || {})
    } catch (err) {
      send('error', { message: err.message || '读取 API Key 失败' })
      return
    }
    if (provider.kind !== 'ollama' && !provider.apiKey) {
      send('error', { message: '该供应商还没有保存 API Key' })
      return
    }
    const retry = normalizeRetry(payload.retry)
    const maxAttempts = retry.enabled ? retry.maxAttempts : 1
    let attempt = 0
    let lastError = null

    while (attempt < maxAttempts) {
      attempt++
      if (sender.isDestroyed()) return
      if (controller.signal.aborted) {
        send('error', { message: '请求已取消' })
        return
      }
      let full = ''
      let emitted = false
      try {
        const req = buildRequest(provider, payload)
        const out = await streamChat(req, (delta) => {
          emitted = true
          full += delta
          send('delta', { text: delta })
        }, { idleMs: retry.timeoutMs, controller })

        /* 没有结束标记 = 对端在传输中途把连接关了。还能重试就重来，
           最后一轮仍然如此就按成功收尾，只提示可能不完整。 */
        if (!out.terminated) {
          if (attempt < maxAttempts) {
            throw llmError('连接在传输结束前断开（未收到结束标记）', { retryable: true })
          }
          send('warning', { message: '响应缺少结束标记，内容可能不完整' })
        }

        if (out.toolCalls.length) send('toolCalls', { calls: out.toolCalls })
        if (out.usage) send('usage', { usage: out.usage })
        send('done', { text: full })
        return
      } catch (err) {
        lastError = err
        if (controller.signal.aborted) {
          send('error', { message: '请求已取消' })
          return
        }
        if (!err || err.retryable === false || attempt >= maxAttempts) break
        const wait = err.retryAfter > 0
          ? Math.min(30000, err.retryAfter * 1000)
          : retryDelay(attempt, retry)
        send('retry', {
          attempt,
          next: attempt + 1,
          max: maxAttempts,
          delay: wait,
          reason: err && err.message ? err.message : String(err),
          reset: emitted
        })
        await new Promise((resolve) => setTimeout(resolve, wait))
        if (sender.isDestroyed()) return
      }
    }
    send('error', { message: lastError && lastError.message ? lastError.message : '模型调用失败' })
  })().finally(() => {
    if (llmControllers.get(id) === controller) llmControllers.delete(id)
  })
  return { ok: true, id }
})

ipcMain.handle('astral:llm:stop', async (_event, payload = {}) => {
  const id = String(payload.id || '')
  const controller = llmControllers.get(id)
  if (!controller) return { ok: false, error: '没有正在进行的模型请求' }
  try { controller.abort() } catch { /* ignore */ }
  return { ok: true, id }
})

ipcMain.handle('astral:llm:test', async (_event, payload) => {
  try {
    const provider = await providerWithKey(payload.provider || {})
    const req = buildRequest(provider, {
      model: payload.model,
      messages: [
        { role: 'system', content: '你是连接测试助手。' },
        { role: 'user', content: '只回复两个字：在线' }
      ],
      temperature: 0,
      maxTokens: 32
    })
    let text = ''
    await streamChat(req, (delta) => { text += delta }, { idleMs: 30000 })
    return { ok: true, text: text.slice(0, 200) }
  } catch (err) {
    return { ok: false, message: err && err.message ? err.message : String(err) }
  }
})

/* ------------------------------------------------------- mcp client (工具) */

ipcMain.handle('astral:mcp:list', async () => {
  try {
    return mcpRegistry.snapshot()
  } catch (err) {
    return { ok: false, error: err.message, servers: [] }
  }
})

ipcMain.handle('astral:mcp:reload', async () => {
  try {
    return await mcpRegistry.reload()
  } catch (err) {
    return { ok: false, error: err.message, servers: [] }
  }
})

async function dialogThemeTokens () {
  try {
    const settings = await readJson(path.join(CONFIG_DIR, 'settings.json'), {})
    const themes = await collectThemes()
    const theme = themes.find((item) => item.id === (settings.theme || 'astral')) || themes[0]
    return theme && theme.tokens && typeof theme.tokens === 'object' ? theme.tokens : {}
  } catch {
    return {}
  }
}

async function confirmToolCall (effective, decision) {
  /* 自动化测试：ASTRAL_TEST_APPROVAL=1 时按 ASTRAL_APPROVAL_CHOICES 队列取 0/1/2，
     ASTRAL_APPROVAL_CHOICE 是单值版本。生产环境不设置这两个变量。 */
  if (process.env.ASTRAL_TEST_APPROVAL === '1') {
    const raw = process.env.ASTRAL_APPROVAL_CHOICES || process.env.ASTRAL_APPROVAL_CHOICE || ''
    const choices = raw.split(',').map((item) => Number(item)).filter((item) => item === 0 || item === 1 || item === 2)
    if (!choices.length) return 2
    const choice = choices.shift()
    process.env.ASTRAL_APPROVAL_CHOICES = choices.join(',')
    return choice
  }

  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getFocusedWindow()
  const args = JSON.stringify(effective.args || {}, null, 2)
  const detail = [
    `工具：${effective.serverId || '未知服务器'} / ${effective.tool || '未知工具'}`,
    `成员：${effective.agentName || effective.agentId || '未知'} · 项目：${effective.projectName || effective.projectId || '当前项目'}`,
    `运行：${effective.runId || '未知'}（发起成员：${effective.runAgentId || '未知'}）`,
    `能力：${(decision.capabilities || []).join('、') || '无特殊能力'}`,
    '',
    '参数：',
    args.slice(0, 3000) + (args.length > 3000 ? '\n…（参数过长，已截断）' : '')
  ].join('\n')
  try {
    const choice = await showThemedConfirm({
      parent: win,
      title: '允许调用工具？',
      message: '这个工具会在你的电脑上执行实际操作',
      detail,
      actions: [
        { value: 0, label: '允许一次', style: 'primary' },
        { value: 1, label: '始终允许', style: 'ghost' },
        { value: 2, label: '拒绝', style: 'danger' }
      ],
      cancelValue: 2,
      themeTokens: await dialogThemeTokens(),
      width: 620,
      height: 640
    })
    return typeof choice === 'number' ? choice : 2
  } catch {
    return 2
  }
}

ipcMain.handle('astral:mcp:call', async (_event, payload = {}) => {
  const startedAt = Date.now()
  /* 渲染层可能塞 approved / approvalToken 试图绕过；主进程一律忽略。
     真正的授权只来自主进程：正在运行的 run + 权限权威判定 + 原生确认 + 一次性令牌。 */
  const clientApprovalIgnored = payload.approved === true || Boolean(payload.approvalToken)

  /* 工具调用必须绑定到主进程记录中正在运行的 run，并出示 runStart 下发的能力令牌。
     这样渲染层不能凭空造一个 agentId/projectId 调工具，也不能在 run 结束后继续用旧凭据。 */
  const runId = String(payload.runId || '')
  const runCapability = runCapabilities.get(runId)
  const runLookup = runId ? runStore.get(runId) : null
  const run = runLookup && runLookup.ok ? runLookup.run : null
  const runOk = Boolean(
    run &&
    run.projectId &&
    run.status === 'running' &&
    runCapability &&
    secretMatches(runCapability, payload.runCapability)
  )
  if (!runOk) {
    const error = runId
      ? '工具调用未绑定到主进程正在运行的 run（runId/能力令牌无效或已结束）'
      : '工具调用缺少 runId，必须来自一次正在运行的协作'
    const denied = { ok: false, capabilities: [], policy: 'run', error }
    toolGateway.record({
      payload: { ...payload, clientApprovalIgnored },
      decision: denied,
      durationMs: Date.now() - startedAt
    })
    return { ok: false, denied: true, error, reason: 'run-required' }
  }
  if (payload.projectId && String(payload.projectId) !== String(run.projectId)) {
    const error = '工具调用项目与运行记录不一致'
    const denied = { ok: false, capabilities: [], policy: 'run', error }
    toolGateway.record({
      payload: { ...payload, clientApprovalIgnored },
      decision: denied,
      durationMs: Date.now() - startedAt
    })
    return { ok: false, denied: true, error, reason: 'project-mismatch' }
  }

  const projectId = String(run.projectId)
  const agentAuthority = permissionAuthority.resolve({ projectId, agentId: payload.agentId })
  if (!agentAuthority.ok) {
    const denied = { ok: false, capabilities: [], policy: 'authority', error: agentAuthority.error }
    toolGateway.record({ payload: { ...payload, clientApprovalIgnored }, decision: denied, durationMs: Date.now() - startedAt })
    return { ok: false, denied: true, error: agentAuthority.error, reason: agentAuthority.reason || '' }
  }
  const ownerAuthority = permissionAuthority.resolve({ projectId, agentId: run.agentId })
  if (!ownerAuthority.ok) {
    const denied = { ok: false, capabilities: [], policy: 'authority', error: ownerAuthority.error }
    toolGateway.record({ payload: { ...payload, clientApprovalIgnored }, decision: denied, durationMs: Date.now() - startedAt })
    return { ok: false, denied: true, error: ownerAuthority.error, reason: ownerAuthority.reason || '' }
  }

  /* 子成员的工具权限不能超过本次 run 的发起成员：避免在同一个 run 里换用更特权成员。 */
  const permissions = intersectPermissions(ownerAuthority.permissions, agentAuthority.permissions)

  /* 渲染层传来的 permissions / approved / approvalToken 只作为兼容信息丢弃；
     真正用于判定的是 run 项目下、发起成员与执行成员权限的交集。 */
  const effective = {
    ...payload,
    agentId: agentAuthority.agent.id,
    agentName: agentAuthority.agent.name || agentAuthority.agent.id,
    runId: run.id,
    runAgentId: run.agentId,
    projectId: ownerAuthority.project.id,
    projectName: run.projectName || ownerAuthority.project.name,
    projectRoot: ownerAuthority.project.rootPath || '',
    permissions,
    permissionScope: 'run-intersection',
    clientApprovalIgnored
  }
  delete effective.approved
  delete effective.approvalToken
  delete effective.approvalSource
  delete effective.approvalId
  delete effective.runCapability

  const decision = toolGateway.evaluate(effective)
  if (!decision.ok) {
    toolGateway.record({ payload: effective, decision, durationMs: Date.now() - startedAt })
    return {
      ok: false,
      denied: true,
      error: decision.error,
      capabilities: decision.capabilities
    }
  }

  /* 敏感工具由主进程原生对话框确认，渲染层无法伪造确认。 */
  const allGranted = ['readFiles', 'writeFiles', 'runCommands', 'network', 'tools', 'memory']
    .every((key) => Boolean(permissions[key]))
  const auto = permissions.full || allGranted || mcpRegistry.isAutoApproved(effective.serverId, effective.tool)
  let approvalSource = auto ? 'auto' : ''
  if (!auto) {
    const choice = await confirmToolCall(effective, decision)
    if (choice !== 0 && choice !== 1) {
      const denied = { ...decision, ok: false, error: '用户拒绝了这个工具的调用' }
      toolGateway.record({
        payload: effective,
        decision: denied,
        durationMs: Date.now() - startedAt,
        approval: { source: 'denied', ok: false }
      })
      return { ok: false, denied: true, error: '用户拒绝了这个工具的调用' }
    }
    if (choice === 1) {
      try {
        const allowed = await mcpRegistry.allowAlways(effective.serverId, effective.tool)
        if (!allowed || allowed.ok === false) {
          const error = (allowed && allowed.error) || '保存自动允许失败'
          toolGateway.record({
            payload: effective,
            decision,
            result: { ok: false, error },
            durationMs: Date.now() - startedAt,
            approval: { source: 'always', ok: false }
          })
          return { ok: false, error }
        }
      } catch (err) {
        toolGateway.record({
          payload: effective,
          decision,
          result: { ok: false, error: err.message },
          durationMs: Date.now() - startedAt,
          approval: { source: 'always', ok: false }
        })
        return { ok: false, error: err.message }
      }
    }
    approvalSource = choice === 1 ? 'always' : 'once'
  }

  let approval = null
  try {
    /* 令牌绑定工具、参数、成员、项目与运行；执行端只认令牌，不认布尔值。 */
    approval = toolApprovals.issue({
      serverId: effective.serverId,
      tool: effective.tool,
      args: effective.args || {},
      agentId: effective.agentId,
      projectId: effective.projectId,
      runId: effective.runId || ''
    }, { source: approvalSource })
    const approvedPayload = {
      ...effective,
      approvalSource: approval.source,
      approvalId: approval.id
    }
    const result = await mcpRegistry.call({
      ...approvedPayload,
      approvalToken: approval.token
    })
    toolGateway.record({
      payload: approvedPayload,
      decision,
      result,
      durationMs: Date.now() - startedAt,
      approval
    })
    return result
  } catch (err) {
    toolGateway.record({
      payload: effective,
      decision,
      result: { ok: false, error: err.message },
      durationMs: Date.now() - startedAt,
      approval
    })
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('astral:audit:list', async (_event, payload = {}) => toolGateway.list(payload))
ipcMain.handle('astral:audit:capabilities', async () => toolGateway.describeCapabilities())
ipcMain.handle('astral:build:info', async () => currentBuildInfo())

/* 尚未完成的发布/集成能力：明确返回 unsupported，调用方不要假装已具备。 */
ipcMain.handle('astral:capabilities', async () => ({
  ok: true,
  signing: {
    supported: false,
    reason: '未配置代码签名证书（需要 .pfx/证书与密码）'
  },
  updater: {
    supported: false,
    reason: '未配置自动更新发布源/更新服务'
  },
  webSearch: {
    supported: false,
    reason: '未配置搜索 API 或外部搜索 MCP 服务；可接入 MCP 工具代替'
  },
  usage: { supported: true },
  mcpTransports: ['stdio']
}))
ipcMain.handle('astral:diagnostics:export', async () => {
  try {
    return diagnostics.exportPackage()
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('astral:mcp:setEnabled', async (_event, payload = {}) => {
  try {
    return await mcpRegistry.setEnabled(payload.serverId, payload.enabled)
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('astral:mcp:openConfig', async () => {
  return shell.openPath(mcpRegistry.configPath)
})

/* ------------------------------------------------------------- mcp bridge */

const BRIDGE_PENDING = new Map()
let bridgeServer = null
let bridgePort = 0
let bridgeToken = ''

function readBody (req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', () => resolve(''))
  })
}

function corsHeaders () {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-astral-token, authorization',
    'access-control-allow-methods': 'POST, GET, OPTIONS'
  }
}

function listen (server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.removeListener('listening', onListening); reject(err) }
    const onListening = () => { server.removeListener('error', onError); resolve(server.address().port) }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

async function startBridge (win, preferredPort, token) {
  const server = http.createServer(async (req, res) => {
    const cors = corsHeaders()
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }
    const url = new URL(req.url, 'http://127.0.0.1')

    if (url.pathname === '/health') {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, app: 'astral-realm', port: bridgePort, tokenRequired: Boolean(token) }))
    }
    if (url.pathname !== '/rpc') {
      res.writeHead(404, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'not_found' }))
    }
    if (token) {
      const provided = req.headers['x-astral-token'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
      if (provided !== token) {
        res.writeHead(401, { ...cors, 'content-type': 'application/json' })
        return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null }))
      }
    }
    const body = await readBody(req)
    let msg
    try {
      msg = JSON.parse(body)
    } catch {
      res.writeHead(400, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null }))
    }
    if (win.isDestroyed()) {
      res.writeHead(503, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'app window closed' }, id: msg.id ?? null }))
    }

    const requestId = crypto.randomUUID()
    const pending = new Promise((resolve) => {
      BRIDGE_PENDING.set(requestId, resolve)
      setTimeout(() => {
        if (BRIDGE_PENDING.delete(requestId)) resolve({ error: { code: -32002, message: 'timeout' } })
      }, 180000)
    })
    win.webContents.send('astral:bridge', { id: requestId, method: msg.method, params: msg.params || {} })
    const outcome = await pending
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    const payload = { jsonrpc: '2.0', id: msg.id ?? null }
    if (outcome && outcome.error) payload.error = outcome.error
    else payload.result = (outcome && outcome.result) ?? null
    res.end(JSON.stringify(payload))
  })

  let port = preferredPort
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const bound = await listen(server, port)
      bridgeServer = server
      bridgePort = bound
      return { ok: true, port: bound }
    } catch (err) {
      if (err.code !== 'EADDRINUSE') return { ok: false, message: err.message }
      port += 1
    }
  }
  return { ok: false, message: 'no free port' }
}

ipcMain.on('astral:bridge:reply', (_event, msg) => {
  const resolve = BRIDGE_PENDING.get(msg.id)
  if (!resolve) return
  BRIDGE_PENDING.delete(msg.id)
  resolve(msg.result)
})

/* --------------------------------------------------------------- bootstrap */

async function bootPayload () {
  const settings = await readJson(path.join(CONFIG_DIR, 'settings.json'), {})
  const rawProviders = await readJson(path.join(CONFIG_DIR, 'providers.json'), { providers: [] })
  const providers = await secrets.hydrateProviders(rawProviders)
  const roster = await readJson(path.join(CONFIG_DIR, 'roster.json'), { agents: [] })
  const projects = await readJson(path.join(CONFIG_DIR, 'projects.json'), { version: 1, activeProjectId: null, projects: [] })
  const teamTemplates = await readJson(path.join(CONFIG_DIR, 'team-templates.json'), { version: 1, templates: [] })
  return {
    settings,
    providers,
    roster,
    projects,
    teamTemplates,
    themes: await collectThemes(),
    skills: await collectSkills(),
    plugins: await collectPlugins(),
    bridge: { port: bridgePort, token: bridgeToken },
    dirs: { config: CONFIG_DIR, app: APP_DIR, root: ROOT, data: path.join(CONFIG_DIR, 'data'), projects: PROJECT_SESSIONS_DIR() },
    version: app.getVersion()
  }
}

ipcMain.handle('astral:boot', async () => bootPayload())

ipcMain.handle('astral:saveConfig', async (_event, file, data) => {
  if (!CONFIG_FILES.includes(file)) return { ok: false, message: 'unknown config file' }
  try {
    if (file === 'providers.json') {
      return await secrets.saveProviders(data)
    }
    await writeJson(path.join(CONFIG_DIR, file), data)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err.message }
  }
})

ipcMain.handle('astral:providerKey:set', async (_event, payload = {}) => {
  return secrets.setKey(payload.id, payload.key)
})
ipcMain.handle('astral:providerKey:clear', async (_event, payload = {}) => {
  return secrets.clearKey(payload.id)
})
ipcMain.handle('astral:providerKey:has', async (_event, payload = {}) => {
  return { ok: true, hasKey: await secrets.hasKey(payload.id) }
})

/* ------------------------------------------------------ 内置知识库存储 */

const KNOWLEDGE_DIR = () => path.join(CONFIG_DIR, 'knowledge')

function knowledgeFile (projectId) {
  const key = String(projectId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'default'
  return path.join(KNOWLEDGE_DIR(), `${key}.json`)
}

async function readKnowledge (projectId) {
  const data = await readJson(knowledgeFile(projectId), { version: 1, entries: [] })
  return {
    version: 1,
    entries: Array.isArray(data && data.entries) ? data.entries : []
  }
}

ipcMain.handle('astral:knowledge:list', async (_event, payload = {}) => {
  try {
    const data = await readKnowledge(payload.projectId)
    return { ok: true, entries: data.entries }
  } catch (err) {
    return { ok: false, error: err.message, entries: [] }
  }
})

ipcMain.handle('astral:knowledge:save', async (_event, payload = {}) => {
  try {
    const projectId = payload.projectId
    const file = knowledgeFile(projectId)
    const data = await readKnowledge(projectId)
    const source = payload.entry || {}
    const title = String(source.title || '').trim().slice(0, 200)
    const content = String(source.content || '').trim()
    if (!title) return { ok: false, error: '标题不能为空' }
    if (!content) return { ok: false, error: '内容不能为空' }
    if (Buffer.byteLength(content, 'utf8') > 200 * 1024) return { ok: false, error: '单条内容超过 200KB 上限' }
    const kind = ['资料', '方法', '避错'].includes(source.kind) ? source.kind : '资料'
    const tags = (Array.isArray(source.tags) ? source.tags : String(source.tags || '').split(/[,，、\s]+/))
      .map((tag) => String(tag || '').trim())
      .filter(Boolean)
      .slice(0, 20)
    const now = Date.now()
    const id = String(source.id || `kb_${now.toString(36)}_${crypto.randomBytes(3).toString('hex')}`)
    const existing = data.entries.findIndex((entry) => entry.id === id)
    const entry = {
      id,
      title,
      content,
      kind,
      tags,
      createdAt: existing >= 0 ? data.entries[existing].createdAt || now : now,
      updatedAt: now
    }
    if (existing >= 0) data.entries[existing] = entry
    else data.entries.unshift(entry)
    data.entries = data.entries.slice(0, 1000)
    await writeJson(file, { version: 1, entries: data.entries })
    return { ok: true, entry, entries: data.entries }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('astral:knowledge:delete', async (_event, payload = {}) => {
  try {
    const data = await readKnowledge(payload.projectId)
    const id = String(payload.id || '')
    data.entries = data.entries.filter((entry) => entry.id !== id)
    await writeJson(knowledgeFile(payload.projectId), { version: 1, entries: data.entries })
    return { ok: true, entries: data.entries }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('astral:knowledge:call', async (_event, payload = {}) => {
  try {
    const service = await getKnowledgeService()
    return await service.invoke(payload.action, payload.args || {}, payload.project || {})
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('astral:knowledge:pick-dir', async () => {
  if (!mainWindow) return { ok: false, error: '窗口尚未就绪' }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择知识库父目录',
    buttonLabel: '使用此目录',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true }
  return { ok: true, dir: result.filePaths[0] }
})

ipcMain.handle('astral:session:load', async () => readJson(SESSION_FILE, { messages: [] }))
ipcMain.handle('astral:session:save', async (_event, data) => {
  try {
    await writeJson(SESSION_FILE, data)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err.message }
  }
})

function secretMatches (expected, actual) {
  const a = Buffer.from(String(expected || ''), 'utf8')
  const b = Buffer.from(String(actual || ''), 'utf8')
  if (!a.length || a.length !== b.length) return false
  try { return crypto.timingSafeEqual(a, b) } catch { return false }
}

/* 每个项目第一次（或换成员时）确认一次发起成员；用户可「信任并记住」。
   这份信任存在独立文件里，和插件/模型配置分开，可在 设置 → 运行 里清除。 */
const runOwnersFile = () => path.join(CONFIG_DIR, 'run-owners.json')

async function readRunOwners () {
  const data = await readJson(runOwnersFile(), { version: 1, owners: {} })
  return data && data.owners && typeof data.owners === 'object' ? data.owners : {}
}

async function writeRunOwner (projectId, agentId) {
  const owners = await readRunOwners()
  owners[String(projectId)] = String(agentId)
  await writeJson(runOwnersFile(), { version: 1, owners })
}

async function confirmRunOwner (authority) {
  /* 自动化测试用：ASTRAL_TRUST_RUN_OWNER=1 跳过；
     ASTRAL_TEST_RUN_OWNER=1 + ASTRAL_RUN_OWNER_CHOICE=0/1/2 模拟三个按钮。 */
  if (process.env.ASTRAL_TRUST_RUN_OWNER === '1') return 1
  const scripted = process.env.ASTRAL_TEST_RUN_OWNER === '1' ? Number(process.env.ASTRAL_RUN_OWNER_CHOICE) : NaN
  if (scripted === 0 || scripted === 1 || scripted === 2) return scripted

  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getFocusedWindow()
  const permissions = Object.entries(authority.permissions || {})
    .filter(([key, value]) => key !== 'full' && value === true)
    .map(([key]) => key)
  try {
    const choice = await showThemedConfirm({
      parent: win,
      title: '确认本轮发起成员',
      message: `由「${authority.agent.name || authority.agent.id}」发起本轮协作？`,
      detail: [
        `项目：${authority.project.name || authority.project.id}`,
        `成员：${authority.agent.name || authority.agent.id}（${authority.agent.id}）`,
        `权限：${permissions.length ? permissions.join('、') : '无工具权限'}`,
        '',
        '工具调用会继承该成员的权限；子成员的工具权限不会超过发起成员。',
        '「信任并记住」只在当前项目生效，可在 设置 → 运行 里清除。'
      ].join('\n'),
      actions: [
        { value: 0, label: '信任并记住', style: 'primary' },
        { value: 1, label: '仅本次', style: 'ghost' },
        { value: 2, label: '取消', style: 'danger' }
      ],
      cancelValue: 2,
      themeTokens: await dialogThemeTokens(),
      width: 580,
      height: 520
    })
    return typeof choice === 'number' ? choice : 2
  } catch {
    return 2
  }
}

ipcMain.handle('astral:runOwner:list', async () => {
  try {
    return { ok: true, owners: await readRunOwners() }
  } catch (err) {
    return { ok: false, error: err.message, owners: {} }
  }
})

ipcMain.handle('astral:runOwner:reset', async (_event, payload = {}) => {
  try {
    const owners = await readRunOwners()
    if (payload.projectId) delete owners[String(payload.projectId)]
    else for (const key of Object.keys(owners)) delete owners[key]
    await writeJson(runOwnersFile(), { version: 1, owners })
    return { ok: true, owners }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('astral:runs:start', async (_event, payload = {}) => {
  try {
    const authority = permissionAuthority.resolve(payload)
    if (!authority.ok) return { ok: false, error: authority.error }

    const owners = await readRunOwners()
    let ownerTrust = 'trusted'
    if (owners[authority.project.id] !== authority.agent.id) {
      const choice = await confirmRunOwner(authority)
      if (choice === 2) return { ok: false, error: '用户取消了本轮协作' }
      if (choice === 0) {
        try {
          await writeRunOwner(authority.project.id, authority.agent.id)
        } catch (err) {
          return { ok: false, error: `保存发起成员信任失败：${err.message}` }
        }
        ownerTrust = 'remembered'
      } else {
        ownerTrust = 'once'
      }
    }

    const run = runStore.start({
      ...payload,
      projectId: authority.project.id,
      projectName: authority.project.name,
      agentId: authority.agent.id,
      agentName: authority.agent.name,
      ownerTrust
    })
    const runCapability = crypto.randomBytes(24).toString('base64url')
    runCapabilities.set(run.id, runCapability)
    return { ok: true, run: { ...run, runCapability } }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('astral:runs:event', async (_event, payload = {}) => {
  try {
    const event = runStore.event(payload.id, payload.type, payload.data || {})
    return event ? { ok: true } : { ok: false, error: '没有这条运行记录' }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('astral:runs:finish', async (_event, payload = {}) => {
  runCapabilities.delete(String(payload.id || ''))
  const run = runStore.finish(payload.id, payload.status, { error: payload.error || '' })
  return run ? { ok: true, run } : { ok: false, error: '没有这条运行记录' }
})

ipcMain.handle('astral:runs:abandon', async (_event, payload = {}) => {
  runCapabilities.delete(String(payload.id || ''))
  const run = runStore.abandon(payload.id)
  return run ? { ok: true, run } : { ok: false, error: '没有这条运行记录' }
})

ipcMain.handle('astral:runs:list', async (_event, payload = {}) => runStore.list(payload))
ipcMain.handle('astral:runs:get', async (_event, payload = {}) => runStore.get(payload.id))

ipcMain.handle('astral:jobs:list', async (_event, payload = {}) => jobStore.list(payload))
ipcMain.handle('astral:jobs:get', async (_event, payload = {}) => {
  const job = jobStore.get(payload.id)
  return job ? { ok: true, job } : { ok: false, error: '找不到长任务' }
})
ipcMain.handle('astral:jobs:create', async (_event, payload = {}) => jobStore.create(payload))
ipcMain.handle('astral:jobs:update', async (_event, payload = {}) => jobStore.update(payload.id, payload))
ipcMain.handle('astral:jobs:remove', async (_event, payload = {}) => jobStore.remove(payload.id))

function safeProjectSessionFile (projectId) {
  const id = String(projectId || '')
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null
  return path.join(PROJECT_SESSIONS_DIR(), `${id}.session.json`)
}

ipcMain.handle('astral:projectSession:load', async (_event, projectId) => {
  const file = safeProjectSessionFile(projectId)
  if (!file) return { version: 2, user: [], agent: [] }
  return readJson(file, { version: 2, user: [], agent: [] })
})

ipcMain.handle('astral:projectSession:save', async (_event, projectId, data) => {
  const file = safeProjectSessionFile(projectId)
  if (!file) return { ok: false, message: 'invalid project id' }
  try {
    await writeJson(file, data)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err.message }
  }
})

ipcMain.handle('astral:pickFolder', async () => {
  if (!mainWindow) return ''
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择项目文件夹',
    buttonLabel: '使用此文件夹',
    properties: ['openDirectory', 'createDirectory']
  })
  return result.canceled || !result.filePaths.length ? '' : result.filePaths[0]
})

ipcMain.handle('astral:openDir', async (_event, which) => {
  const target = which === 'app' ? APP_DIR : which === 'root' ? ROOT : CONFIG_DIR
  await shell.openPath(target)
  return { ok: true, path: target }
})

ipcMain.handle('astral:openFile', async (_event, filePath) => {
  const target = String(filePath || '')
  if (!target) return { ok: false, error: '缺少文件路径' }
  try {
    const stat = await fsp.stat(target)
    if (!stat.isFile()) return { ok: false, error: '目标不是文件' }
    const error = await shell.openPath(target)
    return error ? { ok: false, error } : { ok: true }
  } catch (err) {
    return { ok: false, error: err.message || '文件不存在' }
  }
})

async function scopedFile (rootPath, filePath) {
  const root = String(rootPath || '').trim()
  const file = String(filePath || '').trim()
  if (!root || !file) return { ok: false, error: '缺少项目目录或文件路径' }
  try {
    const rootReal = await fsp.realpath(root)
    const fileReal = await fsp.realpath(file)
    const rel = path.relative(rootReal, fileReal)
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return { ok: false, error: '文件不在当前项目范围内' }
    }
    const stat = await fsp.stat(fileReal)
    if (!stat.isFile()) return { ok: false, error: '目标不是文件' }
    return { ok: true, rootReal, fileReal, stat }
  } catch (err) {
    return { ok: false, error: err.message || '文件不可用' }
  }
}

ipcMain.handle('astral:readProjectFile', async (_event, payload = {}) => {
  const checked = await scopedFile(payload.rootPath, payload.filePath)
  if (!checked.ok) return checked
  if (checked.stat.size > 2 * 1024 * 1024) {
    return { ok: false, error: '文件超过 2MB，无法在消息编辑器里打开' }
  }
  try {
    const text = await fsp.readFile(checked.fileReal, 'utf8')
    return { ok: true, text, size: checked.stat.size }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('astral:writeProjectFile', async (_event, payload = {}) => {
  const checked = await scopedFile(payload.rootPath, payload.filePath)
  if (!checked.ok) return checked
  const text = String(payload.text ?? '')
  if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) {
    return { ok: false, error: '文件超过 2MB，无法保存' }
  }
  try {
    await fsp.writeFile(checked.fileReal, text, 'utf8')
    const stat = await fsp.stat(checked.fileReal)
    return { ok: true, size: stat.size }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('astral:bridgeStatus', async () => ({ port: bridgePort, token: bridgeToken, running: Boolean(bridgeServer) }))

/* ----------------------------------------------------------- file picker */

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.css', '.scss', '.html', '.htm', '.csv', '.tsv', '.yml', '.yaml', '.toml', '.ini', '.xml',
  '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.sql',
  '.sh', '.ps1', '.bat', '.log', '.env', '.gitignore'
])
const MAX_FILE_BYTES = 512 * 1024

/* ------------------------------------------------------- model list */

/* 只认服务端显式声明的思考档位（OpenRouter 契约：reasoning.supported_efforts）。
   没有 supported_efforts 的一律视为「未声明」，交给渲染层按模型名兜底。 */
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
const EFFORT_LABEL = { none: '关', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '极高' }
const EFFORT_VALUE = { none: 0, minimal: 25, low: 45, medium: 70, high: 92, xhigh: 100 }

function parseDeclaredReasoning (entry) {
  if (!entry || typeof entry !== 'object') return null
  const raw = entry.reasoning
  if (!raw || typeof raw !== 'object') return null

  const list = Array.isArray(raw.supported_efforts)
    ? raw.supported_efforts
    : Array.isArray(raw.efforts) ? raw.efforts : null
  if (!list) return null

  const values = []
  for (const item of list) {
    const raw2 = typeof item === 'string' ? item : (item && (item.value || item.name || item.effort))
    if (!raw2) continue
    const key = String(raw2).toLowerCase()
    if (EFFORT_ORDER.includes(key) && !values.includes(key)) values.push(key)
  }
  if (!values.length) return null

  values.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))
  const mandatory = raw.mandatory === true
  const tiers = values
    .filter((v) => !(mandatory && v === 'none'))
    .map((v) => ({ value: EFFORT_VALUE[v], label: EFFORT_LABEL[v], param: v }))
  if (!tiers.length) return null

  const def = String(raw.default_effort || '').toLowerCase()
  return {
    mode: 'effort',
    /* OpenRouter 用的是 reasoning: { effort }，不是顶层 reasoning_effort */
    style: 'object',
    label: 'reasoning.effort',
    source: 'api',
    tiers,
    default: EFFORT_ORDER.includes(def) ? def : null,
    mandatory
  }
}

ipcMain.handle('astral:listModels', async (_event, payload = {}) => {
  const kind = payload.kind || 'openai'
  const base = String(payload.baseUrl || '').replace(/\/+$/, '')
  const key = payload.providerId
    ? await secrets.getKey(payload.providerId)
    : (payload.apiKey || '')
  if (!base) return { ok: false, error: '缺少 Base URL' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)

  try {
    let url = `${base}/models`
    const headers = { 'content-type': 'application/json' }
    if (kind === 'ollama') {
      url = `${base}/api/tags`
    } else if (kind === 'anthropic') {
      headers['x-api-key'] = key
      headers['anthropic-version'] = '2023-06-01'
    } else {
      headers.authorization = `Bearer ${key}`
    }

    const res = await net.fetch(url, { method: 'GET', headers, signal: controller.signal })
    const text = await res.text()
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} · ${text.slice(0, 160)}` }
    }

    const data = JSON.parse(text)
    let rows = []
    if (Array.isArray(data.data)) rows = data.data
    else if (Array.isArray(data.models)) rows = data.models
    else if (Array.isArray(data)) rows = data

    const ids = [...new Set(rows.map((m) => m && (m.id || m.name)).filter(Boolean))].sort()

    /* 只有显式声明 supported_efforts 的模型才会进这张表 */
    const reasoning = {}
    for (const row of rows) {
      const id = row && (row.id || row.name)
      if (!id) continue
      const declared = parseDeclaredReasoning(row)
      if (declared) reasoning[id] = declared
    }

    return { ok: true, models: ids, reasoning }
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? '请求超时' : err.message }
  } finally {
    clearTimeout(timer)
  }
})

ipcMain.handle('astral:reload', () => {
  if (mainWindow) mainWindow.webContents.reload()
})

ipcMain.handle('astral:pickImage', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择头像',
    buttonLabel: '使用',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
  })
  if (result.canceled || !result.filePaths.length) return null
  const file = result.filePaths[0]
  const stat = await fsp.stat(file)
  if (stat.size > 6 * 1024 * 1024) throw new Error('图片超过 6MB，请先压缩')
  const buf = await fsp.readFile(file)
  const ext = path.extname(file).toLowerCase().replace('.', '')
  const mime = ext === 'jpg' ? 'jpeg' : ext
  return `data:image/${mime};base64,${buf.toString('base64')}`
})

ipcMain.handle('astral:pickFiles', async (_event, projectRoot = '') => {
  if (!mainWindow) return { files: [], rejected: 0 }
  const root = String(projectRoot || '').trim()
  let rootReal = null
  if (root) {
    rootReal = await fsp.realpath(root).catch(() => null)
    if (!rootReal) return { files: [], rejected: 0, message: '项目文件夹不可用' }
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: rootReal ? '添加项目文件' : '添加参考文件',
    buttonLabel: '添加',
    defaultPath: rootReal || undefined,
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '文本与代码', extensions: [...TEXT_EXT].map((e) => e.replace('.', '')) },
      { name: '全部文件', extensions: ['*'] }
    ]
  })
  if (result.canceled) return { files: [], rejected: 0 }

  const inside = async (filePath) => {
    if (!rootReal) return true
    const relInside = (rel) => Boolean(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
    try {
      const real = await fsp.realpath(filePath)
      return relInside(path.relative(rootReal, real))
    } catch {
      return relInside(path.relative(rootReal, path.resolve(filePath)))
    }
  }

  const picked = []
  let rejected = 0
  for (const filePath of result.filePaths.slice(0, 8)) {
    if (!(await inside(filePath))) {
      rejected += 1
      continue
    }
    try {
      const stat = await fsp.stat(filePath)
      const ext = path.extname(filePath).toLowerCase()
      const isText = TEXT_EXT.has(ext) || stat.size < 32 * 1024
      const text = isText && stat.size <= MAX_FILE_BYTES ? await fsp.readFile(filePath, 'utf8') : null
      picked.push({ name: path.basename(filePath), path: filePath, size: stat.size, text })
    } catch {
      picked.push({ name: path.basename(filePath), path: filePath, size: 0, text: null })
    }
  }
  return { files: picked, rejected }
})

/* ------------------------------------------------- 数据权限文件 */

/* 允许作为「数据权限文件」上传的类型：文本态按 utf8 传输，二进制按 base64 传输 */
const DATA_TEXT_EXT = new Set([
  '.json', '.jsonl', '.jsonc', '.csv', '.tsv', '.txt', '.md', '.markdown',
  '.yaml', '.yml', '.toml', '.ini', '.xml', '.svg', '.sql', '.log', '.env'
])
const DATA_BINARY_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'
])
const DATA_EXT = new Set([...DATA_TEXT_EXT, ...DATA_BINARY_EXT])
const MAX_DATA_BYTES = 5 * 1024 * 1024
const DATA_EXT_HINT = '图片 jpg / jpeg / png / gif / webp / bmp / svg，文档 pdf / doc / docx / xls / xlsx / ppt / pptx，文本与数据 txt / md / csv / json / xml / yaml / toml 等'
const DATA_DIR = () => path.join(CONFIG_DIR, 'data')

/* 二进制类型的文件头校验：扩展名可伪造，魔数不会 */
function magicOk (ext, buf) {
  const head = buf.subarray(0, 12)
  const ascii = head.toString('latin1')
  if (ext === '.jpg' || ext === '.jpeg') return head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF
  if (ext === '.png') return head[0] === 0x89 && ascii.slice(1, 4) === 'PNG'
  if (ext === '.gif') return ascii.startsWith('GIF8')
  if (ext === '.webp') return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP'
  if (ext === '.bmp') return head[0] === 0x42 && head[1] === 0x4D
  if (ext === '.pdf') return ascii.startsWith('%PDF')
  if (['.docx', '.xlsx', '.pptx'].includes(ext)) return head[0] === 0x50 && head[1] === 0x4B /* Zip 容器 */
  if (['.doc', '.xls', '.ppt'].includes(ext)) return ascii.slice(0, 4) === '\xD0\xCF\x11\xE0' /* OLE2 容器 */
  return true /* 其余类型不校验魔数 */
}

ipcMain.handle('astral:pickDataFile', async () => {
  if (!mainWindow) return null
  const exts = [...DATA_EXT].map((e) => e.replace('.', ''))
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择数据权限文件',
    buttonLabel: '上传',
    properties: ['openFile'],
    filters: [
      { name: '全部支持的类型', extensions: exts },
      { name: '图片', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'] },
      { name: '文档', extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'] },
      { name: '文本与数据', extensions: ['txt', 'md', 'csv', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'sql', 'log', 'env', 'tsv', 'jsonl', 'jsonc', 'markdown'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  })
  if (result.canceled || !result.filePaths.length) return null

  const filePath = result.filePaths[0]
  const ext = path.extname(filePath).toLowerCase()
  if (!DATA_EXT.has(ext)) {
    throw new Error(`不支持的文件类型 ${ext || '（无扩展名）'}，允许：${DATA_EXT_HINT}`)
  }
  const stat = await fsp.stat(filePath)
  if (stat.size > MAX_DATA_BYTES) {
    throw new Error(`文件 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过 5MB 上限`)
  }
  if (!stat.size) throw new Error('文件为空')

  if (DATA_BINARY_EXT.has(ext)) {
    const buf = await fsp.readFile(filePath)
    if (!magicOk(ext, buf)) {
      throw new Error(`文件内容与 .${ext.replace('.', '')} 格式不符（文件头校验未通过），请确认文件没有损坏或被改名`)
    }
    return { name: path.basename(filePath), ext, size: stat.size, kind: 'binary', data: buf.toString('base64') }
  }
  const text = await fsp.readFile(filePath, 'utf8')
  return { name: path.basename(filePath), ext, size: stat.size, kind: 'text', text }
})

ipcMain.handle('astral:saveDataFile', async (_event, payload = {}) => {
  const name = String(payload.name || '').trim()
  if (!name) return { ok: false, error: '缺少文件名' }
  const ext = (String(payload.ext || path.extname(name)).toLowerCase().replace(/^\./, '')) || 'txt'
  if (!DATA_EXT.has(`.${ext}`)) {
    return { ok: false, error: `不支持的文件类型 .${ext}，允许：${DATA_EXT_HINT}` }
  }

  /* 文本态收 text，二进制收 base64；两者都按实际字节校验大小 */
  let bytes = 0
  let writeBuf = null
  if (payload.data != null) {
    if (!DATA_BINARY_EXT.has(`.${ext}`)) return { ok: false, error: `.${ext} 是文本类型，不应以二进制方式上传` }
    writeBuf = Buffer.from(String(payload.data), 'base64')
    bytes = writeBuf.length
    if (bytes && !magicOk(`.${ext}`, writeBuf)) {
      return { ok: false, error: `文件内容与 .${ext} 格式不符（文件头校验未通过），请确认文件没有损坏或被改名` }
    }
  } else {
    const text = String(payload.text || '')
    bytes = Buffer.byteLength(text, 'utf8')
    writeBuf = Buffer.from(text, 'utf8')
  }
  if (bytes > MAX_DATA_BYTES) return { ok: false, error: `内容 ${(bytes / 1024 / 1024).toFixed(1)}MB 超过 5MB 上限` }
  if (!bytes) return { ok: false, error: '文件为空' }

  const dir = DATA_DIR()
  await fsp.mkdir(dir, { recursive: true })
  const id = `df_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`
  const safe = name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
  const rel = path.join('data', `${id}_${safe}`)
  await fsp.writeFile(path.join(CONFIG_DIR, rel), writeBuf)
  return { ok: true, file: { id, name: safe, ext: `.${ext}`, size: bytes, path: rel, ts: Date.now() } }
})

ipcMain.handle('astral:deleteDataFile', async (_event, payload = {}) => {
  const rel = String(payload.path || '')
  if (!rel.startsWith('data' + path.sep) && !rel.startsWith('data/')) {
    return { ok: false, error: '路径不在数据目录内' }
  }
  try {
    await fsp.unlink(path.join(CONFIG_DIR, rel))
    return { ok: true }
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true }
    return { ok: false, error: err.message }
  }
})

/* 预览工具改动过的文件：只读，文本截断 512KB，图片限 8MB。
   路径来自用户点击的工具记录，相对路径按用户主目录解析。 */
ipcMain.handle('astral:readFilePreview', async (_event, payload = {}) => {
  let target = String(payload.path || '').trim()
  if (!target) return { ok: false, error: '缺少文件路径' }
  if (!path.isAbsolute(target)) {
    target = path.join(require('node:os').homedir(), target)
  }
  try {
    const stat = await fsp.stat(target)
    if (stat.isDirectory()) return { ok: false, error: '这是一个目录，不是文件' }
    const ext = path.extname(target).toLowerCase()
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) {
      if (stat.size > 8 * 1024 * 1024) return { ok: false, error: '图片超过 8MB，无法预览' }
      const buf = await fsp.readFile(target)
      const mime = ext === '.svg' ? 'image/svg+xml' : `image/${ext.slice(1).replace('jpg', 'jpeg')}`
      return { ok: true, kind: 'image', dataUrl: `data:${mime};base64,${buf.toString('base64')}`, size: stat.size, path: target }
    }
    /* HTML：交给 astral://preview 同源托管，相对路径的 CSS/JS/图片都能加载 */
    if (['.html', '.htm', '.xhtml'].includes(ext)) {
      if (stat.size > 20 * 1024 * 1024) return { ok: false, error: '网页超过 20MB，无法预览' }
      const token = grantPreviewRoot(path.dirname(target))
      return {
        ok: true,
        kind: 'html',
        url: `astral://preview/${token}/${encodeURIComponent(path.basename(target))}`,
        size: stat.size,
        path: target
      }
    }

    const MAX = 512 * 1024
    const buf = await fsp.readFile(target)
    /* 含 NUL 字节视为二进制，直接拒绝，避免把 docx/zip 读成乱码 */
    if (buf.subarray(0, 512).includes(0)) {
      return { ok: false, error: '这是二进制文件，无法内联预览；可用系统程序打开' }
    }
    const head = buf.subarray(0, Math.min(buf.length, MAX))
    return {
      ok: true,
      kind: 'text',
      text: head.toString('utf8'),
      truncated: buf.length > MAX,
      size: stat.size,
      path: target
    }
  } catch (err) {
    const message = err.code === 'ENOENT' ? '文件不存在或已被移动' : err.message
    return { ok: false, error: message }
  }
})

ipcMain.handle('astral:readDataFile', async (_event, payload = {}) => {
  const rel = String(payload.path || '')
  if (!rel.startsWith('data' + path.sep) && !rel.startsWith('data/')) {
    return { ok: false, error: '路径不在数据目录内' }
  }
  try {
    const buf = await fsp.readFile(path.join(CONFIG_DIR, rel))
    if (payload.encoding === 'base64') return { ok: true, data: buf.toString('base64'), size: buf.length }
    return { ok: true, text: buf.toString('utf8'), size: buf.length }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

/* ------------------------------------------------------- 语音转写 */

/* 走 OpenAI 兼容的 /audio/transcriptions（whisper 系）。浏览器内置识别不可用时兜底。 */
ipcMain.handle('astral:transcribe', async (_event, payload = {}) => {
  const input = payload.provider || {}
  const provider = input.id
    ? { ...input, apiKey: await secrets.getKey(input.id) }
    : input
  const model = String(payload.model || 'whisper-1')
  const base = String(provider.baseUrl || '').replace(/\/+$/, '')
  if (!base) return { ok: false, error: '缺少服务端地址' }
  if (provider.kind !== 'ollama' && !provider.apiKey) return { ok: false, error: '缺少 API Key' }

  const audio = Buffer.from(String(payload.audio || ''), 'base64')
  if (!audio.length) return { ok: false, error: '录音内容为空' }
  if (audio.length > 20 * 1024 * 1024) return { ok: false, error: '录音超过 20MB' }

  const form = new FormData()
  const ext = String(payload.ext || 'webm').replace(/^\./, '')
  const mime = payload.mime || `audio/${ext}`
  form.append('file', new Blob([audio], { type: mime }), `speech.${ext}`)
  form.append('model', model)
  if (payload.language) form.append('language', String(payload.language))

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60000)
  try {
    const headers = {}
    if (provider.kind !== 'ollama') headers.Authorization = `Bearer ${provider.apiKey}`
    const res = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers,
      body: form,
      signal: controller.signal
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status} · ${text.slice(0, 300)}`)
    let data = null
    try { data = JSON.parse(text) } catch { /* 纯文本响应 */ }
    const out = (data && (data.text || data.transcription)) || text.trim()
    if (!out) throw new Error('服务端没有返回转写文本')
    return { ok: true, text: out }
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? '转写超时' : err.message }
  } finally {
    clearTimeout(timer)
  }
})

/* ------------------------------------------------- 语音转写：Windows 本机 */

let winSpeechChild = null
let winSpeechSession = 0
let winSpeechFinal = ''
let winSpeechPartial = ''

function speechEvent (payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('astral:speech:event', payload)
}

function speechText () {
  return (winSpeechFinal || winSpeechPartial || '').trim()
}

function killSpeechProcess () {
  const child = winSpeechChild
  winSpeechChild = null
  if (!child) return
  try { child.kill() } catch { /* already gone */ }
}

async function stopSpeechProcess (sessionId) {
  const child = winSpeechChild
  if (!child) return { ok: true, text: speechText() }
  if (sessionId && sessionId !== winSpeechSession) return { ok: true, text: speechText() }

  try { child.stdin.write('stop\n') } catch { /* pipe already closed */ }
  await Promise.race([
    child.__exitPromise || Promise.resolve(),
    new Promise((resolve) => setTimeout(resolve, 2200))
  ])
  if (winSpeechChild === child) {
    /* C# 进程没有在宽限期内退出：保证麦克风被释放。 */
    killSpeechProcess()
    await Promise.race([
      child.__exitPromise || Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 500))
    ])
  }
  return { ok: true, text: speechText() }
}

ipcMain.handle('astral:speech:start', async (_event, payload = {}) => {
  if (process.platform !== 'win32') return { ok: false, error: '本机语音识别仅支持 Windows' }
  await stopSpeechProcess()
  winSpeechFinal = ''
  winSpeechPartial = ''

  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (!fs.existsSync(powershell)) return { ok: false, error: '找不到 Windows PowerShell，无法启动本机识别' }

  const language = String(payload.language || 'zh-CN').replace(/[^A-Za-z-]/g, '') || 'zh-CN'
  const encoded = Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64')
  let child
  try {
    child = spawn(powershell, [
      '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ASTRAL_SPEECH_LANG: language,
        ...(process.env.ASTRAL_SPEECH_WAV ? { ASTRAL_SPEECH_WAV: process.env.ASTRAL_SPEECH_WAV } : {})
      }
    })
  } catch (err) {
    return { ok: false, error: err.message || '无法启动 Windows 本机识别' }
  }

  winSpeechChild = child
  const sessionId = ++winSpeechSession
  child.__exitPromise = new Promise((resolve) => child.once('exit', resolve))

  const lines = readline.createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    let data = null
    try { data = JSON.parse(line) } catch { return }
    if (!data || typeof data !== 'object') return
    if (data.type === 'partial') winSpeechPartial = String(data.text || '')
    if (data.type === 'final') {
      winSpeechFinal = String(data.transcript || (winSpeechFinal + String(data.text || '')))
      winSpeechPartial = ''
    }
    if (data.type === 'done') {
      winSpeechFinal = String(data.transcript || winSpeechFinal || winSpeechPartial)
    }
    speechEvent({ ...data, sessionId })
  })

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim()
    if (text) console.error(`[speech] ${text.slice(0, 1200)}`)
  })

  child.on('error', (err) => {
    if (winSpeechChild === child) {
      speechEvent({ type: 'error', message: err.message || '本机语音识别启动失败', sessionId })
    }
  })

  child.on('exit', () => {
    lines.close()
    if (winSpeechChild === child) {
      winSpeechChild = null
      speechEvent({
        type: 'ended',
        text: speechText(),
        sessionId
      })
    }
  })

  return { ok: true, sessionId }
})

ipcMain.handle('astral:speech:stop', async (_event, payload = {}) => {
  const result = await stopSpeechProcess(Number(payload.sessionId) || 0)
  return result
})

ipcMain.handle('astral:sensevoice:info', (_event, payload = {}) => sensevoice.info(payload && payload.modelDir))

ipcMain.handle('astral:sensevoice:transcribe', async (_event, payload = {}) => {
  return sensevoice.transcribe(payload)
})

ipcMain.handle('astral:speech-models:pick', async () => {
  if (!mainWindow) return { ok: false, error: '窗口尚未就绪' }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 SenseVoice 模型文件夹',
    buttonLabel: '使用此模型',
    properties: ['openDirectory']
  })
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true }
  const inspected = sensevoice.inspectModel(result.filePaths[0])
  if (!inspected.ok) return { ok: false, error: inspected.error }
  return { ok: true, model: inspected.model }
})

ipcMain.handle('astral:open-external', async (_event, url) => {
  const target = String(url || '')
  if (!/^https:\/\//i.test(target)) return { ok: false, error: '只允许打开 https 链接' }
  await shell.openExternal(target)
  return { ok: true }
})

ipcMain.handle('astral:clipboard:write', (_event, text) => {
  const value = String(text ?? '')
  if (value.length > 200000) return { ok: false, error: '剪贴板内容超过上限' }
  clipboard.writeText(value)
  return { ok: true }
})

/* ----------------------------------------------------------------- window */

let mainWindow = null
let tray = null
let trayHintShown = false
let isQuitting = false
/* 关闭窗口 = 收进托盘继续跑；可在「设置 · 运行」里改成关闭即退出 */
let closeToTray = true
let lastWindowState = null

const WINDOW_STATE_FILE = () => path.join(CONFIG_DIR, 'window.json')
const BACKGROUND_FILE = () => path.join(CONFIG_DIR, 'background.json')

function trayImage () {
  const ico = path.join(APP_DIR, 'assets', 'astral-icon.ico')
  const png = path.join(APP_DIR, 'assets', 'astral-icon.png')
  const source = nativeImage.createFromPath(process.platform === 'win32' && fs.existsSync(ico) ? ico : png)
  if (source.isEmpty()) return null
  /* 托盘只吃小图，直接塞 512px 会被系统缩成糊块 */
  return process.platform === 'win32' ? source : source.resize({ width: 22, height: 22 })
}

function notifyActivity () {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const active = mainWindow.isVisible() && !mainWindow.isMinimized()
  mainWindow.webContents.send('app:activity', active)
}

function showMainWindow () {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(lastWindowState)
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  refreshTray()
  notifyActivity()
}

function hideMainWindow () {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.hide()
  refreshTray()
  notifyActivity()
  showTrayHintOnce()
}

function showTrayHintOnce () {
  if (trayHintShown || !tray) return
  trayHintShown = true
  writeJson(BACKGROUND_FILE(), { hintShown: true }).catch(() => {})
  try {
    if (process.platform === 'win32') {
      tray.displayBalloon({
        title: '星界仍在后台运行',
        content: '窗口已收起。对话、任务和 MCP 桥都没中断，点托盘图标可以随时叫回来；右键托盘可以退出。',
        iconType: 'info'
      })
    } else if (process.platform === 'darwin') {
      tray.setToolTip('星界 · 后台运行中（点图标回到窗口）')
    }
  } catch { /* 通知被系统关掉也不影响后台运行 */ }
}

function refreshTray () {
  if (!tray || (typeof tray.isDestroyed === 'function' && tray.isDestroyed())) return
  const visible = Boolean(
    mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()
  )
  tray.setToolTip(visible ? '星界 · 运行中' : '星界 · 后台运行中')
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: visible ? '星界正在前台' : '打开星界窗口',
      enabled: !visible,
      click: () => showMainWindow()
    },
    {
      label: '收起窗口（继续后台运行）',
      enabled: visible,
      click: () => hideMainWindow()
    },
    { type: 'separator' },
    { label: closeToTray ? '关闭窗口：驻留后台' : '关闭窗口：退出程序', enabled: false },
    { type: 'separator' },
    { label: '退出星界', click: () => quitApp() }
  ]))
}

function createTray () {
  if (tray && !(typeof tray.isDestroyed === 'function' && tray.isDestroyed())) return tray
  tray = null
  const image = trayImage()
  if (!image) return null
  tray = new Tray(image)
  tray.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) return
    showMainWindow()
  })
  tray.on('double-click', () => showMainWindow())
  tray.on('balloon-click', () => showMainWindow())
  refreshTray()
  return tray
}

function destroyTray () {
  if (!tray) return
  try { tray.destroy() } catch { /* ignore */ }
  tray = null
}

function quitApp () {
  isQuitting = true
  app.quit()
}

function applyBackgroundPref (value) {
  closeToTray = value !== false
  if (closeToTray) createTray()
  else destroyTray()
  refreshTray()
  return closeToTray
}

ipcMain.handle('app:background', (_event, prefs) => {
  if (prefs && typeof prefs.closeToTray === 'boolean') applyBackgroundPref(prefs.closeToTray)
  return {
    closeToTray,
    tray: Boolean(tray),
    hidden: Boolean(mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible())
  }
})

ipcMain.handle('app:hideToTray', () => {
  if (!createTray()) return { ok: false, error: '托盘图标不可用，无法隐藏窗口' }
  hideMainWindow()
  return { ok: true }
})

ipcMain.handle('app:quit', () => {
  quitApp()
  return true
})

ipcMain.handle('win:minimize', () => {
  if (mainWindow) mainWindow.minimize()
})

ipcMain.handle('win:toggleMaximize', () => {
  if (!mainWindow) return false
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
  return mainWindow.isMaximized()
})

ipcMain.handle('win:close', () => {
  if (mainWindow) mainWindow.close()
})

function fitToScreen (saved) {
  const work = screen.getPrimaryDisplay().workAreaSize
  if (process.env.ASTRAL_WIN) {
    const [w, h] = process.env.ASTRAL_WIN.split('x').map(Number)
    if (w > 400 && h > 400) return { width: w, height: h }
  }
  const width = Math.min(Math.max((saved && saved.width) || 1600, 880), Math.round(work.width * 0.96))
  const height = Math.min(Math.max((saved && saved.height) || 1000, 560), Math.round(work.height * 0.94))
  return { width, height }
}

function createWindow (savedState) {
  lastWindowState = savedState || lastWindowState
  const { width, height } = fitToScreen(savedState)
  const pngIcon = nativeImage.createFromPath(path.join(APP_DIR, 'assets', 'astral-icon.png'))
  const icoIcon = nativeImage.createFromPath(path.join(APP_DIR, 'assets', 'astral-icon.ico'))
  const windowIcon = pngIcon.isEmpty() ? icoIcon : pngIcon

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 880,
    minHeight: 560,
    center: true,
    show: false,
    icon: windowIcon.isEmpty() ? undefined : windowIcon,
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    titleBarStyle: 'hidden',
    thickFrame: true,
    backgroundColor: '#05060d',
    autoHideMenuBar: true,
    title: '星界',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      /* 窗口收起后渲染进程继续按原节奏调度：智能体派单、轮询、流式回调都不被节流 */
      backgroundThrottling: false
    }
  })

  if (savedState && savedState.maximized && !process.env.ASTRAL_WIN) mainWindow.maximize()

  let saveTimer = null
  const rememberBounds = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      const bounds = mainWindow.getNormalBounds()
      writeJson(WINDOW_STATE_FILE(), {
        width: bounds.width,
        height: bounds.height,
        maximized: mainWindow.isMaximized()
      }).catch(() => {})
    }, 400)
  }
  mainWindow.on('resize', rememberBounds)
  mainWindow.on('move', rememberBounds)
  mainWindow.on('maximize', rememberBounds)
  mainWindow.on('unmaximize', rememberBounds)

  const notifyMaximize = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('win:maximized', mainWindow.isMaximized())
    }
  }
  mainWindow.on('maximize', notifyMaximize)
  mainWindow.on('unmaximize', notifyMaximize)

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    mainWindow.webContents.setZoomFactor(1)
    if (process.env.ASTRAL_DEBUG) {
      console.error(`[window] ${JSON.stringify({
        resizable: mainWindow.isResizable(),
        maximizable: mainWindow.isMaximizable(),
        frame: mainWindow.isSimpleFullScreen ? 'custom' : 'native',
        bounds: mainWindow.getBounds(),
        workArea: screen.getPrimaryDisplay().workAreaSize
      })}`)
    }
  })
  mainWindow.loadURL('astral://app/index.html')

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = String(input.key || '')
    if (key === 'F5' || (input.control && key.toLowerCase() === 'r')) {
      event.preventDefault()
      mainWindow.webContents.reload()
    }
  })

  mainWindow.webContents.on('did-finish-load', () => {
    /* Chromium 会按站点持久化缩放级别，强制回到 1 以免旧值把整页放大/缩小 */
    mainWindow.webContents.setZoomFactor(1)
    notifyActivity()
  })

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[load-fail] ${code} ${desc} ${url}`)
  })

  if (process.env.ASTRAL_DEBUG) {
    mainWindow.webContents.on('console-message', (_event, level, message, line, source) => {
      const tag = ['log', 'warn', 'error', 'debug'][level] || 'log'
      console.error(`[renderer:${tag}] ${message} (${source}:${line})`)
    })
  }

  if (process.env.ASTRAL_EVAL) {
    mainWindow.webContents.once('did-finish-load', async () => {
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.ASTRAL_EVAL_DELAY || 2500)))
      try {
        const out = await mainWindow.webContents.executeJavaScript(process.env.ASTRAL_EVAL)
        console.error(`[eval] ${JSON.stringify(out)}`)
      } catch (err) {
        console.error(`[eval] failed: ${err.message}`)
      }
      app.quit()
    })
  }

  if (process.env.ASTRAL_SHOT) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          if (process.env.ASTRAL_SHOT_ASK) {
            const ask = JSON.stringify(process.env.ASTRAL_SHOT_ASK)
            await mainWindow.webContents.executeJavaScript(
              `window.Astral && window.Astral.submit(${ask}).catch(e => console.error(e))`
            ).catch(() => {})
            await new Promise((resolve) => setTimeout(resolve, Number(process.env.ASTRAL_SHOT_WAIT || 9000)))
          }
          if (process.env.ASTRAL_SHOT_ZOOM) {
            mainWindow.webContents.setZoomFactor(Number(process.env.ASTRAL_SHOT_ZOOM))
            await new Promise((resolve) => setTimeout(resolve, 500))
          }
          if (process.env.ASTRAL_SHOT_JS) {
            await mainWindow.webContents.executeJavaScript(process.env.ASTRAL_SHOT_JS).catch(() => {})
            await new Promise((resolve) => setTimeout(resolve, Number(process.env.ASTRAL_SHOT_JS_WAIT || 900)))
          }
          if (process.env.ASTRAL_SHOT_TOP) {
            await mainWindow.webContents.executeJavaScript('document.querySelector("#stream").scrollTop = 0').catch(() => {})
          } else {
            await mainWindow.webContents.executeJavaScript(
              'const s = document.querySelector("#stream"); if (s) s.scrollTop = s.scrollHeight'
            ).catch(() => {})
          }
          await new Promise((resolve) => setTimeout(resolve, 400))
          const rect = process.env.ASTRAL_SHOT_RECT
            ? (() => {
                const [x, y, width, height] = process.env.ASTRAL_SHOT_RECT.split(',').map(Number)
                return { x, y, width, height }
              })()
            : undefined
          const image = await mainWindow.webContents.capturePage(rect)
          await fsp.writeFile(process.env.ASTRAL_SHOT, image.toPNG())
          console.error(`[shot] ${process.env.ASTRAL_SHOT}`)
        } catch (err) {
          console.error(`[shot] failed: ${err.message}`)
        }
        app.quit()
      }, 2600)
    })
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('close', (event) => {
    /* 关窗 = 收进托盘；只有真正退出（托盘菜单 / app.quit）才放行销毁 */
    if (isQuitting || !closeToTray || !createTray()) return
    event.preventDefault()
    hideMainWindow()
  })

  mainWindow.on('show', () => { refreshTray(); notifyActivity() })
  mainWindow.on('hide', () => { refreshTray(); notifyActivity() })
  mainWindow.on('minimize', () => { refreshTray(); notifyActivity() })
  mainWindow.on('restore', () => { refreshTray(); notifyActivity() })

  mainWindow.on('closed', () => {
    killSpeechProcess()
    mainWindow = null
    refreshTray()
  })
}

/* 单实例：已经常驻后台时再双击图标，只把原窗口叫回前台，不另起一套进程。
   截图 / 自动化自检需要并行跑隔离实例，那些模式跳过锁。 */
const TEST_RUN = Boolean(process.env.ASTRAL_SHOT || process.env.ASTRAL_EVAL || process.env.ASTRAL_MULTI)
const gotSingleInstanceLock = TEST_RUN ? true : app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', async () => {
    const info = currentBuildInfo()
    if (app.isPackaged && info.stale) {
      try {
        const choice = await showThemedConfirm({
          title: '星界构建已更新',
          message: '磁盘上的应用构建比当前运行的进程更新。',
          detail: [
            `当前进程启动：${new Date(info.startedAt).toLocaleString('zh-CN', { hour12: false })}`,
            `最新构建文件：${info.latestFile || '未知'}`,
            `文件更新时间：${info.latestAt ? new Date(info.latestAt).toLocaleString('zh-CN', { hour12: false }) : '未知'}`,
            '',
            '继续使用当前窗口会运行旧渲染代码。请选择「现在重启」加载新构建；如果正在执行任务，可以选择稍后手动退出。'
          ].join('\n'),
          actions: [
            { value: 0, label: '现在重启', style: 'primary' },
            { value: 1, label: '稍后', style: 'ghost' }
          ],
          cancelValue: 1,
          themeTokens: await dialogThemeTokens(),
          width: 600,
          height: 500
        })
        if (choice === 0) {
          isQuitting = true
          app.relaunch()
          app.exit(0)
          return
        }
      } catch { /* 对话框失败时仍然把窗口叫回前台 */ }
    }
    showMainWindow()
  })
}

if (process.platform === 'win32') app.setAppUserModelId('com.astral.realm.workbench')

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return
  registerAppProtocol()
  await ensureConfig()
  const settings = await readJson(path.join(CONFIG_DIR, 'settings.json'), {})
  const backgroundCfg = await readJson(BACKGROUND_FILE(), {})
  trayHintShown = Boolean(backgroundCfg.hintShown)
  applyBackgroundPref(!settings.app || settings.app.closeToTray !== false)
  const bridgeCfg = settings.bridge || {}
  bridgeToken = bridgeCfg.token || crypto.randomBytes(8).toString('hex')
  if (!bridgeCfg.token) {
    settings.bridge = { ...bridgeCfg, token: bridgeToken }
    await writeJson(path.join(CONFIG_DIR, 'settings.json'), settings)
  }
  const savedWindow = await readJson(WINDOW_STATE_FILE(), null)
  createWindow(savedWindow)
  createTray()
  if (bridgeCfg.enabled !== false && mainWindow) {
    await startBridge(mainWindow, bridgeCfg.port || 45871, bridgeToken)
  }
  app.on('activate', () => {
    showMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (isQuitting) return
  /* 常驻模式：窗口没了也不退出，任务与桥继续在后台跑；没有托盘可依赖时才真退出 */
  if (closeToTray && tray) return
  if (process.platform === 'darwin') return
  app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
  destroyTray()
  mcpRegistry.shutdown().catch(() => {})
  if (bridgeServer) bridgeServer.close()
  killSpeechProcess()
})

/* keep a reference so electron's net module is not tree-shaken away by linters */
void net
