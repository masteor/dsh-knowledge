const API_BASE = document.querySelector('meta[name="dsh-knowledge-api"]')?.content || '/knowledge-api/v1'
const AUTH_MODE = document.querySelector('meta[name="dsh-knowledge-auth-mode"]')?.content || 'bearer'
const WEB_PATH = document.querySelector('meta[name="dsh-knowledge-web"]')?.content || '/knowledge'
const ASSET_VERSION = document.querySelector('meta[name="dsh-knowledge-asset-version"]')?.content || ''
const moduleUrl = name => `./${name}.js${ASSET_VERSION ? `?v=${encodeURIComponent(ASSET_VERSION)}` : ''}`
const { createDocumentGroupField, renderDocumentGroups, openDocumentGroupOrganizer } = await import(moduleUrl('document-groups'))
const [apiModule, themeModule, uiModule, modelCatalogModule, dialogModule, selectModule, documentActionsModule] = await Promise.all([
  import(moduleUrl('api-client')),
  import(moduleUrl('host-theme')),
  import(moduleUrl('ui-primitives')),
  import(moduleUrl('model-catalog')),
  import(moduleUrl('dialogs')),
  import(moduleUrl('select-control')),
  import(moduleUrl('document-actions')),
])
const { createApiClient } = apiModule
const { installHostThemeBridge } = themeModule
const { actionButton, badge, createToastPresenter, element, interfaceIcon, paneToggleButton } = uiModule
const { renderMenu: renderDocumentMenu, closeMenus: closeDocumentMenus } = documentActionsModule.createDocumentMenuPresenter(uiModule)
const readModelCatalog = modelCatalogModule.createModelCatalogLoader()
const { createWritebackWorkspace } = await import(moduleUrl('writeback-workspace'))
const { createWorklogWorkspace } = await import(moduleUrl('worklog-workspace'))
const { createDocumentSync } = await import(moduleUrl('document-sync'))
const { openNoteExcerpt } = await import(moduleUrl('note-excerpt'))
const { createBaseGroups, knowledgeBasePathLabel, sortKnowledgeBasesByGroup } = await import(moduleUrl('base-groups'))
let baseGroups
let writebackWorkspace
let worklogWorkspace
const TOKEN_KEY = 'dsh-knowledge.session-token'
const TYPES = ['preference', 'fact', 'decision', 'procedure', 'lesson']
const TYPE_LABELS = { preference: 'Предпочтение', fact: 'Факт', decision: 'Решение', procedure: 'Процесс', lesson: 'Опыт' }
const ACTION_LABELS = { create: 'Добавлено', update: 'Обновить', conflict: 'Конфликт' }
const STATUS_LABELS = { active: 'Действует', archived: 'В архиве', pending: 'На проверке', approved: 'Принято', rejected: 'Отклонено' }
const CHANGE_LABELS = { create: 'Создать', update: 'Обновить', archive: 'В архив', restore: 'Восстановить' }
const WRITE_MODE_LABELS = { none: 'Только извлечение', audit: 'Запись с проверкой', direct: 'Прямая запись' }
const EVIDENCE_LABELS = { explicit: 'Явно указано пользователем', verified: 'Результат проверен', inferred: 'Вывод модели' }
const DOCUMENT_STATE_LABELS = { open: 'В процессе', resolved: 'Решено', complete: 'Сбор завершён' }
const DOCUMENT_LAYOUT_KEY = 'dsh-knowledge.document-layout'
const KNOWLEDGE_DOCUMENT_DRAG_TYPE = 'application/x-dsh-knowledge-document-id'
const NOTE_MAX_FILE_SIZE = 64 * 1024 * 1024
const pageParams = new URLSearchParams(location.search)
const initialKnowledgeBaseId = pageParams.get('knowledgeBaseId')?.trim() || ''
const initialDocumentId = pageParams.get('documentId')?.trim() || ''
const initialView = ['notes', 'writeback', 'worklog'].includes(pageParams.get('view')) ? pageParams.get('view') : 'entries'
const initialNoteId = pageParams.get('noteId')?.trim() || ''
const mountContext = {
  sessionId: pageParams.get('sessionId')?.trim() || '',
  projectId: pageParams.get('projectId')?.trim() || '',
}
const app = document.querySelector('#app')
const toastRegion = document.querySelector('#toast-region')
const showToast = createToastPresenter(toastRegion)
const { openConfirm, openSheet, openModal } = dialogModule.createDialogPresenter({ element, actionButton, interfaceIcon, showToast, friendlyError })
selectModule.installSelectControls()
const savedDocumentLayout = readDocumentLayout()

function createDocumentViewState(overrides = {}) {
  return {
    knowledgeBaseId: '', documentId: '', query: '', mode: 'preview', treeOpen: false,
    expandedBases: new Set(), documentPages: new Map(),
    collapsedGroups: new Set(),
    searchResults: [], searchNextCursor: '', searchTotal: 0, searchLoading: false, searchError: '', searchRequest: 0,
    editor: null, editorLoading: false, loadingDocumentId: '', ...overrides,
  }
}

const state = {
  token: sessionStorage.getItem(TOKEN_KEY) || '',
  view: initialView,
  menuOpen: false,
  stats: null,
  overview: null,
  knowledgeBases: [],
  knowledgeBaseView: 'libraries',
  knowledgeBaseQuery: '',
  mounts: [],
  resolvedMounts: [],
  mountContext,
  mountManager: {
    targetKind: mountContext.sessionId ? 'session' : 'project',
    query: '',
    filter: 'all',
    selectedIds: new Set(),
  },
  entries: [],
  nextCursor: null,
  entryFilters: { query: '', type: '', status: 'active', projectId: '', knowledgeBaseId: '' },
  documents: [],
  documentView: createDocumentViewState({
    knowledgeBaseId: initialKnowledgeBaseId,
    documentId: initialDocumentId,
    sidebarHidden: savedDocumentLayout.sidebarHidden,
    sidebarWidth: savedDocumentLayout.sidebarWidth,
  }),
  libraryDetail: {
    knowledgeBaseId: '',
    documents: [],
    error: '',
    view: createDocumentViewState(),
  },
  candidates: [],
  candidateTargets: new Map(),
  candidateStatus: 'pending',
  candidateBatchRunning: false,
  settings: { writebackPolicy: 'conservative', updatedAt: '' },
  modelCatalog: null,
  settingsSaving: false,
  tokens: [],
  notes: {
    children: new Map(), loadedFolders: new Set(), expandedFolders: new Set(),
    selectedId: initialNoteId, selectedNode: null, currentFolderId: null, breadcrumbs: [],
    content: '', draft: '', dirty: false, assetUrl: '', query: '', searchResults: [],
    transfer: null, loadingNodeId: '', shares: [], shareError: '', browserOpen: false,
  },
  service: { publicApiEnabled: false, publicApiPrefix: '/knowledge-api/v1', remote: false },
  scrollPositions: new Map(),
  loading: false,
  loadingPhase: '',
  loadingProgress: 0,
  error: '',
}

let scrollRestoreFrame = 0
let navigationController = null
let navigationRequest = 0
let navigationSave = Promise.resolve(true)
let libraryDetailRequest = 0
let documentSearchTimer = 0
let documentSearchController = null
let noteSearchTimer = 0
let noteSearchController = null
let noteSearchRequest = 0
let markdownEditorHandle = null
let noteEditorLoader = null
let markdownEditorMountRequest = 0
let plainTextEditorHandle = null
let plainTextEditorMountRequest = 0
let noteTransferFrame = 0
let noteTransferSequence = 0
let noteSelectionRequest = 0
let knowledgeDocumentDrag = null
let movingDocumentId = ''

function readDocumentLayout() {
  const fallback = {
    sidebarHidden: false,
    sidebarWidth: 214,
  }
  try {
    const value = JSON.parse(localStorage.getItem(DOCUMENT_LAYOUT_KEY) || '{}')
    return {
      sidebarHidden: value.sidebarHidden === true,
      sidebarWidth: clampNumber(value.sidebarWidth, 190, 340, fallback.sidebarWidth),
    }
  } catch { return fallback }
}

function saveDocumentLayout() {
  try {
    localStorage.setItem(DOCUMENT_LAYOUT_KEY, JSON.stringify({
      sidebarHidden: state.documentView.sidebarHidden,
      sidebarWidth: state.documentView.sidebarWidth,
    }))
  } catch {}
}

function clampNumber(value, minimum, maximum, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.round(number))) : fallback
}

function captureScrollPosition() {
  const shell = app.querySelector('.app-shell[data-view]')
  if (!shell || shell.dataset.loading === 'true') return
  const regions = {}
  shell.querySelectorAll('[data-scroll-key]').forEach(node => {
    const key = node.getAttribute('data-scroll-key')
    if (key) regions[key] = { left: node.scrollLeft, top: node.scrollTop }
  })
  state.scrollPositions.set(shell.dataset.scrollState || shell.dataset.view, {
    window: { left: window.scrollX, top: window.scrollY },
    regions,
  })
}

function currentScrollState() {
  return state.view === 'bases' ? `bases:${state.knowledgeBaseView}` : state.view
}

function restoreScrollPosition(view) {
  if (state.loading) return
  const saved = state.scrollPositions.get(view)
  if (!saved) return
  if (scrollRestoreFrame) window.cancelAnimationFrame(scrollRestoreFrame)
  scrollRestoreFrame = window.requestAnimationFrame(() => {
    window.scrollTo(saved.window.left, saved.window.top)
    app.querySelectorAll('[data-scroll-key]').forEach(node => {
      const position = saved.regions[node.getAttribute('data-scroll-key')]
      if (!position) return
      node.scrollLeft = position.left
      node.scrollTop = position.top
    })
    scrollRestoreFrame = 0
  })
}

const { api, binaryRequest, binaryUploadRequest } = createApiClient({
  apiBase: API_BASE,
  authMode: AUTH_MODE,
  getToken: () => state.token,
})

async function boot() {
  if (AUTH_MODE === 'same-origin') {
    state.token = ''
    await Promise.all([
      api('service').then(service => { state.service = service }).catch(() => {}),
      navigate(initialView),
    ])
    renderShell()
    return
  }
  if (!state.token) {
    renderLogin()
    return
  }
  try {
    await api('entries?limit=1')
    await navigate(initialView)
  } catch (error) {
    sessionStorage.removeItem(TOKEN_KEY)
    state.token = ''
    renderLogin(error.status === 401 ? 'Токен недействителен или отозван, введите его заново.' : 'Пока не удаётся подключиться к базе знаний.')
  }
}

function renderLogin(message = '') {
  const tokenInput = element('input', {
    class: 'input', type: 'password', name: 'token', autocomplete: 'current-password',
    placeholder: 'Введите токен доступа администратора или только для чтения', required: true, autofocus: true,
  })
  const error = element('p', { class: 'login-error', role: 'alert' }, message)
  const submit = actionButton('Подключить базу знаний', () => form.requestSubmit(), 'primary')
  const form = element('form', {
    onSubmit: async (event) => {
      event.preventDefault()
      const token = tokenInput.value.trim()
      if (!token) return
      submit.disabled = true
      submit.textContent = 'Подключение…'
      error.textContent = ''
      state.token = token
      try {
        await api('entries?limit=1')
        sessionStorage.setItem(TOKEN_KEY, token)
        await navigate(initialView)
      } catch (requestError) {
        state.token = ''
        error.textContent = requestError.status === 401 ? 'Токен недействителен или отозван.' : 'Не удалось подключиться. Проверьте состояние сервиса и повторите попытку.'
        submit.disabled = false
        submit.textContent = 'Подключить базу знаний'
        tokenInput.focus()
      }
    },
  },
  element('div', { class: 'field' },
    element('label', { for: 'login-token' }, 'Токен доступа'),
    Object.assign(tokenInput, { id: 'login-token' }),
    element('span', { class: 'field-hint' }, 'Токен хранится только в текущей вкладке браузера и удаляется при её закрытии.'),
  ), error, submit)

  app.replaceChildren(element('main', { class: 'login-page' }, element('section', { class: 'login-card', 'aria-labelledby': 'login-title' },
    element('div', { class: 'brand-mark', 'aria-hidden': 'true' }, 'K'),
    element('h1', { id: 'login-title' }, 'База знаний DSH'),
    element('p', {}, 'Управляйте долгосрочными знаниями из диалогов и кандидатами от ИИ.'),
    form,
  )))
}

function signOut() {
  cancelPendingSearches()
  releaseNoteEditors()
  releaseNoteAsset()
  sessionStorage.removeItem(TOKEN_KEY)
  Object.assign(state, { token: '', stats: null, overview: null, knowledgeBases: [], mounts: [], resolvedMounts: [], entries: [], documents: [], candidates: [], candidateTargets: new Map(), settings: { writebackPolicy: 'conservative', updatedAt: '' }, tokens: [] })
  state.notes = { children: new Map(), loadedFolders: new Set(), expandedFolders: new Set(), selectedId: '', selectedNode: null, currentFolderId: null, breadcrumbs: [], content: '', draft: '', dirty: false, assetUrl: '', query: '', searchResults: [], transfer: null, loadingNodeId: '', shares: [], shareError: '', browserOpen: false }
  if (AUTH_MODE === 'same-origin') void boot()
  else renderLogin()
}

async function navigate(view) {
  const request = ++navigationRequest
  navigationSave = navigationSave.then(() => saveBeforeNavigation(), () => saveBeforeNavigation())
  if (!await navigationSave || request !== navigationRequest) return
  cancelPendingSearches()
  navigationController?.abort()
  const controller = new AbortController()
  navigationController = controller
  const previousView = state.view
  if (view === 'bases' && previousView !== 'bases' && state.knowledgeBaseView === 'detail') {
    state.knowledgeBaseView = 'libraries'
  }
  state.view = view
  state.menuOpen = false
  state.loading = true
  state.loadingPhase = loadingPhaseForView(view)
  state.loadingProgress = .12
  state.error = ''
  renderShell()
  try {
    if (view === 'overview') await loadOverview(controller.signal)
    if (view === 'bases') await loadKnowledgeBasesPage(controller.signal)
    if (view === 'entries') await loadDocuments(controller.signal, (label, progress) => updateLoadingPhase(request, label, progress))
    if (view === 'candidates') await loadCandidates(controller.signal)
    if (view === 'notes') await loadNotes(controller.signal, (label, progress) => updateLoadingPhase(request, label, progress))
    if (view === 'shares') await loadNoteShares(controller.signal)
    if (view === 'tokens') await loadTokens(controller.signal)
  } catch (error) {
    if (controller.signal.aborted) return
    if (error.status === 401 && AUTH_MODE === 'bearer') return signOut()
    state.error = friendlyError(error)
  } finally {
    if (navigationController !== controller) return
    state.loading = false
    state.loadingPhase = ''
    state.loadingProgress = 1
    renderShell()
  }
}

function cancelPendingSearches() {
  state.documentView.searchRequest += 1
  state.libraryDetail.view.searchRequest += 1
  noteSearchRequest += 1
  window.clearTimeout(documentSearchTimer)
  window.clearTimeout(noteSearchTimer)
  documentSearchController?.abort()
  noteSearchController?.abort()
  documentSearchController = null
  noteSearchController = null
  documentSearchTimer = 0
  noteSearchTimer = 0
}

function loadingPhaseForView(view) {
  return ({
    overview: 'Сбор сведений о работе с базой', bases: 'Чтение настроек баз знаний', entries: 'Чтение каталога знаний',
    notes: 'Чтение каталога заметок', shares: 'Чтение списка ссылок общего доступа', candidates: 'Подготовка очереди проверки', tokens: 'Чтение прав доступа',
  })[view] || 'Подготовка рабочей области'
}

function updateLoadingPhase(request, label, progress) {
  if (request !== navigationRequest || !state.loading) return
  state.loadingPhase = label
  state.loadingProgress = Math.max(0, Math.min(1, progress))
  const progressNode = document.querySelector('.route-progress')
  progressNode?.setAttribute('aria-label', label)
  progressNode?.setAttribute('aria-valuenow', String(Math.round(state.loadingProgress * 100)))
  progressNode?.firstElementChild?.style.setProperty('--route-progress', String(state.loadingProgress))
}

async function saveBeforeNavigation() {
  if (state.view === 'notes' && (state.notes.dirty || state.notes.titleDirty || state.notes.renaming)) return saveNoteDocument()
  return saveBeforeLeavingDocument()
}

async function saveBeforeLeavingDocument() {
  const workspace = activeDocumentWorkspace()
  const editor = workspace?.view.editor
  if (!workspace || !editor?.dirty) return true
  const emptyDraft = editor.isNew && !editor.title.trim() && !editor.body.trim()
  if (emptyDraft) {
    workspace.view.editor = null
    workspace.view.documentId = ''
    return true
  }
  return saveDocumentEditor(workspace)
}

async function refreshStats(signal) {
  state.stats = await api('stats', { signal })
}

async function ensureKnowledgeBases(force = false, signal) {
  if (force || state.knowledgeBases.length === 0) state.knowledgeBases = await api('knowledge-bases', { signal })
  return state.knowledgeBases
}

async function loadKnowledgeBasesPage(signal) {
  const options = { signal }
  const requests = [api('knowledge-bases', options), api('mounts', options), api('settings', options), api('service', options)]
  if (state.mountContext.sessionId) {
    const params = new URLSearchParams({ sessionId: state.mountContext.sessionId })
    if (state.mountContext.projectId) params.set('projectId', state.mountContext.projectId)
    requests.push(api(`mounts/resolve?${params}`, options))
  }
  const [bases, mounts, settings, service, resolved = []] = await Promise.all(requests)
  state.knowledgeBases = bases
  state.mounts = mounts
  state.settings = settings
  state.service = service
  state.resolvedMounts = resolved
  await refreshStats(signal)
}

async function loadOverview(signal) {
  const options = { signal }
  const [stats, recent, pending, bases] = await Promise.all([
    api('stats', options),
    api('entries?status=active&limit=6', options),
    api('candidates?status=pending&limit=5', options),
    api('knowledge-bases', options),
  ])
  state.stats = stats
  state.knowledgeBases = bases
  state.overview = { recent: recent.items, pending }
}

async function loadEntries(cursor = '') {
  await ensureKnowledgeBases()
  const filters = state.entryFilters
  let result
  if (filters.query.trim() && filters.status === 'active' && !cursor) {
    const params = new URLSearchParams({ q: filters.query.trim(), limit: '100' })
    if (filters.projectId.trim()) params.set('projectId', filters.projectId.trim())
    if (filters.type) params.append('type', filters.type)
    if (filters.knowledgeBaseId) params.append('knowledgeBaseId', filters.knowledgeBaseId)
    const hits = await api(`search?${params}`)
    result = { items: hits.map(hit => hit.entry) }
  } else {
    const params = new URLSearchParams({ limit: '50', status: filters.status })
    if (filters.type) params.set('type', filters.type)
    if (filters.projectId.trim()) params.set('projectId', filters.projectId.trim())
    if (filters.knowledgeBaseId) params.set('knowledgeBaseId', filters.knowledgeBaseId)
    if (cursor) params.set('cursor', cursor)
    result = await api(`entries?${params}`)
  }
  state.entries = cursor ? [...state.entries, ...result.items] : result.items
  state.nextCursor = result.nextCursor || null
  if (!state.stats) await refreshStats()
}

async function loadDocuments(signal, onPhase = () => {}) {
  onPhase('Чтение доступных баз знаний', .24)
  const options = { signal }
  const requests = [api('knowledge-bases', options)]
  if (state.mountContext.sessionId) {
    const params = new URLSearchParams({ sessionId: state.mountContext.sessionId })
    if (state.mountContext.projectId) params.set('projectId', state.mountContext.projectId)
    requests.push(api(`mounts/resolve?${params}`, options))
  }
  const [results, stats] = await Promise.all([
    Promise.all(requests),
    state.stats ? Promise.resolve(state.stats) : api('stats', options),
  ])
  const [bases, resolved = []] = results
  state.knowledgeBases = bases
  state.resolvedMounts = resolved
  state.stats = stats
  onPhase('Построение индекса документов', .56)
  const visibleBaseIds = new Set(documentKnowledgeBases(bases).map(base => base.id))
  state.documents = state.documents.filter(document => visibleBaseIds.has(document.knowledgeBaseId))
  const workspace = sessionDocumentWorkspace()
  const view = workspace.view
  const availableBaseIds = visibleBaseIds
  if (!view.knowledgeBaseId || !availableBaseIds.has(view.knowledgeBaseId)) {
    view.knowledgeBaseId = state.entryFilters.knowledgeBaseId && availableBaseIds.has(state.entryFilters.knowledgeBaseId)
      ? state.entryFilters.knowledgeBaseId
      : documentKnowledgeBases(bases)[0]?.id || ''
  }
  if (view.knowledgeBaseId) {
    view.expandedBases.add(view.knowledgeBaseId)
    await loadDocumentPage(workspace, view.knowledgeBaseId, { signal })
  }
  if (view.documentId && !state.documents.some(document => document.id === view.documentId)) {
    try {
      const document = await api(`documents/${encodeURIComponent(view.documentId)}`, { signal })
      if (visibleBaseIds.has(document.knowledgeBaseId)) {
        view.knowledgeBaseId = document.knowledgeBaseId
        view.expandedBases.add(document.knowledgeBaseId)
        mergeDocumentSummaries(workspace, [documentSummary(document)], document.knowledgeBaseId, false)
      } else view.documentId = ''
    } catch (error) {
      if (error.name === 'AbortError') throw error
      view.documentId = ''
    }
  }
  selectDefaultDocument(workspace)
  if (view.documentId) {
    onPhase('Открытие последнего документа', .82)
    await loadDocumentEditor(workspace, view.documentId, signal)
  }
  else view.editor = null
}

async function loadNotes(signal, onPhase = () => {}) {
  onPhase('Чтение каталога верхнего уровня', .36)
  const [rootNodes] = await Promise.all([
    api('notes?limit=500', { signal }),
    loadNoteShares(signal),
  ])
  state.notes.children.set('root', rootNodes)
  state.notes.loadedFolders.add('root')
  if (state.notes.selectedId) {
    onPhase('Восстановление последней открытой заметки', .74)
    const selected = state.notes.selectedNode?.id === state.notes.selectedId
      ? state.notes.selectedNode
      : await api(`notes/${encodeURIComponent(state.notes.selectedId)}`, { signal }).catch(() => null)
    if (!selected) clearNoteSelection()
    else await selectNoteNode(selected)
  }
}

function documentKnowledgeBases(bases = state.knowledgeBases) {
  const active = bases.filter(base => base.status === 'active')
  if (!state.mountContext.sessionId) return active
  const mountedIds = new Set(state.resolvedMounts.map(mount => mount.knowledgeBaseId))
  return active.filter(base => mountedIds.has(base.id))
}

function sessionDocumentWorkspace() {
  return { kind: 'session', view: state.documentView }
}

function libraryDocumentWorkspace() {
  return { kind: 'library', view: state.libraryDetail.view }
}

function activeDocumentWorkspace() {
  if (state.view === 'entries') return sessionDocumentWorkspace()
  if (state.view === 'bases' && state.knowledgeBaseView === 'detail') return libraryDocumentWorkspace()
  return null
}

function documentWorkspaceDocuments(workspace) {
  return workspace.kind === 'library' ? state.libraryDetail.documents : state.documents
}

function setDocumentWorkspaceDocuments(workspace, documents) {
  if (workspace.kind === 'library') state.libraryDetail.documents = documents
  else state.documents = documents
}

function documentPageState(workspace, knowledgeBaseId) {
  const pages = workspace.view.documentPages
  if (!pages.has(knowledgeBaseId)) {
    pages.set(knowledgeBaseId, { loaded: false, loading: false, nextCursor: '', total: 0, error: '' })
  }
  return pages.get(knowledgeBaseId)
}

function mergeDocumentSummaries(workspace, items, knowledgeBaseId, reset) {
  const current = documentWorkspaceDocuments(workspace)
  const retained = reset ? current.filter(document => document.knowledgeBaseId !== knowledgeBaseId) : current
  const merged = new Map(retained.map(document => [document.id, document]))
  for (const item of items) merged.set(item.id, item)
  setDocumentWorkspaceDocuments(workspace, [...merged.values()])
}

async function loadDocumentPage(workspace, knowledgeBaseId, options = {}) {
  if (!knowledgeBaseId) return
  const page = documentPageState(workspace, knowledgeBaseId)
  if (page.loading || (!options.reset && !options.append && page.loaded)) return
  if (options.append && !page.nextCursor) return
  page.loading = true
  page.error = ''
  const cursor = options.append ? page.nextCursor : ''
  try {
    const params = new URLSearchParams({ knowledgeBaseId, limit: '60' })
    if (cursor) params.set('cursor', cursor)
    const result = await api(`document-index?${params}`, { signal: options.signal })
    mergeDocumentSummaries(workspace, result.items, knowledgeBaseId, !options.append)
    page.loaded = true
    page.nextCursor = result.nextCursor || ''
    page.total = result.total
  } catch (error) {
    if (error.name === 'AbortError') throw error
    page.error = friendlyError(error)
    if (options.throwOnError) throw error
  } finally {
    page.loading = false
  }
}

async function toggleDocumentBase(workspace, baseId) {
  const view = workspace.view
  view.knowledgeBaseId = baseId
  if (view.expandedBases.has(baseId)) {
    view.expandedBases.delete(baseId)
    renderShell()
    return
  }
  view.expandedBases.add(baseId)
  const page = documentPageState(workspace, baseId)
  if (!page.loaded) page.loading = true
  renderShell()
  if (!page.loaded) {
    page.loading = false
    await loadDocumentPage(workspace, baseId)
    renderShell()
  }
}

function resetDocumentSearch(view) {
  view.searchRequest += 1
  view.searchResults = []
  view.searchNextCursor = ''
  view.searchTotal = 0
  view.searchLoading = false
  view.searchError = ''
}

function scheduleDocumentSearch(workspace) {
  window.clearTimeout(documentSearchTimer)
  documentSearchController?.abort()
  documentSearchController = null
  const view = workspace.view
  view.searchRequest += 1
  if (!view.query.trim()) {
    resetDocumentSearch(view)
    renderShell()
    return
  }
  view.searchLoading = true
  view.searchError = ''
  documentSearchTimer = window.setTimeout(() => { void loadDocumentSearch(workspace, true) }, 220)
}

function renderDocumentSearchState(workspace) {
  renderShell()
  window.requestAnimationFrame(() => {
    const input = document.querySelector(`.note-tree-search[data-document-scope="${workspace.kind}"]`)
    input?.focus()
    input?.setSelectionRange(input.value.length, input.value.length)
  })
}

async function loadDocumentSearch(workspace, reset = false) {
  const view = workspace.view
  const query = view.query.trim()
  if (!query) return resetDocumentSearch(view)
  const request = ++view.searchRequest
  documentSearchController?.abort()
  const controller = new AbortController()
  documentSearchController = controller
  view.searchLoading = true
  view.searchError = ''
  const params = new URLSearchParams({ q: query, limit: '80' })
  const bases = documentWorkspaceBases(workspace)
  if (bases.length === 0) {
    resetDocumentSearch(view)
    return renderShell()
  }
  if (workspace.kind === 'library') {
    params.append('knowledgeBaseId', state.libraryDetail.knowledgeBaseId)
  } else if (state.mountContext.sessionId) {
    params.set('sessionId', state.mountContext.sessionId)
    if (state.mountContext.projectId) params.set('projectId', state.mountContext.projectId)
  } else {
    params.set('active', '1')
  }
  if (!reset && view.searchNextCursor) params.set('cursor', view.searchNextCursor)
  try {
    const result = await api(`document-index?${params}`, { signal: controller.signal })
    if (request !== view.searchRequest || query !== view.query.trim()) return
    const merged = new Map((reset ? [] : view.searchResults).map(document => [document.id, document]))
    for (const item of result.items) merged.set(item.id, item)
    view.searchResults = [...merged.values()]
    view.searchNextCursor = result.nextCursor || ''
    view.searchTotal = result.total
  } catch (error) {
    if (controller.signal.aborted) return
    if (request !== view.searchRequest) return
    view.searchError = friendlyError(error)
  } finally {
    if (documentSearchController === controller) documentSearchController = null
    if (request === view.searchRequest) {
      view.searchLoading = false
      renderDocumentSearchState(workspace)
    }
  }
}

function documentWorkspaceBases(workspace) {
  if (workspace.kind === 'library') {
    const base = state.knowledgeBases.find(item => item.id === state.libraryDetail.knowledgeBaseId)
    return base ? [base] : []
  }
  return documentKnowledgeBases()
}

function documentWorkspaceReadOnly(workspace) {
  return workspace.kind === 'library' && documentWorkspaceBases(workspace)[0]?.status === 'archived'
}

async function reloadDocumentWorkspace(workspace) {
  const baseId = workspace.kind === 'library' ? state.libraryDetail.knowledgeBaseId : workspace.view.knowledgeBaseId
  if (!baseId) return true
  await loadDocumentPage(workspace, baseId, { reset: true, throwOnError: true })
  if (workspace.kind === 'library' && state.libraryDetail.knowledgeBaseId !== baseId) return false
  const selectedId = workspace.view.documentId
  if (selectedId && !documentWorkspaceDocuments(workspace).some(document => document.id === selectedId)) {
    const document = await api(`documents/${encodeURIComponent(selectedId)}`)
    mergeDocumentSummaries(workspace, [documentSummary(document)], baseId, false)
  }
  return true
}

function documentSummary(document) {
  const { content: _content, ...summary } = document
  return summary
}

function selectDefaultDocument(workspace) {
  const view = workspace.view
  const documents = documentWorkspaceDocuments(workspace).filter(document => document.knowledgeBaseId === view.knowledgeBaseId)
  if (!documents.some(document => document.id === view.documentId)) {
    view.documentId = documents[0]?.id || ''
  }
  if (view.knowledgeBaseId) view.expandedBases.add(view.knowledgeBaseId)
}

async function loadDocumentEditor(workspace, id, signal) {
  const revision = (workspace.view.loadRevision || 0) + 1
  workspace.view.loadRevision = revision
  const [entry, noteReferences] = await Promise.all([
    api(`entries/${encodeURIComponent(id)}`, { signal }),
    api(`entries/${encodeURIComponent(id)}/note-references`, { signal }),
  ])
  if (workspace.view.loadRevision !== revision || workspace.view.documentId !== id) return false
  workspace.view.mode = 'preview'
  workspace.view.editor = {
    ...entry,
    noteReferences,
    tagsText: entry.tags.join(', '),
    dirty: false,
    isNew: false,
    saveState: 'Сохранено',
  }
  return true
}

