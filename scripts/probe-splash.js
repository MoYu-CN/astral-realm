#!/usr/bin/env node
'use strict'

/* probe-splash.js — 启动动画几何探针
 *
 * 把 splash 克隆后暂停全部动画，逐个时间点回卷并测量
 * 彗星 / 两颗导航星 / 流星（Logo）的实际位置，用 ASTRAL_EVAL 把 JSON 打回来。
 * 用来确认「彗星是否正好停在导航星上」「终点是否落在 Logo 中心」。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const TIMEOUT = 60000

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
    const splash = document.getElementById('splash')
    if (!splash) return { error: 'no-splash' }
    const clone = splash.cloneNode(true)
    clone.classList.remove('stars-live')
    splash.replaceWith(clone)
    const anims = clone.getAnimations({ subtree: true })
    anims.forEach((a) => a.pause())
    const box = (sel) => {
      const el = clone.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        cx: +(r.left + r.width / 2).toFixed(1),
        cy: +(r.top + r.height / 2).toFixed(1),
        w: +r.width.toFixed(1)
      }
    }
    const frames = []
    for (const t of [0, 120, 368, 460, 759, 851, 900, 1093, 1150]) {
      anims.forEach((a) => { try { a.currentTime = t } catch (e) {} })
      await sleep(40)
      frames.push({
        t,
        comet: box('.splash-comet'),
        w1: box('.splash-waypoint.w1'),
        w2: box('.splash-waypoint.w2'),
        meteor: box('.splash-meteor'),
        trail: +getComputedStyle(clone.querySelector('.splash-trail')).opacity
      })
    }
    return {
      viewport: [innerWidth, innerHeight],
      dpr: devicePixelRatio,
      frames
    }
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
    const child = spawn(electronPath, ['.'], {
      cwd: dir,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill()
      resolve({ code: -1, stderr, timedOut: true })
    }, TIMEOUT)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, stderr, error: err.message })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr })
    })
  })
}

async function main () {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-probe-'))
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
    const match = /\[eval\]\s+(\{[\s\S]*\})\s*$/m.exec(run.stderr)
    if (!match) {
      console.error('探针失败：没有拿到 eval 结果')
      console.error(run.stderr.split('\n').slice(-15).join('\n'))
      return 1
    }
    const data = JSON.parse(match[1])
    console.log(`viewport ${data.viewport.join('×')} @dpr ${data.dpr}`)
    console.log('   t(ms) |      comet      |        w1       |        w2       |     meteor      | trail')
    for (const f of data.frames) {
      const fmt = (p) => (p ? `${p.cx.toFixed(0).padStart(4)},${p.cy.toFixed(0).padStart(4)}` : '   —,   —')
      console.log(`  ${String(f.t).padStart(5)} | ${fmt(f.comet)} | ${fmt(f.w1)} | ${fmt(f.w2)} | ${fmt(f.meteor)} | ${f.trail.toFixed(2)}`)
    }
    const w1 = data.frames[2].w1
    const w2 = data.frames[4].w2
    const c2 = data.frames[2].comet
    const c4 = data.frames[4].comet
    const meteor = data.frames[0].meteor
    const end = data.frames[7].comet
    const d = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy)
    console.log('')
    console.log(`彗星停在 w1 的偏差：${d(c2, w1).toFixed(1)}px`)
    console.log(`彗星停在 w2 的偏差：${d(c4, w2).toFixed(1)}px`)
    console.log(`彗星终点与 Logo 中心偏差：${d(end, meteor).toFixed(1)}px`)
    console.log(`Logo 中心在视口：${meteor.cx},${meteor.cy}（${(meteor.cx / data.viewport[0] * 100).toFixed(1)}% , ${(meteor.cy / data.viewport[1] * 100).toFixed(1)}%）`)
    return 0
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

main().then((code) => { process.exitCode = code }).catch((err) => {
  console.error(err)
  process.exitCode = 1
})
