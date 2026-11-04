#!/usr/bin/env node
'use strict'

/* probe-theme-clash.js — 星砂(插件主题) × 杏日 冲突复现探针
 * 场景 A（刷新回退）：临时配置 theme='sand' 启动 → boot 时 sand 未注册会回退，
 *   插件注册完成后应自动纠正回星砂（--bg-0=#0a0906）。
 * 场景 B（切换残留）：杏日 → 星砂 后，杏日显式覆盖的 --plane/--surface/
 *   --line/--shadow-lg 必须回落到样式表默认值，不得残留棕色调。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const TIMEOUT = 120000

const APRICOT = {
  plane: 'rgba(255, 251, 244, 0.78)',
  surface: 'rgba(96, 62, 24, 0.05)',
  line: 'rgba(96, 62, 24, 0.11)',
  shadow: '0 24px 60px rgba(120, 78, 30, 0.2)'
}

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
    const read = (tag) => {
      const cs = getComputedStyle(document.documentElement)
      return {
        tag,
        setting: window.Astral ? (Astral.state.settings.theme || '') : '',
        bodyTheme: document.body.dataset.theme || '',
        themeIds: window.Astral ? Astral.state.themes.map((x) => x.id) : [],
        bg0: cs.getPropertyValue('--bg-0').trim(),
        fg0: cs.getPropertyValue('--fg-0').trim(),
        plane: cs.getPropertyValue('--plane').trim(),
        surface: cs.getPropertyValue('--surface').trim(),
        line: cs.getPropertyValue('--line').trim(),
        shadow: cs.getPropertyValue('--shadow-lg').trim()
      }
    }
    /* 轮询等 boot 完成 */
    let ready = false
    for (let i = 0; i < 60; i++) {
      if (window.Astral && Array.isArray(Astral.state.themes) && Astral.state.themes.length) { ready = true; break }
      await sleep(500)
    }
    if (!ready) return [{ tag: 'not-ready' }]
    const out = [read('A:boot后(应已是星砂)')]
    await sleep(2500)
    out.push(read('A:再等2.5s(稳定)'))

    /* 场景 B：杏日 → 星砂，检查残留 */
    const apricot = Astral.state.themes.find((x) => x.id === 'apricot')
    const sand = Astral.state.themes.find((x) => x.id === 'sand')
    if (!apricot || !sand) return out.concat([{ tag: 'missing-theme', ids: Astral.state.themes.map((x) => x.id) }])
    Astral.applyTheme(apricot, Astral.state.settings)
    await sleep(400)
    out.push(read('B:切到杏日'))
    Astral.applyTheme(sand, Astral.state.settings)
    Astral.state.settings.theme = 'sand'
    await sleep(400)
    out.push(read('B:切回星砂'))
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-probe-clash-'))
  try {
    copyDir(path.join(ROOT, 'app'), path.join(temp, 'app'))
    copyDir(path.join(ROOT, 'electron'), path.join(temp, 'electron'))
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(temp, 'package.json'))
    fs.mkdirSync(path.join(temp, 'config'), { recursive: true })
    fs.copyFileSync(path.join(ROOT, 'config', 'projects.json'), path.join(temp, 'config', 'projects.json'))
    writeJson(path.join(temp, 'config', 'settings.json'), {
      theme: 'sand',
      onboarding: { knowledgePrompted: true },
      plugins: { knowledge: { enabled: false }, stardust: { enabled: true } },
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
    const rows = JSON.parse(match[1])

    const failures = []
    const a = rows.find((r) => r.tag.startsWith('A:'))
    if (!a) { console.error('缺少场景 A 数据'); return 1 }
    console.log('--- 场景 A：theme=sand 启动（刷新复现）---')
    for (const r of rows.filter((r) => r.tag.startsWith('A:'))) console.log(JSON.stringify(r))
    if (a.bodyTheme !== 'sand') failures.push(`场景 A：boot 后 bodyTheme=${a.bodyTheme}，期望 sand（插件注册未纠正）`)
    if (a.bg0 !== '#0a0906') failures.push(`场景 A：--bg-0=${a.bg0}，期望 #0a0906`)

    const bBefore = rows.find((r) => r.tag === 'B:切到杏日')
    const bAfter = rows.find((r) => r.tag === 'B:切回星砂')
    console.log('--- 场景 B：杏日 → 星砂（残留检查）---')
    for (const r of rows.filter((r) => r.tag.startsWith('B:'))) console.log(JSON.stringify(r))
    if (bBefore && bAfter) {
      if (bAfter.plane === APRICOT.plane) failures.push(`场景 B：--plane 残留杏日值 ${bAfter.plane}`)
      if (bAfter.surface === APRICOT.surface) failures.push(`场景 B：--surface 残留杏日值`)
      if (bAfter.line === APRICOT.line) failures.push(`场景 B：--line 残留杏日值`)
      if (bAfter.shadow === APRICOT.shadow) failures.push(`场景 B：--shadow-lg 残留杏日值`)
      if (bAfter.fg0 !== '#f4ead6') failures.push(`场景 B：--fg-0=${bAfter.fg0}，期望 #f4ead6`)
    }

    if (failures.length) {
      console.log('--- 结论 ---')
      for (const f of failures) console.log('✗ ' + f)
      return 1
    }
    console.log('--- 结论 ---')
    console.log('✓ 场景 A：刷新后星砂自动纠正到位')
    console.log('✓ 场景 B：杏日 → 星砂 无 token 残留')
    return 0
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

main().then((code) => { process.exitCode = code }).catch((err) => {
  console.error(err)
  process.exitCode = 1
})
