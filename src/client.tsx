import { useCallback, useEffect, useRef, useState } from 'react'
import { WritebackStatusClient } from './writeback/status-client.js'
import { observeWritebackVisibility } from './writeback/status-visibility.js'
import { subscribeWritebackChanges } from '../web/writeback-live.js'
import type { WritebackStatus } from './writeback/queue.js'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { activatePluginWorkspace, observePluginWorkspace } from './workspace-ownership.js'
// DSH 0.1.7 renamed size-suffixed icon exports to weight-suffixed ones;
// aliases keep every call site (and the contract tests) on legacy names.
import {
  IconChevronLeftOutlineRegular as IconChevronLeftOutline14,
  IconDataOutlineRegular as IconDataOutline16,
  IconPanelLeftOutlineRegular as IconPanelLeftOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { knowledgeDesignCss } from './design-tokens.js'
import { availableActivitySession, deriveCurrentSession } from './knowledge-activity-state.js'
import { supportsDockedPanels } from './docked-panel-compat.js'
import cssText from './client.css'
import { settingsSurfaceCss } from './settings-surface.js'
import { registerMainPanel } from './main-panel-compat.js'
import activityCss from './knowledge-activity.css'
import { createKnowledgeActivityController, type KnowledgeActivityController } from './knowledge-activity-controller.js'
import {
  createKnowledgeHostTheme,
  KNOWLEDGE_THEME_PROTOCOL_VERSION,
  KNOWLEDGE_THEME_READY_MESSAGE,
  type ThemeSnapshotLike,
} from './theme-bridge.js'

const PLUGIN_ID = '@lemoncat7/dsh-knowledge'
const STYLE_ID = `${PLUGIN_ID}/client`

type SidebarActionProps = PropsRuntime<'sidebar.footer.action'>
type ConversationSlotProps = PropsRuntime<'conversation'>

interface KnowledgeConnectionView {
  backend: 'local' | 'remote'
  remoteUrl?: string
  remoteTimeoutMs: number
  tokenConfigured: boolean
  canSwitchRemote: boolean
  writable: boolean
  managementAvailable: boolean
  managementPath?: string
}

export interface KnowledgeWorkspaceController {
  isOpen(): boolean
  open(): void
  toggle(): void
  openDocument(target: KnowledgeDocumentTarget): void
  currentTarget(): KnowledgeDocumentTarget | undefined
  close(): void
  subscribe(listener: () => void): () => void
}

export type KnowledgeDocumentTarget =
  | { view?: 'entries'; knowledgeBaseId: string; documentId: string }
  | { view: 'notes'; noteId?: string }
  | { view: 'writeback'; sessionId: string }


const CONNECTION_CONTROL_PATH = '/knowledge-control/v1/connection'
let cachedConnectionView: KnowledgeConnectionView | undefined

/** Cordis services needed by the browser half. */
export const inject = ['slots', 'theme', 'layout', 'sessions']

/** Register the knowledge launcher in the sidebar's official extension slot. */
export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'dsh-knowledge: client styles')
  const docked = supportsDockedPanels(ctx)
  let activity: KnowledgeActivityController | undefined
  const workspace = createKnowledgeWorkspaceController(ctx, () => { if (!docked) activity?.close(undefined, true) })
  activity = createKnowledgeActivityController(ctx, {
    beforeOpen: () => { workspace.close(); if (!docked) activatePluginWorkspace(PLUGIN_ID) },
    openWorkspace: target => { if (target === undefined) workspace.open(); else workspace.openDocument(target) },
  })
  ctx.effect(() => observePluginWorkspace(PLUGIN_ID, () => { workspace.close(); if (!docked) activity?.close(undefined, true) }), 'dsh-knowledge: exclusive workspace')
  ctx.effect(() => () => { workspace.close(); activity?.dispose() }, 'dsh-knowledge: workspace lifecycle')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'knowledge',
    order: -10,
  }, props => <KnowledgeLauncher {...props} workspace={workspace} activity={activity!} docked={supportsDockedPanels(ctx)} />))

  // DSH 0.1.7 retired `settings.plugin.item`; `settings.plugins.tab` exists on
  // both host generations and hosts the same connection card as one tab.
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'knowledge',
    order: 20,
    label: () => 'База знаний',
  }, KnowledgeConnectionCard))

  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    id: 'knowledge-writeback-status',
  }, props => <KnowledgeWritebackStatus sessionId={String(props.sessionId)} turn={props.turn.turn} workspace={workspace} />))
}

