/* rich-markdown.js — 消息区的表格、可复制代码块和轻量流程图渲染
 *
 * 不引入外部依赖：
 *   - Markdown 表格由 core.md 生成；
 *   - 代码块加上语言标签和复制按钮；
 *   - ```mermaid / ```diagram 的常用 graph/flowchart 子集渲染成 SVG。
 * 复杂 Mermaid 语法解析失败时保留为可复制代码块，不吞内容。
 */

import { h, copyText, toast } from './core.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
let diagramSeq = 0

function svgEl (tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue
    el.setAttribute(key, String(value))
  }
  return el
}

function isDiagramLang (lang) {
  return /^(mermaid|diagram|flowchart)$/i.test(String(lang || '').trim())
}

function copyButton (text, label = '复制') {
  return h('button', {
    class: 'md-copy',
    type: 'button',
    title: label,
    onclick: async () => {
      const ok = await copyText(text)
      toast(ok ? '已复制' : '复制失败', ok ? 'ok' : 'err')
    }
  }, label)
}

function parseNode (raw) {
  let token = String(raw || '').trim().replace(/;+$/, '')
  if (!token) return null
  const match = /^([A-Za-z0-9_-]+)\s*(?:\(\(([\s\S]*?)\)\)|\(([\s\S]*?)\)|\[([\s\S]*?)\]|\{([\s\S]*?)\}|>([\s\S]*?)\])?$/.exec(token)
  if (!match) return null
  let label = match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? ''
  label = String(label).trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim()
  return { id: match[1], label: label || match[1] }
}

export function parseFlowchart (source) {
  const nodes = new Map()
  const edges = []
  let direction = 'TB'
  let pending = ''
  let edgeLabel = ''

  const addNode = (node) => {
    if (!node) return
    const current = nodes.get(node.id)
    if (!current) nodes.set(node.id, { id: node.id, label: node.label })
    else if (node.label && node.label !== node.id) current.label = node.label
  }

  for (const rawLine of String(source || '').split(/\r?\n/)) {
    let line = rawLine.trim()
    if (!line || line.startsWith('%%')) continue
    const header = /^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)\b/i.exec(line)
    if (header) {
      direction = header[1].toUpperCase()
      line = line.slice(header[0].length).trim()
      if (!line) continue
    }
    if (/^(subgraph|end|direction|style|classDef|class|linkStyle|click)\b/i.test(line)) continue

    const parts = line.split(/(-->|---|-.->|==>)/)
    if (parts.length === 1) {
      addNode(parseNode(line))
      continue
    }

    let previous = null
    for (const part of parts) {
      const token = part.trim()
      if (!token) continue
      if (/^(-->|---|-.->|==>)$/.test(token)) {
        pending = token
        continue
      }
      let nodeToken = token
      if (nodeToken.startsWith('|')) {
        const end = nodeToken.indexOf('|', 1)
        if (end > 0) {
          edgeLabel = nodeToken.slice(1, end).trim()
          nodeToken = nodeToken.slice(end + 1)
        }
      }
      const node = parseNode(nodeToken)
      if (!node) {
        previous = null
        pending = ''
        edgeLabel = ''
        continue
      }
      addNode(node)
      if (previous && pending) {
        edges.push({ from: previous.id, to: node.id, label: edgeLabel })
      }
      previous = node
      pending = ''
      edgeLabel = ''
    }
  }

  return { direction, nodes: [...nodes.values()], edges }
}

