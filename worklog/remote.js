import { fail } from './domain.js'

export function destination(connection) {
  if (connection.backend !== 'remote') return null
  const url = new URL(connection.remoteUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fail('Неверный адрес центральной базы знаний')
  return url.href.replace(/\/+$/, '')
}

export async function requestCentral(connection, method, path, data, query = new URLSearchParams(), signal) {
  const base = destination(connection)
  if (!base || !connection.remoteToken) throw fail('Сначала настройте подключение к центральной базе знаний', 409)
  const controller = new AbortController(), abort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, Math.min(120000, Math.max(1000, connection.remoteTimeoutMs || 15000)))
  try {
    const response = await fetch(`${base}/worklog${path}${query.size ? `?${query}` : ''}`, {
      method, redirect: 'manual', signal: controller.signal,
      headers: { authorization: `Bearer ${connection.remoteToken}`, accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(data) } : {}),
    })
    const chunks = []; let size = 0
    for await (const chunk of response.body || []) {
      size += chunk.length
      if (size > 10 * 1024 * 1024) { controller.abort(); throw fail('Слишком большой ответ центрального журнала', 502) }
      chunks.push(Buffer.from(chunk))
    }
    if (response.status >= 300 && response.status < 400) throw fail('Интерфейс центрального журнала вернул перенаправление, проверьте адрес базы знаний; учётные данные не переданы', 502)
    if (response.status === 404) throw fail('Центральная база знаний пока не поддерживает единый журнал, сначала обновите плагин центра', 502)
    if (response.status === 401 || response.status === 403) throw fail('Недостаточно прав центрального журнала или они истекли, проверьте права токена базы знаний', response.status)
    let value
    try { value = JSON.parse(Buffer.concat(chunks).toString()) } catch { throw fail('Центральный журнал не вернул корректный JSON, проверьте службу центра', 502) }
    if (!response.ok) throw fail(typeof value.error === 'string' ? value.error.slice(0, 500) : 'Запрос к центральному журналу не удался', response.status)
    return value
  } catch (e) {
    if (e.status) throw e
    throw fail('Не удалось подключиться к центральному журналу или истёк тайм-аут; локальные материалы для загрузки сохранены, повторите позже', 502)
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
}
