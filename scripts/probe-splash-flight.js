#!/usr/bin/env node
'use strict'

/* probe-splash-flight.js — 收场「飞入品牌位」探针
 * 检查三件事：
 *   1. 飞行期间品牌图标必须隐藏（屏幕上不能同时出现两个 Logo）；
 *   2. 流星落点与品牌位中心必须零偏差（扣掉壳层 booting 上浮位移后）；
 *   3. splash 移除后品牌图标淡入恢复可见。
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

function evalScript () {
  return `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const t0 = performance.now()
    const stamp = () => Math.round(performance.now() - t0)
    /* 1. 等收场开始：body 加上 splash-flying（飞行启动） */
    let flyingAt = -1
    for (let i = 0; i < 300; i++) {
      if (document.body.classList.contains('splash-flying')) { flyingAt = stamp(); break }
      await sleep(100)
    }
    if (flyingAt < 0) return [{ tag: 'no-flight', splash: Boolean(document.getElementById('splash')), t: stamp() }]
    const mid = {
      tag: 'flight-start',
      brandOp: getComputedStyle(document.querySelector('.brand-mark')).opacity,
      shellTransform: getComputedStyle(document.querySelector('.shell')).transform
    }
    /* 2. 等飞行结束：splash-flying 移除（落地瞬间）。
       过渡在 rAF 下一帧才启动，类移除的时刻可能还差最后一二十毫秒，再等一帧宽限。 */
    let landedAt = -1
    for (let i = 0; i < 80; i++) {
      if (!document.body.classList.contains('splash-flying')) { landedAt = stamp(); break }
      await sleep(20)
    }
    await sleep(60)
    /* 本环境合成动画不推进：先冻结到 brandIn 中段（t=380ms，回弹过冲 + 光环扩散）
       量中间状态，验证动画确实在跑；再推到终点量落定状态 */
    const brandEl = document.querySelector('.brand-mark')
    const all = document.getAnimations({ subtree: true })
    for (const a of all) { try { a.pause() } catch (e) {} }
    for (const a of brandEl.getAnimations({ subtree: true })) {
      try { a.currentTime = 380 } catch (e) {}
    }
    const midState = {
      brandTransform: getComputedStyle(brandEl).getPropertyValue('transform'),
      rippleOpacity: getComputedStyle(brandEl, '::after').getPropertyValue('opacity'),
      rippleTransform: getComputedStyle(brandEl, '::after').getPropertyValue('transform')
    }
    document.getAnimations().forEach((a) => { try { a.finish() } catch (e) {} })
    const splash = document.getElementById('splash')
    const meteor = splash && splash.querySelector('.splash-meteor')
    const brand = document.querySelector('.brand-mark')
    const m = meteor ? meteor.getBoundingClientRect() : null
    const b = brand ? brand.getBoundingClientRect() : null
    const landed = m && b ? {
      tag: 'landed',
      flightMs: landedAt - flyingAt,
      dx: +((m.left + m.width / 2) - (b.left + b.width / 2)).toFixed(2),
      dy: +((m.top + m.height / 2) - (b.top + b.height / 2)).toFixed(2),
      sizeDelta: +(m.width - b.width).toFixed(2),
      brandAnim: getComputedStyle(brand).animationName,
      brandIdleRunning: (() => {
        try {
          return brand.getAnimations().some((a) => {
            const n = a.animationName || (a.effect && a.effect.getKeyframes && '')
            return n === 'brandIdle' && a.playState !== 'finished'
          })
        } catch { return 'n/a' }
      })(),
      rippleAnim: (() => { try { return getComputedStyle(brand, '::after').animationName } catch { return 'n/a' } })(),
      midState
    } : { tag: 'landed-no-rect', landedAt }
    /* 3. 等 splash 移除，确认品牌图标恢复可见 */
    let removedAt = -1
    for (let i = 0; i < 40; i++) {
      if (!document.getElementById('splash')) { removedAt = stamp(); break }
      await sleep(50)
    }
    await sleep(260) /* 等淡入走完 */
    const after = {
      tag: 'after-remove',
      removedAt,
      brandOp: getComputedStyle(document.querySelector('.brand-mark')).opacity
    }
    return [mid, landed, after]
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-probe-flight-'))
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
    const rows = JSON.parse(match[1])
    const failures = []
    const start = rows.find((r) => r.tag === 'flight-start')
    const landed = rows.find((r) => r.tag === 'landed')
    const after = rows.find((r) => r.tag === 'after-remove')
    for (const r of rows) console.log(JSON.stringify(r))

    if (!start) { console.error('✗ 没等到飞行启动'); return 1 }
    if (start.brandOp !== '0') failures.push(`飞行期间品牌图标未隐藏（opacity=${start.brandOp}），屏幕上会同时出现两个 Logo`)
    if (!landed) {
      failures.push('没采到落地帧')
    } else {
      if (Math.abs(landed.dx) > 1 || Math.abs(landed.dy) > 1) failures.push(`落点偏差 dx=${landed.dx} dy=${landed.dy}（应 ≤1px）`)
      if (Math.abs(landed.sizeDelta) > 1) failures.push(`落地尺寸差 ${landed.sizeDelta}px（应与品牌位同大）`)
      if (landed.flightMs < 400 || landed.flightMs > 700) failures.push(`飞行时长 ${landed.flightMs}ms（预期约 520ms）`)
      const anims = String(landed.brandAnim || '').split(',').map((s) => s.trim())
      if (!anims.includes('brandIn')) failures.push(`落地后品牌位未播放入场动画（animationName=${landed.brandAnim}）`)
      if (!anims.includes('brandIdle')) failures.push(`常驻呼吸循环未挂载（animationName=${landed.brandAnim}）`)
      if (landed.brandIdleRunning !== true) failures.push(`brandIdle 没有在运行（playState 检查=${landed.brandIdleRunning}）`)
      if (landed.rippleAnim && landed.rippleAnim !== 'none' && landed.rippleAnim !== 'brandRipple') failures.push(`光环动画异常（${landed.rippleAnim}）`)
    }
    if (!after || after.brandOp === '0') failures.push('splash 移除后品牌图标没有恢复可见')

    console.log('--- 结论 ---')
    if (failures.length) {
      for (const f of failures) console.log('✗ ' + f)
      return 1
    }
    console.log('✓ 飞行期间品牌位隐藏，无双 Logo 同屏')
    console.log(`✓ 落点与品牌位中心零偏差（dx=${landed.dx}, dy=${landed.dy}），尺寸一致`)
    console.log(`✓ 飞行 ${landed.flightMs}ms（提速自 780ms）`)
    console.log('✓ 落地播放入场动画 + 常驻呼吸循环 brandIdle 在运行')
    console.log('✓ splash 移除后品牌图标恢复可见')
    return 0
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

main().then((code) => { process.exitCode = code }).catch((err) => {
  console.error(err)
  process.exitCode = 1
})
