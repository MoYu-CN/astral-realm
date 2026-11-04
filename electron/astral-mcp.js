#!/usr/bin/env node
'use strict'

/**
 * 星界 · MCP stdio 服务器
 * 把外部 AI 客户端的 MCP 调用转成本机 HTTP 桥请求。
 *
 * 用法（Claude Desktop / 任意 MCP 客户端）：
 *   command: node
 *   args: ["<星界目录>/electron/astral-mcp.js"]
 *   env: { ASTRAL_PORT: "45871", ASTRAL_TOKEN: "<config/settings.json 里的 bridge.token>" }
 */

const http = require('node:http')

const HOST = '127.0.0.1'
const PORT = Number(process.env.ASTRAL_PORT || 45871)
const TOKEN = process.env.ASTRAL_TOKEN || ''
const SERVER_INFO = { name: 'astral-realm', version: '0.1.0' }
const PROTOCOL_VERSION = '2024-11-05'

const TOOLS = [
  {
    name: 'astral_list_agents',
    description: '列出星界当前编制中的所有成员（总指挥 / 副指挥 / 执行者），含各自绑定的模型与技能。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'astral_send_message',
    description: '向星界下达一条指令。默认交给总指挥，由它拆解并派给下属；指定 agentId 可直连某个成员。会等待整轮协作结束后返回最终答复。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '指令正文' },
        agentId: { type: 'string', description: '可选，直接对话的成员 id' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'astral_get_messages',
    description: '读取星界最近的对话记录。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '条数，默认 30，最大 200' } },
      additionalProperties: false
    }
  },
  {
    name: 'astral_update_agent',
    description: '修改某个成员的属性：名称、职级、汇报对象、提示词、模型、技能等。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '成员 id' },
        patch: {
          type: 'object',
          description: '要修改的字段，如 {"prompt":"...","model":"deepseek-chat","temperature":0.5}'
        }
      },
      required: ['id', 'patch'],
      additionalProperties: false
    }
  },
  {
    name: 'astral_set_context',
    description: '写入上下文。不传 agentId 写全局上下文（全体可见），传了则写该成员的专属上下文。',
    inputSchema: {
      type: 'object',
      properties: {
        notes: { type: 'string' },
        agentId: { type: 'string' }
      },
      required: ['notes'],
      additionalProperties: false
    }
  },
  {
    name: 'astral_set_theme',
    description: '切换界面主题。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '主题 id，如 astral / ember / sand' } },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'astral_status',
    description: '查询星界当前状态：是否忙碌、成员数量、当前主题。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
]

const METHOD_MAP = {
  astral_list_agents: 'astral.list_agents',
  astral_send_message: 'astral.send_message',
  astral_get_messages: 'astral.get_messages',
  astral_update_agent: 'astral.update_agent',
  astral_set_context: 'astral.set_context',
  astral_set_theme: 'astral.set_theme',
  astral_status: 'astral.status'
}

function bridge (method, params) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params: params || {} })
    const req = http.request({
      host: HOST,
      port: PORT,
      path: '/rpc',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-astral-token': TOKEN
      },
      timeout: 180000
    }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch { resolve({ error: { message: `invalid bridge response: ${data.slice(0, 200)}` } }) }
      })
    })
    req.on('error', (err) => resolve({ error: { message: `无法连接星界（${HOST}:${PORT}）：${err.message}` } }))
    req.on('timeout', () => { req.destroy(); resolve({ error: { message: '星界响应超时' } }) })
    req.write(body)
    req.end()
  })
}

function reply (id, payload) {
  const message = { jsonrpc: '2.0', id, ...payload }
  process.stdout.write(JSON.stringify(message) + '\n')
}

async function handle (msg) {
  const { id, method, params } = msg

  if (method === 'initialize') {
    return reply(id, {
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO
      }
    })
  }

  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') return reply(id, { result: {} })

  if (method === 'tools/list') {
    return reply(id, { result: { tools: TOOLS } })
  }

  if (method === 'tools/call') {
    const name = params && params.name
    const args = (params && params.arguments) || {}
    const mapped = METHOD_MAP[name]
    if (!mapped) {
      return reply(id, { error: { code: -32601, message: `未知工具：${name}` } })
    }
    const res = await bridge(mapped, args)
    if (res.error) {
      return reply(id, {
        result: {
          isError: true,
          content: [{ type: 'text', text: res.error.message || JSON.stringify(res.error) }]
        }
      })
    }
    return reply(id, {
      result: { content: [{ type: 'text', text: JSON.stringify(res.result, null, 2) }] }
    })
  }

  return reply(id, { error: { code: -32601, message: `未知方法：${method}` } })
}

let buffer = ''
let inflight = 0
let ended = false

const maybeExit = () => {
  if (ended && inflight === 0) {
    setTimeout(() => process.exit(0), 30)
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      process.stderr.write(`[astral-mcp] 无法解析：${line.slice(0, 120)}\n`)
      continue
    }
    inflight++
    handle(msg)
      .catch((err) => {
        process.stderr.write(`[astral-mcp] ${err.message}\n`)
        if (msg.id !== undefined) reply(msg.id, { error: { code: -32603, message: err.message } })
      })
      .finally(() => {
        inflight--
        maybeExit()
      })
  }
})

process.stdin.on('end', () => {
  ended = true
  maybeExit()
})
