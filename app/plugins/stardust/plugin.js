/**
 * 星砂 · 示例插件
 * 演示三种扩展点：主题注册、技能注册、回复钩子。
 * 把这个目录整体复制到 config/plugins/ 下同样可用，且优先级高于内置插件。
 */

export default function setup (astral) {
  astral.log('星砂插件已加载')
  let config = astral.settings.get()
  astral.settings.onChange((next) => { config = next })

  // 1. 注册一套主题（会出现在 设置 → 外观 里）
  astral.themes.register({
    id: 'sand',
    name: '星砂',
    desc: '由插件提供的暖沙配色，低对比、护眼。',
    tokens: {
      '--bg-0': '#0a0906',
      '--bg-1': '#0f0d09',
      '--bg-2': '#17130d',
      '--fg-0': '#f4ead6',
      '--fg-1': '#bda98a',
      '--fg-2': '#7a6b52',
      '--accent': '#e6c078',
      '--accent-2': '#d99b63',
      '--ok': '#a9c98a',
      '--warn': '#e8b567',
      '--err': '#e08a7a',
      '--radius': '13px',
      '--radius-sm': '9px'
    },
    motion: { speed: 1.15 },
    art: { starfield: true, aurora: true, grain: true }
  })

  // 2. 注册一个技能，之后可以在成员编辑器里勾选
  astral.skills.register({
    id: 'brief-style',
    name: '简报体',
    desc: '先结论、后论据，三段以内',
    body: [
      '- 第一行必须是结论，独立成句。',
      '- 论据不超过三条，每条一行。',
      '- 需要展开的内容放到「补充」小节，默认不超过两百字。'
    ].join('\n')
  })

  // 3. 回复钩子：成员产出为空时兜底，避免出现空气泡
  astral.on('after:reply', ({ text, agent }) => {
    if (text && text.trim()) return
    const fallback = String(config.fallbackText || '').trim() || '本轮没有产出内容；可能是模型只返回了思考/派单内容，或响应被截断。'
    return { text: `（${agent.name} ${fallback.replace(/^（|）$/g, '')}）` }
  })
}
