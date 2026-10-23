'use strict'
;(() => {
const api = window.clipboardAPI
const layoutApi = window.clipboardLayout
const $ = (id) => document.getElementById(id)
let items = []; let cursor = null; let selected = null; let status = {}; let busy = false; let visible = false
let queryGeneration = 0; let detailGeneration = 0; let debounce = null; let composing = false
let actionInFlight = false
let kind = ''; let pinnedOnly = false
let model = { rows: [], itemRow: [], itemCol: [], height: 0 }
let metrics = null
let renderedWindow = { first: -1, last: -1, cols: -1, language: '' }
let animationFrame = 0
// Mono type stamps are instrument labels, not translated copy: they keep the
// same three-letter shape in every language.
const KIND_BADGE = { text: 'TXT', url: 'URL', image: 'IMG' }
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
  if (selected) $('pin').textContent = t(selectedItem()?.isPinned ? 'clipboard.unpin' : 'clipboard.pin')
  $('view').hidden = !selected || selectedItem()?.kind === 'image'
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
function renderTextRow(row) {
  const item = items[row.items[0]]; const node = document.createElement('button')
  node.className = 'row'; node.type = 'button'; node.id = optionId(item)
  node.setAttribute('role', 'option'); node.setAttribute('aria-selected', String(selected === item.id))
  node.setAttribute('data-item-id', item.id); node.tabIndex = -1
  const main = document.createElement('span'); main.className = 'row-main'
  appendText(main, 'row-preview', String(item.previewText ?? ''))
  const meta = document.createElement('span'); meta.className = 'row-meta'
  if (item.isPinned) appendText(meta, 'pin', t('clipboard.pinned'))
  appendText(meta, 'row-meta-value', [item.sourceDisplayName, formatTime(Math.max(item.lastCopiedAt || 0, item.lastUsedAt || 0)), formatBytes(item.byteLength)].filter(Boolean).join(' · '))
  main.append(meta)
  const badge = document.createElement('span')
  badge.className = 'kind-badge'; badge.textContent = KIND_BADGE[item.kind] || KIND_BADGE.text; badge.setAttribute('aria-hidden', 'true')
  node.append(badge, main)
  node.onclick = () => { $('list').focus(); select(item.id) }
  node.ondblclick = () => perform('copy')
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
    if (item.isPinned) tile.setAttribute('data-pinned', 'true')
    const image = document.createElement('img'); image.alt = ''; image.decoding = 'async'
    image.addEventListener('error', () => retryThumbnail(item.id, image))
    image.addEventListener('load', () => tile.removeAttribute('data-state'))
    tile.append(image)
    tile.onclick = () => { $('list').focus(); select(item.id) }
    tile.ondblclick = () => perform('copy')
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
    if (items.length > 150) trimHistory()
    cursor = page.cursor; $('more').hidden = !cursor; $('new').hidden = true
    if (!items.some((item) => item.id === selected)) { selected = null; clearDetail() }
    rebuildAndRender(); renderStatus(result(await api.status()))
    $('empty').hidden = items.length > 0
  } catch (error) { if (ticket === queryGeneration && visible) { message(error); if (error.message === 'CURSOR_STALE') $('new').hidden = false } }
  finally { if (ticket === queryGeneration) busy = false }
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
// Selecting a record is now a pure selection: opening the inspector is an
// explicit action, so browsing the list never reshapes it.
async function select(id) {
  selected = id
  renderRows(); clearDetail()
  const item = selectedItem()
  if (item?.kind !== 'image') $('view').hidden = false
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
    if (action === 'pin' && selected && !$('detail').hidden) $('detailMeta').textContent = detailMetaText(selectedItem())
  } catch (error) { if (action === 'paste') pasteMessage({ error: error.message }); else message(error) }
  finally { busy = false; actionInFlight = false; for (const id of actionButtons) $(id).disabled = false }
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
$('list').onscroll = scheduleRender
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
  else if (event.key === ' ') { event.preventDefault(); openDetail() }
}
document.onkeydown = (event) => {
  if (event.key !== 'Escape' || event.isComposing || composing) return
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
  refresh()
}
$('refresh').onclick = () => refresh(); $('new').onclick = () => refresh(); $('more').onclick = () => refresh(true)
$('close').onclick = () => api.close(); $('copy').onclick = () => perform('copy'); $('pin').onclick = () => perform('pin'); $('delete').onclick = () => perform('delete')
$('paste').onclick = () => perform('paste')
$('view').onclick = () => openDetail()
$('pause').onclick = async () => { try { renderStatus(result(await api.setPaused(!status.userPaused))) } catch (error) { message(error) } }
$('clear').onclick = async () => {
  try { const prepared = result(await api.prepareClear('ordinary')); if (prepared.token) { result(await api.commitClear(prepared.token, crypto.randomUUID())); selected = null; clearDetail(); await refresh() } }
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
    if (/^#[0-9a-f]{6}$/i.test(data.mainColor || '')) document.documentElement.style.setProperty('--primary', data.mainColor)
    renderStatus(data.status); refresh().then(() => api.interactive(data.generation)); $('search').focus()
    $('feedback').hidden = true; if (data.pasteFeedback) pasteMessage(data.pasteFeedback)
  }),
  api.onStatus((data) => { if (visible) renderStatus(data) }),
  api.onHistory(() => { if (visible) { thumbCache.clear(); thumbFailed.clear(); thumbInFlight.clear(); ++thumbGeneration; $('new').hidden = false } }),
  api.onHidden(clearHistory),
  api.onPasteResult((data) => {
    clearHistory(); document.body.classList.add('feedback-only')
    setLanguage(data.language); applyTranslations(); document.documentElement.lang = currentLanguage(); document.body.classList.toggle('dark', data.dark === true)
    pasteMessage(data.pasteFeedback)
  }),
  api.onLanguage((language) => { setLanguage(language); applyTranslations(); rebuildAndRender(); renderStatus(status) })
]
function clearHistory() {
  visible = false; ++queryGeneration; clearTimeout(debounce); items = []; cursor = null; selected = null; busy = false
  thumbCache.clear(); thumbFailed.clear(); thumbInFlight.clear(); ++thumbGeneration; metrics = null; renderedWindow = { first: -1, last: -1, cols: -1, language: '' }
  clearDetail(); $('rows').replaceChildren(); $('rows').style.height = '0px'
  $('search').value = ''; $('feedback').hidden = true
  $('empty').hidden = true; $('more').hidden = true; $('new').hidden = true
}
applyTranslations()
window.addEventListener('unload', () => {
  for (const cleanup of cleanups) cleanup()
  detachDprQueries()
  clearTimeout(debounce)
  if (animationFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(animationFrame)
})
api.ready()

})()
