# 旧版插件迁移

星界只限制旧版渲染层运行时；外部插件本身不受来源限制。把插件迁到 `runtime: "isolated"` 后即可正常加载。

## 先扫描

```bash
node scripts/migrate-plugins.js
# 或
npm run migrate:plugins
```

扫描 `config/plugins/` 与 `app/plugins/`，列出旧版插件、检测到的旧 API 和迁移提示。

- `--json`：给脚本/CI 用的 JSON。
- `--strict`：发现旧版插件时退出码 1。
- `--template`：打印一份最小迁移模板。

扫描不会修改任何插件文件。

## 迁移对照

| 旧版用法 | 隔离沙箱替代 |
| --- | --- |
| `import { state, bus, h } from '../../js/core.js'` | 改用 `astral.h`；状态放模块作用域 |
| `window.Astral.submit(text)` | `astral.chat.submit(text)`（需要 `chat` 权限） |
| `openModal({...})` / `closeModal()` | `astral.ui.modal({...})` / `modal.close()` |
| `confirm(...)` | `await astral.ui.confirm({...})` |
| `astral.getState()` / `astral.bus` | `astral.project` / `astral.settings` / 自己的状态 |
| 直接操作主界面 DOM | 只能操作自己 dock 面板里的 DOM |
| `ui.registerDockPane` + 主界面类 | 保留；样式由宿主注入，复用 `btn` / `input` / `field` 等类 |
| 旧 manifest 无 `runtime` | 加 `"runtime": "isolated"` 与最小 `permissions` |

## 最小迁移模板

`node scripts/migrate-plugins.js --template` 会输出完整两个文件；也可以直接看 [插件开发参考](plugin-guide.md) 的「隔离沙箱运行时」与「完整示例」。

## 迁移后检查

1. 重载窗口（`Ctrl+R`）。
2. 右侧「插件」面板应显示「隔离沙箱 · 已启用」。
3. 确认没有 `权限` / `import` / `DOM` 报错。
4. 旧 manifest 文件可以删除或留在原目录；留着不会阻断启动，但会一直显示「旧版 · 已限制」。

## 为什么限制旧版运行时

旧版插件直接在主渲染进程里执行，没有沙箱，能读写界面与配置。限制的是这条运行时通道，不是外部插件来源；用 `isolated` 的新插件不需要审核或白名单。