function KnowledgeWritebackStatus({
  sessionId,
  turn,
  workspace,
}: { sessionId: string; turn: number; workspace: KnowledgeWorkspaceController }) {
  const [state, setState] = useState<WritebackStatus>()
  const [retrying, setRetrying] = useState(false)
  const [readError, setReadError] = useState<string>()
  const client = useRef<WritebackStatusClient>()
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setState(undefined)
    setRetrying(false)
    setReadError(undefined)
    const status = new WritebackStatusClient(
      `/knowledge-control/v1/writeback-status?sessionId=${encodeURIComponent(sessionId)}&turn=${turn}`,
      (value, pending, error) => { setState(value); setRetrying(pending); setReadError(error) },
    )
    client.current = status
    const stopVisibility = container.current ? observeWritebackVisibility(container.current, status,
      () => subscribeWritebackChanges('conversation-web', () => status.invalidate())) : undefined
    return () => {
      stopVisibility?.()
      status.dispose()
      client.current = undefined
    }
  }, [sessionId, turn])
  if (state === undefined) return <div ref={container}>
    {readError && <div className="dsh-knowledge-writeback-notice" role="status">{readError}<button type="button" onClick={() => workspace.openDocument({ view: 'writeback', sessionId })}>Управление записью</button></div>}
  </div>
  const retry = (): void => client.current?.retry()
  const destinations = state.destinations ?? []
  const summary = state.summary.replace(/^Запись в базу знаний\s*·\s*/u, '')
  return <div ref={container} className="dsh-knowledge-writeback-notice" data-status={state.status}>
    <div className="dsh-knowledge-writeback-summary" role="status" aria-atomic="true">
      <span>Запись в базу знаний</span><strong>@lemoncat7/dsh-knowledge</strong><span title={state.error}>{summary}</span>
      {state.status === 'failed' && state.retryable && <button type="button" disabled={retrying} onClick={() => { void retry() }}>{retrying ? 'Повтор…' : 'Повторить'}</button>}
      {state.status !== 'completed' && <button type="button" onClick={() => workspace.openDocument({ view: 'writeback', sessionId })}>Управление записью</button>}
    </div>
    {destinations.length > 0 && <ul className="dsh-knowledge-writeback-destinations" aria-label="Цель записи">
      {destinations.map((destination, index) => <li key={`${destination.knowledgeBaseId}:${destination.documentId ?? destination.documentTitle}:${index}`}>
        <span className="dsh-knowledge-writeback-base">{destination.knowledgeBaseName}</span>
        <span className="dsh-knowledge-writeback-separator" aria-hidden="true">/</span>
        {destination.documentId
          ? <button
            type="button"
            className="dsh-knowledge-writeback-document"
            title={`Открыть ${destination.documentPath ?? destination.documentTitle}`}
            aria-label={`Открыть в базе знаний: ${destination.documentTitle}`}
            onClick={() => { workspace.openDocument({ knowledgeBaseId: destination.knowledgeBaseId, documentId: destination.documentId! }) }}
          ><strong>{destination.documentPath ?? destination.documentTitle}</strong></button>
          : <strong title={destination.documentTitle}>{`Будет создано: ${destination.documentTitle}`}</strong>}
        <small data-disposition={destination.disposition}>{destination.disposition === 'written' ? (destination.documentState === 'resolved' ? 'решено' : destination.documentState === 'complete' ? 'завершено' : 'записано') : (destination.documentState ? 'на проверке · отметить' + (destination.documentState === 'resolved' ? 'решить' : 'завершить') : 'на проверке')}</small>
      </li>)}
    </ul>}
    {state.status === 'failed' && state.error && <p className="dsh-knowledge-writeback-error" role="alert">{state.error}</p>}
    {readError && <p className="dsh-knowledge-writeback-error" role="status">{readError}</p>}
  </div>
}