function createBlankDocument(workspace, baseId, group) {
  const base = state.knowledgeBases.find(item => item.id === baseId && item.status === 'active')
  if (!base) return showToast('Сначала выберите доступную базу знаний.', 'error')
  const view = workspace.view
  view.knowledgeBaseId = base.id
  view.documentId = ''
  view.mode = 'edit'
  view.treeOpen = false
  view.expandedBases.add(base.id)
  view.editor = {
    id: '', knowledgeBaseId: base.id, title: '', body: '', type: 'fact', tags: [], tagsText: '',
    group,
    scope: { kind: 'global' }, confidence: .8, noteReferences: [], dirty: true, isNew: true, saveState: 'Новый документ',
  }
  renderShell()
  document.querySelector('.note-title-input')?.focus()
}

async function startBlankDocument(workspace, baseId, group) {
  const editor = workspace.view.editor
  const emptyDraft = editor?.isNew && !editor.title.trim() && !editor.body.trim()
  if (editor?.dirty && !emptyDraft && !await saveDocumentEditor(workspace)) return
  if (!baseId) return showToast('Сначала выберите базу знаний.', 'error')
  if (group) return createBlankDocument(workspace, baseId, group)
  const field = createDocumentGroupField({ element, api, baseId, required: true })
  openSheet({ title: 'Создать документ знаний', description: 'Сначала выберите группу документа, предпочтительно из существующих.', body: field.wrapper, primaryLabel: 'Начать написание', onPrimary: async () => {
    await field.ready
    let name
    try { name = field.validate() } catch { return false }
    if (!name || name === 'без группы') throw new Error('Выберите существующую группу или укажите название новой.')
    createBlankDocument(workspace, baseId, name)
    return true
  } })
}

async function selectDocument(workspace, id) {
  const editor = workspace.view.editor
  const emptyDraft = editor?.isNew && !editor.title.trim() && !editor.body.trim()
  if (editor?.dirty && !emptyDraft && !await saveDocumentEditor(workspace)) return
  workspace.view.documentId = id
  workspace.view.treeOpen = false
  workspace.view.editor = null
  workspace.view.editorLoading = true
  workspace.view.loadingDocumentId = id
  renderShell()
  try {
    await loadDocumentEditor(workspace, id)
  } catch (error) {
    if (workspace.view.documentId === id) showToast(friendlyError(error), 'error')
  } finally {
    if (workspace.view.loadingDocumentId === id) {
      workspace.view.editorLoading = false
      workspace.view.loadingDocumentId = ''
      renderShell()
    }
  }
}

function editorDraft(editor) {
  return {
    knowledgeBaseId: editor.knowledgeBaseId,
    ...(editor.group === undefined ? {} : { group: editor.group }),
    title: editor.title.trim(),
    body: editor.body.trim(),
    type: editor.type,
    tags: parseTags(editor.tagsText),
    scope: editor.scope,
    confidence: editor.confidence,
    ...(editor.source ? { source: editor.source } : {}),
  }
}

async function saveDocumentEditor(workspace = activeDocumentWorkspace()) {
  if (!workspace) return false
  const editor = workspace.view.editor
  if (!editor || !editor.dirty) return true
  if (editor.saving) return false
  if (!editor.isNew && editor.documentState !== 'open') {
    showToast('Этот документ завершён и запечатан; сначала откройте его заново.', 'error')
    return false
  }
  if (!editor.title.trim() || !editor.body.trim()) {
    showToast('Сохранить можно только после заполнения заголовка и текста.', 'error')
    return false
  }
  if (editor.isNew && (!editor.group?.trim() || editor.group === 'без группы')) {
    showToast('Для нового документа знаний нужно указать группу.', 'error')
    return false
  }
  editor.saveState = 'Сохранение…'
  editor.saving = true
  updateEditorSaveState(editor.saveState)
  try {
    const draft = editorDraft(editor)
    const saved = editor.isNew
      ? await api('entries', { method: 'POST', body: { draft } })
      : await api(`entries/${encodeURIComponent(editor.id)}`, { method: 'PUT', body: { draft, expectedVersion: editor.version } })
    editor.id = saved.id
    editor.isNew = false
    editor.dirty = JSON.stringify(editorDraft(editor)) !== JSON.stringify(draft)
    editor.version = saved.version
    editor.documentState = saved.documentState
    editor.updatedAt = saved.updatedAt
    editor.saveState = editor.dirty ? 'Не сохранено' : 'Сохранено'
    workspace.view.documentId = saved.id
    updateEditorSaveState(editor.saveState)
    await reloadDocumentWorkspace(workspace)
    return !editor.dirty
  } catch (error) {
    editor.saveState = 'Не удалось сохранить'
    updateEditorSaveState(editor.saveState)
    showToast(friendlyError(error), 'error')
    if (error.status === 409) void openDocumentSyncConflict()
    return false
  } finally {
    editor.saving = false
  }
}

function activateKnowledgeBaseDropTarget(event, workspace, baseId) {
  const drag = knowledgeDocumentDrag
  if (!drag || drag.workspaceKind !== workspace.kind || drag.sourceBaseId === baseId) return
  if (!hasDragType(event, KNOWLEDGE_DOCUMENT_DRAG_TYPE)) return
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  document.querySelectorAll('.note-tree-group[data-drop-target="true"]').forEach(target => {
    if (target !== event.currentTarget) target.dataset.dropTarget = 'false'
  })
  event.currentTarget.dataset.dropTarget = 'true'
}

function clearKnowledgeDocumentDragState() {
  knowledgeDocumentDrag = null
  document.querySelectorAll('.note-tree-group[data-drop-target="true"]').forEach(node => { node.dataset.dropTarget = 'false' })
  document.querySelectorAll('.note-tree-document[data-dragging="true"]').forEach(node => { node.dataset.dragging = 'false' })
}

function dropKnowledgeDocument(event, workspace, targetBaseId) {
  const documentId = event.dataTransfer?.getData(KNOWLEDGE_DOCUMENT_DRAG_TYPE) || ''
  const source = documentWorkspaceDocuments(workspace).find(document => document.id === documentId)
  if (!documentId || !source || source.knowledgeBaseId === targetBaseId) return
  event.preventDefault()
  event.stopPropagation()
  clearKnowledgeDocumentDragState()
  void moveKnowledgeDocument(workspace, documentId, targetBaseId)
}

async function moveKnowledgeDocument(workspace, documentId, targetBaseId) {
  const bases = documentWorkspaceBases(workspace)
  const target = bases.find(base => base.id === targetBaseId && base.status === 'active')
  const summaries = documentWorkspaceDocuments(workspace)
  const current = summaries.find(document => document.id === documentId)
  const sourceBaseId = current?.knowledgeBaseId
    || (workspace.view.editor?.id === documentId ? workspace.view.editor.knowledgeBaseId : '')
  if (!target || !sourceBaseId || sourceBaseId === targetBaseId || movingDocumentId) return false
  const editor = workspace.view.editor
  if (editor?.id === documentId && editor.dirty && !await saveDocumentEditor(workspace)) return false

  movingDocumentId = documentId
  renderShell()
  try {
    const saved = await api(`documents/${encodeURIComponent(documentId)}/move`, {
      method: 'POST', body: { knowledgeBaseId: targetBaseId },
    })
    const latest = documentWorkspaceDocuments(workspace)
    const summary = latest.find(document => document.id === documentId) || current
    if (summary) {
      setDocumentWorkspaceDocuments(workspace, [
        { ...summary, knowledgeBaseId: targetBaseId, updatedAt: saved.updatedAt },
        ...latest.filter(document => document.id !== documentId),
      ])
    }
    workspace.view.searchResults = workspace.view.searchResults.map(document => document.id === documentId
      ? { ...document, knowledgeBaseId: targetBaseId, updatedAt: saved.updatedAt }
      : document)
    const sourcePage = documentPageState(workspace, sourceBaseId)
    const targetPage = documentPageState(workspace, targetBaseId)
    if (sourcePage.loaded) sourcePage.total = Math.max(0, sourcePage.total - 1)
    if (targetPage.loaded) targetPage.total += 1
    workspace.view.knowledgeBaseId = targetBaseId
    workspace.view.expandedBases.add(targetBaseId)
    if (workspace.view.documentId === documentId && workspace.view.editor?.id === documentId) {
      workspace.view.editor = {
        ...workspace.view.editor,
        ...saved,
        tagsText: saved.tags.join(', '),
        dirty: false,
        isNew: false,
        saveState: 'Перемещено',
      }
    }
    showToast(`Перемещено в «${target.name}».`)
    return true
  } catch (error) {
    showToast(friendlyError(error), 'error')
    return false
  } finally {
    movingDocumentId = ''
    renderShell()
  }
}

function openMoveKnowledgeDocument(workspace, editor) {
  const targets = documentWorkspaceBases(workspace).filter(base => base.status === 'active' && base.id !== editor.knowledgeBaseId)
  if (!targets.length) return showToast('Сейчас нет других баз знаний для перемещения.', 'error')
  const form = element('form', { class: 'form-grid' })
  const destination = selectField('Целевая база знаний', targets.map(base => ({ value: base.id, label: base.name })), targets[0].id)
  destination.wrapper.classList.add('span-2')
  form.append(destination.wrapper)
  return openSheet({
    title: `Переместить «${editor.title}»`,
    description: 'ID документа, история версий и связанные заметки сохранятся, проекция Markdown переместится вместе с ним.',
    body: form,
    primaryLabel: 'Переместить документ',
    onPrimary: () => moveKnowledgeDocument(workspace, editor.id, destination.input.value),
  })
}

function updateEditorSaveState(label) {
  const node = document.querySelector('.editor-save-status')
  if (node) node.textContent = label
}

async function loadCandidates(signal) {
  const [payload] = await Promise.all([
    api(`candidates?status=${state.candidateStatus}&limit=100&includeTargets=1`, { signal }),
    ensureKnowledgeBases(false, signal),
  ])
  const candidates = payload.items
  state.candidates = candidates
  state.candidateTargets = new Map(payload.targets.map(target => [target.id, target]))
  if (!state.stats) await refreshStats(signal)
}

async function loadTokens(signal) {
  const [tokens, service] = await Promise.all([api('tokens', { signal }), api('service', { signal })])
  state.tokens = tokens
  state.service = service
  if (!state.stats) await refreshStats(signal)
}

function renderShell() {
  worklogWorkspace?.dispose()
  worklogWorkspace = undefined
  writebackWorkspace?.dispose()
  writebackWorkspace = undefined
  closeDocumentMenus()
  releaseNoteEditors()
  captureScrollPosition()
  const titles = {
    overview: ['Обзор', 'Состояние базы знаний и последняя активность'],
    bases: ['Базы знаний и подключения', 'Управление каталогом знаний и областью извлечения и записи для проектов и сессий'],
    entries: ['Документы знаний', 'Чтение, упорядочивание и ведение Markdown-документов в каталоге знаний'],
    notes: ['Документ заметки', 'Упорядочивайте заметки и материалы как локальные каталоги и привязывайте их к документам базы знаний по необходимости'],
    shares: ['Опубликовано', 'Управляйте ссылками общего доступа только для чтения и импортируйте чужие заметки и каталоги'],
    candidates: ['На проверке', 'Подтвердите результаты извлечения ИИ, прежде чем записывать их в документ базы знаний'],
    writeback: ['Задачи записи', 'Посмотреть локальную очередь и разобрать неудачные и заблокированные записи'],
    worklog: ['Ежедневный отчёт', 'Упорядочивать по датам рабочий прогресс, решения и результаты, сохраняя источники'],
    tokens: ['Управление доступом', 'Управление правами других клиентов на подключение к центральной базе знаний'],
  }
  const [title, subtitle] = titles[state.view]
  const viewIndexes = { overview: '00', notes: '01', shares: '02', entries: '03', candidates: '04', writeback: '05', bases: '06', worklog: '07', tokens: '08' }
  const shell = element('div', {
    class: 'app-shell', 'data-menu-open': String(state.menuOpen),
    'data-view': state.view, 'data-loading': String(state.loading),
    'data-scroll-state': currentScrollState(),
    'data-base-detail': String(state.view === 'bases' && state.knowledgeBaseView === 'detail'),
    'data-sidebar-hidden': String(state.documentView.sidebarHidden),
    style: `--sidebar-width: ${state.documentView.sidebarWidth}px`,
  },
    renderSidebar(),
    renderAppSidebarResizer(),
    element('button', {
      type: 'button', class: 'app-sidebar-scrim', hidden: !state.menuOpen,
      'aria-label': 'Закрыть меню навигации',
      onClick: () => setMenuOpen(false),
    }),
    element('main', { class: 'main' },
      element('header', { class: 'topbar' },
        element('div', { class: 'topbar-title' },
          actionButton(interfaceIcon('menu'), () => setMenuOpen(!state.menuOpen), 'ghost mobile-menu', {
            'aria-label': state.menuOpen ? 'Закрыть меню навигации' : 'Открыть меню навигации',
            'aria-expanded': String(state.menuOpen),
          }),
          paneToggleButton('main', !state.documentView.sidebarHidden, () => setSidebarHidden(!state.documentView.sidebarHidden), 'Основная навигация'),
          renderContextPaneToggle(),
          element('div', { class: 'topbar-heading' },
            element('span', { class: 'topbar-kicker' }, `KNOWLEDGE / ${viewIndexes[state.view] || '00'}`),
            element('h1', {}, title),
            element('p', {}, subtitle)),
        ),
        state.loading ? element('div', {
          class: 'route-progress', role: 'progressbar', 'aria-label': state.loadingPhase || 'Загрузка',
          'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(state.loadingProgress * 100)),
        }, element('span', { style: `--route-progress: ${state.loadingProgress}` })) : null,
      ),
      element('div', { class: 'page', 'data-scroll-key': 'page' }, element('div', { class: 'view-stage', 'data-view-stage': state.view }, renderCurrentView())),
    ),
  )
  app.replaceChildren(shell)
  applySidebarVisibility(shell, state.documentView.sidebarHidden)
  restoreScrollPosition(currentScrollState())
  renderDocumentSyncNotice()
}

function renderContextPaneToggle() {
  if (state.view === 'notes') {
    return paneToggleButton('library', state.notes.browserOpen, () => {
      state.notes.browserOpen = !state.notes.browserOpen
      renderShell()
    }, 'Каталог заметок')
  }
  const workspace = activeDocumentWorkspace()
  if (!workspace) return null
  return paneToggleButton('library', workspace.view.treeOpen, () => {
    workspace.view.treeOpen = !workspace.view.treeOpen
    renderShell()
  }, 'Каталог знаний')
}

function renderAppSidebarResizer() {
  const minimum = 190
  const maximum = 340
  const value = state.documentView.sidebarWidth
  return element('div', {
    class: 'app-sidebar-resizer', role: 'separator', tabindex: '0',
    title: 'Перетащите, чтобы изменить ширину главной панели навигации',
    'aria-label': 'Изменить ширину главной панели навигации', 'aria-orientation': 'vertical',
    'aria-valuemin': minimum, 'aria-valuemax': maximum, 'aria-valuenow': value,
    onPointerDown: event => startSidebarResize(event, minimum, maximum),
    onKeyDown: event => resizeSidebarWithKeyboard(event, minimum, maximum),
  }, element('span', { 'aria-hidden': 'true' }, '⋮'))
}

function startSidebarResize(event, minimum, maximum) {
  if (event.button !== 0) return
  event.preventDefault()
  const handle = event.currentTarget
  const shell = handle.closest('.app-shell')
  if (!shell) return
  const startX = event.clientX
  const startWidth = state.documentView.sidebarWidth
  let pendingWidth = startWidth
  let frame = 0
  handle.setPointerCapture?.(event.pointerId)
  handle.classList.add('is-dragging')
  document.body.classList.add('is-resizing-columns')
  const move = moveEvent => {
    if (moveEvent.pointerId !== event.pointerId) return
    pendingWidth = clampNumber(startWidth + moveEvent.clientX - startX, minimum, maximum, startWidth)
    if (!frame) frame = window.requestAnimationFrame(() => {
      frame = 0
      if (shell.isConnected) setSidebarWidth(pendingWidth, shell, handle)
    })
  }
  const finish = endEvent => {
    if (endEvent.pointerId !== event.pointerId) return
    if (frame) window.cancelAnimationFrame(frame)
    frame = 0
    if (endEvent.type === 'pointerup') pendingWidth = clampNumber(startWidth + endEvent.clientX - startX, minimum, maximum, startWidth)
    if (shell.isConnected) setSidebarWidth(pendingWidth, shell, handle)
    handle.classList.remove('is-dragging')
    document.body.classList.remove('is-resizing-columns')
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', finish)
    handle.removeEventListener('pointercancel', finish)
    handle.removeEventListener('lostpointercapture', finish)
    if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId)
    saveDocumentLayout()
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', finish)
  handle.addEventListener('pointercancel', finish)
  handle.addEventListener('lostpointercapture', finish)
}

function resizeSidebarWithKeyboard(event, minimum, maximum) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const current = state.documentView.sidebarWidth
  const width = event.key === 'Home' ? minimum
    : event.key === 'End' ? maximum
    : clampNumber(current + (event.key === 'ArrowRight' ? 16 : -16), minimum, maximum, current)
  setSidebarWidth(width, event.currentTarget.closest('.app-shell'), event.currentTarget)
  saveDocumentLayout()
}

function setSidebarWidth(width, shell, handle) {
  state.documentView.sidebarWidth = width
  shell?.style.setProperty('--sidebar-width', `${width}px`)
  handle?.setAttribute('aria-valuenow', String(width))
}

function setMenuOpen(open) {
  state.menuOpen = open
  const shell = app.querySelector('.app-shell')
  if (!shell) return
  shell.dataset.menuOpen = String(open)
  shell.querySelector('.app-sidebar-scrim')?.toggleAttribute('hidden', !open)
  const toggle = shell.querySelector('.mobile-menu')
  toggle?.setAttribute('aria-expanded', String(open))
  toggle?.setAttribute('aria-label', open ? 'Закрыть меню навигации' : 'Открыть меню навигации')
  applySidebarVisibility(shell, state.documentView.sidebarHidden)
}

function setSidebarHidden(hidden) {
  state.documentView.sidebarHidden = hidden
  saveDocumentLayout()
  const shell = app.querySelector('.app-shell')
  if (shell) applySidebarVisibility(shell, hidden)
}

function applySidebarVisibility(shell, hidden) {
  shell.dataset.sidebarHidden = String(hidden)
  const sidebar = shell.querySelector(':scope > .sidebar')
  const resizer = shell.querySelector(':scope > .app-sidebar-resizer')
  const main = shell.querySelector(':scope > .main')
  const toggle = shell.querySelector('.pane-toggle-button[data-pane="main"]')
  const compact = window.matchMedia('(max-width: 1120px), (hover: none) and (pointer: coarse) and (max-width: 1400px)').matches
  const sidebarUnavailable = compact ? !state.menuOpen : hidden
  sidebar?.toggleAttribute('inert', sidebarUnavailable)
  resizer?.toggleAttribute('inert', hidden)
  main?.toggleAttribute('inert', compact && state.menuOpen)
  if (sidebar) {
    if (sidebarUnavailable) sidebar.setAttribute('aria-hidden', 'true')
    else sidebar.removeAttribute('aria-hidden')
  }
  if (resizer) {
    resizer.tabIndex = hidden ? -1 : 0
    if (hidden) resizer.setAttribute('aria-hidden', 'true')
    else resizer.removeAttribute('aria-hidden')
  }
  if (toggle) {
    const visible = !hidden
    const action = `${visible ? 'Скрыть' : 'Показать'} главную навигацию`
    toggle.setAttribute('aria-pressed', String(visible))
    toggle.setAttribute('aria-label', action)
    toggle.title = action
  }
}

function renderSidebar() {
  const pending = state.stats?.candidates.pending
  const navGroups = [
    ['Рабочая область заметок', [['notes', 'Документ заметки'], ['shares', 'Опубликовано']]],
    ['Рабочая область знаний', [['entries', 'Документ базы знаний'], ['candidates', 'На проверке'], ['writeback', 'Задачи записи'], ['bases', 'Базы знаний и подключения']]],
    ['Рабочие записи', [['worklog', 'Ежедневный отчёт']]],
    ['Подключить', [['tokens', 'Управление доступом']].filter(([id]) => id !== 'tokens' || !state.service.remote)],
  ].filter(([, items]) => items.length)
  let navIndex = 0
  return element('aside', { class: 'sidebar', 'aria-label': 'Навигация по базе знаний' },
    element('div', { class: 'brand' },
      element('span', { class: 'brand-emblem', 'aria-hidden': 'true' }, element('span', {})),
      element('div', { class: 'brand-copy' }, element('span', {}, 'DSH Knowledge'), element('strong', {}, 'база знаний')),
    ),
    element('nav', { class: 'nav' }, navGroups.map(([group, items]) => element('div', { class: 'nav-group' },
      element('div', { class: 'nav-group-label' }, group),
      items.map(([id, label]) => element('button', {
        type: 'button', class: 'nav-button', 'aria-current': state.view === id ? 'page' : undefined,
        onClick: () => navigate(id),
      }, element('span', { class: 'nav-index', 'aria-hidden': 'true' }, String(++navIndex).padStart(2, '0')), element('span', { class: 'nav-label' }, label),
      id === 'candidates' && pending ? element('span', { class: 'nav-count', 'aria-label': `${pending} на проверке` }, pending) : null))))),
    element('div', { class: 'sidebar-footer' },
      element('div', { class: 'connection' }, element('span', { class: 'status-dot', 'aria-hidden': 'true' }), state.service.remote ? 'Центральная база знаний подключена' : 'Локальная база знаний подключена'),
      AUTH_MODE === 'bearer' ? actionButton('Выйти из текущей сессии', signOut, 'ghost small') : null,
    ),
  )
}

function renderCurrentView() {
  if (state.loading) return loadingView(state.view, state.loadingPhase, state.loadingProgress)
  if (state.error) return errorView(state.error, () => navigate(state.view))
  if (state.view === 'worklog') {
    worklogWorkspace = createWorklogWorkspace({ element, actionButton })
    return worklogWorkspace.root
  }
  if (state.view === 'writeback') {
    writebackWorkspace = createWritebackWorkspace({ element, actionButton, openConfirm, sessionId: mountContext.sessionId })
    return writebackWorkspace.root
  }
  if (state.view === 'overview') return renderOverview()
  if (state.view === 'bases') return renderKnowledgeBases()
  if (state.view === 'entries') return renderEntries()
  if (state.view === 'notes') return renderNotes()
  if (state.view === 'shares') return renderShares()
  if (state.view === 'candidates') return renderCandidates()
  return renderTokens()
}

function loadingView(view = state.view, phase = 'Загрузка', progress = 0) {
  const label = phase || loadingPhaseForView(view)
  const header = element('div', { class: 'skeleton-heading' },
    element('div', {}, element('div', { class: 'skeleton-line skeleton-title', 'aria-hidden': 'true' }), element('div', { class: 'skeleton-line skeleton-copy', 'aria-hidden': 'true' })),
    element('span', { class: 'skeleton-phase' }, label),
  )
  const content = view === 'entries'
    ? element('div', { class: 'skeleton-workspace skeleton-workspace-documents', 'aria-hidden': 'true' },
      element('div', { class: 'skeleton-pane skeleton-pane-tree' }, ...Array.from({ length: 7 }, (_, index) => element('div', { class: `skeleton-line skeleton-tree-row is-${index % 3}` }))),
      element('div', { class: 'skeleton-pane skeleton-pane-paper' }, element('div', { class: 'skeleton-line skeleton-paper-title' }), ...Array.from({ length: 8 }, (_, index) => element('div', { class: `skeleton-line skeleton-paper-row is-${index % 4}` }))),
    )
    : view === 'notes'
      ? element('div', { class: 'skeleton-workspace skeleton-workspace-notes', 'aria-hidden': 'true' },
        element('div', { class: 'skeleton-pane skeleton-pane-tree' }, ...Array.from({ length: 8 }, (_, index) => element('div', { class: `skeleton-line skeleton-tree-row is-${index % 3}` }))),
        element('div', { class: 'skeleton-pane skeleton-pane-list' }, ...Array.from({ length: 6 }, () => element('div', { class: 'skeleton-list-row' }, element('span', { class: 'skeleton-block' }), element('span', { class: 'skeleton-line' })))),
      )
      : element('div', { class: 'skeleton-grid', 'aria-hidden': 'true' },
        element('div', { class: 'skeleton-block' }), element('div', { class: 'skeleton-block' }), element('div', { class: 'skeleton-block' }))
  return element('div', {
    class: `loading-skeleton loading-skeleton--${view}`, role: 'status', 'aria-label': label,
    style: `--loading-progress: ${progress}`,
  }, element('span', { class: 'visually-hidden' }, label), header, content)
}

function errorView(message, retry) {
  return element('div', { class: 'error-state', role: 'alert' }, element('p', {}, message), actionButton('Повторить', retry, 'small'))
}

function renderOverview() {
  const stats = state.stats
  const overview = state.overview
  if (!stats || !overview) return loadingView()
  const metrics = [
    ['Действующие знания', stats.entries.active, `${stats.entries.archived} в архиве`],
    ['Кандидаты на проверку', stats.candidates.pending, `${stats.candidates.approved} одобрено`],
    ['Задачи извлечения', stats.extractionJobs.total, `${stats.extractionJobs.failed} с ошибкой`],
    ['Тип знания', Object.values(stats.entries.byType).filter(Boolean).length, 'Всего 5 категорий'],
  ]
  return element('div', {},
    element('section', { class: 'metrics', 'aria-label': 'Метрики базы знаний' }, metrics.map(([label, value, detail]) => element('article', { class: 'metric' },
      element('div', { class: 'metric-label' }, label),
      element('strong', { class: 'metric-value' }, value),
      element('div', { class: 'metric-detail' }, detail),
    ))),
    element('div', { class: 'dashboard-grid' },
      element('section', { class: 'panel', 'aria-labelledby': 'recent-title' },
        element('div', { class: 'panel-header' }, element('h2', { id: 'recent-title' }, 'Последнее обновление'), actionButton('Показать все', () => navigate('entries'), 'ghost small')),
        element('div', { class: 'panel-body' }, overview.recent.length ? element('div', { class: 'list' }, overview.recent.map(renderCompactEntry)) : compactEmpty('Пока нет действующих знаний')),
      ),
      element('section', { class: 'panel', 'aria-labelledby': 'pending-title' },
        element('div', { class: 'panel-header' }, element('h2', { id: 'pending-title' }, 'Ожидает подтверждения'), actionButton('Перейти к проверке', () => navigate('candidates'), 'ghost small')),
        element('div', { class: 'panel-body' }, overview.pending.length ? element('div', { class: 'list' }, overview.pending.map(renderCompactCandidate)) : compactEmpty('Сейчас нет кандидатов на проверку')),
      ),
    ),
  )
}

function renderKnowledgeBases() {
  baseGroups ??= createBaseGroups({ element, actionButton, interfaceIcon, openSheet, formField, api,
    getBases: () => state.knowledgeBases, refresh: () => navigate('bases'), showToast,
    storageKey: `dsh-knowledge.base-groups:${API_BASE}` })
  const activeBases = state.knowledgeBases.filter(base => base.status === 'active')
  const archivedBases = state.knowledgeBases.filter(base => base.status === 'archived')
  if (state.knowledgeBaseView === 'detail') return renderKnowledgeBaseDetail()
  const contextAvailable = Boolean(state.mountContext.projectId || state.mountContext.sessionId)
  const query = state.knowledgeBaseQuery.trim().toLocaleLowerCase()
  const matchesQuery = base => !query || [base.name, base.group, base.description, base.defaultTags.join(' ')]
    .some(value => String(value || '').toLocaleLowerCase().includes(query))
  const visibleActiveBases = activeBases.filter(matchesQuery)
  const visibleArchivedBases = archivedBases.filter(matchesQuery)
  const switcher = element('div', { class: 'workspace-switcher' },
    element('div', { class: 'workspace-switcher-leading' },
      element('div', { class: 'tabs workspace-tabs', role: 'tablist', 'aria-label': 'Область управления базой знаний' }, [
      ['libraries', 'база знаний', activeBases.length],
      ['mounts', 'Подключения проектов и сессий', state.mounts.filter(mount => mount.enabled).length],
    ].map(([id, label, count]) => element('button', {
      type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(state.knowledgeBaseView === id),
      onClick: () => { state.knowledgeBaseView = id; renderShell() },
      }, element('span', {}, label), element('span', { class: 'tab-count' }, count)))),
      actionButton('Локальная модель записи', () => openGlobalWritebackModelEditor(), 'ghost small'),
    ),
    element('p', {}, state.service.writebackProvider && state.service.writebackModel
      ? `Запись только этим клиентом: ${state.service.writebackProvider} / ${state.service.writebackModel}.`
      : 'Текущий клиент пишет по модели каждого раунда сеанса.'),
  )
  return element('div', { class: 'bases-page' },
    switcher,
    state.knowledgeBaseView === 'libraries' ? element('section', { class: 'library-management', 'aria-labelledby': 'bases-heading' },
      element('div', { class: 'section-heading' },
        element('div', {}, element('h2', { id: 'bases-heading' }, 'Мои базы знаний'), element('p', {}, 'Название и описание помогают AI определить, куда записывать знания.')),
        element('div', { class: 'base-heading-actions' },
          actionButton('Создать группу', () => baseGroups.edit(), 'ghost', { disabled: !state.knowledgeBases.length }),
          actionButton('+ Создать базу знаний', () => openKnowledgeBaseEditor(), 'primary')),
      ),
      element('div', { class: 'knowledge-base-toolbar' },
        element('div', { class: 'search-box base-search' }, interfaceIcon('search', 'search-symbol'), element('input', {
          class: 'input', type: 'search', value: state.knowledgeBaseQuery,
          placeholder: 'Поиск по названию, группе, описанию или тегам', 'aria-label': 'Поиск баз знаний',
          onInput: event => {
            state.knowledgeBaseQuery = event.target.value
            renderShell()
            document.querySelector('.base-search input')?.focus()
          },
        })),
        element('div', { class: 'base-result-summary', 'aria-live': 'polite' }, query
          ? `Найдено баз знаний: ${visibleActiveBases.length + visibleArchivedBases.length}`
          : `${activeBases.length} доступно · ${archivedBases.length} в архиве`),
      ),
      visibleActiveBases.length
        ? baseGroups.render(visibleActiveBases, renderKnowledgeBaseCard, Boolean(query))
        : query && visibleArchivedBases.length === 0
          ? emptyState('Нет подходящих баз знаний', 'Попробуйте поискать по названию, описанию или тегам.')
          : !query ? emptyState('Пока нет доступных баз знаний', 'Создайте первую базу знаний кнопкой в правом верхнем углу.') : null,
      visibleArchivedBases.length ? element('details', { class: 'archived-bases', open: Boolean(query) },
        element('summary', {}, element('span', {}, 'Архивные базы знаний'), element('span', { class: 'summary-count' }, visibleArchivedBases.length)),
        baseGroups.render(visibleArchivedBases, renderKnowledgeBaseCard, Boolean(query), 'archived'),
      ) : null,
    ) : element('section', { class: 'mount-section', 'aria-labelledby': 'mounts-heading' },
      element('div', { class: 'section-heading' }, element('div', {},
        element('h2', { id: 'mounts-heading' }, 'Область подключения'),
        element('p', {}, 'Сессия по умолчанию наследует проект; переопределение сессии создавайте только при необходимости отличий.'),
      )),
      contextAvailable
        ? element('div', { class: 'mount-context' },
          state.mountContext.projectId ? contextPill('Проект', state.mountContext.projectId) : contextPill('Проект', 'На текущей странице не предоставлено'),
          state.mountContext.sessionId ? contextPill('Сессия', state.mountContext.sessionId) : contextPill('Сессия', 'На текущей странице не предоставлено'),
        )
        : element('div', { class: 'context-warning' }, 'Откройте раздел «База знаний» слева в текущей сессии DSH, чтобы управлять подключениями текущего проекта и сессии.'),
      contextAvailable && activeBases.length
        ? renderMountManager(activeBases)
        : null,
    ),
  )
}

