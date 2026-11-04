/* ask-spec.js — ask_user_question 的纯数据规范化，不依赖 DOM，便于单测。 */

export const ASK_LIMITS = {
  question: 2000,
  context: 1200,
  options: 8,
  label: 200,
  value: 400,
  freeform: 4000
}

export function askText (value, limit) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

export function normalizeOptions (input) {
  if (!Array.isArray(input)) return []
  const out = []
  const seen = new Set()
  for (const item of input) {
    if (out.length >= ASK_LIMITS.options) break
    const raw = item && typeof item === 'object' ? item : { label: item }
    const label = askText(raw.label, ASK_LIMITS.label)
    if (!label) continue
    const value = askText(raw.value, ASK_LIMITS.value) || label
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      label,
      value,
      description: askText(raw.description, 300)
    })
  }
  return out
}
