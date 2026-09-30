/** Document classification controls. No document content or path mutations. */
export function createDocumentGroupField({ element, api, baseId, value = '', required = false, onChange = () => {} }) {
  const id = `document-group-${crypto.randomUUID()}`
  const newValue = `new-${crypto.randomUUID()}`
  const status = element('small', { class: 'muted', role: 'status' }, 'Чтение существующих групп…')
  const select = element('select', { id, class: 'select', 'aria-label': 'Группа документа' }, element('option', { value: '' }, 'Выбрать существующую группу'))
  const input = element('input', { type: 'text', class: 'input', maxlength: 64, value, placeholder: 'Например: деплой и эксплуатация, договорённости проекта', 'aria-label': 'Название новой группы' })
  input.hidden = true
  let groups = [], current = value
  const notify = () => {
    current = select.value === newValue ? input.value.trim() : select.value
    status.textContent = 'Сначала выберите существующую группу; если подходящей нет — создайте новую.'
    status.setAttribute('role', 'status')
    wrapper.querySelectorAll('[aria-invalid]').forEach(control => control.removeAttribute('aria-invalid'))
    onChange(current)
  }
  select.addEventListener('change', () => { input.hidden = select.value !== newValue; notify(); if (!input.hidden) input.focus() })
  input.addEventListener('input', notify)
  const wrapper = element('div', { class: 'document-group-field' }, element('label', { for: id }, `Группа документа${required ? ' *' : ''}`), select, input, status)
  const ready = api(`document-groups?${new URLSearchParams({ knowledgeBaseId: baseId })}`).then(result => {
    groups = result.filter(item => item.name)
    select.replaceChildren(element('option', { value: '' }, required ? 'Выберите группу' : 'без группы'),
      ...groups.map(item => element('option', { value: item.name }, `${item.name}（${item.count}）`)), element('option', { value: newValue }, '+ Новая группа…'))
    const matched = groups.find(item => item.name.normalize('NFKC').toLocaleLowerCase() === value.normalize('NFKC').trim().toLocaleLowerCase())
    select.value = matched?.name || (value ? newValue : '')
    if (matched) current = matched.name
    input.hidden = select.value !== newValue
    status.textContent = 'Сначала выберите существующую группу; если подходящей нет — создайте новую.'
    return groups
  }).catch(error => {
    status.textContent = `Не удалось прочитать группы: ${error.message}. Откройте заново и повторите.`
    select.disabled = true
    throw error
  })
  // Callers may await ready before saving. Avoid unhandled rejections in inline editors.
  void ready.catch(() => {})
  const validate = () => {
    const name = current.normalize('NFKC').trim().replace(/\s+/gu, ' ')
    const error = required && (!name || name === 'без группы') ? 'Выберите существующую группу или введите новую.'
      : name.length > 64 || /[\u0000-\u001f\u007f]/u.test(current) ? 'Название группы — до 64 символов, без управляющих символов.' : ''
    if (error) {
      status.textContent = error; status.setAttribute('role', 'alert')
      const control = input.hidden ? wrapper.querySelector('[role="combobox"]') || select : input
      control.setAttribute('aria-invalid', 'true'); control.focus()
      throw new Error(error)
    }
    return name
  }
  return { wrapper, ready, value: () => current, validate }
}

export function renderDocumentGroups({ element, documents, baseId, collapsed, searching, renderRow, onDrop, onNew }) {
  const groups = new Map()
  for (const doc of documents) { const name = doc.group || ''; if (!groups.has(name)) groups.set(name, []); groups.get(name).push(doc) }
  return [...groups].sort(([a], [b]) => !a ? 1 : !b ? -1 : a.localeCompare(b, 'zh-CN')).map(([name, members]) => {
    const key = JSON.stringify([baseId, name])
    let expanded = searching || !collapsed.has(key)
    const body = element('div', { class: 'document-group-body', role: 'group', 'aria-label': `Документы: ${name || 'без группы'}` })
    const toggle = element('button', { type: 'button', class: 'document-group-toggle', 'aria-expanded': String(expanded), onClick: () => {
      expanded = !expanded; if (expanded) collapsed.delete(key); else collapsed.add(key); paint()
    } }, element('span', { class: 'tree-disclosure', 'aria-hidden': 'true' }), element('span', { class: 'tree-folder-icon', 'aria-hidden': 'true' }),
    element('span', { class: 'document-group-name', title: name || 'без группы' }, name || 'без группы'), element('small', { title: 'Загружено документов' }, members.length))
    const paint = () => { toggle.setAttribute('aria-expanded', String(expanded)); body.hidden = !expanded; body.replaceChildren(...(expanded ? members.map(renderRow) : [])) }
    paint()
    return element('section', { class: 'document-tree-group', 'data-document-group': name, onDragOver: event => {
      if (!onDrop || !event.dataTransfer.types.includes('application/x-dsh-knowledge-document-id')) return
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'
    }, onDrop: event => { if (onDrop) { event.stopPropagation(); onDrop(event, name) } } },
    element('div', { class: 'document-group-heading' }, toggle, name && onNew ? element('button', { type: 'button', class: 'button ghost small document-group-add', 'aria-label': `Создать документ в ${name}`, title: 'Создать документ в этой группе', onClick: () => onNew(name) }, '+') : null), body)
  })
}

export async function openDocumentGroupOrganizer({ element, api, openSheet, baseId, onApply }) {
  const field = createDocumentGroupField({ element, api, baseId })
  const selected = new Set()
  let loaded = false
  const status = element('small', { class: 'muted', role: 'status' }, 'Чтение документа…')
  const list = element('div', { class: 'document-group-selection' })
  const controller = new AbortController()
  const body = element('div', { class: 'document-group-field' }, field.wrapper, status, list)
  const dialog = openSheet({ title: 'Упорядочить группы документов', description: 'Выберите документы и измените группы. «Без группы» лишь убирает принадлежность, документы не удаляются.', body, primaryLabel: 'Применить группу',
    onClose: () => controller.abort(),
    onPrimary: async () => { await field.ready; if (!loaded) throw new Error('Дождитесь загрузки документа; при ошибке откройте заново.'); if (!selected.size) throw new Error('Выберите хотя бы один документ.'); await onApply([...selected], field.validate()); return true },
  })
  try {
    let cursor, count = 0
    do {
      const page = await api(`document-index?${new URLSearchParams({ knowledgeBaseId: baseId, limit: '100', ...(cursor ? { cursor } : {}) })}`, { signal: controller.signal })
      for (const doc of page.items) {
        const check = element('input', { type: 'checkbox', 'aria-label': doc.title, onChange: event => { if (event.target.checked) selected.add(doc.id); else selected.delete(doc.id) } })
        list.append(element('label', { class: 'document-group-choice' }, check, element('span', {}, element('strong', { title: doc.title }, doc.title), element('small', {}, doc.group || 'без группы'))))
      }
      count += page.items.length; cursor = page.nextCursor
      status.textContent = `Загружено ${count} / ${page.total}; за раз не более 500.`
    } while (cursor && count < 500)
    loaded = true
  } catch (error) { if (!controller.signal.aborted) status.textContent = `Ошибка чтения: ${error.message}` }
  return dialog
}