async function openKnowledgeBaseDocuments(base) {
  captureScrollPosition()
  const request = ++libraryDetailRequest
  const detail = state.libraryDetail
  const changingBase = detail.knowledgeBaseId !== base.id
  detail.knowledgeBaseId = base.id
  if (changingBase) {
    detail.documents = []
    detail.view = createDocumentViewState({ knowledgeBaseId: base.id })
  } else {
    detail.view.knowledgeBaseId = base.id
  }
  state.knowledgeBaseView = 'detail'
  state.loading = true
  detail.error = ''
  renderShell()
  const workspace = libraryDocumentWorkspace()
  try {
    if (!await reloadDocumentWorkspace(workspace) || request !== libraryDetailRequest) return
    selectDefaultDocument(workspace)
    if (workspace.view.documentId) await loadDocumentEditor(workspace, workspace.view.documentId)
    else workspace.view.editor = null
  } catch (error) {
    if (request !== libraryDetailRequest) return
    detail.error = friendlyError(error)
  } finally {
    if (request !== libraryDetailRequest) return
    state.loading = false
    renderShell()
    window.requestAnimationFrame(() => document.querySelector('.library-detail-back')?.focus())
  }
}

async function closeKnowledgeBaseDetail() {
  const workspace = libraryDocumentWorkspace()
  const editor = workspace.view.editor
  const emptyDraft = editor?.isNew && !editor.title.trim() && !editor.body.trim()
  if (editor?.dirty && !emptyDraft && !await saveDocumentEditor(workspace)) return
  libraryDetailRequest += 1
  const baseId = state.libraryDetail.knowledgeBaseId
  state.knowledgeBaseView = 'libraries'
  state.libraryDetail.error = ''
  renderShell()
  window.requestAnimationFrame(() => document.querySelector(`[data-open-knowledge-base="${CSS.escape(baseId)}"]`)?.focus())
}

function renderKnowledgeBaseDetail() {
  const base = state.knowledgeBases.find(item => item.id === state.libraryDetail.knowledgeBaseId)
  if (!base) return emptyState('База знаний недоступна', 'Возможно, он удалён. Вернитесь к списку баз знаний и выберите заново.', 'Вернуться к моим базам знаний', () => { state.knowledgeBaseView = 'libraries'; renderShell() })
  const workspace = libraryDocumentWorkspace()
  const archived = base.status === 'archived'
  const mountStatus = state.mountContext.sessionId
    ? mountView(base, 'session', state.mountContext.sessionId)
    : state.mountContext.projectId ? mountView(base, 'project', state.mountContext.projectId) : null
  return element('section', { class: 'library-detail', 'aria-labelledby': 'library-detail-title' },
    element('header', { class: 'library-detail-header' },
      actionButton('Мои базы знаний', () => { void closeKnowledgeBaseDetail() }, 'ghost small library-detail-back', { 'aria-label': 'Вернуться к моим базам знаний' }),
      element('div', { class: 'library-detail-identity' },
        element('span', { class: 'base-symbol', 'aria-hidden': 'true' }, base.name.trim().slice(0, 1).toLocaleUpperCase() || 'K'),
        element('div', {},
          element('div', { class: 'library-detail-title-line' },
            element('h2', { id: 'library-detail-title' }, base.name),
            badge(archived ? 'В архиве' : 'Доступно', archived ? '' : 'success'),
            mountStatus ? badge(mountStatus.statusLabel, mountStatus.statusVariant) : badge('Область подключения не выбрана'),
          ),
          element('p', {}, base.description || 'Общая база знаний, описание соответствия не задано.'),
        ),
      ),
      element('div', { class: 'library-detail-actions' },
        archived ? actionButton('Восстановить базу знаний', () => confirmRestoreKnowledgeBase(base), 'small') : actionButton('Редактировать базу знаний', () => openKnowledgeBaseEditor(base), 'small'),
        !archived ? actionButton('+ Создать документ', () => { void startBlankDocument(workspace, base.id) }, 'primary small') : null,
      ),
    ),
    archived ? element('div', { class: 'library-detail-notice', role: 'status' }, 'Эта база знаний уже заархивирована. Документы можно читать, но создавать и изменять их можно только после восстановления базы знаний.') : null,
    state.libraryDetail.error
      ? errorView(state.libraryDetail.error, () => { void openKnowledgeBaseDocuments(base) })
      : renderDocumentWorkspace(workspace, { heading: base.name, singleBase: true }),
  )
}

async function openGlobalWritebackModelEditor() {
  await loadModelCatalog()
  const custom = element('input', { type: 'checkbox', checked: Boolean(state.service.writebackProvider && state.service.writebackModel) })
  const route = modelRouteFields(state.service.writebackProvider || '', state.service.writebackModel || '')
  const form = element('form', { class: 'form-grid' },
    element('label', { class: 'check-option span-2' }, custom, element('span', {}, element('strong', {}, 'Текущий клиент использует отдельную модель'), element('small', {}, 'Если выключено, используется модель, фактически применяемая текущим клиентом в каждом раунде сессии.'))),
    route.provider.wrapper, route.model.wrapper,
  )
  const sync = () => { route.provider.input.disabled = route.model.input.disabled = !custom.checked; route.provider.input.required = route.model.input.required = custom.checked }
  custom.addEventListener('change', sync); sync()
  openSheet({ title: 'Локальная модель записи', description: 'Эта настройка хранится только в текущем клиенте DSH, не записывается в центральную базу знаний и не влияет на другие устройства.', body: form, primaryLabel: 'Сохранить', onPrimary: async () => {
    if (!form.reportValidity()) return false
    state.service = await api('service', { method: 'PUT', body: custom.checked
      ? { writebackProvider: route.provider.input.value, writebackModel: route.model.input.value }
      : { writebackProvider: null, writebackModel: null } })
    showToast('Модель записи текущего клиента обновлена.'); renderShell(); return true
  } })
}

function contextPill(label, value) {
  return element('div', { class: 'context-pill' }, element('strong', {}, label), element('span', { title: value }, value))
}

function writebackRouteLabel(base) {
  if (state.service.writebackProvider && state.service.writebackModel) {
    return `Переопределение · ${state.service.writebackProvider} / ${state.service.writebackModel}`
  }
  if (base?.writebackProvider && base?.writebackModel) {
    return `Только для базы · ${base.writebackProvider} / ${base.writebackModel}`
  }
  return 'Следовать модели текущей сессии'
}

function renderKnowledgeBaseCard(base) {
  const archived = base.status === 'archived'
  const visibleTags = base.defaultTags.slice(0, 4)
  const hiddenTagCount = Math.max(0, base.defaultTags.length - visibleTags.length)
  return element('article', {
    class: `base-card${archived ? ' is-archived' : ''}`,
  },
    element('div', { class: 'base-card-header' },
      element('div', { class: 'base-card-identity' },
        element('span', { class: 'base-symbol', 'aria-hidden': 'true' }, base.name.trim().slice(0, 1).toLocaleUpperCase() || 'K'),
        element('div', {}, element('h3', {}, base.name), element('small', { title: base.id }, base.id === 'default' ? 'Системная база по умолчанию' : `ID · ${base.id}`)),
      ),
      badge(archived ? 'В архиве' : 'Доступно', archived ? '' : 'success'),
    ),
    element('p', { class: 'base-description' }, base.description || 'Общая база знаний, описание соответствия не задано.'),
    element('div', { class: 'base-card-tags' }, visibleTags.length
      ? visibleTags.map(tag => element('span', { class: 'tag' }, `#${tag}`))
      : element('span', { class: 'tag is-empty' }, 'Без тегов по умолчанию'),
    hiddenTagCount ? element('span', { class: 'tag' }, `+${hiddenTagCount}`) : null),
    element('div', { class: 'base-card-meta' },
      element('span', {}, element('strong', {}, 'Стратегия записи'), base.writebackPolicy === 'proactive' ? 'Активный' : 'Строгий'),
      element('span', {}, element('strong', {}, 'Модель записи'), writebackRouteLabel(base)),
      base.extractionInstructions ? element('span', {}, element('strong', {}, 'Правила извлечения'), 'Задано') : null,
    ),
    element('div', { class: 'base-card-actions' },
      actionButton('Просмотреть знания', () => { void openKnowledgeBaseDocuments(base) }, 'ghost small', { 'data-open-knowledge-base': base.id }),
      archived ? actionButton('Восстановить', () => confirmRestoreKnowledgeBase(base), 'small') : actionButton('Редактировать', () => openKnowledgeBaseEditor(base), 'small'),
      archived ? actionButton('Удалить навсегда', () => confirmDeleteKnowledgeBase(base), 'danger small') : null,
      !archived && base.id !== 'default' ? actionButton('В архив', () => confirmArchiveKnowledgeBase(base), 'danger small') : null,
    ),
  )
}

function findExplicitMount(baseId, targetKind, targetId) {
  return state.mounts.find(mount => mount.knowledgeBaseId === baseId && mount.targetKind === targetKind && mount.targetId === targetId)
}

function mountView(base, targetKind, targetId) {
  const explicit = findExplicitMount(base.id, targetKind, targetId)
  const inherited = targetKind === 'session' && !explicit && state.mountContext.projectId
    ? findExplicitMount(base.id, 'project', state.mountContext.projectId)
    : undefined
  const source = explicit || (inherited?.enabled ? inherited : undefined)
  let statusKey
  let statusLabel
  let statusVariant = ''
  let detail
  if (explicit && !explicit.enabled) {
    statusKey = 'disabled'
    statusLabel = 'Закрыто'
    statusVariant = 'danger'
    detail = 'Явно отключено, настройки проекта не наследуются'
  } else if (source) {
    statusKey = explicit ? 'mounted' : 'inherited'
    statusLabel = explicit ? 'Подключено' : 'Наследовать от проекта'
    statusVariant = explicit ? 'success' : 'accent'
    detail = `${source.recallEnabled ? 'извлечение вкл' : 'извлечение выкл'} · ${WRITE_MODE_LABELS[source.writeMode]}`
  } else {
    statusKey = 'unmounted'
    statusLabel = 'Не подключено'
    detail = 'Без извлечения, без отбора, без записи'
  }
  return { explicit, inherited, source, statusKey, statusLabel, statusVariant, detail }
}

function renderMountManager(activeBases) {
  const manager = state.mountManager
  const availableKinds = [
    state.mountContext.projectId ? ['project', 'Проект'] : null,
    state.mountContext.sessionId ? ['session', 'Сессия'] : null,
  ].filter(Boolean)
  if (!availableKinds.some(([kind]) => kind === manager.targetKind)) manager.targetKind = availableKinds[0][0]
  const targetId = manager.targetKind === 'project' ? state.mountContext.projectId : state.mountContext.sessionId
  const query = manager.query.trim().toLowerCase()
  const rows = sortKnowledgeBasesByGroup(activeBases).map(base => ({ base, view: mountView(base, manager.targetKind, targetId) }))
  const visibleRows = rows.filter(({ base, view }) => {
    const searchable = `${knowledgeBasePathLabel(base)} ${base.description} ${base.defaultTags.join(' ')}`.toLowerCase()
    return (!query || searchable.includes(query)) && (manager.filter === 'all' || manager.filter === view.statusKey)
  })
  const visibleIds = visibleRows.map(({ base }) => base.id)
  const selectedCount = manager.selectedIds.size
  const searchInput = element('input', {
    class: 'input', type: 'search', value: manager.query,
    placeholder: 'Поиск по категории, названию, описанию или тегам', 'aria-label': 'Поиск баз знаний для подключения',
    onInput: (event) => { manager.query = event.target.value; renderShell(); document.querySelector('.mount-search input')?.focus() },
  })
  const filter = selectControl('Фильтр по состоянию подключения', [
    { value: 'all', label: 'Все статусы' },
    { value: 'mounted', label: 'Подключено' },
    { value: 'unmounted', label: 'Не подключено' },
    ...(manager.targetKind === 'session' ? [{ value: 'inherited', label: 'Наследовать от проекта' }] : []),
    { value: 'disabled', label: 'Закрыто' },
  ], manager.filter, (value) => { manager.filter = value; renderShell() })
  return element('div', { class: 'mount-manager' },
    element('div', { class: 'mount-manager-toolbar' },
      element('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Цель подключения' }, availableKinds.map(([kind, label]) => element('button', {
        type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(manager.targetKind === kind),
        onClick: () => {
          manager.targetKind = kind
          manager.filter = 'all'
          manager.selectedIds.clear()
          renderShell()
        },
      }, label))),
      element('div', { class: 'search-box mount-search' }, interfaceIcon('search', 'search-symbol'), searchInput),
      filter,
    ),
    element('div', { class: 'mount-target-line' },
      element('span', {}, manager.targetKind === 'project' ? 'Текущий проект' : 'Текущий сеанс'),
      element('code', { title: targetId }, targetId),
      element('span', { class: 'field-hint' }, `Показано ${visibleRows.length} / ${activeBases.length}`),
    ),
    visibleRows.length
      ? element('div', { class: 'mount-table', role: 'list', 'aria-label': 'Список подключений базы знаний', 'data-scroll-key': 'mount-table' }, visibleRows.map(({ base, view }) => renderMountListRow(base, view, manager.targetKind, targetId)))
      : emptyState('Нет подходящих баз знаний', 'Измените поисковый запрос или фильтры.'),
    element('div', { class: 'mount-bulk-bar', 'aria-live': 'polite' },
      element('strong', {}, `Выбрано ${selectedCount}`),
      element('div', { class: 'mount-bulk-actions' },
        actionButton('Выбрать текущий результат', () => { visibleIds.forEach(id => manager.selectedIds.add(id)); renderShell() }, 'ghost small', { disabled: visibleIds.length === 0 }),
        actionButton('Сбросить выбор', () => { manager.selectedIds.clear(); renderShell() }, 'ghost small', { disabled: selectedCount === 0 }),
        actionButton(manager.targetKind === 'session' ? 'Восстановить наследование' : 'Отключить', () => void bulkRemoveMounts(), 'danger small', { disabled: selectedCount === 0 }),
        actionButton('Пакетное подключение', () => openBulkMountEditor(), 'primary small', { disabled: selectedCount === 0 }),
      ),
    ),
  )
}

function renderMountListRow(base, view, targetKind, targetId) {
  const selected = state.mountManager.selectedIds.has(base.id)
  const checkbox = element('input', {
    type: 'checkbox', checked: selected, 'aria-label': `Выбрать ${knowledgeBasePathLabel(base)}`,
    onChange: (event) => {
      if (event.target.checked) state.mountManager.selectedIds.add(base.id)
      else state.mountManager.selectedIds.delete(base.id)
      renderShell()
    },
  })
  const modelLabel = writebackRouteLabel(base)
  return element('article', {
    class: `mount-list-row${selected ? ' is-selected' : ''}`,
    role: 'listitem',
  },
    element('label', { class: 'mount-select' }, checkbox, element('span', { class: 'visually-hidden' }, `Выбрать ${knowledgeBasePathLabel(base)}`)),
    element('div', { class: 'mount-list-main' },
      element('div', { class: 'mount-list-title' }, element('strong', { class: 'mount-base-path', title: knowledgeBasePathLabel(base) }, knowledgeBasePathLabel(base)), badge(view.statusLabel, view.statusVariant), badge(modelLabel)),
      element('p', {}, base.description || 'Общая база знаний'),
      element('div', { class: 'mount-list-meta' }, view.detail,
        view.source?.includeTags.length ? element('span', {}, ` · включает #${view.source.includeTags.join(' #')}`) : null,
        view.source?.excludeTags.length ? element('span', {}, ` · исключает #${view.source.excludeTags.join(' #')}`) : null,
      ),
    ),
    actionButton(view.explicit ? 'Настройки' : view.inherited?.enabled ? 'Перезаписать' : 'Подключение', () => openMountEditor(base, targetKind, targetId, view.explicit, view.inherited), 'small'),
  )
}

function renderCompactEntry(entry) {
  return element('article', { class: 'list-row' },
    element('div', { class: 'list-main' },
      element('div', { class: 'list-title' }, element('strong', {}, entry.title), badge(TYPE_LABELS[entry.type])),
      element('p', { class: 'list-summary' }, entry.body),
      element('div', { class: 'list-meta' }, knowledgeBaseName(entry.knowledgeBaseId), scopeLabel(entry.scope), formatDate(entry.updatedAt)),
    ),
    actionButton('Редактировать', () => openEntryEditor(entry), 'ghost small'),
  )
}

function renderCompactCandidate(candidate) {
  return element('article', { class: 'list-row' },
    element('div', { class: 'list-main' },
      element('div', { class: 'list-title' }, element('strong', {}, candidate.draft.title), badge(ACTION_LABELS[candidate.action], candidate.action === 'conflict' ? 'warning' : 'accent')),
      element('p', { class: 'list-summary' }, candidate.reason || candidate.draft.body),
      element('div', { class: 'list-meta' }, knowledgeBaseName(candidate.draft.knowledgeBaseId), TYPE_LABELS[candidate.draft.type], formatDate(candidate.createdAt)),
    ),
    actionButton('Проверка', () => navigate('candidates'), 'ghost small'),
  )
}

function compactEmpty(message) {
  return element('div', { class: 'loading' }, message)
}

function renderEntries() {
  return renderDocumentWorkspace(sessionDocumentWorkspace(), { heading: 'Каталог знаний' })
}

async function applyDocumentGroup(workspace, baseId, ids, group) {
  if (workspace.view.editor?.dirty && !await saveDocumentEditor(workspace)) throw new Error('Сначала сохраните текущий документ, затем меняйте группу.')
  await api('document-groups', { method: 'POST', body: { knowledgeBaseId: baseId, ids, group } })
  await reloadDocumentWorkspace(workspace)
  if (workspace.view.documentId) await loadDocumentEditor(workspace, workspace.view.documentId)
  workspace.view.collapsedGroups.delete(JSON.stringify([baseId, group]))
  renderShell()
  showToast('Группа документа обновлена.')
}

async function dropDocumentIntoGroup(event, workspace, baseId, group) {
  event.preventDefault()
  const drag = knowledgeDocumentDrag
  clearKnowledgeDocumentDragState()
  if (!drag || drag.sourceBaseId !== baseId) return showToast('Перетаскивание внутри группы работает только в одной базе знаний; между базами перетаскивайте на имя базы знаний.', 'error')
  try { await applyDocumentGroup(workspace, baseId, [drag.documentId], group) }
  catch (error) { showToast(friendlyError(error), 'error') }
}

function openDocumentGroupEditor(workspace, editor) {
  const field = createDocumentGroupField({ element, api, baseId: editor.knowledgeBaseId, value: editor.group || '', required: editor.isNew })
  openSheet({ title: 'Группа документа', description: 'Смена группы не перемещает файлы и не меняет ссылки в документах.', body: field.wrapper, primaryLabel: 'Сохранить группу', onPrimary: async () => {
    await field.ready
    field.validate()
    if (editor.isNew) {
      if (!field.value() || field.value() === 'без группы') throw new Error('Для нового документа нужно выбрать допустимую группу.')
      editor.group = field.value(); editor.dirty = true; renderShell()
    } else await applyDocumentGroup(workspace, editor.knowledgeBaseId, [editor.id], field.value())
    return true
  } })
}

function renderDocumentWorkspace(workspace, options = {}) {
  const view = workspace.view
  const query = view.query.trim().toLocaleLowerCase()
  const activeBases = documentWorkspaceBases(workspace)
  const workspaceDocuments = documentWorkspaceDocuments(workspace)
  const readOnly = documentWorkspaceReadOnly(workspace)
  const canOrganize = !readOnly
  const selectedBase = activeBases.find(base => base.id === view.knowledgeBaseId)
  const search = element('input', {
    class: 'note-tree-search', type: 'search', value: view.query, placeholder: 'Поиск документов', 'aria-label': 'Поиск документов базы знаний',
    'data-document-scope': workspace.kind,
    onInput: (event) => {
      view.query = event.target.value
      scheduleDocumentSearch(workspace)
      window.requestAnimationFrame(() => {
        const input = document.querySelector(`.note-tree-search[data-document-scope="${workspace.kind}"]`)
        input?.focus()
        input?.setSelectionRange(input.value.length, input.value.length)
      })
    },
  })
  const visibleBases = query
    ? activeBases.filter(base => view.searchResults.some(document => document.knowledgeBaseId === base.id))
    : activeBases
  const tree = visibleBases.map(base => {
    const expanded = view.expandedBases.has(base.id) || Boolean(query)
    const page = documentPageState(workspace, base.id)
    const documents = (query ? view.searchResults : workspaceDocuments).filter(document => document.knowledgeBaseId === base.id)
    return element('section', {
      class: 'note-tree-group', 'data-expanded': String(expanded),
      'data-base-id': base.id, 'data-drop-target': 'false',
      onDragEnter: event => activateKnowledgeBaseDropTarget(event, workspace, base.id),
      onDragOver: event => activateKnowledgeBaseDropTarget(event, workspace, base.id),
      onDragLeave: event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.dataset.dropTarget = 'false' },
      onDrop: event => dropKnowledgeDocument(event, workspace, base.id),
    },
      element('button', {
        type: 'button', class: 'note-tree-base', 'aria-expanded': String(expanded),
        onClick: () => {
          if (query) { view.knowledgeBaseId = base.id; return renderShell() }
          void toggleDocumentBase(workspace, base.id)
        },
      },
      element('span', { class: 'tree-disclosure', 'aria-hidden': 'true' }),
      element('span', { class: 'tree-folder-icon', 'aria-hidden': 'true' }),
      element('span', { class: 'tree-base-name' }, base.name),
      element('span', { class: 'tree-count' }, query ? documents.length : page.loaded ? page.total : '—')),
      expanded ? element('div', { class: 'note-tree-documents', role: 'group', 'aria-label': `Документы: ${base.name}` },
        !query && page.loading && documents.length === 0 ? element('div', { class: 'note-tree-status', role: 'status' }, 'Чтение каталога…') : null,
        !query && page.error ? element('div', { class: 'note-tree-status is-error' },
          element('span', {}, page.error),
          actionButton('Повторить', () => { void loadDocumentPage(workspace, base.id, { reset: true }).then(renderShell) }, 'ghost small')) : null,
        renderDocumentGroups({ element, documents, baseId: base.id, collapsed: view.collapsedGroups, searching: Boolean(query), onNew: readOnly ? undefined : group => { void startBlankDocument(workspace, base.id, group) }, onDrop: readOnly ? undefined : (event, group) => { void dropDocumentIntoGroup(event, workspace, base.id, group) }, renderRow: document => element('button', {
          type: 'button', class: 'note-tree-document', 'aria-current': document.id === view.documentId ? 'page' : undefined,
          draggable: canOrganize && movingDocumentId !== document.id ? 'true' : undefined,
          'aria-busy': movingDocumentId === document.id ? 'true' : undefined,
          title: canOrganize ? `${document.title} · можно перетащить в группу или другую базу` : document.title,
          'data-document-id': document.id,
          onDragStart: event => {
            knowledgeDocumentDrag = { documentId: document.id, sourceBaseId: base.id, workspaceKind: workspace.kind }
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData(KNOWLEDGE_DOCUMENT_DRAG_TYPE, document.id)
            event.currentTarget.dataset.dragging = 'true'
          },
          onDragEnd: clearKnowledgeDocumentDragState,
          onClick: () => { view.knowledgeBaseId = base.id; void selectDocument(workspace, document.id) },
        }, element('span', { class: 'tree-document-icon', 'aria-hidden': 'true' }), element('span', { class: 'tree-document-copy' },
          element('strong', { title: document.title }, document.title), element('small', { title: document.relPath }, document.relPath)),
        document.documentState !== 'open' ? badge(DOCUMENT_STATE_LABELS[document.documentState] || 'Завершено', 'success') : null) }),
        !query && page.nextCursor ? element('button', {
          type: 'button', class: 'note-tree-more', disabled: page.loading,
          onClick: () => { void loadDocumentPage(workspace, base.id, { append: true }).then(renderShell) },
        }, page.loading ? 'Загрузка…' : `Загрузить ещё (показано ${documents.length} / ${page.total})`) : null,
        !query && page.loaded && documents.length === 0 ? element('div', { class: 'note-tree-status' }, 'В этой базе знаний пока нет документов.') : null,
        !query && !readOnly ? element('button', { type: 'button', class: 'note-tree-new', onClick: () => { void startBlankDocument(workspace, base.id) } },
          element('span', { 'aria-hidden': 'true' }, '+'), 'Создать документ') : null,
      ) : null,
    )
  })
  const treeContent = query
    ? [
      view.searchLoading && view.searchResults.length === 0 ? element('div', { class: 'note-tree-status', role: 'status' }, 'Поиск документов…') : null,
      view.searchError ? element('div', { class: 'note-tree-status is-error' }, view.searchError) : null,
      ...tree,
      !view.searchLoading && !view.searchError && view.searchResults.length === 0 ? element('div', { class: 'note-tree-empty' }, 'Нет подходящих документов') : null,
      view.searchNextCursor ? element('button', {
        type: 'button', class: 'note-tree-more search-more', disabled: view.searchLoading,
        onClick: () => { void loadDocumentSearch(workspace, false) },
      }, view.searchLoading ? 'Загрузка…' : `Загрузить ещё результаты (${view.searchResults.length} / ${view.searchTotal})`) : null,
    ]
    : tree.length ? tree : [element('div', { class: 'note-tree-empty' }, workspace.kind === 'session' && state.mountContext.sessionId ? 'В текущем сеансе база знаний не подключена' : 'Пока нет баз знаний')]
  return element('section', {
    class: `note-workspace note-workspace--${workspace.kind}`, 'aria-labelledby': `${workspace.kind}-documents-heading`,
    'data-tree-open': String(view.treeOpen),
  },
    element('aside', { class: 'note-tree-panel', 'aria-label': 'Каталог знаний' },
      element('header', { class: 'note-tree-header' },
        element('div', {}, element('h2', { id: `${workspace.kind}-documents-heading` }, options.heading || 'Каталог знаний'), element('span', {}, query ? `${view.searchTotal} результатов поиска` : `Загружено ${workspaceDocuments.length} документов`)),
        !readOnly ? actionButton('+', () => { void startBlankDocument(workspace, view.knowledgeBaseId || activeBases[0]?.id) }, 'ghost note-add-button', { 'aria-label': 'Создать документ', title: 'Создать документ' }) : null,
      ),
      element('div', {}, element('div', { class: 'note-tree-search-wrap' }, interfaceIcon('search', 'search-symbol'), search),
        !readOnly && view.knowledgeBaseId ? actionButton('Упорядочить группы', () => { const baseId = view.knowledgeBaseId; void openDocumentGroupOrganizer({ element, api, openSheet, baseId, onApply: (ids, group) => applyDocumentGroup(workspace, baseId, ids, group) }) }, 'ghost small document-groups-manage') : null),
      element('nav', { class: 'note-tree', 'data-scroll-key': `${workspace.kind}-note-tree` }, treeContent),
      workspace.kind === 'session' ? element('footer', { class: 'note-tree-footer' }, actionButton('Создать базу знаний', () => openKnowledgeBaseEditor(), 'ghost small')) : null,
    ),
    view.treeOpen ? element('button', {
      type: 'button', class: 'note-tree-scrim', 'aria-label': 'Закрыть каталог знаний',
      onClick: () => { view.treeOpen = false; renderShell() },
    }) : null,
    renderNoteEditor(workspace, view.editor, selectedBase),
  )
}

