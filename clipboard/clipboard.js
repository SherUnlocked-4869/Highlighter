'use strict'
;(() => {
const api = window.clipboardAPI
const $ = (id) => document.getElementById(id)
let items = []; let cursor = null; let selected = null; let status = {}; let busy = false; let visible = false
let queryGeneration = 0; let detailGeneration = 0; let debounce = null; let composing = false
let actionInFlight = false
const rowHeight = 72
const actionButtons = ['copy', 'paste', 'pin', 'delete']
function result(value) { if (!value?.ok) throw new Error(value?.error?.code || 'CLIPBOARD_FAILED'); return value.result }
function message(error) { $('status').textContent = t(`clipboard.error.${error.message.toLowerCase().replaceAll('_', '-')}`) === `clipboard.error.${error.message.toLowerCase().replaceAll('_', '-')}` ? t('clipboard.failed') : t(`clipboard.error.${error.message.toLowerCase().replaceAll('_', '-')}`) }
function selectedItem() { return items.find((item) => item.id === selected) }
function pasteMessage(value) {
  const code = value?.error || value?.reason
  const key = code === 'CLIPBOARD_CHANGED' || code === 'COPY_INTERRUPTED' ? 'clipboard.paste-canceled' : value?.error ? `clipboard.error.${value.error.toLowerCase().replaceAll('_', '-')}` : value?.outcome === 'injected' ? 'clipboard.paste-sent' : 'clipboard.paste-copied-only'
  $('feedback').textContent = t(key) === key ? t('clipboard.failed') : t(key)
  $('feedback').hidden = false
}
function renderRows() {
  if (selected) $('pin').textContent = t(selectedItem()?.isPinned ? 'clipboard.unpin' : 'clipboard.pin')
  const first = Math.max(0, Math.floor($('list').scrollTop / rowHeight) - 4)
  const end = Math.min(items.length, first + Math.ceil($('list').clientHeight / rowHeight) + 9)
  $('rows').replaceChildren(); $('rows').style.height = `${items.length * rowHeight}px`
  for (let index = first; index < end; index++) {
    const item = items[index]; const row = document.createElement('button')
    row.className = 'row'; row.style.top = `${index * rowHeight}px`; row.id = `item-${item.id}`
    row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(selected === item.id)); row.tabIndex = -1
    const preview = document.createElement('b'); preview.textContent = `${item.isPinned ? '★ ' : ''}${item.kind === 'image' ? t('clipboard.image-size', { width: item.width, height: item.height }) : item.previewText}`
    const metadata = document.createElement('small'); metadata.textContent = [item.sourceDisplayName, new Date(Math.max(item.lastCopiedAt, item.lastUsedAt)).toLocaleString(), `${Math.ceil(item.byteLength / 1024)} KiB`].filter(Boolean).join(' · ')
    row.append(preview, metadata); row.onclick = () => select(item.id); row.ondblclick = () => perform('copy')
    $('rows').append(row)
  }
  if (selected && document.getElementById(`item-${selected}`)) $('list').setAttribute('aria-activedescendant', `item-${selected}`)
  else $('list').removeAttribute('aria-activedescendant')
}
function renderStatus(value) {
  status = value || status
  $('pause').textContent = t(status.userPaused ? 'clipboard.resume' : 'clipboard.pause')
  const phase = t(`clipboard.phase.${status.phase || 'disabled'}`)
  $('status').textContent = `${phase} · ${status.itemCount || 0} · ${((status.actualDiskBytes || 0) / 1048576).toFixed(1)} MiB${status.pausedReasons?.length ? ` · ${t('clipboard.runtime-paused')}` : ''}`
  if (status.messageKey) message(new Error(status.messageKey))
}
async function refresh(append = false) {
  if (!visible || (append && (!cursor || busy))) return
  const ticket = ++queryGeneration
  busy = true
  try {
    const page = result(await api.list({ search: $('search').value, kind: $('kind').value, pinnedOnly: $('pinned').checked, cursor: append ? cursor : null, limit: 50 }))
    if (!visible || ticket !== queryGeneration) return
    if (!Array.isArray(page.items) || page.items.length > 100) throw new Error('PROTOCOL_FAILED')
    if (!append) { items = []; $('list').scrollTop = 0 }
    items.push(...page.items)
    if (items.length > 150) { const removed = items.length - 150; items.splice(0, removed); $('list').scrollTop = Math.max(0, $('list').scrollTop - removed * rowHeight) }
    cursor = page.cursor; $('more').hidden = !cursor; $('new').hidden = true
    if (!items.some((item) => item.id === selected)) { selected = null; clearDetail() }
    renderRows(); renderStatus(result(await api.status()))
    if (!items.length) $('status').textContent = t('clipboard.empty')
  } catch (error) { if (ticket === queryGeneration && visible) { message(error); if (error.message === 'CURSOR_STALE') $('new').hidden = false } }
  finally { if (ticket === queryGeneration) busy = false }
}
function clearDetail() { ++detailGeneration; $('detail').hidden = true; $('text').textContent = ''; $('image').removeAttribute('src'); $('image').hidden = true }
async function select(id) {
  selected = id; renderRows(); clearDetail()
  const ticket = detailGeneration
  try {
    const detail = result(await api.detail(id))
    if (!visible || ticket !== detailGeneration || selected !== id) return
    $('detail').hidden = false; $('text').textContent = detail.text || ''; $('truncated').hidden = !detail.truncated
    $('pin').textContent = t(selectedItem()?.isPinned ? 'clipboard.unpin' : 'clipboard.pin')
    if (detail.kind === 'image') {
      const preview = result(await api.preview(id))
      if (!visible || ticket !== detailGeneration || selected !== id) return
      $('image').src = preview.url; $('image').hidden = false
    }
  } catch (error) { if (ticket === detailGeneration && visible) message(error) }
}
async function perform(action) {
  const item = selectedItem()
  if (!item || busy || actionInFlight) return
  busy = true; actionInFlight = true
  $('feedback').hidden = true
  for (const id of actionButtons) $(id).disabled = true
  try {
    const operation = crypto.randomUUID()
    if (action === 'copy') { result(await api.copy(item.id, operation)); $('status').textContent = t('clipboard.copied') }
    if (action === 'paste') pasteMessage(result(await api.paste(item.id, operation)))
    if (action === 'pin') result(await api.setPinned(item.id, !item.isPinned, operation))
    if (action === 'delete') { result(await api.delete([item.id], operation)); selected = null; clearDetail() }
    if (['pin', 'delete'].includes(action)) await refresh()
  } catch (error) { if (action === 'paste') pasteMessage({ error: error.message }); else message(error) }
  finally { busy = false; actionInFlight = false; for (const id of actionButtons) $(id).disabled = false }
}
$('list').onscroll = renderRows
new ResizeObserver(renderRows).observe($('list'))
$('list').onkeydown = (event) => {
  if (event.isComposing || composing) return
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); let index = items.findIndex((item) => item.id === selected)
    index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
    if (items[index]) { $('list').scrollTop = Math.max(0, index * rowHeight - $('list').clientHeight / 2); select(items[index].id) }
  } else if (event.key === 'Enter') { event.preventDefault(); perform('copy') }
  else if (event.key === 'Delete') { event.preventDefault(); perform('delete') }
}
document.onkeydown = (event) => { if (event.key === 'Escape' && !event.isComposing && !composing) api.close() }
$('search').oncompositionstart = () => { composing = true; clearTimeout(debounce) }
$('search').oncompositionend = () => { composing = false; searchChanged() }
function searchChanged() { if (composing) return; clearTimeout(debounce); debounce = setTimeout(() => refresh(), 120) }
$('search').oninput = searchChanged; $('kind').onchange = () => refresh(); $('pinned').onchange = () => refresh()
$('refresh').onclick = () => refresh(); $('new').onclick = () => refresh(); $('more').onclick = () => refresh(true)
$('close').onclick = () => api.close(); $('copy').onclick = () => perform('copy'); $('pin').onclick = () => perform('pin'); $('delete').onclick = () => perform('delete')
$('paste').onclick = () => perform('paste')
$('pause').onclick = async () => { try { renderStatus(result(await api.setPaused(!status.userPaused))) } catch (error) { message(error) } }
$('clear').onclick = async () => {
  try { const prepared = result(await api.prepareClear('ordinary')); if (prepared.token) { result(await api.commitClear(prepared.token, crypto.randomUUID())); selected = null; clearDetail(); await refresh() } }
  catch (error) { message(error) }
}
const cleanups = [
  api.onInit((data) => {
    document.body.classList.remove('feedback-only')
    visible = true; setLanguage(data.language); applyTranslations(); document.documentElement.lang = currentLanguage(); document.documentElement.classList.toggle('dark', data.dark === true)
    if (/^#[0-9a-f]{6}$/i.test(data.mainColor || '')) document.documentElement.style.setProperty('--accent', data.mainColor)
    renderStatus(data.status); refresh().then(() => api.interactive(data.generation)); $('search').focus()
    $('feedback').hidden = true; if (data.pasteFeedback) pasteMessage(data.pasteFeedback)
  }),
  api.onStatus((data) => { if (visible) renderStatus(data) }),
  api.onHistory(() => { if (visible) $('new').hidden = false }),
  api.onHidden(clearHistory),
  api.onPasteResult((data) => {
    clearHistory(); document.body.classList.add('feedback-only')
    setLanguage(data.language); applyTranslations(); document.documentElement.lang = currentLanguage(); document.documentElement.classList.toggle('dark', data.dark === true)
    pasteMessage(data.pasteFeedback)
  }),
  api.onLanguage((language) => { setLanguage(language); applyTranslations(); renderRows(); renderStatus(status) })
]
function clearHistory() {
  visible = false; ++queryGeneration; clearTimeout(debounce); items = []; cursor = null; selected = null; busy = false
  clearDetail(); renderRows(); $('search').value = ''; $('feedback').hidden = true
}
window.addEventListener('unload', () => { for (const cleanup of cleanups) cleanup(); clearTimeout(debounce) })
api.ready()

})()
