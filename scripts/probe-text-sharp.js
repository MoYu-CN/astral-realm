#!/usr/bin/env node
'use strict'

/* probe-text-sharp.js — 量一小块文字的渲染锐度
 *
 * 用法：node scripts/probe-text-sharp.js <图> <x,y,w,h>
 * 输出：亮像素峰值、墨量、平均梯度（边缘锐度）、以及按列切出的文字簇边界。
 * 用来判断「同一段文字」在不同构建里是否被重采样变糊。
 */

const path = require('node:path')
const { app, nativeImage } = require('electron')

const [src, rectArg] = process.argv.slice(2)

app.disableHardwareAcceleration()
app.whenReady().then(() => {
  const [x, y, width, height] = String(rectArg || '0,0,100,40').split(',').map(Number)
  const img = nativeImage.createFromPath(path.resolve(src))
  const crop = img.crop({ x, y, width, height })
  const size = crop.getSize()
  const bmp = crop.toBitmap() // BGRA
  const lum = new Float32Array(size.width * size.height)
  for (let i = 0, p = 0; i < bmp.length; i += 4, p++) {
    lum[p] = 0.114 * bmp[i] + 0.587 * bmp[i + 1] + 0.299 * bmp[i + 2]
  }
  let max = 0
  let ink = 0
  for (let i = 0; i < lum.length; i++) {
    if (lum[i] > max) max = lum[i]
    if (lum[i] > 60) ink++
  }
  /* 梯度：只统计有明显落差的相邻像素，避免背景噪点拉高 */
  let grad = 0
  let edges = 0
  for (let yy = 0; yy < size.height; yy++) {
    for (let xx = 0; xx < size.width - 1; xx++) {
      const d = Math.abs(lum[yy * size.width + xx] - lum[yy * size.width + xx + 1])
      if (d > 12) { grad += d; edges++ }
    }
  }
  /* 列投影：找出文字簇，方便定位同一个字 */
  const cols = new Float32Array(size.width)
  for (let xx = 0; xx < size.width; xx++) {
    let sum = 0
    for (let yy = 0; yy < size.height; yy++) sum += Math.max(0, lum[yy * size.width + xx] - 60)
    cols[xx] = sum
  }
  const clusters = []
  let start = -1
  for (let xx = 0; xx < size.width; xx++) {
    if (cols[xx] > 40 && start < 0) start = xx
    else if (cols[xx] <= 40 && start >= 0) {
      if (xx - start > 2) clusters.push([start, xx - 1])
      start = -1
    }
  }
  if (start >= 0) clusters.push([start, size.width - 1])

  const out = {
    size: size.width + 'x' + size.height,
    maxLum: Number(max.toFixed(1)),
    inkPixels: ink,
    edgeAvg: edges ? Number((grad / edges).toFixed(1)) : 0,
    edgeCount: edges,
    spread: edges ? Number((grad / size.width / size.height).toFixed(2)) : 0,
    clusters: clusters.slice(0, 24).map((c) => `${c[0]}-${c[1]}`)
  }
  console.log('[sharp] ' + JSON.stringify(out))
  app.exit(0)
})