function renderNoteEditor(workspace, editor, base) {
  const view = workspace.view
  const readOnly = documentWorkspaceReadOnly(workspace)
  if (view.editorLoading) return renderDocumentEditorLoading(base)
  if (!editor) return element('main', { class: 'note-editor note-editor-empty' },
    element('div', { class: 'note-empty-content' },
      element('span', { class: 'empty-document-mark', 'aria-hidden': 'true' }),
      element('h3', {}, 'Выберите или создайте документ'),
      element('p', {}, readOnly ? 'Эта база знаний заархивирована, сейчас можно только читать существующие документы.' : 'После сохранения документ сразу участвует в поиске и извлечении текущей базы знаний.'),
      !readOnly ? actionButton('Создать документ', () => { void startBlankDocument(workspace, view.knowledgeBaseId || state.knowledgeBases.find(item => item.status === 'active')?.id) }, 'primary') : null,
    ))
  const saveShortcut = event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 's') {
      event.preventDefault()
      void saveDocumentEditor(workspace).then(saved => { if (saved) renderShell() })
    }
  }
  const update = (key, value) => {
    editor[key] = value
    editor.dirty = true
    editor.saveState = editor.saving ? 'Сохранение…' : 'Не сохранено'
    updateEditorSaveState(editor.saveState)
  }
  const title = element('input', {
    class: 'note-title-input', value: editor.title, maxlength: 200, placeholder: 'Документ без названия', 'aria-label': 'Заголовок документа',
    onInput: event => update('title', event.target.value), onKeyDown: saveShortcut,
  })
  const finalized = !editor.isNew && editor.documentState !== 'open'
  const editable = !finalized && !readOnly
  const body = editable
    ? element('div', { class: 'notes-live-editor knowledge-live-editor', role: 'status', 'aria-label': 'Открытие текста документа знаний' },
      element('div', { class: 'notes-editor-loading' }, 'Открытие документа…'))
    : renderMarkdownPreview(editor.body)
  if (editable) mountMarkdownEditor(body, {
    markdown: editor.body,
    label: 'Редактировать текст документа базы знаний',
    onChange: value => update('body', value),
    onSave: () => { void saveDocumentEditor(workspace).then(saved => { if (saved) renderShell() }) },
  })
  return element('main', { class: 'note-editor', 'aria-label': 'Редактор документов' },
    element('header', { class: 'note-editor-toolbar' },
      element('div', { class: 'note-breadcrumb' },
        element('span', {}, base?.name || 'база знаний'),
        element('span', { 'aria-hidden': 'true' }, '/'),
        element('strong', {}, editor.isNew ? 'Новый документ' : documentWorkspaceDocuments(workspace).find(item => item.id === editor.id)?.relPath || editor.title),
        element('span', { class: 'note-toolbar-meta' },
          element('span', {}, editor.isNew ? 'Ещё не сохранено' : `Обновлено ${formatDate(editor.updatedAt)}`),
          element('span', {}, editor.scope.kind === 'global' ? 'Глобальные знания' : `Проект ${editor.scope.id}`))),
      element('div', { class: 'note-editor-actions' },
        finalized ? badge(DOCUMENT_STATE_LABELS[editor.documentState] || 'Завершено', 'success') : readOnly ? badge('Только чтение') : null,
        element('span', { class: 'editor-save-status', role: 'status' }, editor.saveState),
        finalized && !readOnly ? actionButton('Открыть заново', () => reopenDocument(workspace, editor), 'small') : null,
        !readOnly && !finalized ? actionButton(editor.isNew ? 'Создать документ' : 'Сохранить', () => { void saveDocumentEditor(workspace).then(saved => { if (saved) renderShell() }) }, 'primary small') : null,
        !readOnly && !editor.isNew ? renderDocumentMenu(editor.title || 'Документ базы знаний', [
          [
            ...(documentWorkspaceBases(workspace).some(item => item.id !== editor.knowledgeBaseId)
              ? [{ label: 'Переместить в…', icon: 'move', run: () => openMoveKnowledgeDocument(workspace, editor) }] : []),
            ...(!finalized ? [{ label: 'Отметить как закрытое', icon: 'check', run: () => openFinalizeDocument(workspace, editor) }] : []),
          ],
          !finalized ? [{ label: 'Удалить документ', icon: 'trash', danger: true, run: () => confirmDeleteDocument(workspace, editor) }] : [],
        ]) : null,
      ),
    ),
    element('div', { class: 'note-editor-scroll', 'data-scroll-key': 'note-editor' },
      finalized ? element('aside', { class: 'document-finalized-banner', role: 'status' },
        element('strong', {}, DOCUMENT_STATE_LABELS[editor.documentState] || 'Документ закрыт'),
        element('span', {}, editor.documentState === 'resolved'
          ? 'Этот вопрос решён, документ запечатан и запись в него остановлена.'
          : 'Сбор материалов завершён, документ запечатан и запись в него остановлена.'),
        editor.finalizationNote ? element('p', {}, editor.finalizationNote) : null,
        editor.finalizedAt ? element('small', {}, `Завершено ${formatDate(editor.finalizedAt)}`) : null,
      ) : null,
      element('article', { class: `note-paper is-${editable ? 'edit' : 'preview'}`, 'data-document-mode': editable ? 'edit' : 'preview' },
        editable ? title : element('h1', { class: 'note-preview-title' }, editor.title || 'Документ без названия'),
        body,
      ),
    ),
    renderDocumentReferenceBar(workspace, editor, editable),
    element('footer', { class: 'note-inspector' },
      readOnly ? element('span', { class: 'note-format-hint' }, `Группа: ${editor.group || 'без группы'}`) : actionButton(`Группа: ${editor.group || 'без группы'}`, () => openDocumentGroupEditor(workspace, editor), 'ghost small document-group-control', { title: editor.group || 'без группы', 'aria-label': 'Изменить группу документа' }),
      finalized || readOnly ? element('span', { class: 'note-format-hint' }, readOnly ? 'База знаний в архиве · только чтение' : 'Только чтение · для редактирования снова откройте') : element('label', {}, element('span', {}, 'Тип'), element('select', {
        class: 'note-meta-select', onChange: event => update('type', event.target.value),
      }, TYPES.map(type => element('option', { value: type, selected: type === editor.type }, TYPE_LABELS[type])))),
      finalized || readOnly ? null : element('label', { class: 'note-tags-field' }, element('span', {}, 'Теги'), element('input', {
        value: editor.tagsText, placeholder: 'Через запятую', onInput: event => update('tagsText', event.target.value),
      })),
      editable ? element('span', { class: 'note-format-hint' }, 'Markdown · Ctrl/⌘ S — сохранить') : null,
    ),
  )
}

function renderDocumentEditorLoading(base) {
  return element('main', { class: 'note-editor note-editor-loading', role: 'status', 'aria-label': 'Открытие документа знаний' },
    element('header', { class: 'note-editor-toolbar' },
      element('div', { class: 'note-breadcrumb' }, element('span', {}, base?.name || 'база знаний'), element('span', { 'aria-hidden': 'true' }, '/'), element('strong', {}, 'Открытие документа')),
      element('span', { class: 'editor-load-label' }, 'Загружать текст и связанные заметки по требованию'),
    ),
    element('div', { class: 'note-editor-scroll' }, element('article', { class: 'note-paper editor-paper-skeleton', 'aria-hidden': 'true' },
      element('div', { class: 'skeleton-line skeleton-paper-title' }),
      ...Array.from({ length: 9 }, (_, index) => element('div', { class: `skeleton-line skeleton-paper-row is-${index % 4}` })),
    )),
  )
}

function renderDocumentReferenceBar(workspace, editor, editable) {
  const references = editor.noteReferences || []
  return element('section', { class: 'document-reference-bar', 'aria-label': 'Связать заметку' },
    element('div', { class: 'document-reference-heading' },
      element('span', { class: 'document-reference-mark', 'aria-hidden': 'true' }),
      element('strong', {}, 'Связать заметку'),
      element('small', {}, references.length ? `${references.length} шт.` : 'Не связано')),
    element('div', { class: 'document-reference-list' }, references.length
      ? references.map(reference => element('span', { class: 'document-reference-chip' },
        element('button', {
          type: 'button', class: 'document-reference-open', title: `Открыть ${reference.note.name}`,
          onClick: () => { void openNoteReference(reference.note.id) },
        }, renderNoteIcon(reference.note), element('span', {}, reference.note.name)),
        editable ? element('button', {
          type: 'button', class: 'document-reference-remove', 'aria-label': `Убрать связь с ${reference.note.name}`, title: 'Убрать связь',
          onClick: () => { void removeDocumentNoteReference(workspace, editor, reference) },
        }, '×') : null,
      ))
      : element('span', { class: 'document-reference-empty' }, editor.isNew ? 'После сохранения документа можно привязать заметки или файлы материалов' : 'У этого знания пока нет связанных заметок')),
    editable && !editor.isNew ? actionButton('+ Добавить', () => { void openDocumentNoteReferencePicker(workspace, editor) }, 'ghost small document-reference-add') : null,
  )
}

async function openDocumentNoteReferencePicker(workspace, editor) {
  const search = element('input', {
    class: 'input', type: 'search', placeholder: 'Поиск заметок, документов или файлов', 'aria-label': 'Поиск заметок для связи',
  })
  const results = element('div', { class: 'note-picker-results', 'aria-live': 'polite' })
  let modal
  let request = 0
  const paint = async () => {
    const current = ++request
    const query = search.value.trim()
    if (!query) {
      results.replaceChildren(element('div', { class: 'note-picker-empty' }, 'Введите название, чтобы найти документы заметок и файлы для связи.'))
      return
    }
    results.replaceChildren(element('div', { class: 'note-picker-empty' }, 'Поиск…'))
    try {
      const linked = new Set((editor.noteReferences || []).map(reference => reference.note.id))
      const visible = (await api(`notes?q=${encodeURIComponent(query)}&limit=100`)).filter(node => node.kind !== 'folder' && !linked.has(node.id))
      if (current !== request) return
      results.replaceChildren(...(visible.length
        ? visible.map(node => element('button', {
          type: 'button', class: 'note-picker-row',
          onClick: async event => {
            event.currentTarget.disabled = true
            try {
              const reference = await api(`entries/${encodeURIComponent(editor.id)}/note-references`, { method: 'POST', body: { noteId: node.id } })
              editor.noteReferences = [...(editor.noteReferences || []), reference]
              modal.close(true)
              renderShell()
              showToast('Заметка связана.')
            } catch (error) {
              event.currentTarget.disabled = false
              showToast(friendlyError(error), 'error')
            }
          },
        },
        renderNoteIcon(node),
        element('span', {}, element('strong', {}, node.name), element('small', {}, `${node.kind === 'document' ? 'документ заметки' : formatBytes(node.size)}  ${shortNoteId(node.id)}`))))
        : [element('div', { class: 'note-picker-empty' }, 'Нет подходящих документов-заметок или файлов.')]))
    } catch (error) {
      if (current !== request) return
      results.replaceChildren(element('div', { class: 'note-picker-empty is-error' }, friendlyError(error)))
    }
  }
  let timer = 0
  search.addEventListener('input', () => { window.clearTimeout(timer); timer = window.setTimeout(() => void paint(), 180) })
  modal = openSheet({
    title: 'Добавить связанную заметку',
    description: 'Связи хранятся вне текста документа и сохраняются при перемещении или переименовании заметки.',
    body: element('div', { class: 'note-picker' }, search, results),
    cancelLabel: 'Отмена',
  })
  search.focus()
}

async function removeDocumentNoteReference(workspace, editor, reference) {
  try {
    await api(`entries/${encodeURIComponent(editor.id)}/note-references/${encodeURIComponent(reference.note.id)}`, { method: 'DELETE' })
    editor.noteReferences = (editor.noteReferences || []).filter(item => item.note.id !== reference.note.id)
    if (workspace.view.editor === editor) renderShell()
    showToast('Связь удалена.')
  } catch (error) { showToast(friendlyError(error), 'error') }
}

function renderMarkdownPreview(markdown) {
  if (!markdown.trim()) return element('div', { class: 'markdown-preview is-empty', role: 'document' }, 'Текста пока нет')
  const preview = element('div', { class: 'markdown-preview', role: 'document' })
  preview.innerHTML = window.DshKnowledgeMarkdown.renderMarkdown(markdown)
  preview.querySelectorAll('table').forEach(table => {
    const scroller = element('div', {
      class: 'markdown-table-scroll', role: 'region', tabindex: '0',
      'aria-label': 'Содержимое таблицы, прокручивается по горизонтали',
    })
    table.replaceWith(scroller)
    scroller.append(table)
  })
  preview.querySelectorAll('[data-note-id]').forEach(link => {
    link.setAttribute('role', 'button')
    link.setAttribute('tabindex', '0')
    link.setAttribute('title', 'Открыть заметку-документ')
    const open = event => {
      if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      void openNoteReference(link.dataset.noteId)
    }
    link.addEventListener('click', open)
    link.addEventListener('keydown', open)
  })
  return preview
}

async function openNoteReference(id) {
  try {
    if (!await saveBeforeLeavingDocument()) return
    const node = await api(`notes/${encodeURIComponent(id)}`)
    state.view = 'notes'
    state.loading = false
    await selectNoteNode(node)
    renderShell()
  } catch (error) { showToast(friendlyError(error), 'error') }
}

function openFinalizeDocument(workspace, editor) {
  const form = element('form', { class: 'form-grid' })
  const stateField = selectField('Состояние завершения', [
    { value: 'resolved', label: 'Решено — по вопросу есть окончательный вывод' },
    { value: 'complete', label: 'Сбор завершён — материалы больше не дополняются' },
  ], 'resolved')
  const note = formField('Пояснение к завершению (необязательно)', 'textarea', '', {
    maxlength: 1000,
    placeholder: 'Например: проверено в продакшене, вопрос закрыт.',
  })
  stateField.wrapper.classList.add('span-2')
  note.wrapper.classList.add('span-2')
  form.append(stateField.wrapper, note.wrapper)
  return openSheet({
    title: `Завершить «${editor.title}»`,
    description: 'После завершения документ всё ещё доступен для поиска и извлечения, но запись от ИИ, проверка кандидатов и ручное редактирование будут отклоняться сервером; для изменения нужно сначала открыть документ заново.',
    body: form,
    primaryLabel: 'Подтвердить завершение и запечатывание',
    onPrimary: async () => {
      const saved = await api(`documents/${encodeURIComponent(editor.id)}/finalize`, {
        method: 'POST',
        body: { state: stateField.input.value, note: note.input.value.trim() },
      })
      workspace.view.editor = { ...saved, tagsText: saved.tags.join(', '), dirty: false, isNew: false, saveState: 'Запечатано' }
      workspace.view.mode = 'preview'
      await reloadDocumentWorkspace(workspace)
      renderShell()
      showToast(stateField.input.value === 'resolved' ? 'Документ отмечен как решённый и закрыт.' : 'Документ отмечен как полностью собранный и закрыт.')
      return true
    },
  })
}

function reopenDocument(workspace, editor) {
  openConfirm({
    title: `Открыть заново «${editor.title}»?`,
    message: 'После повторного открытия ручное редактирование, запись от ИИ и проверка кандидатов возобновятся.',
    confirmLabel: 'Подтвердить повторное открытие',
    onConfirm: async () => {
      const saved = await api(`documents/${encodeURIComponent(editor.id)}/reopen`, { method: 'POST' })
      workspace.view.editor = { ...saved, tagsText: saved.tags.join(', '), dirty: false, isNew: false, saveState: 'Открыто заново' }
      await reloadDocumentWorkspace(workspace)
      renderShell()
      showToast('Документ снова открыт.')
    },
  })
}

function confirmDeleteDocument(workspace, editor) {
  openConfirm({
    title: `Удалить «${editor.title}»?`,
    message: 'Документ и связанные с ним извлечённые знания будут удалены навсегда, это действие нельзя отменить.',
    confirmLabel: 'Удалить навсегда', danger: true,
    onConfirm: async () => {
      await api(`entries/${encodeURIComponent(editor.id)}`, { method: 'DELETE' })
      workspace.view.documentId = ''
      workspace.view.editor = null
      state.stats = null
      await reloadDocumentWorkspace(workspace)
      selectDefaultDocument(workspace)
      if (workspace.view.documentId) await loadDocumentEditor(workspace, workspace.view.documentId)
      renderShell()
      showToast('Документ удалён.')
    },
  })
}

function renderNotes() {
  const fileInput = element('input', {
    class: 'visually-hidden', type: 'file', multiple: true, tabindex: '-1',
    onChange: event => { void uploadNoteFiles([...event.target.files], state.notes.currentFolderId); event.target.value = '' },
  })
  const rootNodes = state.notes.children.get('root') || []
  const tree = state.notes.query.trim() ? renderNoteSearchResults() : renderNoteTreeBranch(null)
  const workspace = element('section', {
    class: 'notes-workspace', 'data-drop-active': 'false',
    'data-browser-open': String(state.notes.browserOpen),
    onDragEnter: noteWorkspaceDragEnter, onDragOver: noteWorkspaceDragEnter,
    onDragLeave: noteWorkspaceDragLeave,
    onDrop: event => {
      clearNoteDragState()
      if (!hasDragType(event, 'Files')) return
      event.preventDefault()
      void importDroppedNotes(event.dataTransfer, state.notes.currentFolderId)
    },
  },
    state.notes.browserOpen ? element('button', {
      type: 'button', class: 'notes-browser-scrim', 'aria-label': 'Закрыть каталог заметок',
      onClick: () => { state.notes.browserOpen = false; renderShell() },
    }) : null,
    element('aside', { class: 'notes-browser', 'aria-label': 'Каталог заметок' },
      element('header', { class: 'notes-browser-header' },
        element('div', {}, element('h2', {}, 'Каталог'), element('span', {}, `${rootNodes.length} элементов в корне`)),
        element('div', { class: 'notes-browser-actions' },
          actionButton('Создать', () => openCreateNoteDocument(), 'primary small'),
          actionButton('Каталог', () => openCreateNoteFolder(), 'small'),
          actionButton('Импорт', () => fileInput.click(), 'ghost small'),
          actionButton('Команда сессии', openNoteAgentGuide, 'ghost small'),
          fileInput,
        ),
      ),
      element('div', { class: 'notes-search' }, element('input', {
        class: 'input', type: 'search', value: state.notes.query, placeholder: 'Поиск заметок и документов', 'aria-label': 'Поиск заметок и документов',
        onInput: event => scheduleNoteSearch(event.target.value),
      })),
      element('div', {
        class: 'notes-tree', role: 'tree', 'data-scroll-key': 'notes-tree',
        onDragOver: event => {
          if (hasDragType(event, 'application/x-dsh-note-id') || hasDragType(event, 'Files')) event.preventDefault()
        },
        onDrop: event => { if (event.target === event.currentTarget) void dropNoteNode(event, null) },
      }, tree),
    ),
    renderNoteContent(),
    element('div', { class: 'notes-drop-overlay', 'aria-hidden': 'true' },
      element('strong', {}, 'Отпустите, чтобы импортировать текущий каталог'),
      element('span', {}, 'Поддерживаются файлы и целые каталоги, исходная структура каталогов сохраняется.')),
    renderNoteTransfer(),
  )
  return element('section', { class: 'notes-page', 'aria-label': 'Рабочая область заметок' }, workspace)
}

function openNoteAgentGuide() {
  const capabilityRows = [
    ['Документ заметки', 'Создание, добавление или замена содержимого, переименование, перемещение, удаление'],
    ['Каталог заметок', 'Создание, переименование, перемещение, удаление'],
  ].map(([label, detail]) => element('div', { class: 'notes-agent-capability' },
    element('strong', {}, label), element('span', {}, detail)))
  const examples = [
    ['Создать', 'В каталоге «Материалы к релизу» рабочей области заметок создайте заметку-документ «Проверка перед релизом.md» со следующим содержимым: …'],
    ['Обновить', 'Допишите в заметку-документ «Материалы к релизу/Проверка перед релизом.md» следующее: …'],
    ['Каталог', 'Переименуйте каталог заметок «Материалы к релизу» в «Архив релизов».'],
  ].map(([label, text]) => element('li', {}, element('span', {}, label), element('code', {}, text)))
  const body = element('div', { class: 'notes-agent-guide' },
    element('section', { class: 'notes-agent-guide-rule' },
      element('span', { class: 'notes-agent-guide-index', 'aria-hidden': 'true' }, '01'),
      element('div', {},
        element('h3', {}, 'Укажите заметку или документ в текущем сообщении'),
        element('p', {}, 'Если в текущем сообщении явно указаны «документ-заметка», «каталог заметок» или «рабочее пространство заметок», сессия может просматривать и обслуживать их по вашему запросу; фиксированная формулировка не нужна. Во избежание ошибок для удаления по-прежнему нужно явно сказать «удалить», и разрешение не переносится из предыдущего раунда.'))),
    element('section', { class: 'notes-agent-guide-rule' },
      element('span', { class: 'notes-agent-guide-index', 'aria-hidden': 'true' }, '02'),
      element('div', {},
        element('h3', {}, 'Названия достаточно, при совпадении дополните путь'),
        element('p', {}, 'Внутренний номер указывать не нужно. Сессия сначала просмотрит каталог заметок, чтобы найти цель; при совпадении имён укажите «каталог/подкаталог/имя документа».'))),
    element('div', { class: 'notes-agent-capabilities', 'aria-label': 'Операции с заметками, доступные сессии' }, capabilityRows),
    element('section', { class: 'notes-agent-examples' },
      element('h3', {}, 'Можно сказать прямо так'),
      element('ul', {}, examples)),
    element('p', { class: 'notes-agent-guide-note' }, 'Фразы «создать Markdown» или «создать локальный каталог» сами по себе не дают прав на заметки; достаточно упомянуть «документ-заметка» в текущем сообщении.'))
  return openModal({
    title: 'Поручить сессии разобрать заметки',
    description: 'Сессия может работать с рабочим пространством заметок, но каждая запись требует явного разрешения в текущем сообщении пользователя.',
    body,
    cancelLabel: 'Понятно',
    className: 'notes-agent-guide-dialog',
  })
}

async function loadNoteShares(signal) {
  try {
    state.notes.shares = await api('notes/shares', { signal })
    state.notes.shareError = ''
  } catch (error) {
    if (error.name === 'AbortError') throw error
    state.notes.shareError = friendlyError(error)
  }
  return state.notes.shares
}

async function refreshNoteShares() {
  await loadNoteShares()
  renderShell()
  if (!state.notes.shareError) showToast('Список общего доступа обновлён.')
}

function renderShares() {
  return element('section', { class: 'shares-page', 'aria-label': 'Опубликованные заметки' },
    element('div', { class: 'section-heading shares-heading' },
      element('div', {}, element('h2', {}, 'Общее пространство'), element('p', {}, 'Управляйте созданными на этом устройстве ссылками только для чтения или копируйте чужой общий контент в свою рабочую область заметок.')),
      element('div', { class: 'shares-heading-actions' },
        actionButton('Импортировать из общей папки', openImportNoteShare, 'primary small'),
        actionButton('Обновить', () => { void refreshNoteShares() }, 'ghost small'),
      ),
    ),
    element('section', { class: 'panel shares-panel' },
      element('header', { class: 'panel-header shares-panel-header' },
        element('div', {}, element('h3', {}, 'Опубликовано с этого устройства'), element('p', {}, `${state.notes.shares.length} шт. · ссылки синхронизируются при обновлении`)),
      ),
      element('div', { class: 'shares-panel-body' },
    state.notes.shareError
      ? element('div', { class: 'notes-share-error', role: 'alert' }, element('strong', {}, 'Не удалось загрузить список общего доступа'), element('p', {}, state.notes.shareError), actionButton('Повторить', () => { void refreshNoteShares() }, 'small'))
      : state.notes.shares.length
        ? element('div', { class: 'notes-share-list' }, state.notes.shares.map(renderNoteShareRow))
        : element('div', { class: 'notes-folder-empty notes-share-empty' },
          element('span', { class: 'notes-share-empty-mark', 'aria-hidden': 'true' }),
          element('h3', {}, 'Пока нет материалов общего доступа'),
          element('p', {}, 'Откройте заметку или каталог и выберите «Поделиться», чтобы создать ссылку только для чтения.'),
          element('div', {}, actionButton('Открыть заметку-документ', () => { void navigate('notes') }, 'primary small')),
        ),
      ),
    ),
  )
}

function renderNoteShareRow(share) {
  const url = noteShareUrl(share)
  return element('article', { class: 'notes-share-row' },
    element('button', { type: 'button', class: 'notes-share-main', onClick: () => { void openSharedNoteOriginal(share) } },
      renderNoteIcon(share.node, true),
      element('span', {}, element('strong', {}, share.node.name), element('small', {}, share.node.kind === 'folder' ? 'Общий каталог и его элементы' : noteKindLabel(share.node))),
    ),
    element('div', { class: 'notes-share-meta' },
      element('span', {}, 'Опубликовано', element('time', { datetime: share.createdAt }, formatDate(share.createdAt))),
      element('span', {}, 'Ссылка автоматически обновляется при изменении исходного содержимого'),
    ),
    element('div', { class: 'notes-share-actions' },
      actionButton('Открыть источник', () => { void openSharedNoteOriginal(share) }, 'ghost small'),
      actionButton('Копировать ссылку', () => copyText(url, 'Ссылка для доступа скопирована.'), 'small'),
      actionButton('Управление', () => showNoteShareDialog(share), 'ghost small'),
    ),
  )
}

function openImportNoteShare() {
  const urlField = formField('Ссылка для доступа', 'input', '', {
    type: 'url', required: true, inputmode: 'url', autocomplete: 'off',
    placeholder: 'https://example.com/knowledge-api/v1/shared/share_…',
  })
  const destination = selectField('Импортировать в', [{ value: '', label: 'Документ заметки (корневой каталог)' }], '')
  destination.input.disabled = true
  const inspectButton = actionButton('Прочитать общий доступ', () => { void inspect() }, 'small')
  const fieldError = element('p', { class: 'share-import-field-error', role: 'alert', hidden: true })
  const privateConfirmation = element('div', { class: 'share-import-note', hidden: true, role: 'status' })
  const preview = element('div', { class: 'share-import-preview', 'data-state': 'empty', 'aria-live': 'polite' },
    element('span', { class: 'share-import-preview-mark', 'aria-hidden': 'true' }, interfaceIcon('share-import')),
    element('div', {}, element('strong', {}, 'Ожидание чтения общего доступа'), element('p', {}, 'После чтения отобразятся тип, количество файлов и размер; до импорта ничего не записывается.')),
  )
  const destinationHint = element('span', { class: 'field-hint' }, 'Чтение вашего каталога заметок…')
  destination.wrapper.append(destinationHint)
  const inputRow = element('div', { class: 'share-import-url-row' }, urlField.input, inspectButton)
  urlField.wrapper.replaceChildren(element('label', {}, 'Ссылка для доступа'), inputRow, fieldError)
  const form = element('form', { class: 'share-import-form', onSubmit: event => { event.preventDefault(); void inspect() } },
    urlField.wrapper,
    privateConfirmation,
    preview,
    destination.wrapper,
    element('p', { class: 'share-import-note' }, 'Импорт создаёт отдельную копию; последующие обновления или прекращение общего доступа на стороне отправителя не изменят уже импортированное содержимое.'),
  )
  let inspectedUrl = ''
  let confirmedPrivateUrl = ''

  const showFieldError = message => {
    fieldError.textContent = message
    fieldError.hidden = !message
    urlField.input.setAttribute('aria-invalid', String(Boolean(message)))
  }
  const renderPreview = manifest => {
    const kind = manifest.share.kind === 'folder' ? 'Каталог' : manifest.share.kind === 'document' ? 'Документ Markdown' : 'Файл'
    preview.dataset.state = 'ready'
    preview.replaceChildren(
      renderNoteIcon({ kind: manifest.share.kind, name: manifest.share.name, mediaType: null }, true),
      element('div', {},
        element('strong', {}, manifest.share.name),
        element('p', {}, `${kind} · ${manifest.share.fileCount} файлов · ${formatBytes(manifest.share.totalSize)}`),
      ),
      manifest.truncated ? badge('Превышен лимит импорта', 'danger') : badge('Можно импортировать', 'success'),
    )
  }
  const inspect = async () => {
    if (inspectButton.disabled) return false
    if (!urlField.input.reportValidity()) return false
    const requestedUrl = urlField.input.value.trim()
    urlField.input.disabled = true
    privateConfirmation.hidden = true
    inspectButton.disabled = true
    inspectButton.setAttribute('aria-busy', 'true')
    inspectButton.textContent = 'Чтение…'
    showFieldError('')
    preview.dataset.state = 'loading'
    try {
      const result = await api('notes/import-share/inspect', { method: 'POST', body: { url: requestedUrl, confirmPrivateShare: confirmedPrivateUrl === requestedUrl } })
      inspectedUrl = requestedUrl
      renderPreview(result.manifest)
      return !result.manifest.truncated
    } catch (error) {
      inspectedUrl = ''
      preview.dataset.state = 'error'
      preview.replaceChildren(
        element('span', { class: 'share-import-preview-mark', 'aria-hidden': 'true' }, interfaceIcon('share-import')),
        element('div', {}, element('strong', {}, 'Не удалось прочитать эту ссылку общего доступа'), element('p', {}, 'Проверьте, полная ли ссылка и действует ли ещё общий доступ.')),
      )
      showFieldError(friendlyError(error))
      if (error.code === 'PRIVATE_SHARE_CONFIRMATION_REQUIRED' && error.origin === new URL(requestedUrl).origin) {
        confirmedPrivateUrl = ''
        showFieldError('')
        preview.dataset.state = 'empty'
        preview.replaceChildren(
          element('span', { class: 'share-import-preview-mark', 'aria-hidden': 'true' }, interfaceIcon('share-import')),
          element('div', {}, element('strong', {}, 'Ожидание подтверждения доступа из внутренней сети'), element('p', {}, 'После подтверждения список общего доступа будет прочитан, импорт сразу не выполняется.')),
        )
        privateConfirmation.replaceChildren(
          element('p', {}, `Адрес ${error.origin} указывает на внутреннюю сеть. После подтверждения сервер DSH обратится к API этой ссылки — разрешайте только доверенные источники. Разрешение действует лишь для этого чтения и импорта и не сохраняется в белый список.`),
          actionButton('Разрешить общий доступ и чтение в этой локальной сети', () => { confirmedPrivateUrl = requestedUrl; void inspect() }, 'small'),
        )
        privateConfirmation.hidden = false
      }
      return false
    } finally {
      inspectButton.disabled = false
      urlField.input.disabled = false
      inspectButton.removeAttribute('aria-busy')
      inspectButton.textContent = 'Прочитать общий доступ'
    }
  }
  urlField.input.addEventListener('input', () => {
    confirmedPrivateUrl = ''
    privateConfirmation.hidden = true
    if (urlField.input.value.trim() !== inspectedUrl) {
      inspectedUrl = ''
      preview.dataset.state = 'empty'
    }
    showFieldError('')
  })

  openModal({
    title: 'Импортировать из общей папки',
    description: 'Скопировать доступ только для чтения в вашу рабочую область заметок',
    body: form,
    primaryLabel: 'Импортировать заметку',
    className: 'share-import-dialog',
    onPrimary: async () => {
      const requestedUrl = urlField.input.value.trim()
      if (!requestedUrl || inspectedUrl !== requestedUrl) {
        showFieldError('Сначала прочитайте и подтвердите содержимое общего доступа.')
        urlField.input.focus()
        return false
      }
      showFieldError('')
      try {
        const result = await api('notes/import-share', {
          method: 'POST', body: { url: requestedUrl, parentId: destination.input.value || null, confirmPrivateShare: confirmedPrivateUrl === requestedUrl },
        })
        state.notes.children.clear()
        state.notes.loadedFolders.clear()
        showToast(`Импортировано «${result.root.name}», элементов: ${result.importedNodes}.`)
        return true
      } catch (error) {
        showFieldError(friendlyError(error))
        return false
      }
    },
  })

  void loadShareImportDestinations().then(options => {
    destination.input.replaceChildren(...options.map(option => element('option', { value: option.value }, option.label)))
    destination.input.disabled = false
    destinationHint.textContent = options.length > 1 ? `Доступно папок: ${options.length - 1}` : 'Сейчас импорт идёт в корневой каталог заметок'
  }).catch(error => {
    destination.input.disabled = false
    destinationHint.textContent = `Не удалось прочитать каталог, импорт в корень: ${friendlyError(error)}`
  })
}

