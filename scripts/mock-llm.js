#!/usr/bin/env node
'use strict'

/**
 * 本地假模型（OpenAI 兼容），用于在没有 API Key 的情况下验证
 * 流式输出、派单解析、三层递归汇总这整条链路。
 *
 * 用法：node scripts/mock-llm.js   （监听 127.0.0.1:45999）
 * 然后在 设置 → 模型供应商 里加一个 OpenAI 兼容供应商，Base URL 填 http://127.0.0.1:45999/v1
 */

const http = require('node:http')

const PORT = Number(process.env.MOCK_PORT || 45999)

const PLAN_COMMANDER = `<astral:plan>
{"brief":"先算成本账，再查落地依赖，两条线并行。","tasks":[
 {"to":"deputy-eng","task":"测算 Electron 与 Tauri 在安装包体积、常驻内存、冷启动三项上的量级差距，给出结论倾向。"},
 {"to":"exec-research","task":"查清 Tauri 2 在 Windows 上的 WebView2 依赖情况与代码签名要求。"}]}
</astral:plan>`

const PLAN_DEPUTY = `<astral:plan>
{"brief":"体积结论我来算，校验交给下属复核口径。","tasks":[
 {"to":"exec-review","task":"核对「Electron 运行时约 200MB」这一说法是否包含 Chromium 与 Node 两部分，指出可能被夸大的地方。"}]}
</astral:plan>`

const WORKER = `先说结论：**改动本身不复杂，但收益不如想象中大。**

- 包体积差距是真的，量级在 20 倍以上；
- 内存差距主要来自独立 Chromium 进程，这个才是日常体感差异；
- 冷启动差距在二次启动后基本消失。

需要注意的前提：\`WebView2\` 在 Win10 老版本上可能缺失，需要引导安装。`

const FINAL = `综合两条线的判断：

1. **体积与内存的收益是真实的**，但不构成迁移理由——你面对的是重度用户，不是下载站流量。
2. **真正的风险在运行时依赖**：WebView2 在旧系统上缺失会直接劝退一批人，这条比体积重要得多。
3. **建议**：保留现有 Electron 版本，把前端与 Node 能力解耦；等出现「必须做轻量分发」的场景再迁移。

一句话：**现在迁移是拿确定性换一个不确定的收益。**`

const TEAM_PLAN = '```json\n' + JSON.stringify({
  name: '星界交付组',
  summary: '一条主控线加策划与工程两个执行面，覆盖方案、实现与核对。',
  members: [
    {
      role: 'commander',
      name: '星枢',
      title: '总指挥',
      duty: '判断目标、拆关键路径，收束各线结果并对最终交付负责',
      bio: '说话简洁，先给结论。',
      providerId: 'mock',
      model: 'mock-1',
      temperature: 0.4,
      skills: ['planning']
    },
    {
      role: 'deputy',
      name: '爻',
      title: '副指挥 · 策划',
      duty: '把计划书拆成可执行步骤，负责结构、叙事与验收口径',
      bio: '先问为什么，再给怎么做。',
      providerId: 'mock',
      model: 'mock-1',
      temperature: 0.7,
      skills: []
    },
    {
      role: 'executor',
      name: '熵',
      title: '执行者 · 工程',
      duty: '按方案完成实现与自测，交付可运行的结果',
      bio: '只相信能跑起来的东西。',
      providerId: 'mock',
      model: 'mock-1',
      temperature: 0.3,
      skills: []
    },
    {
      role: 'executor',
      name: '砭',
      title: '执行者 · 校验',
      duty: '核对事实、边界与失败路径，指出交付里的风险',
      bio: '专挑毛病，不负责安慰。',
      providerId: 'mock',
      model: 'mock-1',
      temperature: 0.2,
      skills: ['review']
    }
  ]
}, null, 2) + '\n```'

const SOLO_EXPAND = '我可以独立完成，但这个任务需要并行设计、实现和校验，建议扩展团队。\n<astral:expand>{"reason":"需要并行完成设计、实现与校验"}</astral:expand>'

