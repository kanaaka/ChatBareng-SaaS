// v0.2.0 — shared formatting helpers (dipecah dari Dashboard.vue, dipakai lintas komponen)

export function getInitials(name) {
  if (!name) return '?'
  const parts = name.split(' ')
  return parts.slice(0, 2).map(p => p[0]?.toUpperCase()).join('')
}

export function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function formatPhone(phone) {
  if (!phone) return ''
  if (phone.length >= 15 || (!phone.startsWith('62') && !phone.startsWith('0') && !phone.startsWith('+'))) {
    return ''
  }
  let cleaned = phone.replace(/^\+/, '')
  if (cleaned.startsWith('62')) {
    const rest = cleaned.slice(2)
    return '+62 ' + rest.slice(0, 3) + '-' + rest.slice(3, 7) + '-' + rest.slice(7, 11)
  }
  if (cleaned.startsWith('0')) {
    const rest = cleaned.slice(1)
    return '+62 ' + rest.slice(0, 3) + '-' + rest.slice(3, 7) + '-' + rest.slice(7, 11)
  }
  return phone
}

export function tagColorClass(color) {
  const map = {
    blue: 'bg-blue-100 text-blue-700',
    green: 'bg-green-100 text-green-700',
    red: 'bg-red-100 text-red-700',
    yellow: 'bg-yellow-100 text-yellow-700',
    purple: 'bg-purple-100 text-purple-700',
    gray: 'bg-gray-100 text-gray-700',
  }
  return map[color] || map.blue
}

export function tagDotClass(color) {
  const map = {
    blue: 'bg-blue-400',
    green: 'bg-green-400',
    red: 'bg-red-400',
    yellow: 'bg-yellow-400',
    purple: 'bg-purple-400',
    gray: 'bg-gray-400',
  }
  return map[color] || map.blue
}

// Escape HTML to prevent XSS in v-html
export function escapeHtml(str) {
  if (!str) return ''
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

// Highlight search term in text (returns HTML string)
export function highlightSearchTerm(text, term) {
  if (!text || !term || term.length < 2) return escapeHtml(text)
  const escaped = escapeHtml(text)
  const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`(${escapedTerm})`, 'gi')
  return escaped.replace(regex, '<mark class="bg-yellow-200 rounded px-0.5">$1</mark>')
}