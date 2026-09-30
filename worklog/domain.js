export const defaults = { enabled: false, scope: 'selected', projects: [], excludedSessions: [], timezone: 'Asia/Shanghai', provider: '', model: '', scheduleEnabled: false, scheduleTime: '23:00' }
export const fail = (message, status = 400) => Object.assign(new Error(message), { status })
export function dayOf(time, timezone) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(time))
  const pick = type => parts.find(p => p.type === type).value
  return `${pick('year')}-${pick('month')}-${pick('day')}`
}
export function validDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) throw fail('Недействительная дата')
  return day
}
export function settings(value) {
  if (!value || typeof value.enabled !== 'boolean' || typeof value.timezone !== 'string') throw fail('Недопустимые настройки сбора')
  try { dayOf(Date.now(), value.timezone) } catch { throw fail('Введите корректный часовой пояс IANA, например Asia/Shanghai') }
  for (const key of ['projects', 'excludedSessions']) {
    if (!Array.isArray(value[key]) || value[key].length > 1000 || value[key].some(v => typeof v !== 'string' || !v.trim() || v.length > 4096)) throw fail('Недопустимая область проекта или сессии')
  }
  const provider = value.provider ?? '', model = value.model ?? ''
  const scope = value.scope ?? 'selected'
  const scheduleEnabled = value.scheduleEnabled === undefined ? false : value.scheduleEnabled
  const scheduleTime = value.scheduleTime === undefined ? '23:00' : value.scheduleTime
  if (typeof scheduleEnabled !== 'boolean' || typeof scheduleTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(scheduleTime)) throw fail('Недопустимое время ежедневной обработки, выберите 00:00–23:59')
  if (!['all', 'selected'].includes(scope)) throw fail('Недопустимая область сбора')
  if (typeof provider !== 'string' || typeof model !== 'string' || provider.length > 256 || model.length > 256 || !!provider.trim() !== !!model.trim()) throw fail('Провайдер и ID модели нужно заполнить вместе или оставить пустыми вместе')
  return { enabled: value.enabled, scope, timezone: value.timezone, projects: [...new Set(value.projects.map(p => p.trim()))], excludedSessions: [...new Set(value.excludedSessions)], provider: provider.trim(), model: model.trim(), scheduleEnabled, scheduleTime }
}
export function text(value, max = 100000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(`Введите содержимое, не более ${max} символов`)
  return value.trim()
}
export function capture(session, turn, config, now = Date.now()) {
  const project = session.header.cwd || ''
  if (!config.enabled || (config.scope !== 'all' && !config.projects.includes(project)) || config.excludedSessions.includes(session.id)) return null
  const events = session.snapshotEvents()
  const start = events.findLastIndex(e => e.type === 'turn/start' && e.data.turn === turn)
  if (start < 0) return null
  const end = events.findIndex((e, i) => i > start && e.type === 'turn/start')
  const slice = events.slice(start, end < 0 ? undefined : end)
  const messageText = m => (m?.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('\n')
  const user = slice.filter(e => e.type === 'user/message' && e.data.source?.kind === 'user').map(e => messageText(e.data)).join('\n')
  const assistant = slice.filter(e => e.type === 'assistant/message' && e.data.turn === turn).map(e => e.data.message).findLast(m => messageText(m))
  if (!user || !assistant) return null
  const answer = messageText(assistant)
  return { id: `${session.id}:${turn}`, day: dayOf(now, config.timezone), time: now, project, sessionId: session.id, turn,
    user: user.slice(0, 16000), answer: answer.slice(0, 32000), truncated: user.length > 16000 || answer.length > 32000,
    route: assistant.source?.provider && assistant.source?.model ? { provider: assistant.source.provider, model: assistant.source.model } : null }
}
