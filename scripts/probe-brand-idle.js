#!/usr/bin/env node
'use strict'

/* probe-brand-idle.js — 品牌图标常驻「阳光钟摆」数值探针
 * brandIdle（transform 正弦九帧）+ brandGlow（::before 光斑 opacity 正弦九帧）。
 * 冻结在峰值（760 + 2800 = 3560ms）与回落（760 + 5600 = 6360ms），
 * 读取计算样式确认：峰值 ≈ scale 1.045 + 光斑 opacity ≈0.82，回落归零。
 * 另在 1/8 周期点（760 + 700 = 1460ms）采样，验证正弦上升沿（早期缓升不突跳）。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const TIMEOUT = 120000

function copyDir (src, dest) {
  fs.cpSync(src, dest, { recursive: true })
}

function writeJson (file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

/* t：冻结点（含 760ms 延迟）；label：输出标记 */
function evalScript (t, label) {
  return `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    for (let i = 0; i < 300; i++) {
      if (document.body.classList.contains('brand-in')) break
      await sleep(100)
    }
    if (!document.body.classList.contains('brand-in')) return { tag: 'no-brand-in' }
    await sleep(60)
    const brand = document.querySelector('.brand-mark')
    for (const a of document.getAnimations()) { try { a.pause() } catch (e) {} }
    /* 伪元素动画不在 element.getAnimations({subtree}) 里，
       从全局动画池按 effect.target（PseudoElement 有 .element）过滤出品牌位的全部动画 */
    const brandAnims = document.getAnimations().filter((a) => {
      const target = a.effect && a.effect.target
      if (!target) return false
      return target === brand || target.element === brand
    })
    for (const a of brandAnims) { try { a.currentTime = ${t} } catch (e) {} }
    const cs = getComputedStyle(brand)
    const idle = brandAnims.find((a) => a.animationName === 'brandIdle')
    const glow = brandAnims.find((a) => a.animationName === 'brandGlow')
    return {
      tag: '${label}',
      transform: cs.transform,
      glowOpacity: getComputedStyle(brand, '::before').opacity,
      idlePlayState: idle ? idle.playState : 'none',
      glowPlayState: glow ? glow.playState : 'none'
    }
  })()`
}

function runElectron (dir, js) {
  return new Promise((resolve) => {
    const electronPath = require('electron')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    env.ASTRAL_EVAL = js
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
    child.on('exit', (code) => {
      clearTimeout(timer)
      const m = stderr.match(/\[eval\] (\{.*\})/)
      resolve({ code, result: m ? JSON.parse(m[1]) : null, stderr })
    })
  })
}

function parseScale (transform) {
  const m = String(transform).match(/matrix\(([-\d.]+),/)
  return m ? +m[1] : null
}

async function main () {
  const failures = []
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-brand-idle-'))
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

    /* 峰值：760 + 2800（半周期 5.6s/2）= 3560ms */
    const peak = await runElectron(temp, evalScript(3560, 'idle-peak'))
    if (!peak.result || peak.result.tag !== 'idle-peak') {
      failures.push('峰值冻结失败: ' + (peak.stderr.split('\n').slice(-4).join(' | ') || '无输出'))
    } else {
      const scale = parseScale(peak.result.transform)
      const glow = +peak.result.glowOpacity
      if (scale === null || Math.abs(scale - 1.045) > 0.005) failures.push(`峰值缩放 ${scale}（应 ≈1.045）`)
      if (Math.abs(glow - 0.82) > 0.03) failures.push(`峰值光斑 opacity ${glow}（应 ≈0.82）`)
      /* 探针流程本身会先 pause 所有动画再冻结，playState=paused 即冻结成功 */
      if (peak.result.idlePlayState !== 'paused') failures.push(`brandIdle 冻结失败（${peak.result.idlePlayState}）`)
      if (peak.result.glowPlayState !== 'paused') failures.push(`brandGlow 冻结失败（${peak.result.glowPlayState}）`)
      console.log('峰值  t=3560ms →', JSON.stringify(peak.result))
    }

    /* 回落：760 + 5600（整周期）= 6360ms */
    const back = await runElectron(temp, evalScript(6360, 'idle-back'))
    if (!back.result || back.result.tag !== 'idle-back') {
      failures.push('回落冻结失败: ' + (back.stderr.split('\n').slice(-4).join(' | ') || '无输出'))
    } else {
      const scale = parseScale(back.result.transform)
      const glow = +back.result.glowOpacity
      if (scale === null || Math.abs(scale - 1) > 0.005) failures.push(`回落缩放 ${scale}（应 ≈1）`)
      if (glow > 0.02) failures.push(`回落仍有光斑 ${glow}（应 ≈0）`)
      console.log('回落  t=6360ms →', JSON.stringify(back.result))
    }

    /* 上升沿早期采样：760 + 700（1/8 周期）= 1460ms，
       正弦值 0.146 → scale ≈1.0066、光斑 opacity ≈0.12——缓升不突跳 */
    const early = await runElectron(temp, evalScript(1460, 'idle-early'))
    if (!early.result || early.result.tag !== 'idle-early') {
      failures.push('早期采样失败: ' + (early.stderr.split('\n').slice(-4).join(' | ') || '无输出'))
    } else {
      const scale = parseScale(early.result.transform)
      const glow = +early.result.glowOpacity
      if (scale === null || Math.abs(scale - 1.0066) > 0.004) failures.push(`早期缩放 ${scale}（应 ≈1.0066）`)
      if (Math.abs(glow - 0.12) > 0.03) failures.push(`早期光斑 opacity ${glow}（应 ≈0.12）`)
      console.log('早期  t=1460ms →', JSON.stringify(early.result))
    }
  } finally {
    try {
      fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    } catch { /* Windows 下进程句柄可能延迟释放，清理失败不影响结论 */ }
  }

  console.log('--- 结论 ---')
  if (failures.length) {
    for (const f of failures) console.log('✗ ' + f)
    return 1
  }
  console.log('✓ brandIdle / brandGlow 阳光钟摆循环正常（正弦采样：缓升 → 峰值 → 缓落，无接点停顿）')
  return 0
}

main().then((code) => { process.exitCode = code }).catch((err) => {
  console.error(err)
  process.exitCode = 1
})
