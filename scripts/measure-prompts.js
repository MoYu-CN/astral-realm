#!/usr/bin/env node
'use strict'

/* measure-prompts.js — 量出默认提示词的实际字符数，防止精简后又悄悄膨胀
 * 用法：node scripts/measure-prompts.js
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const llm = fs.readFileSync(path.join(ROOT, 'app', 'js', 'llm.js'), 'utf8')
const orch = fs.readFileSync(path.join(ROOT, 'app', 'js', 'orchestrator.js'), 'utf8')

function arrayConst (src, name) {
  const re = new RegExp('(?:export )?const ' + name + " = (\\[[\\s\\S]*?\\])\\.join\\('\\\\n'\\)")
  const m = re.exec(src)
  if (!m) return null
  try { return new Function('return ' + m[1])().join('\n') } catch { return null }
}

function objectConst (src, name) {
  const re = new RegExp('(?:export )?const ' + name + ' = (\\{[\\s\\S]*?\\n\\})')
  const m = re.exec(src)
  if (!m) return null
  try { return JSON.stringify(new Function('return ' + m[1])()) } catch { return null }
}

const rows = [
  ['CORE_PROMPT', arrayConst(llm, 'CORE_PROMPT')],
  ['ROLE_BRIEF', objectConst(llm, 'ROLE_BRIEF')],
  ['PLUGIN_MODE_PROMPT', arrayConst(llm, 'PLUGIN_MODE_PROMPT')],
  ['THINK_HINT', objectConst(llm, 'THINK_HINT')],
  ['SOLO_PROMPT', arrayConst(orch, 'SOLO_PROMPT')]
]

let total = 0
for (const [name, text] of rows) {
  const n = text ? text.length : 0
  total += n
  console.log(`${name.padEnd(20)} ${String(n).padStart(5)} 字符`)
}
let skillTotal = 0
for (const f of fs.readdirSync(path.join(ROOT, 'app', 'skills')).filter((x) => x.endsWith('.md'))) {
  skillTotal += fs.readFileSync(path.join(ROOT, 'app', 'skills', f), 'utf8').length
}
console.log(`${'技能 md 合计'.padEnd(20)} ${String(skillTotal).padStart(5)} 字符`)
console.log(`${'合计'.padEnd(20)} ${String(total + skillTotal).padStart(5)} 字符`)
