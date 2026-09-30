/** Lazy workspace extension: no extra Host sidebar item, iframe, or polling. */
export function createWorklogWorkspace({ element, actionButton }) {
  const root = element('section', { class: 'knowledge-worklog', 'data-ui-owned': 'react', 'aria-label': 'Рабочая область журнала' })
  let disposed = false, unmount
  async function load() {
    root.replaceChildren(element('p', { role: 'status' }, 'Открытие журнала работы…'))
    try {
      const module = await import('/worklog-assets/workspace.js')
      if (!disposed) unmount = module.mount(root)
    } catch {
      if (!disposed) root.replaceChildren(element('div', { class: 'empty-state', role: 'alert' },
        element('h2', {}, 'Журнал работы недоступен'),
        element('p', {}, 'Не удалось загрузить встроенный модуль журнала. Обновите страницу; существующие документы не затронуты.'),
        actionButton('Перезагрузить', load)))
    }
  }
  void load()
  return { root, dispose() { disposed = true; unmount?.() } }
}
