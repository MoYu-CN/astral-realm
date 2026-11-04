/* icons.js — 线性图标集，统一 24 视口、1.6 描边 */

const PATHS = {
  shield: '<path d="M12 3.2l7 2.9v5.4c0 4.2-2.9 7.6-7 9.3-4.1-1.7-7-5.1-7-9.3V6.1l7-2.9z"/>',
  clip: '<path d="M9.2 8.2v6.6a2.8 2.8 0 0 0 5.6 0V6.9a4.6 4.6 0 0 0-9.2 0v8.2"/>',
  chip: '<rect x="7.5" y="7.5" width="9" height="9" rx="2"/><path d="M10.5 3.6v3.9M13.5 3.6v3.9M10.5 16.5v3.9M13.5 16.5v3.9M3.6 10.5h3.9M3.6 13.5h3.9M16.5 10.5h3.9M16.5 13.5h3.9"/>',
  mic: '<rect x="9.2" y="3" width="5.6" height="10.6" rx="2.8"/><path d="M5.4 11.2a6.6 6.6 0 0 0 13.2 0M12 17.8V21"/>',
  spark: '<path d="M12 3.4l1.7 4.9 4.9 1.7-4.9 1.7-1.7 4.9-1.7-4.9-4.9-1.7 4.9-1.7 1.7-4.9z"/><path d="M18.4 15.6l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z"/>',
  send: '<path d="M12 19.4V5M6.2 10.8L12 5l5.8 5.8"/>',
  check: '<path d="M5 12.6l4.6 4.4L19 7.4"/>',
  close: '<path d="M6.4 6.4l11.2 11.2M17.6 6.4L6.4 17.6"/>',
  chevron: '<path d="M6.6 9.4L12 14.6l5.4-5.2"/>',
  file: '<path d="M13.6 3.4H7.4a1.8 1.8 0 0 0-1.8 1.8v13.6a1.8 1.8 0 0 0 1.8 1.8h9.2a1.8 1.8 0 0 0 1.8-1.8V8.2l-4.8-4.8z"/><path d="M13.4 3.6v4.8h4.8"/>',
  db: '<ellipse cx="12" cy="6.2" rx="6.6" ry="2.6"/><path d="M5.4 6.2v11.6c0 1.4 3 2.6 6.6 2.6s6.6-1.2 6.6-2.6V6.2"/><path d="M5.4 12c0 1.4 3 2.6 6.6 2.6s6.6-1.2 6.6-2.6"/>',
  folder: '<path d="M3.6 7.2a1.7 1.7 0 0 1 1.7-1.7h4l2 2h7.4a1.7 1.7 0 0 1 1.7 1.7v8.1a1.7 1.7 0 0 1-1.7 1.7H5.3a1.7 1.7 0 0 1-1.7-1.7V7.2z"/>'
}

export function icon (name, size = 16) {
  const span = document.createElement('span')
  span.className = 'ico'
  span.style.width = `${size}px`
  span.style.height = `${size}px`
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`
  return span
}
