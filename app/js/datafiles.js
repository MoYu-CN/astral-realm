/* datafiles.js — 数据权限文件：上传、校验、状态反馈、与权限关联保存

   文件正文落在 config/data/ 下（由主进程写入），元数据与权限关联存在
   settings.dataFiles 里：{ id, name, ext, size, path, perms: [], ts }。
   perms 记录的是「这个文件授权给哪些能力」，成员只有拿到对应权限才看得见。 */

import { state, bus, h, persist, toast } from './core.js'
import { icon } from './icons.js'
import { popoverSection, togglePopover } from './popover.js'
import { PERMS, PERM_KEYS, permByKey, effectivePerms, isFullAuth } from './permissions.js'

/* 与主进程 TEXT_EXT / BINARY_EXT 保持一致，前端先拦一遍，省掉一次无谓的往返 */
const TEXT_EXT = [
  '.json', '.jsonl', '.jsonc', '.csv', '.tsv', '.txt', '.md', '.markdown',
  '.yaml', '.yml', '.toml', '.ini', '.xml', '.svg', '.sql', '.log', '.env'
]
const BINARY_EXT = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'
]
const DATA_EXT = [...TEXT_EXT, ...BINARY_EXT]
const MAX_BYTES = 5 * 1024 * 1024
const EXT_HINT = '图片 jpg / jpeg / png / gif / webp / bmp / svg，文档 pdf / doc / docx / xls / xlsx / ppt / pptx，文本与数据 txt / md / csv / json / xml / yaml / toml 等'

export function dataFiles () {
  if (!Array.isArray(state.settings.dataFiles)) state.settings.dataFiles = []
  return state.settings.dataFiles
}

function commit () {
  persist.settings()
  bus.emit('datafiles:changed')
}

