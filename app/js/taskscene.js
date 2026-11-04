/* taskscene.js — 任务面板的 3D 派单轨迹 */

import { state, h } from './core.js'
import { mountSceneStars } from './scenestars.js'
import { retryPlanTask } from './orchestrator.js'

const LABELS = {
  queued: '排队',
  running: '进行中',
  done: '已交付',
  error: '未完成'
}

const STAGE_TEXT = {
  queued: '等待派发',
  running: '阶段 2 / 3',
  done: '阶段 3 / 3',
  error: '已中断'
}

const PROGRESS = {
  queued: 0,
  running: 2 / 3,
  done: 1,
  error: 1
}

const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M12 1.8C12.55 8.5 14.2 10.8 22.2 12C14.2 13.2 12.55 15.5 12 22.2C11.45 15.5 9.8 13.2 1.8 12C9.8 10.8 11.45 8.5 12 1.8Z" fill="currentColor"/>' +
  '<circle cx="12" cy="12" r="2.2" fill="#fff" opacity=".86"/>' +
  '</svg>'

function reducedMotion () {
  return document.body.classList.contains('reduced-motion') ||
    (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
}

function taskTitle (text) {
  let value = String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!value) return '未命名任务'
  if (value.length > 42) value = value.slice(0, 42).trim() + '…'
  return value
}

function collectTasks () {
  const out = []
  let order = 0
  for (const plan of state.messages) {
    if (!plan || plan.kind !== 'plan' || !Array.isArray(plan.tasks)) continue
    for (const task of plan.tasks) {
      out.push({
        ...task,
        planId: plan.id,
        planTs: plan.ts,
        planName: plan.name || '',
        order: order++,
        titleText: taskTitle(task.text)
      })
    }
  }
  return out
}

function preferredFocus (tasks) {
  for (let i = tasks.length - 1; i >= 0; i--) {
    if (tasks[i].state === 'running') return i
  }
  for (let i = 0; i < tasks.length; i++) {
    if (tasks[i].state === 'queued') return i
  }
  for (let i = tasks.length - 1; i >= 0; i--) {
    if (tasks[i].state === 'error') return i
  }
  return Math.max(0, tasks.length - 1)
}

function setVar (el, name, value) {
  el.style.setProperty(name, value)
}

