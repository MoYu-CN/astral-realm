#!/usr/bin/env node
'use strict'

/* shot-brand.js — 品牌图标落定动画分帧截图
 *
 * 等 body.brand-in 挂上（流星落地揭开品牌位），暂停全部动画并把
 * brandIn/brandRipple 回卷到指定时刻，截图左上角品牌位区域。
 *
 * 用法：node scripts/shot-brand.js [输出目录]
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const TIMEOUT = 90000

/* brandIn 620ms 时间轴上的四个代表帧 */
const FRAMES = [
  { t: 0, label: 'b0-land' },
  { t: 180, label: 'b1-squash' },
  { t: 380, label: 'b2-overshoot-ripple' },
  { t: 620, label: 'b3-settled' },
  /* 常驻阳光钟摆（brandIdle + brandGlow，760ms 起步，5.6s 一轮）：峰值 760+2800 */
  { t: 3560, label: 'b4-idle-peak' },
  { t: 6360, label: 'b5-idle-back' }
]

function copyDir (src, dest) {
  fs.cpSync(src, dest, { recursive: true })
}

function writeJson (file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

function frameJs (t) {
  return `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    /* 轮询等流星落地揭开品牌位 */
    for (let i = 0; i < 200; i++) {
      if (document.body.classList.contains('brand-in')) break
      await sleep(100)
    }
    if (!document.body.classList.contains('brand-in')) return 'no-brand-in'
    await sleep(60)
    const brand = document.querySelector('.brand-mark')
    for (const a of document.getAnimations({ subtree: true })) {
      try { a.pause() } catch (e) {}
    }
    for (const a of brand.getAnimations({ subtree: true })) {
      try { a.currentTime = ${t} } catch (e) {}
    }
    return 'frozen@${t}'
  })()`
}

function runElectron (dir, shotPath, t) {
  return new Promise((resolve) => {
    const electronPath = require('electron')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    env.ASTRAL_SHOT = shotPath
    env.ASTRAL_SHOT_JS = frameJs(t)
    env.ASTRAL_SHOT_JS_WAIT = '3200'
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
  const outDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'astral-brand-shots'))
  fs.mkdirSync(outDir, { recursive: true })
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-brand-'))
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

    let failures = 0
    for (const frame of FRAMES) {
      const shotPath = path.join(outDir, `${frame.label}.png`)
      const run = await runElectron(temp, shotPath, frame.t)
      const okShot = /\[shot\]/.test(run.stderr) && fs.existsSync(shotPath) && fs.statSync(shotPath).size > 4000
      if (okShot) {
        console.log(`✓ ${frame.label} (t=${frame.t}ms)`)
      } else {
        failures++
        console.error(`✗ ${frame.label}：未截图`)
        console.error(run.stderr.split('\n').slice(-6).join('\n'))
      }
    }
    if (failures) {
      console.error(`分帧截图失败 ${failures} 处`)
      return 1
    }
    console.log(`分帧截图完成：${outDir}`)
    return 0
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

main().then((code) => { process.exitCode = code }).catch((err) => {
  console.error(err)
  process.exitCode = 1
})