function truncateText (value, max = 22) {
  const text = String(value || '')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function nodeWidth (node) {
  return Math.max(58, Math.min(196, String(node.label || '').length * 7.2 + 24))
}

function renderFlowchartSvg (graph) {
  const nodes = graph.nodes
  if (!nodes.length) return null
  const levels = new Map(nodes.map((node) => [node.id, 0]))
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false
    for (const edge of graph.edges) {
      const from = levels.get(edge.from) || 0
      const next = from + 1
      if (next > (levels.get(edge.to) || 0)) {
        levels.set(edge.to, next)
        changed = true
      }
    }
    if (!changed) break
  }

  const groups = new Map()
  for (const node of nodes) {
    const level = levels.get(node.id) || 0
    if (!groups.has(level)) groups.set(level, [])
    groups.get(level).push(node)
  }
  const levelKeys = [...groups.keys()].sort((a, b) => a - b)
  const horizontal = graph.direction === 'LR' || graph.direction === 'RL'
  const nodeHeight = 36
  const crossGap = 18
  const mainGap = 58
  const pad = 22
  const positions = new Map()
  let width = 0
  let height = 0

  if (horizontal) {
    const colWidth = 210
    let maxRows = 0
    for (const level of levelKeys) {
      const list = groups.get(level)
      maxRows = Math.max(maxRows, list.length)
      list.forEach((node, row) => {
        const w = nodeWidth(node)
        positions.set(node.id, {
          x: pad + level * colWidth + (colWidth - w) / 2,
          y: pad + row * (nodeHeight + crossGap),
          w,
          h: nodeHeight
        })
      })
    }
    width = pad * 2 + Math.max(1, levelKeys.length) * colWidth
    height = pad * 2 + Math.max(1, maxRows) * (nodeHeight + crossGap)
  } else {
    let maxWidth = 0
    for (const level of levelKeys) {
      const list = groups.get(level)
      const sizes = list.map(nodeWidth)
      const total = sizes.reduce((sum, w) => sum + w, 0) + Math.max(0, sizes.length - 1) * crossGap
      maxWidth = Math.max(maxWidth, total)
      let x = 0
      list.forEach((node, index) => {
        positions.set(node.id, {
          x,
          y: pad + level * (nodeHeight + mainGap),
          w: sizes[index],
          h: nodeHeight
        })
        x += sizes[index] + crossGap
      })
    }
    for (const position of positions.values()) position.x += pad
    width = pad * 2 + Math.max(1, maxWidth)
    height = pad * 2 + Math.max(1, levelKeys.length) * (nodeHeight + mainGap)
  }

  const markerId = `md-arrow-${++diagramSeq}`
  const svg = svgEl('svg', {
    class: 'md-diagram-svg',
    viewBox: `0 0 ${Math.round(width)} ${Math.round(height)}`,
    role: 'img',
    'aria-label': `流程图，${nodes.length} 个节点，${graph.edges.length} 条连线`
  })
  const defs = svgEl('defs')
  const marker = svgEl('marker', {
    id: markerId,
    markerWidth: '9',
    markerHeight: '9',
    refX: '8',
    refY: '4.5',
    orient: 'auto',
    markerUnits: 'strokeWidth'
  })
  const arrow = svgEl('path', { d: 'M0,0 L9,4.5 L0,9 Z', class: 'md-diagram-arrow' })
  marker.append(arrow)
  defs.append(marker)
  svg.append(defs)

  for (const edge of graph.edges) {
    const from = positions.get(edge.from)
    const to = positions.get(edge.to)
    if (!from || !to) continue
    let startX, startY, endX, endY, d
    if (horizontal) {
      const forward = to.x >= from.x
      startX = forward ? from.x + from.w : from.x
      startY = from.y + from.h / 2
      endX = forward ? to.x : to.x + to.w
      endY = to.y + to.h / 2
      const curve = Math.max(42, Math.abs(endX - startX) * 0.5)
      d = `M ${startX} ${startY} C ${startX + (forward ? curve : -curve)} ${startY}, ${endX - (forward ? curve : -curve)} ${endY}, ${endX} ${endY}`
    } else {
      const forward = to.y >= from.y
      startX = from.x + from.w / 2
      startY = forward ? from.y + from.h : from.y
      endX = to.x + to.w / 2
      endY = forward ? to.y : to.y + to.h
      const curve = Math.max(42, Math.abs(endY - startY) * 0.5)
      d = `M ${startX} ${startY} C ${startX} ${startY + (forward ? curve : -curve)}, ${endX} ${endY - (forward ? curve : -curve)}, ${endX} ${endY}`
    }
    svg.append(svgEl('path', {
      class: 'md-diagram-edge',
      d,
      'marker-end': `url(#${markerId})`
    }))
    if (edge.label) {
      const label = svgEl('text', {
        class: 'md-diagram-edge-label',
        x: (startX + endX) / 2,
        y: (startY + endY) / 2 - 5,
        'text-anchor': 'middle'
      })
      label.textContent = edge.label
      svg.append(label)
    }
  }

  for (const node of nodes) {
    const position = positions.get(node.id)
    const group = svgEl('g', { class: 'md-diagram-node' })
    group.append(svgEl('rect', {
      x: position.x,
      y: position.y,
      width: position.w,
      height: position.h,
      rx: 9
    }))
    const title = svgEl('title')
    title.textContent = node.label
    group.append(title)
    const text = svgEl('text', {
      x: position.x + position.w / 2,
      y: position.y + position.h / 2 + 4,
      'text-anchor': 'middle'
    })
    text.textContent = truncateText(node.label)
    group.append(text)
    svg.append(group)
  }

  return svg
}

function diagramCard (source, graph) {
  const svg = renderFlowchartSvg(graph)
  if (!svg) return null
  return h('div', { class: 'md-diagram' },
    h('div', { class: 'md-code-head' },
      h('span', { class: 'md-code-lang', text: `示意图 · ${graph.direction}` }),
      copyButton(source, '复制源码')
    ),
    h('div', { class: 'md-diagram-canvas' }, svg),
    h('details', { class: 'md-diagram-src' },
      h('summary', { text: '查看 Mermaid 源码' }),
      h('pre', { text: source })
    )
  )
}

function decorateCode (pre, lang, code) {
  const source = code ? code.textContent : pre.textContent
  const card = h('div', { class: 'md-code' },
    h('div', { class: 'md-code-head' },
      h('span', { class: 'md-code-lang', text: lang || 'code' }),
      copyButton(source, '复制')
    )
  )
  pre.replaceWith(card)
  card.append(pre)
}

/* 在设置 innerHTML = md(...) 之后调用；可安全重复调用。 */
export function enhanceMarkdown (root) {
  if (!root) return
  for (const pre of [...root.querySelectorAll('pre')]) {
    if (pre.closest('.md-code') || pre.closest('.md-diagram')) continue
    const code = pre.querySelector('code')
    const lang = code ? code.dataset.lang || '' : ''
    if (isDiagramLang(lang)) {
      const source = code ? code.textContent : pre.textContent
      const graph = parseFlowchart(source)
      const card = graph && graph.nodes.length ? diagramCard(source, graph) : null
      if (card) {
        pre.replaceWith(card)
        continue
      }
    }
    decorateCode(pre, lang, code)
  }
}