export function formatBytes (bytes) {
  const n = Number(bytes || 0)
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

/* ------------------------------------------------------------ 上传流程 */

/* status 回调：null 表示无状态（取消），否则 { stage, text }
   stage: picking | uploading | done | error */
export async function uploadDataFile (status = () => {}) {
  if (!window.astral.pickDataFile) throw new Error('当前环境不支持上传文件')

  status({ stage: 'picking', text: '选择文件中…' })
  const picked = await window.astral.pickDataFile()
  if (!picked) { status(null); return null }

  const ext = String(picked.ext || '').toLowerCase()
  if (!DATA_EXT.includes(ext)) {
    throw new Error(`不支持的类型 ${ext || '（无扩展名）'}，允许：${EXT_HINT}`)
  }
  if (Number(picked.size) > MAX_BYTES) {
    throw new Error(`${formatBytes(picked.size)} 超过 5MB 上限`)
  }
  if (!Number(picked.size)) throw new Error('文件为空')

  status({ stage: 'uploading', text: `上传中… ${picked.name}` })
  const payload = { name: picked.name, ext }
  if (picked.kind === 'binary') payload.data = picked.data
  else payload.text = picked.text
  const res = await window.astral.saveDataFile(payload)
  if (!res || !res.ok) throw new Error((res && res.error) || '保存失败')

  const file = {
    id: res.file.id,
    name: res.file.name,
    ext: res.file.ext,
    size: res.file.size,
    path: res.file.path,
    ts: res.file.ts || Date.now(),
    /* 新上传的文件默认挂到「读取文件」上，用户可随时改 */
    perms: ['readFiles']
  }
  dataFiles().push(file)
  commit()
  status({ stage: 'done', text: `已保存 · ${file.name}` })
  return file
}

export async function removeDataFile (file) {
  if (window.astral.deleteDataFile) {
    const res = await window.astral.deleteDataFile({ path: file.path }).catch(() => ({ ok: false }))
    if (res && res.ok === false && res.error) toast(`删除失败：${res.error}`, 'err')
  }
  const list = dataFiles()
  const idx = list.findIndex((f) => f.id === file.id)
  if (idx >= 0) list.splice(idx, 1)
  commit()
}

function toggleFilePerm (file, key, on) {
  const set = new Set(file.perms || [])
  if (on) set.add(key)
  else set.delete(key)
  file.perms = [...set]
  commit()
}

/* -------------------------------------------------------------- 列表 */

/* 列表渲染被工具条浮层和设置页共用 */
export function renderDataList (container, opts = {}) {
  const onStatus = opts.onStatus || (() => {})
  const list = container.querySelector('.data-list')
  if (!list) return
  list.textContent = ''

  const files = dataFiles()
  if (!files.length) {
    list.append(h('div', { class: 'data-empty', text: '还没有上传任何数据文件。上传后可以在这里把它和具体权限绑定。' }))
    return
  }

  for (const file of files) {
    const chips = h('div', { class: 'perm-chips' })
    for (const key of PERM_KEYS) {
      const perm = permByKey(key)
      const on = (file.perms || []).includes(key)
      chips.append(h('button', {
        class: 'perm-chip' + (on ? ' on' : ''),
        type: 'button',
        title: perm ? perm.desc : '',
        onclick: () => { toggleFilePerm(file, key, !on); renderDataList(container, opts) }
      }, perm ? perm.label : key))
    }

    list.append(h('div', { class: 'data-row' },
      h('div', { class: 'data-head' },
        h('span', { class: 'data-ico' }, icon('file', 13)),
        h('span', { class: 'data-name', text: file.name, title: file.path }),
        h('span', { class: 'data-size', text: formatBytes(file.size) }),
        h('button', {
          class: 'data-del',
          type: 'button',
          title: '删除这个文件',
          onclick: async () => {
            await removeDataFile(file)
            renderDataList(container, opts)
            onStatus({ stage: 'done', text: `已删除 · ${file.name}` })
          }
        }, icon('close', 11))
      ),
      chips,
      (file.perms || []).length
        ? null
        : h('div', { class: 'data-warn', text: '未关联任何权限，成员看不到这个文件' })
    ))
  }
}

/* 设置页里的一整段：上传入口 + 状态条 + 列表 */
export function dataFilesSection () {
  const box = h('div', { class: 'data-panel' })
  const statusEl = h('div', { class: 'data-status', hidden: true })

  const setStatus = (info) => {
    if (!info) { statusEl.hidden = true; statusEl.textContent = ''; return }
    statusEl.hidden = false
    statusEl.className = `data-status ${info.stage}`
    statusEl.textContent = ''
    if (info.stage === 'uploading' || info.stage === 'picking') {
      statusEl.append(h('i', { class: 'spin' }))
    }
    statusEl.append(h('span', { text: info.text }))
  }

  const upload = async () => {
    try {
      const file = await uploadDataFile(setStatus)
      if (file) toast('已上传并保存', 'ok')
      renderDataList(box, { onStatus: setStatus })
      bus.emit('datafiles:changed')
    } catch (err) {
      setStatus({ stage: 'error', text: `上传失败：${err.message}` })
      toast(`上传失败：${err.message}`, 'err')
    }
  }

  box.append(
    h('div', { class: 'data-actions' },
      h('button', { class: 'btn', onclick: upload }, '上传数据文件'),
      h('span', { class: 'hint', text: `支持图片（jpg/png/gif/webp/bmp/svg）、文档（pdf/doc/docx/xls/xlsx/ppt/pptx）与文本数据（txt/md/csv/json/xml 等），单文件 ≤ 5MB` })
    ),
    statusEl,
    h('div', { class: 'data-list' })
  )
  renderDataList(box, { onStatus: setStatus })
  return box
}

/* ---------------------------------------------------------- 工具条入口 */

export function mountDataTool (btn) {
  if (!btn) return
  if (!window.astral.pickDataFile) {
    btn.disabled = true
    btn.title = '当前环境不支持上传文件'
    return
  }

  btn.addEventListener('click', () => {
    const box = h('div', { class: 'data-panel' })
    const statusEl = h('div', { class: 'data-status', hidden: true })

    const setStatus = (info) => {
      if (!info) { statusEl.hidden = true; return }
      statusEl.hidden = false
      statusEl.className = `data-status ${info.stage}`
      statusEl.textContent = ''
      if (info.stage === 'uploading' || info.stage === 'picking') statusEl.append(h('i', { class: 'spin' }))
      statusEl.append(h('span', { text: info.text }))
    }

    const upload = async () => {
      try {
        const file = await uploadDataFile(setStatus)
        if (file) toast('已上传并保存', 'ok')
        renderDataList(box, { onStatus: setStatus })
        bus.emit('datafiles:changed')
      } catch (err) {
        setStatus({ stage: 'error', text: `上传失败：${err.message}` })
        toast(`上传失败：${err.message}`, 'err')
      }
    }

    box.append(popoverSection('数据权限文件'))
    box.append(h('div', { class: 'data-actions' },
      h('button', { class: 'btn', onclick: upload }, '上传'),
      h('span', { class: 'hint', text: '上传后勾选它对应的权限' })
    ))
    box.append(statusEl)
    box.append(h('div', { class: 'data-list' }))
    renderDataList(box, { onStatus: setStatus })

    togglePopover({ anchor: btn, id: 'data', width: 336, content: box })
  })
}

/* ------------------------------------------------------- 提示词里的清单 */

/* 成员能看到哪些文件，取决于它实际拿到的权限 */
export function dataFileManifest (agent) {
  const files = dataFiles()
  if (!files.length) return ''
  const perms = effectivePerms(agent)
  const visible = files.filter((f) => isFullAuth(perms) || (f.perms || []).some((k) => perms[k]))
  if (!visible.length) return ''

  const lines = visible.map((f) => {
    const labels = (f.perms || []).map((k) => (permByKey(k) || {}).label).filter(Boolean)
    return `- ${f.name}（${formatBytes(f.size)}）· 授权：${labels.join('、') || '未关联'}`
  })
  return [
    '## 已授权的数据文件',
    lines.join('\n'),
    '这些文件由用户上传并授权给你。需要时按名称引用，不要凭空编造其中的内容。'
  ].join('\n')
}
