#!/usr/bin/env node
'use strict'

/* shot-splash.js — 启动动画分帧截图
 *
 * 在临时目录启动真实 Electron，等 SHOT_JS 时点（load 后 2600ms，
 * 彗星与 Logo 动画早已就位）把 splash 克隆下来、暂停全部 CSS 动画并
 * 回卷到指定时刻 currentTime，再交给 ASTRAL_SHOT 截图。
 * 这样每个关键帧都能在任意时刻精确复现。
 *
 * 用法：node scripts/shot-splash.js [输出目录]
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const TIMEOUT = 60000

/* 彗星 1150ms 航程 + 1050ms 后 Logo 组装的关键帧 */
const FRAMES = [
  { t: 120, label: 'f0-comet-entering' },
  { t: 368, label: 'f1-comet-at-w1' },
  { t: 780, label: 'f2-comet-at-w2' },
  { t: 1093, label: 'f3-comet-merge' },
  { t: 1750, label: 'f4-logo-assembling' },
  { t: 3000, label: 'f5-logo-complete' }
]

function copyDir (src, dest) {
  fs.cpSync(src, dest, { recursive: true })
}

function writeJson (file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

function frameJs (t) {
  return `(() => {
    const splash = document.getElementById('splash')
    if (!splash) return 'no-splash'
    const clone = splash.cloneNode(true)
    clone.classList.remove('stars-live', 'leaving')
    splash.replaceWith(clone)
    for (const a of clone.getAnimations({ subtree: true })) {
      try { a.pause(); a.currentTime = ${t} } catch (e) {}
    }
    return 'frozen@${t} anims=' + clone.getAnimations({ subtree: true }).length
  })()`
}

function runElectron (dir, shotPath, t) {
  return new Promise((resolve) => {
    const electronPath = require('electron')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    env.ASTRAL_SHOT = shotPath
    env.ASTRAL_SHOT_JS = frameJs(t)
    env.ASTRAL_SHOT_JS_WAIT = '900'
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
  const outDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'astral-splash-shots'))
  fs.mkdirSync(outDir, { recursive: true })
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-splash-'))
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
      /* ASTRAL_SHOT_JS 的返回值不回传，只能以截图落地为准；冻结脚本失败时
         画面会停在 sweep 结束后的静帧，肉眼可直接看出。 */
      const okShot = /\[shot\]/.test(run.stderr) && fs.existsSync(shotPath) && fs.statSync(shotPath).size > 4000
      if (okShot) {
        console.log(`✓ ${frame.label} (t=${frame.t}ms)`)
      } else {
        failures++
        console.error(`✗ ${frame.label}：未截图`)
        console.error(run.stderr.split('\n').slice(-8).join('\n'))
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
