#!/usr/bin/env node
'use strict'

/* smoke-ui.js — 隔离插件 / 知识库 UI 的 Electron 冒烟
 *
 * 在临时目录启动真实 Electron，检查：
 *   - 内置知识库面板正常加载；
 *   - config/plugins 里的外部隔离子系统加载，多 dock 面板都出现；
 *   - 切换知识库 / 插件面板时，插件 surface 有正确尺寸，且 iframe 不重建。
 *
 * 说明：这是 surface/标签级自动化，不模拟 iframe 内部表单点击。
 * 用法：node scripts/smoke-ui.js
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
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    await sleep(3500)
    const tabs = [...document.querySelectorAll('#dock-tabs button')]
    const byPane = (id) => tabs.find((tab) => tab.dataset.pane === id)
    const knowledge = byPane('knowledge:knowledge')
    const p1 = byPane('ui-test:p1')
    const p2 = byPane('ui-test:p2')
    const surface = document.querySelector('.plugin-surface[data-plugin-id="ui-test"]')
    const knowledgeSurface = document.querySelector('.plugin-surface[data-plugin-id="knowledge"]')
    const iframe = surface && surface.querySelector('iframe')
    if (knowledge) knowledge.click()
    await sleep(120)
    const duringSwitch = {
      display: knowledgeSurface ? getComputedStyle(knowledgeSurface).display : 'missing',
      className: knowledgeSurface ? knowledgeSurface.className : ''
    }
    await sleep(800)
    const knowledgeRect = knowledgeSurface ? knowledgeSurface.getBoundingClientRect().toJSON() : null
    const knowledgeActivePane = knowledgeSurface ? knowledgeSurface.dataset.activePane : ''
    const slotRect = document.querySelector('#dock-body .plugin-pane-slot')?.getBoundingClientRect().toJSON() || null
    const tabsRect = document.querySelector('#dock-tabs')?.getBoundingClientRect().toJSON() || null
    if (p1) p1.click()
    await sleep(600)
    const p1Rect = surface ? surface.getBoundingClientRect().toJSON() : null
    if (p2) p2.click()
    await sleep(600)
    const p2Rect = surface ? surface.getBoundingClientRect().toJSON() : null
    return {
      title: document.title,
      tabs: tabs.map((tab) => ({ pane: tab.dataset.pane, label: tab.textContent })),
      knowledgeFound: Boolean(knowledge),
      p1Found: Boolean(p1),
      p2Found: Boolean(p2),
      knowledgeRect,
      knowledgeActivePane,
      duringSwitch,
      slotRect,
      tabsRect,
      p1Rect,
      p2Rect,
      sameIframe: Boolean(iframe && surface && surface.querySelector('iframe') === iframe),
      plugins: (window.Astral?.state?.plugins || []).map((plugin) => ({ id: plugin.id, loaded: plugin.loaded, error: plugin.error }))
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

function parseEval (text) {
  const match = /\[eval\]\s+(\{[\s\S]*\})\s*$/m.exec(text)
  if (!match) return null
  try { return JSON.parse(match[1]) } catch { return null }
}

async function main () {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-ui-'))
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
        knowledge: { enabled: true },
        stardust: { enabled: false }
      },
      app: { closeToTray: false }
    })
    writeJson(path.join(temp, 'config', 'mcp.json'), { version: 1, servers: [] })

    const pluginDir = path.join(temp, 'config', 'plugins', 'ui-test')
    fs.mkdirSync(pluginDir, { recursive: true })
    writeJson(path.join(pluginDir, 'plugin.json'), {
      id: 'ui-test',
      name: 'UI 测试插件',
      version: '1.0.0',
      entry: 'plugin.js',
      runtime: 'isolated',
      permissions: ['ui.dock'],
      defaultEnabled: true
    })
    fs.writeFileSync(path.join(pluginDir, 'plugin.js'), `export default function setup (astral) {
  for (const [id, label] of [['p1', '面板一'], ['p2', '面板二']]) {
    astral.ui.registerDockPane({
      id,
      label,
      order: id === 'p1' ? 20 : 21,
      render (host) {
        host.classList.add('dock-body', 'plugin-pane-mode')
        host.append(astral.h('div', { class: 'dock-empty', text: label + '内容' }))
      }
    })
  }
}
`, 'utf8')

    const run = await runElectron(temp)
    const result = parseEval(run.stderr)
    if (!result) {
      console.error('UI 冒烟失败：没有拿到 eval 结果')
      console.error(run.stderr.split('\n').slice(-20).join('\n'))
      return 1
    }
    const failures = []
    if (result.title !== '星界') failures.push('窗口标题异常')
    if (!result.knowledgeFound) failures.push('知识库面板标签缺失')
    if (!result.p1Found || !result.p2Found) failures.push('多 dock 面板标签缺失')
    if (!result.knowledgeRect || result.knowledgeRect.width < 100) failures.push('知识库 surface 尺寸异常')
    if (!result.duringSwitch || result.duringSwitch.display === 'none') failures.push('切换动画期间知识库 surface 出现了空窗')
    if (result.knowledgeActivePane !== 'knowledge') failures.push('知识库 iframe 内部面板没有显示')
    if (result.tabsRect && result.knowledgeRect && result.knowledgeRect.top < result.tabsRect.bottom) {
      failures.push('知识库 surface 覆盖了 dock 标签栏')
    }
    if (result.slotRect && result.knowledgeRect) {
      const aligned = Math.abs(result.slotRect.top - result.knowledgeRect.top) <= 2 &&
        Math.abs(result.slotRect.left - result.knowledgeRect.left) <= 2 &&
        Math.abs(result.slotRect.width - result.knowledgeRect.width) <= 2 &&
        Math.abs(result.slotRect.height - result.knowledgeRect.height) <= 2
      if (!aligned) failures.push('知识库 surface 没有对齐 dock 插槽')
    }
    if (!result.p1Rect || result.p1Rect.width < 100) failures.push('面板一 surface 尺寸异常')
    if (!result.p2Rect || result.p2Rect.width < 100) failures.push('面板二 surface 尺寸异常')
    if (!result.sameIframe) failures.push('切换面板后 iframe 被重建')
    const ui = (result.plugins || []).find((plugin) => plugin.id === 'ui-test')
    if (!ui || ui.loaded !== true || ui.error) failures.push('外部隔离插件没有正常加载')
    if (failures.length) {
      console.error('UI 冒烟失败：')
      for (const failure of failures) console.error(`  - ${failure}`)
      console.error(JSON.stringify(result))
      return 1
    }
    console.log('UI 冒烟通过：知识库面板、外部隔离插件、多 dock 面板与 iframe 复用均正常')
    return 0
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

main().then((code) => { process.exitCode = code }).catch((err) => {
  console.error(err)
  process.exitCode = 1
})
