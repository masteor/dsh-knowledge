/** Conflict resolution is explicit: the remote version becomes the new base,
 * and the user's chosen text remains a draft until saved with a version check. */
export function openSyncConflict({ element, actionButton, openModal, openConfirm, renderDiff, local, remote, apply, useRemote, canEdit = true, allowTitle = true }) {
  const title = element('input', { class: 'input', value: local.title, 'aria-label': 'Объединённый заголовок', disabled: !canEdit || !allowTitle })
  const content = element('textarea', { class: 'input sync-merge-content', 'aria-label': 'Объединённый текст', spellcheck: 'false', disabled: !canEdit }, local.content)
  const remoteText = element('textarea', { class: 'input sync-merge-content', readonly: true, 'aria-label': 'Новый текст с сервера', spellcheck: 'false' }, remote.content)
  let modal
  const body = element('div', { class: 'sync-conflict-body' },
    element('p', {}, 'Ваши несохранённые правки сохранены. Сверьте их с новой версией, примените и вернитесь в документ нажать «Сохранить»; при сохранении версия проверяется снова.'),
    element('details', {}, element('summary', {}, 'Сравнить новую версию с локальным черновиком'), renderDiff(remote.content, local.content, 'Новая версия → локальный черновик')),
    element('div', { class: 'sync-merge-columns' },
      element('section', {}, element('h3', {}, 'Новая версия с сервера'), element('p', {}, remote.title), remoteText),
      element('section', {}, element('h3', {}, 'Привести в порядок объединённый черновик'), title, content)),
    !canEdit ? element('p', { role: 'status' }, 'Этот документ запечатан или архивирован, сохранить напрямую нельзя. Черновик останется в исходном редакторе.') : null,
    actionButton('Отменить локальные правки и взять новую версию', () => openConfirm({
      title: 'Использовать новую версию?', message: 'Несохранённый черновик будет утерян.', confirmLabel: 'Отменить черновик и загрузить', danger: true,
      onConfirm: async () => { await useRemote(); modal.close(true) },
    }), 'small'),
  )
  modal = openModal({ title: 'У документа новая версия', description: 'Изменения ни одной из сторон не перезаписываются автоматически', body, className: 'sync-conflict-dialog', cancelLabel: 'Оставить черновик',
    ...(canEdit ? { primaryLabel: 'Применить к черновику', onPrimary: async () => { await apply({ title: title.value, content: content.value }); return true } } : {}),
  })
}
