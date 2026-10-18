'use strict'
;(() => {
const api = window.clipboardAPI
const $ = (id) => document.getElementById(id)
let items = []; let cursor = null; let selected = null; let status = {}; let busy = false; let visible = false
let queryGeneration = 0; let detailGeneration = 0; let debounce = null; let composing = false
let actionInFlight = false
let kind = ''; let pinnedOnly = false
// Must equal the .row height in clipboard.css: rows are positioned absolutely
// and the virtual window assumes a fixed pitch.
const rowHeight = 64
// Mono type stamps are instrument labels, not translated copy: they keep the
// same three-letter shape in every language.
const KIND_BADGE = { text: 'TXT', url: 'URL', image: 'IMG' }
const PHASE_TONE = { running: 'ok', starting: 'warn', paused: 'warn', error: 'danger', disabled: 'off', stopped: 'off' }
const actionButtons = ['copy', 'paste', 'pin', 'delete']
function result(value) { if (!value?.ok) throw new Error(value?.error?.code || 'CLIPBOARD_FAILED'); return value.result }
function message(error) {
  const key = `clipboard.error.${error.message.toLowerCase().replaceAll('_', '-')}`
  $('status').textContent = t(key) === key ? t('clipboard.failed') : t(key)
  $('led').className = 'led tone-danger'
}
function selectedItem() { return items.find((item) => item.id === selected) }
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KiB`
  return `${(bytes / 1048576).toFixed(1)} MiB`
}
function formatTime(value) {
  if (!Number.isFinite(value) || value <= 0) return ''
  try {
    return new Date(value).toLocaleString(currentLanguage(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  } catch { return new Date(value).toLocaleString() }
}
function detailMetaText(item) {
  return [item?.isPinned ? t('clipboard.pinned') : '', item?.sourceDisplayName, formatTime(Math.max(item?.lastCopiedAt || 0, item?.lastUsedAt || 0)), formatBytes(item?.byteLength)].filter(Boolean).join(' · ')
}
function pasteMessage(value) {
  const code = value?.error || value?.reason
  const key = code === 'CLIPBOARD_CHANGED' || code === 'COPY_INTERRUPTED' ? 'clipboard.paste-canceled' : value?.error ? `clipboard.error.${value.error.toLowerCase().replaceAll('_', '-')}` : value?.outcome === 'injected' ? 'clipboard.paste-sent' : 'clipboard.paste-copied-only'
  $('feedbackText').textContent = t(key) === key ? t('clipboard.failed') : t(key)
  $('feedback').setAttribute('data-tone', value?.error ? 'danger' : key === 'clipboard.paste-sent' ? 'ok' : 'warn')
  $('feedback').hidden = false
}
function appendText(parent, className, text) {
  const node = document.createElement('span')
  if (className) node.className = className
  node.textContent = text
  parent.append(node)
  return node
}
function renderRows() {
  if (selected) $('pin').textContent = t(selectedItem()?.isPinned ? 'clipboard.unpin' : 'clipboard.pin')
  const first = Math.max(0, Math.floor($('list').scrollTop / rowHeight) - 4)
  const end = Math.min(items.length, first + Math.ceil($('list').clientHeight / rowHeight) + 9)
  $('rows').replaceChildren(); $('rows').style.height = `${items.length * rowHeight}px`
  for (let index = first; index < end; index++) {
    const item = items[index]; const row = document.createElement('button')
    row.className = 'row'; row.type = 'button'; row.style.top = `${index * rowHeight}px`; row.id = `item-${item.id}`
    row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(selected === item.id)); row.tabIndex = -1
    const main = document.createElement('span'); main.className = 'row-main'
    appendText(main, 'row-preview', item.kind === 'image' ? t('clipboard.image-size', { width: item.width, height: item.height }) : String(item.previewText ?? ''))
    const meta = document.createElement('span'); meta.className = 'row-meta'
    if (item.isPinned) appendText(meta, 'pin', t('clipboard.pinned'))
    appendText(meta, 'row-meta-value', [item.sourceDisplayName, formatTime(Math.max(item.lastCopiedAt || 0, item.lastUsedAt || 0)), formatBytes(item.byteLength)].filter(Boolean).join(' · '))
    main.append(meta)
    const badge = document.createElement('span')
    badge.className = 'kind-badge'; badge.textContent = KIND_BADGE[item.kind] || KIND_BADGE.text; badge.setAttribute('aria-hidden', 'true')
    row.append(badge, main)
    row.onclick = () => { $('list').focus(); select(item.id) }
    row.ondblclick = () => perform('copy')
    $('rows').append(row)
  }
  if (selected && document.getElementById(`item-${selected}`)) $('list').setAttribute('aria-activedescendant', `item-${selected}`)
  else $('list').removeAttribute('aria-activedescendant')
}
function renderStatus(value) {
  status = value || status
  $('pause').textContent = t(status.userPaused ? 'clipboard.resume' : 'clipboard.pause')
  const parts = [t(`clipboard.phase.${status.phase || 'disabled'}`), t('clipboard.count', { count: status.itemCount || 0 })]
  if (status.pinnedCount) parts.push(t('clipboard.pinned-count', { count: status.pinnedCount }))
  parts.push(`${((status.actualDiskBytes || 0) / 1048576).toFixed(1)} MiB`)
  if (status.pausedReasons?.length) parts.push(t('clipboard.runtime-paused'))
  $('status').textContent = parts.join(' · ')
  const tone = status.userPaused || status.pausedReasons?.length ? 'warn' : (PHASE_TONE[status.phase] || 'off')
  $('led').className = `led tone-${tone}`
  if (status.messageKey) message(new Error(status.messageKey))
}
async function refresh(append = false) {
  if (!visible || (append && (!cursor || busy))) return
  const ticket = ++queryGeneration
  busy = true
  try {
    const page = result(await api.list({ search: $('search').value, kind, pinnedOnly, cursor: append ? cursor : null, limit: 50 }))
    if (!visible || ticket !== queryGeneration) return
    if (!Array.isArray(page.items) || page.items.length > 100) throw new Error('PROTOCOL_FAILED')
    if (!append) { items = []; $('list').scrollTop = 0 }
    items.push(...page.items)
    if (items.length > 150) { const removed = items.length - 150; items.splice(0, removed); $('list').scrollTop = Math.max(0, $('list').scrollTop - removed * rowHeight) }
    cursor = page.cursor; $('more').hidden = !cursor; $('new').hidden = true
    if (!items.some((item) => item.id === selected)) { selected = null; clearDetail() }
    renderRows(); renderStatus(result(await api.status()))
    $('empty').hidden = items.length > 0
  } catch (error) { if (ticket === queryGeneration && visible) { message(error); if (error.message === 'CURSOR_STALE') $('new').hidden = false } }
  finally { if (ticket === queryGeneration) busy = false }
}
function clearDetail() {
  ++detailGeneration
  $('detail').hidden = true; $('text').textContent = ''; $('text').hidden = false
  $('detailBadge').textContent = ''; $('detailMeta').textContent = ''
  $('truncated').hidden = true; $('media').hidden = true
  $('image').removeAttribute('src'); $('image').hidden = true
}
// Opening the inspector shrinks the virtual list, which can leave the selected
// row half-clipped at the fold. Keep it fully in view (this runs once per
// selection, not on scroll, so manual scrolling is never fought).
function ensureSelectedVisible() {
  const index = items.findIndex((item) => item.id === selected)
  if (index < 0) return
  const top = index * rowHeight; const view = $('list').clientHeight
  if (top < $('list').scrollTop) $('list').scrollTop = top
  else if (top + rowHeight > $('list').scrollTop + view) $('list').scrollTop = top + rowHeight - view
}
async function select(id) {
  selected = id; renderRows(); clearDetail()
  const ticket = detailGeneration
  try {
    const detail = result(await api.detail(id))
    if (!visible || ticket !== detailGeneration || selected !== id) return
    const item = selectedItem()
    $('detail').hidden = false
    $('detailBadge').textContent = KIND_BADGE[detail.kind] || KIND_BADGE.text
    $('detailMeta').textContent = detailMetaText(item)
    $('text').textContent = detail.text || ''
    $('text').hidden = detail.kind === 'image'
    $('truncated').hidden = !detail.truncated
    $('pin').textContent = t(item?.isPinned ? 'clipboard.unpin' : 'clipboard.pin')
    ensureSelectedVisible()
    if (detail.kind === 'image') {
      const preview = result(await api.preview(id))
      if (!visible || ticket !== detailGeneration || selected !== id) return
      $('image').src = preview.url; $('image').hidden = false; $('media').hidden = false
      // The preview only gets its intrinsic size once the protocol image loads;
      // the inspector height changes then, so re-anchor the selected row.
      $('image').addEventListener('load', ensureSelectedVisible, { once: true })
      ensureSelectedVisible()
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
    if (action === 'pin' && selected) $('detailMeta').textContent = detailMetaText(selectedItem())
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
  } else if (event.key === 'Enter') {
    event.preventDefault()
    perform(event.ctrlKey || event.metaKey ? 'paste' : 'copy')
  } else if (event.key === 'Delete') { event.preventDefault(); perform('delete') }
}
document.onkeydown = (event) => { if (event.key === 'Escape' && !event.isComposing && !composing) api.close() }
$('search').oncompositionstart = () => { composing = true; clearTimeout(debounce) }
$('search').oncompositionend = () => { composing = false; searchChanged() }
// Keyboard-first flow: the panel opens with the search field focused, so Down
// hands focus to the list on the current (or first) record.
$('search').onkeydown = (event) => {
  if (event.key !== 'ArrowDown' || event.isComposing || composing) return
  event.preventDefault(); $('list').focus()
  const current = items.findIndex((item) => item.id === selected)
  const index = Math.max(0, Math.min(items.length - 1, current < 0 ? 0 : current + 1))
  if (items[index]) { $('list').scrollTop = Math.max(0, index * rowHeight - $('list').clientHeight / 2); select(items[index].id) }
}
function searchChanged() { if (composing) return; clearTimeout(debounce); debounce = setTimeout(() => refresh(), 120) }
$('search').oninput = searchChanged
$('kinds').onclick = (event) => {
  const button = event.target?.closest?.('button[data-kind]')
  if (!button) return
  kind = button.getAttribute('data-kind') || ''
  for (const chip of $('kinds').querySelectorAll('button[data-kind]')) chip.setAttribute('aria-pressed', String((chip.getAttribute('data-kind') || '') === kind))
  refresh()
}
$('pinned').onclick = () => {
  pinnedOnly = !pinnedOnly
  $('pinned').setAttribute('aria-pressed', String(pinnedOnly))
  refresh()
}
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
    visible = true; setLanguage(data.language); applyTranslations(); document.documentElement.lang = currentLanguage(); document.body.classList.toggle('dark', data.dark === true)
    if (/^#[0-9a-f]{6}$/i.test(data.mainColor || '')) document.documentElement.style.setProperty('--primary', data.mainColor)
    renderStatus(data.status); refresh().then(() => api.interactive(data.generation)); $('search').focus()
    $('feedback').hidden = true; if (data.pasteFeedback) pasteMessage(data.pasteFeedback)
  }),
  api.onStatus((data) => { if (visible) renderStatus(data) }),
  api.onHistory(() => { if (visible) $('new').hidden = false }),
  api.onHidden(clearHistory),
  api.onPasteResult((data) => {
    clearHistory(); document.body.classList.add('feedback-only')
    setLanguage(data.language); applyTranslations(); document.documentElement.lang = currentLanguage(); document.body.classList.toggle('dark', data.dark === true)
    pasteMessage(data.pasteFeedback)
  }),
  api.onLanguage((language) => { setLanguage(language); applyTranslations(); renderRows(); renderStatus(status) })
]
function clearHistory() {
  visible = false; ++queryGeneration; clearTimeout(debounce); items = []; cursor = null; selected = null; busy = false
  clearDetail(); renderRows(); $('search').value = ''; $('feedback').hidden = true
  $('empty').hidden = true; $('more').hidden = true; $('new').hidden = true
}
applyTranslations()
window.addEventListener('unload', () => { for (const cleanup of cleanups) cleanup(); clearTimeout(debounce) })
api.ready()

})()
