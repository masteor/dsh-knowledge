import type { Editor } from '@tiptap/core'

interface NoteSelectionMenuOptions {
  editor: Editor
  frame: HTMLElement
  scrollHost: HTMLElement
  findIsOpen(): boolean
  onExcerpt?(text: string): void
}

export interface NoteSelectionMenuController {
  refresh(): void
  hide(): void
  destroy(): void
}

interface FormatAction {
  label: string
  active(): boolean
  run(): void
}

function control(label: string, ariaLabel: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'notes-selection-control'
  button.textContent = label
  button.setAttribute('aria-label', ariaLabel)
  button.addEventListener('pointerdown', event => event.preventDefault())
  button.addEventListener('click', onClick)
  return button
}

function safeLink(value: string): string | null {
  const href = value.trim()
  if (!href) return ''
  if (/^(https?:\/\/|mailto:|\/|#)/i.test(href)) return href
  if (/^[\w.-]+\.[a-z]{2,}(?:[/?#].*)?$/i.test(href)) return `https://${href}`
  return null
}

export function createNoteSelectionMenu(options: NoteSelectionMenuOptions): NoteSelectionMenuController {
  const { editor, frame, scrollHost } = options
  const menu = document.createElement('div')
  menu.className = 'notes-selection-menu'
  menu.setAttribute('role', 'toolbar')
  menu.setAttribute('aria-label', 'Формат выделенного текста')
  menu.hidden = true

  const primary = document.createElement('div')
  primary.className = 'notes-selection-primary'
  const blockToggle = control('Обычный текст', 'Изменить формат абзаца', () => {
    const expanded = blockToggle.getAttribute('aria-expanded') !== 'true'
    blockToggle.setAttribute('aria-expanded', String(expanded))
    blockMenu.hidden = !expanded
    linkForm.hidden = true
    positionMenu()
  })
  blockToggle.classList.add('notes-selection-block-toggle')
  blockToggle.setAttribute('aria-haspopup', 'menu')
  blockToggle.setAttribute('aria-expanded', 'false')

  const markActions: FormatAction[] = [
    { label: 'B', active: () => editor.isActive('bold'), run: () => { editor.chain().focus().toggleBold().run() } },
    { label: 'I', active: () => editor.isActive('italic'), run: () => { editor.chain().focus().toggleItalic().run() } },
    { label: 'U', active: () => editor.isActive('underline'), run: () => { editor.chain().focus().toggleUnderline().run() } },
    { label: 'S', active: () => editor.isActive('strike'), run: () => { editor.chain().focus().toggleStrike().run() } },
    { label: '</>', active: () => editor.isActive('code'), run: () => { editor.chain().focus().toggleCode().run() } },
  ]
  const markLabels = ['Полужирный', 'Курсив', 'Подчёркнутый', 'Зачёркнутый', 'Код в строке']
  const markButtons = markActions.map((action, index) => {
    const button = control(action.label, markLabels[index] ?? action.label, () => {
      action.run()
      refreshActiveStates()
    })
    button.classList.add('notes-selection-mark')
    return button
  })

  const linkToggle = control('Ссылка', 'Добавить или изменить ссылку', () => {
    blockMenu.hidden = true
    blockToggle.setAttribute('aria-expanded', 'false')
    linkForm.hidden = false
    const href = editor.getAttributes('link').href
    linkInput.value = typeof href === 'string' ? href : ''
    linkError.textContent = ''
    positionMenu()
    window.requestAnimationFrame(() => { linkInput.focus(); linkInput.select() })
  })
  const copyButton = control('Копировать', 'Копировать выделенный текст', () => {
    const { from, to } = editor.state.selection
    const text = editor.state.doc.textBetween(from, to, ' ')
    void navigator.clipboard?.writeText(text).catch(() => {})
  })
  primary.append(blockToggle, ...markButtons, linkToggle, copyButton)
  if (options.onExcerpt) {
    const excerpt = control('Выдержка в базу знаний', 'Сохранить выделенный текст в базу знаний', () => {
      const { from, to } = editor.state.selection
      const text = editor.state.doc.textBetween(from, to, '\n')
      if (text.trim()) { hide(); options.onExcerpt?.(text) }
    })
    excerpt.classList.add('notes-selection-excerpt')
    primary.append(excerpt)
  }

  const blockMenu = document.createElement('div')
  blockMenu.className = 'notes-selection-block-menu'
  blockMenu.setAttribute('role', 'menu')
  blockMenu.hidden = true
  const blockActions: FormatAction[] = [
    { label: 'Обычный текст', active: () => editor.isActive('paragraph'), run: () => { editor.chain().focus().setParagraph().run() } },
    { label: 'Заголовок 1', active: () => editor.isActive('heading', { level: 1 }), run: () => { editor.chain().focus().toggleHeading({ level: 1 }).run() } },
    { label: 'Заголовок 2', active: () => editor.isActive('heading', { level: 2 }), run: () => { editor.chain().focus().toggleHeading({ level: 2 }).run() } },
    { label: 'Заголовок 3', active: () => editor.isActive('heading', { level: 3 }), run: () => { editor.chain().focus().toggleHeading({ level: 3 }).run() } },
    { label: 'Маркированный список', active: () => editor.isActive('bulletList'), run: () => { editor.chain().focus().toggleBulletList().run() } },
    { label: 'Нумерованный список', active: () => editor.isActive('orderedList'), run: () => { editor.chain().focus().toggleOrderedList().run() } },
    { label: 'Цитата', active: () => editor.isActive('blockquote'), run: () => { editor.chain().focus().toggleBlockquote().run() } },
    { label: 'Блок кода', active: () => editor.isActive('codeBlock'), run: () => { editor.chain().focus().toggleCodeBlock().run() } },
  ]
  const blockButtons = blockActions.map(action => {
    const button = control(action.label, action.label, () => {
      action.run()
      blockMenu.hidden = true
      blockToggle.setAttribute('aria-expanded', 'false')
      refreshActiveStates()
      schedulePosition()
    })
    button.setAttribute('role', 'menuitemradio')
    blockMenu.append(button)
    return button
  })

  const linkForm = document.createElement('form')
  linkForm.className = 'notes-selection-link-form'
  linkForm.hidden = true
  const linkInput = document.createElement('input')
  linkInput.type = 'text'
  linkInput.inputMode = 'url'
  linkInput.className = 'notes-selection-link-input'
  linkInput.placeholder = 'https://example.com'
  linkInput.setAttribute('aria-label', 'Адрес ссылки')
  linkInput.autocomplete = 'off'
  const applyLink = control('Применить', 'Применить ссылку', () => submitLink())
  const removeLink = control('Убрать', 'Убрать ссылку', () => {
    editor.chain().focus().extendMarkRange('link').unsetLink().run()
    linkForm.hidden = true
    refreshActiveStates()
  })
  const linkError = document.createElement('span')
  linkError.className = 'notes-selection-link-error'
  linkError.setAttribute('role', 'alert')
  linkForm.append(linkInput, applyLink, removeLink, linkError)
  linkForm.addEventListener('submit', event => {
    event.preventDefault()
    submitLink()
  })

  menu.append(primary, blockMenu, linkForm)
  frame.append(menu)

  let positionFrame: number | undefined
  let scrollTimer: number | undefined
  let selectionFrame: number | undefined
  let activeSelectionPointerId: number | undefined
  let gestureCancelled = false
  let destroyed = false
  let lastState: typeof editor.state | undefined

  function currentBlockLabel(): string {
    if (editor.isActive('heading', { level: 1 })) return 'Заголовок 1'
    if (editor.isActive('heading', { level: 2 })) return 'Заголовок 2'
    if (editor.isActive('heading', { level: 3 })) return 'Заголовок 3'
    if (editor.isActive('bulletList')) return 'Маркированный список'
    if (editor.isActive('orderedList')) return 'Нумерованный список'
    if (editor.isActive('blockquote')) return 'Цитата'
    if (editor.isActive('codeBlock')) return 'Блок кода'
    return 'Обычный текст'
  }

  function refreshActiveStates(): void {
    blockToggle.textContent = currentBlockLabel()
    markButtons.forEach((button, index) => button.setAttribute('aria-pressed', String(markActions[index]?.active() ?? false)))
    blockButtons.forEach((button, index) => button.setAttribute('aria-checked', String(blockActions[index]?.active() ?? false)))
    linkToggle.setAttribute('aria-pressed', String(editor.isActive('link')))
  }

  function submitLink(): void {
    const href = safeLink(linkInput.value)
    if (href === null) {
      linkError.textContent = 'Введите корректный адрес веб-страницы или электронной почты.'
      linkInput.focus()
      return
    }
    if (href) editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
    else editor.chain().focus().extendMarkRange('link').unsetLink().run()
    linkError.textContent = ''
    linkForm.hidden = true
    refreshActiveStates()
  }

  function shouldShow(): boolean {
    if (destroyed || editor.isDestroyed || options.findIsOpen()) return false
    const { from, to, empty } = editor.state.selection
    if (empty || !editor.isFocused) return false
    if (lastState === editor.state) return true
    return Boolean(editor.state.doc.textBetween(from, to, ' ').trim())
  }

  function positionMenu(): void {
    positionFrame = undefined
    if (destroyed || menu.hidden || editor.isDestroyed) return
    if (window.matchMedia('(max-width: 1120px), (hover: none) and (pointer: coarse) and (max-width: 1400px)').matches) {
      menu.dataset.placement = 'bottom'
      menu.style.left = 'max(8px, env(safe-area-inset-left))'
      menu.style.right = 'max(8px, env(safe-area-inset-right))'
      menu.style.bottom = 'max(8px, env(safe-area-inset-bottom))'
      menu.style.top = 'auto'
      return
    }
    menu.style.right = ''
    menu.style.bottom = ''
    const { from, to } = editor.state.selection
    const start = editor.view.coordsAtPos(from)
    const end = editor.view.coordsAtPos(to)
    const rect = menu.getBoundingClientRect()
    const margin = 8
    const center = (Math.min(start.left, end.left) + Math.max(start.right, end.right)) / 2
    const left = Math.max(margin, Math.min(window.innerWidth - rect.width - margin, center - rect.width / 2))
    let top = Math.min(start.top, end.top) - rect.height - 9
    menu.dataset.placement = 'top'
    if (top < margin) {
      top = Math.max(start.bottom, end.bottom) + 9
      menu.dataset.placement = 'bottom'
    }
    menu.style.left = `${Math.round(left)}px`
    menu.style.top = `${Math.round(top)}px`
  }

  function schedulePosition(): void {
    if (destroyed || menu.hidden) return
    if (positionFrame !== undefined) window.cancelAnimationFrame(positionFrame)
    positionFrame = window.requestAnimationFrame(positionMenu)
  }

  function refresh(): void {
    if (destroyed || gestureCancelled || activeSelectionPointerId !== undefined) {
      hide()
      return
    }
    if (!shouldShow()) {
      hide()
      return
    }
    menu.hidden = false
    // selectionUpdate and transaction can fire for the same state. Avoid
    // repeatedly traversing a large selection for every formatting control.
    if (lastState !== editor.state) {
      refreshActiveStates()
      lastState = editor.state
    }
    schedulePosition()
  }

  function hide(): void {
    if (positionFrame !== undefined) window.cancelAnimationFrame(positionFrame)
    if (selectionFrame !== undefined) window.cancelAnimationFrame(selectionFrame)
    if (scrollTimer !== undefined) window.clearTimeout(scrollTimer)
    positionFrame = selectionFrame = scrollTimer = undefined
    menu.hidden = true
    blockMenu.hidden = true
    linkForm.hidden = true
    blockToggle.setAttribute('aria-expanded', 'false')
    linkError.textContent = ''
  }

  function onScroll(): void {
    hide()
    scrollTimer = window.setTimeout(refresh, 90)
  }

  function onOutsidePointer(event: PointerEvent): void {
    if (!menu.contains(event.target as Node) && !editor.view.dom.contains(event.target as Node)) cancelGesture()
  }

  function onEditorPointerDown(event: PointerEvent): void {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return
    gestureCancelled = false
    activeSelectionPointerId = event.pointerId
    hide()
  }

  function onSelectionPointerEnd(event: PointerEvent): void {
    if (activeSelectionPointerId === undefined || event.pointerId !== activeSelectionPointerId) return
    activeSelectionPointerId = undefined
    selectionFrame = window.requestAnimationFrame(() => {
      selectionFrame = window.requestAnimationFrame(() => {
        selectionFrame = undefined
        refresh()
      })
    })
  }

  function cancelGesture(): void {
    activeSelectionPointerId = undefined
    gestureCancelled = true
    hide()
  }

  function onSelectionPointerCancel(event: PointerEvent): void {
    if (event.pointerId === activeSelectionPointerId) cancelGesture()
  }

  function onEditorKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') cancelGesture()
    else gestureCancelled = false
  }

  editor.on('selectionUpdate', refresh)
  editor.on('transaction', refresh)
  scrollHost.addEventListener('scroll', onScroll, { passive: true })
  editor.view.dom.addEventListener('pointerdown', onEditorPointerDown, { passive: true })
  editor.view.dom.addEventListener('dragstart', cancelGesture)
  editor.view.dom.addEventListener('keydown', onEditorKeyDown, true)
  window.addEventListener('blur', cancelGesture)
  window.addEventListener('resize', schedulePosition, { passive: true })
  window.addEventListener('pointerup', onSelectionPointerEnd, { passive: true })
  window.addEventListener('pointercancel', onSelectionPointerCancel, { passive: true })
  document.addEventListener('pointerdown', onOutsidePointer)

  return {
    refresh,
    hide,
    destroy: () => {
      destroyed = true
      hide()
      editor.off('selectionUpdate', refresh)
      editor.off('transaction', refresh)
      scrollHost.removeEventListener('scroll', onScroll)
      editor.view.dom.removeEventListener('pointerdown', onEditorPointerDown)
      editor.view.dom.removeEventListener('dragstart', cancelGesture)
      editor.view.dom.removeEventListener('keydown', onEditorKeyDown, true)
      window.removeEventListener('blur', cancelGesture)
      window.removeEventListener('resize', schedulePosition)
      window.removeEventListener('pointerup', onSelectionPointerEnd)
      window.removeEventListener('pointercancel', onSelectionPointerCancel)
      document.removeEventListener('pointerdown', onOutsidePointer)
      menu.remove()
    },
  }
}