async function loadShareImportDestinations() {
  const options = [{ value: '', label: 'Документ заметки (корневой каталог)' }]
  const queue = [{ id: null, path: '' }]
  while (queue.length && options.length <= 500) {
    const batch = queue.splice(0, 4)
    const groups = await Promise.all(batch.map(async parent => ({ parent, nodes: await loadNoteChildren(parent.id) })))
    for (const { parent, nodes } of groups) {
      for (const node of nodes) {
        if (node.kind !== 'folder') continue
        const path = parent.path ? `${parent.path}/${node.name}` : node.name
        options.push({ value: node.id, label: path })
        queue.push({ id: node.id, path })
        if (options.length > 500) break
      }
    }
  }
  return options
}

function renderNoteTransfer() {
  const transfer = state.notes.transfer
  if (!transfer) return null
  const dismissible = transfer.phase === 'complete' || transfer.phase === 'error'
  return element('section', {
    class: 'notes-transfer', 'data-note-transfer': transfer.id, 'data-state': transfer.phase,
    role: transfer.phase === 'error' ? 'alert' : 'status', 'aria-live': 'polite',
  },
    element('div', { class: 'notes-transfer-heading' },
      element('span', { class: 'notes-transfer-mark', 'aria-hidden': 'true' }),
      element('strong', { class: 'notes-transfer-title' }, noteTransferTitle(transfer)),
      dismissible ? actionButton('Закрыть', dismissNoteTransfer, 'ghost tiny notes-transfer-close', { 'aria-label': 'Закрыть ход импорта' }) : null,
    ),
    element('div', { class: 'notes-transfer-detail', title: transfer.currentName || '' }, noteTransferDetail(transfer)),
    element('div', {
      class: 'notes-transfer-track', role: 'progressbar',
      'aria-label': 'Ход импорта заметок', 'aria-valuemin': '0', 'aria-valuemax': '100',
      'aria-valuenow': transfer.phase === 'scanning' ? undefined : String(noteTransferPercent(transfer)),
    }, element('span', { class: 'notes-transfer-fill' })),
    element('div', { class: 'notes-transfer-meta' },
      element('span', { class: 'notes-transfer-count' }, noteTransferCount(transfer)),
      element('span', { class: 'notes-transfer-percent' }, transfer.phase === 'scanning' ? 'Упорядочивание' : `${noteTransferPercent(transfer)}%`),
    ),
  )
}

function renderNoteTreeBranch(parentId, depth = 0) {
  const key = parentId || 'root'
  const nodes = state.notes.children.get(key) || []
  if (!nodes.length && depth === 0) {
    return element('div', { class: 'notes-tree-empty' }, element('strong', {}, 'Пока нет заметок'), element('span', {}, 'Создайте каталог или документ, чтобы начать упорядочивание.'))
  }
  return element('div', { class: 'notes-tree-branch', role: depth ? 'group' : undefined }, nodes.map(node => {
    const selected = state.notes.selectedId === node.id
    const expanded = node.kind === 'folder' && state.notes.expandedFolders.has(node.id)
    const row = element('div', {
      class: 'notes-tree-item', 'data-kind': node.kind, 'data-selected': String(selected),
      'data-note-id': node.id,
      draggable: 'true',
      onDragStart: event => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('application/x-dsh-note-id', node.id)
        event.currentTarget.dataset.dragging = 'true'
      },
      onDragEnd: () => clearNoteDragState(),
      onDragEnter: event => activateNoteFolderDropTarget(event, node),
      onDragOver: event => activateNoteFolderDropTarget(event, node),
      onDragLeave: event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.dataset.dropTarget = 'false' },
      onDrop: event => { if (node.kind === 'folder') void dropNoteNode(event, node.id) },
    },
      element('button', {
        type: 'button', class: 'notes-tree-row', role: 'treeitem',
        'aria-selected': String(selected), 'aria-expanded': node.kind === 'folder' ? String(expanded) : undefined,
        onClick: () => { void selectNoteNode(node, { toggleFolder: node.kind === 'folder' }) },
      },
        node.kind === 'folder' ? element('span', { class: 'notes-tree-chevron', 'aria-hidden': 'true' }) : element('span', { class: 'notes-tree-spacer' }),
        renderNoteIcon(node),
        element('span', { class: 'notes-tree-name', title: node.name }, node.name),
      ),
      element('div', { class: 'notes-row-actions' },
        actionButton('Переименовать', event => { event.stopPropagation(); openRenameNoteNode(node) }, 'ghost tiny'),
        actionButton('Копировать', event => { event.stopPropagation(); void copyNoteNode(node) }, 'ghost tiny'),
        actionButton('Удалить', event => { event.stopPropagation(); void confirmDeleteNoteNode(node) }, 'ghost tiny danger-text'),
      ),
    )
    const children = expanded
      ? state.notes.loadedFolders.has(node.id)
        ? renderNoteTreeBranch(node.id, depth + 1)
        : element('div', { class: 'notes-tree-loading', role: 'status' }, 'Чтение…')
      : null
    return element('div', { class: 'notes-tree-node' }, row, children)
  }))
}

function renderNoteSearchResults() {
  if (!state.notes.searchResults.length) return element('div', { class: 'notes-tree-empty' }, 'Нет подходящих документов-заметок.')
  return element('div', { class: 'notes-search-results' }, state.notes.searchResults.map(node => element('button', {
    type: 'button', class: 'notes-search-row',
    onClick: () => { void selectNoteNode(node) },
  }, renderNoteIcon(node), element('span', {}, element('strong', {}, node.name), element('small', {}, noteKindLabel(node))))))
}

function renderNoteContent() {
  const node = state.notes.selectedNode
  if (!node) return renderNoteFolderContent(null)
  if (state.notes.loadingNodeId === node.id) return renderNoteSelectionLoading(node)
  if (node.kind === 'folder') return renderNoteFolderContent(node)
  if (node.kind === 'document') return renderNoteDocument(node)
  return renderNoteFile(node)
}

function renderNoteSelectionLoading(node) {
  return element('main', { class: `notes-content notes-selection-loading is-${node.kind}`, role: 'status', 'aria-label': `Открывается ${node.name}` },
    element('header', { class: 'notes-content-header' },
      element('div', { class: 'notes-breadcrumb' }, element('span', {}, 'Документ заметки'), element('span', { 'aria-hidden': 'true' }, '/'), element('strong', {}, node.name)),
      element('div', { class: 'notes-content-title' }, element('div', {}, element('h2', {}, node.name), element('p', {}, node.kind === 'folder' ? 'Чтение содержимого каталога' : 'Чтение содержимого документа по мере необходимости'))),
    ),
    element('div', { class: 'notes-selection-skeleton', 'aria-hidden': 'true' },
      element('div', { class: 'skeleton-line skeleton-paper-title' }),
      ...Array.from({ length: node.kind === 'folder' ? 6 : 9 }, (_, index) => element('div', { class: `skeleton-line skeleton-paper-row is-${index % 4}` })),
    ),
  )
}

function renderNoteFolderContent(folder) {
  const parentId = folder?.id || null
  const children = state.notes.children.get(parentId || 'root') || []
  return element('main', {
    class: 'notes-content is-folder',
    onDragOver: event => event.preventDefault(),
    onDrop: event => void dropNoteNode(event, parentId),
  },
    renderNoteContentHeader(folder),
    children.length
      ? element('div', { class: 'notes-file-table' },
        element('div', { class: 'notes-file-columns', 'aria-hidden': 'true' },
          element('span', {}, 'Название'), element('span', {}, 'Время обновления'), element('span', {}, 'Размер'), element('span', {}, 'Действие')),
        element('div', { class: 'notes-file-list', role: 'list' }, children.map(node => element('div', {
        class: 'notes-file-row', role: 'listitem', draggable: 'true',
        onDragStart: event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-dsh-note-id', node.id) },
        onDblClick: () => { void selectNoteNode(node, { toggleFolder: node.kind === 'folder' }) },
      },
        element('button', { type: 'button', class: 'notes-file-main', onClick: () => { void selectNoteNode(node) } },
          renderNoteIcon(node, true),
          element('span', {}, element('strong', {}, node.name), element('small', {}, noteKindLabel(node))),
        ),
        element('time', { datetime: node.updatedAt, 'data-label': 'Обновить' }, formatDate(node.updatedAt)),
        element('span', { class: 'notes-file-size', 'data-label': node.kind === 'folder' ? 'Тип' : 'Размер' }, node.kind === 'folder' ? 'Каталог' : formatBytes(node.size)),
        element('div', { class: 'notes-file-actions' },
          node.kind !== 'folder' ? noteDownloadButton(node, 'ghost tiny') : null,
          actionButton(noteShareForNode(node.id) ? 'Публикация' : 'Поделиться', () => { void openNoteShare(node) }, 'ghost tiny'),
          actionButton('Переименовать', () => openRenameNoteNode(node), 'ghost tiny'),
          actionButton('Копировать', () => { void copyNoteNode(node) }, 'ghost tiny'),
          actionButton('Удалить', () => { void confirmDeleteNoteNode(node) }, 'ghost tiny danger-text'),
        ),
        ))))
      : element('div', { class: 'notes-folder-empty' },
        element('span', { class: 'notes-empty-folder-mark', 'aria-hidden': 'true' }),
        element('h3', {}, 'Этот каталог пока пуст'),
        element('p', {}, 'Здесь можно создать документ-заметку, подкаталог или перетащить локальные файлы.'),
        element('div', {}, actionButton('Создать документ', () => openCreateNoteDocument(parentId), 'primary small'), actionButton('Создать каталог', () => openCreateNoteFolder(parentId), 'small')),
      ),
  )
}

function renderNoteContentHeader(folder) {
  const path = folder ? [...state.notes.breadcrumbs] : []
  return element('header', { class: 'notes-content-header' },
    element('nav', { class: 'notes-breadcrumb', 'aria-label': 'Текущее расположение' },
      element('button', { type: 'button', onClick: () => { void openNoteRoot() } }, 'Документ заметки'),
      path.map(node => element('span', {}, element('span', { 'aria-hidden': 'true' }, '/'), element('button', { type: 'button', onClick: () => { void selectNoteNode(node) } }, node.name))),
    ),
    element('div', { class: 'notes-content-title' },
      element('div', {}, element('h2', {}, folder?.name || 'Все заметки'), element('p', {}, folder ? `${(state.notes.children.get(folder.id) || []).length} элементов` : 'Ваш отдельный каталог заметок и материалов')),
      element('div', { class: 'notes-content-actions' },
        folder ? actionButton(noteShareForNode(folder.id) ? 'Публикация' : 'Общий каталог', () => { void openNoteShare(folder) }, 'ghost small') : null,
        actionButton('Опубликовано', () => { void navigate('shares') }, 'ghost small'),
        actionButton('Создать документ', () => openCreateNoteDocument(folder?.id || null), 'primary small'),
        actionButton('Создать каталог', () => openCreateNoteFolder(folder?.id || null), 'small'),
      ),
    ),
  )
}

function renderNoteDocument(node) {
  return renderEditableNote(node)
}

function renderEditableNote(node) {
  const markdown = isMarkdownNote(node)
  const title = editableNoteTitle(node)
  const editor = markdown
    ? element('div', { class: 'notes-live-editor', role: 'status', 'aria-label': `Открывается ${node.name}` },
      element('div', { class: 'notes-editor-loading' }, 'Открытие документа…'))
    : createPlainTextNoteEditor(node)
  const scrollHost = element('div', { class: 'notes-document-scroll', 'data-scroll-key': `notes-document:${node.id}` },
    element('h1', {
      class: 'notes-document-title', contenteditable: 'plaintext-only', spellcheck: 'false',
      'aria-label': `Изменить заголовок ${node.name}`, title: 'Нажмите, чтобы изменить заголовок',
      onInput: () => { state.notes.titleDirty = true },
      onBlur: event => { void saveEditableNoteTitle(event.currentTarget, node) },
      onKeyDown: event => {
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
        if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.textContent = editableNoteTitle(state.notes.selectedNode || node); state.notes.titleDirty = false; event.currentTarget.blur() }
      },
    }, title),
    editor,
  )
  const outlineHost = markdown ? element('aside', { id: 'dsh-note-outline', class: 'notes-editor-outline', 'aria-label': 'Структура документа', 'aria-hidden': 'true' }) : null
  const editorFrame = markdown
    ? element('div', { class: 'notes-editor-frame', 'data-outline-open': 'false', 'data-find-open': 'false' }, scrollHost, outlineHost)
    : scrollHost
  if (markdown) mountMarkdownNoteEditor(editor, node, editorFrame, scrollHost, outlineHost)
  else mountPlainTextNoteEditor(editor, node)
  return element('main', { class: `notes-content is-document${markdown ? '' : ' has-line-numbers'}` },
    renderNoteFileToolbar(node, { editable: true, enhanced: markdown }),
    editorFrame,
    renderNoteFileStatusbar(node),
  )
}

function editableNoteTitle(node) {
  return node.kind === 'document' ? node.name.replace(/\.md$/i, '') : node.name
}

async function saveEditableNoteTitle(editor, node) {
  node = state.notes.selectedNode?.id === node.id ? state.notes.selectedNode : node
  const title = readPlainTextEditor(editor).replace(/\s+/g, ' ').trim()
  const name = node.kind === 'document' && title ? `${title.replace(/\.md$/i, '')}.md` : title
  if (!name) {
    editor.textContent = editableNoteTitle(node)
    state.notes.titleDirty = false
    showToast('Заголовок не может быть пустым.', 'error')
    return
  }
  if (name === node.name) {
    editor.textContent = editableNoteTitle(node)
    state.notes.titleDirty = false
    return
  }
  editor.setAttribute('contenteditable', 'false')
  state.notes.renaming = true
  try {
    const updated = await api(`notes/${encodeURIComponent(node.id)}`, { method: 'PATCH', body: { name, expectedName: node.name } })
    if (state.notes.selectedNode?.id === node.id) { state.notes.selectedNode = updated; state.notes.titleDirty = false }
    editor.textContent = editableNoteTitle(updated)
    const breadcrumb = document.querySelector('.notes-document-toolbar .notes-breadcrumb strong')
    if (breadcrumb) breadcrumb.textContent = updated.name
    await loadNoteChildren(updated.parentId, true).catch(() => {})
    const treeName = document.querySelector(`.notes-tree-item[data-note-id="${updated.id}"] .notes-tree-name`)
    if (treeName) treeName.textContent = updated.name
    showToast('Заголовок обновлён.')
  } catch (error) {
    // Keep the user's title available to copy/retry, rather than silently losing it.
    showToast(friendlyError(error), 'error')
  } finally {
    state.notes.renaming = false
    if (editor.isConnected) editor.setAttribute('contenteditable', 'plaintext-only')
  }
}

function createPlainTextNoteEditor(node) {
  return element('div', { class: 'notes-plain-editor', role: 'status', 'aria-label': `Открывается ${node.name}` },
    element('div', { class: 'notes-editor-loading' }, 'Открытие документа…'))
}

function readPlainTextEditor(editor) {
  return editor.innerText.replace(/\r\n?/g, '\n')
}

function updateNoteDraft(value) {
  state.notes.draft = value
  state.notes.dirty = state.notes.draft !== state.notes.content
  syncNoteEditorChrome()
}

function mountMarkdownNoteEditor(host, node, frame, scrollHost, outlineHost) {
  mountMarkdownEditor(host, {
    frame,
    scrollHost,
    outlineHost,
    markdown: state.notes.draft,
    label: `Изменить ${node.name}`,
    isCurrent: () => state.notes.selectedNode?.id === node.id,
    onChange: updateNoteDraft,
    onSave: () => { void saveNoteDocument() },
    onExcerpt: text => { void excerptSelectedNote(node, text) },
  })
}

function mountPlainTextNoteEditor(host, node) {
  const request = ++plainTextEditorMountRequest
  window.requestAnimationFrame(async () => {
    if (!host.isConnected || state.notes.selectedNode?.id !== node.id || request !== plainTextEditorMountRequest) return
    try {
      const runtime = await loadMarkdownNoteEditor()
      if (!host.isConnected || state.notes.selectedNode?.id !== node.id || request !== plainTextEditorMountRequest) return
      host.replaceChildren()
      host.removeAttribute('role')
      plainTextEditorHandle = runtime.createPlainTextEditor({
        host,
        text: state.notes.draft,
        label: `Изменить ${node.name}`,
        onChange: updateNoteDraft,
        onSave: () => { void saveNoteDocument() },
      })
    } catch (error) {
      if (!host.isConnected || request !== plainTextEditorMountRequest) return
      host.replaceChildren(element('div', { class: 'notes-editor-error', role: 'alert' },
        element('strong', {}, 'Не удалось открыть редактор простого текста'),
        element('span', {}, friendlyError(error)),
        actionButton('Повторить', () => { noteEditorLoader = null; host.replaceChildren(); mountPlainTextNoteEditor(host, node) }, 'small')))
    }
  })
}

function mountMarkdownEditor(host, options) {
  const request = ++markdownEditorMountRequest
  window.requestAnimationFrame(async () => {
    if (!host.isConnected || options.isCurrent?.() === false || request !== markdownEditorMountRequest) return
    try {
      const runtime = await loadMarkdownNoteEditor()
      if (!host.isConnected || options.isCurrent?.() === false || request !== markdownEditorMountRequest) return
      host.replaceChildren()
      host.removeAttribute('role')
      markdownEditorHandle = runtime.createMarkdownEditor({
        host,
        ...(options.frame ? {
          frame: options.frame,
          scrollHost: options.scrollHost,
          outlineHost: options.outlineHost,
          findButton: host.closest('.notes-content')?.querySelector('[data-note-find]') || null,
          outlineButton: host.closest('.notes-content')?.querySelector('[data-note-outline]') || null,
        } : {}),
        markdown: options.markdown,
        label: options.label,
        onChange: options.onChange,
        onSave: options.onSave,
        onExcerpt: options.onExcerpt,
        onOpenNote: id => { void openNoteReference(id) },
      })
    } catch (error) {
      if (!host.isConnected || request !== markdownEditorMountRequest) return
      host.replaceChildren(element('div', { class: 'notes-editor-error', role: 'alert' },
        element('strong', {}, 'Не удалось открыть редактор Markdown'),
        element('span', {}, friendlyError(error)),
        actionButton('Повторить', () => { noteEditorLoader = null; host.replaceChildren(); mountMarkdownEditor(host, options) }, 'small')))
    }
  })
}

async function excerptSelectedNote(node, text) {
  try {
    if (state.notes.selectedNode?.id !== node.id) return
    if (!await saveNoteDocument()) return
    if (state.notes.selectedNode?.id !== node.id) return
    await openNoteExcerpt({ node, text, api, element, openSheet, showToast, friendlyError, formField, selectField, knowledgeBasePathLabel })
  } catch (error) { showToast(friendlyError(error), 'error') }
}

function loadMarkdownNoteEditor() {
  if (window.DshKnowledgeNoteEditor?.createMarkdownEditor) return Promise.resolve(window.DshKnowledgeNoteEditor)
  if (noteEditorLoader) return noteEditorLoader
  noteEditorLoader = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    const suffix = ASSET_VERSION ? `?v=${encodeURIComponent(ASSET_VERSION)}` : ''
    script.src = `${WEB_PATH.replace(/\/$/, '')}/note-editor.js${suffix}`
    script.async = true
    script.onload = () => window.DshKnowledgeNoteEditor?.createMarkdownEditor
      ? resolve(window.DshKnowledgeNoteEditor)
      : reject(new Error('Недопустимый модуль редактора Markdown'))
    script.onerror = () => { script.remove(); reject(new Error('Не удалось загрузить редактор Markdown')) }
    document.head.append(script)
  }).catch(error => {
    noteEditorLoader = null
    throw error
  })
  return noteEditorLoader
}

function releaseNoteEditors() {
  markdownEditorMountRequest += 1
  plainTextEditorMountRequest += 1
  markdownEditorHandle?.destroy()
  plainTextEditorHandle?.destroy()
  markdownEditorHandle = null
  plainTextEditorHandle = null
}

function syncNoteEditorChrome() {
  const status = document.querySelector('[data-note-save-state]')
  if (status) {
    status.textContent = state.notes.saving ? 'Сохранение…' : state.notes.dirty ? 'Не сохранено' : 'Сохранено'
    status.dataset.dirty = String(state.notes.dirty)
  }
  const save = document.querySelector('[data-note-save]')
  if (save) save.disabled = state.notes.saving || !state.notes.dirty
}

function renderNoteDocumentBreadcrumb(node) {
  return element('nav', { class: 'notes-breadcrumb', 'aria-label': 'Текущее расположение' },
    element('button', { type: 'button', onClick: () => { void openNoteRoot() } }, 'Документ заметки'),
    state.notes.breadcrumbs.map(parent => element('span', {}, element('span', { 'aria-hidden': 'true' }, '/'), element('button', { type: 'button', onClick: () => { void selectNoteNode(parent) } }, parent.name))),
    element('span', {}, element('span', { 'aria-hidden': 'true' }, '/'), element('strong', {}, node.name)),
  )
}

function renderNoteFile(node) {
  if (node.editable) return renderEditableNote(node)
  const previewKind = noteFilePreviewKind(node)
  let preview
  if (previewKind === 'image' && state.notes.assetUrl) {
    preview = element('img', { class: 'notes-inline-image', src: state.notes.assetUrl, alt: node.name })
  } else if (previewKind === 'pdf' && state.notes.assetUrl) {
    preview = element('iframe', { class: 'notes-inline-frame', src: state.notes.assetUrl, title: node.name })
  } else {
    preview = element('div', { class: 'notes-inline-unavailable' },
      renderNoteIcon(node, true),
      element('h2', {}, node.name),
      element('p', {}, 'Этот формат нельзя редактировать прямо в браузере — скачайте файл и откройте его в локальном приложении.'),
      noteDownloadButton(node, 'primary small', 'Скачать файл'),
    )
  }
  return element('main', { class: 'notes-content is-file' },
    renderNoteFileToolbar(node),
    element('section', { class: `notes-inline-viewer is-${previewKind}`, 'aria-label': `Содержимое: ${node.name}` }, preview),
    renderNoteFileStatusbar(node),
  )
}

function renderNoteFileToolbar(node, options = {}) {
  return element('header', { class: 'notes-document-toolbar' },
    element('div', { class: 'notes-toolbar-leading' }, renderNoteDocumentBreadcrumb(node)),
    element('div', { class: 'notes-document-actions' },
      options.editable ? element('span', { class: 'notes-save-state', role: 'status', 'data-note-save-state': '', 'data-dirty': String(state.notes.dirty) }, state.notes.dirty ? 'Не сохранено' : 'Сохранено') : null,
      options.enhanced ? actionButton([
        interfaceIcon('outline', 'notes-toolbar-action-icon'), element('span', {}, 'Структура'),
      ], () => markdownEditorHandle?.toggleOutline(), 'ghost small notes-outline-action', { 'data-note-outline': '', 'aria-label': 'Открыть структуру заголовков', title: 'Структура заголовков', 'aria-controls': 'dsh-note-outline', 'aria-expanded': 'false', 'aria-pressed': 'false' }) : null,
      options.editable ? actionButton('Сохранить', () => { void saveNoteDocument() }, 'primary small', { 'data-note-save': '', disabled: !state.notes.dirty, 'aria-keyshortcuts': 'Control+S Meta+S' }) : null,
      renderNoteFileOverflowMenu(node, options),
    ),
  )
}

function renderNoteFileOverflowMenu(node, options) {
  return renderDocumentMenu(node.name, [
    [
      ...(options.enhanced ? [{ label: 'Найти', icon: 'search', run: () => markdownEditorHandle?.openFind(), attributes: { 'data-note-find': '', 'aria-keyshortcuts': 'Control+F Meta+F' } }] : []),
      ...(options.editable ? [{ label: 'История страницы', icon: 'history', run: () => { void openNoteHistory(node) }, attributes: { 'data-note-history': '' } }] : []),
    ],
    [
      { label: 'Скачать', icon: 'download', run: event => { void downloadNoteFile(node, event.currentTarget) } },
      { label: noteShareForNode(node.id) ? 'Управление общим доступом' : 'Создать общий доступ', icon: 'link', run: () => { void openNoteShare(node) } },
      { label: 'Копировать ссылку-цитату', icon: 'link', run: () => { void copyNoteReference(node) } },
    ],
    [
      { label: 'Переименовать', icon: 'rename', run: () => openRenameNoteNode(node) },
      { label: 'Показать опубликованные', icon: 'outline', run: () => { void navigate('shares') } },
    ],
  ])
}

function renderNoteFileStatusbar(node) {
  return element('footer', { class: 'notes-document-statusbar', 'aria-label': 'Информация о документе' },
    element('div', { class: 'notes-file-info' },
      noteInfoItem('Номер', shortNoteId(node.id), node.id, 'id'),
      noteInfoItem('Формат', node.kind === 'document' ? 'Markdown' : node.mediaType || 'Неизвестно'),
      noteInfoItem('Размер', formatBytes(node.size), '', 'size'),
      noteInfoItem('Обновить', formatDate(node.updatedAt), '', 'updated'),
    ),
  )
}

function noteInfoItem(label, value, title = '', key = '') {
  return element('span', { class: 'notes-file-info-item', title: title || value, ...(key ? { 'data-note-info': key } : {}) }, element('strong', {}, label), element('span', {}, value))
}

function renderNoteIcon(node, large = false) {
  return element('span', { class: `note-node-icon ${node.kind === 'folder' ? 'tree-folder-icon' : 'tree-document-icon'}${large ? ' is-large' : ''}`, 'data-media-kind': noteMediaKind(node), 'aria-hidden': 'true' })
}

function noteKindLabel(node) {
  if (node.kind === 'folder') return 'Каталог'
  if (node.kind === 'document') return 'Заметка Markdown'
  return `${node.mediaType || 'файл'}  ${formatBytes(node.size)}`
}

function isMarkdownNote(node) {
  return node.kind === 'document' || node.mediaType === 'text/markdown' || /\.(md|markdown)$/i.test(node.name)
}

function noteFilePreviewKind(node) {
  if (node.mediaType?.startsWith('image/')) return 'image'
  if (node.mediaType === 'application/pdf' || /\.pdf$/i.test(node.name)) return 'pdf'
  return 'unavailable'
}

async function selectNoteNode(node, options = {}) {
  if (state.notes.titleDirty || state.notes.renaming) return showToast('Сначала сохраните заголовок; чтобы отказаться от правок заголовка, нажмите Escape в поле заголовка.', 'error')
  if (state.notes.dirty && !await saveNoteDocument()) return
  const request = ++noteSelectionRequest
  releaseNoteAsset()
  state.notes.selectedId = node.id
  state.notes.selectedNode = node
  state.notes.browserOpen = false
  Object.assign(state.notes, { content: '', draft: '', dirty: false })
  state.notes.loadingNodeId = node.id
  renderShell()
  try {
    const breadcrumbs = await loadNoteBreadcrumbs(node)
    if (request !== noteSelectionRequest || state.notes.selectedId !== node.id) return
    state.notes.breadcrumbs = breadcrumbs
    if (node.kind === 'folder') {
      Object.assign(state.notes, { content: '', draft: '', dirty: false })
      state.notes.currentFolderId = node.id
      if (options.toggleFolder) {
        if (state.notes.expandedFolders.has(node.id)) state.notes.expandedFolders.delete(node.id)
        else state.notes.expandedFolders.add(node.id)
      }
      await loadNoteChildren(node.id)
    } else if (node.editable) {
      const snapshot = await readNoteSnapshot(node.id)
      const content = snapshot.content
      if (request !== noteSelectionRequest || state.notes.selectedId !== node.id) return
      state.notes.content = content
      state.notes.selectedNode = snapshot.node
      state.notes.contentVersion = snapshot.node.version
      state.notes.draft = content
      state.notes.dirty = false
      state.notes.currentFolderId = node.parentId
    } else {
      state.notes.content = ''
      state.notes.draft = ''
      state.notes.dirty = false
      state.notes.currentFolderId = node.parentId
      if (noteFilePreviewKind(node) !== 'unavailable') {
        const blob = await binaryRequest(`notes/${encodeURIComponent(node.id)}/content`, { responseType: 'blob', accept: node.mediaType || 'application/octet-stream' })
        if (request !== noteSelectionRequest || state.notes.selectedId !== node.id) return
        state.notes.assetUrl = URL.createObjectURL(blob)
      }
    }
  } catch (error) {
    if (request === noteSelectionRequest) showToast(friendlyError(error), 'error')
  } finally {
    if (request === noteSelectionRequest && state.notes.loadingNodeId === node.id) {
      state.notes.loadingNodeId = ''
      renderShell()
    }
  }
}

