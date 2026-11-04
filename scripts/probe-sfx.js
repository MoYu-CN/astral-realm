#!/usr/bin/env node
'use strict'

/* probe-sfx.js — 音效自检：离线渲染每个音色 + 核对启动组曲调度与音频上下文状态 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const TIMEOUT = 120000

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
      if (window.Astral && window.Astral.sfx) { ready = true; break }
      await sleep(300)
    }
    if (!ready) return { ok: false, error: 'not-ready' }
    const d = Astral.sfx.debug()
    const times = d.scheduled.map((s) => s.at)
    const spanMs = times.length ? times[times.length - 1] - times[0] : 0
    const out = []
    for (const name of d.names) {
      const r = await Astral.sfx.renderOffline(name)
      out.push({
        name,
        rms: r ? r.rms : 0,
        peak: r ? r.peak : 0,
        attackMs: r ? r.attackMs : 0,
        tailMs: r ? r.tailMs : 0,
        zcr: r ? r.zcr : 0,
        hf: r ? r.hf : 0
      })
    }
    const before = Astral.sfx.debug().scheduled.length
    Astral.sfx.play('waypoint1')
    const afterPlay = Astral.sfx.debug().scheduled.length
    Astral.sfx.setConfig({ enabled: false })
    const mutedRejected = Astral.sfx.play('merge') === false
    Astral.sfx.setConfig({ enabled: true })
    Astral.sfx.setConfig({ startup: false })
    const startupMuted = Astral.sfx.playStartup('merge') === false
    Astral.sfx.setConfig({ startup: true })
    let sfxUi = false
    try {
      Astral.openSettings('appearance')
      await sleep(500)
      const t = document.body.textContent
      sfxUi = t.includes('程序化音效') && t.includes('第一声')
    } catch { sfxUi = false }
    return {
      ok: true,
      ctxState: d.ctxState,
      config: d.config,
      scheduled: d.scheduled.map((s) => s.name),
      spanMs,
      out,
      uiHooked: afterPlay === before + 1,
      mutedRejected,
      startupMuted,
      sfxUi
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-probe-sfx-'))
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
      app: { closeToTray: false },
      bridge: { enabled: false, port: 45871, token: '' },
      sfx: { enabled: true, startup: true, volume: 0.5 }
    })
    writeJson(path.join(temp, 'config', 'mcp.json'), { version: 1, servers: [] })

    const run = await runElectron(temp)
    const match = /\[eval\]\s+(\{[\s\S]*\})\s*$/m.exec(run.stderr)
    if (!match) {
      console.error('探针失败：未拿到 eval 结果')
      console.error(run.stderr.split('\n').slice(-16).join('\n'))
      return 1
    }
    const r = JSON.parse(match[1])
    if (!r.ok) { console.error('探针失败：' + r.error); return 1 }

    const failures = []
    console.log('--- 音频上下文 ---')
    console.log(JSON.stringify({ ctxState: r.ctxState, config: r.config }))
    if (r.ctxState !== 'running') failures.push(`AudioContext 未运行：${r.ctxState}（自动播放限制未解除）`)
    if (!r.config.enabled || !r.config.startup) failures.push('音效默认配置未启用')

    console.log('--- 三个音色（起音 / 余韵 / 亮度）---')
    if (r.out.length !== 3) failures.push(`音色应只有 3 个，实际 ${r.out.length}`)
    for (const o of r.out) {
      console.log(`  ${o.name.padEnd(12)} rms=${o.rms.toFixed(5)} peak=${o.peak.toFixed(4)} attack=${o.attackMs.toFixed(1)}ms tail=${o.tailMs.toFixed(0)}ms zcr=${o.zcr.toFixed(0)} hf=${o.hf.toFixed(3)}`)
      if (!(o.rms > 0.0003)) failures.push(`${o.name} 没有可听波形（rms=${o.rms}）`)
      if (!(o.peak > 0.01)) failures.push(`${o.name} 峰值过低（peak=${o.peak}）`)
      if (!(o.peak < 1.5)) failures.push(`${o.name} 可能削波（peak=${o.peak}）`)
      if (!(o.attackMs < 12)) failures.push(`${o.name} 起音太慢（${o.attackMs.toFixed(1)}ms），不够清脆`)
      if (!(o.hf > 0.01)) failures.push(`${o.name} 高频不足（hf=${o.hf.toFixed(3)}），偏闷`)
    }
    for (const key of ['waypoint1', 'waypoint2', 'merge']) {
      const o = r.out.find((x) => x.name === key)
      if (o && !(o.tailMs > 200)) failures.push(`${key} 缺少铃铛余韵（tail=${o.tailMs.toFixed(0)}ms）`)
    }

    console.log('--- 启动过程实际响了几声 ---')
    console.log(JSON.stringify(r.scheduled))
    const expected = ['waypoint1', 'waypoint2', 'merge']
    if (JSON.stringify(r.scheduled) !== JSON.stringify(expected)) {
      failures.push(`启动应恰好三声，实际 ${JSON.stringify(r.scheduled)}`)
    }
    console.log(`三声跨度 ${r.spanMs}ms（收场在约 3800ms，之后不应再有声音）`)
    if (!(r.spanMs < 1500)) failures.push(`第三声不在彗星航程内，或收场又响了（跨度 ${r.spanMs}ms）`)
    console.log('--- 接线 ---')
    console.log(JSON.stringify({ playHooked: r.uiHooked, mutedRejected: r.mutedRejected, startupMuted: r.startupMuted, sfxUi: r.sfxUi }))
    if (!r.uiHooked) failures.push('play() 未记录调度')
    if (!r.mutedRejected) failures.push('关闭总开关后仍能播放')
    if (!r.startupMuted) failures.push('关闭启动动画开关后仍能播放收场音')
    if (!r.sfxUi) failures.push('设置 → 外观 未渲染音效区')

    if (failures.length) {
      console.log('--- 结论 ---')
      for (const f of failures) console.log('✗ ' + f)
      return 1
    }
    console.log('--- 结论 ---')
    console.log('✓ 只有 3 个音色，全部清脆快起音、有铃铛余韵、无削波')
    console.log('✓ 启动恰好三声：导航星① → 导航星② → 第三颗星（Logo 落点）')
    console.log('✓ 收场把 Logo 送到左上角时完全安静')
    console.log('✓ 无用户手势时 AudioContext 已 running；静音开关与设置页正常')
    return 0
  } finally {
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5 }) } catch { /* Windows 下可能 EBUSY */ }
  }
}

main().then((code) => { process.exitCode = code }).catch((err) => {
  console.error(err)
  process.exitCode = 1
})
