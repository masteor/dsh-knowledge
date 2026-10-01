import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// DSH 0.1.7 renamed size-suffixed icon exports to weight-suffixed ones;
// aliases keep every call site (and the contract tests) on legacy names.
import {
  IconChevronLeftOutlineRegular as IconChevronLeftOutline14,
  IconChevronDownOutlineRegular as IconChevronDownOutline14,
  IconCloseOutlineRegular as IconCloseOutline16,
  IconDatabaseOutlineRegular as IconDatabaseOutline16,
  IconDataOutlineRegular as IconDataOutline16,
  IconRefreshOutlineRegular as IconRefreshOutline14,
  IconSearchOutlineRegular as IconSearchOutline16,
  IconFullscreenOutlineRegular as IconFullscreenOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { KnowledgeDocument, KnowledgeDocumentSummary, ResolvedKnowledgeMount } from './domain.js'
import {
  loadKnowledgeDocument,
  loadKnowledgeDocumentIndex,
  loadMountedKnowledge,
} from './knowledge-activity-api.js'
import type { KnowledgeActivityController } from './knowledge-activity-controller.js'
import { KnowledgeActivityNotes } from './knowledge-activity-notes.js'
import { LatestRequest } from './latest-request.js'
import { renderMarkdown } from './web-markdown-preview.js'
import { compareNames } from './collation.js'

type DetailsProps = PropsRuntime<'details'>

export function KnowledgeActivityPanel(
  props: DetailsProps & { controller: KnowledgeActivityController },
): JSX.Element {
  const sessionId = String(props.sessionId)
  const projectId = props.useSessions((state: SessionListState) => state.byId[props.sessionId]?.cwd)
  const initial = props.controller.selection(sessionId)
  const [mode, setMode] = useState<'knowledge' | 'notes'>(initial.mode ?? 'knowledge')
  const [mounts, setMounts] = useState<ResolvedKnowledgeMount[]>([])
  const [selectedBaseId, setSelectedBaseId] = useState(initial.knowledgeBaseId)
  const [selectedDocumentId, setSelectedDocumentId] = useState(initial.documentId)
  const [documents, setDocuments] = useState<KnowledgeDocumentSummary[]>([])
  const [documentValue, setDocumentValue] = useState<KnowledgeDocument>()
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const [mountState, setMountState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [listState, setListState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [documentState, setDocumentState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [documentRefresh, setDocumentRefresh] = useState(0)
  const [error, setError] = useState('')
  const [nextCursor, setNextCursor] = useState<string>()
  const [baseMenuOpen, setBaseMenuOpen] = useState(false)
  const indexRequest = useRef(new LatestRequest())
  const mountRequest = useRef(new LatestRequest())
  const scopeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!baseMenuOpen) return
    const closeOutside = (event: PointerEvent): void => {
      if (!scopeRef.current?.contains(event.target as Node)) setBaseMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setBaseMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [baseMenuOpen])

  const refreshMounts = useCallback(async (): Promise<void> => {
    const signal = mountRequest.current.start()
    setMountState('loading')
    setError('')
    try {
      const next = await loadMountedKnowledge(sessionId, projectId, signal)
      if (signal.aborted) return
      setMounts(next)
      const current = props.controller.selection(sessionId)
      const selected = next.some(item => item.knowledgeBaseId === current.knowledgeBaseId)
        ? current.knowledgeBaseId
        : next[0]?.knowledgeBaseId
      props.controller.select(sessionId, {
        knowledgeBaseId: selected,
        documentId: selected === current.knowledgeBaseId ? current.documentId : undefined,
      })
      setSelectedBaseId(selected)
      if (selected !== current.knowledgeBaseId) {
        setSelectedDocumentId(undefined)
        setDocumentValue(undefined)
      }
      setMountState('ready')
    } catch (reason) {
      if (signal?.aborted) return
      setMountState('error')
      setError(message(reason))
    }
  }, [projectId, props.controller, sessionId])

  useEffect(() => {
    void refreshMounts()
    return () => { mountRequest.current.cancel() }
  }, [refreshMounts])

  const loadIndex = useCallback(async (cursor?: string, append = false): Promise<void> => {
    const signal = indexRequest.current.start()
    if (mounts.length === 0 || (query.length === 0 && selectedBaseId === undefined)) {
      setDocuments([])
      setNextCursor(undefined)
      setListState('ready')
      return
    }
    setListState('loading')
    setError('')
    try {
      const result = await loadKnowledgeDocumentIndex({
        sessionId,
        ...projectId === undefined ? {} : { projectId },
        knowledgeBaseIds: query ? mounts.map(item => item.knowledgeBaseId) : [selectedBaseId!],
        ...query ? { query } : {},
        ...cursor === undefined ? {} : { cursor },
        ...signal === undefined ? {} : { signal },
      })
      if (signal.aborted) return
      setDocuments(current => append ? [...current, ...result.items] : result.items)
      setNextCursor(result.nextCursor)
      setListState('ready')
    } catch (reason) {
      if (signal?.aborted) return
      setListState('error')
      setError(message(reason))
    }
  }, [mounts, projectId, query, selectedBaseId, sessionId])

  useEffect(() => {
    void loadIndex()
    return () => { indexRequest.current.cancel() }
  }, [loadIndex])

  useEffect(() => {
    if (selectedDocumentId === undefined) {
      setDocumentValue(undefined)
      setDocumentState('idle')
      return
    }
    const controller = new AbortController()
    setDocumentState('loading')
    setError('')
    void loadKnowledgeDocument({
      id: selectedDocumentId,
      sessionId,
      ...projectId === undefined ? {} : { projectId },
      signal: controller.signal,
    }).then(value => {
      if (controller.signal.aborted) return
      setDocumentValue(value)
      setDocumentState('ready')
    }).catch(reason => {
      if (controller.signal.aborted) return
      setDocumentState('error')
      setError(message(reason))
    })
    return () => { controller.abort() }
  }, [documentRefresh, projectId, selectedDocumentId, sessionId])

  const selectBase = (knowledgeBaseId: string): void => {
    setBaseMenuOpen(false)
    setSelectedBaseId(knowledgeBaseId)
    setSelectedDocumentId(undefined)
    setDocumentValue(undefined)
    setQueryInput('')
    setQuery('')
    props.controller.select(sessionId, { mode: 'knowledge', knowledgeBaseId, documentId: undefined })
  }
  const selectDocument = (document: KnowledgeDocumentSummary): void => {
    setSelectedBaseId(document.knowledgeBaseId)
    setSelectedDocumentId(document.id)
    props.controller.select(sessionId, {
      mode: 'knowledge',
      knowledgeBaseId: document.knowledgeBaseId,
      documentId: document.id,
    })
  }
  const closeDocument = (): void => {
    setSelectedDocumentId(undefined)
    setDocumentValue(undefined)
    props.controller.select(sessionId, {
      mode: 'knowledge',
      documentId: undefined,
      ...selectedBaseId === undefined ? {} : { knowledgeBaseId: selectedBaseId },
    })
  }
  const submitSearch = (event: FormEvent): void => {
    event.preventDefault()
    setSelectedDocumentId(undefined)
    setDocumentValue(undefined)
    props.controller.select(sessionId, { documentId: undefined })
    setQuery(queryInput.trim())
  }
  const clearSearch = (): void => {
    setQueryInput('')
    setQuery('')
  }

  const openWorkspace = (): void => {
    const noteId = props.controller.selection(sessionId).noteDocumentId
    props.controller.openWorkspace(mode === 'notes'
      ? { view: 'notes', ...(noteId === undefined ? {} : { noteId }) }
      : documentValue === undefined ? undefined : {
        knowledgeBaseId: documentValue.knowledgeBaseId,
        documentId: documentValue.id,
      })
  }

  const selectMode = (nextMode: 'knowledge' | 'notes'): void => {
    setMode(nextMode)
    setBaseMenuOpen(false)
    props.controller.select(sessionId, { ...props.controller.selection(sessionId), mode: nextMode })
  }

  return <section className="dsh-knowledge-activity-panel" data-knowledge-surface="activity" aria-label="База знаний сессии">
    <header className="dsh-knowledge-activity-header">
      <div className="dsh-knowledge-activity-title">
        <span className="dsh-knowledge-activity-mark"><IconDatabaseOutline16 size={17} /></span>
        <span><strong>База знаний</strong><small>Текущая сессия · {shortId(sessionId)}</small></span>
      </div>
      <div className="dsh-knowledge-activity-header-actions">
        <button type="button" className="dsh-knowledge-activity-icon-button" aria-label="Открыть в полном рабочем пространстве" title="Полное рабочее пространство" onClick={openWorkspace}><IconFullscreenOutline16 size={16} /></button>
        <button type="button" className="dsh-knowledge-activity-icon-button" aria-label="Закрыть базу знаний сессии" title="Закрыть" onClick={() => props.controller.close(sessionId)}><IconCloseOutline16 size={16} /></button>
      </div>
    </header>

    <nav className="dsh-knowledge-activity-tabs" aria-label="Типы содержимого базы знаний">
      <button type="button" className={mode === 'knowledge' ? 'is-active' : ''} aria-pressed={mode === 'knowledge'} onClick={() => selectMode('knowledge')}><IconDatabaseOutline16 size={15} />Документы знаний</button>
      <button type="button" className={mode === 'notes' ? 'is-active' : ''} aria-pressed={mode === 'notes'} onClick={() => selectMode('notes')}><IconDataOutline16 size={15} />Заметки</button>
    </nav>

    {mode === 'notes'
      ? <KnowledgeActivityNotes sessionId={sessionId} projectId={projectId} controller={props.controller} />
      : selectedDocumentId === undefined
      ? <div className="dsh-knowledge-activity-browser">
        <form className="dsh-knowledge-activity-search" role="search" onSubmit={submitSearch}>
          <IconSearchOutline16 size={16} aria-hidden="true" />
          <input aria-label="Поиск по документам знаний текущей сессии" value={queryInput} placeholder="Поиск по подключённым знаниям…" onChange={event => setQueryInput(event.target.value)} />
          {queryInput && <button type="button" onClick={clearSearch} aria-label="Очистить поиск"><IconCloseOutline16 size={14} /></button>}
        </form>

        {mountState === 'loading' ? <ActivityState label="Чтение подключений сессии…" />
          : mountState === 'error' ? <ActivityError message={error} onRetry={() => { void refreshMounts() }} />
            : mounts.length === 0 ? <ActivityEmpty title="В текущей сессии нет подключённых баз знаний" description="Подключите базу в полном рабочем пространстве — и документы будут под рукой." />
              : <>
                <div ref={scopeRef} className="dsh-knowledge-activity-scope">
                  <button type="button" className="dsh-knowledge-activity-scope-trigger" aria-haspopup="listbox" aria-expanded={baseMenuOpen} onClick={() => setBaseMenuOpen(value => !value)}>
                    <span className="dsh-knowledge-activity-scope-icon"><IconDatabaseOutline16 size={15} /></span>
                    <span><small>Текущая база знаний</small><strong>{mounts.find(item => item.knowledgeBaseId === selectedBaseId)?.base.name}</strong></span>
                    <IconChevronDownOutline14 size={14} className={baseMenuOpen ? 'is-open' : ''} />
                  </button>
                  {baseMenuOpen && <div className="dsh-knowledge-activity-scope-menu" role="listbox" aria-label="Переключить базу знаний">
                    {mounts.map(mount => <button
                      type="button"
                      role="option"
                      aria-selected={selectedBaseId === mount.knowledgeBaseId}
                      key={mount.knowledgeBaseId}
                      className={selectedBaseId === mount.knowledgeBaseId ? 'is-active' : ''}
                      onClick={() => selectBase(mount.knowledgeBaseId)}
                    ><IconDataOutline16 size={15} /><span><strong>{mount.base.name}</strong><small>{mount.inheritedFrom === 'project' ? 'Подключение проекта' : 'Подключение сессии'}</small></span></button>)}
                  </div>}
                </div>
                <div className="dsh-knowledge-activity-list-heading">
                  <span><strong>{query ? `Результаты «${query}»` : 'Документы знаний'}</strong><small>{query ? 'Поиск по всем подключённым базам' : `Показано: ${documents.length}`}</small></span>
                  <button type="button" className="dsh-knowledge-activity-icon-button" aria-label="Обновить документы" title="Обновить" onClick={() => { void loadIndex() }}><IconRefreshOutline14 size={14} /></button>
                </div>
                <div className="dsh-knowledge-activity-list" aria-busy={listState === 'loading'}>
                  {listState === 'loading' && documents.length === 0 ? <ActivityState label="Чтение документов…" />
                    : listState === 'error' ? <ActivityError message={error} onRetry={() => { void loadIndex() }} />
                      : documents.length === 0 ? <ActivityEmpty title={query ? 'Ничего не найдено' : 'Здесь пока нет документов знаний'} description={query ? 'Измените запрос или очистите поиск и просмотрите каталог.' : 'Одобренные или записанные напрямую знания появятся здесь.'} />
                        : <><GroupedDocuments documents={documents} mounts={mounts} searching={Boolean(query)} onSelect={selectDocument} />
                        {nextCursor && <button type="button" className="dsh-knowledge-activity-load-more" disabled={listState === 'loading'} onClick={() => { void loadIndex(nextCursor, true) }}>{listState === 'loading' ? 'Загрузка…' : 'Загрузить ещё'}</button>}</>}
                </div>
              </>}
      </div>
      : <DocumentReader
        value={documentValue}
        state={documentState}
        error={error}
        onBack={closeDocument}
        onRetry={() => setDocumentRefresh(value => value + 1)}
      />}
  </section>
}

function GroupedDocuments({ documents, mounts, searching, onSelect }: { documents: KnowledgeDocumentSummary[]; mounts: ResolvedKnowledgeMount[]; searching: boolean; onSelect(value: KnowledgeDocumentSummary): void }): JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const groups = useMemo(() => {
    const result = new Map<string, KnowledgeDocumentSummary[]>()
    for (const doc of documents) { const key = JSON.stringify([doc.knowledgeBaseId, doc.group || '']); const list = result.get(key) ?? []; list.push(doc); result.set(key, list) }
    return [...result].sort((a, b) => compareNames(a[1][0]?.group || '\uffff', b[1][0]?.group || '\uffff'))
  }, [documents])
  return <>{groups.map(([key, members]) => {
    const first = members[0]!
    const name = first.group || 'Без группы'
    const expanded = searching || !collapsed.has(key)
    return <section key={key} className="dsh-knowledge-activity-document-group"><button type="button" className="dsh-knowledge-activity-group-toggle" aria-expanded={expanded} onClick={() => setCollapsed(previous => { const next = new Set(previous); if (expanded) next.add(key); else next.delete(key); return next })}><IconChevronDownOutline14 size={14} /><strong>{name}</strong><small>{members.length}</small></button>{expanded && members.map(document => <DocumentRow key={document.id} document={document} baseName={searching ? mounts.find(item => item.knowledgeBaseId === document.knowledgeBaseId)?.base.name : undefined} onClick={() => onSelect(document)} />)}</section>
  })}</>
}

function DocumentRow({ document, baseName, onClick }: { document: KnowledgeDocumentSummary; baseName: string | undefined; onClick(): void }): JSX.Element {
  const stateLabel = document.documentState === 'resolved' ? 'Решён' : document.documentState === 'complete' ? 'Завершён' : undefined
  return <button type="button" className="dsh-knowledge-activity-row" onClick={onClick}>
    <span className="dsh-knowledge-activity-row-icon"><IconDataOutline16 size={16} /></span>
    <span className="dsh-knowledge-activity-row-copy"><strong>{document.title}</strong><small>{baseName ? `${baseName} · ${document.relPath}` : document.relPath}</small></span>
    <span className="dsh-knowledge-activity-row-meta">{stateLabel && <em>{stateLabel}</em>}<time dateTime={document.updatedAt}>{formatDate(document.updatedAt)}</time></span>
  </button>
}

function DocumentReader({ value, state, error, onBack, onRetry }: {
  value: KnowledgeDocument | undefined
  state: 'idle' | 'loading' | 'ready' | 'error'
  error: string
  onBack(): void
  onRetry(): void
}): JSX.Element {
  const html = useMemo(() => value === undefined ? '' : renderMarkdown(readableMarkdown(value.content)), [value])
  return <div className="dsh-knowledge-activity-reader">
    <div className="dsh-knowledge-activity-reader-bar">
      <button type="button" className="dsh-knowledge-activity-back" onClick={onBack}><IconChevronLeftOutline14 size={14} />Каталог документов</button>
      {value && <span>Обновлено {formatDate(value.updatedAt)}</span>}
    </div>
    {state === 'loading' ? <ActivityState label="Открытие документа…" />
      : state === 'error' ? <ActivityError message={error} onRetry={onRetry} />
        : value === undefined ? <ActivityState label="Подготовка документа…" />
          : <><div className="dsh-knowledge-activity-document-heading">
            <span className="dsh-knowledge-activity-document-icon"><IconDataOutline16 size={18} /></span>
            <div><h2>{value.title}</h2><p>{value.relPath}</p></div>
          </div>
          <article className="dsh-knowledge-activity-markdown" dangerouslySetInnerHTML={{ __html: html }} /></>}
  </div>
}

function ActivityState({ label }: { label: string }): JSX.Element {
  return <p className="dsh-knowledge-activity-state" role="status"><span aria-hidden="true" />{label}</p>
}

function ActivityError({ message, onRetry }: { message: string; onRetry(): void }): JSX.Element {
  return <div className="dsh-knowledge-activity-error" role="alert"><strong>Не удаётся прочитать</strong><p>{message}</p><button type="button" onClick={onRetry}>Повторить</button></div>
}

function ActivityEmpty({ title, description }: { title: string; description: string }): JSX.Element {
  return <div className="dsh-knowledge-activity-empty"><span><IconDatabaseOutline16 size={20} /></span><strong>{title}</strong><p>{description}</p></div>
}

function readableMarkdown(value: string): string {
  return value.replace(/^---\s*\n[\s\S]*?\n---\s*\n*/u, '').replace(/^#\s+[^\n]+\n*/u, '')
}

function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 7)}…${value.slice(-5)}`
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Неизвестное время'
  // Локаль НЕ прибита к zh-CN: иначе порядок и вид даты не соответствуют UI.
  return new Intl.DateTimeFormat('ru-RU', { month: '2-digit', day: '2-digit' }).format(date)
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
