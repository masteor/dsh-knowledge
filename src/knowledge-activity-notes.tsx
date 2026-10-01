import { useCallback, useEffect, useMemo, useState, useRef, type FormEvent } from 'react'
// DSH 0.1.7 renamed size-suffixed icon exports to weight-suffixed ones;
// aliases keep every call site (and the contract tests) on legacy names.
import {
  IconChevronLeftOutlineRegular as IconChevronLeftOutline14,
  IconChevronRightOutlineRegular as IconChevronRightOutline14,
  IconCloseOutlineRegular as IconCloseOutline16,
  IconDataOutlineRegular as IconDataOutline16,
  IconFolderOpenOutlineRegular as IconFolderOpenOutline16,
  IconRefreshOutlineRegular as IconRefreshOutline14,
  IconSearchOutlineRegular as IconSearchOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { NoteNode } from './notes/domain.js'
import { loadNoteContent, loadNoteIndex, type KnowledgeActivityNoteContent } from './knowledge-activity-api.js'
import type { KnowledgeActivityController } from './knowledge-activity-controller.js'
import { LatestRequest } from './latest-request.js'
import { renderMarkdown } from './web-markdown-preview.js'

interface NotesPaneProps {
  sessionId: string
  projectId?: string
  controller: KnowledgeActivityController
}

interface FolderCrumb { id: string | null; name: string }

export function KnowledgeActivityNotes({ sessionId, projectId, controller }: NotesPaneProps): JSX.Element {
  const initial = controller.selection(sessionId)
  const [folderId, setFolderId] = useState<string | null>(initial.noteFolderId ?? null)
  const [crumbs, setCrumbs] = useState<FolderCrumb[]>(initial.noteCrumbs ?? [{ id: null, name: 'Все заметки' }])
  const [selectedId, setSelectedId] = useState(initial.noteDocumentId)
  const [nodes, setNodes] = useState<NoteNode[]>([])
  const [content, setContent] = useState<KnowledgeActivityNoteContent>()
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [contentState, setContentState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = useState('')
  const listRequest = useRef(new LatestRequest())
  const [refresh, setRefresh] = useState(0)

  const loadNodes = useCallback(async (): Promise<void> => {
    const signal = listRequest.current.start()
    setListState('loading')
    setError('')
    try {
      const value = await loadNoteIndex({
        sessionId,
        ...projectId === undefined ? {} : { projectId },
        parentId: folderId,
        query,
        ...signal === undefined ? {} : { signal },
      })
      if (signal.aborted) return
      setNodes(value)
      setListState('ready')
    } catch (reason) {
      if (signal?.aborted) return
      setListState('error')
      setError(message(reason))
    }
  }, [folderId, projectId, query, sessionId])

  useEffect(() => {
    void loadNodes()
    return () => { listRequest.current.cancel() }
  }, [loadNodes, refresh])

  useEffect(() => {
    if (selectedId === undefined) {
      setContent(undefined)
      setContentState('idle')
      return
    }
    const abort = new AbortController()
    setContentState('loading')
    setError('')
    void loadNoteContent({
      id: selectedId,
      sessionId,
      ...projectId === undefined ? {} : { projectId },
      signal: abort.signal,
    }).then(value => {
      if (abort.signal.aborted) return
      setContent(value)
      setContentState('ready')
    }).catch(reason => {
      if (abort.signal.aborted) return
      setContentState('error')
      setError(message(reason))
    })
    return () => { abort.abort() }
  }, [projectId, refresh, selectedId, sessionId])

  const openFolder = (node: NoteNode): void => {
    setFolderId(node.id)
    const nextCrumbs = [...crumbs, { id: node.id, name: node.name }]
    setCrumbs(nextCrumbs)
    setQuery('')
    setQueryInput('')
    controller.select(sessionId, { mode: 'notes', noteFolderId: node.id, noteDocumentId: undefined, noteCrumbs: nextCrumbs })
  }
  const openCrumb = (crumb: FolderCrumb, index: number): void => {
    setFolderId(crumb.id)
    const nextCrumbs = crumbs.slice(0, index + 1)
    setCrumbs(nextCrumbs)
    setSelectedId(undefined)
    controller.select(sessionId, { mode: 'notes', noteFolderId: crumb.id, noteDocumentId: undefined, noteCrumbs: nextCrumbs })
  }
  const openNode = (node: NoteNode): void => {
    if (node.kind === 'folder') return openFolder(node)
    if (!node.editable) return
    setSelectedId(node.id)
    controller.select(sessionId, { ...controller.selection(sessionId), mode: 'notes', noteFolderId: folderId, noteDocumentId: node.id })
  }
  const closeDocument = (): void => {
    setSelectedId(undefined)
    setContent(undefined)
    controller.select(sessionId, { ...controller.selection(sessionId), mode: 'notes', noteFolderId: folderId, noteDocumentId: undefined })
  }
  const submitSearch = (event: FormEvent): void => {
    event.preventDefault()
    setSelectedId(undefined)
    setContent(undefined)
    controller.select(sessionId, { noteDocumentId: undefined })
    setQuery(queryInput.trim())
  }

  if (selectedId !== undefined) return <NoteReader
    value={content}
    state={contentState}
    error={error}
    onBack={closeDocument}
    onRetry={() => setRefresh(value => value + 1)}
  />

  return <div className="dsh-knowledge-activity-browser">
    <form className="dsh-knowledge-activity-search" role="search" onSubmit={submitSearch}>
      <IconSearchOutline16 size={16} aria-hidden="true" />
      <input aria-label="Поиск по заметкам" value={queryInput} placeholder="Поиск по заметкам и папкам…" onChange={event => setQueryInput(event.target.value)} />
      {queryInput && <button type="button" onClick={() => { setQueryInput(''); setQuery('') }} aria-label="Очистить поиск"><IconCloseOutline16 size={14} /></button>}
    </form>

    {!query && <nav className="dsh-knowledge-activity-breadcrumbs" aria-label="Путь к папке заметок">
      {crumbs.map((crumb, index) => <span key={`${crumb.id ?? 'root'}-${index}`}>
        {index > 0 && <IconChevronRightOutline14 size={12} />}
        <button type="button" aria-current={index === crumbs.length - 1 ? 'location' : undefined} onClick={() => openCrumb(crumb, index)}>{crumb.name}</button>
      </span>)}
    </nav>}

    <div className="dsh-knowledge-activity-list-heading">
      <span><strong>{query ? `Результаты «${query}»` : crumbs.at(-1)?.name ?? 'Заметки'}</strong><small>{query ? 'Поиск по всем заметкам' : `Показано: ${nodes.length}`}</small></span>
      <button type="button" className="dsh-knowledge-activity-icon-button" aria-label="Обновить заметки" title="Обновить" onClick={() => setRefresh(value => value + 1)}><IconRefreshOutline14 size={14} /></button>
    </div>
    <div className="dsh-knowledge-activity-list" aria-busy={listState === 'loading'}>
      {listState === 'loading' && nodes.length === 0 ? <ActivityState label="Чтение заметок…" />
        : listState === 'error' ? <ActivityError error={error} onRetry={() => setRefresh(value => value + 1)} />
          : nodes.length === 0 ? <ActivityEmpty query={query} />
            : nodes.map(node => <button type="button" key={node.id} className="dsh-knowledge-activity-row" disabled={node.kind !== 'folder' && !node.editable} onClick={() => openNode(node)}>
              <span className="dsh-knowledge-activity-row-icon">{node.kind === 'folder' ? <IconFolderOpenOutline16 size={16} /> : <IconDataOutline16 size={16} />}</span>
              <span className="dsh-knowledge-activity-row-copy"><strong>{node.name}</strong><small>{node.kind === 'folder' ? 'Папка' : node.editable ? formatSize(node.size) : 'Предпросмотр в панели недоступен'}</small></span>
              <span className="dsh-knowledge-activity-row-meta"><time dateTime={node.updatedAt}>{formatDate(node.updatedAt)}</time>{node.kind === 'folder' && <IconChevronRightOutline14 size={13} />}</span>
            </button>)}
    </div>
  </div>
}

function NoteReader({ value, state, error, onBack, onRetry }: {
  value: KnowledgeActivityNoteContent | undefined
  state: 'idle' | 'loading' | 'ready' | 'error'
  error: string
  onBack(): void
  onRetry(): void
}): JSX.Element {
  const html = useMemo(() => value === undefined ? '' : renderMarkdown(value.content), [value])
  return <div className="dsh-knowledge-activity-reader">
    <div className="dsh-knowledge-activity-reader-bar">
      <button type="button" className="dsh-knowledge-activity-back" onClick={onBack}><IconChevronLeftOutline14 size={14} />Каталог заметок</button>
      {value && <span>Обновлено {formatDate(value.node.updatedAt)}</span>}
    </div>
    {state === 'loading' ? <ActivityState label="Открытие заметки…" />
      : state === 'error' ? <ActivityError error={error} onRetry={onRetry} />
        : value === undefined ? <ActivityState label="Подготовка заметки…" />
          : <><div className="dsh-knowledge-activity-document-heading">
            <span className="dsh-knowledge-activity-document-icon"><IconDataOutline16 size={18} /></span>
            <div><h2>{value.node.name}</h2><p>Заметка · {formatSize(value.node.size)}</p></div>
          </div>
          <article className="dsh-knowledge-activity-markdown" dangerouslySetInnerHTML={{ __html: html }} /></>}
  </div>
}

function ActivityState({ label }: { label: string }): JSX.Element {
  return <p className="dsh-knowledge-activity-state" role="status"><span aria-hidden="true" />{label}</p>
}

function ActivityError({ error, onRetry }: { error: string; onRetry(): void }): JSX.Element {
  return <div className="dsh-knowledge-activity-error" role="alert"><strong>Не удаётся прочитать</strong><p>{error}</p><button type="button" onClick={onRetry}>Повторить</button></div>
}

function ActivityEmpty({ query }: { query: string }): JSX.Element {
  return <div className="dsh-knowledge-activity-empty"><span><IconDataOutline16 size={20} /></span><strong>{query ? 'Заметки не найдены' : 'Эта папка пуста'}</strong><p>{query ? 'Измените запрос или очистите поиск и просмотрите каталог.' : 'Заметки можно создать или импортировать в полном рабочем пространстве.'}</p></div>
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Неизвестное время'
  // Локаль НЕ прибита к zh-CN: иначе порядок и вид даты не соответствуют UI.
  return new Intl.DateTimeFormat('ru-RU', { month: '2-digit', day: '2-digit' }).format(date)
}

function formatSize(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
