export async function api(path, data, signal) {
  const response = await fetch(`/worklog-control/v1${path}`, {
    method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', signal,
    headers: { 'x-dsh-worklog-client': 'workspace', ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  })
  const raw = await response.text()
  let result
  try { result = JSON.parse(raw) } catch { throw new Error(`Интерфейс журнала работы вернул HTTP ${response.status}，Проверьте плагин и маршрут удалённого доступа.`) }
  if (!response.ok) throw new Error(result.error || `Запрос не выполнен (${response.status})`)
  return result
}

