import { useEffect, useState } from 'react'
import { api } from './api.js'

export function ModelPicker({ provider = '', model = '', onChange, central = false }) {
  const [providers, setProviders] = useState([]), [error, setError] = useState('')
  const [loading, setLoading] = useState(true), [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    api('/models', undefined, controller.signal).then(data => {
      if (!controller.signal.aborted) setProviders(data.providers)
    }).catch(e => { if (!controller.signal.aborted) setError(e.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [revision])
  const value = provider && model ? JSON.stringify([provider, model]) : ''
  const available = providers.some(p => p.id === provider && p.models.some(m => m.id === model))
  return <section>
    <label>Модель обработки журнала<select aria-label="Модель обработки журнала" value={value} disabled={loading} onChange={e => onChange(...(e.target.value ? JSON.parse(e.target.value) : ['', '']))}>
      <option value="">{central ? 'Попросите администратора выбрать центральную модель' : 'Использовать модель локальной сессии центра'}</option>
      {value && !available && <option value={value} disabled>{provider} / {model}（{loading ? 'Загрузка' : 'Сейчас недоступно'}）</option>}
      {providers.map(p => <optgroup key={p.id} label={p.name || p.id}>{p.models.map(m => <option key={m.id} value={JSON.stringify([p.id, m.id])}>{m.name || m.id}</option>)}</optgroup>)}
    </select></label>
    <p className="wl-muted">Выберите из моделей, настроенных в центральном DSH. ID модели отправителя не используется центром напрямую; если есть только удалённые материалы или ручные записи, сначала нужно выбрать модель центра.</p>
    {loading && <p role="status">Получение модели…</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && <button type="button" onClick={() => setRevision(v => v + 1)}>Обновить список моделей</button>}
  </section>
}