async function loadNoteChildren(parentId, force = false) {
  const key = parentId || 'root'
  if (!force && state.notes.loadedFolders.has(key)) return state.notes.children.get(key) || []
  const params = new URLSearchParams({ limit: '500' })
  if (parentId) params.set('parentId', parentId)
  const nodes = await api(`notes?${params}`)
  state.notes.children.set(key, nodes)
  state.notes.loadedFolders.add(key)
  return nodes
}

async function loadNoteBreadcrumbs(node) {
  const parents = []
  let parentId = node.parentId
  while (parentId) {
    const parent = findCachedNote(parentId) || await api(`notes/${encodeURIComponent(parentId)}`)
    parents.unshift(parent)
    parentId = parent.parentId
  }
  return node.kind === 'folder' ? [...parents, node] : parents
}

function findCachedNote(id) {
  for (const nodes of state.notes.children.values()) {
    const found = nodes.find(node => node.id === id)
    if (found) return found
  }
  return state.notes.selectedNode?.id === id ? state.notes.selectedNode : null
}

async function openNoteRoot() {
  if (state.notes.titleDirty || state.notes.renaming) return showToast('Сначала сохраните заголовок; чтобы отказаться от правок заголовка, нажмите Escape в поле заголовка.', 'error')
  if (state.notes.dirty && !await saveNoteDocument()) return
  noteSelectionRequest += 1
  clearNoteSelection()
  await loadNoteChildren(null)
  renderShell()
}

function clearNoteSelection() {
  releaseNoteAsset()
  Object.assign(state.notes, { selectedId: '', selectedNode: null, currentFolderId: null, breadcrumbs: [], content: '', draft: '', dirty: false, loadingNodeId: '' })
}

function releaseNoteAsset() {
  if (!state.notes?.assetUrl) return
  URL.revokeObjectURL(state.notes.assetUrl)
  state.notes.assetUrl = ''
}

function scheduleNoteSearch(value) {
  state.notes.query = value
  window.clearTimeout(noteSearchTimer)
  noteSearchController?.abort()
  noteSearchController = null
  const request = ++noteSearchRequest
  noteSearchTimer = window.setTimeout(async () => {
    const controller = new AbortController()
    noteSearchController = controller
    try {
      const results = value.trim()
        ? await api(`notes?q=${encodeURIComponent(value.trim())}&limit=200`, { signal: controller.signal })
        : []
      if (request !== noteSearchRequest || value !== state.notes.query) return
      state.notes.searchResults = results
      renderShell()
    } catch (error) {
      if (!controller.signal.aborted && request === noteSearchRequest) showToast(friendlyError(error), 'error')
    } finally {
      if (noteSearchController === controller) noteSearchController = null
    }
  }, 180)
}

function openCreateNoteFolder(parentId = state.notes.currentFolderId) {
  const field = formField('Название каталога', 'text', '', { maxlength: 255, placeholder: 'Например: материалы проекта' })
  const form = element('form', { class: 'form-grid' }, field.wrapper)
  openSheet({
    title: 'Создать каталог', description: 'Каталог может содержать подкаталоги, документы-заметки и любые файлы.', body: form,
    primaryLabel: 'Создать каталог', onPrimary: async () => {
      const node = await api('notes/folders', { method: 'POST', body: { name: field.input.value, parentId } })
      await loadNoteChildren(parentId, true)
      if (parentId) state.notes.expandedFolders.add(parentId)
      await selectNoteNode(node)
      return true
    },
  })
  field.input.focus()
}

function openCreateNoteDocument(parentId = state.notes.currentFolderId) {
  const field = formField('Название документа', 'text', '', { maxlength: 255, placeholder: 'Например: журнал развёртывания' })
  const form = element('form', { class: 'form-grid' }, field.wrapper)
  openSheet({
    title: 'Создать документ-заметку', description: 'Документ редактируется в Markdown и по умолчанию не извлекается и не записывается AI.', body: form,
    primaryLabel: 'Создать и редактировать', onPrimary: async () => {
      const node = await api('notes/documents', { method: 'POST', body: { name: field.input.value, parentId } })
      await loadNoteChildren(parentId, true)
      if (parentId) state.notes.expandedFolders.add(parentId)
      await selectNoteNode(node)
      return true
    },
  })
  field.input.focus()
}

function openRenameNoteNode(node) {
  const field = formField('Название', 'text', node.name, { maxlength: 255 })
  openSheet({
    title: 'Переименовать', description: 'Ссылки @ в документах базы знаний используют стабильные номера и не ломаются при переименовании.', body: element('form', { class: 'form-grid' }, field.wrapper),
    primaryLabel: 'Сохранить имя', onPrimary: async () => {
      const updated = await api(`notes/${encodeURIComponent(node.id)}`, { method: 'PATCH', body: { name: field.input.value } })
      await loadNoteChildren(node.parentId, true)
      if (state.notes.selectedId === node.id) await selectNoteNode(updated)
      else renderShell()
      showToast('Название обновлено.')
      return true
    },
  })
  field.input.select()
}

async function copyNoteNode(node) {
  try {
    const copy = await api(`notes/${encodeURIComponent(node.id)}/copy`, { method: 'POST', body: {} })
    await loadNoteChildren(node.parentId, true)
    renderShell()
    showToast(`Создано «${copy.name}».`)
  } catch (error) { showToast(friendlyError(error), 'error') }
}

async function dropNoteNode(event, parentId) {
  event.preventDefault()
  event.stopPropagation()
  clearNoteDragState()
  const id = event.dataTransfer.getData('application/x-dsh-note-id')
  if (!id) {
    if (hasDragType(event, 'Files')) await importDroppedNotes(event.dataTransfer, parentId)
    return
  }
  const node = findCachedNote(id)
  if (!node || id === parentId || node.parentId === parentId) return
  try {
    await api(`notes/${encodeURIComponent(id)}`, { method: 'PATCH', body: { parentId } })
    await Promise.all([loadNoteChildren(node.parentId, true), loadNoteChildren(parentId, true)])
    if (state.notes.selectedId === id) state.notes.selectedNode = await api(`notes/${encodeURIComponent(id)}`)
    renderShell()
    showToast('Перемещено в целевой каталог.')
  } catch (error) { showToast(friendlyError(error), 'error') }
}

async function uploadNoteFiles(files, parentId) {
  const summary = createNoteImportSummary()
  const plans = files.flatMap(file => createNoteFilePlan(file, summary))
  if (!plans.length) return showToast('Нет файлов для загрузки, лимит одного файла — 64 MiB.', 'error')
  const transfer = beginNoteTransfer('uploading')
  if (!transfer) return
  prepareNoteTransfer(transfer, summary)
  try {
    await importNotePlans(plans, parentId, transfer)
    await loadNoteChildren(parentId, true)
    renderShell()
    completeNoteTransfer(transfer)
    showNoteImportResult(summary)
  } catch (error) {
    if (transfer.completedItems) await loadNoteChildren(parentId, true).catch(() => {})
    renderShell()
    failNoteTransfer(transfer, error)
    showToast(friendlyError(error), 'error')
  }
}

async function importDroppedNotes(dataTransfer, parentId) {
  const payload = captureNoteDropPayload(dataTransfer)
  if (!payload.entries.length) return uploadNoteFiles(payload.files, parentId)
  const transfer = beginNoteTransfer('scanning')
  if (!transfer) return
  const summary = createNoteImportSummary()
  try {
    const plans = []
    for (const entry of payload.entries) {
      const plan = await collectNoteEntry(entry, summary, transfer)
      if (plan) plans.push(plan)
    }
    if (!plans.length) {
      dismissNoteTransfer()
      showToast('Нет содержимого для загрузки, лимит одного файла — 64 MiB.', 'error')
      return
    }
    prepareNoteTransfer(transfer, summary)
    await importNotePlans(plans, parentId, transfer)
    await loadNoteChildren(parentId, true)
    if (parentId) state.notes.expandedFolders.add(parentId)
    renderShell()
    completeNoteTransfer(transfer)
    showNoteImportResult(summary)
  } catch (error) {
    await loadNoteChildren(parentId, true).catch(() => {})
    renderShell()
    failNoteTransfer(transfer, error)
    showToast(friendlyError(error), 'error')
  }
}

function createNoteImportSummary() {
  return { files: 0, folders: 0, skipped: 0, bytes: 0 }
}

function createNoteFilePlan(file, summary) {
  if (file.size > NOTE_MAX_FILE_SIZE) {
    summary.skipped += 1
    return []
  }
  summary.files += 1
  summary.bytes += file.size
  return [{ kind: 'file', name: file.name, file }]
}

function captureNoteDropPayload(dataTransfer) {
  const files = Array.from(dataTransfer?.files || [])
  const entries = Array.from(dataTransfer?.items || []).flatMap(item => {
    if (item.kind !== 'file' || typeof item.webkitGetAsEntry !== 'function') return []
    try {
      const entry = item.webkitGetAsEntry()
      return entry ? [entry] : []
    } catch {
      return []
    }
  })
  return { entries, files }
}

async function collectNoteEntry(entry, summary, transfer) {
  transfer.currentName = entry.name || ''
  transfer.scannedItems += 1
  scheduleNoteTransferSync()
  if (entry.isDirectory) {
    summary.folders += 1
    const children = []
    for (const child of await readNoteDirectoryEntries(entry)) {
      const plan = await collectNoteEntry(child, summary, transfer)
      if (plan) children.push(plan)
    }
    return { kind: 'folder', name: entry.name, children }
  }
  if (!entry.isFile) return null
  const file = await readNoteFileEntry(entry)
  return createNoteFilePlan(file, summary)[0] || null
}

async function importNotePlans(plans, parentId, transfer) {
  for (const plan of plans) {
    transfer.currentName = plan.name
    scheduleNoteTransferSync()
    if (plan.kind === 'folder') {
      const folder = await api('notes/folders', { method: 'POST', body: { name: plan.name, parentId } })
      transfer.completedItems += 1
      scheduleNoteTransferSync()
      await importNotePlans(plan.children, folder.id, transfer)
      continue
    }
    const settledBytes = transfer.loadedBytes
    await uploadNoteFile(plan.file, parentId, loaded => {
      transfer.loadedBytes = settledBytes + Math.min(loaded, plan.file.size)
      scheduleNoteTransferSync()
    })
    transfer.loadedBytes = settledBytes + plan.file.size
    transfer.completedItems += 1
    scheduleNoteTransferSync()
  }
}

async function readNoteDirectoryEntries(entry) {
  const reader = entry.createReader()
  const entries = []
  while (true) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))
    if (!batch.length) return entries
    entries.push(...batch)
  }
}

function readNoteFileEntry(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

async function uploadNoteFile(file, parentId, onProgress) {
  const params = new URLSearchParams({ name: file.name })
  if (parentId) params.set('parentId', parentId)
  return binaryUploadRequest(`notes/files?${params}`, file, {
    method: 'POST', contentType: file.type || 'application/octet-stream', onProgress,
  })
}

function beginNoteTransfer(phase) {
  if (state.notes.transfer && ['scanning', 'uploading'].includes(state.notes.transfer.phase)) {
    showToast('Уже выполняется задача импорта, подождите.', 'error')
    return null
  }
  const transfer = {
    id: String(++noteTransferSequence), phase, currentName: '', error: '',
    scannedItems: 0, completedItems: 0, totalItems: 0,
    loadedBytes: 0, totalBytes: 0, files: 0, folders: 0, skipped: 0,
  }
  state.notes.transfer = transfer
  refreshNoteTransferPanel()
  return transfer
}

function prepareNoteTransfer(transfer, summary) {
  transfer.phase = 'uploading'
  transfer.currentName = ''
  transfer.totalItems = summary.files + summary.folders
  transfer.totalBytes = summary.bytes
  transfer.files = summary.files
  transfer.folders = summary.folders
  transfer.skipped = summary.skipped
  scheduleNoteTransferSync()
}

function completeNoteTransfer(transfer) {
  if (state.notes.transfer !== transfer) return
  transfer.phase = 'complete'
  transfer.currentName = ''
  transfer.completedItems = transfer.totalItems
  transfer.loadedBytes = transfer.totalBytes
  refreshNoteTransferPanel()
  window.setTimeout(() => {
    if (state.notes.transfer === transfer && transfer.phase === 'complete') dismissNoteTransfer()
  }, 2600)
}

function failNoteTransfer(transfer, error) {
  if (state.notes.transfer !== transfer) return
  transfer.phase = 'error'
  transfer.error = friendlyError(error)
  refreshNoteTransferPanel()
}

function dismissNoteTransfer() {
  state.notes.transfer = null
  document.querySelector('.notes-transfer')?.remove()
}

function refreshNoteTransferPanel() {
  const current = document.querySelector('.notes-transfer')
  const panel = renderNoteTransfer()
  if (!panel) {
    current?.remove()
    return
  }
  if (current) current.replaceWith(panel)
  else document.querySelector('.notes-workspace')?.append(panel)
  syncNoteTransferPanel()
}

function scheduleNoteTransferSync() {
  if (noteTransferFrame) return
  noteTransferFrame = requestAnimationFrame(() => {
    noteTransferFrame = 0
    syncNoteTransferPanel()
  })
}

function syncNoteTransferPanel() {
  const transfer = state.notes.transfer
  const panel = document.querySelector('.notes-transfer')
  if (!transfer || !panel || panel.dataset.noteTransfer !== transfer.id) return
  const percent = noteTransferPercent(transfer)
  panel.dataset.state = transfer.phase
  panel.style.setProperty('--notes-transfer-progress', String(percent / 100))
  const title = panel.querySelector('.notes-transfer-title')
  const detail = panel.querySelector('.notes-transfer-detail')
  const count = panel.querySelector('.notes-transfer-count')
  const percentLabel = panel.querySelector('.notes-transfer-percent')
  const progress = panel.querySelector('.notes-transfer-track')
  if (title) title.textContent = noteTransferTitle(transfer)
  if (detail) {
    detail.textContent = noteTransferDetail(transfer)
    detail.title = transfer.currentName || ''
  }
  if (count) count.textContent = noteTransferCount(transfer)
  if (percentLabel) percentLabel.textContent = transfer.phase === 'scanning' ? 'Упорядочивание' : `${percent}%`
  if (progress) {
    if (transfer.phase === 'scanning') progress.removeAttribute('aria-valuenow')
    else progress.setAttribute('aria-valuenow', String(percent))
  }
}

function noteTransferPercent(transfer) {
  if (transfer.phase === 'complete') return 100
  const value = transfer.totalBytes > 0
    ? transfer.loadedBytes / transfer.totalBytes
    : transfer.totalItems > 0 ? transfer.completedItems / transfer.totalItems : 0
  return Math.min(transfer.phase === 'uploading' ? 99 : 100, Math.max(0, Math.round(value * 100)))
}

function noteTransferTitle(transfer) {
  if (transfer.phase === 'scanning') return 'Упорядочивание импортированного содержимого'
  if (transfer.phase === 'complete') return 'Импорт завершён'
  if (transfer.phase === 'error') return 'Импорт не завершён'
  return 'Импорт заметок'
}

function noteTransferDetail(transfer) {
  if (transfer.phase === 'error') return transfer.error || 'Во время импорта произошла ошибка'
  if (transfer.phase === 'complete') return `Записано: ${transfer.files} файлов, ${transfer.folders} папок`
  if (transfer.phase === 'scanning') return transfer.currentName || 'Чтение файлов и каталогов…'
  return transfer.currentName || 'Подготовка к записи…'
}

function noteTransferCount(transfer) {
  if (transfer.phase === 'scanning') return `Прочитано ${transfer.scannedItems} шт.`
  const count = `${transfer.completedItems} / ${transfer.totalItems} шт.`
  const bytes = transfer.totalBytes ? ` · ${formatBytes(transfer.loadedBytes)} / ${formatBytes(transfer.totalBytes)}` : ''
  const skipped = transfer.skipped ? ` · пропущено ${transfer.skipped}` : ''
  return `${count}${bytes}${skipped}`
}

function showNoteImportResult(summary) {
  const added = [summary.folders ? `${summary.folders} папок` : '', summary.files ? `${summary.files} файлов` : ''].filter(Boolean).join('、')
  const skipped = summary.skipped ? `, пропущено ${summary.skipped} файлов больше 64 МиБ` : ''
  showToast(`Добавлено ${added ? ` ${added}` : ''}${skipped}。`)
}

async function saveNoteDocument() {
  if (state.notes.titleDirty || state.notes.renaming) { showToast('Сначала завершите правку заголовка или нажмите Escape в поле заголовка, чтобы отказаться.', 'error'); return false }
  const node = state.notes.selectedNode
  if (!node || !node.editable || !state.notes.dirty) return true
  if (state.notes.saving) return false
  state.notes.saving = true
  syncNoteEditorChrome()
  const submitted = state.notes.draft
  try {
    const updated = await binaryRequest(`notes/${encodeURIComponent(node.id)}/content?expectedVersion=${state.notes.contentVersion ?? node.version}`, {
      method: 'PUT', body: new Blob([submitted], { type: node.mediaType || 'text/plain' }), contentType: node.mediaType || 'text/plain',
    })
    if (state.notes.selectedNode?.id !== node.id) return false
    state.notes.selectedNode = updated
    state.notes.content = submitted
    state.notes.contentVersion = updated.version
    state.notes.dirty = state.notes.draft !== submitted
    await loadNoteChildren(node.parentId, true)
    const size = document.querySelector('[data-note-info="size"] > span')
    const updatedAt = document.querySelector('[data-note-info="updated"] > span')
    if (size) size.textContent = formatBytes(updated.size)
    if (updatedAt) updatedAt.textContent = formatDate(updated.updatedAt)
    syncNoteEditorChrome()
    showToast('Файл сохранён.')
    return !state.notes.dirty
  } catch (error) {
    showToast(friendlyError(error), 'error')
    if (error.status === 409) void openDocumentSyncConflict()
    return false
  } finally {
    state.notes.saving = false
    syncNoteEditorChrome()
  }
}

async function openNoteHistory(node) {
  if (state.notes.selectedNode?.id === node.id && state.notes.dirty && !await saveNoteDocument()) return
  try {
    const current = state.notes.selectedNode?.id === node.id ? state.notes.selectedNode : await api(`notes/${encodeURIComponent(node.id)}`)
    if (!current?.editable) throw new Error('История страниц доступна только для редактируемых документов-заметок.')
    const versions = await api(`notes/${encodeURIComponent(node.id)}/versions?limit=100`)
    if (!versions.length) {
      showToast('У этого документа пока нет сохранённых записей для просмотра.')
      return
    }
    let modal
    const view = window.DshKnowledgeNoteHistory.createNoteHistoryView({
      versions,
      currentVersion: current.version,
      currentContent: state.notes.selectedNode?.id === node.id ? state.notes.content : '',
      loadContent: async (version, signal) => {
        const blob = await binaryRequest(`notes/${encodeURIComponent(node.id)}/versions/${version.version}/content`, {
          responseType: 'blob', accept: version.mediaType || 'text/plain', signal,
        })
        return blob.text()
      },
      renderPreview: content => renderHistoricalNotePreview(content, isMarkdownNote(current)),
      renderDiff: renderNoteHistoryDiff,
      formatDate,
      formatBytes,
      onRestore: async (version, content) => {
        const updated = await api(`notes/${encodeURIComponent(node.id)}/versions/${version.version}/restore`, {
          method: 'POST', body: { expectedVersion: current.version },
        })
        if (state.notes.selectedNode?.id === node.id) {
          state.notes.selectedNode = updated
          state.notes.content = content
          state.notes.draft = content
          state.notes.dirty = false
          await loadNoteChildren(updated.parentId, true)
        }
        modal?.close(true)
        renderShell()
        showToast(`Версия ${version.version} восстановлена как новая версия ${updated.version}.`)
      },
      onError: error => showToast(friendlyError(error), 'error'),
    })
    modal = openModal({
      title: `${current.name} · история страницы`,
      description: 'Каждое сохранение содержимого создаёт неизменяемый снимок; восстановление истории не удаляет текущую версию.',
      body: view.element,
      cancelLabel: 'Закрыть',
      onClose: () => view.destroy(),
    })
    modal.dialog.classList.add('note-history-dialog')
    modal.dialog.classList.remove('narrow')
  } catch (error) {
    showToast(friendlyError(error), 'error')
  }
}

function renderHistoricalNotePreview(content, markdown) {
  if (!markdown) return element('pre', { class: 'note-history-plain-preview', role: 'document' }, content || '(пустой документ)')
  const rendered = renderMarkdownPreview(content).cloneNode(true)
  rendered.classList.add('note-history-markdown-preview')
  rendered.querySelectorAll('a').forEach(link => {
    link.removeAttribute('href')
    link.removeAttribute('role')
    link.removeAttribute('tabindex')
    link.removeAttribute('title')
  })
  return rendered
}

function renderNoteHistoryDiff(historical, current, heading = 'Прошлая версия → текущая версия') {
  const diff = window.DshKnowledgeReview.createLineDiff(historical, current)
  const lines = window.DshKnowledgeReview.compactDiffLines(diff.lines, 3)
  return element('section', { class: 'note-history-diff', 'aria-label': 'Построчные различия между прошлой и текущей версиями' },
    element('div', { class: 'note-history-diff-summary' },
      element('strong', {}, heading),
      element('div', { class: 'diff-summary', 'aria-label': `Добавлено ${diff.additions} строк, удалено ${diff.deletions}` },
        element('span', { class: 'diff-stat additions' }, `+${diff.additions}`),
        element('span', { class: 'diff-stat deletions' }, `-${diff.deletions}`),
      ),
    ),
    diff.simplified ? element('div', { class: 'diff-notice' }, 'Содержимое большое, показан ограниченный упрощённый вид различий.') : null,
    element('div', { class: 'diff-viewer', role: 'table' },
      element('div', { class: 'diff-column-headings', role: 'row' },
        element('span', { role: 'columnheader' }, 'Старый'),
        element('span', { role: 'columnheader' }, 'Новый'),
        element('span', { 'aria-hidden': 'true' }),
        element('span', { role: 'columnheader' }, 'Текст'),
      ),
      lines.length ? lines.map(renderDiffLine) : element('div', { class: 'diff-empty' }, 'Выбранная версия совпадает с текущим содержимым.'),
    ),
  )
}

function noteDownloadButton(node, variant = 'ghost small', label = 'Скачать', attributes = {}) {
  return actionButton(label, event => { void downloadNoteFile(node, event.currentTarget) }, variant, {
    'aria-label': `Скачать ${node.name}`,
    title: `Скачать ${node.name}`,
    ...attributes,
  })
}

async function downloadNoteFile(node, button) {
  const originalLabel = button?.textContent || ''
  if (button) {
    button.disabled = true
    button.setAttribute('aria-busy', 'true')
    button.textContent = 'Скачивание'
  }
  try {
    if (state.notes.selectedNode?.id === node.id && state.notes.dirty && !await saveNoteDocument()) return
    const current = state.notes.selectedNode?.id === node.id ? state.notes.selectedNode : node
    const blob = await binaryRequest(`notes/${encodeURIComponent(current.id)}/content?download=1`, { responseType: 'blob', accept: current.mediaType || 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const anchor = element('a', { href: url, download: current.name })
    document.body.append(anchor); anchor.click(); anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    showToast(`Скачано ${current.name}.`)
  } catch (error) {
    showToast(`Ошибка скачивания: ${friendlyError(error)}`, 'error')
  } finally {
    if (button?.isConnected) {
      button.disabled = false
      button.removeAttribute('aria-busy')
      button.textContent = originalLabel
    }
  }
}

async function copyNoteReference(node) {
  try { await navigator.clipboard.writeText(noteReference(node)); showToast('Ссылка на заметку скопирована.') }
  catch { showToast('Не удалось скопировать, скопируйте номер документа вручную.', 'error') }
}

function noteShareForNode(noteId) {
  return state.notes.shares.find(share => share.noteId === noteId) || null
}

function noteShareUrl(share) {
  const apiBase = state.service.publicApiPrefix || API_BASE
  return new URL(`${apiBase.replace(/\/$/, '')}/shared/${encodeURIComponent(share.token)}`, location.href).href
}

async function openNoteShare(node) {
  if (state.notes.selectedNode?.id === node.id && state.notes.dirty && !await saveNoteDocument()) return
  try {
    let share = noteShareForNode(node.id)
    if (!share) {
      share = await api(`notes/${encodeURIComponent(node.id)}/share`, { method: 'POST' })
      state.notes.shares = [share, ...state.notes.shares.filter(item => item.noteId !== node.id)]
    }
    showNoteShareDialog(share)
  } catch (error) {
    showToast(`Не удалось создать ссылку: ${friendlyError(error)}`, 'error')
  }
}

function showNoteShareDialog(share) {
  const url = noteShareUrl(share)
  const input = Object.assign(element('input', {
    class: 'input notes-share-link-input', readonly: true, value: url,
    'aria-label': `Ссылка на «${share.node.name}»`, onFocus: event => event.currentTarget.select(),
  }), { value: url })
  let modal
  const body = element('div', { class: 'notes-share-dialog-body' },
    element('div', { class: 'notes-share-dialog-kind' }, renderNoteIcon(share.node, true), element('span', {}, element('strong', {}, share.node.name), element('small', {}, share.node.kind === 'folder' ? 'Каталог и текущие дочерние элементы доступны только для чтения' : 'Ссылка на документ только для чтения'))),
    element('label', { class: 'notes-share-link-label' }, element('span', {}, 'Ссылка для доступа'), element('div', { class: 'notes-share-link-row' }, input, actionButton('Копировать', () => copyText(url, 'Ссылка для доступа скопирована.'), 'primary small'))),
    element('p', { class: 'notes-share-dialog-note' }, 'Содержимое по ссылке обновляется вместе с исходной заметкой. Доступ получит любой, у кого есть ссылка; после остановки общего доступа ссылка сразу перестанет работать.'),
    element('div', { class: 'notes-share-dialog-danger' },
      element('span', {}, element('strong', {}, 'Остановить общий доступ'), element('small', {}, 'Исходный документ или каталог не удаляется.')),
      actionButton('Остановить общий доступ', () => confirmRemoveNoteShare(share, () => modal?.close(true)), 'danger small'),
    ),
  )
  modal = openModal({
    title: 'Поделиться заметкой',
    description: 'Создать отдельную ссылку доступа только для чтения',
    body,
    cancelLabel: 'Готово',
    className: 'notes-share-dialog',
  })
}

function confirmRemoveNoteShare(share, afterRemove) {
  openConfirm({
    title: `Прекратить доступ к «${share.node.name}»?`,
    message: 'Действующие ссылки общего доступа сразу перестанут работать, содержимое исходной заметки не будет удалено.',
    confirmLabel: 'Остановить общий доступ',
    danger: true,
    onConfirm: async () => {
      await api(`notes/${encodeURIComponent(share.noteId)}/share`, { method: 'DELETE' })
      state.notes.shares = state.notes.shares.filter(item => item.noteId !== share.noteId)
      afterRemove?.()
      renderShell()
      showToast('Общий доступ остановлен.')
    },
  })
}

async function openSharedNoteOriginal(share) {
  if (state.notes.dirty && !await saveNoteDocument()) return
  state.view = 'notes'
  await selectNoteNode(share.node)
}

async function confirmDeleteNoteNode(node) {
  try {
    const references = await api(`notes/${encodeURIComponent(node.id)}/references`)
    if (references.length) {
      const names = references.slice(0, 4).map(item => `“${item.documentTitle}”`).join('、')
      return openModal({
        title: 'Всё ещё используется документами базы знаний', description: node.name,
        body: element('p', {}, `${names}${references.length > 4 ? `и ещё ${references.length} документов` : ''} всё ещё ссылаются на это. Сначала уберите ссылки, потом удаляйте.`),
        cancelLabel: 'Понятно',
      })
    }
    openConfirm({
      title: `Удалить «${node.name}»?`,
      message: node.kind === 'folder' ? 'Каталог и все его подкаталоги и файлы будут удалены навсегда.' : 'Этот документ будет удалён безвозвратно, отменить это нельзя.',
      confirmLabel: 'Удалить навсегда', danger: true,
      onConfirm: async () => {
        await api(`notes/${encodeURIComponent(node.id)}`, { method: 'DELETE' })
        await loadNoteShares()
        await loadNoteChildren(node.parentId, true)
        if (state.notes.selectedId === node.id || state.notes.breadcrumbs.some(parent => parent.id === node.id)) clearNoteSelection()
        renderShell(); showToast('Удалено.')
      },
    })
  } catch (error) { showToast(friendlyError(error), 'error') }
}

function noteWorkspaceDragEnter(event) {
  if (!hasDragType(event, 'Files')) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  event.currentTarget.dataset.dropActive = 'true'
}

function noteWorkspaceDragLeave(event) {
  if (event.currentTarget.contains(event.relatedTarget)) return
  clearNoteDragState()
}

function activateNoteFolderDropTarget(event, node) {
  if (node.kind !== 'folder') return
  const hasFiles = hasDragType(event, 'Files')
  if (!hasFiles && !hasDragType(event, 'application/x-dsh-note-id')) return
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer) event.dataTransfer.dropEffect = hasFiles ? 'copy' : 'move'
  const workspace = document.querySelector('.notes-workspace')
  if (workspace) workspace.dataset.dropActive = 'false'
  document.querySelectorAll('.notes-tree-item[data-drop-target="true"]').forEach(target => {
    if (target !== event.currentTarget) target.dataset.dropTarget = 'false'
  })
  event.currentTarget.dataset.dropTarget = 'true'
}

function hasDragType(event, type) {
  return Array.from(event.dataTransfer?.types || []).includes(type)
}

function clearNoteDragState() {
  const workspace = document.querySelector('.notes-workspace')
  if (workspace) workspace.dataset.dropActive = 'false'
  document.querySelectorAll('.notes-tree-item[data-drop-target="true"]').forEach(node => { node.dataset.dropTarget = 'false' })
  document.querySelectorAll('.notes-tree-item[data-dragging="true"]').forEach(node => { node.dataset.dragging = 'false' })
}

function installDragRecovery() {
  const clear = () => {
    clearNoteDragState()
    clearKnowledgeDocumentDragState()
  }
  window.addEventListener('drop', clear, true)
  window.addEventListener('dragend', clear, true)
  window.addEventListener('blur', clear)
  document.addEventListener('dragleave', event => {
    if (event.relatedTarget === null) clear()
  }, true)
}

function noteReference(node) {
  const label = node.name.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]')
  return `@[${label}](note://${node.id})`
}

function noteMediaKind(node) {
  if (node.kind === 'folder') return 'folder'
  if (node.kind === 'document' || node.mediaType?.startsWith('text/')) return 'text'
  if (node.mediaType?.startsWith('image/')) return 'image'
  if (node.mediaType === 'application/pdf') return 'pdf'
  return 'file'
}

function shortNoteId(id) {
  return `${id.slice(0, 11)}…${id.slice(-5)}`
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KiB`
  return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MiB`
}

function renderCandidates() {
  const statuses = [['pending', 'На проверке'], ['approved', 'Принято'], ['rejected', 'Отклонено']]
  const pendingCount = state.stats?.candidates.pending ?? state.candidates.filter(candidate => candidate.status === 'pending').length
  return element('section', { class: 'candidate-page', 'aria-labelledby': 'candidates-heading' },
    element('div', { class: 'section-heading' },
      element('div', {}, element('h2', { id: 'candidates-heading' }, 'Кандидаты от ИИ'), element('p', {}, 'Запись с проверкой, выводы модели, результаты с низкой уверенностью и конфликты ожидают здесь подтверждения; напрямую записываются только результаты с высокой уверенностью и явными доказательствами.')),
      element('div', { class: 'candidate-heading-actions' },
        state.candidateStatus === 'pending' ? actionButton(state.candidateBatchRunning ? 'Выполняется через…' : 'Одобрить всё', openBulkApprove, 'primary', {
          disabled: state.candidateBatchRunning || pendingCount === 0,
          title: pendingCount === 0 ? 'Сейчас нет кандидатов на проверку' : 'Новые и безопасно объединяемые элементы одобряются партиями, конфликтные остаются',
          'aria-busy': String(state.candidateBatchRunning),
        }) : null,
        element('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Статус кандидата' }, statuses.map(([value, label]) => element('button', {
          type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(state.candidateStatus === value),
          onClick: async () => { state.candidateStatus = value; await navigate('candidates') },
        }, label, state.stats ? ` ${state.stats.candidates[value]}` : ''))),
      ),
    ),
    state.candidates.length ? element('div', { class: 'candidate-list' }, state.candidates.map(renderCandidateCard))
      : emptyState(`Нет кандидатов: ${STATUS_LABELS[state.candidateStatus]}`, state.candidateStatus === 'pending' ? 'После завершения нового диалога плагин в фоне определит, появились ли кандидаты.' : 'Переключите другой статус, чтобы увидеть историю.'),
  )
}

