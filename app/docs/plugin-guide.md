# 星界插件开发参考

这份文档同时给人和 AI 用。编写插件时以本文为准；文中没有出现的 API 就不存在，不要臆造。

当前插件 API 版本：`1`。外部插件不受来源限制，但必须使用 `"runtime": "isolated"`；旧版渲染层运行时已限制。

## 一、最小插件

```
config/plugins/<插件 id>/
├─ plugin.json     必需
└─ plugin.js       必需（或在 manifest 的 entry 里改名）
```

`plugin.json`

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "description": "一句话说明它做什么",
  "entry": "plugin.js",
  "runtime": "isolated",
  "permissions": [],
  "author": "你"
}
```

`plugin.js`

```js
export default function setup (astral) {
  astral.log('已加载')
}
```

要点：

- 入口**必须默认导出**一个函数，星界启动时调用一次；
- 隔离运行时里是标准 ES 模块，但**不能 import 其他模块**（源码以 Blob module 执行）；
- 放在 `config/plugins/` 下即可，无需构建、无需注册；`Ctrl+R` 重载窗口生效；
- `app/plugins/` 是内置插件目录；同 `id` 时 `config/` 覆盖 `app/`。

## 二、manifest 字段

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `id` | 是 | 唯一标识，只能包含字母、数字、下划线、短横线；重复时后者覆盖前者 |
| `name` | 否 | 显示名，缺省用 `id` |
| `version` | 否 | 显示在右侧「插件」面板 |
| `entry` | 否 | 入口文件，默认 `plugin.js` |
| `description` | 否 | 面板里的一行说明 |
| `author` | 否 | 作者 |
| `defaultEnabled` | 否 | 默认是否启用，默认 `true` |
| `apiVersion` | 否 | 插件 API 版本，当前只支持 `1` |
| `permissions` | 否 | 声明使用的 API 权限，见下文；新插件必须写最小集合 |
| `settings` | 否 | 通用插件设置表单的字段定义，见下文 |
| `runtime` | 否 | 只接受 `"isolated"`（无同源权限的 iframe 沙箱）；缺省或写 `"legacy"` 属于旧版运行时，已限制加载 |

用户可在右侧「插件」面板单独启停；**启停会即时加载/卸载，不再重载页面**。

### 权限

```json
"permissions": ["ui.dock", "hooks", "settings"]
```

| 权限 | 允许使用的 API |
| --- | --- |
| `ui.dock` | `astral.ui.registerDockPane` |
| `hooks` | `astral.on` |
| `skills` | `astral.skills.register` |
| `themes` | `astral.themes.register` |
| `messages` | `astral.messages.inject` |
| `settings` | `astral.settings.get/set/onChange` |
| `knowledge` | `astral.knowledge.call/pickDir` |
| `chat` | `astral.chat.submit` |
| `clipboard` | `astral.clipboard.write` |

未声明的 API 会直接抛错或拒绝请求，插件加载失败并在插件面板显示原因。  
`astral.ui.modal` / `astral.ui.confirm` / `astral.project` 属于基础能力，不需要单独声明权限。

老插件没有 `permissions` 字段时按 `["*"]` 兼容，面板会显示「旧版权限」；但缺省 `runtime` 的老插件属于旧版运行时，会被限制加载，见下文。外部插件改用 `runtime: "isolated"` 后不受来源限制。

## 三、隔离沙箱运行时

manifest 写 `"runtime": "isolated"` 后，插件在 `sandbox="allow-scripts"` 的 iframe 中运行：

- 不能访问主界面 DOM、`window.Astral`、应用状态、API Key 或网络；
- 插件源码通过 iframe 内的 Blob module 执行，**不能 import 其他模块**；
- 不提供 `astral.getState`、`astral.bus`；
- 可用：`log`、`toast`、`h`、`settings`、`project`、`chat`、`clipboard`、`themes.register`、`skills.register`、`messages.inject`、`on`、`ui`、`knowledge`；
- 宿主会把应用样式与当前主题变量注入 iframe，插件用同一套组件类，外观与主界面一致；
- iframe 的 CSP 禁止网络和图片，允许内联样式；脚本只允许内联与 Blob。

### UI 与主题

宿主注入 `tokens.css`（全局重置、变量）与 `app.css`（组件类），并随主题切换推送新的 CSS 变量。可以复用这些稳定类：

`btn` / `btn ghost` / `btn primary` / `btn danger` / `btn-row` / `input` / `select` / `textarea` / `label` / `hint` / `field` / `field-row` / `field-row-3` / `pane-title` / `dock-empty`。

其余应用内部类（例如 `kb-*`）不保证跨版本稳定；第三方插件最好在 iframe 内自己补一小段 `<style>`，只复用变量（`var(--fg-1)`、`var(--accent)` 等）。

### dock 面板的生命周期

`astral.ui.registerDockPane({ id, label, order, render })`

- 一个隔离插件可以注册**多个** dock 面板（每个面板 id 唯一）；
- 每个 `render(host)` 在插件加载时调用**一次**，宿主不会在切换面板时销毁 iframe 或重建 DOM；
- 面板切走只是隐藏当前面板 DOM，其他面板的状态（查询词、滚动位置、缓存）会保留；
- 面板宽度会随右侧 dock 拖动变化，宿主自动同步尺寸；
- 返回值是卸载函数，插件停用时宿主会自动移除面板。

```js
astral.ui.registerDockPane({
  id: 'my-pane',
  label: '我的面板',
  order: 10,
  render (host) {
    host.classList.add('dock-body', 'plugin-pane-mode')
    host.append(astral.h('div', { class: 'dock-empty', text: '这里是我的面板' }))
  }
})
```

### 弹层：`astral.ui.modal`

打开一个应用风格的弹层。弹层打开时宿主把整个 iframe 提升到全窗口（sheet），因此不需要自己处理宽度或遮罩。

```js
const modal = astral.ui.modal({
  title: '编辑条目',
  sub: '可选副标题',
  width: 760,                       // 最大宽度，窄窗口会自动收
  onClose: () => {},                // 点击遮罩/关闭/按 Esc 时触发
  render (body) {
    const input = astral.h('input', { class: 'input', placeholder: '标题' })
    body.append(
      astral.h('div', { class: 'field' },
        astral.h('label', { class: 'label', text: '标题' }),
        input
      ),
      astral.h('div', { class: 'btn-row' },
        astral.h('button', {
          class: 'btn primary',
          type: 'button',
          text: '保存',
          onclick: () => modal.close()
        }, '保存')
      )
    )
  }
})
```

`modal.close()` 关闭弹层，不触发 `onClose`；用户点遮罩 / ✕ / Esc 关闭时触发 `onClose`。只支持同时一个弹层。

### 确认框：`astral.ui.confirm`

返回 `Promise<boolean>`，不会使用浏览器原生 `confirm`：

```js
const ok = await astral.ui.confirm({
  title: '删除 P-003？',
  message: '此操作不可撤销。',
  confirmText: '删除',
  danger: true
})
if (ok) { /* ... */ }
```

### 只读项目上下文

- `astral.project.current()`：返回 `{ id, name }`；
- `astral.project.onChange(fn)`：切换项目时回调，返回卸载函数。

项目根路径不会下发给隔离插件；需要读写项目资料时走 `knowledge` 或主进程已有的受限工具。

### 提交到主对话

`astral.chat.submit(text)` 需要 `chat` 权限。它把文本交给主界面的发送流程，等价于用户在输入框回车；不会绕过权限、审批或工具网关。

```js
astral.chat.submit('请把刚才的结论整理成三个要点。')
```

## 四、API

`setup(astral)` 的参数就是全部能力。以下都挂在 `astral` 上。

### `astral.log(...args)`

带插件标识的控制台输出，等价于 `console.log` 加了前缀。

### `astral.toast(message, kind)`

底部浮条提示。`kind` 可选 `ok` / `err`；不传为普通提示。

### `astral.settings`

需要 `settings` 权限。

- `astral.settings.get()`：返回当前插件配置，已合并 schema 默认值
- `astral.settings.set(patch)`：写入并广播，返回保存后的配置
- `astral.settings.onChange(fn)`：配置变化时回调；返回卸载函数

```js
let config = astral.settings.get()
astral.settings.onChange((next) => { config = next })
```

### `astral.h(tag, attrs, ...children)`

创建 DOM 的辅助函数，写面板 UI 时用。`attrs` 支持 `class`、`text`、`style`（对象）、`dataset`、`onclick` 等事件、其它属性走 `setAttribute`。不提供 `html`，不要往 `innerHTML` 里拼用户数据。

```js
astral.h('div', { class: 'row' },
  astral.h('span', { text: '标题' }),
  astral.h('button', { onclick: () => astral.toast('点了') }, '按钮')
)
```

### `astral.on(event, handler)`

挂请求/回复钩子，返回一个卸载函数，需要 `hooks` 权限。

| 事件 | 载荷 | 返回值 |
| --- | --- | --- |
| `before:request` | `{ agent, messages }` | 可返回 `{ agent, messages }` 覆盖 |
| `after:reply` | `{ agent, text }` | 可返回 `{ text }` 改写回复 |
| `on:message` | `{ message }` | 仅供监听 |

钩子按注册顺序串行执行，前一个的返回值是后一个的输入；抛错会被捕获并打到控制台，不会中断协作。

```js
astral.on('before:request', ({ messages }) => {
  const sys = messages[0]
  if (sys && sys.role === 'system') {
    messages[0] = { ...sys, content: sys.content + '\n当前时间：' + new Date().toLocaleString() }
  }
  return { messages }
})
```

> 注意：`before:request` 对用户↔AI 与 AI↔AI 两条通道都会触发。要只作用于用户侧，请自行判断 `agent` 或消息内容。

### `astral.messages.inject(text, kind)`

往当前对话流插一条消息，需要 `messages` 权限。`kind` 为 `system`（默认，居中提示）或 `agent`。

```js
astral.messages.inject('插件提示：规则已更新')
```

### `astral.skills.register({ id, name, desc, body })`

注册一条技能，需要 `skills` 权限。注册后出现在成员编辑器的技能勾选列表，`body` 会拼进成员提示词。`id` 已存在则跳过。

```js
astral.skills.register({
  id: 'brief-style',
  name: '简报体',
  desc: '先结论、后论据',
  body: '- 第一行必须是结论\n- 论据不超过三条'
})
```

### `astral.themes.register(theme)`

注册主题，需要 `themes` 权限，立即出现在 设置 → 外观。

```js
astral.themes.register({
  id: 'sand',
  name: '星砂',
  desc: '暖沙配色',
  tokens: { '--bg-0': '#0a0906', '--accent': '#e6c078' },
  motion: { speed: 1.15 },
  art: { starfield: true, aurora: true, grain: true }
})
```

可用 token 见 `app/css/tokens.css` 的 `:root`。同 `id` 会替换。

### `astral.knowledge`

需要 `knowledge` 权限；数据经主进程知识库服务读写当前项目。

- `astral.knowledge.call(action, args)`：`browse` / `search` / `guide` / `get` / `add` / `update` / `remove` / `prune` / `init` / `describe` / `config` / `saveConfig` / `resetConfig` / `inject`
- `astral.knowledge.pickDir()`：打开系统目录选择器

```js
const list = await astral.knowledge.call('browse', {})
const guide = await astral.knowledge.call('guide', { task: '改插件运行时', limit: 5 })
```

### `astral.clipboard.write(text)`

需要 `clipboard` 权限。由主进程写系统剪贴板，返回 `{ ok: true }`。

### 生命周期与清理

`setup(astral)` 可以返回一个清理函数，也可以返回清理函数数组；隔离运行时的 iframe 卸载会销毁整个页面，宿主也会自动撤销：

- `astral.on`、`astral.ui.registerDockPane`、`astral.settings.onChange`、`astral.project.onChange` 返回的卸载函数
- 主题、技能注册
- 设置监听

停用插件会移除它的面板、钩子、主题、技能和设置监听；再次启用会重新加载入口。插件开关即时生效，不需要整页重载。

## 五、完整示例

一个「给所有回复加时间戳，并提供右侧面板」的隔离插件。

`config/plugins/time-tag/plugin.json`

```json
{
  "id": "time-tag",
  "name": "时间戳",
  "version": "1.0.0",
  "description": "在每条回复末尾追加生成时间",
  "entry": "plugin.js",
  "runtime": "isolated",
  "permissions": ["ui.dock", "hooks"]
}
```

`config/plugins/time-tag/plugin.js`

```js
export default function setup (astral) {
  let enabled = true

  astral.on('after:reply', ({ text }) => {
    if (!enabled) return
    return { text: `${text}\n\n—— ${new Date().toLocaleString('zh-CN')}` }
  })

  astral.ui.registerDockPane({
    id: 'time-tag',
    label: '时间戳',
    order: 20,
    render (host) {
      host.classList.add('dock-body', 'plugin-pane-mode')
      const state = astral.h('div', { class: 'dock-empty' })
      const paint = () => {
        state.textContent = enabled ? '已启用：每条回复会带时间' : '已停用'
      }
      paint()
      host.append(state, astral.h('div', { class: 'btn-row', style: { marginTop: '10px' } },
        astral.h('button', {
          class: 'btn ghost',
          onclick: () => { enabled = !enabled; paint(); astral.toast(enabled ? '已启用' : '已停用') }
        }, '切换')
      ))
    }
  })

  astral.log('时间戳插件已加载')
}
```

## 六、旧版运行时的限制

manifest 不写 `runtime`（或写 `"legacy"`）的插件属于旧版渲染层插件。旧版运行时**已限制加载**：

- 它直接在渲染进程里执行，没有沙箱，能读配置、发网络请求、改主界面 DOM；
- 与「主进程权威」的安全目标冲突，因此没有「放行旧版插件」的开关；
- 星界仍会读出这类 manifest，在插件面板标成「旧版 · 已限制」并显示迁移提示，但**不会执行入口代码**，面板开关为禁用状态。

这条限制**只针对旧版运行时，不针对外部插件**：

- 外部插件可以放在 `config/plugins/`，来源、数量和作者都不受限制；
- 只要 manifest 写 `"runtime": "isolated"`，就会正常加载，不需要审核或白名单；
- 旧 manifest 留在目录里不会阻断启动，也不会获得执行机会；迁移后即可恢复加载。

先跑 `node scripts/migrate-plugins.js` 扫描现有插件，会列出旧版条目、检测到的旧 API 与迁移提示；`--template` 输出最小迁移模板。完整对照表见 [`docs/plugin-migration.md`](../../docs/plugin-migration.md)。

### 迁移检查表

1. `plugin.json` 写 `"runtime": "isolated"`，补最小 `permissions`；
2. 去掉 `import` 主界面模块（`core.js`、`modal.js` 等），改用 `astral.h` / `astral.ui.modal` / `astral.toast`；
3. `state` / `astral.getState` / `astral.bus` → 用 `astral.project`、`astral.settings` 或自定义模块状态；
4. `openModal` / `closeModal` → `astral.ui.modal` / `astral.ui.confirm`；
5. `window.Astral.submit` → `astral.chat.submit`；
6. 直接操作主界面 DOM → 改成 dock 面板内自己的 DOM；
7. `ui.registerDockPane` 的 `render` 现在只调用一次，状态可以放心放在模块作用域；
8. 改完重载窗口，在插件面板确认状态为「隔离沙箱 · 已启用」。

迁移后的插件不能假设旧版能力仍然存在；需要文件、命令、网络等能力时，走对应的受限 API 或主进程工具。

## 七、调试

- 右侧面板 → **插件**：列出插件、版本、运行时（隔离沙箱 / 旧版已限制）、来源（内置/用户）与加载错误；
- 改完代码 `Ctrl+R` 重载窗口即可，不必重启应用；
- 需要看堆栈时 `Ctrl+Shift+I` 打开开发者工具；
- 插件加载失败**不会阻断启动**，错误只出现在插件面板与控制台。

## 八、边界与安全

- `runtime: "isolated"` 的插件在无同源权限的 iframe 中运行，不能访问主界面、应用状态或 API Key；
- 旧版渲染层运行时已限制加载：没有沙箱的插件不会再获得执行机会，也没有全局放行开关；
- **外部插件不受来源限制**：`config/plugins/` 下的第三方插件只要声明 `runtime: "isolated"` 就会正常加载；
- `permissions` 是 **API 层声明与校验**，不是操作系统级沙箱；
- 主渲染进程现在不再持有供应商 API Key，隔离插件也读不到窗口状态；
- 不要依赖未在本文出现的内部函数、私有字段或 CSS 类名，升级可能变动；
- 面板里插入用户数据时用 `textContent` 或 `h(..., { text })`，不要拼 `innerHTML`。

## 九、常见错误

| 现象 | 原因 |
| --- | --- |
| 插件面板里显示加载错误 | 没有 `export default`，或入口文件名与 `entry` 不一致 |
| `require is not defined` | 用了 CommonJS，改成 ES module 的 `export default` |
| 面板标签不出现 | `registerDockPane` 的 `id` 重复，或没传 `render` 函数 |
| 改了代码没变化 | 没重载窗口（`Ctrl+R`），或插件被用户在设置里停用 |
| 钩子不生效 | `astral.on` 的事件名写错，或返回结构不是 `{ messages }` / `{ text }` |
| `失败：插件「x」未声明 y 权限` | manifest 的 `permissions` 没写对应权限 |
| 旧版插件显示「运行时已限制」 | 旧版渲染层运行时不再执行；外部插件改用 `runtime: "isolated"` 并按沙箱 API 改写即可加载 |
| 外部插件不加载 | 检查 manifest 是否写了 `runtime: "isolated"`；旧版/缺省 runtime 会被限制 |
| 弹层打开后界面被整个盖住 | 这是 sheet 设计：弹层期间 iframe 覆盖窗口，关闭后恢复 dock 尺寸 |
