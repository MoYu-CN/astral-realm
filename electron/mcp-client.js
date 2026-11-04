'use strict'

/* mcp-client.js — MCP 客户端（stdio 传输）

   负责按 config/mcp.json 启动本机 MCP 服务器、完成 initialize 握手、
   拉取 tools/list，并把 tools/call 转发过去。只做传输与生命周期管理。

   权限与审批不在这里判断：主进程按 roster 重算权限、弹原生确认，然后签发
   一次性审批令牌；这里的 call() 只接受绑定到本次调用的令牌，不认 approved 布尔。

   协议要点：
   - stdio 上每行一个 JSON-RPC 2.0 消息；
   - 握手 protocolVersion 用 2024-11-05（当前服务端普遍兼容的版本）；
   - 服务端反向请求（sampling / roots 等）一律回 -32601，不做支持。 */

const { spawn } = require('node:child_process')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

const PROTOCOL_VERSION = '2024-11-05'
const CLIENT_INFO = { name: 'astral-realm', version: '1.0.0' }
const INIT_TIMEOUT = 20000
const CALL_TIMEOUT = 120000
const MAX_TOOLS = 200
const BUILTIN_ID = 'builtin'

/* 内置工具：不依赖外部进程，开箱即可读写受控目录。
   这是「小任务立刻能干」的兜底，外部 MCP 服务器仍可照常接入。 */
const BUILTIN_TOOLS = [
  {
    name: 'write_text_file',
    description: '写入文本文件（UTF-8），自动创建父目录。path 支持相对用户主目录的写法，例如 Desktop/hello.txt。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标路径，如 Desktop/hello.txt 或 C:\\Users\\你\\Desktop\\hello.txt' },
        content: { type: 'string', description: '要写入的文本内容' },
        overwrite: { type: 'boolean', description: '目标已存在时是否覆盖，默认 false' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'read_text_file',
    description: '读取文本文件内容（UTF-8），最大 200KB。path 支持相对用户主目录的写法。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '要读取的文件路径' } },
      required: ['path']
    }
  },
  {
    name: 'list_directory',
    description: '列出目录下的文件与子目录（最多 200 项）。path 支持相对用户主目录的写法，例如 Desktop。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '目录路径，默认用户主目录' } }
    }
  },
  {
    name: 'get_current_timestamp',
    description: '获取当前日期、时间、星期、ISO 时间和 Unix 时间戳。可选传入 IANA 时区（如 Asia/Shanghai），默认使用本机时区。',
    inputSchema: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: '可选，IANA 时区名，如 Asia/Shanghai；默认本机时区' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'take_screenshot',
    description: '截取当前主屏幕或星界窗口，保存为 PNG 并返回可预览的绝对路径。截图属于敏感操作，调用前需要用户确认。',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: ['screen', 'window'],
          description: 'screen = 主屏幕（默认）；window = 星界窗口'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'kb_guide',
    description: '按正在做的事（工序）返回知识库里该照做的条目；动手前先查。task 写“什么时候会遇到”，stage 可选：设计/动手前/写码中/提交前/排障。',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '正在做的工序，例如：给插件加配置项、排查构建失败' },
        stage: { type: 'string', enum: ['设计', '动手前', '写码中', '提交前', '排障'] },
        kind: { type: 'string', enum: ['方法', '避错'] },
        limit: { type: 'number', description: '最多返回几条，默认 5，硬上限 20' }
      },
      required: ['task']
    }
  },
  {
    name: 'kb_search',
    description: '关键词检索知识库，回答「这个项目以前提过这个词吗」。返回编号、类别、领域、标题和正文。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '检索关键词' },
        kind: { type: 'string', enum: ['方法', '避错'] },
        domain: { type: 'string', description: '只查某个领域' },
        limit: { type: 'number', description: '最多返回几条，默认取设置里的检索条数' }
      },
      required: ['text']
    }
  },
  {
    name: 'kb_add',
    description: '往当前项目的知识库写一条。「避错」必须有触发条件、先做、为什么、违规症状；「方法」必须有步骤。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['方法', '避错'] },
        domain: { type: 'string', description: '领域名；空则归入未分类' },
        title: { type: 'string' },
        trigger: { type: 'string', description: '触发条件 / 适用场景' },
        steps: { type: 'array', items: { type: 'string' }, description: '可执行步骤；避错里叫「先做」' },
        why: { type: 'string', description: '依据' },
        symptoms: { type: 'string', description: '违规症状（避错必填）：怎么判断没做' },
        verify: { type: 'string', description: '验证方式' },
        boundaries: { type: 'string', description: '已知边界' },
        id: { type: 'string', description: '可选；更新已有条目时传编号' }
      },
      required: ['kind', 'title', 'steps']
    }
  },
  {
    name: 'kb_list',
    description: '列出当前项目知识库的全部条目摘要（编号 / 类别 / 领域 / 标题）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'kb_get',
    description: '按编号读取知识库的一条全文。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '如 M-001 或 P-003' } },
      required: ['id']
    }
  },
  {
    name: 'kb_remove',
    description: '删除一条知识库条目。不可撤销，调用前必须问用户确认。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '要删除的编号' } },
      required: ['id']
    }
  },
  {
    name: 'kb_prune',
    description: '把知识库清理到不超过 keep 条，只删最旧的。不可撤销，调用前必须问用户确认。',
    inputSchema: {
      type: 'object',
      properties: { keep: { type: 'number', description: '保留条数（两类合计）' } },
      required: ['keep']
    }
  },
  {
    name: 'kb_init',
    description: '为当前项目建出知识库骨架（总纲 + 方法/避错主体索引）。不会覆盖已有文件。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
]

