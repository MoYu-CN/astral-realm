/* fold-state.js — 对话列表的自动折叠策略（纯状态，不依赖 DOM）。
 *
 * 规则：
 *   - 最近 3 条非工具消息默认自动展开；
 *   - 第 4 条及更早的消息默认自动折叠；
 *   - 用户手动折叠/展开后保留 foldManual，新消息不会覆盖手动选择；
 *   - 手动折叠的最新消息也保持折叠，直到用户再次展开；
 *   - 消息进出最近 3 条时只改变“自动默认值”，不强行覆盖手动状态。
 */

export const KEEP_EXPANDED = 3

export function normalizeFoldMessages (messages, keep = KEEP_EXPANDED) {
  /* 交接摘要有自己的右上角折叠按钮，不参与「最近 3 条自动展开」策略：
     否则聊几轮后它会被自动折起，而通用折叠条又不适合卡片。 */
  const list = (Array.isArray(messages) ? messages : [])
    .filter((msg) => msg && msg.kind !== 'tool' && msg.kind !== 'handoff')
  const keepCount = Math.max(0, Number(keep) || 0)
  const pinned = new Set(keepCount ? list.slice(-keepCount).map((msg) => msg.id) : [])

  for (const msg of list) {
    const latest = pinned.has(msg.id)
    msg.foldPinned = latest
    if (msg.streaming) {
      msg.folded = false
      continue
    }
    /* 只有没有手动状态（或旧数据没有 folded 布尔值）时才套用自动规则。 */
    if (!msg.foldManual || typeof msg.folded !== 'boolean') {
      msg.folded = !latest
    }
  }
  return pinned
}
