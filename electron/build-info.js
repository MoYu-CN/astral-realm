'use strict'

/* build-info.js — 判断当前运行的进程是否落后于磁盘上的构建。
 *
 * 这是解决「已经改了构建文件，但双击 exe 只把旧窗口叫到前台」的常见问题：
 * 主进程启动时记录时间，second-instance 时对比 app 文件 mtime；如果磁盘文件更新，
 * 提示用户完全重启，而不是继续使用内存里的旧渲染代码。
 */

const fs = require('node:fs')
const path = require('node:path')

const BUILD_FILES = [
  'js/main.js',
  'js/chat.js',
  'js/mcp.js',
  'js/ask.js',
  'js/ask-spec.js',
  'js/orchestrator.js',
  'js/fold-state.js',
  'index.html',
  'css/app.css'
]

function latestFile (appDir, files = BUILD_FILES) {
  let latest = null
  for (const relative of files) {
    try {
      const stat = fs.statSync(path.join(appDir, relative))
      if (!latest || stat.mtimeMs > latest.mtimeMs) {
        latest = { file: relative, mtimeMs: stat.mtimeMs }
      }
    } catch { /* 文件不存在时跳过；打包结构可能裁剪 */ }
  }
  return latest
}

function buildInfo ({ appDir, startedAt, version = '', files = BUILD_FILES } = {}) {
  const latest = latestFile(appDir, files)
  const started = Number(startedAt) || 0
  /* 给启动读取文件本身留出余量，避免把启动瞬间的 mtime 误判成更新。 */
  const stale = Boolean(latest && started && latest.mtimeMs > started + 1500)
  return {
    version: String(version || ''),
    startedAt: started,
    latestAt: latest ? latest.mtimeMs : 0,
    latestFile: latest ? latest.file : '',
    stale,
    files: files.slice()
  }
}

module.exports = { buildInfo, latestFile, BUILD_FILES }