function expandUserPath (input, home) {
  let p = String(input || '').trim()
  if (!p) p = home
  if (p === '~') p = home
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = path.join(home, p.slice(2))
  if (!path.isAbsolute(p)) p = path.join(home, p)
  return path.resolve(p)
}

function insideRoots (target, roots) {
  const norm = target.toLowerCase()
  return roots.some((root) => {
    const base = path.resolve(root).toLowerCase()
    return norm === base || norm.startsWith(`${base}${path.sep}`)
  })
}

async function runBuiltinTool (tool, args, roots, helpers = {}) {
  const home = os.homedir()

  if (String(tool).startsWith('kb_')) {
    if (typeof helpers.knowledge !== 'function') throw new Error('知识库插件当前不可用')
    return await helpers.knowledge(tool, args || {}, helpers.project || {})
  }

  if (tool === 'get_current_timestamp') {
    const now = new Date()
    const requested = String(args.timezone || '').trim()
    const timezone = requested || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    let local
    try {
      local = new Intl.DateTimeFormat('zh-CN', {
        timeZone: timezone,
        dateStyle: 'full',
        timeStyle: 'long'
      }).format(now)
    } catch {
      throw new Error(`无效的时区：${timezone}`)
    }
    return [
      `当前时间：${local}`,
      `时区：${timezone}`,
      `ISO 8601：${now.toISOString()}`,
      `Unix 秒：${Math.floor(now.getTime() / 1000)}`,
      `Unix 毫秒：${now.getTime()}`
    ].join('\n')
  }

  if (tool === 'take_screenshot') {
    if (typeof helpers.captureScreenshot !== 'function') {
      throw new Error('当前环境没有接入截图能力')
    }
    const target = args.target === 'window' ? 'window' : 'screen'
    const shot = await helpers.captureScreenshot({ target })
    if (!shot || shot.ok === false) throw new Error((shot && shot.error) || '截图失败')
    return [
      `截图已保存：${shot.path}`,
      `范围：${shot.label || (target === 'window' ? '星界窗口' : '主屏幕')}`,
      `尺寸：${shot.width} × ${shot.height}`,
      `时间：${shot.capturedAt}`,
      '可在对话中的图片预览里查看。'
    ].join('\n')
  }

  if (tool === 'write_text_file') {
    const target = expandUserPath(args.path, home)
    if (!insideRoots(target, roots)) {
      throw new Error(`只能写入这些目录：${roots.join('、')}。收到的是 ${target}`)
    }
    const content = String(args.content ?? '')
    if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) throw new Error('内容超过 2MB 上限')
    await fsp.mkdir(path.dirname(target), { recursive: true })
    if (!args.overwrite) {
      try {
        await fsp.access(target)
        throw new Error('目标已存在；如需覆盖请把 overwrite 设为 true')
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
    }
    await fsp.writeFile(target, content, 'utf8')
    return `已写入 ${target}（${Buffer.byteLength(content, 'utf8')} 字节）`
  }

  if (tool === 'read_text_file') {
    const target = expandUserPath(args.path, home)
    if (!insideRoots(target, roots)) throw new Error(`只能读取这些目录：${roots.join('、')}`)
    const stat = await fsp.stat(target)
    if (stat.size > 200 * 1024) throw new Error('文件超过 200KB，暂不支持读取')
    return await fsp.readFile(target, 'utf8')
  }

  if (tool === 'list_directory') {
    const target = expandUserPath(args.path, home)
    if (!insideRoots(target, roots)) throw new Error(`只能列出这些目录：${roots.join('、')}`)
    const entries = await fsp.readdir(target, { withFileTypes: true })
    return entries.slice(0, 200).map((e) => `${e.isDirectory() ? '[目录]' : '[文件]'} ${e.name}`).join('\n') || '（空目录）'
  }

  throw new Error(`未知的内置工具 ${tool}`)
}

