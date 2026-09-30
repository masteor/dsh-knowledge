/** Selection is captured before opening the dialog; no editor ownership here. */
import { createDocumentGroupField } from './document-groups.js'
export async function openNoteExcerpt({ node, text, api, element, openSheet, showToast, friendlyError, formField, selectField, knowledgeBasePathLabel }) {
  if (!text.trim() || text.length > 50000) throw new Error('Выберите от 1 до 50000 символов содержимого заметки.')
  const bases = (await api('knowledge-bases')).filter(base => base.status === 'active')
  if (!bases.length) throw new Error('Сначала создайте доступную базу знаний.')
  const base = selectField('Целевая база знаний', bases.map(item => ({ value: item.id, label: knowledgeBasePathLabel(item) })), bases[0].id)
  const mode = selectField('Способ добавления', [{ value: 'existing', label: 'Дополнить существующий документ знаний' }, { value: 'new', label: 'Создать документ знаний' }], 'existing')
  const title = formField('Заголовок нового документа', 'text', node.name.replace(/\.md$/i, ''), { maxlength: 200 })
  const search = formField('Поиск документов знаний', 'search', '', { placeholder: 'Введите запрос или «/» для просмотра всех документов' })
  for (const [key, field] of Object.entries({ base, mode, title, search })) {
    field.input.id = `excerpt-${key}-${crypto.randomUUID()}`
    field.wrapper.querySelector('label').htmlFor = field.input.id
    field.wrapper.classList.add('span-2')
  }
  title.wrapper.hidden = true
  const groupSlot = element('div', { class: 'span-2', hidden: true })
  let groupField
  const loadGroup = () => {
    groupField = createDocumentGroupField({ element, api, baseId: base.input.value, required: true, onChange: () => { requestId = crypto.randomUUID(); sync() } })
    groupSlot.replaceChildren(groupField.wrapper)
  }
  const results = element('div', { class: 'note-picker-results span-2', 'aria-live': 'polite' })
  const status = element('p', { class: 'muted span-2', role: 'status' }, 'Выберите целевой документ')
  const fields = element('fieldset', { class: 'form-grid note-excerpt-fields' }, base.wrapper, mode.wrapper, title.wrapper, groupSlot, search.wrapper, results, status)
  // Only bound the visual preview; submission always retains the entire selection.
  const preview = text.length > 1200 ? `${text.slice(0, 1200)}\n… (предпросмотр сокращён, полный текст будет добавлен)` : text
  const form = element('form', {}, fields, element('blockquote', { class: 'note-excerpt-preview' }, preview))
  form.addEventListener('submit', event => event.preventDefault())
  let selected, requestId = crypto.randomUUID(), sequence = 0, timer, closed = false, pending = false
  const controller = new AbortController()
  const modal = openSheet({
    title: 'Выдержка в базу знаний', description: 'Выбранный текст добавляется со ссылкой на исходную заметку и создаётся связь. Исходная заметка сохраняется, текст не синхронизируется.',
    body: form, primaryLabel: 'Добавить выдержку',
    onClose: () => { closed = true; clearTimeout(timer); controller.abort() },
    onPrimary: async () => {
      if (mode.input.value === 'existing' && !selected) throw new Error('Сначала выберите документ знаний, доступный для правки.')
      if (mode.input.value === 'new' && !title.input.value.trim()) throw new Error('Укажите заголовок нового документа.')
      if (mode.input.value === 'new') { await groupField?.ready; groupField?.validate(); if (!groupField?.value() || groupField.value() === 'без группы') throw new Error('Выберите группу для нового документа.') }
      pending = true
      fields.disabled = true
      try {
        const entry = await api('note-excerpts', { method: 'POST', body: {
          requestId, noteId: node.id, text, knowledgeBaseId: base.input.value,
          ...(mode.input.value === 'existing' ? { documentId: selected.id, expectedVersion: selected.version } : { title: title.input.value.trim(), group: groupField.value() }),
        } })
        showToast(`Добавлено в «${entry.title}» со ссылкой на исходную заметку.`)
        return true
      } catch (error) {
        if (error.status === 409) { selected = undefined; status.textContent = 'Документ изменился — выберите цель заново.'; requestId = crypto.randomUUID() }
        throw error
      } finally { pending = false; fields.disabled = false }
    },
  })
  const primary = modal.dialog.querySelector('.dialog-footer button:last-child')
  function sync() { primary.disabled = pending || (mode.input.value === 'existing' ? !selected : !title.input.value.trim()) }
  async function load(cursor) {
    const current = ++sequence
    if (closed || mode.input.value !== 'existing') return
    const query = search.input.value.trim()
    if (!query) {
      selected = undefined; results.replaceChildren(); results.hidden = true
      status.textContent = 'Введите запрос для поиска или «/» для просмотра документов по каталогу.'
      sync(); return
    }
    results.hidden = false
    if (!cursor) { selected = undefined; results.replaceChildren(); status.textContent = 'Чтение документа…'; sync() }
    try {
      const params = new URLSearchParams({ knowledgeBaseId: base.input.value, q: query === '/' ? '' : query, active: '1', limit: '50', ...(cursor ? { cursor } : {}) })
      const page = await api(`document-index?${params}`, { signal: controller.signal })
      if (closed || current !== sequence) return
      results.querySelector('[data-load-more]')?.remove()
      for (const doc of page.items) {
        const button = element('button', { type: 'button', class: 'note-picker-row note-excerpt-document-row', title: doc.title, 'aria-label': doc.title, disabled: doc.documentState !== 'open', 'aria-pressed': 'false' },
          element('span', {}, element('strong', {}, doc.title), element('small', { title: doc.relPath || '' }, `${doc.relPath || 'корень'}${doc.documentState === 'open' ? '' : ' · завершён, дополнение невозможно'}`)))
        button.addEventListener('click', async () => {
          if (pending) return
          const choice = ++sequence
          selected = undefined; sync(); status.textContent = 'Чтение целевой версии…'
          try {
            const entry = await api(`entries/${encodeURIComponent(doc.id)}`, { signal: controller.signal })
            if (closed || choice !== sequence) return
            if (entry.status !== 'active' || entry.documentState !== 'open' || entry.knowledgeBaseId !== base.input.value) throw new Error('Документ перемещён или недоступен — выполните поиск заново.')
            selected = entry; requestId = crypto.randomUUID()
            results.querySelectorAll('button[aria-pressed]').forEach(item => item.setAttribute('aria-pressed', String(item === button)))
            status.textContent = `Будет добавлено в: ${entry.title}`; sync()
          } catch (error) { if (!closed && choice === sequence) status.textContent = friendlyError(error) }
        })
        results.append(button)
      }
      if (page.nextCursor) {
        const more = element('button', { type: 'button', class: 'note-picker-row note-excerpt-document-row', 'data-load-more': '' }, 'Загрузить ещё')
        more.addEventListener('click', () => { more.disabled = true; void load(page.nextCursor) })
        results.append(more)
      }
      status.textContent = results.children.length ? 'Выберите целевой документ или переключитесь на создание нового.' : 'Подходящих документов нет — можно создать новый.'
    } catch (error) {
      if (!closed && current === sequence) {
        status.textContent = friendlyError(error)
        const more = results.querySelector('[data-load-more]')
        if (more) more.disabled = false
        else {
          const retry = element('button', { type: 'button', class: 'note-picker-row note-excerpt-document-row' }, 'Перезагрузить документ')
          retry.addEventListener('click', () => { void load() })
          results.replaceChildren(retry)
        }
      }
    }
  }
  base.input.addEventListener('change', () => { requestId = crypto.randomUUID(); if (mode.input.value === 'existing') void load(); else { loadGroup(); sync() } })
  mode.input.addEventListener('change', () => {
    clearTimeout(timer); sequence++; requestId = crypto.randomUUID(); selected = undefined
    const creating = mode.input.value === 'new'
    groupSlot.hidden = !creating
    if (creating) loadGroup()
    title.wrapper.hidden = !creating; search.wrapper.hidden = creating; results.hidden = creating
    status.textContent = creating ? 'Будет создан документ со ссылкой на исходную заметку.' : 'Выберите целевой документ'
    sync(); if (!creating) void load()
  })
  title.input.addEventListener('input', () => { requestId = crypto.randomUUID(); sync() })
  search.input.addEventListener('input', () => {
    clearTimeout(timer); sequence++; selected = undefined; results.replaceChildren(); results.hidden = true; sync()
    if (!search.input.value.trim()) { void load(); return }
    status.textContent = 'Поиск документов…'
    timer = setTimeout(() => void load(), 200)
  })
  sync(); void load()
}