function renderCandidateCard(candidate) {
  const pending = candidate.status === 'pending'
  const target = candidate.targetId ? state.candidateTargets.get(candidate.targetId) : null
  const targetAvailable = candidate.action === 'create' || Boolean(target && (candidate.change?.kind === 'group'
    ? target.version === candidate.change.baseVersion
    : candidate.change?.kind !== 'finalize' || target.documentState === 'open' && target.version === candidate.change.baseVersion))
  const action = candidatePrimaryAction(candidate)
  return element('article', { class: 'candidate' },
    element('div', { class: 'candidate-header' },
      element('div', {},
        element('div', {},
          badge(knowledgeBaseName(candidate.draft.knowledgeBaseId)), ' ',
          badge(ACTION_LABELS[candidate.action], candidate.action === 'conflict' ? 'warning' : 'accent'), ' ',
          candidate.change?.kind === 'finalize' ? badge(candidate.change.state === 'resolved' ? 'Отметить как решённое' : 'Отметить сбор завершённым', 'warning') : candidate.change?.kind === 'revise' ? badge('Правка текста', 'warning') : candidate.change?.kind === 'append' ? badge('Дополнение содержимого') : null, ' ',
          badge(TYPE_LABELS[candidate.draft.type]), ' ',
          candidate.draft.source?.evidence ? badge(EVIDENCE_LABELS[candidate.draft.source.evidence] || candidate.draft.source.evidence) : null),
        element('h3', {}, candidate.draft.title),
      ),
      badge(STATUS_LABELS[candidate.status], candidate.status === 'approved' ? 'success' : candidate.status === 'rejected' ? 'danger' : 'warning'),
    ),
    element('div', { class: 'candidate-body' },
      renderCandidateDiff(candidate, target),
      element('div', { class: 'candidate-reason' },
        element('section', {},
          element('strong', {}, 'Место записи'),
          element('span', { class: 'candidate-target' }, candidate.action === 'create'
            ? `Создать «${candidate.draft.title}»`
            : target ? `${candidate.change?.kind === 'group' ? 'Смена группы: ' : candidate.change?.kind === 'finalize' ? 'Завершить документ' : candidate.change?.kind === 'revise' ? 'Исправить' : 'Дополнить'}«${target.title}»` : `Цель ${candidate.targetId || 'недоступна'}`),
        ),
        renderCandidateMetadataChanges(candidate, target),
        element('section', {},
          element('strong', {}, 'Основание решения модели'),
          element('p', {}, candidate.reason || 'Пояснение к решению не указано'),
        ),
        candidate.reviewNote ? element('section', {},
          element('strong', {}, 'Примечание проверки'),
          element('p', {}, candidate.reviewNote),
        ) : null,
      ),
    ),
    element('div', { class: 'candidate-footer' },
      element('small', {}, `${scopeLabel(candidate.draft.scope)} · уверенность ${Math.round(candidate.draft.confidence * 100)}%${candidate.targetId ? ` · цель ${candidate.targetId}` : ''} · ${formatDate(candidate.createdAt)}`),
      pending ? element('div', { class: 'candidate-actions' },
        actionButton('Отклонить', () => reviewCandidate(candidate, 'reject'), 'danger small'),
        ['finalize', 'group'].includes(candidate.change?.kind) ? null : actionButton(action.editLabel, () => openEntryEditor(undefined, candidate), 'small', {
          disabled: !targetAvailable,
          title: targetAvailable ? action.editLabel : 'Целевой документ недоступен, безопасно править объединённый результат нельзя',
        }),
        action.manualOnly ? null : actionButton(action.label, () => reviewCandidate(candidate, 'approve', action.resolution), 'primary small', {
          disabled: !targetAvailable,
          title: targetAvailable ? action.label : 'Целевой документ недоступен: обновите и проверьте заново',
        }),
      ) : null,
    ),
  )
}

function renderCandidateDiff(candidate, target) {
  if (candidate.change?.kind === 'group') {
    return element('section', { class: 'candidate-change' },
      element('strong', {}, 'Изменить группу документа'),
      element('p', {}, `${target?.group || 'без группы'} → ${candidate.change.group}`),
      element('p', {}, 'Меняется только группа; текст, теги, путь и статус завершения остаются прежними.'),
      target && target.version !== candidate.change.baseVersion ? element('p', { role: 'alert' }, 'Версия документа изменилась: отклоните и отправьте изменение группы заново.') : null,
    )
  }
  if (candidate.change?.kind === 'finalize') {
    return element('section', { class: 'candidate-change', 'aria-label': 'Предпросмотр закрытия документа' },
      element('strong', {}, `${target?.title || candidate.draft.title} · ${candidate.change.state === 'resolved' ? 'отметить решённым' : 'отметить завершённым'}`),
      element('p', {}, `Базовая версия: ${candidate.change.baseVersion} · текущая: ${target?.version ?? 'недоступна'}`),
      element('p', {}, `Подтверждение пользователя: ${candidate.change.confirmation}`),
      element('p', {}, `Вывод: ${candidate.change.note}`),
      target && candidate.status === 'pending' && (target.documentState !== 'open' || target.version !== candidate.change.baseVersion)
        ? element('p', { role: 'alert' }, 'Документ изменился: отклоните этот кандидат, затем прочитайте заново и подтвердите.') : null,
      element('p', {}, 'Текст остаётся без изменений, запись целиком остановится; чтобы продолжить дополнять, снова откройте его в документе.'),
    )
  }
  if (candidate.action !== 'create' && !target) {
    return element('section', { class: 'candidate-change candidate-change-unavailable', role: 'alert' },
      element('strong', {}, 'Не удалось создать предпросмотр изменений'),
      element('p', {}, 'Целевой документ временно недоступен. Чтобы не перезаписать вслепую, обновите и подтвердите текущую версию, затем проверьте.'),
    )
  }
  const review = window.DshKnowledgeReview.createReviewChange(candidate.action, target?.body || '', candidate.draft.body, candidate.change?.kind)
  const title = candidate.action === 'create'
    ? 'Содержимое нового документа'
    : candidate.action === 'conflict' ? 'Предпросмотр обработки конфликтов' : candidate.change?.kind === 'revise' ? 'Предпросмотр правки текста' : 'Предпросмотр дополнения содержимого'
  const targetLabel = candidate.action === 'create'
    ? candidate.draft.title
    : `${target.title} · текущая версия ${target.version}`
  return element('section', { class: `candidate-change is-${candidate.action}`, 'aria-label': title },
    element('div', { class: 'candidate-change-heading' },
      element('div', {}, element('strong', {}, title), element('small', {}, targetLabel)),
      element('div', { class: 'diff-summary', 'aria-label': `Добавлено ${review.diff.additions}, удалено ${review.diff.deletions}, без изменений ${review.diff.unchanged}` },
        element('span', { class: 'diff-stat additions' }, `+${review.diff.additions}`),
        element('span', { class: 'diff-stat deletions' }, `-${review.diff.deletions}`),
        element('span', { class: 'diff-stat unchanged' }, `${review.diff.unchanged} без изменений`),
      ),
    ),
    review.diff.simplified ? element('div', { class: 'diff-notice' }, 'Документ сильно изменился, используется упрощённый вид различий. На объединённое содержимое это не влияет.') : null,
    element('div', { class: 'diff-viewer', role: 'table', 'aria-label': `${title} — построчные различия` },
      element('div', { class: 'diff-column-headings', role: 'row' },
        element('span', { role: 'columnheader' }, 'Старый'),
        element('span', { role: 'columnheader' }, 'Новый'),
        element('span', { 'aria-hidden': 'true' }),
        element('span', { role: 'columnheader' }, 'Текст'),
      ),
      review.displayLines.length
        ? review.displayLines.map(renderDiffLine)
        : element('div', { class: 'diff-empty' }, 'Текст пуст, записывать нечего.'),
    ),
  )
}

function renderDiffLine(line) {
  if (line.kind === 'omitted') {
    return element('div', { class: 'diff-line is-omitted', role: 'row', 'aria-label': `${line.count} строк без изменений, свёрнуто` },
      element('span', { class: 'diff-line-number', 'aria-hidden': 'true' }),
      element('span', { class: 'diff-line-number', 'aria-hidden': 'true' }),
      element('span', { class: 'diff-marker', 'aria-hidden': 'true' }, '…'),
      element('span', { class: 'diff-omitted-copy' }, `${line.count} строк без изменений`),
    )
  }
  const marker = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '
  const label = line.kind === 'add'
    ? `Добавлена строка ${line.newLine}`
    : line.kind === 'remove' ? `Удалена строка ${line.oldLine}` : `Строка без изменений ${line.oldLine}`
  return element('div', { class: `diff-line is-${line.kind}`, role: 'row', 'aria-label': label },
    element('span', { class: 'diff-line-number', role: 'cell' }, line.oldLine || ''),
    element('span', { class: 'diff-line-number', role: 'cell' }, line.newLine || ''),
    element('span', { class: 'diff-marker', role: 'cell', 'aria-hidden': 'true' }, marker),
    element('code', { class: 'diff-code', role: 'cell' }, line.text || ' '),
  )
}

function renderCandidateMetadataChanges(candidate, target) {
  if (candidate.change?.kind === 'finalize') return null
  if (!target || candidate.action === 'create') return null
  const changes = []
  if (target.title !== candidate.draft.title) changes.push(`Заголовок: ${target.title} → ${candidate.draft.title}`)
  const addedTags = candidate.draft.tags.filter(tag => !target.tags.includes(tag))
  if (addedTags.length) changes.push(`Новые теги: ${addedTags.join(', ')}`)
  if (candidate.draft.confidence > target.confidence) {
    changes.push(`Уверенность: ${Math.round(target.confidence * 100)}% → ${Math.round(candidate.draft.confidence * 100)}%`)
  }
  if (!changes.length) return null
  return element('section', { class: 'candidate-metadata' },
    element('strong', {}, 'Изменение свойств'),
    element('ul', {}, changes.map(change => element('li', {}, change))),
  )
}

function candidatePrimaryAction(candidate) {
  if (candidate.change?.kind === 'group') return { label: 'Подтвердить изменение группы', manualOnly: candidate.action === 'conflict' }
  if (candidate.change?.kind === 'finalize') return { label: candidate.change.state === 'resolved' ? 'Подтвердить отметку «решено»' : 'Подтвердить завершение сбора', manualOnly: candidate.action === 'conflict' }
  if (candidate.action === 'create') return { label: 'Записать в новый документ', editLabel: 'Записать после редактирования' }
  if (candidate.action === 'conflict' && candidate.change?.kind !== 'revise') {
    return { label: 'Требуется решить вручную', editLabel: 'Решить вручную', resolution: 'merge', manualOnly: true }
  }
  if (candidate.action === 'conflict') return {
    label: candidate.change?.kind === 'revise' ? 'Применить конфликтную правку' : 'Подтвердить дополнение',
    editLabel: 'Решить вручную', resolution: 'merge',
  }
  if (candidate.change?.kind === 'revise') return { label: 'Применить правку', editLabel: 'Редактировать результат правки' }
  return { label: 'Дополнить документ', editLabel: 'Дополнить после редактирования' }
}

function renderTokens() {
  const apiAddress = new URL(state.service.publicApiPrefix, location.origin).href.replace(/\/$/, '')
  return element('section', { 'aria-labelledby': 'tokens-heading' },
    element('div', { class: 'api-access-card' },
      element('div', { class: 'api-access-heading' },
        element('div', {}, element('strong', {}, 'API удалённой базы знаний'), element('p', {}, state.service.publicApiEnabled
          ? 'Другие клиенты DSH могут подключиться по указанному ниже адресу и токену клиента.'
          : 'Сейчас управление возможно только на этом устройстве; другие клиенты DSH смогут подключиться после включения.')),
        badge(state.service.publicApiEnabled ? 'Открыто' : 'Закрыто', state.service.publicApiEnabled ? 'success' : 'warning'),
      ),
      element('label', { class: 'api-address-label', for: 'knowledge-public-api-address' }, 'Адрес сервера, указанный клиентом'),
      element('div', { class: 'api-address-row' },
        Object.assign(element('input', { id: 'knowledge-public-api-address', class: 'input', readonly: true, value: apiAddress }), { value: apiAddress }),
        actionButton('Копировать адрес', () => copyText(apiAddress, 'Адрес API скопирован.'), 'small'),
      ),
      element('div', { class: 'api-access-actions' },
        element('small', {}, state.service.publicApiEnabled ? 'После отключения существующие клиенты сразу потеряют связь; локальное управление не затронуто.' : 'После включения удалённого API создайте отдельный токен для каждого клиента.'),
        actionButton(state.service.publicApiEnabled ? 'Отключить удалённый API' : 'Включить удалённый API', togglePublicApi, state.service.publicApiEnabled ? 'danger small' : 'primary small'),
      ),
    ),
    element('div', { class: 'section-heading' },
      element('div', {}, element('h2', { id: 'tokens-heading' }, 'Токен доступа клиента'), element('p', {}, 'Выдавайте другим клиентам DSH минимально необходимые права; исходный токен показывается только один раз.')),
      actionButton('+ Создать токен', openTokenCreator, 'primary'),
    ),
    element('div', { class: 'panel' }, element('div', { class: 'panel-body' },
      state.tokens.length ? element('div', { class: 'token-list' }, state.tokens.map(renderTokenRow)) : compactEmpty('Пока нет токенов доступа'),
    )),
  )
}

function renderTokenRow(token) {
  const revoked = Boolean(token.revokedAt)
  return element('article', { class: 'token-row' },
    element('div', {},
      element('strong', {}, token.name, ' ', revoked ? badge('Отозвано', 'danger') : badge('Действительно', 'success')),
      element('div', { class: 'permissions' }, token.permissions.map(permission => badge(permission))),
      element('small', {}, `Создан ${formatDate(token.createdAt)}${token.lastUsedAt ? ` · последнее использование ${formatDate(token.lastUsedAt)}` : ' · ещё не использовался'}`),
    ),
    revoked
      ? actionButton('Удалить навсегда', () => confirmDeleteToken(token), 'danger small')
      : actionButton('Отозвать', () => confirmRevokeToken(token), 'danger small'),
  )
}

async function copyText(value, successMessage) {
  try { await navigator.clipboard.writeText(value); showToast(successMessage) } catch { showToast('Не удалось скопировать, выберите содержимое вручную.', 'error') }
}

function togglePublicApi() {
  const enabling = !state.service.publicApiEnabled
  openConfirm({
    title: enabling ? 'Включить удалённый API базы знаний?' : 'Отключить удалённый API базы знаний?',
    message: enabling
      ? 'После включения другие клиенты DSH с действующим токеном смогут подключиться к этой центральной базе знаний.'
      : 'После отключения все удалённые клиенты сразу отключатся; локальная база знаний и панель управления не затронуты.',
    confirmLabel: enabling ? 'Подтвердить включение' : 'Подтвердить закрытие', danger: !enabling,
    onConfirm: async () => {
      state.service = await api('service', { method: 'PUT', body: { publicApiEnabled: enabling } })
      showToast(enabling ? 'Удалённый API включён.' : 'Удалённый API отключён.')
      renderShell()
    },
  })
}

function emptyState(title, description, actionLabel, action) {
  return element('div', { class: 'empty-state' }, element('div', {}, element('strong', {}, title), element('p', {}, description), actionLabel ? actionButton(actionLabel, action, 'primary') : null))
}

function selectControl(label, options, current, onChange) {
  const select = element('select', { class: 'select', 'aria-label': label, onChange: (event) => onChange(event.target.value) },
    options.map(option => element('option', { value: option.value, selected: option.value === current }, option.label)))
  return select
}

function knowledgeBaseName(id) {
  return state.knowledgeBases.find(base => base.id === id)?.name || id || 'База знаний по умолчанию'
}

function parseTags(value) {
  return [...new Set(value.split(/[,，]/).map(tag => tag.trim().toLowerCase()).filter(Boolean))]
}

async function openKnowledgeBaseEditor(base) {
  await loadModelCatalog()
  const source = base || { name: '', description: '', defaultTags: [], extractionInstructions: '', writebackPolicy: 'conservative' }
  const form = element('form', { class: 'form-grid' })
  const name = formField('Название', 'input', source.name, { required: true, maxlength: 100, placeholder: 'Например: стандарты проекта' })
  const group = formField('Группа', 'input', source.group || '', { id: 'knowledge-base-group', maxlength: 64, placeholder: 'Пусто — без группы; можно ввести название новой группы', list: 'knowledge-base-group-options' })
  group.wrapper.querySelector('label').htmlFor = group.input.id
  const groupOptions = element('datalist', { id: 'knowledge-base-group-options' },
    [...new Set(state.knowledgeBases.map(item => item.group).filter(Boolean))].sort().map(value => element('option', { value })))
  const description = formField('Запись по совпадению с описанием', 'textarea', source.description, { maxlength: 2000, placeholder: 'Опишите, какие диалоги относятся к этой базе. Например: записывать только архитектурные решения и правила развёртывания проекта dsh-knowledge' })
  const tags = formField('Теги по умолчанию', 'input', source.defaultTags.join(', '), { placeholder: 'project-rule, backend' })
  const instructions = formField('Требования извлечения', 'textarea', source.extractionInstructions, { maxlength: 4000, placeholder: 'Например: включать только подтверждённые проектные договорённости, пригодные для повторного использования между сессиями' })
  const policy = selectField('Стратегия записи', [
    { value: 'conservative', label: 'Строгий (прямая запись при высокой уверенности)' },
    { value: 'proactive', label: 'Активный (охотнее сохраняет знания)' },
  ], source.writebackPolicy || 'conservative')
  const dedicatedModel = element('input', {
    type: 'checkbox',
    checked: Boolean(source.writebackProvider && source.writebackModel),
  })
  const route = modelRouteFields(source.writebackProvider || '', source.writebackModel || '')
  const routeToggle = element('label', { class: 'check-option span-2' }, dedicatedModel,
    element('span', {},
      element('strong', {}, 'Эта база знаний использует отдельную модель для записи'),
      element('small', {}, 'Если не задано, сначала используется локальная переопределяющая настройка; если и она не задана — модель текущей сессии.'),
    ))
  const syncRouteAvailability = () => {
    route.provider.input.disabled = route.model.input.disabled = !dedicatedModel.checked
    route.provider.input.required = route.model.input.required = dedicatedModel.checked
  }
  dedicatedModel.addEventListener('change', syncRouteAvailability)
  syncRouteAvailability()
  for (const field of [name, description, tags, instructions]) field.wrapper.classList.add('span-2')
  form.append(
    name.wrapper, group.wrapper, groupOptions, description.wrapper, tags.wrapper, instructions.wrapper, policy.wrapper,
    routeToggle, route.provider.wrapper, route.model.wrapper,
  )
  openSheet({
    title: base ? 'Редактировать базу знаний' : 'Создать базу знаний',
    description: 'Описание соответствия сначала определяет, относится ли диалог к этой базе; требования к отбору затем задают, что нужно включать.',
    body: form,
    primaryLabel: base ? 'Сохранить изменения' : 'Создать',
    onPrimary: async () => {
      if (!form.reportValidity()) return false
      const draft = {
        name: name.input.value.trim(),
        group: group.input.value.trim(),
        description: description.input.value.trim(),
        defaultTags: parseTags(tags.input.value),
        extractionInstructions: instructions.input.value.trim(),
        writebackPolicy: policy.input.value,
        ...(dedicatedModel.checked ? {
          writebackProvider: route.provider.input.value,
          writebackModel: route.model.input.value,
        } : {}),
      }
      if (base) await api(`knowledge-bases/${encodeURIComponent(base.id)}`, { method: 'PUT', body: { draft } })
      else await api('knowledge-bases', { method: 'POST', body: { draft } })
      showToast(base ? 'База знаний обновлена.' : 'База знаний создана, теперь её можно подключить к проекту или сессии.')
      await navigate('bases')
      return true
    },
  })
  name.input.focus()
}

function openBulkMountEditor() {
  const manager = state.mountManager
  const targetId = manager.targetKind === 'project' ? state.mountContext.projectId : state.mountContext.sessionId
  const bases = sortKnowledgeBasesByGroup(state.knowledgeBases.filter(base => base.status === 'active' && manager.selectedIds.has(base.id)))
  if (!targetId || bases.length === 0) return
  const recall = element('input', { type: 'checkbox', checked: true })
  const writeMode = selectField('Способ записи', [
    { value: 'none', label: 'Только извлечение (без отбора и записи)' },
    { value: 'audit', label: 'Запись с проверкой (рекомендуется)' },
    { value: 'direct', label: 'Прямая запись (обычные результаты применяются автоматически; конфликты ждут проверки)' },
  ], 'audit')
  const includeTags = formField('Обязательные теги', 'input', '', { placeholder: 'Необязательно, через запятую' })
  const excludeTags = formField('Исключаемые теги', 'input', '', { placeholder: 'Необязательно, через запятую' })
  const form = element('form', { class: 'form-grid' },
    element('div', { class: 'selection-summary span-2' },
      element('strong', {}, `Будет подключено баз: ${bases.length}`),
      element('p', {}, bases.slice(0, 8).map(knowledgeBasePathLabel).join('、'), bases.length > 8 ? ` и ещё ${bases.length}` : ''),
    ),
    element('label', { class: 'check-option' }, recall, element('span', {}, element('strong', {}, 'Включить извлечение'), element('small', {}, 'Перед ответом искать в выбранной базе знаний.'))),
    writeMode.wrapper,
    includeTags.wrapper,
    excludeTags.wrapper,
  )
  openSheet({
    title: `Подключить к ${manager.targetKind === 'project' ? 'проекту' : 'сессии'}`,
    description: targetId,
    body: form,
    primaryLabel: `Подключено ${bases.length}`,
    onPrimary: async () => {
      const include = parseTags(includeTags.input.value)
      const exclude = parseTags(excludeTags.input.value)
      if (include.some(tag => exclude.includes(tag))) {
        showToast('Один и тот же тег нельзя одновременно включить и исключить.', 'error')
        return false
      }
      await api('mounts/bulk', { method: 'POST', body: {
        upserts: bases.map(base => ({
          targetKind: manager.targetKind,
          targetId,
          knowledgeBaseId: base.id,
          enabled: true,
          recallEnabled: recall.checked,
          writeMode: writeMode.input.value,
          includeTags: include,
          excludeTags: exclude,
          extractionInstructions: '',
        })),
        deleteIds: [],
      } })
      manager.selectedIds.clear()
      showToast(`Подключено баз: ${bases.length}.`)
      await navigate('bases')
      return true
    },
  })
}

async function bulkRemoveMounts() {
  const manager = state.mountManager
  const targetId = manager.targetKind === 'project' ? state.mountContext.projectId : state.mountContext.sessionId
  const explicit = state.mounts.filter(mount =>
    mount.targetKind === manager.targetKind
    && mount.targetId === targetId
    && manager.selectedIds.has(mount.knowledgeBaseId))
  if (explicit.length === 0) {
    showToast(manager.targetKind === 'session' ? 'У выбранной базы знаний нет переопределений сеанса, восстанавливать нечего.' : 'У выбранной базы знаний нет подключений проекта.')
    return
  }
  try {
    await api('mounts/bulk', { method: 'POST', body: { upserts: [], deleteIds: explicit.map(mount => mount.id) } })
    manager.selectedIds.clear()
    showToast(manager.targetKind === 'session' ? `Восстановлено наследование проекта для баз: ${explicit.length}.` : `Отключено подключений проекта: ${explicit.length}.`)
    await navigate('bases')
  } catch (error) {
    showToast(friendlyError(error), 'error')
  }
}

function openMountEditor(base, targetKind, targetId, explicit, inherited) {
  const source = explicit || inherited || {
    enabled: true, recallEnabled: true, writeMode: 'audit', includeTags: [], excludeTags: [], extractionInstructions: '',
  }
  const enabled = element('input', { type: 'checkbox', checked: source.enabled })
  const recall = element('input', { type: 'checkbox', checked: source.recallEnabled })
  const writeMode = selectField('Способ записи', [
    { value: 'none', label: 'Только извлечение (без отбора и записи)' },
    { value: 'audit', label: 'Запись с проверкой (сначала в очередь проверки)' },
    { value: 'direct', label: 'Прямая запись (обычные результаты применяются автоматически; конфликты ждут проверки)' },
  ], source.writeMode)
  const includeTags = formField('Обязательные теги', 'input', source.includeTags.join(', '), { placeholder: 'Например: project-rule' })
  const excludeTags = formField('Исключаемые теги', 'input', source.excludeTags.join(', '), { placeholder: 'Например: personal, temporary' })
  const instructions = formField('Дополнительные требования извлечения для этого подключения', 'textarea', source.extractionInstructions, { maxlength: 4000, placeholder: 'Может быть строже правил базы знаний по умолчанию' })
  const form = element('form', { class: 'form-grid' },
    element('label', { class: 'check-option span-2' }, enabled, element('span', {}, element('strong', {}, 'Включить это подключение'), element('small', {}, 'После отключения в текущей области нет извлечения, отбора и записи.'))),
    element('label', { class: 'check-option' }, recall, element('span', {}, element('strong', {}, 'Включить извлечение'), element('small', {}, 'Перед ответом искать только в этой базе.'))),
    writeMode.wrapper,
    includeTags.wrapper,
    excludeTags.wrapper,
    instructions.wrapper,
  )
  instructions.wrapper.classList.add('span-2')
  if (targetKind === 'session' && !explicit && inherited) {
    form.prepend(element('div', { class: 'context-warning span-2' }, 'Сейчас эта сессия наследует настройки проекта. После сохранения будет создана отдельная переопределяющая настройка сессии.'))
  }
  if (explicit) {
    form.append(element('div', { class: 'mount-delete span-2' },
      element('span', { class: 'field-hint' }, targetKind === 'session' ? 'После удаления переопределения сессии снова наследуется конфигурация проекта.' : 'После удаления проект больше не подключает эту базу.'),
      actionButton('Удалить текущую конфигурацию', async () => {
        try {
          await api(`mounts/${encodeURIComponent(explicit.id)}`, { method: 'DELETE' })
          document.querySelector('.dialog-backdrop')?.remove()
          showToast(targetKind === 'session' ? 'Переопределение сессии удалено, восстановлено наследование проекта.' : 'Подключение проекта удалено.')
          await navigate('bases')
        } catch (error) { showToast(friendlyError(error), 'error') }
      }, 'danger small'),
    ))
  }
  const updateAvailability = () => {
    for (const input of [recall, writeMode.input, includeTags.input, excludeTags.input, instructions.input]) input.disabled = !enabled.checked
  }
  enabled.addEventListener('change', updateAvailability)
  updateAvailability()
  openSheet({
    title: `${targetKind === 'project' ? 'Проект' : 'Сессия'} · ${knowledgeBasePathLabel(base)}`,
    description: targetId,
    body: form,
    primaryLabel: 'Сохранить подключение',
    onPrimary: async () => {
      const include = parseTags(includeTags.input.value)
      const exclude = parseTags(excludeTags.input.value)
      if (include.some(tag => exclude.includes(tag))) {
        showToast('Один и тот же тег нельзя одновременно включить и исключить.', 'error')
        return false
      }
      await api('mounts', { method: 'POST', body: { draft: {
        targetKind, targetId, knowledgeBaseId: base.id,
        enabled: enabled.checked,
        recallEnabled: enabled.checked && recall.checked,
        writeMode: enabled.checked ? writeMode.input.value : 'none',
        includeTags: include,
        excludeTags: exclude,
        extractionInstructions: instructions.input.value.trim(),
      } } })
      showToast(enabled.checked ? 'Настройки подключения сохранены.' : 'Эта база знаний закрыта в текущей области.')
      await navigate('bases')
      return true
    },
  })
}

