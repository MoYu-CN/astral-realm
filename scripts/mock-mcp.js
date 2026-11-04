'use strict'

/* mock-mcp.js — 本地 MCP 测试服务器（stdio）
   用于验证星界的 MCP 客户端：握手、tools/list、tools/call。
   只做回显与求和，不触碰文件系统。 */

let buffer = ''

function reply (id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function fail (id, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } })}\n`)
}

const TOOLS = [
  {
    name: 'echo',
    description: '回显输入文本，用于连通性测试',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text']
    }
  },
  {
    name: 'sum',
    description: '把两个数字相加',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number', description: '第一个数' },
        b: { type: 'number', description: '第二个数' }
      },
      required: ['a', 'b']
    }
  }
]

function handle (msg) {
  if (!msg || typeof msg !== 'object') return
  if (msg.method === 'initialize') {
    return reply(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mock-mcp', version: '1.0.0' }
    })
  }
  if (msg.method === 'notifications/initialized') return
  if (msg.method === 'tools/list') return reply(msg.id, { tools: TOOLS })
  if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params || {}
    if (name === 'echo') {
      return reply(msg.id, { content: [{ type: 'text', text: `echo: ${args.text || ''}` }] })
    }
    if (name === 'sum') {
      const total = Number(args.a || 0) + Number(args.b || 0)
      return reply(msg.id, { content: [{ type: 'text', text: `sum: ${total}` }] })
    }
    return fail(msg.id, `未知工具 ${name}`)
  }
  if (msg.id !== undefined) return fail(msg.id, `不支持的方法 ${msg.method}`)
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    try { handle(JSON.parse(line)) } catch { /* 忽略坏行 */ }
  }
})
