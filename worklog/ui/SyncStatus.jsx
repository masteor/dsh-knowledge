import { useEffect, useState } from 'react'
import { api } from './api.js'
import { Dialog } from './Dialog.jsx'

export function SyncStatus() {
  const [state, setState] = useState(null), [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController(); let timer
    async function poll() {
      try { if (!document.hidden) setState(await api('/collector-state', undefined, controller.signal)) }
      catch (e) { if (!controller.signal.aborted) setError(e.message) }
      finally { if (!controller.signal.aborted) timer = setTimeout(poll, 6000) }
    }
    void poll(); return () => { controller.abort(); clearTimeout(timer) }
  }, [])
  async function act(path) {
    setBusy(true); setError('')
    try { setState(await api(path, { confirm: true })); setConfirm(false) }
    catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }
  if (!state?.remote) return null
  return <>
    <div className="wl-sync-status">
      <span role="status">Центральный журнал · ожидает загрузки с этого устройства {state.sync.pending} записей{state.sync.otherDestinations > 0 && ` · Также есть ${state.sync.otherDestinations} записей остаётся в очереди по прежнему центральному адресу`}</span>
      {(error || state.sync.error) && <span role="alert">{error || state.sync.error}</span>}
      {state.sync.pending > 0 && <button disabled={busy} onClick={() => act('/retry-sync')}>Повторить загрузку</button>}
      {(state.localHistory > 0 || state.localReports > 0) && <button disabled={busy} onClick={() => setConfirm(true)}>Перенести локальную историю</button>}
    </div>
    {confirm && <Dialog title="Перенести в текущую центральную базу знаний" close={() => !busy && setConfirm(false)}>
      <p>На текущую подключённую центральную базу знаний будут загружены существующие материалы этого устройства и история журналов. История диалогов может содержать конфиденциальные сведения; убедитесь, что центральная служба вызывает доверие и авторизация выполнена.</p>
      <p>Источники дедуплицируются; старые журналы сохраняются в истории версий на центре и не перезаписывают центральный текст. Локальные исходные данные сохраняются; локальные настройки расписания и незавершённые задачи обработки не переносятся.</p>
      {error && <p role="alert">{error}</p>}
      <footer><button disabled={busy} onClick={() => setConfirm(false)}>Отмена</button><button disabled={busy} onClick={() => act('/migrate')}>{busy ? 'Добавление в очередь…' : 'Подтвердить загрузку истории'}</button></footer>
    </Dialog>}
  </>
}
