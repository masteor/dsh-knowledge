import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { Dialog } from './Dialog.jsx'
import { Settings } from './Settings.jsx'
import { Markdown } from './Markdown.jsx'
import { copyText } from './clipboard.js'
import { SyncStatus } from './SyncStatus.jsx'
import { defaults } from '../domain.js'

const statuses = { queued: 'Ожидает обработки', running: 'Обработка', failed: 'Обработка не удалась', cancelled: 'Отменено', done: 'Обработка завершена' }
export function Workspace({ close, openSession, embedded = false, currentProject = '' }) {
  const [state, setState] = useState(null), [day, setDay] = useState(''), [detail, setDetail] = useState(null)
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const [modal, setModal] = useState(''), [draft, setDraft] = useState(''), [revision, setRevision] = useState(0)
  const [evidence, setEvidence] = useState(null)
  const [search, setSearch] = useState(''), [project, setProject] = useState(''), [dates, setDates] = useState(false)
  const [version, setVersion] = useState(0), scroll = useRef(null), positions = useRef({})
  const time = n => n ? new Intl.DateTimeFormat('zh-CN', { timeZone: state?.config.timezone || 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(n)) : 'Ещё не обработано'
  useEffect(() => {
    const controller = new AbortController(); let timer, lastVersion
    async function load() {
      try {
        if (document.hidden) return
        const update = await api('/version', undefined, controller.signal)
        if (update.version === lastVersion) return
        const next = await api('/state', undefined, controller.signal)
        if (controller.signal.aborted) return
        setState(next)
        setError('')
        if (!day) setDay(next.today)
        else {
          const report = await api(`/day?day=${day}`, undefined, controller.signal)
          if (!controller.signal.aborted) setDetail(report)
        }
        lastVersion = update.version
      } catch (e) {
        lastVersion = undefined
        if (!controller.signal.aborted) {
          setError(e.message)
          try {
            const collector = await api('/collector-state', undefined, controller.signal)
            if (!controller.signal.aborted && collector.remote) setState(previous => ({ ...(previous || {}), days: previous?.days || [], today: previous?.today || '', config: { ...defaults, ...previous?.config, ...collector.capture }, projects: collector.projects, remote: true, centralUnavailable: true, canManage: false }))
          } catch { /* Original central error remains visible; never substitute local reports. */ }
        }
      }
      finally { if (!controller.signal.aborted) timer = setTimeout(load, 6000) }
    }
    load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [day, version])
  useEffect(() => { if (detail?.day === day && scroll.current) scroll.current.scrollTop = positions.current[day] || 0 }, [detail?.day])
  async function act(path, data, done = true) {
    setBusy(true); setError(''); setMessage('')
    try { await api(path, data); setVersion(v => v + 1); if (done) setModal(''); setMessage('Сохранено') }
    catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }
  function select(next) { positions.current[day] = scroll.current?.scrollTop || 0; setDay(next); setDetail(null); setDates(false) }
  function edit() { setDraft(detail.report.markdown); setRevision(detail.report.revision); setModal('edit') }
  function generate() { if (detail.report.edited) setModal('replace'); else act('/generate', { day }) }
  function exportReport() {
    const url = URL.createObjectURL(new Blob([detail.report.markdown], { type: 'text/markdown;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = `Рабочий журнал-${day}.md`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  async function copyReport() { try { await copyText(detail.report.markdown); setMessage('Markdown Скопировано') } catch (e) { setError(e.message) } }
  function visit(sessionId) { try { openSession(sessionId) } catch { setError('Не удалось открыть сессию-источник: возможно, она удалена или заархивирована.') } }
  const localSource = record => !record.sourceId ? !state?.remote : record.sourceId === state?.sourceId
  const active = ['queued', 'running'].includes(detail?.job?.status)
  const records = detail?.records.filter(r => (!project || r.project === project) && (!search || `${r.user}\n${r.answer}`.toLowerCase().includes(search.toLowerCase()))) || []
  const dayList = <nav className="wl-days" aria-label="Дата журнала"><input type="date" aria-label="Выберите дату журнала" value={day} onChange={e => { if (e.target.value) select(e.target.value) }} />{state && [...new Set([state.today, ...state.days])].filter(Boolean).sort().reverse().map(d => <button key={d} aria-current={d === day ? 'date' : undefined} onClick={() => select(d)}><span>{d}</span>{d === state.today && <small>Сегодня</small>}</button>)}</nav>
  return <section className="dsh-worklog wl-workspace">
    <header className="wl-toolbar">{!embedded && <><h1>Журнал работы</h1><span className="wl-muted wl-desktop">ежедневный прогресс с основаниями</span></>}<div className="wl-spacer" />
      <button className="wl-mobile" onClick={() => setDates(true)}>Дата</button><button onClick={() => setModal('settings')} disabled={!state}>Настройки сбора</button>{!embedded && <button onClick={close}>Вернуться к диалогу</button>}
    </header>
    <SyncStatus />
    {error && <div className="wl-error" role="alert">{error}<button onClick={() => { setError(''); setVersion(v => v + 1) }}>Перезагрузить</button></div>}
    <div className="wl-body"><aside>{dayList}</aside><main ref={scroll} onScroll={e => { positions.current[day] = e.currentTarget.scrollTop }}>
      {!state || !detail ? <p className="wl-empty">{state?.centralUnavailable ? 'Центральный журнал временно недоступен, материалы для загрузки на этом устройстве сохранены.' : 'Чтение рабочего журнала…'}</p> : <>
        {!state.config.enabled && <div className="wl-notice">Сбор ещё не включён. Можно сначала добавить ручную запись или выбрать проект в настройках сбора и включить его.</div>}
        <div className="wl-heading"><div><span className="wl-eyebrow">Рабочий журнал</span><h2>{day}</h2><p className="wl-muted">{detail.report.updated ? `Обработано ${time(detail.report.updated)}` : 'Журнал ещё не обработан'}{detail.pending > 0 && ` · ${detail.pending} записей ожидает обработки`}</p></div>
          <div className="wl-actions"><button className="wl-primary" disabled={busy || active || !detail.records.some(r => !r.excluded)} onClick={generate}>{active ? 'Обработка…' : detail.report.markdown ? 'Обновить журнал' : 'Обработать журнал'}</button>
            <button onClick={() => { setDraft(''); setModal('note') }}>Добавить ручную запись</button>
            <details className="wl-more"><summary aria-label="Другие действия с журналом">Ещё</summary><div><button disabled={!detail.report.markdown} onClick={edit}>Редактировать журнал</button><button disabled={!detail.report.markdown} onClick={copyReport}>Копировать Markdown</button><button disabled={!detail.report.markdown} onClick={exportReport}>Экспорт Markdown</button><button disabled={!detail.history.length} onClick={() => setModal('history')}>Прошлые версии</button></div></details>
          </div>
        </div>
        {detail.job && <div className="wl-job" role="status"><span>{statuses[detail.job.status]}{JSON.parse(detail.job.body).error && ` · ${JSON.parse(detail.job.body).error}`}</span>
          {active && <button disabled={busy} onClick={() => act('/cancel', { id: detail.job.id })}>Отмена</button>}
          {['failed', 'cancelled'].includes(detail.job.status) && <button disabled={busy} onClick={generate}>Обработать заново</button>}
        </div>}
        {detail.report.markdown ? <article className="wl-document"><Markdown text={detail.report.markdown} onEvidence={id => { const source = detail.records.find(r => r.id === id); if (source) setEvidence(source); else setError('Этот источник не существует, проверьте его в истории.') }} /></article> : <div className="wl-empty"><h3>Соберите сделанное за сегодня в рабочий журнал</h3><p>Материалы сессий собираются только в выбранных проектах; модель вызывается лишь при обработке и не блокирует чат.</p><p>Записей пока нет？Можно сначала добавить ручную запись.</p></div>}
        <section className="wl-evidence"><header><h3>Записи источников <small>{detail.records.length}</small></h3><span className="wl-muted">для сверки, не означает, что уже выполнено</span></header>
          <div className="wl-filters"><input aria-label="Поиск записей-источников" placeholder="Поиск записей-источников…" value={search} onChange={e => setSearch(e.target.value)} /><select aria-label="Фильтр источников по проекту" value={project} onChange={e => setProject(e.target.value)}><option value="">Источники всех проектов</option>{[...new Set(detail.records.map(r => r.project))].filter(Boolean).map(p => <option key={p}>{p}</option>)}</select></div>
          {records.map(r => <details className="wl-source" key={r.id}><summary><span><strong>{r.user.slice(0, 100)}</strong><small>{time(r.time)} · {r.project || 'Ручная запись'}{r.excluded ? ' · Исключено' : ''}{r.truncated ? ' · Фрагмент содержимого' : ''}</small></span></summary><div><p className="wl-muted">По ID:{r.id}{r.sessionId && ` · ход ${r.turn}`}</p><pre>{r.user}</pre><pre>{r.answer}</pre><div className="wl-actions">{r.sessionId && localSource(r) && openSession && <button onClick={() => visit(r.sessionId)}>Открыть сессию-источник</button>}<button disabled={busy} onClick={() => act('/exclude', { id: r.id, excluded: !r.excluded }, false)}>{r.excluded ? 'Включить снова' : 'Исключить из следующей обработки'}</button></div></div></details>)}
          {!records.length && <p className="wl-muted">Нет подходящих записей источников.</p>}
        </section>
      </>}
    </main></div>
    {message && <div className="wl-feedback" role="status">{message}</div>}
    {dates && <Dialog title="Выберите дату" close={() => setDates(false)}>{dayList}</Dialog>}
    {evidence && <Dialog title="Журнал работы · Просмотр оснований" close={() => setEvidence(null)}><p className="wl-muted">{time(evidence.time)} · {evidence.project || 'Ручная запись'}</p><h3>Требования пользователя</h3><pre className="wl-source-text">{evidence.user}</pre><h3>Итог сессии</h3><pre className="wl-source-text">{evidence.answer}</pre>{evidence.truncated && <p>Этот источник — фрагмент; откройте сессию, чтобы увидеть полное содержимое.</p>}{evidence.sessionId && localSource(evidence) && openSession && <button onClick={() => visit(evidence.sessionId)}>Открыть сессию-источник · Ход {evidence.turn} </button>}</Dialog>}
    {modal && <Dialog title={{ settings: 'Журнал работы · Настройки сбора', note: 'Добавить ручную запись', edit: 'Редактировать журнал', history: 'Прошлые версии', replace: 'Обработать журнал заново' }[modal]} close={() => !busy && setModal('')}>
      {error && <p className="wl-error" role="alert">{error}</p>}
      {modal === 'settings' && <Settings state={state} currentProject={currentProject} busy={busy} saveCapture={config => act('/capture-settings', config)} save={config => act('/settings', config)} />}
      {['note', 'edit'].includes(modal) && <form onSubmit={e => { e.preventDefault(); act(modal === 'note' ? '/note' : '/save', modal === 'note' ? { day, text: draft } : { day, markdown: draft, revision }) }}><label>{modal === 'note' ? 'Запишите фактически выполненную работу, решения или задачи' : 'Текст Markdown'}<textarea autoFocus rows={14} value={draft} onChange={e => setDraft(e.target.value)} required /></label><footer><button disabled={busy || !draft.trim()} className="wl-primary">{busy ? 'Сохранение…' : 'Сохранить'}</button></footer></form>}
      {modal === 'replace' && <><p>Журнал содержит ручные правки. Повторная обработка заменит текст, прежняя версия останется в истории. Любая правка во время новой обработки отменяет перезапись.</p><footer><button disabled={busy} onClick={() => setModal('')}>Сохранить текст</button><button disabled={busy} onClick={() => act('/generate', { day, allowReplace: true })}>Подтвердить повторную обработку</button></footer></>}
      {modal === 'history' && detail.history.map(h => <details key={h.id}><summary>{time(h.updated)} · {h.sourceId ? 'Перенести историю' : 'Версия'} {h.revision}</summary><Markdown text={h.markdown} /><button onClick={() => { setDraft(h.markdown); setRevision(detail.report.revision); setModal('edit') }}>Как черновик редактора</button></details>)}
    </Dialog>}
  </section>
}
