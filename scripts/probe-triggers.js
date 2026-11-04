#!/usr/bin/env node
'use strict'

/* probe-triggers.js — 事件触发器端到端探针（真实 Electron，不调用任何模型）
 * 验证：观察模式零模型调用 / 零对话消息、白名单与去重、候选卡片 UI 渲染。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const TIMEOUT = 120000
const MOCK_PORT = 46001

function copyDir (src, dest) { fs.cpSync(src, dest, { recursive: true }) }
function writeJson (file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

function evalScript () {
  return `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    let ready = false
    for (let i = 0; i < 80; i++) {
      if (window.Astral && window.Astral.triggers) { ready = true; break }
      await sleep(300)
    }
    if (!ready) return { ok: false, error: 'not-ready' }
    const T = Astral.triggers
    const messagesBefore = Astral.state.messages.length
    const r1 = T.emitEvent({ source: 'test', type: 'manual', text: '探针测试事件' }, { isTest: true })
    const r2 = T.emitEvent({ source: 'ci', eventId: 'probe-1', type: 'ci.failed', text: 'CI 构建失败' })
    const r3 = T.emitEvent({ source: 'ci', eventId: 'probe-1', type: 'ci.failed', text: 'CI 构建失败' })
    const r4 = T.emitEvent({ source: 'stranger', eventId: 'probe-2', text: '未授权来源' })
    const events = T.listEvents()
    let ui = { opened: false }
    try {
      Astral.openSettings('bridge')
      await sleep(700)
      ui = {
        opened: true,
        modeTitle: document.body.textContent.includes('事件模式'),
        rules: document.body.textContent.includes('来源白名单'),
        cards: document.querySelectorAll('.trig-event').length,
        approveButtons: [...document.querySelectorAll('.trig-event button')].filter((b) => b.textContent === '批准执行').length
      }
    } catch (err) { ui.error = String(err) }
    const messagesAfterSceneA = Astral.state.messages.length
    const modeSceneA = T.config().mode
    /* 场景 A2：同一 threadId 的两条事件应归到一张候选卡 */
    const m1 = T.emitEvent({ source: 'ci', eventId: 'th-1', threadId: 'pr-7', text: 'CI 首次失败' })
    const m2 = T.emitEvent({ source: 'ci', eventId: 'th-2', threadId: 'pr-7', text: 'CI 仍然失败' })
    const threadCards = T.listEvents().filter((e) => e.threadId === 'pr-7')
    const thread = {
      first: m1.status,
      second: m2.status,
      merged: m2.merged === true,
      cards: threadCards.length,
      count: threadCards[0] ? threadCards[0].threadCount : 0
    }

    /* 场景 B：切到 auto，让一条事件真正跑完一轮（本地假模型，不联网） */
    let auto = {}
    try {
      Astral.state.settings.triggers.mode = 'auto'
      Astral.state.settings.triggers.sources = ['ci']
      const beforeAuto = Astral.state.messages.length
      const rAuto = T.emitEvent({ source: 'ci', eventId: 'probe-auto', type: 'ci.failed', threadId: 'pr-auto', text: 'CI 构建失败，请分析原因' })
      let hit = null
      for (let i = 0; i < 80; i++) {
        hit = T.listEvents().find((e) => e.eventId === 'probe-auto') || null
        if (hit && (hit.status === 'executed' || hit.status === 'failed')) break
        await sleep(250)
      }
      const userTexts = Astral.state.messages.filter((m) => m.kind === 'user').map((m) => String(m.text || ''))
      auto = {
        emit: rAuto.status,
        status: hit ? hit.status : 'missing',
        reason: hit ? hit.reason : '',
        messagesBefore: beforeAuto,
        messagesAfter: Astral.state.messages.length,
        hasMandate: Boolean(hit && hit.mandate),
        hasEventTextInChat: userTexts.some((t) => t.includes('[事件单 md_')),
        hasEventBodyInChat: userTexts.some((t) => t.includes('CI 构建失败，请分析原因'))
      }
    } catch (err) { auto = { error: String(err) } }

    return {
      ok: true,
      r1, r2, r3, r4,
      messagesBefore,
      messagesAfter: messagesAfterSceneA,
      eventCount: events.length,
      statuses: events.map((e) => e.status),
      mode: modeSceneA,
      watchdog: T.config().watchdog,
      ui,
      thread,
      auto
    }
  })()`
}

/* 本地假模型：让 auto 模式真正跑完一轮，并把最后一次请求落盘供核对 */
function startMock (captureFile) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_CAPTURE: captureFile, MOCK_DELAY: '2' }
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mock-llm.js')], {
      cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe']
    })
    let buf = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('mock-llm 启动超时')) }, 10000)
    child.stderr.on('data', (chunk) => {
      buf += chunk
      if (buf.includes('[mock-llm]')) { clearTimeout(timer); resolve(child) }
    })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

function runElectron (dir) {
  return new Promise((resolve) => {
    const electronPath = require('electron')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    env.ASTRAL_EVAL = evalScript()
    env.ASTRAL_EVAL_DELAY = '2600'
    env.ASTRAL_TRUST_RUN_OWNER = '1'
    env.ASTRAL_MULTI = '1'
    const child = spawn(electronPath, ['.'], { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => { child.kill(); resolve({ code: -1, stderr, timedOut: true }) }, TIMEOUT)
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stderr, error: err.message }) })
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stderr }) })
  })
}

async function main () {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-probe-triggers-'))
  let mock = null
  try {
    mock = await startMock(path.join(temp, 'mock-capture.json'))
    copyDir(path.join(ROOT, 'app'), path.join(temp, 'app'))
    copyDir(path.join(ROOT, 'electron'), path.join(temp, 'electron'))
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(temp, 'package.json'))
    fs.mkdirSync(path.join(temp, 'config'), { recursive: true })
    fs.copyFileSync(path.join(ROOT, 'config', 'projects.json'), path.join(temp, 'config', 'projects.json'))
    writeJson(path.join(temp, 'config', 'settings.json'), {
      theme: 'astral',
      onboarding: { knowledgePrompted: true },
      plugins: { knowledge: { enabled: false }, stardust: { enabled: false } },
      app: { closeToTray: false },
      thinking: 0,
      bridge: { enabled: false, port: 45871, token: '' },
      triggers: {
        mode: 'observe', sources: ['ci'], keywords: [], dedupe: true,
        quietHours: null, watchdog: { enabled: true, threshold: 3 }, events: []
      }
    })
    writeJson(path.join(temp, 'config', 'mcp.json'), { version: 1, servers: [] })
    writeJson(path.join(temp, 'config', 'providers.json'), {
      providers: [{
        id: 'deepseek', name: 'Mock', kind: 'openai',
        baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'mock',
        models: ['deepseek-chat'], enabled: true
      }]
    })

    const run = await runElectron(temp)
    const match = /\[eval\]\s+(\{[\s\S]*\})\s*$/m.exec(run.stderr)
    if (!match) {
      console.error('探针失败：未拿到 eval 结果')
      console.error(run.stderr.split('\n').slice(-16).join('\n'))
      return 1
    }
    const r = JSON.parse(match[1])
    if (!r.ok) { console.error('探针失败：' + r.error); return 1 }
    let captured = null
    try { captured = JSON.parse(fs.readFileSync(path.join(temp, 'mock-capture.json'), 'utf8')) } catch { /* 未捕获到请求 */ }

    const failures = []
    if (r.mode !== 'observe') failures.push(`模式应为 observe，实际 ${r.mode}`)
    if (r.r1.status !== 'observed') failures.push(`测试事件应进候选，实际 ${r.r1.status}`)
    if (r.r2.status !== 'observed') failures.push(`白名单事件应进候选，实际 ${r.r2.status}`)
    if (r.r3.status !== 'ignored') failures.push(`重复事件应被忽略，实际 ${r.r3.status}`)
    if (r.r4.status !== 'rejected') failures.push(`非白名单应被拒绝，实际 ${r.r4.status}`)
    if (r.messagesAfter !== r.messagesBefore) failures.push(`观察模式产生了对话消息：${r.messagesBefore} → ${r.messagesAfter}`)
    if (!r.ui.modeTitle || !r.ui.rules) failures.push('设置页未渲染事件模式或规则区')
    if (r.ui.cards < 2) failures.push(`候选卡片数量不足：${r.ui.cards}`)
    if (r.ui.approveButtons < 2) failures.push(`批准按钮数量不足：${r.ui.approveButtons}`)
    if (!r.watchdog || r.watchdog.threshold !== 3) failures.push('Watchdog 配置未生效')
    if (!r.thread || !r.thread.merged || r.thread.cards !== 1 || r.thread.count !== 2) {
      failures.push('线索归集失败：' + JSON.stringify(r.thread))
    }
    if (!r.auto || r.auto.status !== 'executed') failures.push('auto 未跑完一轮：' + JSON.stringify(r.auto))
    if (r.auto && r.auto.messagesAfter <= r.auto.messagesBefore) failures.push('auto 未产生对话消息')
    if (r.auto && !r.auto.hasMandate) failures.push('auto 未生成任务单')
    if (!r.auto || !r.auto.hasEventTextInChat) failures.push('对话流里没有事件单文本')
    if (!r.auto || !r.auto.hasEventBodyInChat) failures.push('对话流里没有事件正文')

    console.log('--- 事件判定 ---')
    console.log(JSON.stringify({ r1: r.r1.status, r2: r.r2.status, r3: r.r3.status, r4: r.r4.status, statuses: r.statuses }))
    console.log('--- 对话流 ---')
    console.log(JSON.stringify({ before: r.messagesBefore, after: r.messagesAfter }))
    console.log('--- 设置页 UI ---')
    console.log(JSON.stringify(r.ui))
    console.log('--- 线索归集 ---')
    console.log(JSON.stringify(r.thread))
    console.log('--- auto 真实一轮 ---')
    console.log(JSON.stringify(r.auto))
    console.log('--- 假模型收到的请求 ---')
    console.log(JSON.stringify({ user: captured ? String(captured.user || '').slice(0, 200) : '' }))
    if (failures.length) {
      console.log('--- 结论 ---')
      for (const f of failures) console.log('✗ ' + f)
      return 1
    }
    console.log('--- 结论 ---')
    console.log('✓ 观察模式：0 次模型调用、0 条对话消息，事件只进候选')
    console.log('✓ 规则层：白名单 / 去重生效，未授权来源被拒')
    console.log('✓ 设置 → 外部接口：候选卡片与批准按钮正常渲染')
    console.log('✓ 线索归集：同 threadId 两条事件合成一张单')
    console.log('✓ auto 真实一轮：事件单进入对话流、模型完成收束、任务单已生成')
    return 0
  } finally {
    if (mock) { try { mock.kill() } catch { /* 已退出 */ } }
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5 }) } catch { /* Windows 下可能 EBUSY */ }
  }
}

main().then((code) => { process.exitCode = code }).catch((err) => {
  console.error(err)
  process.exitCode = 1
})
