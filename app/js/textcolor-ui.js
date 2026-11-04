/* textcolor-ui.js — 设置 → 外观里的完整「消息文字颜色」编辑面板
   配置项与 DSH 插件保持一致：模式、5 组作用范围、24 个单色、自定义色、
   9 套炫彩、色相、速度、流动方式、色带宽度、实时预览、恢复默认。 */

import { h } from './core.js'
import {
  getTextColorConfig,
  setTextColorConfig,
  resetTextColorConfig,
  solidColor,
  previewStyle,
  parseHex,
  toHex,
  effectiveRainbowStops,
  getCustomRainbowPresets,
  saveCustomRainbowPreset,
  deleteCustomRainbowPreset,
  SOLID_CHOICES,
  RAINBOW_PRESETS,
  PRESET_NAMES,
  SCOPES
} from './textcolor.js'

const PREVIEW_TEXT = {
  assistant: '助手回复：这段文字会跟随当前设置。',
  reasoning: '规划状态：正在编排任务…',
  tools: '工具与任务：任务状态也会变色。',
  user: '我的消息：气泡文字会变色，底色保留。',
  composer: '输入区：输入框和提示文字会变色。'
}

const MODE_LABELS = { off: '关闭', solid: '单色', rainbow: '炫彩渐变' }
const MOTION_LABELS = { alternate: '往复', loop: '单向', still: '静止' }
const CUSTOM_MIN = 2
const CUSTOM_MAX = 12

function rgbToHsv (rgb) {
  const r = rgb[0] / 255
  const g = rgb[1] / 255
  const b = rgb[2] / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  let h = 0
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
    h *= 60
    if (h < 0) h += 360
  }
  const s = max === 0 ? 0 : delta / max
  return { h, s, v: max }
}

function hsvToRgb (h, s, v) {
  const c = v * s
  const hp = ((h % 360) + 360) % 360 / 60
  const x = c * (1 - Math.abs(hp % 2 - 1))
  let rgb
  if (hp < 1) rgb = [c, x, 0]
  else if (hp < 2) rgb = [x, c, 0]
  else if (hp < 3) rgb = [0, c, x]
  else if (hp < 4) rgb = [0, x, c]
  else if (hp < 5) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  const m = v - c
  return rgb.map((channel) => Math.round((channel + m) * 255))
}

function colorToHsv (hex) {
  const rgb = parseHex(hex)
  return rgb ? rgbToHsv(rgb) : { h: 0, s: 0, v: 1 }
}

function hsvToHex (h, s, v) {
  return toHex(hsvToRgb(h, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, v))))
}

function drawColorWheel (canvas) {
  const size = canvas.width
  const ctx = canvas.getContext('2d')
  const data = ctx.createImageData(size, size)
  const radius = size / 2 - 2
  const cx = size / 2
  const cy = size / 2
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - cx
      const dy = y - cy
      const distance = Math.sqrt(dx * dx + dy * dy)
      if (distance > radius + 1) continue
      const h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360
      const s = Math.min(1, distance / radius)
      const rgb = hsvToRgb(h, s, 1)
      const edge = Math.min(1, Math.max(0, radius + 1 - distance))
      const offset = (y * size + x) * 4
      data.data[offset] = rgb[0]
      data.data[offset + 1] = rgb[1]
      data.data[offset + 2] = rgb[2]
      data.data[offset + 3] = Math.round(255 * edge)
    }
  }
  ctx.putImageData(data, 0, 0)
}

function controlRow (label, hint, control, extraClass = '') {
  return h('div', { class: 'tc-row ' + extraClass },
    h('div', { class: 'tc-row-main' },
      h('div', { class: 'tc-row-label', text: label }),
      hint ? h('div', { class: 'hint', text: hint }) : null
    ),
    h('div', { class: 'tc-row-control' }, control)
  )
}

function switchControl (on, onclick, label) {
  const el = h('div', {
    class: 'switch' + (on ? ' on' : ''),
    role: 'switch',
    'aria-checked': on,
    'aria-label': label,
    tabindex: '0'
  })
  const trigger = () => onclick(el)
  el.onclick = trigger
  el.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      trigger()
    }
  }
  return el
}

