#!/usr/bin/env node
'use strict'

/* probe-theme.js — 主题运行时探针
 * 在 boot 前后各取一次状态：state.themes 是否就绪、applyTheme 后 --bg-0 是否真的变了、
 * boot 完成后是否又被写回默认主题。
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

function writeJson (file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

function evalScript () {
  return `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const read = (tag) => ({
      tag,
      t: Math.round(performance.now()),
      hasAstral: Boolean(window.Astral),
      themeCount: window.Astral && Array.isArray(Astral.state.themes) ? Astral.state.themes.length : -1,
      themeIds: window.Astral && Array.isArray(Astral.state.themes) ? Astral.state.themes.map((x) => x.id) : [],
      current: window.Astral ? (Astral.state.settings.theme || '') : '',
      bodyTheme: document.body.dataset.theme || '',
      lightClass: document.body.classList.contains('theme-light'),
      bg0: getComputedStyle(document.documentElement).getPropertyValue('--bg-0').trim(),
      hasApply: Boolean(window.Astral && typeof Astral.applyTheme === 'function')
    })
    const out = [read('t0')]
    await sleep(4000)
    out.push(read('t0+4s(boot后)'))
    if (window.Astral && typeof Astral.applyTheme === 'function') {
      const t = Astral.state.themes.find((x) => x.id === 'daybreak')
      if (t) {
        Astral.state.settings.theme = 'daybreak'
        Astral.applyTheme(t, Astral.state.settings)
        await sleep(300)
        out.push(read('切到 daybreak 后'))
      } else {
        out.push({ tag: '找不到 daybreak', themeIds: Astral.state.themes.map((x) => x.id) })
      }
    }
    await sleep(4000)
    out.push(read('再等 4s（是否被写回）'))
    return out
  })()`
}

function runElectron (dir) {
  return new Promise((resolve) => {
    const electronPath = require('electron')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    env.ASTRAL_EVAL = evalScript()
    env.ASTRAL_EVAL_DELAY = '2600'
    env.ASTRAL_TRUST_RUN_OWNER = '1'
    const child = spawn(electronPath, ['.'], { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => { child.kill(); resolve({ code: -1, stderr, timedOut: true }) }, TIMEOUT)
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stderr, error: err.message }) })
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stderr }) })
  })
}

async function main () {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-probe-theme-'))
  try {
    copyDir(path.join(ROOT, 'app'), path.join(temp, 'app'))
    copyDir(path.join(ROOT, 'electron'), path.join(temp, 'electron'))
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(temp, 'package.json'))
    fs.mkdirSync(path.join(temp, 'config'), { recursive: true })
    fs.copyFileSync(path.join(ROOT, 'config', 'projects.json'), path.join(temp, 'config', 'projects.json'))
    writeJson(path.join(temp, 'config', 'settings.json'), {
      theme: 'astral',
      onboarding: { knowledgePrompted: true },
      plugins: { knowledge: { enabled: false }, stardust: { enabled: false } },
      app: { closeToTray: false }
    })
    writeJson(path.join(temp, 'config', 'mcp.json'), { version: 1, servers: [] })

    const run = await runElectron(temp)
    const match = /\[eval\]\s+(\[[\s\S]*\])\s*$/m.exec(run.stderr)
    if (!match) {
      console.error('探针失败')
      console.error(run.stderr.split('\n').slice(-12).join('\n'))
      return 1
    }
    for (const row of JSON.parse(match[1])) {
      console.log(JSON.stringify(row))
    }
    return 0
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

main().then((code) => { process.exitCode = code }).catch((err) => {
  console.error(err)
  process.exitCode = 1
})