function createKnowledgeWorkspaceController(client: ClientContext, beforeOpen: () => void): KnowledgeWorkspaceController {
  const listeners = new Set<() => void>()
  let disposeWorkspace: (() => void) | undefined
  let target: KnowledgeDocumentTarget | undefined
  const notify = (): void => { for (const listener of listeners) listener() }
  const close = (): void => {
    if (disposeWorkspace === undefined) return
    const dispose = disposeWorkspace
    disposeWorkspace = undefined
    dispose()
    notify()
  }
  let controller: KnowledgeWorkspaceController
  const open = (): void => {
    if (disposeWorkspace !== undefined) return
    beforeOpen()
    activatePluginWorkspace(PLUGIN_ID)
    disposeWorkspace = registerMainPanel(client, PLUGIN_ID, -1, props => (
      <KnowledgeWorkspace {...props} client={client} workspace={controller} />
    ), close)
  }
  controller = {
    isOpen: () => disposeWorkspace !== undefined,
    open: () => { target = undefined; open(); notify() },
    toggle: () => {
      if (disposeWorkspace !== undefined) return close()
      target = undefined
      open()
      notify()
    },
    openDocument: nextTarget => {
      target = nextTarget
      open()
      notify()
    },
    currentTarget: () => target,
    close,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return controller
}

function KnowledgeConnectionCard() {
  const [current, setCurrent] = useState<KnowledgeConnectionView>()
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState('')
  const [open, setOpen] = useState(false)
  const [backend, setBackend] = useState<'local' | 'remote'>('local')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [remoteToken, setRemoteToken] = useState('')
  const [timeout, setTimeoutValue] = useState('10000')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string }>()

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setLoadState('loading')
    setLoadError('')
    try {
      const value = await requestConnection('GET', undefined, signal)
      setCurrent(value)
      setLoadState('ready')
    } catch (error) {
      if (signal?.aborted) return
      setLoadError(connectionErrorMessage(error))
      setLoadState('error')
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => { controller.abort() }
  }, [load])

  useEffect(() => {
    if (dirty || current === undefined) return
    setBackend(current.backend)
    setRemoteUrl(current.remoteUrl ?? '')
    setTimeoutValue(String(current.remoteTimeoutMs ?? 10000))
  }, [current, dirty])

  const timeoutNumber = Number(timeout)
  const urlError = backend === 'remote' ? validateRemoteUrl(remoteUrl) : undefined
  const tokenError = backend === 'remote' && !current?.tokenConfigured && remoteToken.trim().length === 0
    ? 'При первом подключении нужно указать клиентский токен.'
    : remoteToken.length > 0 && remoteToken.trim().length < 24 ? 'Токен должен содержать минимум 24 символа.' : undefined
  const timeoutError = !Number.isInteger(timeoutNumber) || timeoutNumber < 100 || timeoutNumber > 120000
    ? 'Таймаут должен быть целым числом от 100 до 120000 мс.'
    : undefined
  const invalid = urlError !== undefined || tokenError !== undefined || timeoutError !== undefined

  const edit = (action: () => void): void => {
    action()
    setDirty(true)
    setMessage(undefined)
  }
  const reset = (): void => {
    setBackend(current?.backend ?? 'local')
    setRemoteUrl(current?.remoteUrl ?? '')
    setRemoteToken('')
    setTimeoutValue(String(current?.remoteTimeoutMs ?? 10000))
    setDirty(false)
    setMessage(undefined)
  }
  const save = async (): Promise<void> => {
    if (!dirty || invalid || !current?.writable || saving) return
    setSaving(true)
    setMessage(undefined)
    try {
      const next = await requestConnection('PUT', {
        backend,
        remoteTimeoutMs: timeoutNumber,
        ...backend === 'remote' ? { remoteUrl: remoteUrl.trim() } : {},
        ...backend === 'remote' && remoteToken.trim().length > 0 ? { remoteToken: remoteToken.trim() } : {},
      })
      setCurrent(next)
      setRemoteToken('')
      setDirty(false)
      setMessage({
        kind: 'success',
        text: backend === 'remote' ? 'Проверено и переключено на удалённую базу знаний.' : 'Переключено на локальную базу знаний.',
      })
    } catch (error) {
      setMessage({ kind: 'error', text: connectionErrorMessage(error) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <li className={`dsh-plugin-settings dsh-knowledge-settings-card${open ? ' dsh-knowledge-settings-card--open' : ''}`}>
      <button type="button" className="dsh-knowledge-settings-header" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        <span><strong>Подключение базы знаний</strong><small>Выберите локальную базу знаний или подключитесь к центральной базе DSH</small></span>
        <span className="dsh-knowledge-settings-summary">{loadState === 'loading' ? 'Чтение' : loadState === 'error' ? 'Точка подключения' : current?.backend === 'remote' ? 'Удалённо' : 'Локально'}<i aria-hidden="true" /></span>
      </button>
      {open && <div className="dsh-knowledge-settings-body">
        {loadState === 'loading' ? <p className="dsh-knowledge-settings-note" role="status">Чтение настроек подключения…</p>
          : loadState === 'error' ? <div className="dsh-knowledge-settings-load-error" role="alert">
            <p>{loadError}</p>
            <button type="button" onClick={() => { void load() }}>Перечитать</button>
          </div> : <>
          <fieldset className="dsh-knowledge-source-picker">
            <legend>Источник базы знаний</legend>
            <label className={backend === 'local' ? 'is-selected' : ''}>
              <input type="radio" name="dsh-knowledge-backend" checked={backend === 'local'} onChange={() => edit(() => { setBackend('local') })} />
              <span><strong>Локально</strong><small>Данные хранятся в SQLite текущего DSH</small></span>
            </label>
            <label className={`${backend === 'remote' ? 'is-selected' : ''}${!current?.canSwitchRemote ? ' is-disabled' : ''}`}>
              <input type="radio" name="dsh-knowledge-backend" checked={backend === 'remote'} disabled={!current?.canSwitchRemote} onChange={() => edit(() => { setBackend('remote') })} />
              <span><strong>Удалённо</strong><small>Извлечение и запись идут через центральную базу знаний</small></span>
            </label>
          </fieldset>
          {!current?.canSwitchRemote && <p className="dsh-knowledge-settings-note">Этот экземпляр сам является центральной службой баз знаний — переключиться на другую удалённую службу нельзя.</p>}
          {backend === 'remote' && <div className="dsh-knowledge-remote-fields">
            <label htmlFor="dsh-knowledge-remote-url">Адрес сервера
              <input id="dsh-knowledge-remote-url" type="url" value={remoteUrl} placeholder="https://example.com/knowledge-api/v1" autoComplete="url" onChange={event => edit(() => { setRemoteUrl(event.target.value) })} aria-invalid={urlError !== undefined} aria-describedby={urlError ? 'dsh-knowledge-url-error' : undefined} />
              {urlError && <small id="dsh-knowledge-url-error" className="dsh-knowledge-field-error">{urlError}</small>}
            </label>
            <label htmlFor="dsh-knowledge-remote-token">Клиентский токен
              <input id="dsh-knowledge-remote-token" type="password" value={remoteToken} placeholder={current?.tokenConfigured ? 'Сохранён; оставьте пустым, чтобы не менять' : 'Вставьте клиентский токен'} autoComplete="new-password" onChange={event => edit(() => { setRemoteToken(event.target.value) })} aria-invalid={tokenError !== undefined} aria-describedby="dsh-knowledge-token-help" />
              <small id="dsh-knowledge-token-help" className={tokenError ? 'dsh-knowledge-field-error' : undefined}>{tokenError ?? (current?.tokenConfigured ? 'Токен сохранён безопасно и недоступен странице; введите новый, чтобы заменить.' : 'Токен нельзя прочитать после сохранения — только заменить.')}</small>
            </label>
          </div>}
          <label className="dsh-knowledge-timeout-field" htmlFor="dsh-knowledge-timeout">Таймаут запроса (мс)
            <input id="dsh-knowledge-timeout" type="number" min="100" max="120000" step="100" value={timeout} onChange={event => edit(() => { setTimeoutValue(event.target.value) })} aria-invalid={timeoutError !== undefined} />
            {timeoutError && <small className="dsh-knowledge-field-error">{timeoutError}</small>}
          </label>
          {!current?.writable && <p className="dsh-knowledge-settings-note">У плагина не задан путь для хранения данных — подключение не сохранить.</p>}
          {message && <p className={`dsh-knowledge-settings-message is-${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'} aria-live="polite">{message.text}</p>}
          <div className="dsh-knowledge-settings-actions">
            <button type="button" onClick={reset} disabled={!dirty || saving}>Отменить изменения</button>
            <button type="button" className="is-primary" onClick={() => { void save() }} disabled={!dirty || invalid || saving || !current?.writable}>{saving ? 'Проверка…' : 'Проверить и подключить'}</button>
          </div>
        </>}
      </div>}
    </li>
  )
}

function validateRemoteUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim())
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return 'Для удалённой базы знаний требуется HTTPS.'
    return undefined
  } catch { return 'Укажите полный адрес API базы знаний.' }
}

function connectionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('Failed to fetch')) return 'API подключения плагина недоступен: убедитесь, что служба плагина загружена.'
  return message || 'Не удалось выполнить операцию с подключением: проверьте адрес, токен и журнал DSH.'
}

async function requestConnection(
  method: 'GET' | 'PUT',
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<KnowledgeConnectionView> {
  const response = await fetch(CONNECTION_CONTROL_PATH, {
    method,
    headers: { accept: 'application/json', ...body === undefined ? {} : { 'content-type': 'application/json' } },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
    ...signal === undefined ? {} : { signal },
  })
  const payload = await response.json().catch(() => undefined) as unknown
  if (!response.ok) {
    const message = payload !== null && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : `API подключения вернул HTTP ${response.status}`
    throw new Error(message)
  }
  if (!isConnectionView(payload)) throw new Error('API подключения плагина вернул некорректные данные.')
  cachedConnectionView = payload
  return payload
}

function isConnectionView(value: unknown): value is KnowledgeConnectionView {
  if (value === null || typeof value !== 'object') return false
  const item = value as Partial<KnowledgeConnectionView>
  return (item.backend === 'local' || item.backend === 'remote')
    && Number.isInteger(item.remoteTimeoutMs)
    && typeof item.tokenConfigured === 'boolean'
    && typeof item.canSwitchRemote === 'boolean'
    && typeof item.writable === 'boolean'
    && typeof item.managementAvailable === 'boolean'
    && (!item.managementAvailable || isManagementPath(item.managementPath))
}

function isManagementPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
}

function KnowledgeLauncher({ wide, useSessions, workspace, activity, docked }: SidebarActionProps & { workspace: KnowledgeWorkspaceController; activity: KnowledgeActivityController; docked: boolean }) {
  const [open, setOpen] = useState(workspace.isOpen())
  const currentSessionId = useSessions((state: SessionListState) => availableActivitySession(state, docked))
  const [activityOpen, setActivityOpen] = useState(currentSessionId === undefined ? false : activity.isOpen(currentSessionId))

  useEffect(() => workspace.subscribe(() => { setOpen(workspace.isOpen()) }), [workspace])
  useEffect(() => {
    const sync = (): void => {
      setActivityOpen(currentSessionId === undefined ? false : activity.isOpen(currentSessionId))
    }
    sync()
    return activity.subscribe(sync)
  }, [activity, currentSessionId])

  return (
    <div className={`dsh-knowledge-launcher${wide ? '' : ' dsh-knowledge-launcher--rail'}`} role="group" aria-label="Вход в базу знаний">
    {wide && <button
      type="button"
      className={`dsh-knowledge-trigger${wide ? '' : ' dsh-knowledge-trigger--rail'}${open ? ' is-active' : ''}`}
      aria-label={open ? 'Вернуться к диалогу' : 'Открыть рабочую область базы знаний'}
      aria-pressed={open}
      title={open ? 'Вернуться к диалогу' : 'Открыть рабочую область базы знаний'}
      onClick={() => workspace.toggle()}
    >
      <IconDataOutline16 size={wide ? 16 : 18} />
      {wide && <span>База знаний</span>}
    </button>}
    <button
      type="button"
      className={`dsh-knowledge-trigger dsh-knowledge-panel-trigger${activityOpen ? ' is-active' : ''}`}
      aria-label={activityOpen ? 'Свернуть базу знаний сессии' : 'Развернуть базу знаний сессии'}
      aria-expanded={activityOpen}
      disabled={currentSessionId === undefined}
      title={currentSessionId === undefined ? 'Панель знаний доступна внутри сессии' : activityOpen ? 'Свернуть базу знаний сессии' : 'Развернуть базу знаний сессии'}
      onClick={() => { if (currentSessionId !== undefined) activity.toggle(currentSessionId) }}
    >
      <IconPanelLeftOutline16 size={16} className="dsh-knowledge-panel-right-icon" />
    </button>
    </div>
  )
}

function KnowledgeWorkspace({
  sessionId: scopedSessionId,
  useSessions,
  client,
  workspace,
}: ConversationSlotProps & { client: ClientContext; workspace: KnowledgeWorkspaceController }) {
  const cachedManagementPath = cachedConnectionView?.managementAvailable ? cachedConnectionView.managementPath : undefined
  const [panelState, setPanelState] = useState<'loading' | 'ready' | 'unavailable' | 'error'>(cachedConnectionView === undefined ? 'loading' : cachedManagementPath === undefined ? 'unavailable' : 'ready')
  const [managementPath, setManagementPath] = useState<string | undefined>(cachedManagementPath)
  const [panelError, setPanelError] = useState('')
  const [target, setTarget] = useState<KnowledgeDocumentTarget | undefined>(workspace.currentTarget())
  const selectedSessionId = useSessions((state: SessionListState) => deriveCurrentSession(state))
  const sessionId = scopedSessionId ?? selectedSessionId
  const projectId = useSessions((state: SessionListState) => sessionId === undefined ? undefined : state.byId[sessionId]?.cwd)
  const knowledgeUrl = managementPath === undefined ? undefined : knowledgePanelUrl(managementPath, sessionId, projectId, target)
  const frame = useRef<HTMLIFrameElement | null>(null)
  const themeFrame = useRef(0)

  const loadManagement = useCallback(async (background = false): Promise<void> => {
    if (!background) setPanelState('loading')
    setPanelError('')
    try {
      const connection = await requestConnection('GET')
      if (!connection.managementAvailable || connection.managementPath === undefined) {
        setManagementPath(undefined)
        setPanelState('unavailable')
        return
      }
      setManagementPath(connection.managementPath)
      setPanelState('ready')
    } catch (error) {
      setManagementPath(undefined)
      setPanelError(connectionErrorMessage(error))
      setPanelState('error')
    }
  }, [])

  useEffect(() => {
    void loadManagement(cachedConnectionView !== undefined)
  }, [loadManagement])

  useEffect(() => workspace.subscribe(() => { setTarget(workspace.currentTarget()) }), [workspace])

  const sendTheme = useCallback((): void => {
    const currentFrame = frame.current
    if (currentFrame === null) return
    const target = currentFrame.contentWindow
    if (target === null) return
    target.postMessage(
      createKnowledgeHostTheme(client.theme.getTheme()),
      frameOrigin(currentFrame) ?? '*',
    )
  }, [client])

  const scheduleTheme = useCallback((): void => {
    if (themeFrame.current !== 0) window.cancelAnimationFrame(themeFrame.current)
    themeFrame.current = window.requestAnimationFrame(() => {
      themeFrame.current = 0
      sendTheme()
    })
  }, [sendTheme])

  useEffect(() => {
    const off = client.on('theme/change', scheduleTheme)
    const onMessage = (event: MessageEvent): void => {
      const currentFrame = frame.current
      if (event.source !== currentFrame?.contentWindow) return
      const expectedOrigin = frameOrigin(currentFrame)
      if (expectedOrigin !== undefined && event.origin !== expectedOrigin) return
      const data = event.data as { type?: unknown; version?: unknown; sessionId?: unknown } | null
      if (data?.type === '@lemoncat7/dsh-worklog/open-session' && typeof data.sessionId === 'string' && data.sessionId.length > 0 && data.sessionId.length <= 256) {
        const navigation = client.get('uiWorkspace') as { openSession(id: string): void } | undefined
        if (navigation) { navigation.openSession(data.sessionId); activatePluginWorkspace('conversation') }
      }
      if (data?.type === KNOWLEDGE_THEME_READY_MESSAGE && data.version === KNOWLEDGE_THEME_PROTOCOL_VERSION) sendTheme()
    }
    window.addEventListener('message', onMessage)
    scheduleTheme()
    return () => {
      off()
      window.removeEventListener('message', onMessage)
      if (themeFrame.current !== 0) window.cancelAnimationFrame(themeFrame.current)
    }
  }, [client, scheduleTheme, sendTheme])

  return (
    <section className="dsh-knowledge-workspace" data-knowledge-surface="workspace" aria-labelledby="dsh-knowledge-workspace-title">
      <header className="dsh-knowledge-workspace-header">
        <div>
          <button type="button" data-knowledge-workspace-close onClick={workspace.close} aria-label="Вернуться к сессии" title="Вернуться к сессии"><IconChevronLeftOutline14 size={15} /></button>
          <IconDataOutline16 size={18} />
          <span><h2 id="dsh-knowledge-workspace-title">База знаний</h2><p>Документы, проверка, подключения и управление доступом</p></span>
        </div>
      </header>
      {panelState === 'ready' && knowledgeUrl !== undefined
        ? <iframe ref={frame} className="dsh-knowledge-frame" src={knowledgeUrl} title="Консоль управления базами знаний" onLoad={sendTheme} />
        : <div className="dsh-knowledge-panel-state" role={panelState === 'error' ? 'alert' : 'status'} aria-live="polite">
          <span className="dsh-knowledge-panel-state-icon" aria-hidden="true">{panelState === 'loading' ? '···' : panelState === 'error' ? '!' : '—'}</span>
          <div>
            <h3>{panelState === 'loading' ? 'Открытие базы знаний…' : panelState === 'error' ? 'Не удалось открыть базу знаний' : 'В этом DSH консоль управления базами знаний не включена'}</h3>
            <p>{panelState === 'loading'
              ? 'Проверяем, предоставляет ли этот экземпляр страницу управления.'
              : panelState === 'error'
                ? panelError
                : 'Локальное извлечение и запись продолжают работать. В текущем профиле exposeWeb явно отключён; включите его, чтобы управлять отсюда. При удалённой базе знаний используйте консоль управления центрального DSH.'}</p>
            {panelState === 'error' && <button type="button" onClick={() => { void loadManagement() }}>Повторить</button>}
          </div>
        </div>}
    </section>
  )
}

function knowledgePanelUrl(managementPath: string, sessionId?: string, projectId?: string, target?: KnowledgeDocumentTarget): string {
  const params = new URLSearchParams()
  if (sessionId !== undefined) params.set('sessionId', sessionId)
  if (projectId !== undefined) params.set('projectId', projectId)
  if (target !== undefined) {
    if (target.view === 'writeback') {
      params.set('view', 'writeback')
      params.set('sessionId', target.sessionId)
    } else if (target.view === 'notes') {
      params.set('view', 'notes')
      if (target.noteId !== undefined) params.set('noteId', target.noteId)
    } else {
      params.set('knowledgeBaseId', target.knowledgeBaseId)
      params.set('documentId', target.documentId)
    }
  }
  const query = params.toString()
  return query.length === 0 ? managementPath : `${managementPath}${managementPath.includes('?') ? '&' : '?'}${query}`
}

function frameOrigin(frame: HTMLIFrameElement): string | undefined {
  try {
    const origin = new URL(frame.src).origin
    return origin === 'null' ? undefined : origin
  } catch {
    return undefined
  }
}

function installStyles(): () => void {
  const previous = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${STYLE_ID}"]`)
  previous?.remove()
  const style = document.createElement('style')
  style.dataset.plugin = PLUGIN_ID
  style.dataset.pluginCss = STYLE_ID
  const scope = ':is(.dsh-knowledge-trigger, .dsh-knowledge-activity-panel, .dsh-knowledge-workspace, .dsh-knowledge-settings-card, .dsh-knowledge-writeback-notice)'
  style.textContent = knowledgeDesignCss(scope, 'body[data-ds-dark-theme] ' + scope, false) + cssText + activityCss + settingsSurfaceCss
  document.head.appendChild(style)
  return () => { style.remove() }
}