export function createTaskScene () {
  let tasks = []
  let nodes = new Map()
  let prevStates = new Map()
  let focus = 0
  let overviewMode = false
  let userLocked = false
  let ready = false
  let destroyed = false
  let lastIds = ''
  let lastWheel = 0
  let epoch = 0
  let resizeObs = null
  let resizeRaf = 0
  let shiftTimer = null
  const timers = new Set()

  const headCount = h('span', { class: 'ts-count', text: '0 / 0' })
  const headSub = h('span', { class: 'ts-sub', text: '等待派单' })
  const headMain = h('div', { class: 'ts-head-main' },
    h('span', { class: 'ts-eyebrow', text: 'DISPATCH TRAIL' }),
    h('div', { class: 'ts-headline' },
      h('span', { text: '任务轨迹' }),
      headCount
    ),
    headSub
  )
  const overviewBtn = h('button', {
    class: 'ts-overview',
    type: 'button',
    'aria-pressed': 'false',
    title: '总览 / 回到聚焦视图'
  }, '总览')
  const head = h('div', { class: 'ts-head' }, headMain, overviewBtn)

  const route = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  route.setAttribute('class', 'ts-route')
  route.setAttribute('aria-hidden', 'true')
  const routeGlow = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  routeGlow.setAttribute('class', 'ts-route-glow')
  const routePath = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  routePath.setAttribute('class', 'ts-route-line')
  route.append(routeGlow, routePath)

  const layer = h('div', { class: 'ts-layer' })
  const empty = h('div', { class: 'ts-empty', hidden: true },
    h('div', { class: 'ts-empty-star', html: STAR_SVG }),
    h('div', { class: 'ts-empty-title', text: '还没有派单记录' }),
    h('div', { class: 'ts-empty-desc', text: '总指挥接到任务后，任务会以流星节点沿这条轨迹依次展开，进度会实时更新。' })
  )
  const effects = h('div', { class: 'ts-effects' })
  const hudHint = h('span', { class: 'ts-hint' })
  const hudIndex = h('span', { class: 'ts-index', 'aria-live': 'polite' })
  const hud = h('div', { class: 'ts-hud' }, hudHint, hudIndex)

  const sky = document.createElement('canvas')
  sky.className = 'ts-canvas'
  sky.setAttribute('aria-hidden', 'true')

  const scene = h('div', {
    class: 'ts-scene',
    role: 'region',
    'aria-label': '任务派单轨迹'
  }, sky, route, layer, empty, effects, hud)

  const skyField = mountSceneStars(sky)

  const root = h('div', { class: 'ts-wrap' }, head, scene)

  function after (delay, fn) {
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (!destroyed) fn()
    }, delay)
    timers.add(timer)
    return timer
  }

  function clearEmpty () {
    empty.hidden = true
    empty.remove()
  }

  function ensureEmptyInScene () {
    if (!empty.isConnected) scene.insertBefore(empty, effects)
    empty.hidden = false
  }

  function showEmpty () {
    effectClear()
    epoch++
    layer.textContent = ''
    nodes.clear()
    prevStates.clear()
    tasks = []
    lastIds = ''
    focus = 0
    overviewMode = false
    scene.classList.remove('is-overview')
    scene.classList.add('is-ready')
    overviewBtn.disabled = true
    overviewBtn.setAttribute('aria-pressed', 'false')
    headCount.textContent = '0 / 0'
    headSub.textContent = '等待派单'
    hud.hidden = true
    routePath.setAttribute('d', '')
    routeGlow.setAttribute('d', '')
    ensureEmptyInScene()
  }

  function effectClear () {
    effects.textContent = ''
  }

  function updateHeader () {
    if (!tasks.length) {
      headCount.textContent = '0 / 0'
      headSub.textContent = '等待派单'
      overviewBtn.disabled = true
      return
    }
    const done = tasks.filter((t) => t.state === 'done').length
    const running = tasks.filter((t) => t.state === 'running').length
    const queued = tasks.filter((t) => t.state === 'queued').length
    const errored = tasks.filter((t) => t.state === 'error').length
    headCount.textContent = `${done} / ${tasks.length}`
    const bits = []
    if (running) bits.push(`${running} 进行中`)
    if (queued) bits.push(`${queued} 排队`)
    if (done) bits.push(`${done} 已交付`)
    if (errored) bits.push(`${errored} 未完成`)
    headSub.textContent = bits.length ? bits.join(' · ') : '等待派单'
    overviewBtn.disabled = false
  }

  function updateHud () {
    if (!tasks.length) {
      hud.hidden = true
      return
    }
    hud.hidden = false
    if (overviewMode) {
      hudHint.textContent = '总览模式 · 点击流星聚焦'
      hudIndex.textContent = `总览 · ${tasks.length} 项`
    } else {
      hudHint.textContent = tasks.length > 1 ? '滚轮切换 · 点击流星聚焦' : '点击流星聚焦'
      hudIndex.textContent = `焦点 ${focus + 1} / ${tasks.length}`
    }
  }

  function buildNode (task) {
    const node = h('div', {
      class: 'ts-node',
      role: 'button',
      tabindex: '0',
      dataset: { id: task.id, state: task.state }
    })
    node.style.setProperty('--task-color', task.color || 'var(--accent)')
    node.title = task.text || task.titleText

    const meteor = h('div', { class: 'ts-meteor' },
      h('i', { class: 'ts-tail' }),
      h('span', { class: 'ts-halo' }),
      h('span', { class: 'ts-star-icon', html: STAR_SVG }),
      h('span', { class: 'ts-ring' })
    )

    const stateEl = h('span', { class: 'ts-state', text: LABELS[task.state] || task.state })
    const stageEl = h('span', { class: 'ts-progress-stage', text: STAGE_TEXT[task.state] || '' })
    const titleEl = h('div', { class: 'ts-title', text: task.titleText })
    const roster = Array.isArray(state.roster && state.roster.agents) ? state.roster.agents : []
    const owner = roster.find((entry) => entry.id === (task.to || task.agentId)) ||
      roster.find((entry) => entry.name === task.name) || null
    const avatar = h('span', {
      class: 'ts-agent-avatar',
      'aria-hidden': 'true',
      title: owner && owner.name ? owner.name : (task.name || '')
    })
    if (owner && owner.avatar) avatar.append(h('img', { src: owner.avatar, alt: '' }))
    else avatar.append(h('span', { class: 'ts-agent-avatar-glyph', text: (owner && owner.glyph) || (task.name || '?').slice(0, 1) }))
    /* 失败任务的重试入口：就地重跑原任务，不追加副本。
       按钮挂在卡片内，点它不能冒泡成「聚焦这颗流星」。 */
    const retryLabel = h('span', { class: 'ts-retry-label', text: '↻ 重试' })
    const retryPlanId = task.planId
    const retryTaskId = task.id
    const retryBtn = h('button', {
      class: 'ts-retry',
      type: 'button',
      title: '用同样的指令重新执行这条任务',
      onclick: async (e) => {
        e.stopPropagation()
        if (retryBtn.disabled) return
        retryBtn.disabled = true
        retryLabel.textContent = '重试中…'
        try {
          await retryPlanTask(retryPlanId, retryTaskId)
        } finally {
          retryBtn.disabled = false
          retryLabel.textContent = '↻ 重试'
        }
      },
      onkeydown: (e) => e.stopPropagation()
    }, retryLabel)
    const retryRow = h('div', { class: 'ts-retry-row', hidden: true }, retryBtn)

    const card = h('div', { class: 'ts-card' },
      titleEl,
      h('div', { class: 'ts-agent' },
        h('i', { class: 'ts-agent-dot' }),
        h('div', { class: 'ts-agent-meta' },
          h('span', { class: 'ts-agent-name', text: task.name || '未知成员', title: task.name || '' }),
          h('span', { class: 'ts-agent-title', text: task.title || '', title: task.title || '' })
        ),
        avatar
      ),
      h('div', { class: 'ts-foot' },
        stateEl,
        stageEl
      ),
      h('div', { class: 'ts-progress' },
        h('i', { class: 'ts-progress-fill' })
      ),
      retryRow
    )

    node.append(meteor, card)
    const entry = {
      node,
      meteor,
      star: meteor.querySelector('.ts-star-icon'),
      card,
      stateEl,
      titleEl,
      stageEl,
      retryRow,
      retryBtn,
      retryLabel,
      fill: card.querySelector('.ts-progress-fill'),
      task
    }

    node.addEventListener('click', () => focusOn(tasks.indexOf(entry.task)))
    node.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      focusOn(tasks.indexOf(entry.task))
    })
    node.addEventListener('focus', () => {
      if (!overviewMode) return
      node.classList.add('is-key-focus')
    })
    node.addEventListener('blur', () => node.classList.remove('is-key-focus'))

    return entry
  }

  function updateNode (entry, task) {
    entry.task = task
    entry.node.dataset.state = task.state
    entry.stateEl.textContent = LABELS[task.state] || task.state
    entry.stageEl.textContent = STAGE_TEXT[task.state] || ''
    entry.fill.style.width = `${Math.round((PROGRESS[task.state] ?? 0) * 100)}%`
    entry.titleEl.textContent = task.titleText
    entry.node.title = task.text || task.titleText
    /* 只有失败的卡片才露出重试；一旦重跑，状态转 queued/running，按钮立刻收起 */
    const failed = task.state === 'error'
    entry.retryRow.hidden = !failed
    entry.retryBtn.disabled = !failed
    entry.retryLabel.textContent = '↻ 重试'
    entry.retryBtn.title = failed && task.attempts
      ? `用同样的指令重新执行这条任务（已重试 ${task.attempts} 次）`
      : '用同样的指令重新执行这条任务'
    entry.node.setAttribute('aria-label',
      `${task.titleText}，${task.name || '未知成员'}，${LABELS[task.state] || task.state}，${STAGE_TEXT[task.state] || ''}`)
  }

  function buildNodes () {
    layer.textContent = ''
    nodes.clear()
    for (const task of tasks) {
      const entry = buildNode(task)
      nodes.set(task.id, entry)
      layer.append(entry.node)
      updateNode(entry, task)
    }
    empty.hidden = true
  }

  function preferredIndex (list) {
    return preferredFocus(list)
  }

  function markShift () {
    if (shiftTimer) clearTimeout(shiftTimer)
    scene.classList.add('is-shifting')
    shiftTimer = setTimeout(() => {
      shiftTimer = null
      if (!destroyed) scene.classList.remove('is-shifting')
    }, 620)
  }

  function focusOn (index) {
    if (!tasks[index] || destroyed) return
    userLocked = true
    overviewMode = false
    scene.classList.remove('is-overview')
    overviewBtn.setAttribute('aria-pressed', 'false')
    focus = index
    markShift()
    layout()
    updateHud()
  }

  function setOverview (on) {
    if (!tasks.length) return
    userLocked = true
    overviewMode = Boolean(on)
    scene.classList.toggle('is-overview', overviewMode)
    overviewBtn.setAttribute('aria-pressed', overviewMode ? 'true' : 'false')
    markShift()
    layout()
    updateHud()
  }

  function layout () {
    if (destroyed || !scene.isConnected) return
    const width = scene.clientWidth
    const height = scene.clientHeight
    if (!width || !height) return

    route.setAttribute('viewBox', `0 0 ${width} ${height}`)
    // 与 .ts-node 的 left 保持一致：普通节点星头中心在画布 40% 处，
    // 聚焦节点星头中心固定在 40px，尾巴收短后仍留在轨道框内。
    const baseStarX = width * 0.4
    const activeStarX = 40
    const baseStarY = height * 0.5
    const points = []
    const overviewScale = tasks.length <= 4 ? 0.82
      : tasks.length <= 7 ? 0.7
        : tasks.length <= 10 ? 0.6 : 0.5

    tasks.forEach((task, index) => {
      const entry = nodes.get(task.id)
      if (!entry) return
      let x = 0
      let y = 0
      let z = 0
      let scale = 1
      let opacity = 1
      let ry = -2
      let active = false
      let visible = true

      if (overviewMode) {
        const t = tasks.length > 1 ? index / (tasks.length - 1) : 0.5
        const starX = width * (0.12 + 0.32 * t)
        const starY = height * (0.8 - 0.62 * t)
        x = starX - baseStarX
        y = starY - baseStarY
        z = -index * 8
        scale = overviewScale
        opacity = 0.86
        ry = -7
      } else {
        const d = index - focus
        const abs = Math.abs(d)
        const stepX = Math.max(24, Math.min(34, width * 0.1))
        const verticalGap = height * 0.25 + (abs - 1) * height * 0.16
        x = d * stepX
        y = -Math.sign(d) * verticalGap
        z = -abs * 70
        scale = d === 0 ? 1.04 : abs === 1 ? 0.74 : 0.52
        opacity = d === 0 ? 1 : abs === 1 ? 0.82 : 0.42
        ry = d === 0 ? -2 : -7
        active = d === 0
        visible = abs <= 2
        if (!visible) {
          opacity = 0
          scale = 0.5
          z = -300
        }
      }

      const node = entry.node
      setVar(node, '--x', `${x}px`)
      setVar(node, '--y', `${y}px`)
      setVar(node, '--z', `${z}px`)
      setVar(node, '--s', String(scale))
      setVar(node, '--o', String(opacity))
      setVar(node, '--ry', `${ry}deg`)
      node.classList.toggle('is-active', active)
      node.style.zIndex = active ? '50' : String(overviewMode ? 20 + index : 40 - Math.abs(index - focus))
      node.style.pointerEvents = visible ? 'auto' : 'none'
      node.tabIndex = visible ? 0 : -1
      if (visible) node.removeAttribute('aria-hidden')
      else node.setAttribute('aria-hidden', 'true')
      if (active) node.setAttribute('aria-current', 'true')
      else node.removeAttribute('aria-current')

      if (visible) points.push({
        x: (active ? activeStarX : baseStarX) + x,
        y: baseStarY + y
      })
    })

    if (points.length > 1) {
      let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`
      for (let i = 1; i < points.length; i++) {
        d += ` L ${points[i].x.toFixed(2)} ${points[i].y.toFixed(2)}`
      }
      routePath.setAttribute('d', d)
      routeGlow.setAttribute('d', d)
    } else {
      routePath.setAttribute('d', '')
      routeGlow.setAttribute('d', '')
    }
  }

  function updateHudState () {
    updateHeader()
    updateHud()
  }

  function refresh () {
    if (destroyed) return
    const oldTasks = tasks
    const oldFocusId = oldTasks[focus] && oldTasks[focus].id
    const next = collectTasks()
    const nextIds = next.map((t) => t.id).join('|')
    const changed = nextIds !== lastIds
    const appended = changed && next.length > oldTasks.length &&
      oldTasks.every((task, i) => next[i] && next[i].id === task.id)

    if (!next.length) {
      lastIds = ''
      showEmpty()
      return
    }

    tasks = next
    lastIds = nextIds
    clearEmpty()

    if (changed) {
      epoch++
      if (appended && !overviewMode) {
        userLocked = false
        focus = preferredIndex(tasks)
      } else {
        const preserved = oldFocusId ? tasks.findIndex((t) => t.id === oldFocusId) : -1
        focus = preserved >= 0 ? preserved : preferredIndex(tasks)
      }
      focus = Math.max(0, Math.min(tasks.length - 1, focus))
      ready = false
      scene.classList.remove('is-ready')
      if (!overviewMode) scene.classList.remove('is-overview')
      buildNodes()
      prevStates = new Map(tasks.map((t) => [t.id, t.state]))
      updateHeader()
      updateHud()
      layout()
      requestAnimationFrame(() => {
        if (destroyed) return
        layout()
        ready = true
        scene.classList.add('is-ready')
      })
      return
    }

    const newlyDone = []
    const newlyRunning = []
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i]
      const entry = nodes.get(task.id)
      if (!entry) continue
      const prev = prevStates.get(task.id)
      updateNode(entry, task)
      if (prev && prev !== 'done' && task.state === 'done') newlyDone.push(i)
      if (prev && prev !== 'running' && task.state === 'running') newlyRunning.push(i)
      prevStates.set(task.id, task.state)
    }

    updateHeader()
    if (!overviewMode && !userLocked && newlyRunning.length) {
      focus = newlyRunning[newlyRunning.length - 1]
      markShift()
      layout()
    }
    updateHud()

    newlyDone.forEach((index, order) => {
      const entry = nodes.get(tasks[index].id)
      if (!entry) return
      const runEpoch = epoch
      after(120 + order * 150, () => {
        if (runEpoch !== epoch) return
        playHandoff(index)
      })
    })
  }

  function nodeVisible (entry) {
    if (!entry || !entry.node.isConnected) return false
    const opacity = Number(getComputedStyle(entry.node).opacity)
    if (!Number.isFinite(opacity) || opacity <= 0.06) return false
    const sceneRect = scene.getBoundingClientRect()
    const starRect = entry.star.getBoundingClientRect()
    if (!starRect.width || !starRect.height) return false
    const cx = starRect.left + starRect.width / 2
    const cy = starRect.top + starRect.height / 2
    return cx > sceneRect.left + 2 && cx < sceneRect.right - 2 &&
      cy > sceneRect.top + 2 && cy < sceneRect.bottom - 2
  }

  function toScenePoint (el) {
    const sceneRect = scene.getBoundingClientRect()
    const rect = el.getBoundingClientRect()
    return {
      x: rect.left + rect.width / 2 - sceneRect.left,
      y: rect.top + rect.height / 2 - sceneRect.top
    }
  }

  function spawnBurst (point, color, small) {
    const burst = h('span', { class: 'ts-burst' + (small ? ' small' : '') })
    burst.style.left = `${point.x}px`
    burst.style.top = `${point.y}px`
    burst.style.setProperty('--burst-color', color || 'var(--accent)')
    for (let i = 0; i < 6; i++) {
      const spark = h('i')
      spark.style.setProperty('--a', `${i * 60 + Math.random() * 28}deg`)
      spark.style.setProperty('--d', `${small ? 10 + Math.random() * 7 : 15 + Math.random() * 17}px`)
      burst.append(spark)
    }
    effects.append(burst)
    after(900, () => burst.remove())
  }

  function spawnBeam (from, to, color) {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const length = Math.hypot(dx, dy)
    if (length < 2) return
    const angle = Math.atan2(dy, dx)
    const beam = h('span', { class: 'ts-beam' })
    beam.style.left = `${from.x}px`
    beam.style.top = `${from.y}px`
    beam.style.width = `${length}px`
    beam.style.transform = `rotate(${angle}rad)`
    beam.style.setProperty('--beam-color', color || 'var(--accent)')
    effects.append(beam)
    after(950, () => beam.remove())
    return { dx, dy, angle, length }
  }

  function spawnEnergy (from, to, color, path) {
    if (!path || reducedMotion()) return
    const dot = h('span', { class: 'ts-energy' })
    dot.style.left = `${from.x}px`
    dot.style.top = `${from.y}px`
    dot.style.setProperty('--energy-color', color || 'var(--accent)')
    dot.style.setProperty('--energy-angle', `${path.angle}rad`)
    effects.append(dot)
    const start = 'translate(-50%, -50%) translate3d(0, 0, 0)'
    const end = `translate(-50%, -50%) translate3d(${path.dx}px, ${path.dy}px, 0)`
    dot.animate([
      { transform: start, opacity: 0, offset: 0 },
      { transform: start, opacity: 1, offset: 0.1 },
      { transform: end, opacity: 1, offset: 0.9 },
      { transform: end, opacity: 0, offset: 1 }
    ], {
      duration: 900,
      easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
      fill: 'forwards'
    })
    after(980, () => dot.remove())
  }

  function playHandoff (index) {
    if (destroyed) return
    const task = tasks[index]
    if (!task) return
    const fromEntry = nodes.get(task.id)
    if (!nodeVisible(fromEntry)) return
    const from = toScenePoint(fromEntry.star)
    spawnBurst(from, task.color)
    fromEntry.node.classList.add('is-bursting')
    after(760, () => fromEntry.node.classList.remove('is-bursting'))

    const nextTask = tasks[index + 1]
    if (!nextTask) return
    const toEntry = nodes.get(nextTask.id)
    if (!nodeVisible(toEntry)) return
    const to = toScenePoint(toEntry.star)
    const path = spawnBeam(from, to, task.color)
    spawnEnergy(from, to, task.color, path)
    after(900, () => {
      const nextEntry = nodes.get(nextTask.id)
      if (!nextEntry) return
      nextEntry.node.classList.add('is-received')
      spawnBurst(toScenePoint(nextEntry.star), nextTask.color, true)
      after(820, () => nextEntry.node.classList.remove('is-received'))
    })
  }

  function onWheel (event) {
    if (!tasks.length || overviewMode) return
    if (Math.abs(event.deltaY) < 3) return
    event.preventDefault()
    const now = performance.now()
    if (now - lastWheel < 190) return
    lastWheel = now
    userLocked = true
    const dir = event.deltaY > 0 ? 1 : -1
    focus = (focus + dir + tasks.length) % tasks.length
    markShift()
    layout()
    updateHud()
  }

  scene.addEventListener('wheel', onWheel, { passive: false })
  overviewBtn.addEventListener('click', () => setOverview(!overviewMode))

  resizeObs = new ResizeObserver(() => {
    if (destroyed) return
    if (resizeRaf) cancelAnimationFrame(resizeRaf)
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0
      if (destroyed) return
      layout()
    })
  })
  resizeObs.observe(scene)

  refresh()

  return {
    root,
    update: refresh,
    destroy () {
      destroyed = true
      skyField.destroy()
      scene.removeEventListener('wheel', onWheel)
      if (resizeObs) resizeObs.disconnect()
      if (resizeRaf) cancelAnimationFrame(resizeRaf)
      if (shiftTimer) clearTimeout(shiftTimer)
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      root.remove()
    }
  }
}
