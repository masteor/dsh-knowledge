import { useState } from 'react'
import { ModelPicker } from './ModelPicker.jsx'

export function Settings({ state, save, saveCapture, busy, currentProject = '' }) {
  const [config, set] = useState({ ...state.config, sharedRevision: state.sharedRevision })
  const [project, setProject] = useState('')
  const projects = [...new Set([currentProject, ...state.projects, ...config.projects].filter(Boolean))]
  return <form onSubmit={e => { e.preventDefault(); save(config) }}>
    <h3>Локальный сбор</h3>
    <p>{state.remote ? 'Текущий экземпляр DSH собирает данные по путям локальных проектов и загружает их в подключённую центральную базу знаний; без сети данные копятся и досылаются позже.' : 'Текущий узел хранит и обрабатывает журнал; другие экземпляры DSH после подключения к этой центральной базе знаний смогут загружать источники.'}Собираются только новые диалоги после включения; сообщения в каналы автоматически не отправляются.</p>
    <label className="wl-check"><input type="checkbox" checked={config.enabled} onChange={e => set({ ...config, enabled: e.target.checked })} />Включить сбор рабочих материалов</label>
    {state.remote && <p className="wl-muted">Отключение сбора лишь останавливает добавление новых материалов: оно не отменяет уже разрешённые к сбору записи, ожидающие загрузки, и не удаляет записи на центре.</p>}
    <h3>Проекты сбора</h3>
    <div className="wl-actions" role="group" aria-label="Область сбора">
      <button type="button" aria-pressed={config.scope === 'all'} onClick={() => set({ ...config, scope: 'all' })}>Все проекты</button>
      <button type="button" aria-pressed={config.scope !== 'all'} onClick={() => set({ ...config, scope: 'selected' })}>Выберите проект</button>
    </div>
    {config.scope === 'all' ? <p className="wl-muted">Включает новые диалоги текущих и будущих проектов, указанные ниже сессии по-прежнему исключены. Вступает в силу после сохранения и включения сбора.</p> : <>
    <p className="wl-muted">Выберите из текущих и уже записанных проектов, путь можно ввести вручную; если проект не выбран, сбор не ведётся.</p>
    {currentProject && <button type="button" onClick={() => set({ ...config, projects: [...new Set([...config.projects, currentProject])] })}>Добавить текущий проект</button>}
    <div className="wl-projects">
    {projects.map(id => <label className="wl-check" key={id}><input type="checkbox" checked={config.projects.includes(id)} onChange={e => set({ ...config, projects: e.target.checked ? [...config.projects, id] : config.projects.filter(p => p !== id) })} /><span title={id}>{id}</span></label>)}
    </div>
    <label>Добавить путь к проекту<input value={project} onChange={e => setProject(e.target.value)} placeholder="например /workspace/my-project" /></label>
    <button type="button" disabled={!project.trim()} onClick={() => { set({ ...config, projects: [...new Set([...config.projects, project.trim()])] }); setProject('') }}>Добавить проект</button>
    </>}
    <label>Исключить сессии (по одному ID сессии в строке)<textarea rows={3} value={config.excludedSessions.join('\n')} onChange={e => set({ ...config, excludedSessions: e.target.value.split('\n').filter(Boolean) })} /></label>
    {state.remote && saveCapture && <button type="button" disabled={busy} onClick={() => saveCapture(config)}>Сохранить только локальный сбор</button>}
    <h3>Обработка на центре</h3>
    <p className="wl-muted">Часовой пояс, модель и задания по расписанию управляются централизованно. Все экземпляры, подключённые к этому центру, видят один и тот же журнал; локально модель для обработки не вызывается.</p>
    {state.remote && !state.canManage && <p className="wl-muted">У текущего токена нет прав администратора: центральные настройки доступны только для просмотра; локальный сбор по-прежнему можно изменять.</p>}
    {state.centralUnavailable ? <p role="status">Центр временно недоступен, конфигурацию центра нельзя прочитать или изменить; локальный сбор по-прежнему можно сохранить отдельно.</p> : <fieldset className="wl-central-settings" disabled={state.remote && !state.canManage}>
    <label>Часовой пояс даты<input value={config.timezone} onChange={e => set({ ...config, timezone: e.target.value })} placeholder="Asia/Shanghai" /></label>
    <p className="wl-muted">Источники архивируются по часовому поясу момента получения на центре; смена часового пояса не переносит существующие журналы.</p>
    <ModelPicker central={state.remote} provider={config.provider} model={config.model} onChange={(provider, model) => set({ ...config, provider, model })} />
    <section aria-label="Настройки обработки по расписанию">
      <h3>Обработка по расписанию</h3>
      <label className="wl-check"><input type="checkbox" checked={config.scheduleEnabled ?? false} onChange={e => set({ ...config, scheduleEnabled: e.target.checked })} />Ежедневная обработка по расписанию</label>
      {config.scheduleEnabled && <>
        <label>Время ежедневной обработки<input type="time" required step="60" value={config.scheduleTime ?? '23:00'} onChange={e => set({ ...config, scheduleTime: e.target.value })} aria-describedby="wl-schedule-help" /></label>
        <p id="wl-schedule-help" className="wl-muted">По часовому поясу выше {config.timezone}，Обрабатывает материалы за текущий день на момент запуска. После сохранения отсчёт идёт от следующего заданного времени; выполняется на сервере, открывать страницу не нужно. Вызывает выбранную модель.</p>
        <p className="wl-muted">После перезапуска восполняется только последняя пропущенная дата, история массово не заполняется. При отсутствии новых материалов или при ручных правках текста обработка пропускается; материалы, добавленные после наступления времени в тот же день, обрабатывайте вручную. Отключение расписания не отменяет уже поставленные в очередь задачи.</p>
      </>}
      {state.scheduleLast && <p className="wl-muted" role="status">Последняя проверка по расписанию · {state.scheduleLast.day}：{state.scheduleLast.message}{state.scheduleLast.status === 'failed' && ' Исправьте настройки и повторите попытку, нажав «Обработать журнал» на нужной дате.'}</p>}
    </section>
    </fieldset>}
    {!state.centralUnavailable && <footer><button disabled={busy} className="wl-primary">{busy ? 'Сохранение…' : 'Сохранить настройки'}</button></footer>}
  </form>
}