function confirmArchiveKnowledgeBase(base) {
  openConfirm({
    title: `Архивировать «${base.name}»?`,
    message: 'После архивации все подключения закроются автоматически, знания сохранятся, но больше не будут участвовать в извлечении и записи.',
    confirmLabel: 'Подтвердить архивацию', danger: true,
    onConfirm: async () => {
      await api(`knowledge-bases/${encodeURIComponent(base.id)}/archive`, { method: 'POST' })
      showToast('База знаний заархивирована, связанные подключения закрыты.')
      await navigate('bases')
    },
  })
}

function confirmRestoreKnowledgeBase(base) {
  openConfirm({
    title: `Восстановить «${base.name}»?`,
    message: 'После восстановления базу знаний можно снова подключить; подключения, закрытые при архивации, автоматически не откроются.',
    confirmLabel: 'Подтвердить восстановление', danger: false,
    onConfirm: async () => {
      await api(`knowledge-bases/${encodeURIComponent(base.id)}/restore`, { method: 'POST' })
      showToast('База знаний восстановлена, подключения можно настроить заново.')
      await navigate('bases')
    },
  })
}

function confirmDeleteKnowledgeBase(base) {
  const confirmation = formField('Введите название базы знаний для подтверждения', 'input', '', {
    required: true, autocomplete: 'off', placeholder: base.name,
    'aria-describedby': 'delete-base-warning',
  })
  const form = element('form', {},
    element('div', { id: 'delete-base-warning', class: 'context-warning' },
      'Это действие нельзя отменить. Все знания, история версий, кандидаты, подключения и созданные документы в базе знаний будут удалены навсегда.'),
    confirmation.wrapper,
  )
  confirmation.wrapper.classList.add('delete-base-confirmation')
  openModal({
    title: `Удалить навсегда «${base.name}»?`,
    description: 'Безвозвратно удалить можно только архивную базу знаний.',
    body: form,
    primaryLabel: 'Удалить навсегда',
    primaryVariant: 'danger',
    onPrimary: async () => {
      if (!form.reportValidity()) return false
      if (confirmation.input.value.trim() !== base.name) {
        showToast('Введённое название базы знаний не совпадает.', 'error')
        confirmation.input.select()
        return false
      }
      await api(`knowledge-bases/${encodeURIComponent(base.id)}`, { method: 'DELETE' })
      if (state.documentView.knowledgeBaseId === base.id) {
        state.documentView.knowledgeBaseId = ''
        state.documentView.documentId = ''
      }
      if (state.libraryDetail.knowledgeBaseId === base.id) {
        state.libraryDetail.knowledgeBaseId = ''
        state.libraryDetail.documents = []
        state.libraryDetail.view = createDocumentViewState()
        state.knowledgeBaseView = 'libraries'
      }
      if (state.entryFilters.knowledgeBaseId === base.id) state.entryFilters.knowledgeBaseId = ''
      showToast('База знаний и все связанные данные удалены навсегда.')
      await navigate('bases')
      return true
    },
  })
  confirmation.input.focus()
}

function openEntryEditor(entry, candidate) {
  const activeWorkspace = activeDocumentWorkspace()
  const candidateTarget = candidate?.targetId ? state.candidateTargets.get(candidate.targetId) : null
  const candidateReview = candidate && (candidate.action === 'create' || candidateTarget)
    ? window.DshKnowledgeReview.createReviewChange(candidate.action, candidateTarget?.body || '', candidate.draft.body, candidate.change?.kind)
    : null
  const source = candidate ? { ...candidate.draft, body: candidateReview?.after || candidate.draft.body } : entry || {
    knowledgeBaseId: activeWorkspace?.view.knowledgeBaseId || undefined,
    title: '', body: '', type: 'fact', tags: [], scope: { kind: 'global' }, confidence: .8,
  }
  const form = element('form', { class: 'form-grid' })
  const title = formField('Заголовок', 'input', source.title, { required: true, maxlength: 200, placeholder: 'Опишите эту запись одной фразой' })
  const body = formField('Текст', 'textarea', source.body, { required: true, maxlength: 50000, placeholder: 'Запишите то, что можно будет использовать в будущих диалогах' })
  const type = selectField('Тип', TYPES.map(value => ({ value, label: TYPE_LABELS[value] })), source.type)
  const activeBases = state.knowledgeBases.filter(base => base.status === 'active')
  const selectedBaseId = source.knowledgeBaseId || activeBases[0]?.id || 'default'
  const knowledgeBase = selectField('База знаний', activeBases.map(base => ({ value: base.id, label: base.name })), selectedBaseId)
  const requiresGroup = !entry && (!candidate || candidate.action === 'create')
  let groupField = createDocumentGroupField({ element, api, baseId: selectedBaseId, value: candidateTarget?.group ?? source.group ?? '', required: requiresGroup })
  const groupSlot = element('div', { class: 'span-2' }, groupField.wrapper)
  knowledgeBase.input.addEventListener('change', () => {
    groupField = createDocumentGroupField({ element, api, baseId: knowledgeBase.input.value, value: groupField.value(), required: requiresGroup })
    groupSlot.replaceChildren(groupField.wrapper)
  })
  const scope = selectField('Область', [{ value: 'global', label: 'Глобально' }, { value: 'project', label: 'Проект' }], source.scope.kind)
  const project = formField('ID проекта / путь', 'input', source.scope.kind === 'project' ? source.scope.id : '', { placeholder: '/workspace/project' })
  const tags = formField('Теги', 'input', source.tags.join(', '), { placeholder: 'docker, deployment' })
  const confidenceInput = element('input', { type: 'range', min: 0, max: 1, step: .01, value: source.confidence })
  const confidenceValue = element('span', { class: 'range-value' }, `${Math.round(source.confidence * 100)}%`)
  confidenceInput.addEventListener('input', () => { confidenceValue.textContent = `${Math.round(Number(confidenceInput.value) * 100)}%` })
  const scopeProjectField = project.wrapper
  const updateScope = () => { scopeProjectField.hidden = scope.input.value !== 'project'; project.input.required = scope.input.value === 'project' }
  scope.input.addEventListener('change', updateScope)
  updateScope()
  form.append(
    title.wrapper,
    type.wrapper,
    knowledgeBase.wrapper,
    groupSlot,
    scope.wrapper,
    scopeProjectField,
    element('div', { class: 'field span-2' }, element('label', {}, 'Уверенность'), element('div', { class: 'range-row' }, confidenceInput, confidenceValue)),
    body.wrapper,
    tags.wrapper,
  )
  body.wrapper.classList.add('span-2')
  tags.wrapper.classList.add('span-2')
  const modeTitle = candidate
    ? candidate.action === 'create' ? 'Редактировать новый документ' : 'Редактировать итоговый документ'
    : entry ? 'Редактировать документ базы знаний' : 'Создать документ знаний'
  const candidateDescription = candidate?.action === 'create'
    ? 'После подтверждения документ будет создан и сразу начнёт участвовать в извлечении.'
    : 'Текст — итоговая версия после проверки; можно сразу править и удалять устаревшее. Если исходник изменился, потребуется открыть заново и разобрать.'
  const primaryLabel = candidate
    ? candidate.action === 'create' ? 'Записать в новый документ' : 'Сохранить итоговую версию'
    : 'Сохранить документ'
  const modal = openSheet({ title: modeTitle, description: candidate ? candidateDescription : 'После сохранения документ сразу участвует в последующем извлечении.', body: form, primaryLabel, onPrimary: async () => {
    if (!form.reportValidity()) return false
    await groupField.ready
    groupField.validate()
    if (requiresGroup && (!groupField.value() || groupField.value() === 'без группы')) throw new Error('Для нового документа нужно выбрать группу.')
    const draft = {
      knowledgeBaseId: knowledgeBase.input.value,
      group: groupField.value(),
      title: title.input.value.trim(), body: body.input.value.trim(), type: type.input.value,
      tags: parseTags(tags.input.value),
      scope: scope.input.value === 'global' ? { kind: 'global' } : { kind: 'project', id: project.input.value.trim() },
      confidence: Number(confidenceInput.value),
      ...(source.source ? { source: source.source } : {}),
    }
    if (candidate) await api(`candidates/${encodeURIComponent(candidate.id)}/review`, {
      method: 'POST', body: {
        decision: 'approve', draft,
        ...(candidateTarget?.version ? { expectedVersion: candidateTarget.version } : {}),
        ...(candidate.action === 'conflict' ? { resolution: 'merge' } : {}),
      },
    })
    else if (entry) await api(`entries/${encodeURIComponent(entry.id)}`, { method: 'PUT', body: { draft } })
    else await api('entries', { method: 'POST', body: { draft } })
    showToast(candidate ? candidate.action === 'create' ? 'Новый документ записан.' : 'Ревизия документа сохранена.' : 'Знания сохранены.')
    state.stats = null
    await navigate(candidate ? 'candidates' : state.view)
    return true
  } })
  title.input.focus()
  return modal
}

function formField(label, kind, value, attributes = {}) {
  const input = element(kind === 'textarea' ? 'textarea' : 'input', { class: kind === 'textarea' ? 'textarea' : 'input', value, ...attributes })
  if (kind === 'textarea') input.value = value
  return { input, wrapper: element('div', { class: 'field' }, element('label', {}, label), input) }
}

function selectField(label, options, value) {
  const input = element('select', { class: 'select' }, options.map(option => element('option', { value: option.value, selected: option.value === value }, option.label)))
  return { input, wrapper: element('div', { class: 'field' }, element('label', {}, label), input) }
}

async function loadModelCatalog() {
  try {
    state.modelCatalog = await readModelCatalog()
  } catch (error) {
    showToast(`Не удалось прочитать каталог моделей DSH: ${error.message}. Откройте заново, чтобы повторить.`, 'error')
  }
  return state.modelCatalog || []
}

function modelRouteFields(currentProvider, currentModel) {
  const providers = [...(state.modelCatalog || [])]
  if (currentProvider && !providers.some(item => item.id === currentProvider)) {
    providers.push({ id: currentProvider, name: `${currentProvider} (текущая настройка)`, models: [] })
  }
  const provider = selectField('Поставщик модели', providers.map(item => ({ value: item.id, label: item.name || item.id })), currentProvider || providers[0]?.id || '')
  const model = selectField('Модель записи', [], '')
  const refreshModels = preferred => {
    const selected = providers.find(item => item.id === provider.input.value)
    const models = [...(selected?.models || [])]
    if (preferred && !models.some(item => item.id === preferred)) models.push({ id: preferred, name: `${preferred} (текущая настройка)` })
    model.input.replaceChildren(...models.map(item => element('option', {
      value: item.id, selected: item.id === preferred,
    }, item.name && item.name !== item.id ? `${item.name} · ${item.id}` : item.id)))
    if (preferred && models.some(item => item.id === preferred)) model.input.value = preferred
  }
  provider.input.addEventListener('change', () => refreshModels(''))
  refreshModels(currentModel)
  return { provider, model }
}

async function reviewCandidate(candidate, decision, resolution) {
  const approve = decision === 'approve'
  const action = candidatePrimaryAction(candidate)
  const title = approve ? `${action.label}？` : 'Отклонить этого кандидата?'
  const message = !approve
    ? 'После отклонения запись проверки сохранится, но в базу знаний ничего не попадёт.'
    : candidate.change?.kind === 'group'
      ? `Документ будет только помещён в «${candidate.change.group}» — текст и статус не изменятся.`
    : candidate.change?.kind === 'finalize'
      ? 'После подтверждения весь документ будет завершён и запись остановится, текст останется без изменений. Чтобы продолжить дополнять, откройте документ заново; при смене версии это подтверждение не сработает.'
    : candidate.action === 'create'
      ? 'После подтверждения будет создан новый документ, который сразу начнёт участвовать в извлечении для следующих диалогов.'
      : candidate.action === 'conflict'
        ? candidate.change?.kind === 'revise'
          ? 'После подтверждения исходный текст будет заменён или удалён согласно превью. Внимательно проверьте красные удалённые и зелёные добавленные строки.'
          : 'После подтверждения текущий документ сохранится и будет дополнен содержимым кандидата.'
        : candidate.change?.kind === 'revise'
          ? 'После подтверждения текст будет исправлен по предпросмотру; посторонние параллельные дополнения сохранятся, а изменения в той же области станут конфликтами.'
          : 'После подтверждения документ будет дополнен по предпросмотру; при противоречиях появятся конфликты.'
  openConfirm({
    title,
    message,
    confirmLabel: approve ? action.label : 'Подтвердить отклонение', danger: !approve,
    onConfirm: async () => {
      const reviewed = await api(`candidates/${encodeURIComponent(candidate.id)}/review`, {
        method: 'POST', body: { decision, ...(resolution ? { resolution } : {}) },
      })
      if (approve && reviewed.status === 'pending' && reviewed.action === 'conflict') {
        showToast('За время проверки знания изменились, кандидат стал конфликтом — сравните и подтвердите заново.')
        state.stats = null
        await navigate('candidates')
        return
      }
      showToast(approve ? candidate.change?.kind === 'finalize' ? (candidate.change.state === 'resolved' ? 'Документ отмечен как решённый.' : 'Документ отмечен как полностью собранный.') : candidate.action === 'create' ? 'Новый документ записан.' : candidate.change?.kind === 'revise' ? 'Текст изменён.' : 'Содержимое дополнено.' : 'Кандидат отклонён.')
      state.stats = null
      await navigate('candidates')
    },
  })
}

function openBulkApprove() {
  if (state.candidateBatchRunning) return
  const pendingCount = state.stats?.candidates.pending ?? state.candidates.length
  const summary = element('strong', {}, `К обработке ${pendingCount} кандидатов на проверке`)
  const detail = element('p', {}, 'После запуска обработка пойдёт партиями по времени создания, результаты будут показываться сразу.')
  const metrics = element('div', { class: 'bulk-review-metrics' })
  const status = element('div', {
    class: 'bulk-review-status', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', hidden: true,
  }, summary, detail, metrics)
  const body = element('div', { class: 'bulk-review-confirm' },
    element('p', {}, 'Новые и безопасно объединяемые элементы из очереди проверки будут приняты партиями. Конфликты, элементы с недоступной целью и кандидаты, изменившиеся во время проверки, останутся для обработки по одному.'),
    element('div', { class: 'bulk-review-safety' },
      element('strong', {}, 'Конфликты не обрабатываются автоматически'),
      element('span', {}, 'Кандидаты одного документа записываются по порядку времени, чтобы избежать параллельной перезаписи.'),
    ),
    status,
  )
  openModal({
    title: 'Одобрить все кандидаты на проверке?',
    description: 'Подходит для массовой обработки накопившихся кандидатов; после завершения отменить всё сразу нельзя.',
    body,
    primaryLabel: 'Начать приём в один клик',
    onPrimary: async () => {
      state.candidateBatchRunning = true
      status.hidden = false
      const excluded = new Set()
      const totals = { approved: 0, deferred: 0, failed: 0, selected: 0, remainingReviewable: pendingCount, remainingManual: 0 }
      const updateProgress = (message = 'Последовательная проверка кандидатов…') => {
        summary.textContent = message
        detail.textContent = `Проверено ${totals.selected}; не более 25 за раз.`
        metrics.replaceChildren(
          bulkReviewMetric('Принято', totals.approved, 'success'),
          bulkReviewMetric('Отметить как конфликт', totals.deferred, 'warning'),
          bulkReviewMetric('При ошибке сохранить', totals.failed, totals.failed ? 'danger' : ''),
          bulkReviewMetric('Осталось обработать', totals.remainingReviewable),
        )
      }
      updateProgress()
      try {
        for (let pass = 0; pass < 1000; pass += 1) {
          const result = await api('candidates/bulk-review', {
            method: 'POST', body: { limit: 25, excludeIds: [...excluded] },
          })
          totals.selected += result.selected
          totals.approved += result.approved
          totals.deferred += result.deferred
          totals.failed += result.failed.length
          totals.remainingReviewable = result.remainingReviewable
          totals.remainingManual = result.remainingManual
          result.failed.forEach(item => excluded.add(item.id))
          updateProgress()
          if (result.remainingReviewable === 0) break
          if (result.selected === 0) throw new Error('Пакетная проверка не продолжилась; оставшиеся кандидаты сохранены, обновите страницу и повторите.')
        }
        if (totals.remainingReviewable > 0) throw new Error('Кандидатов на проверку слишком много, достигнут безопасный предел обработки. Запустите ещё раз.')
        summary.textContent = totals.approved > 0 ? `Одобрено кандидатов: ${totals.approved}` : 'Нет кандидатов для автоматического принятия'
        detail.textContent = totals.remainingManual > 0
          ? `Осталось ${totals.remainingManual} конфликтов или ошибок — подтвердите по одному.`
          : 'Очередь проверки обработана полностью.'
        state.stats = null
        await loadCandidates()
        state.candidateBatchRunning = false
        renderShell()
        const parts = [`Одобрено ${totals.approved}`]
        if (totals.deferred) parts.push(`${totals.deferred} стали конфликтами`)
        if (totals.failed) parts.push(`${totals.failed} с ошибкой, сохранены`)
        if (totals.remainingManual) parts.push(`${totals.remainingManual} требуют ручной обработки`)
        showToast(`${parts.join('，')}。`, totals.failed ? 'error' : '')
        return true
      } finally {
        state.candidateBatchRunning = false
      }
    },
  })
}

function bulkReviewMetric(label, value, variant = '') {
  return element('span', { class: `bulk-review-metric ${variant}`.trim() },
    element('small', {}, label), element('strong', {}, String(value)),
  )
}

function confirmArchive(entry) {
  openConfirm({ title: 'Архивировать это знание?', message: 'После архивации он больше не участвует в извлечении, история версий сохранится.', confirmLabel: 'Подтвердить архивацию', danger: true, onConfirm: async () => {
    await api(`entries/${encodeURIComponent(entry.id)}/archive`, { method: 'POST' })
    showToast('Знания заархивированы.')
    state.stats = null
    await navigate('entries')
  } })
}

function confirmDelete(entry) {
  openConfirm({ title: 'Удалить это знание безвозвратно?', message: 'Текст документа и вся история версий будут удалены безвозвратно, отменить это нельзя.', confirmLabel: 'Удалить навсегда', danger: true, onConfirm: async () => {
    await api(`entries/${encodeURIComponent(entry.id)}`, { method: 'DELETE' })
    showToast('Знания окончательно удалены.')
    state.stats = null
    await navigate('entries')
  } })
}

async function openHistory(entry) {
  try {
    const versions = await api(`entries/${encodeURIComponent(entry.id)}/versions`)
    const content = element('div', { class: 'history' }, versions.map(version => element('article', { class: 'history-item' },
      element('div', { class: 'history-line' }, element('span', { class: 'history-dot', 'aria-hidden': 'true' })),
      element('div', { class: 'history-content' }, element('strong', {}, `v${version.version} · ${CHANGE_LABELS[version.changeKind]}`), element('small', {}, formatDate(version.createdAt)), element('p', {}, version.snapshot.body)),
    )))
    openModal({ title: `${entry.title} · история версий`, description: 'При каждом изменении сохраняется неизменяемый снимок.', body: content, cancelLabel: 'Закрыть' })
  } catch (error) { showToast(friendlyError(error), 'error') }
}

function openTokenCreator() {
  const name = formField('Имя токена', 'input', '', { required: true, maxlength: 100, placeholder: 'Например: офисный компьютер' })
  const permissions = ['read', 'propose', 'write', 'admin']
  const checkboxes = permissions.map((permission, index) => {
    const input = element('input', { type: 'checkbox', value: permission, checked: index === 0 })
    return { permission, input, node: element('label', { class: 'check-option' }, input, permission) }
  })
  const body = element('form', { class: 'form-grid' }, name.wrapper,
    element('div', { class: 'field span-2' }, element('label', {}, 'Права'), element('div', { class: 'check-grid' }, checkboxes.map(item => item.node)), element('span', { class: 'field-hint' }, 'Обычному клиенту рекомендуется выдавать только read + propose. write — это глобальное право записи текущего центрального сервиса, оно также разрешает прямую запись, управление базами знаний, подключения и заметки; выдавайте только при реальной необходимости.')))
  name.wrapper.classList.add('span-2')
  openModal({ title: 'Создать токен клиента', description: 'Исходный токен показывается только один раз после успешного создания.', body, primaryLabel: 'Создать токен', onPrimary: async () => {
    if (!body.reportValidity()) return false
    const selected = checkboxes.filter(item => item.input.checked).map(item => item.permission)
    if (!selected.length) { showToast('Выберите хотя бы одно право.', 'error'); return false }
    const created = await api('tokens', { method: 'POST', body: { name: name.input.value.trim(), permissions: selected } })
    await loadTokens()
    renderShell()
    window.setTimeout(() => showSecret(created.token), 0)
    return true
  } })
  name.input.focus()
}

function showSecret(token) {
  const code = element('code', {}, token)
  const content = element('div', { class: 'secret-box' }, element('strong', {}, 'Скопируйте сейчас и надёжно сохраните'), element('p', {}, 'После закрытия этого окна сервер больше не сможет показать исходный токен.'), element('div', { class: 'secret-value' }, code, actionButton('Копировать', async () => {
    try { await navigator.clipboard.writeText(token); showToast('Токен скопирован.') } catch { showToast('Не удалось скопировать, выберите токен вручную.', 'error') }
  }, 'small')))
  openModal({ title: 'Токен создан', body: content, cancelLabel: 'Я сохранил' })
}

function confirmRevokeToken(token) {
  openConfirm({ title: `Отозвать «${token.name}»?`, message: 'Клиенты с этим токеном сразу потеряют доступ — действие необратимо.', confirmLabel: 'Подтвердить отзыв', danger: true, onConfirm: async () => {
    await api(`tokens/${encodeURIComponent(token.id)}`, { method: 'DELETE' })
    showToast('Токен отозван.')
    await loadTokens()
    renderShell()
  } })
}

function confirmDeleteToken(token) {
  openConfirm({ title: `Удалить навсегда «${token.name}»?`, message: 'Эта запись об отозванном токене будет удалена безвозвратно, отменить это нельзя.', confirmLabel: 'Удалить навсегда', danger: true, onConfirm: async () => {
    await api(`tokens/${encodeURIComponent(token.id)}`, { method: 'DELETE' })
    showToast('Отозванный токен удалён безвозвратно.')
    await loadTokens()
    renderShell()
  } })
}

function formatDate(value) {
  try { return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) } catch { return value }
}

function scopeLabel(scope) {
  return scope.kind === 'global' ? 'Глобально' : `Проект · ${scope.id}`
}

function friendlyError(error) {
  if (error.status === 403) return 'У текущего токена нет прав для этой операции.'
  if (error.status === 409) return error.message || 'Содержимое изменилось, обновите страницу и повторите.'
  if (error.name === 'AbortError') return 'Запрос отменён.'
  return error.message || 'Не удалось выполнить действие, повторите позже.'
}

let documentSyncState = { key: '', status: '' }
let syncConflictLoading = false

function currentSyncTarget() {
  if (state.loading || (AUTH_MODE !== 'same-origin' && !state.token)) return null
  const focused = () => !!document.activeElement?.closest('.note-editor, .notes-content, [role="dialog"]')
  if (state.view === 'notes') {
    const node = state.notes.selectedNode
    if (!node?.editable || state.notes.loadingNodeId) return null
    return { key: `note:${node.id}`, id: node.id, kind: 'note', identity: node,
      version: state.notes.contentVersion ?? node.version, updatedAt: node.updatedAt,
      busy: () => state.notes.dirty || state.notes.saving || state.notes.titleDirty || state.notes.renaming || focused() }
  }
  const workspace = activeDocumentWorkspace()
  const editor = workspace?.view.editor
  if (!editor?.id || editor.isNew || workspace.view.editorLoading) return null
  return { key: `${workspace.kind}:${editor.id}`, id: editor.id, kind: 'knowledge', identity: editor, workspace,
    version: editor.version, updatedAt: editor.updatedAt,
    busy: () => editor.dirty || editor.saving || focused() }
}

async function readNoteSnapshot(id, signal) {
  const node = await api(`notes/${encodeURIComponent(id)}`, { signal })
  if (!node.editable) throw new Error('Этот файл больше не поддерживает редактирование текста')
  const blob = await binaryRequest(`notes/${encodeURIComponent(id)}/versions/${node.version}/content`, { responseType: 'blob', signal })
  return { node, content: await blob.text() }
}

async function readSyncSnapshot(target, signal) {
  if (target.kind === 'note') return readNoteSnapshot(target.id, signal)
  const [entry, noteReferences] = await Promise.all([
    api(`entries/${encodeURIComponent(target.id)}`, { signal }),
    api(`entries/${encodeURIComponent(target.id)}/note-references`, { signal }),
  ])
  return { entry, noteReferences }
}

function applySyncSnapshot(target, snapshot, draft) {
  if (target.kind === 'note') {
    Object.assign(state.notes, { selectedNode: snapshot.node, content: snapshot.content, contentVersion: snapshot.node.version,
      draft: draft?.content ?? snapshot.content, dirty: draft !== undefined && draft.content !== snapshot.content })
    for (const [key, nodes] of state.notes.children) state.notes.children.set(key, nodes.map(node => node.id === target.id ? snapshot.node : node))
  } else {
    const entry = snapshot.entry
    Object.assign(target.identity, entry, { noteReferences: snapshot.noteReferences, tagsText: entry.tags.join(', '), dirty: !!draft,
      ...(draft ? { title: draft.title, body: draft.content } : {}), saveState: draft ? 'Не сохранено' : 'Синхронизировано' })
    const items = documentWorkspaceDocuments(target.workspace)
    setDocumentWorkspaceDocuments(target.workspace, items.map(item => item.id === target.id ? { ...item, title: target.identity.title, version: entry.version, updatedAt: entry.updatedAt } : item))
  }
  documentSyncState = { key: target.key, status: draft ? '' : 'synced' }
  renderShell()
}

function renderDocumentSyncNotice() {
  const target = currentSyncTarget()
  const status = target?.key === documentSyncState.key ? documentSyncState.status : ''
  const host = document.querySelector('.note-editor-toolbar, .notes-document-toolbar')
  let notice = host?.querySelector('.document-sync-notice')
  if (!target || !status) { notice?.remove(); return }
  const labels = { changed: 'У документа есть новая версия, текущее содержимое сохранено', missing: 'Документ удалён или недоступен, черновик сохранён', offline: 'Синхронизация временно недоступна, будет выполнена повторная попытка', synced: 'Синхронизирована последняя версия' }
  if (notice?.dataset.status === status) return
  if (!notice) { notice = element('div', { class: 'document-sync-notice' }); host?.append(notice) }
  notice.dataset.status = status
  notice.replaceChildren(element('span', { role: 'status' }, labels[status] || ''))
  if (status === 'changed') notice.append(actionButton('Просмотреть и обработать', () => { void openDocumentSyncConflict() }, 'small'))
}

async function openDocumentSyncConflict() {
  const target = currentSyncTarget()
  if (!target || syncConflictLoading) return
  if (target.kind === 'note' && (state.notes.titleDirty || state.notes.renaming)) return showToast('Изменение заголовка не сохранено — сначала скопируйте его; нажмите Escape в заголовке, чтобы вернуть прежний, и затем разберите новую версию документа.', 'error')
  syncConflictLoading = true
  try {
    const snapshot = await readSyncSnapshot(target, AbortSignal.timeout(10000))
    if (currentSyncTarget()?.identity !== target.identity) return
    const local = target.kind === 'note' ? { title: state.notes.selectedNode.name, content: state.notes.draft }
      : { title: target.identity.title, content: target.identity.body }
    const remote = target.kind === 'note' ? { title: snapshot.node.name, content: snapshot.content }
      : { title: snapshot.entry.title, content: snapshot.entry.body }
    const { openSyncConflict } = await import(moduleUrl('document-sync-ui'))
    const stillCurrent = () => {
      if (currentSyncTarget()?.identity !== target.identity) throw new Error('Текущий документ переключён, откройте различия заново')
      if ((target.kind === 'note' ? state.notes.draft : target.identity.body) !== local.content
        || (target.kind === 'knowledge' && target.identity.title !== local.title)) throw new Error('В локальном черновике есть новые правки: закройте и посмотрите различия заново')
    }
    openSyncConflict({ element, actionButton, openModal, openConfirm, renderDiff: renderNoteHistoryDiff, local, remote,
      allowTitle: target.kind === 'knowledge',
      canEdit: target.kind === 'note' || (snapshot.entry.documentState === 'open' && snapshot.entry.status === 'active' && !documentWorkspaceReadOnly(target.workspace)),
      apply: draft => { stillCurrent(); applySyncSnapshot(target, snapshot, draft) },
      useRemote: () => { stillCurrent(); applySyncSnapshot(target, snapshot) },
    })
  } catch (error) { showToast(friendlyError(error), 'error') }
  finally { syncConflictLoading = false }
}

const documentSync = createDocumentSync({
  current: currentSyncTarget,
  check: (target, signal) => api(target.kind === 'note' ? `notes/${encodeURIComponent(target.id)}` : `entries/${encodeURIComponent(target.id)}/revision`, { signal }),
  refresh: async (target, signal, valid) => {
    const snapshot = await readSyncSnapshot(target, signal)
    if (valid()) applySyncSnapshot(target, snapshot)
    else if (currentSyncTarget()?.identity === target.identity) {
      documentSyncState = { key: target.key, status: 'changed' }
      renderDocumentSyncNotice()
    }
  },
  notify: (target, status) => {
    if (status === 'current') {
      if (documentSyncState.key !== target.key || documentSyncState.status === 'synced') return
      status = ''
    }
    documentSyncState = { key: target.key, status }
    renderDocumentSyncNotice()
  },
})
document.addEventListener('visibilitychange', () => { if (document.hidden) documentSync.pause(); else documentSync.wake() })
window.addEventListener('focus', () => documentSync.wake())
window.addEventListener('online', () => documentSync.wake())
window.addEventListener('pagehide', () => documentSync.pause())
window.addEventListener('pageshow', () => documentSync.wake())

window.addEventListener('beforeunload', event => {
  const editor = activeDocumentWorkspace()?.view.editor
  if (!editor?.dirty && !state.notes.dirty && !state.notes.titleDirty) return
  event.preventDefault()
  event.returnValue = ''
})

installDragRecovery()
void installHostThemeBridge().then(() => boot()).then(() => documentSync.wake())