const DEFAULT_CONFIG = {
  version: 1,
  servers: []
}

function okText (text) {
  return { ok: true, text }
}

class McpServer {
  constructor (cfg, onStatus) {
    this.cfg = cfg
    this.onStatus = onStatus
    this.child = null
    this.status = 'stopped'
    this.error = ''
    this.tools = []
    this.pending = new Map()
    this.seq = 0
    this.buffer = ''
    this.stderr = []
    this.stopping = false
  }

  snapshot () {
    return {
      id: this.cfg.id,
      name: this.cfg.name || this.cfg.id,
      command: this.cfg.command || '',
      args: this.cfg.args || [],
      enabled: this.cfg.enabled !== false,
      autoApprove: Array.isArray(this.cfg.autoApprove) ? this.cfg.autoApprove : [],
      status: this.status,
      error: this.error,
      tools: this.tools.map((t) => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object', properties: {} }
      }))
    }
  }

  setStatus (status, error = '') {
    this.status = status
    this.error = error
    if (this.onStatus) this.onStatus(this.snapshot())
  }

  /* ------------------------------------------------------------ 生命周期 */

  async start () {
    if (!this.cfg.command) {
      this.setStatus('error', '缺少 command 配置')
      return
    }
    await this.stop()
    this.stopping = false
    this.setStatus('starting')

    let child
    try {
      child = spawn(this.cfg.command, this.cfg.args || [], {
        cwd: this.cfg.cwd || undefined,
        env: { ...process.env, ...(this.cfg.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        windowsHide: true
      })
    } catch (err) {
      this.setStatus('error', `启动失败：${err.message}`)
      return
    }

    this.child = child
    this.buffer = ''
    this.stderr = []

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.stderr.push(String(chunk).trim())
      if (this.stderr.length > 30) this.stderr.shift()
    })
    child.on('error', (err) => {
      this.setStatus('error', `进程错误：${err.message}`)
    })
    child.on('exit', (code, signal) => {
      this.child = null
      if (this.stopping) return
      const tail = this.stderr.slice(-3).join(' | ')
      this.setStatus('error', `进程退出（code=${code}${signal ? ` signal=${signal}` : ''}）${tail ? ` · ${tail}` : ''}`)
      this.rejectAll(new Error('MCP 服务器已退出'))
    })

    try {
      await this.initialize()
      this.tools = await this.listTools()
      this.setStatus('ready')
    } catch (err) {
      this.setStatus('error', err.message)
      await this.stop()
    }
  }

  async stop () {
    this.stopping = true
    this.rejectAll(new Error('MCP 服务器已停止'))
    const child = this.child
    this.child = null
    if (!child) return
    try { child.stdin.end() } catch { /* ignore */ }
    try { child.kill() } catch { /* ignore */ }
    await new Promise((resolve) => setTimeout(resolve, 120))
    try { child.kill('SIGKILL') } catch { /* ignore */ }
    this.tools = []
    this.setStatus('stopped')
  }

  rejectAll (err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
    this.pending.clear()
  }

  /* -------------------------------------------------------------- 传输 */

  write (message) {
    if (!this.child || !this.child.stdin.writable) throw new Error('MCP 服务器未连接')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  request (method, params, timeout = CALL_TIMEOUT) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时（${Math.round(timeout / 1000)}s）`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.write({ jsonrpc: '2.0', id, method, params })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      }
    })
  }

  notify (method, params) {
    try {
      this.write({ jsonrpc: '2.0', method, params })
    } catch { /* 连接已断，忽略通知失败 */ }
  }

  onData (chunk) {
    this.buffer += chunk
    let idx
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      this.handleMessage(msg)
    }
  }

  handleMessage (msg) {
    if (!msg || typeof msg !== 'object') return

    /* 服务端发来的请求：明确拒绝，避免对方一直等 */
    if (msg.method && msg.id !== undefined) {
      try {
        this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `星界不支持 ${msg.method}` } })
      } catch { /* ignore */ }
      return
    }

    if (msg.id === undefined) return /* 通知，忽略 */
    const entry = this.pending.get(msg.id)
    if (!entry) return
    this.pending.delete(msg.id)
    clearTimeout(entry.timer)
    if (msg.error) entry.reject(new Error(msg.error.message || `MCP 错误 ${msg.error.code}`))
    else entry.resolve(msg.result)
  }

  /* ------------------------------------------------------------ 协议方法 */

  async initialize () {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: CLIENT_INFO
    }, INIT_TIMEOUT)
    this.notify('notifications/initialized')
    return result
  }

  async listTools () {
    const tools = []
    let cursor
    for (let page = 0; page < 10; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, INIT_TIMEOUT)
      for (const tool of (result && result.tools) || []) {
        if (!tool || !tool.name) continue
        tools.push({
          name: tool.name,
          description: tool.description || '',
          inputSchema: tool.inputSchema || { type: 'object', properties: {} }
        })
        if (tools.length >= MAX_TOOLS) return tools
      }
      cursor = result && result.nextCursor
      if (!cursor) break
    }
    return tools
  }

  async callTool (name, args) {
    const result = await this.request('tools/call', { name, arguments: args || {} })
    return { result, isError: Boolean(result && result.isError) }
  }
}

const IMAGE_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}
const MAX_TOOL_IMAGE = 8 * 1024 * 1024

async function saveMcpImage (configDir, data, mimeType) {
  const ext = IMAGE_EXT[String(mimeType || '').toLowerCase()]
  if (!ext || !data) return ''
  let buffer
  try {
    buffer = Buffer.from(String(data), 'base64')
  } catch {
    return ''
  }
  if (!buffer.length || buffer.length > MAX_TOOL_IMAGE) return ''
  const dir = path.join(configDir, 'data', 'mcp-images')
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.${ext}`)
  await fsp.writeFile(file, buffer)
  /* 只保留最近 50 张，避免工具图片无限堆积 */
  try {
    const files = (await fsp.readdir(dir)).filter((name) => !name.startsWith('.')).sort()
    for (const name of files.slice(0, Math.max(0, files.length - 50))) {
      await fsp.rm(path.join(dir, name), { force: true }).catch(() => {})
    }
  } catch { /* ignore */ }
  return file
}

