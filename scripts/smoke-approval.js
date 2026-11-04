#!/usr/bin/env node
'use strict'

/* smoke-approval.js — 工具审批三条路径的 Electron 自动化测试
 *
 * 在临时目录复制一份应用与最小配置，启动真实 Electron：
 *   1. 拒绝   (choice 2) -> 调用被拒绝，审计 approved=false / denied
 *   2. 允许一次 (choice 0) -> 执行成功，审计 approvalSource=once
 *   3. 始终允许 (choice 1) -> 执行成功，写入 autoApprove，审计 approvalSource=always
 *
 * 用法：node scripts/smoke-approval.js
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const TIMEOUT = 90000

function copyDir (src, dest) {
  fs.cpSync(src, dest, { recursive: true })
}

function readJson (file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function writeJson (file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

function evalScript () {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    await sleep(3000)
    const projectId = window.Astral.state.activeProjectId
    const started = await window.astral.runStart({
      projectId,
      projectName: '默认项目',
      agentId: 'commander',
      agentName: '星枢',
      thread: 'commander',
      prompt: 'approval-smoke',
      channel: 'user'
    })
    if (!started || !started.ok) return { ok: false, error: 'runStart failed: ' + JSON.stringify(started) }
    await window.astral.mcpReload()
    const base = {
      serverId: 'builtin',
      tool: 'get_current_timestamp',
      args: { timezone: 'UTC' },
      agentId: 'commander',
      projectId,
      runId: started.run.id,
      runCapability: started.run.runCapability
    }
    const deny = await window.astral.mcpCall(base)
    const once = await window.astral.mcpCall(base)
    const always = await window.astral.mcpCall(base)
    await window.astral.runFinish({ id: started.run.id, status: 'completed' })
    return {
      ok: true,
      deny: { ok: deny.ok, denied: deny.denied, error: deny.error },
      once: { ok: once.ok, hasText: Boolean(once.text), error: once.error },
      always: { ok: always.ok, hasText: Boolean(always.text), error: always.error }
    }
  })()`
}

function runElectron (dir) {
  return new Promise((resolve) => {
    const electronPath = require('electron')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    env.ASTRAL_EVAL = evalScript()
    env.ASTRAL_EVAL_DELAY = '6000'
    env.ASTRAL_TRUST_RUN_OWNER = '1'
    env.ASTRAL_TEST_APPROVAL = '1'
    env.ASTRAL_APPROVAL_CHOICES = '2,0,1'
    const child = spawn(electronPath, ['.'], {
      cwd: dir,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill()
      resolve({ code: -1, timedOut: true, stderr, stdout })
    }, TIMEOUT)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, error: err.message, stderr, stdout })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr, stdout })
    })
  })
}

function parseEval (text) {
  const match = /\[eval\]\s+(\{[\s\S]*\})\s*$/m.exec(text)
  if (!match) return null
  try { return JSON.parse(match[1]) } catch { return null }
}

async function main () {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-approval-'))
  try {
    copyDir(path.join(ROOT, 'app'), path.join(temp, 'app'))
    copyDir(path.join(ROOT, 'electron'), path.join(temp, 'electron'))
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(temp, 'package.json'))
    fs.mkdirSync(path.join(temp, 'config'), { recursive: true })
    fs.copyFileSync(path.join(ROOT, 'config', 'projects.json'), path.join(temp, 'config', 'projects.json'))
    writeJson(path.join(temp, 'config', 'settings.json'), {
      theme: 'astral',
      onboarding: { knowledgePrompted: true },
      plugins: {
        knowledge: { enabled: false },
        stardust: { enabled: false }
      },
      permissions: { tools: true },
      app: { closeToTray: false }
    })
    writeJson(path.join(temp, 'config', 'mcp.json'), { version: 1, servers: [] })

    const run = await runElectron(temp)
    const result = parseEval(run.stderr)
    if (!result || !result.ok) {
      console.error('审批冒烟失败：没有拿到 eval 结果')
      console.error(run.stderr.split('\n').slice(-20).join('\n'))
      return 1
    }

    const auditFile = path.join(temp, 'config', 'logs', 'tools.jsonl')
    const audit = fs.existsSync(auditFile)
      ? fs.readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(Boolean)
      : []
    const mcp = readJson(path.join(temp, 'config', 'mcp.json'), { servers: [] })
    const builtin = (mcp.servers || []).find((item) => item.id === 'builtin')
    const autoApprove = (builtin && builtin.autoApprove) || []

    const failures = []
    if (!result.deny || result.deny.ok !== false || result.deny.denied !== true) failures.push('拒绝路径没有拒绝')
    if (!result.once || result.once.ok !== true) failures.push('允许一次路径没有执行')
    if (!result.always || result.always.ok !== true) failures.push('始终允许路径没有执行')
    if (!autoApprove.includes('get_current_timestamp')) failures.push('始终允许没有写入 autoApprove')

    const sources = audit.map((item) => item.approvalSource)
    if (!sources.includes('denied')) failures.push('审计缺少 approvalSource=denied')
    if (!sources.includes('once')) failures.push('审计缺少 approvalSource=once')
    if (!sources.includes('always')) failures.push('审计缺少 approvalSource=always')
    const deniedAudit = audit.find((item) => item.approvalSource === 'denied')
    if (!deniedAudit || deniedAudit.approved !== false) failures.push('拒绝审计 approved 不是 false')
    const approvedAudit = audit.filter((item) => item.approved === true)
    if (approvedAudit.length < 2) failures.push('允许路径审计 approved 数量不足')

    if (failures.length) {
      console.error('审批冒烟失败：')
      for (const failure of failures) console.error(`  - ${failure}`)
      console.error('eval:', JSON.stringify(result))
      console.error('audit sources:', JSON.stringify(sources))
      return 1
    }
    console.log('审批冒烟通过：拒绝 / 允许一次 / 始终允许 三条路径与审计一致')
    return 0
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

main().then((code) => { process.exitCode = code }).catch((err) => {
  console.error(err)
  process.exitCode = 1
})
