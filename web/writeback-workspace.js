import { subscribeWritebackChanges } from './writeback-live.js'
/** Local outbox UI. Poll only this view, never reload the knowledge workspace. */
export function createWritebackWorkspace({ element, actionButton, openConfirm, sessionId = '' }) {
  const labels = { queued: 'В очереди', running: 'Запись', failed: 'Ошибка', completed: 'Завершено', cancelled: 'Отменено' }
  let disposed = false, timer, request, offset = 0, busy = false, previous = '', dirty = false
  let failedOnly = false
  const failedButton = actionButton('Только ошибки', () => {
    failedOnly = !failedOnly
    failedButton.setAttribute('aria-pressed', String(failedOnly))
    offset = 0; previous = ''; void refresh()
  }, 'small', { 'aria-pressed': 'false' })
  const message = element('p', { role: 'status' })
  const list = element('div', { class: 'writeback-job-list' })
  const page = element('span', {})
  const filter = element('input', { class: 'input', value: sessionId, placeholder: 'Фильтр по номеру сессии (можно пусто)', 'aria-label': 'Номер сессии' })
  const previousButton = actionButton('Назад', () => { offset = Math.max(0, offset - 50); previous = ''; void refresh() }, 'ghost small')
  const nextButton = actionButton('Вперёд', () => { offset += 50; previous = ''; void refresh() }, 'ghost small')
  const root = element('section', { class: 'writeback-workspace' },
    element('p', {}, 'Локальная очередь записи. В одной сессии задачи идут по порядку; при обрыве сети повтор автоматический, при повторных ошибках можно повторить вручную или отменить. Отмена не убирает уже записанное.'),
    element('div', { class: 'writeback-toolbar' }, filter, actionButton('Фильтр', () => { sessionId = filter.value.trim(); offset = 0; previous = ''; void refresh() }, 'small'), actionButton('Обновить', () => { void refresh() }, 'ghost small')),
    element('div', { class: 'writeback-toolbar' }, failedButton),
    message, list, element('div', { class: 'writeback-toolbar' }, previousButton, page, nextButton))
  async function fetchJson(params, method = 'GET', signal) {
    const response = await fetch(`/knowledge-control/v1/writeback-jobs?${params}`, { method, credentials: 'same-origin', headers: { 'x-dsh-knowledge-client': 'management-web' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || `Не удалось прочитать очередь записи (${response.status})`)
    return data
  }
  async function operate(job, action) {
    if (busy || disposed) return
    busy = true
    request?.abort()
    message.textContent = action === 'cancel' ? 'Запрос отмены…' : 'Отправка повтора…'
    try {
      const result = await fetchJson(new URLSearchParams({ action, sourceKey: job.sourceKey }), 'POST')
      message.textContent = result.summary
      previous = ''
    } catch (error) { message.textContent = error.message }
    finally { busy = false; if (!disposed) void refresh(true) }
  }
  function renderJob(job) {
    const actions = element('div', { class: 'writeback-toolbar' })
    if (job.status === 'failed') actions.append(actionButton('Повторить', () => operate(job, 'retry'), 'small'))
    if (['queued', 'running', 'failed'].includes(job.status)) actions.append(actionButton(job.cancelRequested ? 'Отмена…' : 'Отменить запись', () => openConfirm({ title: 'Отменить эту запись?', message: 'После отмены повтор не выполняется, очередь продолжается. Уже записанное не отменяется.', confirmLabel: 'Отменить запись', danger: true, onConfirm: () => operate(job, 'cancel') }), 'ghost small', { disabled: job.cancelRequested }))
    return element('article', { class: 'writeback-job' },
      element('div', { class: 'writeback-toolbar' }, element('strong', {}, labels[job.status] || job.status), element('span', {}, `Попыток: ${job.attempts}`), actions),
      element('div', { class: 'writeback-job-key', title: job.sourceKey }, job.sourceKey),
      job.createdAt ? element('p', {}, 'Создано ', element('time', { datetime: new Date(job.createdAt).toISOString() }, new Date(job.createdAt).toLocaleString())) : element('p', {}, 'Старые задачи · время создания не записано'),
      element('p', {}, job.summary),
      job.blockedBy ? element('p', {}, `блокирует задача: ${job.blockedBy}`) : null,
      job.nextAttemptAt ? element('p', {}, `Следующая попытка: ${new Date(job.nextAttemptAt).toLocaleString()}`) : null,
      job.error ? element('details', {}, element('summary', {}, 'Причина ошибки'), element('pre', {}, job.error)) : null,
      ...(job.destinations || []).map(destination => element('p', {}, `${destination.knowledgeBaseName} / ${destination.documentTitle || destination.documentId || ''}`)))
  }
  async function refresh(preserveMessage = false) {
    clearTimeout(timer)
    if (disposed || document.hidden || busy) return
    dirty = false
    request?.abort()
    const controller = new AbortController()
    request = controller
    try {
      const data = await fetchJson(new URLSearchParams({ sessionId, offset: String(offset), ...(failedOnly ? { status: 'failed' } : {}) }), 'GET', controller.signal)
      if (disposed || request !== controller) return
      if (offset > 0 && offset >= data.total) { offset = Math.max(0, Math.floor((data.total - 1) / 50) * 50); void refresh(preserveMessage); return }
      const fingerprint = JSON.stringify(data)
      if (fingerprint !== previous) {
        list.replaceChildren(...(data.items.length ? data.items.map(renderJob) : [element('p', {}, failedOnly ? 'В текущем диапазоне нет неудачных задач записи' : 'Задач записи нет')]))
        previous = fingerprint
      }
      page.textContent = `Всего ${data.total} · страница ${Math.floor(offset / 50) + 1}`
      previousButton.disabled = offset === 0
      nextButton.disabled = offset + 50 >= data.total
      if (!preserveMessage) message.textContent = 'Состояние обновляется автоматически'
    } catch (error) { if (!controller.signal.aborted && !disposed) message.textContent = `${error.message}; переподключение автоматически` }
    finally { if (request === controller) { request = undefined; if (!disposed) timer = setTimeout(() => refresh(), dirty ? 0 : 5000) } }
  }
  function visibility() { if (document.hidden) { clearTimeout(timer); request?.abort() } else void refresh() }
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('online', visibility)
  const unsubscribeChanges = subscribeWritebackChanges('management-web', () => { if (request || busy) dirty = true; else void refresh() })
  void refresh()
  return { root, dispose() { disposed = true; clearTimeout(timer); request?.abort(); unsubscribeChanges(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('online', visibility) } }
}
