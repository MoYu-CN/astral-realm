#!/usr/bin/env node
'use strict'

/**
 * 打绿色版：把 Electron 运行时 + 源码组装成可直接双击的目录。
 * 不做安装包、不做签名，产物体积≈Electron 运行时本体。
 *
 * 用法：
 *   npm run pack          打包，并保留现有 dist/星界-win32-x64/config
 *   npm run pack -- --fresh  丢弃现有便携配置，打一份干净产物
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const NAME = '星界'
const DIST_ROOT = path.join(ROOT, 'dist')
const OUT = path.join(DIST_ROOT, `${NAME}-win32-x64`)
const BUILD = path.join(DIST_ROOT, 'astral-build')
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist')
const FRESH = process.argv.includes('--fresh')

if (!fs.existsSync(ELECTRON_DIST)) {
  console.error('找不到 electron 运行时，先执行 npm install')
  process.exit(1)
}

/* dist/星界-win32-x64/config 是便携版的真实数据。
   打包会先删 dist，所以要在删除前把它复制到系统临时目录，打完后原样放回。
   备份失败就中止，绝不带着「以为备份过」的状态继续删。 */
const LIVE_CONFIG = path.join(OUT, 'config')
let configBackup = ''
let backupRoot = ''
if (!FRESH && fs.existsSync(LIVE_CONFIG)) {
  backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-pack-config-'))
  configBackup = path.join(backupRoot, 'config')
  try {
    fs.cpSync(LIVE_CONFIG, configBackup, { recursive: true })
  } catch (err) {
    console.error(`便携配置备份失败：${err.message}`)
    console.error('已中止打包，dist 未被删除。')
    process.exit(1)
  }
  console.log(`保留便携配置 → ${backupRoot}`)
}

/* 注意：Windows 上 fs.cpSync 的目标路径含非 ASCII 字符会抛 ENOENT，
   所以先组装到 ASCII 目录，最后整体改名。 */
console.log('清理旧产物…')
fs.rmSync(DIST_ROOT, { recursive: true, force: true })
fs.mkdirSync(BUILD, { recursive: true })

const copy = (src, dest, label) => {
  try {
    fs.cpSync(src, dest, { recursive: true })
  } catch (err) {
    console.error(`复制失败（${label}）：${err.code} ${err.message}`)
    process.exit(1)
  }
}

console.log('复制 Electron 运行时…')
copy(ELECTRON_DIST, BUILD, 'electron dist')

const exe = path.join(BUILD, 'electron.exe')
if (fs.existsSync(exe)) fs.renameSync(exe, path.join(BUILD, `${NAME}.exe`))

/* 把品牌图标写进 PE 资源；只设置窗口图标是不够的，
   资源管理器/任务栏/快捷方式读取的是 exe 内嵌图标。 */
const finalExe = path.join(BUILD, `${NAME}.exe`)
const iconFile = path.join(ROOT, 'build', 'icon.ico')
const rcedit = path.join(ROOT, 'scripts', 'tools', 'rcedit-x64.exe')
if (fs.existsSync(iconFile) && fs.existsSync(rcedit)) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  console.log('写入应用程序图标与版本信息…')
  try {
    execFileSync(rcedit, [
      finalExe,
      '--set-icon', iconFile,
      '--set-file-version', pkg.version || '0.1.0',
      '--set-product-version', pkg.version || '0.1.0',
      '--set-version-string', 'ProductName', NAME,
      '--set-version-string', 'FileDescription', '星界 Astral Realm',
      '--set-version-string', 'CompanyName', 'Astral Realm',
      '--set-version-string', 'LegalCopyright', 'MIT'
    ], { stdio: 'inherit', windowsHide: true })
  } catch (err) {
    console.error(`写入 exe 图标失败：${err.message}`)
    process.exit(1)
  }
} else {
  console.warn('跳过 exe 图标：缺少 build/icon.ico 或 rcedit（先执行 npm install）')
}

console.log('复制应用源码…')
const appDir = path.join(BUILD, 'resources', 'app')
fs.mkdirSync(appDir, { recursive: true })
for (const item of ['app', 'electron', 'package.json', 'README.md', 'docs']) {
  const src = path.join(ROOT, item)
  if (!fs.existsSync(src)) continue
  copy(src, path.join(appDir, item), item)
}

console.log('写入便携标记与说明…')
fs.writeFileSync(
  path.join(BUILD, 'portable.flag'),
  '存在此文件时，星界以便携模式运行：配置写在同目录的 config/ 下，整包可拷走。\n',
  'utf8'
)

fs.writeFileSync(
  path.join(BUILD, '使用说明.txt'),
  [
    '星界 Astral Realm',
    '',
    '启动：双击 星界.exe',
    '首次启动会在本目录生成 config/，所有配置都是明文 JSON，可直接编辑。',
    '',
    '第一次使用：',
    '  1. 点左下「设置」→ 模型供应商',
    '  2. 选一家（DeepSeek / OpenAI 兼容 / Anthropic / 本地 Ollama），填 API Key',
    '  3. 点「测试」确认连通，关掉设置，直接下达指令',
    '',
    '想让别的 AI 操作星界：',
    '  设置 → 外部接口 → 复制 MCP 配置，粘到 Claude Desktop 之类的客户端里。',
    '',
    '改界面：',
    '  config/themes/ 放一个主题 JSON 就多一套皮肤；',
    '  config/skills/ 放一个 .md 就多一个技能；',
    '  config/plugins/ 放一个目录就多一个插件；',
    '  config/custom.css 会被自动加载，用来做最后的视觉微调。',
    '',
    '删掉 portable.flag 则改为把配置存到系统用户目录。',
    ''
  ].join('\n'),
  'utf8'
)

console.log('改名为最终目录…')
fs.renameSync(BUILD, OUT)

if (configBackup) {
  try {
    fs.cpSync(configBackup, path.join(OUT, 'config'), { recursive: true })
    fs.rmSync(backupRoot, { recursive: true, force: true })
    console.log('便携配置已还原到新产物')
  } catch (err) {
    console.error(`便携配置还原失败：${err.message}`)
    console.error(`备份仍在：${backupRoot}`)
    console.error('请手动把备份里的 config 复制到 dist/星界-win32-x64/config，不要直接删备份。')
    process.exit(1)
  }
}

let size = 0
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else size += fs.statSync(full).size
  }
}
walk(OUT)

console.log('')
console.log(`完成：${OUT}`)
console.log(`体积：${(size / 1024 / 1024).toFixed(0)} MB`)
console.log(`启动：${path.join(OUT, `${NAME}.exe`)}`)
