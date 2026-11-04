#!/usr/bin/env node
'use strict'

/* shot-themes.js — 全主题截图
 *
 * 每个主题起一次真实 Electron：SHOT_JS 切换主题（或打开外观页）后截图，
 * 用来肉眼验收主题质量，尤其是浅色主题的白点/白边是否都翻过来了。
 *
 * 用法：node scripts/shot-themes.js [输出目录]
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const TIMEOUT = 60000

/* boot 完成（window.Astral 出现）约需 7s，且 boot 结束时会 applyTheme 一次，
   所以 SHOT_JS 返回 Promise：先轮询等 Astral，再切主题，最后留出过渡时间 */
const WAIT_READY = `
  const waitReady = async () => {
    for (let i = 0; i < 90; i++) {
      if (window.Astral && Array.isArray(Astral.state.themes) && Astral.state.themes.length) return true
      await new Promise((r) => setTimeout(r, 200))
    }
    return false
  }
`

const SHOTS = [
  ...['astral', 'ember', 'daybreak', 'apricot', 'skyline'].map((id) => ({
    label: `theme-${id}`,
    js: `(async () => {
      ${WAIT_READY}
      if (!await waitReady()) return 'not-ready'
      const t = Astral.state.themes.find((x) => x.id === '${id}')
      if (!t) return 'missing:${id}'
      Astral.state.settings.theme = t.id
      Astral.applyTheme(t, Astral.state.settings)
      await new Promise((r) => setTimeout(r, 700))
      return t.id
    })()`
  })),
  {
    label: 'theme-cards',
    js: `(async () => {
      ${WAIT_READY}
      if (!await waitReady()) return 'not-ready'
      Astral.openSettings('appearance')
      await new Promise((r) => setTimeout(r, 1600))
      /* 这个环境里合成动画不推进，入场动画会卡在 0%（opacity:0），
         截图前把所有动画一次性推到终点 */
      document.getAnimations().forEach((a) => { try { a.finish() } catch (e) {} })
      await new Promise((r) => setTimeout(r, 400))
      return 'cards'
    })()`
  },
  /* 正文排版探针：往空会话里塞一段示例正文，检查气泡/行内代码/代码块/表格在浅底上的可读性 */
  ...['daybreak', 'apricot'].map((id) => ({
    label: `theme-${id}-md`,
    js: `(async () => {
      ${WAIT_READY}
      if (!await waitReady()) return 'not-ready'
      const t = Astral.state.themes.find((x) => x.id === '${id}')
      Astral.state.settings.theme = t.id
      Astral.applyTheme(t, Astral.state.settings)
      await new Promise((r) => setTimeout(r, 600))
      const stream = document.querySelector('#stream')
      if (!stream) return 'no-stream'
      /* 会话区是状态驱动渲染的，直接插节点会被下一次渲染清掉；
         这里用一个浮层承载同样的类名，只验证排版配色 */
      const panel = document.createElement('div')
      panel.style.cssText = 'position:fixed;left:360px;top:70px;width:620px;max-height:520px;overflow:auto;padding:16px 20px;z-index:60;background:var(--bg-1);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow-lg);color:var(--fg-0)'
      panel.className = 'md'
      panel.innerHTML = \`
        <h2>配置说明</h2>
        <p>把 <code>baseURL</code> 指向本地端口即可，其余字段保持默认。参考 <a href="#">供应商文档</a>。</p>
        <pre><code>{
  "provider": "local",
  "baseURL": "http://127.0.0.1:45999/v1",
  "model": "deepseek-chat"
}</code></pre>
        <blockquote>本地模型不需要 API Key，但流式输出要确认网关没有做缓冲。</blockquote>
        <table><thead><tr><th>字段</th><th>作用</th></tr></thead>
        <tbody><tr><td>provider</td><td>选择供应商类型</td></tr>
        <tr><td>baseURL</td><td>兼容 OpenAI 协议的入口</td></tr></tbody></table>\`
      document.body.append(panel)
      const userBubble = document.createElement('div')
      userBubble.style.cssText = 'position:fixed;left:360px;top:610px;z-index:60'
      userBubble.innerHTML = '<div class="bubble"><div class="user-text">帮我把这段配置改成本地模型，顺便解释下每个字段。</div></div>'
      document.body.append(userBubble)
      await new Promise((r) => setTimeout(r, 400))
      return 'md:${id}'
    })()`
  }))
]

function copyDir (src, dest) {
  fs.cpSync(src, dest, { recursive: true })
}

function writeJson (file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

function runElectron (dir, shotPath, js) {
  return new Promise((resolve) => {
    const electronPath = require('electron')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    env.ASTRAL_SHOT = shotPath
    env.ASTRAL_SHOT_JS = js
    env.ASTRAL_SHOT_JS_WAIT = '1200'
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
  const outDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'astral-theme-shots'))
  fs.mkdirSync(outDir, { recursive: true })
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-themes-'))
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
    /* 可选第三个参数：只截名字里含该关键字的几张（调试单张时省时间） */
    const only = process.argv[3] || ''
    for (const shot of SHOTS) {
      if (only && !shot.label.includes(only)) continue
      const shotPath = path.join(outDir, `${shot.label}.png`)
      const run = await runElectron(temp, shotPath, shot.js)
      const ok = /\[shot\]/.test(run.stderr) && fs.existsSync(shotPath) && fs.statSync(shotPath).size > 4000
      if (ok) console.log(`✓ ${shot.label}`)
      else {
        failures++
        console.error(`✗ ${shot.label}：未截图`)
        console.error(run.stderr.split('\n').slice(-8).join('\n'))
      }
    }
    if (failures) {
      console.error(`主题截图失败 ${failures} 处`)
      return 1
    }
    console.log(`主题截图完成：${outDir}`)
    return 0
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

main().then((code) => { process.exitCode = code }).catch((err) => {
  console.error(err)
  process.exitCode = 1
})