/* 把 MCP 的 content 数组压成一段可读文本；图片落盘后把绝对路径写进结果，
   对话里的工具卡片会自动把该路径渲染成缩略图。 */
async function flattenContent (result, saveImage) {
  const content = (result && result.content) || []
  const parts = []
  for (const item of content) {
    if (!item) continue
    if (item.type === 'text') {
      parts.push(String(item.text || ''))
    } else if (item.type === 'image') {
      const saved = typeof saveImage === 'function' ? await saveImage(item.data, item.mimeType) : ''
      parts.push(saved ? `图片已保存：${saved}` : `[图片内容 ${item.mimeType || 'image'}，已省略]`)
    } else if (item.type === 'resource') {
      const resource = item.resource || {}
      const uri = resource.uri || ''
      if (resource.text) parts.push(`[资源 ${uri}]\n${String(resource.text).slice(0, 4000)}`)
      else if (resource.blob && String(resource.mimeType || '').startsWith('image/')) {
        const saved = typeof saveImage === 'function' ? await saveImage(resource.blob, resource.mimeType) : ''
        parts.push(saved ? `图片已保存：${saved}` : `[资源图片 ${uri || resource.mimeType}，已省略]`)
      } else {
        parts.push(`[资源 ${uri || resource.mimeType || ''}]`)
      }
    } else {
      parts.push(JSON.stringify(item).slice(0, 2000))
    }
  }
  if (!parts.length && result && result.structuredContent) {
    parts.push(JSON.stringify(result.structuredContent).slice(0, 4000))
  }
  return parts.join('\n').trim()
}

