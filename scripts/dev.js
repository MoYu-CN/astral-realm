#!/usr/bin/env node
'use strict'

/**
 * 启动器：绕开宿主环境注入的 ELECTRON_RUN_AS_NODE。
 * 在某些 Electron 系终端（VS Code / 各类 AI IDE）里，该变量会让 electron.exe 退化成普通 Node，
 * 导致 require('electron') 拿不到 app 对象。这里在子进程里清掉它。
 */

const { spawn } = require('node:child_process')
const path = require('node:path')

const electronPath = require('electron')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const args = ['.', ...process.argv.slice(2)]
const child = spawn(electronPath, args, {
  stdio: 'inherit',
  env,
  cwd: path.join(__dirname, '..')
})

child.on('exit', (code) => process.exit(code ?? 0))
