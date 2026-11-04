# 外部 AI 接入（MCP）

星界可以被别的 AI 操控：列举你的编制、替你下达指令、改写成员提示词、切换主题。

## 架构

```
外部 MCP 客户端  ──stdio──▶  electron/astral-mcp.js  ──HTTP 127.0.0.1:45871──▶  星界（渲染进程）
```

- 应用启动时在本机开一个 JSON-RPC 桥，只监听 `127.0.0.1`，带令牌校验。
- `electron/astral-mcp.js` 是一个独立进程，把 MCP 协议翻译成对桥的调用。
- 令牌写在 `config/settings.json` 的 `bridge.token`，首次启动自动生成。

## 配置 MCP 客户端

在 Claude Desktop 或任意 MCP 客户端的配置里加：

```json
{
  "mcpServers": {
    "astral-realm": {
      "command": "node",
      "args": ["C:\\Astral Realm\\electron\\astral-mcp.js"],
      "env": {
        "ASTRAL_PORT": "45871",
        "ASTRAL_TOKEN": "把 config/settings.json 里的 bridge.token 复制到这里"
      }
    }
  }
}
```

> 设置 → 外部接口 里有「复制配置」按钮，会按你本机的真实路径生成这段 JSON。

## 工具

| 工具 | 作用 |
| --- | --- |
| `astral_list_agents` | 列出编制：id、名称、职级、汇报对象、模型、技能 |
| `astral_send_message` | 下达指令并等待整轮协作完成，返回最终答复 |
| `astral_get_messages` | 读取最近对话 |
| `astral_update_agent` | 改成员属性：提示词、模型、温度、职级、汇报对象、技能 |
| `astral_set_context` | 写全局上下文，或写某个成员的专属上下文 |
| `astral_set_theme` | 切换主题 |
| `astral_status` | 查询是否忙碌、成员数、当前主题 |

### 例子

让外部 AI 派活：

```json
{
  "name": "astral_send_message",
  "arguments": { "text": "评估一下把构建脚本从 npm 换成 pnpm 的收益与风险" }
}
```

指定某个成员直连：

```json
{
  "name": "astral_send_message",
  "arguments": { "agentId": "deputy-eng", "text": "只评估风险，不用给方案" }
}
```

改组编制：

```json
{
  "name": "astral_update_agent",
  "arguments": {
    "id": "exec-review",
    "patch": { "model": "deepseek-reasoner", "temperature": 0.1 }
  }
}
```

## 不用 MCP 也行

桥本身就是普通的 HTTP JSON-RPC，任何能发请求的东西都能直连：

```bash
curl -s http://127.0.0.1:45871/rpc \
  -H "content-type: application/json" \
  -H "x-astral-token: <你的令牌>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"astral.list_agents","params":{}}'
```

健康检查（不需要令牌）：

```bash
curl -s http://127.0.0.1:45871/health
```

方法名与工具名一一对应，把 `astral_list_agents` 换成 `astral.list_agents` 即可。

## 安全

- 桥只绑定 `127.0.0.1`，局域网内其它机器访问不到。
- 令牌校验可通过清空 `bridge.token` 关闭——**不建议**，等于把编制交给本机任意进程。
- `astral_send_message` 会消耗你的模型额度。外部 AI 完全可以循环调用它，请只接你信任的客户端。
- 想彻底关掉：把 `config/settings.json` 的 `bridge.enabled` 设为 `false`，重启。

## 排查

| 现象 | 原因 |
| --- | --- |
| `无法连接星界` | 应用没开，或 `ASTRAL_PORT` 与设置里的端口不一致 |
| `unauthorized` | `ASTRAL_TOKEN` 与 `config/settings.json` 的 `bridge.token` 不匹配 |
| `星界正在处理上一轮指令` | 上一轮协作还没结束，串行等待即可 |
| 工具列表为空 | 客户端没完成 `initialize` 握手，检查客户端版本 |
