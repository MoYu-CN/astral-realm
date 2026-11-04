#!/usr/bin/env node
'use strict'

/* crop-image.js — 裁一块图并按倍数放大，用于肉眼核对小字号 / 细节渲染
 *
 * 用法：node scripts/crop-image.js <源图> <输出> <x,y,w,h> [放大倍数]
 * 走 Electron 的 nativeImage，不引入额外图像库。
 */

const fs = require('node:fs')
const path = require('node:path')
const { app, nativeImage } = require('electron')

const [src, out, rectArg, scaleArg] = process.argv.slice(2)

app.disableHardwareAcceleration()
app.whenReady().then(() => {
  const [x, y, width, height] = String(rectArg || '0,0,100,100').split(',').map(Number)
  const scale = Math.max(1, Number(scaleArg) || 3)
  const img = nativeImage.createFromPath(path.resolve(src))
  if (img.isEmpty()) {
    console.error('[crop] 读不到图片：' + src)
    app.exit(1)
    return
  }
  const scaled = img.crop({ x, y, width, height }).resize({
    width: Math.round(width * scale),
    height: Math.round(height * scale),
    quality: 'good'
  })
  fs.writeFileSync(path.resolve(out), scaled.toPNG())
  console.log(`[crop] ${width}x${height} @${scale}x -> ${out}`)
  app.exit(0)
})