function createMcpRegistry ({ configDir, allowedRoots, captureScreenshot, knowledge, knowledgeEnabled, verifyApproval }) {
  const file = path.join(configDir, 'mcp.json')
  const roots = typeof allowedRoots === 'function' ? allowedRoots : () => (allowedRoots || [])
  let servers = []
  let builtinCfg = null
  const byId = new Map()

  function ensureBuiltin (list) {
    if (!list.some((s) => s.id === BUILTIN_ID)) {
      list.unshift({
        id: BUILTIN_ID,
        name: '本机工具',
        command: '',
        args: [],
        env: {},
        cwd: '',
        enabled: true,
        autoApprove: []
      })
    }
    return list
  }

  async function readConfig () {
    try {
      const raw = await fsp.readFile(file, 'utf8')
      const data = JSON.parse(raw)
      const list = Array.isArray(data && data.servers) ? data.servers : []
      return ensureBuiltin(list
        .filter((s) => s && typeof s.id === 'string' && s.id.trim())
        .map((s) => ({
          id: s.id.trim(),
          name: String(s.name || s.id).trim(),
          command: String(s.command || '').trim(),
          args: Array.isArray(s.args) ? s.args.map(String) : [],
          env: s.env && typeof s.env === 'object' ? s.env : {},
          cwd: typeof s.cwd === 'string' ? s.cwd : '',
          enabled: s.enabled !== false,
          autoApprove: Array.isArray(s.autoApprove) ? s.autoApprove.map(String) : []
        })))
    } catch {
      await fsp.mkdir(configDir, { recursive: true })
      await fsp.writeFile(file, JSON.stringify({ version: 1, servers: ensureBuiltin([]) }, null, 2), 'utf8')
      return ensureBuiltin([])
    }
  }

  async function writeConfig (list) {
    await fsp.mkdir(configDir, { recursive: true })
    await fsp.writeFile(file, JSON.stringify({ version: 1, servers: list }, null, 2), 'utf8')
  }

  async function reload () {
    for (const server of servers) await server.stop()
    servers = []
    byId.clear()

    const list = await readConfig()
    for (const cfg of list) {
      if (cfg.id === BUILTIN_ID) {
        builtinCfg = cfg
        continue
      }
      const server = new McpServer(cfg, () => {})
      servers.push(server)
      byId.set(cfg.id, server)
    }

    await Promise.all(servers.map((server) => (server.cfg.enabled === false ? Promise.resolve() : server.start())))
    return snapshot()
  }

  function builtinSnapshot () {
    const cfg = builtinCfg || { id: BUILTIN_ID, name: '本机工具', enabled: true, autoApprove: [] }
    const enabled = cfg.enabled !== false
    const allowKnowledge = typeof knowledgeEnabled !== 'function' || knowledgeEnabled()
    const tools = BUILTIN_TOOLS.filter((t) => !t.name.startsWith('kb_') || allowKnowledge)
    return {
      id: BUILTIN_ID,
      name: cfg.name || '本机工具',
      command: '（内置）',
      args: [],
      enabled,
      autoApprove: cfg.autoApprove || [],
      status: enabled ? 'ready' : 'stopped',
      error: '',
      tools: enabled ? tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema
      })) : []
    }
  }

  function snapshot () {
    return {
      ok: true,
      configPath: file,
      servers: [builtinSnapshot(), ...servers.map((s) => s.snapshot())]
    }
  }

  async function call (request = {}) {
    const { serverId, tool, args, approvalToken, projectId, projectName, projectRoot } = request
    /* 只认主进程签发的令牌；缺失、过期、参数不一致、重复使用一律拒绝。
       渲染层传来的 approved:true 不会进入这里，也不会被当作授权。 */
    const approval = typeof verifyApproval === 'function'
      ? verifyApproval(approvalToken, request)
      : { ok: false, error: '审批校验器不可用' }
    if (!approval || approval.ok !== true) {
      return {
        ok: false,
        error: (approval && approval.error) || 'needs-approval',
        approvalDenied: true
      }
    }

    if (serverId === BUILTIN_ID) {
      const cfg = builtinCfg || { name: '本机工具', enabled: true, autoApprove: [] }
      if (cfg.enabled === false) return { ok: false, error: '内置文件工具已停用' }
      if (String(tool).startsWith('kb_') && typeof knowledgeEnabled === 'function' && !knowledgeEnabled()) {
        return { ok: false, error: '知识库插件当前未启用' }
      }
      if (!BUILTIN_TOOLS.some((t) => t.name === tool)) {
        return { ok: false, error: `内置工具没有「${tool}」` }
      }
      try {
        const text = await runBuiltinTool(tool, args || {}, roots(), {
          captureScreenshot,
          knowledge,
          project: { projectId, projectName, projectRoot }
        })
        return { ok: true, text, server: cfg.name || '本机工具', tool, approvalId: approval.id }
      } catch (err) {
        return { ok: false, error: err.message, approvalId: approval.id }
      }
    }

    const server = byId.get(String(serverId || ''))
    if (!server) return { ok: false, error: '没有这个 MCP 服务器' }
    if (server.cfg.enabled === false) return { ok: false, error: `${server.cfg.name} 已停用` }
    if (server.status !== 'ready') return { ok: false, error: `服务器未就绪：${server.error || server.status}` }
    if (!server.tools.some((t) => t.name === tool)) return { ok: false, error: `服务器没有暴露工具「${tool}」` }

    try {
      const { result, isError } = await server.callTool(tool, args)
      const text = await flattenContent(result, (data, mimeType) => saveMcpImage(configDir, data, mimeType))
      return { ok: !isError, isError, text, server: server.cfg.name, tool, approvalId: approval.id }
    } catch (err) {
      return { ok: false, error: err.message, approvalId: approval.id }
    }
  }

  function isAutoApproved (serverId, tool) {
    if (serverId === BUILTIN_ID) {
      const cfg = builtinCfg || { autoApprove: [] }
      return (cfg.autoApprove || []).includes(tool)
    }
    const server = byId.get(String(serverId || ''))
    return Boolean(server && (server.cfg.autoApprove || []).includes(tool))
  }

  async function allowAlways (serverId, tool) {
    const id = String(serverId || '')
    const list = await readConfig()
    const cfg = list.find((s) => s.id === id)
    if (!cfg) return { ok: false, error: '没有这个 MCP 服务器' }
    if (!Array.isArray(cfg.autoApprove)) cfg.autoApprove = []
    if (!cfg.autoApprove.includes(tool)) cfg.autoApprove.push(tool)
    await writeConfig(list)
    if (id === BUILTIN_ID) {
      builtinCfg = cfg
    } else {
      const server = byId.get(id)
      if (server) server.cfg.autoApprove = cfg.autoApprove
    }
    return { ok: true, autoApprove: cfg.autoApprove }
  }

  async function setEnabled (serverId, enabled) {
    const list = await readConfig()
    const cfg = list.find((s) => s.id === serverId)
    if (!cfg) return { ok: false, error: '配置里找不到该服务器' }
    cfg.enabled = Boolean(enabled)
    await writeConfig(list)
    await reload()
    return snapshot()
  }

  async function shutdown () {
    await Promise.all(servers.map((s) => s.stop()))
  }

  return { reload, snapshot, call, isAutoApproved, allowAlways, setEnabled, shutdown, configPath: file }
}

module.exports = { createMcpRegistry, flattenContent, saveMcpImage }
