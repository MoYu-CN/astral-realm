#!/usr/bin/env node
'use strict'

/* migrate-plugins.js — 外部旧版插件迁移扫描
 *
 * 只做静态扫描与迁移提示，不改写用户插件。
 * 用法：
 *   node scripts/migrate-plugins.js
 *   node scripts/migrate-plugins.js --json
 *   node scripts/migrate-plugins.js --strict   # 发现旧版插件时退出码 1
 *   node scripts/migrate-plugins.js --template
 */

const fs = require('node:fs')
const path = require('node:path')
const { normalizePluginManifest } = require('../electron/plugin-manifest.js')

const ROOT = path.join(__dirname, '..')
const CONFIG_PLUGINS = path.join(ROOT, 'config', 'plugins')
const APP_PLUGINS = path.join(ROOT, 'app', 'plugins')

const MIGRATION_TEMPLATE = `# config/plugins/<id>/plugin.json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "entry": "plugin.js",
  "runtime": "isolated",
  "permissions": ["ui.dock"],
  "author": "你"
}

# config/plugins/<id>/plugin.js
export default function setup (astral) {
  astral.ui.registerDockPane({
    id: 'my-pane',
    label: '我的面板',
    order: 20,
    render (host) {
      host.classList.add('dock-body', 'plugin-pane-mode')
      host.append(astral.h('div', { class: 'dock-empty', text: '已迁移到隔离沙箱' }))
    }
  })
}
`

function readText (file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}

function detectLegacyPatterns (source) {
  const text = String(source || '')
  const flags = []
  if (/^\s*import\s+/m.test(text) || /\brequire\s*\(/.test(text)) flags.push('模块导入')
  if (/from\s+['"][^'"]*js\/(core|modal|plugins|llm)\.js/.test(text)) flags.push('导入主界面模块')
  if (/\bstate\b|astral\.getState|astral\.bus/.test(text)) flags.push('直接使用应用状态')
  if (/window\.Astral/.test(text)) flags.push('window.Astral')
  if (/\bopenModal\b|\bcloseModal\b/.test(text)) flags.push('主界面弹层')
  if (/\bwindow\.Astral\.submit\b/.test(text)) flags.push('window.Astral.submit')
  if (/document\.(querySelector|getElementById|body)|\bwindow\.document\b/.test(text)) flags.push('主界面 DOM')
  return flags
}

function scanPlugin (dir, scope = 'user') {
  const manifestFile = path.join(dir, 'plugin.json')
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  } catch (err) {
    return {
      ok: false,
      dir,
      scope,
      id: path.basename(dir),
      name: path.basename(dir),
      legacy: false,
      error: `plugin.json 读取失败：${err.message}`,
      flags: []
    }
  }
  const manifest = normalizePluginManifest(raw, scope, path.basename(dir))
  const entryFile = path.join(dir, manifest.entry)
  const source = readText(entryFile)
  return {
    ok: true,
    dir,
    scope,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    runtime: manifest.runtime,
    legacy: manifest.runtime !== 'isolated',
    error: manifest.manifestError,
    entry: entryFile,
    flags: detectLegacyPatterns(source)
  }
}

function discoverPlugins () {
  const out = []
  const seen = new Set()
  for (const [dir, scope] of [[CONFIG_PLUGINS, 'user'], [APP_PLUGINS, 'app']]) {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const result = scanPlugin(path.join(dir, entry.name), scope)
      if (!result.ok) { out.push(result); continue }
      if (seen.has(result.id)) continue
      seen.add(result.id)
      out.push(result)
    }
  }
  return out
}

function printReport (items) {
  if (!items.length) {
    console.log('没有发现外部插件。')
    return
  }
  let legacy = 0
  for (const item of items) {
    if (!item.ok) {
      console.log(`✗ ${item.scope} · ${item.id} — ${item.error}`)
      continue
    }
    if (item.legacy) legacy += 1
    const mark = item.legacy ? '旧版' : '隔离'
    console.log(`\n${item.legacy ? '⚠' : '✓'} [${mark}] ${item.name || item.id} (${item.id}) · ${item.scope} · v${item.version}`)
    console.log(`  路径：${path.relative(ROOT, item.dir)}`)
    if (item.error) console.log(`  原因：${item.error}`)
    if (item.flags.length) console.log(`  检测到：${item.flags.join('、')}`)
    if (item.legacy) {
      console.log('  迁移：给 plugin.json 加 "runtime": "isolated"，把主界面 API 换成 astral.*；')
      console.log('        参考 app/docs/plugin-guide.md 与 `node scripts/migrate-plugins.js --template`。')
    }
  }
  console.log(`\n共 ${items.length} 个插件，其中旧版 ${legacy} 个。`)
}

function main () {
  const args = new Set(process.argv.slice(2))
  if (args.has('--template')) {
    process.stdout.write(MIGRATION_TEMPLATE)
    return 0
  }
  const items = discoverPlugins()
  if (args.has('--json')) {
    process.stdout.write(`${JSON.stringify({ plugins: items, legacy: items.filter((item) => item.legacy).length }, null, 2)}\n`)
  } else {
    printReport(items)
  }
  if (args.has('--strict') && items.some((item) => item.legacy)) return 1
  return 0
}

if (require.main === module) {
  process.exitCode = main()
}

module.exports = { scanPlugin, discoverPlugins, detectLegacyPatterns, MIGRATION_TEMPLATE }