const SUMMARY = `## 会话目标
为星界补上标准会话形态，并实现「革新」：总结当前会话后开启干净上下文的新会话。

## 已完成
- 默认工作模式改为标准会话，单个智能体直连，不派单。
- 新增革新入口：总结、预览、归档、重置上下文。
- 交接摘要以 handoff 卡片进入新会话，作为唯一历史。

## 关键结论与决策
- 革新只作用于当前智能体的这条线程，其他成员线程与 AI↔AI 日志不受影响。
- 归档最多保留两份，只用于回看，不参与上下文组装。
- 新项目默认标准会话，模板/AI 组队显式使用团队模式。

## 待办与下一步
- 在真实模型上验证总结质量与长会话截断。
- 确认归档回看的入口是否需要在设置里再放一个。

## 重要约束与偏好
- 中文界面，深色星空主题，控件不要白色底板。
- 不要在未确认时清空会话。

交接完成度：完整；仅缺少具体文件行号与测试数值。`

function decide (system, user) {
  if (/会话交接编辑/.test(system || '')) return SUMMARY
  if (/团队编制规划器/.test(system || '')) return TEAM_PLAN
  if (/## 标准会话/.test(user || '')) {
    const task = String(user).split('## 标准会话')[0]
    return /扩展/.test(task) ? SOLO_EXPAND : WORKER
  }
  if (/单智能体模式/.test(user || '')) {
    const task = String(user).split('## 单智能体模式')[0]
    return /扩展/.test(task) ? SOLO_EXPAND : WORKER
  }
  if (user.trim().startsWith('## 收束')) return FINAL
  const name = /你是「(.+?)」/.exec(system || '')
  const who = name ? name[1] : ''
  const role = (/你是本编制中的\*\*(总指挥|副指挥|执行者)\*\*/.exec(system || '') || [])[1] || ''
  if (role === '副指挥' && who === '熵') return PLAN_DEPUTY
  if (role === '总指挥') return PLAN_COMMANDER
  return WORKER
}

function split (text, size) {
  const out = []
  let i = 0
  while (i < text.length) { out.push(text.slice(i, i + size)); i += size }
  return out
}

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'not found' }))
    }

    let payload = {}
    try { payload = JSON.parse(body) } catch { /* ignore */ }

    const messages = payload.messages || []
    const system = (messages.find((m) => m.role === 'system') || {}).content || ''
    const user = [...messages].reverse().find((m) => m.role === 'user')
    /* 测试用：把最近一次请求落到文件，便于核对上下文是否带上交接摘要 */
    if (process.env.MOCK_CAPTURE) {
      try {
        require('node:fs').writeFileSync(process.env.MOCK_CAPTURE, JSON.stringify({
          at: Date.now(),
          system: String(system).slice(0, 4000),
          user: user ? String(user.content).slice(0, 12000) : ''
        }, null, 2))
      } catch { /* ignore */ }
    }
    const text = decide(system, user ? user.content : '')
    const chunks = split(text, 12)

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })

    let i = 0
    const timer = setInterval(() => {
      if (i >= chunks.length) {
        clearInterval(timer)
        /* 模拟 OpenAI stream_options.include_usage：最后一个 chunk 带 usage */
        const outputTokens = chunks.reduce((sum, chunk) => sum + Math.ceil(chunk.length / 2), 0)
        res.write(`data: ${JSON.stringify({
          id: 'mock',
          choices: [],
          usage: { prompt_tokens: 120, completion_tokens: outputTokens, total_tokens: 120 + outputTokens }
        })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      res.write(`data: ${JSON.stringify({ id: 'mock', choices: [{ delta: { content: chunks[i++] } }] })}\n\n`)
    }, Number(process.env.MOCK_DELAY || 18))

    res.on('close', () => clearInterval(timer))
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[mock-llm] http://127.0.0.1:${PORT}/v1  (model: mock-1)`)
})
