'use strict'
;(() => {
const api = window.clipboardAPI
const layoutApi = window.clipboardLayout
const $ = (id) => document.getElementById(id)
let items = []; let nextPage = null; let selected = null; let status = {}; let loading = false; let visible = false
let queryGeneration = 0; let detailGeneration = 0; let debounce = null; let composing = false
let actionInFlight = false
let kind = ''; let pinnedOnly = false
let model = { rows: [], itemRow: [], itemCol: [], height: 0 }
let metrics = null
let renderedWindow = { first: -1, last: -1, cols: -1, language: '' }
let animationFrame = 0
// Mono type stamps are instrument labels, not translated copy: they keep the
// same three-letter shape in every language.
const KIND_BADGE = { text: 'TXT', url: 'URL', image: 'IMG', files: 'FIL' }
const PHASE_TONE = { running: 'ok', starting: 'warn', paused: 'warn', error: 'danger', disabled: 'off', stopped: 'off' }
const actionButtons = ['copy', 'paste', 'view', 'pin', 'delete']
// Fallbacks only: the values that matter live in clipboard.css as custom
// properties on #list (one source of truth), plus the DPR media queries there.
const FALLBACK = { rowH: 64, cellH: 92, gap: 8, padX: 10, target: 110, min: 72 }
const OVERSCAN = 2
// One retry per thumbnail: a hidden panel revokes tokens, so an <img> that was
// already assigned src while the panel hid would otherwise stay blank forever.
const THUMB_RETRY_MS = 500
let thumbGeneration = 0
const thumbCache = new Map()
let thumbInFlight = new Set()
// A05 preview state. The overlay keeps no URL map of its own: exactly one <img>
// exists while the preview is open, and closing it drops the element (and its
// capability src) so the decoded bitmap can be collected. previewGeneration
// discards a lazy previews() response that lands after the overlay closed.
const previewApi = window.clipboardPreview
// One source of truth for the ceiling: the pure module owns the constant and
// the renderer only passes it through.
const PREVIEW_MAX_SCALE = previewApi?.MAX_PREVIEW_SCALE || 2
let previewGeneration = 0
// N02 (report section 5.2): one-click image actions. The renderer only submits the
// record id; OCR / the Excel export / the pin bridge all run in main and return a
// value. One action at a time keeps a double click (or a preview button plus the
// context menu) from starting two decodes, and the buttons stay disabled while it
// runs. IMAGE_ACTION_BUTTONS is the single list both surfaces use.
const IMAGE_ACTION_BUTTONS = ['previewOcr', 'previewTable', 'previewPin', 'menuOcr', 'menuTable', 'menuPin']
let imageAction = null
let ocrText = ''
let ocrCopyPending = false
let contextItemId = null
// Text rows keep only the detail text needed to cut a snippet around a search
// hit. Bounded and cleared with the filter, because a full entry can be 64 KiB.
const SNIPPET_CACHE_LIMIT = 24
const snippetCache = new Map()
const snippetPending = new Set()
const snippetFailed = new Set()
const snippetQueue = []
let snippetActive = 0
let snippetGeneration = 0
// ClipboardService rejects with BACKPRESSURE once 16 requests are pending. A
// fast scroll can mount enough hit rows to reach that, so snippet detail
// requests run through a small queue instead of one burst per render pass.
const SNIPPET_CONCURRENCY = 4
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
function imageLabel(item) {
  const size = t('clipboard.image-size', { width: item.width, height: item.height })
  return [size, item.sourceDisplayName, formatTime(Math.max(item.lastCopiedAt || 0, item.lastUsedAt || 0)), item.isPinned ? t('clipboard.pinned') : ''].filter(Boolean).join(' · ')
}
// ---------- N02: one-click image actions ----------
//
// Every action submits exactly one record id. The reply is a value (OCR text, a
// base file name, or the pin fallback flag); the page never receives pixels, a
// path or a URL. Failures are stable error codes rendered through the same
// clipboard.error.* table the copy/paste path uses.
function imageActionErrorText(error) {
  const code = String(error?.message || '')
  const key = `clipboard.error.${code.toLowerCase().replaceAll('_', '-')}`
  return t(key) === key ? t('clipboard.failed') : t(key)
}
// A notice belongs to whichever surface is on top: the preview overlay, the OCR
// result sheet, or - when the action came from a tile's context menu - the status
// rail that is still visible behind the list.
function showNotice(element, text, tone = 'ok') {
  if (!element) return
  element.textContent = text || ''
  element.hidden = !text
  if (text) element.setAttribute('data-tone', tone)
  else element.removeAttribute('data-tone')
}
function statusNotice(text, tone = 'ok') {
  if (!text) return
  $('status').textContent = text
  $('led').className = `led tone-${tone === 'danger' ? 'danger' : tone === 'warn' ? 'warn' : 'ok'}`
}
function showImageNotice(origin, text, tone = 'ok') {
  if (origin === 'preview' && previewOpen()) showNotice($('previewNotice'), text, tone)
  else if (origin === 'ocr' && !$('ocr').hidden) showNotice($('ocrNotice'), text, tone)
  else statusNotice(text, tone)
}
function setImageActionsBusy(busy) {
  for (const id of IMAGE_ACTION_BUTTONS) {
    const button = $(id)
    if (button) button.disabled = busy
  }
  $('preview').setAttribute('aria-busy', String(busy))
  $('contextMenu').setAttribute('aria-busy', String(busy))
}
function openOcrSheet(item, value) {
  ocrText = String(value?.text || '')
  $('ocrText').textContent = ocrText || t('clipboard.ocr-empty')
  $('ocrCopy').disabled = !ocrText
  const meta = [imageLabel(item)]
  if (value?.lineCount) meta.push(t('clipboard.ocr-lines', { count: value.lineCount }))
  if (value?.lowResolution) meta.push(t('clipboard.ocr-low-resolution'))
  $('ocrMeta').textContent = meta.filter(Boolean).join(' · ')
  showNotice($('ocrNotice'), '', 'ok')
  showNotice($('previewNotice'), '', 'ok')
  $('ocr').hidden = false
  $('ocrClose').focus()
}
function closeOcrSheet(options = {}) {
  const wasOpen = !$('ocr').hidden
  $('ocr').hidden = true
  $('ocrText').textContent = ''
  $('ocrMeta').textContent = ''
  showNotice($('ocrNotice'), '', 'ok')
  ocrText = ''
  $('ocrCopy').disabled = true
  if (!wasOpen || options.restoreFocus === false) return
  if (previewOpen()) $('previewClose').focus()
  else $('list').focus()
}
async function copyOcrText() {
  if (!ocrText || ocrCopyPending) return
  ocrCopyPending = true
  $('ocrCopy').disabled = true
  try {
    result(await api.copyText(ocrText))
    showNotice($('ocrNotice'), t('clipboard.ocr-copied'), 'ok')
  } catch (error) {
    showNotice($('ocrNotice'), imageActionErrorText(error), 'danger')
  } finally {
    ocrCopyPending = false
    $('ocrCopy').disabled = !ocrText
  }
}
async function runImageAction(action, item, origin) {
  if (!item || item.kind !== 'image' || imageAction) return
  imageAction = action
  setImageActionsBusy(true)
  closeContextMenu()
  if (origin === 'preview') showNotice($('previewNotice'), t('clipboard.image-action-working'), 'warn')
  try {
    if (action === 'ocr') {
      const value = result(await api.imageOcr(item.id))
      if (!visible) return
      openOcrSheet(item, value)
    } else if (action === 'table') {
      const value = result(await api.imageTable(item.id))
      if (!visible) return
      // A cancelled save dialog wrote nothing and needs no message: the panel
      // simply stays as it was.
      if (value?.canceled) { if (origin === 'preview') showNotice($('previewNotice'), '', 'ok') }
      else showImageNotice(origin, t('clipboard.table-saved', { name: String(value?.name || '') }), 'ok')
    } else if (action === 'pin') {
      const value = result(await api.imagePin(item.id))
      if (!visible) return
      showImageNotice(origin, t(value?.pinned === true ? 'clipboard.pin-done' : 'clipboard.pin-fallback'), value?.pinned === true ? 'ok' : 'warn')
    }
  } catch (error) {
    if (!visible) return
    const text = imageActionErrorText(error)
    if (origin === 'preview') showNotice($('previewNotice'), text, 'danger')
    else statusNotice(text, 'danger')
  } finally {
    imageAction = null
    setImageActionsBusy(false)
  }
}
// The context menu is attached to image tiles only: those are the records these
// three actions accept, and a text row keeps its existing keyboard/Enter model.
function openContextMenu(item, event) {
  if (!item || item.kind !== 'image' || !visible || imageAction) return
  event?.preventDefault?.()
  event?.stopPropagation?.()
  contextItemId = item.id
  if (selected !== item.id) select(item.id)
  const menu = $('contextMenu')
  const width = 168
  const height = 100
  const viewportWidth = Number(window.innerWidth) || 480
  const viewportHeight = Number(window.innerHeight) || 640
  const left = Math.max(4, Math.min(Number(event?.clientX) || 0, viewportWidth - width - 4))
  const top = Math.max(4, Math.min(Number(event?.clientY) || 0, viewportHeight - height - 4))
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
  menu.hidden = false
  $('menuOcr').focus?.()
}
function closeContextMenu(options = {}) {
  if ($('contextMenu').hidden) return
  $('contextMenu').hidden = true
  contextItemId = null
  if (options.restoreFocus) $('list').focus()
}
function contextAction(action) {
  const id = contextItemId
  // Return focus to the grid before the action replaces the menu; the outcome
  // notice then lands in the status rail without stranding keyboard focus.
  closeContextMenu({ restoreFocus: true })
  const item = items.find((entry) => entry.id === id) || selectedItem()
  if (item) runImageAction(action, item, 'status')
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
// Geometry is read from the stylesheet, never duplicated in script: #list
// declares --row-h/--cell-h/--grid-gap/--grid-pad-x/--tile-target/--tile-min,
// and the DPR buckets live in the media queries next to them.
function readMetrics() {
  const style = typeof getComputedStyle === 'function' ? getComputedStyle($('list')) : null
  const num = (name, fallback) => {
    const value = style ? parseFloat(style.getPropertyValue(name)) : NaN
    return Number.isFinite(value) && value > 0 ? value : fallback
  }
  const dpr = Number(window.devicePixelRatio) > 0 ? Number(window.devicePixelRatio) : 1
  return {
    rowH: num('--row-h', FALLBACK.rowH), cellH: num('--cell-h', FALLBACK.cellH),
    gap: num('--grid-gap', FALLBACK.gap), padX: num('--grid-pad-x', FALLBACK.padX),
    target: num('--tile-target', FALLBACK.target), min: num('--tile-min', FALLBACK.min), dpr
  }
}
function currentLanguageName() { try { return currentLanguage() } catch { return '' } }
function columnCount() {
  const width = $('list').clientWidth || 0
  if (typeof layoutApi.computeColumns !== 'function') return 1
  // A panel that has not been laid out yet reports 0; rendering one wide column
  // and then reflowing to four would flash the grid, so keep the last known
  // count (or a sane default) instead of the degenerate 1-column answer.
  if (width < 1) return renderedWindow.cols > 0 ? renderedWindow.cols : 4
  return layoutApi.computeColumns(width, metrics)
}
function rebuildModel() {
  metrics = metrics || readMetrics()
  const cols = columnCount()
  const language = currentLanguageName()
  model = layoutApi.layout(items, { rowH: metrics.rowH, cellH: metrics.cellH, gap: metrics.gap, cols })
  model.cols = cols
  $('rows').style.setProperty('--cols', String(cols))
  $('rows').style.height = `${model.height}px`
  renderedWindow = { first: -1, last: -1, cols, language }
  return cols
}
function rowAt(y) { return layoutApi.rowAt(model, y) }
function selectedRow() {
  if (selected == null) return null
  const index = items.findIndex((item) => item.id === selected)
  if (index < 0) return null
  return { index, row: model.rows[model.itemRow[index]], col: model.itemCol[index] }
}
function scrollSelectionIntoView() {
  const found = selectedRow()
  if (!found || !found.row) return
  const view = $('list').clientHeight; const top = found.row.y
  if (top < $('list').scrollTop) $('list').scrollTop = top
  else if (top + found.row.h > $('list').scrollTop + view) $('list').scrollTop = top + found.row.h - view
}
function centerSelection() {
  const found = selectedRow()
  if (!found || !found.row) return
  const view = $('list').clientHeight
  const target = found.row.y + found.row.h / 2 - view / 2
  $('list').scrollTop = layoutApi.clamp(target, 0, Math.max(0, model.height - view))
}
function renderRows() {
  if (!metrics) return rebuildAndRender()
  const language = currentLanguageName()
  const view = $('list').clientHeight
  const first = Math.max(0, rowAt($('list').scrollTop) - OVERSCAN)
  const last = Math.min(model.rows.length - 1, rowAt($('list').scrollTop + view) + OVERSCAN)
  // Rebuilding the DOM on every scroll frame would recreate every <img> and
  // re-request each thumbnail, so skip when the window and locale are stable.
  if (first === renderedWindow.first && last === renderedWindow.last &&
      model.cols === renderedWindow.cols && language === renderedWindow.language) {
    syncSelection()
    return
  }
  renderedWindow = { first, last, cols: model.cols, language }
  $('rows').replaceChildren()
  for (let index = first; index <= last; index++) {
    const row = model.rows[index]
    if (!row) continue
    const node = row.type === 'images' ? renderImageRow(row) : renderTextRow(row)
    node.style.top = `${row.y}px`
    $('rows').append(node)
  }
  syncSelection()
  requestThumbnails().catch(() => {})
}
function syncSelection() {
  // Set selection from the mounted rows rather than by looking the id up in the
  // document: the selected record may be scrolled outside the virtual window, in
  // which case there is no node to find and the attribute would go stale.
  let mounted = false
  for (const node of $('rows').querySelectorAll('[data-item-id]')) {
    const isSelected = node.getAttribute('data-item-id') === selected
    node.setAttribute('aria-selected', String(isSelected))
    if (isSelected) mounted = true
  }
  if (selected && mounted) $('list').setAttribute('aria-activedescendant', `item-${selected}`)
  else $('list').removeAttribute('aria-activedescendant')
}
function optionId(item) { return `item-${item.id}` }
// A files record is a text row whose preview is the first file name (the native
// snapshot stores every path but previews the first basename), so the meta line
// carries how many paths the record holds. A single file needs no count.
function fileCountLabel(item) {
  return item.kind === 'files' && item.fileCount > 1 ? t('clipboard.file-count', { count: item.fileCount }) : ''
}
function renderTextRow(row) {
  const item = items[row.items[0]]; const node = document.createElement('button')
  node.className = 'row'; node.type = 'button'; node.id = optionId(item)
  node.setAttribute('role', 'option'); node.setAttribute('aria-selected', String(selected === item.id))
  node.setAttribute('data-item-id', item.id); node.tabIndex = -1
  const main = document.createElement('span'); main.className = 'row-main'
  const preview = document.createElement('span'); preview.className = 'row-preview'
  fillRowPreview(preview, item)
  main.append(preview)
  const meta = document.createElement('span'); meta.className = 'row-meta'
  if (item.isPinned) appendText(meta, 'pin', t('clipboard.pinned'))
  appendText(meta, 'row-meta-value', [fileCountLabel(item), item.sourceDisplayName, formatTime(Math.max(item.lastCopiedAt || 0, item.lastUsedAt || 0)), formatBytes(item.byteLength)].filter(Boolean).join(' · '))
  main.append(meta)
  const badge = document.createElement('span')
  badge.className = 'kind-badge'; badge.textContent = KIND_BADGE[item.kind] || KIND_BADGE.text; badge.setAttribute('aria-hidden', 'true')
  node.append(badge, main)
  node.onclick = () => { $('list').focus(); select(item.id) }
  node.ondblclick = () => perform('copy')
  // Only asks the main process when the stored 500-character preview does not
  // already contain the hit; a short record renders its snippet immediately.
  ensureSnippetText(item)
  return node
}
// An image record is a thumbnail plate and nothing else: no preview text, no
// size caption, no metadata line. The description lives on aria-label so a
// screen reader still gets it while the grid stays purely visual.
function renderImageRow(row) {
  const wrapper = document.createElement('div')
  wrapper.className = 'grid-row'; wrapper.setAttribute('role', 'presentation')
  for (const index of row.items) {
    const item = items[index]; const tile = document.createElement('div')
    tile.className = 'tile'; tile.id = optionId(item); tile.tabIndex = -1
    tile.setAttribute('role', 'option'); tile.setAttribute('aria-selected', String(selected === item.id))
    tile.setAttribute('data-item-id', item.id); tile.setAttribute('aria-label', imageLabel(item))
    // The detail action is hidden for images, so the tooltip is where Space is
    // discoverable without adding a control to the plate-only grid; the ARIA
    // shortcut covers the screen-reader path.
    tile.title = t('clipboard.preview-hint')
    tile.setAttribute('aria-keyshortcuts', 'Space')
    if (item.isPinned) tile.setAttribute('data-pinned', 'true')
    const image = document.createElement('img'); image.alt = ''; image.decoding = 'async'
    image.addEventListener('error', () => retryThumbnail(item.id, image))
    image.addEventListener('load', () => tile.removeAttribute('data-state'))
    tile.append(image)
    tile.onclick = () => { $('list').focus(); select(item.id) }
    tile.ondblclick = () => perform('copy')
    // N02: the right-click menu is the second entry point for the three image
    // actions; the preview overlay's action bar is the first.
    tile.oncontextmenu = (event) => openContextMenu(item, event)
    wrapper.append(tile)
  }
  return wrapper
}
// Thumbnails arrive as capability URLs, not stable resources: the main process
// revokes tokens on hide, so a tile that failed once gets exactly one retry.
function retryThumbnail(id, image) {
  if (image.dataset.retried === 'true') {
    const tile = image.closest ? image.closest('.tile') : null
    if (tile) markThumbnailFailed(tile, id)
    return
  }
  image.dataset.retried = 'true'
  // A load error can be a revoked capability URL (the panel was hidden) rather
  // than a broken record, so allow exactly one re-issue: drop both the URL and
  // the failure mark before asking again.
  thumbCache.delete(id)
  thumbFailed.delete(id)
  setTimeout(() => {
    if (image.isConnected === false) return
    if (thumbCache.has(id)) { image.src = thumbCache.get(id); return }
    assignThumbnail(id, image)
  }, THUMB_RETRY_MS)
}
// Failure is tracked separately from the URL map: storing an empty string would
// be indistinguishable from "not requested yet" and would re-issue the batch on
// every scroll frame.
const thumbFailed = new Set()
// F05 (report report section 3.5): a thumbnail URL is content-addressed per item id and a
// history event caused by a new record (or a pin toggle) cannot invalidate an
// existing entry. The old handler cleared `thumbCache`/`thumbFailed` and the
// in-flight marks on every `history` event, so each copy made the panel re-read
// every visible thumbnail. Entries are now dropped only when their record is
// known to be gone (explicit delete, or a refresh that no longer lists them) or
// when the whole panel history is cleared.
let historyThumbPrune = false
function dropThumbnails(ids) {
  for (const id of ids) { thumbCache.delete(id); thumbFailed.delete(id) }
}
function clearThumbnails() {
  thumbCache.clear(); thumbFailed.clear(); thumbInFlight.clear(); ++thumbGeneration
}
// Called after a list reload that followed a history event: only ids the backend
// no longer returns are evicted, so a new record does not disturb the rest.
function pruneThumbnails() {
  historyThumbPrune = false
  const live = new Set(items.filter((item) => item.kind === 'image').map((item) => item.id))
  for (const id of thumbCache.keys()) if (!live.has(id)) thumbCache.delete(id)
  for (const id of thumbFailed) if (!live.has(id)) thumbFailed.delete(id)
}
function assignThumbnail(id, image) {
  const tile = image.closest ? image.closest('.tile') : null
  if (thumbFailed.has(id)) { if (tile) markThumbnailFailed(tile, id); return }
  const cached = thumbCache.get(id)
  if (cached) { image.src = cached; return }
  if (tile) tile.setAttribute('data-state', 'loading')
  // A retry re-issues the batch, which applies every freshly issued URL to the
  // mounted tiles; this tile is included because it is still in the DOM.
  requestThumbnails().then(() => {
    const url = thumbCache.get(id)
    if (!url) { if (tile) markThumbnailFailed(tile, id); return }
    image.src = url
  }).catch(() => { if (tile) markThumbnailFailed(tile, id) })
}
// One batched IPC call per render pass: individual preview() calls would revoke
// each other's tokens, so they can never be issued in parallel. Runs after the
// rows are attached, because the batch is derived from the mounted tiles.
//
// Two failure modes this has to survive, both of which leave permanent blank
// plates if handled naively:
//   1. the panel hides or the history changes mid-flight. Tokens are revoked, so
//      the batch result must be discarded, but the in-flight marks must still be
//      released or those ids are never requested again for the session.
//   2. more mounted tiles than one batch may carry. The remainder has to be
//      requested in follow-up batches instead of silently dropped.
const THUMB_BATCH = 64
function requestThumbnails() {
  const wanted = []
  const seen = new Set()
  for (const tile of $('rows').querySelectorAll('.tile[data-item-id]')) {
    const id = tile.getAttribute('data-item-id')
    if (seen.has(id) || thumbCache.has(id) || thumbFailed.has(id) || thumbInFlight.has(id)) continue
    const item = items.find((entry) => entry.id === id)
    if (!item || item.kind !== 'image') continue
    seen.add(id); wanted.push(id)
  }
  if (!wanted.length) { applyThumbnails(); return Promise.resolve(thumbCache) }
  // Keep going until every mounted id has settled: a tall or wide panel can
  // mount more tiles than a single batch carries.
  return runThumbBatch(wanted).then(() => {
    const pending = wanted.filter((id) => !thumbCache.has(id) && !thumbFailed.has(id) && !thumbInFlight.has(id))
    if (pending.length && visible) return requestThumbnails()
    return thumbCache
  })
}
function runThumbBatch(wanted) {
  const ids = wanted.slice(0, THUMB_BATCH)
  const generation = thumbGeneration
  for (const id of ids) thumbInFlight.add(id)
  return Promise.resolve()
    .then(() => api.previews(ids))
    .then((page) => {
      // Always release the in-flight marks, even for a superseded batch: leaving
      // them set would make those ids unrequestable for the rest of the session.
      for (const id of ids) thumbInFlight.delete(id)
      if (generation !== thumbGeneration || !visible) return thumbCache
      for (const entry of result(page) || []) {
        if (!entry || !entry.id) continue
        // An entry with an error is recorded as a failure, not as an empty URL,
        // so the batch is not re-issued for the same broken record every frame.
        if (entry.url) thumbCache.set(entry.id, entry.url)
        else thumbFailed.add(entry.id)
      }
      applyThumbnails()
      return thumbCache
    })
    .catch((error) => { for (const id of ids) thumbInFlight.delete(id); throw error })
}
// Assign src only to mounted tiles: an <img> that is detached or that never got
// a URL must not be given an empty source (the window-security probe treats a
// failed scheme load as a console error).
function applyThumbnails() {
  for (const tile of $('rows').querySelectorAll('.tile[data-item-id]')) {
    const id = tile.getAttribute('data-item-id')
    const url = thumbCache.get(id)
    const image = tile.querySelector('img')
    if (!image) continue
    if (url) { if (image.getAttribute('src') !== url) image.src = url }
    else if (thumbFailed.has(id)) markThumbnailFailed(tile, id)
  }
}
// A plate that will not render is still a record: keep it selectable, but tell
// assistive tech the image is unavailable instead of announcing a normal image.
function markThumbnailFailed(tile, id) {
  tile.setAttribute('data-state', 'failed')
  const item = items.find((entry) => entry.id === id)
  if (item) {
    const label = [t('clipboard.thumbnail-unavailable'), imageLabel(item)].filter(Boolean).join(' · ')
    tile.setAttribute('aria-label', label)
  }
}
// B05: when the capacity view suspects pinned records are consuming the
// storage budget, the status rail offers the existing pinned filter as a
// one-click view. The control is created in script instead of clipboard.html so
// the panel's static element-id contract stays unchanged; insertion is skipped
// when the rail is absent (renderer tests load this file without a window).
const pinnedJump = document.createElement('button')
pinnedJump.type = 'button'
pinnedJump.className = 'quiet-button'
pinnedJump.hidden = true
pinnedJump.onclick = () => { if (!pinnedOnly && !pinnedJump.hidden) $('pinned').click() }
function refreshPinnedJump() {
  const squeezed = status?.capacity?.pinnedSqueeze?.possible === true
  pinnedJump.hidden = pinnedOnly || !squeezed
  pinnedJump.textContent = t('clipboard.pinned-only')
  pinnedJump.title = t('clipboard.pinned-only-hint')
  pinnedJump.setAttribute('aria-label', t('clipboard.pinned-only-hint'))
}
const refreshNode = $('refresh')
const statusRail = refreshNode?.closest?.('.status-rail')
if (statusRail) statusRail.insertBefore(pinnedJump, refreshNode)
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
  refreshPinnedJump()
  if (status.messageKey) message(new Error(status.messageKey))
}
async function refresh(append = false) {
  if (!visible) return
  const search = $('search').value
  if (append && (loading || actionInFlight || composing || !nextPage ||
      nextPage.search !== search || nextPage.kind !== kind || nextPage.pinnedOnly !== pinnedOnly)) return
  const filter = { search, kind, pinnedOnly }
  const ticket = ++queryGeneration
  // A new filter (search text, kind chip, pinned, refresh) retires the preview
  // and the detail text cached for the previous hit set before the IPC starts;
  // otherwise a slow list response could keep an overlay for the old filter. The
  // OCR sheet and the context menu belong to the same retired selection.
  if (!append) { closePreview({ restoreFocus: false }); closeOcrSheet({ restoreFocus: false }); closeContextMenu(); resetSnippets() }
  loading = true
  try {
    const page = result(await api.list({ ...filter, cursor: append ? nextPage.cursor : null, limit: 50 }))
    if (!visible || ticket !== queryGeneration) return
    if (!Array.isArray(page.items) || page.items.length > 100) throw new Error('PROTOCOL_FAILED')
    if (!append) { items = []; $('list').scrollTop = 0 }
    items.push(...page.items)
    if (items.length > 150) trimHistory()
    // F05: a reload following a history event is where a record that the backend
    // pruned disappears; evict only those ids instead of clearing the URL cache.
    if (historyThumbPrune) pruneThumbnails()
    nextPage = page.cursor ? { ...filter, cursor: page.cursor } : null
    $('more').hidden = !nextPage; $('new').hidden = true
    if (!items.some((item) => item.id === selected)) { selected = null; clearDetail() }
    $('empty').hidden = items.length > 0
    rebuildAndRender()
    const value = result(await api.status())
    if (ticket === queryGeneration && visible) renderStatus(value)
  } catch (error) {
    if (ticket === queryGeneration && visible) {
      message(error)
      if (append && error.message === 'CURSOR_STALE') {
        nextPage = null
        $('more').hidden = true; $('new').hidden = false
      }
    }
  } finally { if (ticket === queryGeneration) loading = false }
}
// Trimming past 150 records deletes rows from the head, so the old
// `scrollTop - removed * rowHeight` shortcut no longer holds: mixed rows have
// different heights. Re-anchor on the id that was at the top instead.
function trimHistory() {
  const removed = items.length - 150
  if (removed <= 0) return
  const list = $('list')
  const scrollTop = list.scrollTop
  const topRow = model.rows[rowAt(scrollTop)] || model.rows[0]
  const inner = topRow ? scrollTop - topRow.y : 0
  // The trim cuts from the head, so it can slice INTO the top row: the first
  // cell may disappear while later cells of the same row survive. Anchoring on
  // the row's first cell would then find nothing and jump to the very top, so
  // pick the first cell of that row that outlives the cut, and fall back to the
  // following row only when the whole row is removed.
  let anchorId = null
  if (topRow) {
    for (const index of topRow.items) {
      if (index >= removed) { anchorId = items[index]?.id ?? null; break }
    }
    if (anchorId == null) {
      const nextRow = model.rows[model.rows.indexOf(topRow) + 1]
      if (nextRow && nextRow.items.length) anchorId = items[nextRow.items[0]]?.id ?? null
    }
  }
  const previousCount = items.length
  items.splice(0, removed)
  if (previousCount === items.length) return
  // Tokens/URLs survive, but positions changed: rebuild before touching scrollTop
  // so the browser cannot clamp the new value against the old spacer height.
  rebuildModel()
  renderRows()
  const list2 = $('list')
  const at = anchorId == null ? -1 : items.findIndex((item) => item.id === anchorId)
  if (at < 0) { list2.scrollTop = 0; return }
  const row = model.rows[model.itemRow[at]]
  const target = row.y + Math.min(inner, row.h)
  list2.scrollTop = layoutApi.clamp(target, 0, Math.max(0, model.height - list2.clientHeight))
}
function rebuildAndRender() { rebuildModel(); renderRows(); refreshChrome() }
// Copy that lives on a control instead of in the layout still has to follow the
// interface language, so it is refreshed wherever the chrome is rebuilt.
function refreshChrome() {
  $('paste').title = t('clipboard.paste-hint')
  $('view').textContent = t('clipboard.view-text')
  renderSelectionActions()
}
function renderSelectionActions() {
  const item = selectedItem()
  $('pin').textContent = t(item?.isPinned ? 'clipboard.unpin' : 'clipboard.pin')
  $('pin').disabled = !item || actionInFlight
  $('view').hidden = !item || item.kind === 'image'
}
function clearDetail() {
  ++detailGeneration
  $('detail').hidden = true; $('text').textContent = ''; $('text').hidden = false
  $('detailBadge').textContent = ''; $('detailMeta').textContent = ''
  $('truncated').hidden = true; $('media').hidden = true
  $('image').removeAttribute('src'); $('image').hidden = true
  $('view').setAttribute('aria-expanded', 'false')
  $('view').textContent = t('clipboard.view-text')
}
// ---------- A05: on-demand image preview ----------
//
// The overlay is part of this page (no second BrowserWindow). It loads only the
// selected record's capability URL - the one already in thumbCache whenever the
// plate has rendered - and caps the display size with the pure fitPreview()
// helper. On close the <img> is detached and its src removed; the main process
// revokes every outstanding token when the panel hides (clipboard domain).
function previewOpen() { return !$('preview').hidden }
function previewBox() {
  const body = $('previewBody')
  const width = Number(body.clientWidth) || 0
  const height = Number(body.clientHeight) || 0
  // 10px padding + 1px border on each side, so the image cannot push the grid
  // into a scrollbar.
  return {
    width: width > 0 ? Math.max(96, width - 22) : 360,
    height: height > 0 ? Math.max(96, height - 22) : 300
  }
}
function previewCreatedText(item) {
  const stamp = item?.createdAt || Math.max(item?.lastCopiedAt || 0, item?.lastUsedAt || 0)
  const time = formatTime(stamp)
  return time ? t('clipboard.preview-created', { time }) : ''
}
function previewMetaText(item) {
  return [
    t('clipboard.image-size', { width: item.width, height: item.height }),
    previewCreatedText(item),
    item.sourceDisplayName,
    item.isPinned ? t('clipboard.pinned') : ''
  ].filter(Boolean).join(' · ')
}
function previewSize(width, height) {
  if (!previewApi || typeof previewApi.fitPreview !== 'function') return null
  return previewApi.fitPreview(width, height, previewBox(), { maxScale: PREVIEW_MAX_SCALE })
}
function releasePreviewImage() {
  const body = $('previewBody')
  // Removing the element is what releases the decoded bitmap; dropping the src
  // first also makes the release explicit to a reader (and to a test) instead
  // of relying on GC timing alone.
  for (const image of body.querySelectorAll('img')) image.removeAttribute('src')
  body.replaceChildren()
  body.removeAttribute('data-state')
  body.removeAttribute('aria-label')
}
function markPreviewFailed() {
  const body = $('previewBody')
  body.replaceChildren()
  body.setAttribute('data-state', 'failed')
  body.setAttribute('aria-label', t('clipboard.thumbnail-unavailable'))
  // The dialog's aria-describedby points at this line, so the failure is
  // announced without inventing a second live region.
  const item = selectedItem()
  $('previewMeta').textContent = [item ? previewMetaText(item) : '', t('clipboard.thumbnail-unavailable')].filter(Boolean).join(' · ')
}
function mountPreviewImage(item, url, ticket) {
  if (!visible || ticket !== previewGeneration) return
  const body = $('previewBody')
  const image = document.createElement('img')
  image.className = 'preview-image'
  image.alt = imageLabel(item)
  image.decoding = 'async'
  const initial = previewSize(item.width, item.height)
  if (initial) { image.width = initial.width; image.height = initial.height }
  image.addEventListener('error', () => { if (ticket === previewGeneration) markPreviewFailed() })
  image.addEventListener('load', () => {
    if (ticket !== previewGeneration) return
    // naturalWidth is the thumbnail's own edge (<= 240), which is the only
    // honest source for the 2x cap; metadata describes the original file.
    const fitted = previewSize(image.naturalWidth || item.width, image.naturalHeight || item.height)
    if (fitted) { image.width = fitted.width; image.height = fitted.height }
  })
  image.src = url
  body.removeAttribute('data-state')
  body.removeAttribute('aria-label')
  body.replaceChildren(image)
}
// One lazy request, only when the grid has no URL for the record yet (a plate
// that never rendered, or a thumbnail that failed once). A successful response
// also repairs the tile: the URL goes back into the same cache the grid uses.
async function requestPreviewUrl(item, ticket) {
  const generation = thumbGeneration
  try {
    const page = result(await api.previews([item.id]))
    if (!visible || ticket !== previewGeneration || generation !== thumbGeneration) return
    const entry = Array.isArray(page) ? page.find((value) => value && value.id === item.id) : null
    if (!entry?.url) { markPreviewFailed(); return }
    thumbFailed.delete(item.id)
    thumbCache.set(item.id, entry.url)
    applyThumbnails()
    mountPreviewImage(item, entry.url, ticket)
  } catch { if (visible && ticket === previewGeneration) markPreviewFailed() }
}
function refreshPreviewChrome() {
  if (!previewOpen()) return
  const item = selectedItem()
  if (!item) { closePreview({ restoreFocus: false }); return }
  const failed = $('previewBody').getAttribute('data-state') === 'failed'
  $('previewMeta').textContent = [previewMetaText(item), failed ? t('clipboard.thumbnail-unavailable') : ''].filter(Boolean).join(' · ')
  const image = $('previewBody').querySelector('.preview-image')
  if (image) image.alt = imageLabel(item)
}
function openPreview() {
  const item = selectedItem()
  if (!item || item.kind !== 'image' || !visible) return false
  const ticket = ++previewGeneration
  releasePreviewImage()
  $('previewMeta').textContent = previewMetaText(item)
  showNotice($('previewNotice'), '', 'ok')
  $('preview').hidden = false
  $('previewClose').focus()
  const cached = thumbCache.get(item.id)
  if (cached) { mountPreviewImage(item, cached, ticket); return true }
  $('previewBody').setAttribute('data-state', 'loading')
  requestPreviewUrl(item, ticket)
  return true
}
function closePreview(options = {}) {
  const wasOpen = previewOpen()
  // Invalidate first: a previews() response that lands after this point must not
  // mount an image over the restored list.
  ++previewGeneration
  // The OCR sheet is a child surface of the preview; closing the preview cannot
  // leave its text (or its focus trap) floating over the list.
  if (!$('ocr').hidden) closeOcrSheet({ restoreFocus: false })
  releasePreviewImage()
  $('preview').hidden = true
  $('previewMeta').textContent = ''
  showNotice($('previewNotice'), '', 'ok')
  if (wasOpen && options.restoreFocus !== false) {
    $('list').focus()
    if (selected != null) scrollSelectionIntoView()
  }
}

// ---------- A05: search-hit snippet ----------
//
// The row shows up to 48 code points on each side of the hit instead of the
// record's first 500 characters, so a hit near the end of a long text is
// visible without opening the full-text sheet. The stored preview is enough
// for most records; a record whose preview does not contain the hit asks for
// its (64 KiB-capped) detail text once and renders the fragment in place.
function snippetQuery() { return String($('search').value || '').trim() }
function snippetFor(item) {
  if (!previewApi || typeof previewApi.snippetAround !== 'function') return null
  const query = snippetQuery()
  if (!query) return null
  const text = snippetCache.has(item.id) ? snippetCache.get(item.id) : String(item.previewText ?? '')
  return previewApi.snippetAround(text, query)
}
function fillRowPreview(span, item) {
  span.replaceChildren()
  const snippet = snippetFor(item)
  if (!snippet) { appendText(span, '', String(item.previewText ?? '')); return }
  if (snippet.prefix) appendText(span, 'snippet-edge', '…')
  if (snippet.before) appendText(span, '', snippet.before)
  appendText(span, 'snippet-hit', snippet.match)
  if (snippet.after) appendText(span, '', snippet.after)
  if (snippet.suffix) appendText(span, 'snippet-edge', '…')
}
function ensureSnippetText(item) {
  if (!visible || !previewApi || typeof previewApi.snippetAround !== 'function') return
  const query = snippetQuery()
  if (!query || item.kind === 'image') return
  if (snippetCache.has(item.id) || snippetPending.has(item.id) || snippetFailed.has(item.id)) return
  const live = previewApi.snippetAround(String(item.previewText ?? ''), query)
  if (live) return
  snippetPending.add(item.id)
  snippetQueue.push({ id: item.id, ticket: snippetGeneration })
  pumpSnippets()
}
function pumpSnippets() {
  if (!visible) return
  while (snippetActive < SNIPPET_CONCURRENCY && snippetQueue.length) {
    const job = snippetQueue.shift()
    // A filter change invalidates queued work before it costs a backend round
    // trip; the generation check is the same one the response handler uses.
    if (job.ticket !== snippetGeneration) { snippetPending.delete(job.id); continue }
    snippetActive++
    api.detail(job.id).then((page) => {
      if (!visible || job.ticket !== snippetGeneration) return
      const detail = result(page)
      snippetCache.set(job.id, String(detail?.text ?? ''))
      while (snippetCache.size > SNIPPET_CACHE_LIMIT) snippetCache.delete(snippetCache.keys().next().value)
      refreshRowPreview(job.id)
    }).catch(() => { if (job.ticket === snippetGeneration) snippetFailed.add(job.id) })
      .finally(() => {
        snippetActive = Math.max(0, snippetActive - 1)
        snippetPending.delete(job.id)
        pumpSnippets()
      })
  }
}
function refreshRowPreview(id) {
  if (!visible) return
  const item = items.find((entry) => entry.id === id)
  if (!item) return
  for (const node of $('rows').querySelectorAll('[data-item-id]')) {
    if (node.getAttribute('data-item-id') !== id) continue
    const span = node.querySelector('.row-preview')
    if (span) fillRowPreview(span, item)
    return
  }
}
function resetSnippets() {
  ++snippetGeneration
  snippetCache.clear(); snippetPending.clear(); snippetFailed.clear(); snippetQueue.length = 0
}

// Selecting a record is now a pure selection: opening the inspector is an
// explicit action, so browsing the list never reshapes it.
async function select(id) {
  // A preview belongs to the record it was opened for; selecting another record
  // (for example through the accessibility tree) closes it without moving focus.
  if (previewOpen() && id !== selected) closePreview({ restoreFocus: false })
  if (id !== selected && !$('ocr').hidden) closeOcrSheet({ restoreFocus: false })
  selected = id
  renderRows(); clearDetail()
  renderSelectionActions()
}
async function openDetail() {
  const item = selectedItem()
  if (!item || item.kind === 'image') return false
  if (!$('detail').hidden) { clearDetail(); return true }
  const ticket = ++detailGeneration
  $('detail').hidden = false
  $('view').setAttribute('aria-expanded', 'true')
  $('detailBadge').textContent = KIND_BADGE[item.kind] || KIND_BADGE.text
  $('detailMeta').textContent = detailMetaText(item)
  $('truncated').hidden = true; $('media').hidden = true
  $('text').hidden = false; $('text').textContent = ''
  try {
    const detail = result(await api.detail(item.id))
    if (!visible || ticket !== detailGeneration || selected !== item.id) return true
    $('text').textContent = detail.text || ''
    $('text').hidden = detail.kind === 'image'
    $('truncated').hidden = !detail.truncated
  } catch (error) { if (ticket === detailGeneration && visible) message(error) }
  return true
}
async function perform(action) {
  const item = selectedItem()
  if (!item || loading || actionInFlight) return
  actionInFlight = true
  $('feedback').hidden = true
  for (const id of actionButtons) $(id).disabled = true
  try {
    const operation = crypto.randomUUID()
    if (action === 'copy') { result(await api.copy(item.id, operation)); $('status').textContent = t('clipboard.copied') }
    if (action === 'paste') pasteMessage(result(await api.paste(item.id, operation)))
    if (action === 'pin') result(await api.setPinned(item.id, !item.isPinned, operation))
    if (action === 'delete') { result(await api.delete([item.id], operation)); dropThumbnails([item.id]); selected = null; clearDetail() }
    if (['pin', 'delete'].includes(action)) await refresh()
    if (action === 'pin' && selected && !$('detail').hidden) $('detailMeta').textContent = detailMetaText(selectedItem())
  } catch (error) { if (action === 'paste') pasteMessage({ error: error.message }); else message(error) }
  finally {
    actionInFlight = false
    for (const id of actionButtons) $(id).disabled = false
    renderSelectionActions()
  }
}
function scheduleRender() {
  if (animationFrame) return
  const run = () => { animationFrame = 0; if (visible) renderRows() }
  animationFrame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 16)
}
function moveBy(delta) {
  if (!items.length) return null
  const index = items.findIndex((item) => item.id === selected)
  const start = index < 0 ? (delta > 0 ? -1 : items.length) : index
  return items[layoutApi.clamp(start + delta, 0, items.length - 1)]
}
// Arrow up/down follows the visual grid (same column, adjacent row); arrow
// left/right keeps reading order so the list stays fully reachable.
function moveVertical(direction) {
  const found = selectedRow()
  if (!found) return items[direction > 0 ? 0 : items.length - 1]
  // Read the row index from the model's own item index rather than searching the
  // rows array for the object identity; itemRow is the documented mapping.
  const rowIndex = layoutApi.clamp(model.itemRow[found.index], 0, model.rows.length - 1)
  const target = model.rows[layoutApi.clamp(rowIndex + direction, 0, model.rows.length - 1)]
  if (!target) return items[found.index]
  const column = Math.min(found.col, target.items.length - 1)
  const picked = items[target.items[Math.max(0, column)]]
  return picked || items[found.index]
}
// Scrolling retires the image context menu: it is anchored to viewport pixels,
// so it would otherwise float over unrelated rows after the grid moved.
$('list').onscroll = () => { closeContextMenu(); scheduleRender() }
$('list').addEventListener('scrollend', (event) => {
  if (!nextPage) return
  const list = event.currentTarget
  // scrollTop can be fractional at non-integer display scaling.
  if (list.scrollTop > 0 && list.scrollHeight - list.clientHeight - list.scrollTop <= 1) refresh(true)
})
if (typeof ResizeObserver === 'function') new ResizeObserver(() => { metrics = null; if (visible) rebuildAndRender() }).observe($('list'))
$('list').onkeydown = (event) => {
  if (event.isComposing || composing) return
  if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault()
    const picked = moveVertical(event.key === 'ArrowDown' ? 1 : -1)
    if (picked) { select(picked.id); centerSelection() }
  } else if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault()
    const picked = moveBy(event.key === 'ArrowRight' ? 1 : -1)
    if (picked) { select(picked.id); centerSelection() }
  } else if (['Home', 'End'].includes(event.key)) {
    event.preventDefault()
    const picked = event.key === 'Home' ? items[0] : items[items.length - 1]
    if (picked) { $('list').scrollTop = event.key === 'Home' ? 0 : Math.max(0, model.height - $('list').clientHeight); select(picked.id); scrollSelectionIntoView() }
  } else if (event.key === 'Enter') {
    event.preventDefault()
    perform(event.ctrlKey || event.metaKey ? 'paste' : 'copy')
  } else if (event.key === 'Delete') { event.preventDefault(); perform('delete') }
  else if (event.key === ' ') {
    event.preventDefault()
    // Images have no detail sheet (that action is hidden for them), so Space is
    // their preview; text/url/files keep the existing full-text behaviour.
    const item = selectedItem()
    if (item && item.kind === 'image') openPreview()
    else openDetail()
  }
}
// The preview owns the keyboard while it is open. stopPropagation keeps the
// document-level Escape handler from closing the whole panel on the same press.
// Tab cycles the overlay's own controls (three image actions + close) instead of
// escaping into the covered list behind it.
$('preview').onkeydown = (event) => {
  if (event.isComposing || composing) return
  if (event.key === 'Tab') {
    event.preventDefault()
    const controls = [['previewOcr'], ['previewTable'], ['previewPin'], ['previewClose']]
      .map(([id]) => $(id)).filter((node) => node && node.disabled !== true)
    const index = controls.indexOf(document.activeElement)
    const step = event.shiftKey ? -1 : 1
    controls[(Math.max(0, index) + step + controls.length) % controls.length].focus()
    return
  }
  if (event.key !== ' ' && event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  closePreview()
}
$('previewClose').onclick = () => closePreview()
$('previewOcr').onclick = () => runImageAction('ocr', selectedItem(), 'preview')
$('previewTable').onclick = () => runImageAction('table', selectedItem(), 'preview')
$('previewPin').onclick = () => runImageAction('pin', selectedItem(), 'preview')
// The OCR sheet is its own dialog above the preview. Escape closes only the sheet;
// Tab stays inside its two controls so focus cannot land on a covered layer.
$('ocr').onkeydown = (event) => {
  if (event.isComposing || composing) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeOcrSheet(); return }
  if (event.key !== 'Tab') return
  event.preventDefault()
  const controls = [$('ocrCopy'), $('ocrClose')].filter((node) => node && node.disabled !== true)
  const index = controls.indexOf(document.activeElement)
  const step = event.shiftKey ? -1 : 1
  controls[(Math.max(0, index) + step + controls.length) % controls.length].focus()
}
$('ocrCopy').onclick = () => copyOcrText()
$('ocrClose').onclick = () => closeOcrSheet()
// The context menu keeps list-style keyboard control: arrows move the highlight,
// Escape hands focus back to the grid.
$('contextMenu').onkeydown = (event) => {
  if (event.isComposing || composing) return
  const buttons = ['menuOcr', 'menuTable', 'menuPin'].map((id) => $(id)).filter((node) => node && node.disabled !== true)
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeContextMenu({ restoreFocus: true }); return }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  const index = buttons.indexOf(document.activeElement)
  const step = event.key === 'ArrowDown' ? 1 : -1
  buttons[(Math.max(0, index) + step + buttons.length) % buttons.length].focus()
}
$('menuOcr').onclick = () => contextAction('ocr')
$('menuTable').onclick = () => contextAction('table')
$('menuPin').onclick = () => contextAction('pin')
// A click anywhere outside the menu dismisses it; the menu-item handlers close it
// themselves first, so the same click cannot reopen anything.
document.onclick = (event) => {
  if ($('contextMenu').hidden) return
  if ($('contextMenu').contains?.(event?.target) === true) return
  closeContextMenu()
}
document.onkeydown = (event) => {
  if (event.key !== 'Escape' || event.isComposing || composing) return
  if (!$('ocr').hidden) { closeOcrSheet(); return }
  if (!$('contextMenu').hidden) { closeContextMenu({ restoreFocus: true }); return }
  if (!$('preview').hidden) { closePreview(); return }
  if (!$('detail').hidden) { clearDetail(); return }
  api.close()
}
$('search').oncompositionstart = () => { composing = true; clearTimeout(debounce) }
$('search').oncompositionend = () => { composing = false; searchChanged() }
// Keyboard-first flow: the panel opens with the search field focused, so Down
// hands focus to the list on the current (or first) record.
$('search').onkeydown = (event) => {
  if (event.key !== 'ArrowDown' || event.isComposing || composing) return
  event.preventDefault(); $('list').focus()
  const current = items.findIndex((item) => item.id === selected)
  const index = Math.max(0, Math.min(items.length - 1, current < 0 ? 0 : current + 1))
  if (items[index]) { select(items[index].id); centerSelection() }
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
  refreshPinnedJump()
  refresh()
}
$('refresh').onclick = () => refresh(); $('new').onclick = () => refresh(); $('more').onclick = () => refresh(true)
$('close').onclick = () => api.close(); $('copy').onclick = () => perform('copy'); $('pin').onclick = () => perform('pin'); $('delete').onclick = () => perform('delete')
$('paste').onclick = () => perform('paste')
$('view').onclick = () => openDetail()
$('pause').onclick = async () => { try { renderStatus(result(await api.setPaused(!status.userPaused))) } catch (error) { message(error) } }
$('clear').onclick = async () => {
  try { const prepared = result(await api.prepareClear('ordinary')); if (prepared.token) { result(await api.commitClear(prepared.token, crypto.randomUUID())); clearThumbnails(); selected = null; clearDetail(); await refresh() } }
  catch (error) { message(error) }
}
// The panel can follow the cursor to a display with a different scale factor;
// ResizeObserver never fires for that, so watch the resolution explicitly.
// A single (resolution: 1dppx) query only flips when the panel crosses 1x, so a
// move between 1.25x and 2.5x displays would leave the layout model on the old
// cell height while CSS had already switched buckets. Watch every bucket the
// stylesheet defines and re-subscribe, so any crossing re-reads the geometry.
const DPR_BUCKETS = [1.25, 1.5, 1.75, 2, 2.25, 2.5, 3]
let dprQueries = []
function detachDprQueries() {
  for (const query of dprQueries) {
    if (typeof query.removeEventListener === 'function') query.removeEventListener('change', onDprChange)
    else if (typeof query.removeListener === 'function') query.removeListener(onDprChange)
  }
  dprQueries = []
}
function onDprChange() { attachDprQueries(); metrics = null; if (visible) rebuildAndRender() }
function attachDprQueries() {
  detachDprQueries()
  if (typeof window.matchMedia !== 'function') return
  for (const bucket of DPR_BUCKETS) {
    const query = window.matchMedia(`(resolution: ${bucket}dppx)`)
    if (typeof query.addEventListener === 'function') query.addEventListener('change', onDprChange)
    else if (typeof query.addListener === 'function') query.addListener(onDprChange)
    else continue
    dprQueries.push(query)
  }
}
attachDprQueries()
const cleanups = [
  api.onInit((data) => {
    document.body.classList.remove('feedback-only')
    visible = true; setLanguage(data.language); applyTranslations(); document.documentElement.lang = currentLanguage(); document.body.classList.toggle('dark', data.dark === true)
    // Forward-compatible density: the app-level "compact layout" preference is
    // not in the clipboard appearance payload yet, so reading it here keeps the
    // panel ready without a main-process change. It only changes --row-h, so the
    // geometry is re-read while the list is still empty (refresh() below).
    document.body.classList.toggle('compact', data.compact === true)
    metrics = null
    if (/^#[0-9a-f]{6}$/i.test(data.mainColor || '')) document.documentElement.style.setProperty('--primary', data.mainColor)
    renderStatus(data.status); refresh().then(() => api.interactive(data.generation)); $('search').focus()
    $('feedback').hidden = true; if (data.pasteFeedback) pasteMessage(data.pasteFeedback)
  }),
  api.onStatus((data) => { if (visible) renderStatus(data) }),
  api.onHistory(() => { if (visible) { ++thumbGeneration; historyThumbPrune = true; thumbFailed.clear(); $('new').hidden = false } }),
  api.onHidden(clearHistory),
  api.onPasteResult((data) => {
    clearHistory(); document.body.classList.add('feedback-only')
    setLanguage(data.language); applyTranslations(); document.documentElement.lang = currentLanguage(); document.body.classList.toggle('dark', data.dark === true)
    pasteMessage(data.pasteFeedback)
  }),
  api.onLanguage((language) => { setLanguage(language); applyTranslations(); rebuildAndRender(); refreshPreviewChrome(); renderStatus(status) })
]
function clearHistory() {
  visible = false; ++queryGeneration; clearTimeout(debounce); items = []; nextPage = null; selected = null; loading = false
  composing = false
  clearThumbnails(); metrics = null; renderedWindow = { first: -1, last: -1, cols: -1, language: '' }
  clearDetail(); closePreview({ restoreFocus: false }); closeOcrSheet({ restoreFocus: false }); closeContextMenu(); resetSnippets()
  $('rows').replaceChildren(); $('rows').style.height = '0px'
  renderSelectionActions()
  $('search').value = ''; $('feedback').hidden = true
  $('empty').hidden = true; $('more').hidden = true; $('new').hidden = true
  pinnedJump.hidden = true
}
// Both action overlays ship hidden in the markup; setting the state explicitly
// keeps the renderer deterministic for harnesses whose stub elements start shown.
$('ocr').hidden = true; $('contextMenu').hidden = true
applyTranslations()
window.addEventListener('unload', () => {
  for (const cleanup of cleanups) cleanup()
  detachDprQueries()
  clearTimeout(debounce)
  if (animationFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(animationFrame)
})
api.ready()

})()
