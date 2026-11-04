#!/usr/bin/env node
'use strict'

/* smoke-fold.js — 消息手动折叠 + 工具归属的 Electron 冒烟
 *
 * 验证：
 *   - 最近三条非工具消息默认展开，仍显示折叠开关；
 *   - 第 4 条及更早消息默认折叠，可手动展开/折叠；
 *   - 工具调用归到上一条对话消息下面，不单独出现折叠开关；
 *   - 折叠父消息时工具一起隐藏，展开父消息时一起显示；
 *   - 新消息到达时离开最近三条的消息自动收起，手动状态保持；
 *   - 滚动不再触发动态折叠。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const TIMEOUT = 90000

function writeJson (file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

function evalScript () {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    await sleep(3000)
    const state = window.Astral.state
    state.activeAgentId = 'commander'
    state.view = 'user'
    state.messages = [
      { id: 'm0', ts: Date.now(), thread: 'commander', channel: 'user', kind: 'user', text: '第一条用户消息。第二句。', summary: '第一条用户消息' },
      { id: 'm1', ts: Date.now() + 1, thread: 'commander', channel: 'user', kind: 'agent', agentId: 'commander', name: '星枢', depth: 0, text: '第一条回答。它带着两个工具调用。', summary: '第一条回答' },
      { id: 't1', ts: Date.now() + 2, thread: 'commander', channel: 'user', kind: 'tool', toolLabel: '读取文件', ok: true, args: '{}', detail: '读取成功' },
      { id: 't2', ts: Date.now() + 3, thread: 'commander', channel: 'user', kind: 'tool', toolLabel: '搜索资料', ok: false, args: '{}', detail: '搜索失败' },
      { id: 'm2', ts: Date.now() + 4, thread: 'commander', channel: 'user', kind: 'user', text: '第二条用户消息。第二句。', summary: '第二条用户消息' },
      { id: 'm3', ts: Date.now() + 5, thread: 'commander', channel: 'user', kind: 'agent', agentId: 'commander', name: '星枢', depth: 0, text: '最新回答。', summary: '最新回答' }
    ]
    window.Astral.bus.emit('messages:reload')
    await sleep(500)

    const stream = document.querySelector('#stream')
    const direct = () => [...document.querySelectorAll('#stream > .msg')]
    const tools = () => [...document.querySelectorAll('#stream .msg-tools > .msg')]
    const nodeOf = (id) => document.querySelector('#stream > .msg[data-id="' + id + '"]')
    const visibleToggle = (node) => {
      const toggle = node && node.querySelector('.msg-fold-toggle')
      return Boolean(toggle && !toggle.hidden && getComputedStyle(toggle).display !== 'none')
    }
    const visibleBar = (node) => {
      const bar = node && node.querySelector('.msg-fold-bar')
      return Boolean(bar && getComputedStyle(bar).display !== 'none')
    }
    const parent = nodeOf('m1')
    const box = parent.querySelector(':scope > .msg-tools')
    const older = nodeOf('m0')
    const initial = {
      direct: direct().length,
      tools: tools().length,
      folded: direct().map((node) => node.classList.contains('folded')),
      visibleToggles: direct().filter(visibleToggle).length,
      visibleBars: direct().filter(visibleBar).length,
      toolToggles: tools().filter((node) => node.querySelector('.msg-fold-toggle')).length,
      toolBars: tools().filter((node) => node.querySelector('.msg-fold-bar')).length,
      boxCount: box ? box.children.length : 0,
      boxDisplay: box ? getComputedStyle(box).display : '',
      identities: direct().map((node) => ({
        name: node.querySelector('.msg-fold-name')?.textContent || '',
        avatar: Boolean(node.querySelector('.msg-fold-avatar'))
      }))
    }

    /* 第 4 条旧消息可以手动展开；最近三条也保留折叠开关。 */
    older.querySelector('.msg-fold-bar').click()
    await sleep(250)
    const expanded = {
      olderFolded: older.classList.contains('folded'),
      boxDisplay: getComputedStyle(box).display,
      toolHeight: Math.round(tools()[0].getBoundingClientRect().height)
    }

    /* 新工具应挂到最新对话消息下，不新增独立折叠单元。 */
    const newTool = { id: 't3', ts: Date.now() + 10, thread: 'commander', channel: 'user', kind: 'tool', toolLabel: '新工具', ok: true, args: '{}', detail: 'ok' }
    state.messages.push(newTool)
    window.Astral.bus.emit('message:add', newTool)
    await sleep(300)
    const latestParent = nodeOf('m3')
    const latestBox = latestParent.querySelector(':scope > .msg-tools')
    const afterTool = {
      direct: direct().length,
      tools: tools().length,
      visibleToggles: direct().filter(visibleToggle).length,
      latestParentFolded: latestParent.classList.contains('folded'),
      latestToolCount: latestBox ? latestBox.children.length : 0,
      newToolHasToggle: Boolean(document.querySelector('.msg[data-id="t3"] .msg-fold-toggle'))
    }

    /* 新对话消息到达：最新三条变成 m2/m3/m4，m1 自动折叠；m3 仍在最近三条。 */
    const newMsg = { id: 'm4', ts: Date.now() + 11, thread: 'commander', channel: 'user', kind: 'user', text: '最新用户消息。', summary: '最新用户消息' }
    state.messages.push(newMsg)
    window.Astral.bus.emit('message:add', newMsg)
    await sleep(300)
    const afterMessage = {
      direct: direct().length,
      latestOldFolded: latestParent.classList.contains('folded'),
      latestToolsDisplay: latestBox ? getComputedStyle(latestBox).display : '',
      m1Folded: parent.classList.contains('folded'),
      olderStillExpanded: !older.classList.contains('folded'),
      newLatestExpanded: !nodeOf('m4').classList.contains('folded'),
      newestToggleVisible: visibleToggle(nodeOf('m4'))
    }

    /* 最新三条默认展开，但允许用户手动折叠并再次展开。 */
    const newest = nodeOf('m4')
    const newestToggle = newest.querySelector('.msg-fold-toggle')
    newestToggle.click()
    await sleep(150)
    const newestFolded = newest.classList.contains('folded')
    newestToggle.click()
    await sleep(150)
    const newestExpanded = !newest.classList.contains('folded')

    /* 离开锁定区的 m1 可以重新手动展开和折叠。 */
    const m1Toggle = parent.querySelector('.msg-fold-toggle')
    m1Toggle.click()
    await sleep(150)
    const m1Expanded = !parent.classList.contains('folded') && getComputedStyle(box).display !== 'none'
    m1Toggle.click()
    await sleep(150)
    const m1Folded = parent.classList.contains('folded') && getComputedStyle(box).display === 'none'

    const beforeScroll = direct().filter((node) => node.classList.contains('folded')).length
    stream.scrollTop = 0
    stream.dispatchEvent(new Event('scroll'))
    await sleep(300)
    stream.scrollTop = 300
    stream.dispatchEvent(new Event('scroll'))
    await sleep(300)
    const afterScroll = direct().filter((node) => node.classList.contains('folded')).length

    return {
      initial,
      expanded,
      afterTool,
      afterMessage,
      newestFolded,
      newestExpanded,
      m1Expanded,
      m1Folded,
      scrollFoldDelta: afterScroll - beforeScroll
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-fold-'))
  try {
    fs.cpSync(path.join(ROOT, 'app'), path.join(temp, 'app'), { recursive: true })
    fs.cpSync(path.join(ROOT, 'electron'), path.join(temp, 'electron'), { recursive: true })
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
    const result = parseEval(run.stderr)
    if (!result) {
      console.error('手动折叠冒烟失败：没有拿到 eval 结果')
      console.error(run.stderr.split('\n').slice(-20).join('\n'))
      return 1
    }
    const failures = []
    const initial = result.initial
    if (initial.direct !== 4) failures.push('对话消息数量不正确')
    if (initial.tools !== 2) failures.push('工具消息没有归入对话消息')
    if (JSON.stringify(initial.folded) !== JSON.stringify([true, false, false, false])) failures.push('最近三条没有保持展开或旧消息没有折叠')
    if (initial.visibleToggles !== 4 || initial.visibleBars !== 1) failures.push('折叠开关数量不正确')
    if (initial.toolToggles !== 0 || initial.toolBars !== 0) failures.push('工具消息仍然单独折叠')
    if (initial.boxCount !== 2) failures.push('工具没有挂到对应对话消息下')
    if (initial.boxDisplay === 'none') failures.push('最近第三条的父消息被折叠，工具不可见')
    if (initial.identities[1].name !== '星枢' || !initial.identities[1].avatar) failures.push('折叠行没有保留发送者头像和名称')
    if (result.expanded.olderFolded) failures.push('第 4 条旧消息手动展开失败')
    if (result.expanded.boxDisplay === 'none') failures.push('最近消息的工具被错误隐藏')
    if (result.afterTool.direct !== 4) failures.push('新工具被当成了独立对话消息')
    if (result.afterTool.latestToolCount !== 1) failures.push('新工具没有归到最新对话消息下')
    if (result.afterTool.newToolHasToggle) failures.push('新工具仍然带独立折叠开关')
    if (result.afterTool.latestParentFolded) failures.push('新增工具导致父消息被折叠')
    if (result.afterMessage.latestOldFolded) failures.push('最近三条中的 m3 被错误折叠')
    if (result.afterMessage.latestToolsDisplay === 'none') failures.push('最近三条中的工具被错误隐藏')
    if (!result.afterMessage.m1Folded) failures.push('离开最近三条的消息没有自动折叠')
    if (!result.afterMessage.olderStillExpanded) failures.push('手动展开的旧消息被新消息错误收起')
    if (!result.afterMessage.newLatestExpanded) failures.push('新消息没有默认展开')
    if (!result.afterMessage.newestToggleVisible) failures.push('最近三条没有显示折叠开关')
    if (!result.newestFolded) failures.push('最近三条无法手动折叠')
    if (!result.newestExpanded) failures.push('最近三条无法重新手动展开')
    if (!result.m1Expanded) failures.push('离开最近三条后无法手动展开')
    if (!result.m1Folded) failures.push('离开最近三条后无法手动折叠')
    if (result.scrollFoldDelta !== 0) failures.push('滚动仍然触发了动态折叠')


    if (failures.length) {
      console.error('手动折叠冒烟失败：')
      for (const failure of failures) console.error(`  - ${failure}`)
      console.error(JSON.stringify(result))
      return 1
    }
    console.log('手动折叠冒烟通过：最近三条默认展开且可手动折叠、第 4 条起默认折叠、滚动不再折叠')
    return 0
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

main().then((code) => { process.exitCode = code }).catch((err) => {
  console.error(err)
  process.exitCode = 1
})