function segmented (options, current, onPick) {
  const buttons = {}
  const el = h('div', { class: 'tc-seg', role: 'group' },
    options.map((option) => {
      const button = h('button', {
        type: 'button',
        class: 'tc-seg-btn' + (option.id === current ? ' active' : ''),
        text: option.label,
        onclick: () => onPick(option.id)
      })
      buttons[option.id] = button
      return button
    })
  )
  return { el, buttons }
}

function setActiveButtons (buttons, activeId) {
  for (const [id, button] of Object.entries(buttons)) button.classList.toggle('active', id === activeId)
}

export function renderTextColorSettings (body) {
  const section = h('div', { class: 'tc-section' })
  const configNow = getTextColorConfig()

  const resetButton = h('button', {
    class: 'btn ghost tc-reset',
    type: 'button',
    text: '恢复默认',
    onclick: () => {
      resetTextColorConfig()
      sync()
    }
  })

  const closeButton = h('button', {
    class: 'btn ghost tc-close',
    type: 'button',
    text: '关闭',
    title: '关闭消息文字颜色，恢复主题默认颜色',
    onclick: () => {
      setTextColorConfig({ mode: 'off' })
      sync()
    }
  })

  section.append(h('div', { class: 'tc-head' },
    h('div', { class: 'tc-head-main' },
      h('div', { class: 'pane-title', text: '消息文字颜色' }),
      h('div', { class: 'hint', text: '把文字颜色插件完整搬进外观：单色或流动彩虹，配色、参数和作用范围都能改，改完立即生效。' })
    ),
    h('div', { class: 'tc-head-actions' }, closeButton, resetButton)
  ))

  /* 总开关 + 染色方式 */
  const masterSwitch = switchControl(configNow.mode !== 'off', () => {
    const config = getTextColorConfig()
    setTextColorConfig({ mode: config.mode === 'off' ? (config.lastMode || 'rainbow') : 'off' })
    sync()
  }, '启用消息文字颜色')

  const modeSeg = segmented(
    ['off', 'solid', 'rainbow'].map((id) => ({ id, label: MODE_LABELS[id] })),
    configNow.mode,
    (mode) => {
      setTextColorConfig({ mode })
      sync()
    }
  )

  section.append(h('div', { class: 'tc-card' },
    h('div', { class: 'tc-card-title', text: '基础' }),
    controlRow('启用消息文字颜色', '关闭时完全不动原来的文字颜色；下面的配色会保留。', masterSwitch),
    controlRow('染色方式', '关闭 = 恢复主题默认颜色；单色整段替换；炫彩渐变会流动。', modeSeg.el)
  ))

  /* 作用范围 */
  const scopeSwitches = {}
  const scopeRows = SCOPES.map((scope) => {
    const sw = switchControl(configNow.applyTo[scope.key] === true, (el) => {
      el.classList.toggle('on')
      setTextColorConfig({ applyTo: { [scope.key]: el.classList.contains('on') } })
      sync()
    }, scope.label)
    scopeSwitches[scope.key] = sw
    return controlRow(scope.label, scope.hint, sw)
  })
  section.append(h('div', { class: 'tc-card' },
    h('div', { class: 'tc-card-title', text: '作用范围' }),
    h('div', { class: 'hint', text: '按消息的组成部分分别开关，只染你想要的那几块。' }),
    ...scopeRows
  ))

  /* 单色 */
  const swatchButtons = {}
  const swatchGrid = h('div', { class: 'tc-swatches' })
  for (const hex of SOLID_CHOICES) {
    const button = h('button', {
      type: 'button',
      class: 'tc-swatch',
      title: hex,
      'aria-label': hex,
      style: { background: solidColor(hex, 'light') },
      onclick: () => {
        setTextColorConfig({ mode: 'solid', color: hex })
        sync()
      }
    })
    swatchButtons[hex] = button
    swatchGrid.append(button)
  }

  const colorInput = h('input', {
    type: 'color',
    class: 'tc-color-input',
    value: configNow.color,
    'aria-label': '自定义颜色',
    oninput: (event) => {
      setTextColorConfig({ mode: 'solid', color: event.target.value })
      sync()
    }
  })

  const hexInput = h('input', {
    type: 'text',
    class: 'tc-hex',
    value: configNow.color,
    spellcheck: 'false',
    'aria-label': '自定义十六进制颜色',
    oninput: (event) => {
      const value = event.target.value.trim()
      if (parseHex(value)) {
        setTextColorConfig({ mode: 'solid', color: value })
        sync()
      }
    },
    onblur: () => sync()
  })

  section.append(h('div', { class: 'tc-card' },
    h('div', { class: 'tc-card-title', text: '单色颜色' }),
    h('div', { class: 'hint', text: '24 个常用色；浅色与深色主题会自动选一版能看清的亮度。' }),
    swatchGrid,
    h('div', { class: 'tc-custom-row' },
      colorInput,
      hexInput,
      h('span', { class: 'hint', text: '选色或输入十六进制后自动切到单色。' })
    )
  ))

  /* 炫彩 */
  const presetButtons = {}
  const presetGrid = h('div', { class: 'tc-presets' })
  for (const preset of RAINBOW_PRESETS) {
    const button = h('button', {
      type: 'button',
      class: 'tc-preset',
      title: PRESET_NAMES[preset.id],
      onclick: () => {
        setTextColorConfig({ mode: 'rainbow', rainbow: { preset: preset.id } })
        sync()
      }
    },
    h('span', {
      class: 'tc-band',
      style: { backgroundImage: `linear-gradient(90deg, ${preset.stops.concat([preset.stops[0]]).join(', ')})` }
    }),
    h('span', { class: 'tc-preset-name', text: PRESET_NAMES[preset.id] })
    )
    presetButtons[preset.id] = button
    presetGrid.append(button)
  }

  const savedPresetGrid = h('div', { class: 'tc-presets tc-saved-presets' })
  const savedPresetEmpty = h('div', { class: 'hint tc-saved-empty', text: '还没有保存的自定义预设。调好色块后，在下方命名保存。' })
  const savedPresetBlock = h('div', { class: 'tc-saved-box' },
    h('div', { class: 'tc-saved-head' },
      h('span', { class: 'tc-saved-title', text: '我的预设' }),
      h('span', { class: 'hint', text: '保存后的自定义色带会出现在这里，可随时选用或删除' })
    ),
    savedPresetGrid,
    savedPresetEmpty
  )

  const hueInput = h('input', { type: 'range', class: 'tc-range', min: '0', max: '350', step: '5', value: String(configNow.rainbow.hue), 'aria-label': '色相偏移' })
  const hueValue = h('span', { class: 'tc-value', text: configNow.rainbow.hue + '°' })
  hueInput.oninput = (event) => {
    setTextColorConfig({ rainbow: { hue: Number(event.target.value) } })
    sync()
  }

  const speedInput = h('input', { type: 'range', class: 'tc-range', min: '1', max: '24', step: '0.5', value: String(configNow.rainbow.speed), 'aria-label': '流动速度' })
  const speedValue = h('span', { class: 'tc-value', text: configNow.rainbow.speed + 's' })
  speedInput.oninput = (event) => {
    setTextColorConfig({ rainbow: { speed: Number(event.target.value) } })
    sync()
  }

  const widthInput = h('input', { type: 'range', class: 'tc-range', min: '120', max: '800', step: '10', value: String(configNow.rainbow.width), 'aria-label': '色带宽度' })
  const widthValue = h('span', { class: 'tc-value', text: configNow.rainbow.width + '%' })
  widthInput.oninput = (event) => {
    setTextColorConfig({ rainbow: { width: Number(event.target.value) } })
    sync()
  }

  const motionSeg = segmented(
    ['alternate', 'loop', 'still'].map((id) => ({ id, label: MOTION_LABELS[id] })),
    configNow.rainbow.motion,
    (motion) => {
      const current = getTextColorConfig()
      setTextColorConfig({ mode: current.mode === 'off' ? 'rainbow' : current.mode, rainbow: { motion } })
      sync()
    }
  )

  section.append(h('div', { class: 'tc-card' },
    h('div', { class: 'tc-card-title', text: '炫彩配色' }),
    h('div', { class: 'hint', text: '9 套色带；色相、速度、流动方式和色带宽度都可以改。' }),
    presetGrid,
    savedPresetBlock,
    controlRow('色相偏移', '仅对预设色带生效；自定义色带直接使用你选定的色块原色。', h('div', { class: 'tc-slider-wrap' }, hueInput, hueValue)),
    controlRow('流动速度', '走完一趟要多久；数字越小越快。', h('div', { class: 'tc-slider-wrap' }, speedInput, speedValue)),
    controlRow('流动方式', '往复来回摆，单向一直流，静止不加动画。', motionSeg.el),
    controlRow('色带宽度', '数值越大，同一段文字里颜色越少、过渡越长。', h('div', { class: 'tc-slider-wrap' }, widthInput, widthValue))
  ))

  /* 自定义炫彩条：增删色块、拖拽排序、RGB 色盘改色 */
  let selectedStop = 0
  let dragStop = -1
  let wheelHsv = { h: 0, s: 0, v: 1 }
  let wheelDragging = false

  const customCard = h('div', { class: 'tc-card tc-custom-card' })
  const customCount = h('span', { class: 'tc-count', text: '6 色' })
  const customHint = h('div', { class: 'hint' })
  const customStrip = h('div', { class: 'tc-strip', role: 'list', 'aria-label': '自定义炫彩色块' })

  const addButton = h('button', {
    class: 'btn ghost tc-mini',
    type: 'button',
    text: '+ 添加色块',
    onclick: () => addCustomStop()
  })
  const removeButton = h('button', {
    class: 'btn ghost tc-mini',
    type: 'button',
    text: '删除选中',
    onclick: () => removeCustomStop()
  })
  const closeRainbowButton = h('button', {
    class: 'btn ghost tc-mini tc-close',
    type: 'button',
    text: '关闭炫彩',
    title: '关闭炫彩效果，恢复主题默认文字颜色',
    onclick: () => {
      setTextColorConfig({ mode: 'off' })
      sync()
    }
  })
  const forkButton = h('button', {
    class: 'btn ghost tc-mini',
    type: 'button',
    text: '转为自定义',
    title: '复制当前预设色带为可编辑的自定义色带',
    onclick: () => forkCustomStops()
  })

  const presetNameInput = h('input', {
    class: 'tc-save-name',
    type: 'text',
    maxlength: '24',
    placeholder: '给这套色带命名，例如「海盐」',
    'aria-label': '自定义炫彩预设名称'
  })
  const savePresetButton = h('button', {
    class: 'btn primary tc-mini',
    type: 'button',
    text: '保存为预设',
    title: '把当前色带保存到「我的预设」'
  })
  const savePresetStatus = h('span', { class: 'hint tc-save-status' })
  const savePresetRow = h('div', { class: 'tc-save-preset' },
    presetNameInput,
    savePresetButton,
    savePresetStatus
  )
  const wheelCanvas = h('canvas', { class: 'tc-wheel-canvas', 'aria-label': '颜色色盘' })
  wheelCanvas.width = 360
  wheelCanvas.height = 360
  drawColorWheel(wheelCanvas)
  const wheelMarker = h('span', { class: 'tc-wheel-marker' })
  const wheelPreview = h('span', { class: 'tc-wheel-preview' })
  const wheelHex = h('span', { class: 'tc-wheel-hex', text: '#FFFFFF' })
  const wheelRgb = h('span', { class: 'tc-wheel-rgb', text: 'R 255 · G 255 · B 255' })
  const wheelBrightness = h('input', {
    type: 'range', class: 'tc-range', min: '0', max: '100', step: '1', value: '100', 'aria-label': '色块明度'
  })
  const wheelBrightnessValue = h('span', { class: 'tc-value', text: '100%' })

  function currentRawStops () {
    return effectiveRainbowStops(getTextColorConfig())
  }

  function saveCurrentPreset () {
    const name = presetNameInput.value.trim()
    if (!name) {
      savePresetStatus.textContent = '先给预设起一个名字'
      presetNameInput.focus()
      return
    }
    const preset = saveCustomRainbowPreset(name, currentRawStops())
    if (!preset) {
      savePresetStatus.textContent = '保存失败：预设数量已满（最多 24 个）或色块无效'
      return
    }
    presetNameInput.value = ''
    setTextColorConfig({ mode: 'rainbow', rainbow: { preset: preset.id, hue: 0 } })
    sync()
    savePresetStatus.textContent = `已保存「${preset.name}」，可在上方「我的预设」中选用`
  }

  savePresetButton.addEventListener('click', saveCurrentPreset)
  presetNameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      saveCurrentPreset()
    }
  })

  function commitCustomStops (nextStops, nextSelected = selectedStop) {
    if (!Array.isArray(nextStops) || nextStops.length < CUSTOM_MIN || nextStops.length > CUSTOM_MAX) return
    selectedStop = Math.max(0, Math.min(nextStops.length - 1, nextSelected))
    setTextColorConfig({
      mode: 'rainbow',
      rainbow: { preset: 'custom', customStops: nextStops, hue: 0 }
    })
    sync()
  }

  function forkCustomStops () {
    const stops = currentRawStops()
    selectedStop = Math.min(selectedStop, stops.length - 1)
    commitCustomStops(stops, selectedStop)
  }

  function addCustomStop () {
    const stops = currentRawStops()
    if (stops.length >= CUSTOM_MAX) return
    const base = stops[Math.min(selectedStop, stops.length - 1)] || '#8b9cff'
    const hsv = colorToHsv(base)
    const nextColor = hsvToHex(hsv.h + 38, Math.max(0.55, hsv.s), Math.max(0.72, hsv.v))
    const next = [...stops]
    const at = Math.min(selectedStop + 1, next.length)
    next.splice(at, 0, nextColor)
    selectedStop = at
    commitCustomStops(next, at)
  }

  function removeCustomStop () {
    const stops = currentRawStops()
    if (stops.length <= CUSTOM_MIN) return
    const next = [...stops]
    next.splice(Math.min(selectedStop, next.length - 1), 1)
    selectedStop = Math.min(selectedStop, next.length - 1)
    commitCustomStops(next, selectedStop)
  }

  function moveCustomStop (from, to) {
    const stops = currentRawStops()
    if (from < 0 || from >= stops.length || to < 0 || to >= stops.length || from === to) return
    const next = [...stops]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    selectedStop = to
    commitCustomStops(next, to)
  }

  function commitSelectedColor (hex) {
    const stops = currentRawStops()
    const next = [...stops]
    next[Math.min(selectedStop, next.length - 1)] = hex
    commitCustomStops(next, selectedStop)
  }

  function renderCustomStrip (config) {
    const stops = effectiveRainbowStops(config)
    selectedStop = Math.max(0, Math.min(selectedStop, stops.length - 1))
    customStrip.textContent = ''
    for (let index = 0; index < stops.length; index += 1) {
      const hex = stops[index]
      const button = h('button', {
        type: 'button',
        class: 'tc-stop' + (index === selectedStop ? ' active' : ''),
        style: { background: hex },
        title: `色块 ${index + 1} · ${hex} · 拖动排序`,
        'aria-label': `色块 ${index + 1} ${hex}`,
        'aria-pressed': index === selectedStop,
        draggable: 'true'
      }, h('span', { class: 'tc-stop-grip', text: '⠿' }))
      button.addEventListener('click', () => {
        selectedStop = index
        sync()
      })
      button.addEventListener('dragstart', (event) => {
        dragStop = index
        button.classList.add('dragging')
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', String(index))
        }
      })
      button.addEventListener('dragover', (event) => {
        event.preventDefault()
        button.classList.add('drag-over')
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
      })
      button.addEventListener('dragleave', () => button.classList.remove('drag-over'))
      button.addEventListener('drop', (event) => {
        event.preventDefault()
        button.classList.remove('drag-over')
        if (dragStop >= 0) moveCustomStop(dragStop, index)
        dragStop = -1
      })
      button.addEventListener('dragend', () => {
        button.classList.remove('dragging')
        dragStop = -1
        for (const el of customStrip.querySelectorAll('.drag-over')) el.classList.remove('drag-over')
      })
      customStrip.append(button)
    }
    const plus = h('button', {
      type: 'button',
      class: 'tc-strip-add',
      text: '+',
      title: stops.length >= CUSTOM_MAX ? '最多 12 个色块' : '添加色块',
      onclick: () => addCustomStop()
    })
    plus.disabled = stops.length >= CUSTOM_MAX
    customStrip.append(plus)

    customCount.textContent = `${stops.length} 色`
    addButton.disabled = stops.length >= CUSTOM_MAX
    removeButton.disabled = stops.length <= CUSTOM_MIN
    closeRainbowButton.style.display = config.mode === 'rainbow' ? '' : 'none'
    forkButton.style.display = config.rainbow.preset === 'custom' ? 'none' : ''
    customCard.classList.toggle('is-custom', config.rainbow.preset === 'custom')
    customHint.textContent = config.rainbow.preset === 'custom'
      ? '正在使用自定义色带。拖动色块排序；点选色块后，用下方 RGB 色盘替换颜色。'
      : `当前为预设「${presetLabel(config)}」；任何增删、拖动或改色都会自动转为自定义。`
    hueInput.disabled = config.rainbow.preset === 'custom'
    hueValue.textContent = config.rainbow.preset === 'custom' ? '自定义' : config.rainbow.hue + '°'
  }

  function syncWheel (config) {
    const stops = effectiveRainbowStops(config)
    selectedStop = Math.max(0, Math.min(selectedStop, stops.length - 1))
    const hex = (stops[selectedStop] || '#ffffff').toLowerCase()
    const hsv = colorToHsv(hex)
    wheelHsv = hsv
    const angle = hsv.h * Math.PI / 180
    const distance = hsv.s * 50
    wheelMarker.style.left = `${50 + Math.cos(angle) * distance}%`
    wheelMarker.style.top = `${50 + Math.sin(angle) * distance}%`
    wheelPreview.style.background = hex
    wheelHex.textContent = hex.toUpperCase()
    const rgb = parseHex(hex) || [255, 255, 255]
    wheelRgb.textContent = `R ${rgb[0]} · G ${rgb[1]} · B ${rgb[2]}`
    wheelBrightness.value = String(Math.round(hsv.v * 100))
    wheelBrightnessValue.textContent = `${Math.round(hsv.v * 100)}%`
  }

  function presetLabel (config) {
    const saved = getCustomRainbowPresets().find((preset) => preset.id === config.rainbow.preset)
    return saved ? saved.name : (PRESET_NAMES[config.rainbow.preset] || '光谱')
  }

  function renderSavedPresets (config) {
    const presets = getCustomRainbowPresets()
    savedPresetGrid.textContent = ''
    savedPresetEmpty.hidden = presets.length > 0
    for (const preset of presets) {
      const active = config.rainbow.preset === preset.id
      const button = h('button', {
        type: 'button',
        class: 'tc-preset tc-saved-preset-btn' + (active ? ' active' : ''),
        title: preset.name,
        onclick: () => {
          setTextColorConfig({ mode: 'rainbow', rainbow: { preset: preset.id, hue: 0 } })
          sync()
        }
      },
      h('span', {
        class: 'tc-band',
        style: { backgroundImage: `linear-gradient(90deg, ${preset.stops.concat([preset.stops[0]]).join(', ')})` }
      }),
      h('span', { class: 'tc-preset-name', text: preset.name })
      )
      const remove = h('button', {
        type: 'button',
        class: 'tc-preset-del',
        text: '×',
        title: `删除预设「${preset.name}」`,
        'aria-label': `删除预设 ${preset.name}`,
        onclick: (event) => {
          event.stopPropagation()
          const active = getTextColorConfig().rainbow.preset === preset.id
          deleteCustomRainbowPreset(preset.id)
          /* 删除正在使用的预设时保留当前颜色，退回可编辑的自定义色带。 */
          if (active) {
            setTextColorConfig({
              mode: 'rainbow',
              rainbow: { preset: 'custom', customStops: preset.stops, hue: 0 }
            })
          }
          sync()
        }
      })
      savedPresetGrid.append(h('div', { class: 'tc-saved-preset' }, button, remove))
    }
  }

  function pickWheelColor (event) {
    const rect = wheelCanvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const x = (event.clientX - rect.left) / rect.width - 0.5
    const y = (event.clientY - rect.top) / rect.height - 0.5
    const distance = Math.sqrt(x * x + y * y)
    const radius = Math.min(0.5, distance)
    const scale = distance > 0 ? radius / distance : 0
    const px = x * scale
    const py = y * scale
    const hue = (Math.atan2(py, px) * 180 / Math.PI + 360) % 360
    const saturation = Math.min(1, distance / 0.5)
    wheelHsv = { h: hue, s: saturation, v: wheelHsv.v }
    commitSelectedColor(hsvToHex(hue, saturation, wheelHsv.v))
  }

  wheelCanvas.addEventListener('pointerdown', (event) => {
    wheelDragging = true
    wheelCanvas.setPointerCapture?.(event.pointerId)
    pickWheelColor(event)
  })
  wheelCanvas.addEventListener('pointermove', (event) => {
    if (wheelDragging) pickWheelColor(event)
  })
  wheelCanvas.addEventListener('pointerup', (event) => {
    wheelDragging = false
    wheelCanvas.releasePointerCapture?.(event.pointerId)
  })
  wheelCanvas.addEventListener('pointercancel', () => { wheelDragging = false })
  wheelBrightness.addEventListener('input', () => {
    const value = Number(wheelBrightness.value) / 100
    wheelHsv.v = value
    commitSelectedColor(hsvToHex(wheelHsv.h, wheelHsv.s, value))
  })

  customCard.append(
    h('div', { class: 'tc-custom-head' },
      h('div', { class: 'tc-custom-head-main' },
        h('div', { class: 'tc-card-title', text: '自定义炫彩条' }),
        customHint
      ),
      h('div', { class: 'tc-custom-actions' },
        customCount,
        forkButton,
        addButton,
        removeButton,
        closeRainbowButton
      )
    ),
    customStrip,
    savePresetRow,
    h('div', { class: 'tc-wheel-row' },
      h('div', { class: 'tc-wheel-wrap' }, wheelCanvas, wheelMarker),
      h('div', { class: 'tc-wheel-side' },
        h('div', { class: 'tc-wheel-meta' }, wheelPreview,
          h('div', {}, wheelHex, wheelRgb)),
        h('div', { class: 'tc-wheel-brightness' },
          h('span', { class: 'tc-wheel-label', text: '明度' }),
          wheelBrightness,
          wheelBrightnessValue
        ),
        h('div', { class: 'hint', text: '点击或拖动色盘选取颜色；明度控制深浅。所选颜色会直接替换当前选中的色块。' })
      )
    )
  )
  section.append(customCard)

  /* 实时预览 */
  const preview = h('div', { class: 'tc-preview' })
  section.append(h('div', { class: 'tc-card tc-preview-card' },
    h('div', { class: 'tc-preview-head' },
      h('span', { text: '预览' }),
      h('span', { class: 'hint', text: '只显示已启用的作用范围' })
    ),
    preview
  ))

  function sync () {
    const config = getTextColorConfig()
    closeButton.style.display = config.mode === 'off' ? 'none' : ''
    masterSwitch.classList.toggle('on', config.mode !== 'off')
    masterSwitch.setAttribute('aria-checked', String(config.mode !== 'off'))
    setActiveButtons(modeSeg.buttons, config.mode)
    for (const scope of SCOPES) {
      const on = config.applyTo[scope.key] === true
      scopeSwitches[scope.key].classList.toggle('on', on)
      scopeSwitches[scope.key].setAttribute('aria-checked', String(on))
    }
    for (const [hex, button] of Object.entries(swatchButtons)) {
      button.classList.toggle('active', config.mode === 'solid' && config.color.toLowerCase() === hex.toLowerCase())
    }
    colorInput.value = config.color
    if (document.activeElement !== hexInput) hexInput.value = config.color
    for (const [id, button] of Object.entries(presetButtons)) {
      button.classList.toggle('active', config.rainbow.preset === id)
    }
    renderSavedPresets(config)
    hueInput.value = String(config.rainbow.hue)
    speedInput.value = String(config.rainbow.speed)
    speedInput.disabled = config.rainbow.motion === 'still'
    speedValue.textContent = config.rainbow.motion === 'still' ? '静止' : config.rainbow.speed + 's'
    setActiveButtons(motionSeg.buttons, config.rainbow.motion)
    widthInput.value = String(config.rainbow.width)
    widthInput.disabled = config.mode !== 'rainbow'
    widthValue.textContent = config.rainbow.width + '%'
    renderCustomStrip(config)
    syncWheel(config)

    preview.textContent = ''
    const enabled = SCOPES.filter((scope) => config.applyTo[scope.key] === true)
    if (!enabled.length) {
      preview.append(h('div', { class: 'hint', text: '当前没有启用任何作用范围，消息保持默认颜色。' }))
    } else {
      for (const scope of enabled) {
        preview.append(h('div', {
          class: 'tc-preview-line',
          text: PREVIEW_TEXT[scope.key],
          style: previewStyle(config)
        }))
      }
    }
    section.classList.toggle('tc-off', config.mode === 'off')
  }

  body.append(section)
  sync()
}
