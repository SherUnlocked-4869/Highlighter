// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 history（截图历史）。

let historyQuery = ''
let historySource = ''
let historyTag = ''
let historyRenderVersion = 0
let historySearchTimer = null
let historySelectedIds = new Set()
let historyThumbnailObserver = null
// N02 follow-up (real-device verification, 2026-11-27): the search box used to run the full
// page render on every `input` event. During an IME composition Chromium fires `input` for each
// pinyin keystroke, and the rebuild replaced the focused <input>, aborting the composition and
// leaving only the raw letters in the box. `historySearchComposing` makes the box ignore those
// intermediate events; committed text is searched after compositionend (or on Enter).
let historySearchComposing = false

// B1.4 (history re-edit): `history:changed` used to rebuild the whole page, which
// threw away the scroll offset, the pages the user had loaded and the thumbnail
// cache. The list is now patched by document id instead, so these have to outlive
// a single render: the thumbnail cache is keyed by (documentId, revisionId)
// (plan §6.5.1) and `historyListState` describes the list currently on screen.
let historyThumbnailCache = new Map()
let historyListState = null
let historyRenderInFlight = false
let historyRefreshTimer = null
let historyRefreshRunning = false
let historyRefreshPending = false

const HISTORY_PAGE_SIZE = 40
// Mirror of HistoryService's MAX_HISTORY_PAGE_SIZE (main/services/history-service.js):
// an in-place refresh refetches exactly the pages the user already loaded, and the
// largest page the service accepts keeps the round-trip count down.
const HISTORY_MAX_PAGE_SIZE = 100
const HISTORY_THUMBNAIL_CACHE_LIMIT = 120
// One user action can push several history:changed events (batch delete); coalesce
// the burst so a refresh reads the list once and restores the scroll once.
const HISTORY_REFRESH_DELAY = 60

const HISTORY_SOURCE_LABELS = {
  // `region` is what the capture domain stores for a plain screenshot; `capture`
  // is the fallback HistoryService gives legacy rows with no source.
  capture: 'config.history.source.region',
  region: 'config.history.source.region',
  'long-capture': 'config.history.source.long-capture',
  'focused-window': 'config.history.source.focused-window',
  file: 'config.history.source.file',
  history: 'config.history.source.history',
  'quick-save': 'config.history.source.quick-save',
  'save-as': 'config.history.source.save-as'
}

// Plan §6.5.1 compatibility window: `item.id === item.documentId`, but both reads
// go through these helpers, so a record without the new fields still renders and
// still caches instead of collapsing every card onto one "undefined" key.
function historyDocumentId(item) {
  return String(item?.documentId ?? item?.id ?? '')
}

function historyRevisionId(item) {
  return String(item?.revisionId ?? '')
}

// The version starts at 1 and legacy rows have no field at all: `Math.trunc(Number(x)) || 1`
// keeps "version 1" noise off the card and falls back for junk values.
function historyVersion(item) {
  const version = Math.trunc(Number(item?.version)) || 1
  return version > 1 ? version : 1
}

// Cache key for a thumbnail. The `history:thumbnail` IPC still takes a bare id, so
// the request keeps using documentId while the cache uses (documentId, revisionId)
// — a new revision must not be served the previous version's image.
function historyThumbnailKey(item) {
  return `${historyDocumentId(item)}::${historyRevisionId(item)}`
}

function historySourceLabel(source) {
  const key = HISTORY_SOURCE_LABELS[source]
  return key ? t(key) : String(source ?? '')
}

// N02 (docs/reviews/2026-11-26-code-review-and-optimization-report.md §5.2): per-record tags.
// The limits mirror HistoryService.normalizeHistoryTags(), so the card only ever sends a
// shape the write path accepts; the chips therefore never disagree with the stored record.
const HISTORY_TAGS_MAX = 8
const HISTORY_TAG_MAX_LENGTH = 24

function historyItemTags(item) {
  const tags = Array.isArray(item?.tags) ? item.tags : []
  return tags.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim())
}

// One removable chip per tag. Inline styles are the route's existing escape hatch for small
// additions (no config.css change is in this ticket's write scope).
function historyTagChipsMarkup(tags) {
  return (Array.isArray(tags) ? tags : []).map((tag) => {
    const label = escapeHtml(t('config.history.tag-remove', { tag }))
    return `<span class="history-tag" style="display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border:1px solid var(--line-2);border-radius:var(--radius-pill);color:var(--text);background:var(--surface-2);font-size:11px">${escapeHtml(tag)}<button type="button" class="history-tag-remove" data-history-tag-remove="${escapeHtml(tag)}" aria-label="${label}" title="${label}" style="border:0;background:none;padding:0;color:var(--muted);font-size:12px;line-height:1;cursor:pointer">&times;</button></span>`
  }).join('')
}

function historyTagsMarkup(item) {
  return `<div class="history-tags action-group" data-history-tags style="padding:0 13px 7px;gap:5px"><span class="action-group" data-history-tag-chips style="gap:5px">${historyTagChipsMarkup(historyItemTags(item))}</span><input class="input" data-history-tag-input type="text" maxlength="${HISTORY_TAG_MAX_LENGTH}" placeholder="${escapeHtml(t('config.history.tags-placeholder'))}" style="max-width:150px;padding:2px 8px;font-size:11px"></div>`
}

function historyCurrentTags(card) {
  return [...(card?.querySelectorAll('[data-history-tag-remove]') || [])]
    .map((button) => String(button.dataset.historyTagRemove || ''))
    .filter(Boolean)
}

function historyBindTagChips(card) {
  if (!card) return
  for (const remove of card.querySelectorAll('[data-history-tag-remove]')) {
    remove.onclick = () => { void historyRemoveTag(card, remove.dataset.historyTagRemove) }
  }
}

function historyRenderCardTags(card, tags) {
  const chips = card?.querySelector('[data-history-tag-chips]')
  if (!chips) return
  chips.innerHTML = historyTagChipsMarkup(tags)
  historyBindTagChips(card)
}

// One write for add/remove: the answer carries the normalized list, so the chips are patched
// from the store's own answer instead of from the optimistic payload. The history:changed
// broadcast that follows re-renders the whole card (the signature below includes the tags).
async function historyWriteTags(card, tags) {
  const id = card?.dataset.historyDocument
  if (!id) return false
  let written
  try {
    written = await window.electronAPI.updateHistoryTags(id, tags)
  } catch (error) {
    toast(errorMessage(error) || t('config.history.tags-failed'))
    return false
  }
  if (!Array.isArray(written)) {
    toast(t('config.history.tags-failed'))
    return false
  }
  historyRenderCardTags(card, written)
  return true
}

async function historyAddTag(card, input) {
  if (!card || !input) return
  const tag = String(input.value || '').trim().replace(/\s+/g, ' ').slice(0, HISTORY_TAG_MAX_LENGTH)
  if (!tag) return
  const current = historyCurrentTags(card)
  const duplicate = current.some((existing) => existing.toLocaleLowerCase() === tag.toLocaleLowerCase())
  if (duplicate) {
    input.value = ''
    return
  }
  if (current.length >= HISTORY_TAGS_MAX) {
    toast(t('config.history.tags-limit', { max: HISTORY_TAGS_MAX }))
    return
  }
  const written = await historyWriteTags(card, [...current, tag])
  if (written) input.value = ''
}

async function historyRemoveTag(card, tag) {
  const value = String(tag || '')
  if (!value) return
  const next = historyCurrentTags(card).filter((existing) => existing !== value)
  await historyWriteTags(card, next)
}

// Everything the card actually shows. A card whose signature is unchanged is kept
// as-is on refresh (so its loaded thumbnail survives); only changed cards are
// re-created. Selection is deliberately excluded — it must not invalidate a card.
// N02: the tags are part of the signature so an edit re-renders the chips.
// N02 follow-up: the OCR status/length are too, otherwise a background recognition
// would patch the list without ever updating the badge on the card.
function historyCardSignature(item) {
  return [
    historyDocumentId(item),
    historyRevisionId(item),
    String(item?.id ?? ''),
    String(item?.createdAt ?? ''),
    String(item?.source ?? ''),
    String(item?.width ?? ''),
    String(item?.height ?? ''),
    String(historyVersion(item)),
    item?.longCapture ? '1' : '0',
    String(item?.ocrStatus ?? ''),
    String(item?.ocrTextLength ?? ''),
    Array.isArray(item?.tags) ? item.tags.join('\u0001') : ''
  ].join('|')
}

// N02 follow-up: the card's OCR status chip. The status is the effective one projected by
// HistoryService (a stale `pending` from a previous run already reads as unindexed), so this
// mapping only picks the copy. `done` carries the recognized character count; the empty-text
// case is deliberately not called "failed" because it is a valid result.
function historyOcrStatusLabel(item) {
  const status = String(item?.ocrStatus || '')
  if (status === 'done') return t('config.history.ocr-done', { count: Math.max(0, Number(item?.ocrTextLength) || 0) })
  if (status === 'empty') return t('config.history.ocr-empty')
  if (status === 'pending') return t('config.history.ocr-pending')
  if (status === 'failed') return t('config.history.ocr-failed')
  if (status === 'skipped') return t('config.history.ocr-skipped')
  return t('config.history.ocr-unindexed')
}

function historyOcrBadgeMarkup(item) {
  const status = String(item?.ocrStatus || '')
  const label = historyOcrStatusLabel(item)
  return `<span class="history-ocr" data-history-ocr="${escapeHtml(status || 'none')}" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`
}

// N02 follow-up: a card that has no text index (or a failed/skipped one) gets an explicit
// action, so "not indexed" is something the user can fix instead of a dead end. Queued and
// done records have no action; recognition is already the indexer's job.
function historyOcrActionMarkup(item) {
  const status = String(item?.ocrStatus || '')
  if (status !== '' && status !== 'failed' && status !== 'skipped') return ''
  const id = escapeHtml(historyDocumentId(item))
  const label = status === 'failed' ? t('config.history.ocr-action-retry') : t('config.history.ocr-action')
  return `<button type="button" class="button subtle" data-history-action="ocr" data-id="${id}">${label}</button>`
}

function historyCardMarkup(item) {
  const documentId = historyDocumentId(item)
  const id = escapeHtml(documentId)
  const version = historyVersion(item)
  const selected = historySelectedIds.has(documentId)
  const versionBadge = version > 1 ? `<span class="history-version">${escapeHtml(t('config.history.version-badge', { version }))}</span>` : ''
  // Plan §6.5.1 S8: long captures have no editor yet. Hiding the button alone read
  // as a missing row, so the reason now lives on the thumbnail plate (locale key).
  const imageTitle = item?.longCapture ? ` title="${escapeHtml(t('config.history.long-capture-no-edit'))}"` : ''
  const editButton = item?.longCapture ? '' : `<button type="button" class="button subtle" data-history-action="edit" data-id="${id}">${t('config.history.action-edit')}</button>`
  const openButton = `<button type="button" class="button subtle" data-history-action="open" data-id="${id}">${t('config.history.action-open')}</button>`
  // N02 follow-up: the badge lives on the thumbnail plate (bottom-left) so it is visible without
  // reading the meta row, and the retry entry lives in the "more" popover next to the other
  // secondary actions.
  const ocrBadge = historyOcrBadgeMarkup(item)
  const ocrAction = historyOcrActionMarkup(item)
  return `<article class="card history-item ${selected ? 'selected' : ''}" data-history-document="${id}" data-history-signature="${escapeHtml(historyCardSignature(item))}">
    <label class="history-select" title="${t('config.history.select-item')}"><input type="checkbox" aria-label="${t('config.history.select-item')}" data-history-select data-id="${id}" ${selected ? 'checked' : ''}></label>
    <div class="history-image"${imageTitle}><img data-history-thumbnail="${id}" data-history-thumbnail-key="${escapeHtml(historyThumbnailKey(item))}" loading="lazy" decoding="async" alt="">${ocrBadge}</div>
    <div class="history-meta"><span class="history-meta-time">${new Date(item.createdAt).toLocaleString()}</span><span class="history-meta-sub">${escapeHtml(historySourceLabel(item.source))} · ${escapeHtml(item.width)}×${escapeHtml(item.height)}</span>${versionBadge}</div>
    ${historyTagsMarkup(item)}
    <div class="history-actions action-group">
      ${editButton || openButton}<button type="button" class="button subtle" data-history-action="copy" data-id="${id}">${t('config.history.action-copy')}</button>
      <button type="button" class="button subtle history-more-trigger" popovertarget="history-more-${id}">${t('config.common.more-actions')}</button>
      <div class="action-popover" id="history-more-${id}" popover>
        ${editButton ? openButton : ''}<button type="button" class="button subtle" data-history-action="address" data-id="${id}">${t('config.history.action-address')}</button>${ocrAction}<button type="button" class="button subtle danger" data-history-action="delete" data-id="${id}">${t('config.history.action-delete')}</button>
      </div>
    </div>
  </article>`
}

function historyCreateCard(item) {
  const template = document.createElement('template')
  template.innerHTML = historyCardMarkup(item)
  return template.content.firstElementChild
}

// The CSS plate labels an unusable thumbnail through attr(data-unavailable), so
// the copy lives in the locale table rather than in config.css.
function historyMarkThumbnailUnavailable(imageElement) {
  const plate = imageElement.closest('.history-image')
  if (!plate) return
  plate.dataset.unavailable = t('config.history.thumbnail-unavailable')
  plate.classList.add('unavailable')
}

function historyCacheThumbnail(cacheKey, thumbnail) {
  historyThumbnailCache.delete(cacheKey)
  historyThumbnailCache.set(cacheKey, thumbnail)
  while (historyThumbnailCache.size > HISTORY_THUMBNAIL_CACHE_LIMIT) {
    const oldest = historyThumbnailCache.keys().next()
    if (oldest.done) break
    historyThumbnailCache.delete(oldest.value)
  }
}

async function historyLoadThumbnail(imageElement) {
  const documentId = imageElement.dataset.historyThumbnail
  if (!documentId || imageElement.dataset.loaded === 'true') return
  const cacheKey = imageElement.dataset.historyThumbnailKey || documentId
  imageElement.dataset.loaded = 'true'
  let thumbnail = null
  try {
    thumbnail = historyThumbnailCache.get(cacheKey) || await window.electronAPI.getHistoryThumbnail(documentId)
  } catch {
    thumbnail = null
  }
  if (!thumbnail) {
    historyMarkThumbnailUnavailable(imageElement)
    return
  }
  historyCacheThumbnail(cacheKey, thumbnail)
  // Only a detached element (route left, full page rebuilt) is stale. A results-only filter
  // change bumps historyRenderVersion but keeps the card and its plate connected, and the
  // thumbnail is keyed by document/revision, so applying it is still correct - treating the
  // version bump as a failure used to poison every in-flight thumbnail on the first keystroke.
  if (currentRoute === 'history' && imageElement.isConnected) imageElement.src = thumbnail
}

function historyObserveThumbnailElements(elements) {
  const images = [...(elements || [])]
  if (!images.length) return
  if (!('IntersectionObserver' in window)) {
    images.forEach((imageElement) => { void historyLoadThumbnail(imageElement) })
    return
  }
  if (!historyThumbnailObserver) {
    historyThumbnailObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return
        observer.unobserve(entry.target)
        void historyLoadThumbnail(entry.target)
      })
    }, { root: view, rootMargin: '240px' })
  }
  images.forEach((imageElement) => historyThumbnailObserver.observe(imageElement))
}

function historyObserveThumbnailsIn(scope) {
  if (!scope) return
  historyObserveThumbnailElements(scope.querySelectorAll('[data-history-thumbnail]:not([data-loaded])'))
}

function historyUpdateLoadedCount(state) {
  if (!state?.loadedCount) return
  state.loadedCount.textContent = state.totalCount > state.items.length
    ? t('config.history.count-of-total', { loaded: state.items.length, total: state.totalCount })
    : t('config.history.count-total', { total: state.totalCount })
}

function historyUpdateSelectionControls(state) {
  if (!state?.selectedCount) return
  const count = historySelectedIds.size
  state.selectedCount.textContent = t('config.history.selected-count', { count })
  state.batchActions.hidden = count === 0
  state.selectAll.disabled = state.items.length === 0
  state.exportSelected.disabled = count === 0
  state.exportSelectedPdf.disabled = count === 0
  state.deleteSelected.disabled = count === 0
  state.selectAll.checked = state.items.length > 0 && count === state.items.length
  state.selectAll.indeterminate = count > 0 && count < state.items.length
}

// ---------------------------------------------------------------------------
// N02 follow-up: tag dropdown + OCR status bar
// ---------------------------------------------------------------------------

// Tag options for the filter dropdown: the localized "all tags" option first, then the distinct
// tags with their record counts (most used first, ordered by HistoryService.listTags). The label
// is built here rather than through a locale key because "tag (count)" needs no translation
// beyond the parenthesised number; the placeholder option carries the localized "all tags" copy.
function historyTagOptionsMarkup(tags) {
  return (Array.isArray(tags) ? tags : []).map((entry) => {
    const tag = String(entry?.tag || '')
    if (!tag) return ''
    const count = Math.max(0, Number(entry?.count) || 0)
    return `<option value="${escapeHtml(tag)}">${escapeHtml(count ? `${tag} (${count})` : tag)}</option>`
  }).join('')
}

function historyRenderTagOptions(state, tags) {
  const select = state?.tagSelect
  // `null` means the tag read failed: keep the current options instead of clearing the filter.
  if (!select || !Array.isArray(tags)) return
  const list = tags
  // The selected tag may have disappeared with its last record: fall back to "all tags" so the
  // filter cannot become an invisible, unsatisfiable constraint. Grouping in the store is
  // case-insensitive, so the selected value is canonicalized to the stored casing when it still
  // exists; otherwise the <select> would show "all tags" while the list stayed filtered.
  if (historyTag) {
    const wanted = historyTag.toLocaleLowerCase()
    const match = list.find((entry) => String(entry?.tag || '').toLocaleLowerCase() === wanted)
    historyTag = match ? String(match.tag || '') : ''
  }
  const signature = list.map((entry) => `${entry?.tag || ''}\u0001${Number(entry?.count) || 0}`).join('\u0002')
  if (select.dataset.signature !== signature) {
    select.innerHTML = `<option value="">${t('config.history.all-tags')}</option>${historyTagOptionsMarkup(list)}`
    select.dataset.signature = signature
  }
  if (select.value !== historyTag) select.value = historyTag
}

// What the page-level bar should say, in one testable place. Priority: an active queue first
// (so the user knows recognition is running), then "N captures have no text index" (with the
// index action); a fully indexed history hides the bar entirely instead of adding noise.
function historyOcrBarState(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null
  const summary = snapshot.summary && typeof snapshot.summary === 'object' ? snapshot.summary : null
  if (!summary) return null
  const queue = snapshot.queue && typeof snapshot.queue === 'object' ? snapshot.queue : {}
  const active = Math.max(0, Number(queue.pending) || 0) + (queue.running ? 1 : 0)
  const backlog = Math.max(0, Number(summary.unindexed) || 0) +
    Math.max(0, Number(summary.failed) || 0) +
    Math.max(0, Number(summary.skipped) || 0)
  const enabled = snapshot.enabled !== false
  if (active > 0) return { mode: 'progress', count: active, action: false }
  if (backlog > 0) return { mode: enabled ? 'backlog' : 'unavailable', count: backlog, action: enabled }
  return null
}

function historyRenderOcrBar(state, snapshot) {
  if (!state?.ocrBar) return
  const status = historyOcrBarState(snapshot)
  if (!status) {
    state.ocrBar.hidden = true
    return
  }
  state.ocrBar.hidden = false
  state.ocrBar.dataset.mode = status.mode
  if (state.ocrText) {
    state.ocrText.textContent = status.mode === 'progress'
      ? t('config.history.ocr-progress', { count: status.count })
      : status.mode === 'backlog'
        ? t('config.history.ocr-backlog', { count: status.count })
        : t('config.history.ocr-backlog-off', { count: status.count })
  }
  if (state.indexMissingOcr) state.indexMissingOcr.hidden = !status.action
}

// Refetch just the OCR status (cheap: one command-envelope round-trip, no disk probe) and update
// the bar. Used after a manual index request; background writes arrive through history:changed.
async function refreshHistoryOcrState(state = historyListState) {
  if (!state || currentRoute !== 'history') return
  const version = historyRenderVersion
  try {
    const snapshot = await window.electronAPI.getHistoryOcrState()
    if (currentRoute !== 'history' || version !== historyRenderVersion || historyListState !== state) return
    historyRenderOcrBar(state, snapshot)
  } catch {
    // Keep the last known bar; the next push retries.
  }
}

// The tag list and the OCR summary change on background writes too (a capture can add a tag, an
// OCR job flips a badge), so the in-place refresh re-reads them after patching the cards. Both
// requests are optional: a failure keeps the previous dropdown/bar instead of failing the list.
async function refreshHistoryMeta(state, renderVersion) {
  if (!state || currentRoute !== 'history') return
  const [tags, ocrSnapshot] = await Promise.all([
    window.electronAPI.getHistoryTags().catch(() => null),
    window.electronAPI.getHistoryOcrState().catch(() => null)
  ])
  if (currentRoute !== 'history' || renderVersion !== historyRenderVersion || historyListState !== state) return
  if (Array.isArray(tags)) {
    const previousTag = historyTag
    historyRenderTagOptions(state, tags)
    // The selected tag disappeared with its last record while the page was showing its empty
    // result: re-run the list with the fallback filter so the dropdown and the grid agree. A
    // casing-only canonicalization does not change which records match, so it needs no refetch.
    if (historyTag.toLocaleLowerCase() !== previousTag.toLocaleLowerCase()) {
      void historyApplyFilters()
      return
    }
  }
  if (ocrSnapshot) historyRenderOcrBar(state, ocrSnapshot)
}

function historyBindCard(state, card) {
  for (const checkbox of card.querySelectorAll('[data-history-select]')) {
    checkbox.onchange = () => {
      const id = checkbox.dataset.id
      if (checkbox.checked) historySelectedIds.add(id)
      else historySelectedIds.delete(id)
      checkbox.closest('.history-item')?.classList.toggle('selected', checkbox.checked)
      historyUpdateSelectionControls(state)
    }
  }
  for (const button of card.querySelectorAll('[data-history-action]')) {
    button.onclick = () => {
      const popup = button.closest('[popover]')
      if (popup) {
        popup.hidePopover()
        card.querySelector('.history-more-trigger')?.focus({ preventScroll: true })
      }
      void historyRunItemAction(button)
    }
  }
  // N02: Enter in the tag box adds, the chip's × removes. Both writes go through the same
  // history:list envelope exposed as updateHistoryTags() in preload.js.
  const tagInput = card.querySelector('[data-history-tag-input]')
  if (tagInput) {
    tagInput.onkeydown = (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      void historyAddTag(card, tagInput)
    }
  }
  historyBindTagChips(card)
}

function historyBindItems(state) {
  if (!state?.results) return
  for (const card of state.results.querySelectorAll('[data-history-document]')) historyBindCard(state, card)
}

// Renders `state.items` into `state.results` as a fresh grid. Used by the full render and by
// "load more" (append); filter/search changes go through historyRenderFilteredResults(), which
// diffs the existing cards so a query change never rebuilds the stats/filters/batch blocks
// (that rebuild is what made the page flash and stole the focused input during an IME
// composition).
function historyRenderLoadedItems(state, { append = false } = {}) {
  if (!state?.results) return
  if (!state.items.length) {
    state.results.innerHTML = '<div class="empty">' + t('config.history.empty') + '</div>'
  } else if (append && state.renderedCount > 0) {
    const newItems = state.items.slice(state.renderedCount)
    let grid = state.results.querySelector('.history-grid')
    if (!grid) {
      state.results.innerHTML = '<div class="history-grid"></div>'
      grid = state.results.querySelector('.history-grid')
    }
    grid.insertAdjacentHTML('beforeend', newItems.map(historyCardMarkup).join(''))
    historyObserveThumbnailsIn(grid)
  } else {
    state.results.innerHTML = `<div class="history-grid">${state.items.map(historyCardMarkup).join('')}</div>`
    historyObserveThumbnailsIn(state.results)
  }
  state.renderedCount = state.items.length
  historyUpdateLoadedCount(state)
  state.loadMore.hidden = !state.hasMore
  state.loadMore.disabled = false
  historyUpdateSelectionControls(state)
  historyBindItems(state)
}

// B1.4: the edit entry used to fire and forget — a game-mode rejection or a deleted
// file made the click completely silent. It now wraps the call in try/catch, checks
// the return value and locks the button (loading copy) for the duration, so a second
// click cannot open a second editor.
async function historyEditItem(button) {
  if (!button || button.disabled) return
  const id = button.dataset.id
  const label = button.textContent
  button.disabled = true
  button.dataset.loading = 'true'
  button.textContent = t('config.history.action-edit-loading')
  try {
    const opened = await window.electronAPI.editHistory(id)
    if (opened === false) toast(t('config.history.edit-failed'))
  } catch (error) {
    toast(errorMessage(error) || t('config.history.edit-failed'))
  } finally {
    // A refresh may already have replaced this button along with its card; a
    // detached node needs no restoring.
    if (button.isConnected) {
      button.disabled = false
      button.textContent = label
      delete button.dataset.loading
    }
  }
}

// N02 follow-up: one card's "recognize text" / "retry recognition" action. Like the edit
// entry, the button is locked and relabelled while the request is in flight so a second click
// cannot enqueue twice, and the result is checked instead of fire-and-forget.
async function historyIndexOcrItem(button) {
  if (!button || button.disabled) return
  const id = button.dataset.id
  if (!id) return
  const label = button.textContent
  button.disabled = true
  button.dataset.loading = 'true'
  button.textContent = t('config.history.ocr-action-running')
  let result = null
  try {
    result = await window.electronAPI.indexHistoryOcr({ ids: [id] })
  } catch (error) {
    toast(errorMessage(error) || t('config.history.ocr-index-failed'))
  } finally {
    if (button.isConnected) {
      button.disabled = false
      button.textContent = label
      delete button.dataset.loading
    }
  }
  if (!result) return
  if (result.disabled) toast(t('config.history.ocr-index-unavailable'))
  else if (!result.accepted) toast(t('config.history.ocr-nothing-to-index'))
  else {
    toast(t('config.history.ocr-index-started'))
    // Accepting a job does not write the store ("pending" is derived from the indexer's
    // in-memory job set), so re-read the list projection to show the badge immediately.
    void historyApplyFilters()
  }
  void refreshHistoryOcrState()
}

async function historyRunItemAction(button) {
  const action = button.dataset.historyAction
  const id = button.dataset.id
  if (action === 'edit') { await historyEditItem(button); return }
  // N02 follow-up: the card-level "recognize text" / "retry" entry. The badge and the card are
  // patched by the history:changed push that the indexer's `pending` write emits, so this only
  // has to report a refused request (OCR off, record gone).
  if (action === 'ocr') { await historyIndexOcrItem(button); return }
  if (action === 'open') {
    try {
      const opened = await window.electronAPI.openHistory(id)
      if (!opened) toast(t('config.history.file-missing'))
    } catch (error) { toast(errorMessage(error) || t('config.history.open-failed')) }
    return
  }
  if (action === 'copy') {
    try {
      const copied = await window.electronAPI.copyHistory(id)
      toast(copied ? t('config.history.copied') : t('config.history.too-large'))
    } catch (error) { toast(errorMessage(error) || t('config.history.too-large')) }
    return
  }
  if (action === 'address') {
    try {
      const copied = await window.electronAPI.copyHistoryPath(id)
      toast(copied ? t('config.history.address-copied') : t('config.history.file-missing'))
    } catch (error) { toast(errorMessage(error) || t('config.history.address-copy-failed')) }
    return
  }
  if (action === 'delete') {
    if (!confirm(t('config.history.confirm-delete-item'))) return
    try { historySelectedIds.delete(id); await window.electronAPI.deleteHistory(id) } catch (error) { toast(errorMessage(error) || t('config.history.delete-failed')) }
  }
}

// ---------------------------------------------------------------------------
// In-place refresh (B1.4)
// ---------------------------------------------------------------------------

// `#view` is the scroller (config.css `#view{flex:1;overflow:auto}`), so the offset
// has to be handed over explicitly across a patch — same shape as the usage
// dashboard (routes/usage.js usageCaptureViewState / usageRestoreViewState).
function historyRestoreScroll(scrollTop) {
  const applyScroll = () => { if (scrollTop > 0 && view.scrollTop !== scrollTop) view.scrollTop = scrollTop }
  // The patched grid has no geometry yet on the line after the swap, so a single
  // assignment can be clamped by the previous scrollHeight; re-apply next frame.
  applyScroll()
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(applyScroll)
}

// Selection survives a refresh. Only ids whose document disappeared from the list
// are dropped: a selection must not be clipped just because a row moved pages, and
// a document that is merely updated keeps its checkbox ticked.
function historySelectionAfterRefresh(selectedIds, previousIds, nextIds) {
  const next = new Set(nextIds)
  const gone = new Set([...previousIds].filter((id) => !next.has(id)))
  if (!gone.size) return selectedIds
  return new Set([...selectedIds].filter((id) => !gone.has(id)))
}

// Refetches exactly the pages the user already loaded (never more): an in-place
// refresh must not roll the list back to page one.
async function historyLoadLoadedPages(targetCount) {
  const items = []
  let cursor = ''
  let hasMore = true
  let totalCount = 0
  while (hasMore) {
    const page = await window.electronAPI.getHistory({
      query: historyQuery,
      source: historySource,
      tag: historyTag,
      limit: Math.max(1, Math.min(HISTORY_MAX_PAGE_SIZE, targetCount - items.length)),
      ...(cursor ? { cursor } : {})
    })
    const pageItems = Array.isArray(page?.items) ? page.items : []
    items.push(...pageItems)
    totalCount = Math.max(items.length, Number(page?.totalCount) || 0)
    hasMore = page?.hasMore === true
    cursor = page?.nextCursor || ''
    if (!hasMore || !cursor || items.length >= targetCount || !pageItems.length) break
  }
  return { items, hasMore, totalCount, nextCursor: cursor }
}

// N02 follow-up: a background write (typically an OCR status flip) re-creates a card. If the
// user was half-way through typing a tag on that very card, the replacement must not throw the
// draft away; only the focused tag box carries one, because every other control has already
// fired its action by the time the push arrives.
function historyCaptureCardDraft(card) {
  if (!card) return null
  const active = document.activeElement
  if (!active || !card.contains(active)) return null
  if (typeof active.matches !== 'function' || !active.matches('[data-history-tag-input]')) return null
  return { value: active.value, start: active.selectionStart, end: active.selectionEnd }
}

function historyRestoreCardDraft(card, draft) {
  if (!card || !draft) return
  const input = card.querySelector?.('[data-history-tag-input]')
  if (!input) return
  input.value = draft.value
  input.focus({ preventScroll: true })
  try {
    input.setSelectionRange(draft.start, draft.end)
  } catch {
    // A non-text input type has no selection API; the value is already restored.
  }
}

// Swaps card bodies in place, keyed by document id. Untouched cards keep their
// element (and therefore their loaded thumbnail); only changed ones are re-created.
function historyPatchCards(state, items) {
  let grid = state.results.querySelector('.history-grid')
  if (!grid) {
    state.results.innerHTML = '<div class="history-grid"></div>'
    grid = state.results.querySelector('.history-grid')
  }
  const existing = new Map()
  for (const card of grid.querySelectorAll('[data-history-document]')) existing.set(card.dataset.historyDocument, card)
  const ordered = []
  for (const item of items) {
    const documentId = historyDocumentId(item)
    if (!documentId) continue
    const card = existing.get(documentId) || null
    let next = card
    if (!card || card.dataset.historySignature !== historyCardSignature(item)) {
      next = historyCreateCard(item)
      const draft = historyCaptureCardDraft(card)
      if (card) card.replaceWith(next)
      historyBindCard(state, next)
      historyObserveThumbnailsIn(next)
      historyRestoreCardDraft(next, draft)
    }
    existing.delete(documentId)
    ordered.push(next)
  }
  // A document deleted elsewhere leaves together with the card it owned.
  for (const stale of existing.values()) stale.remove()
  // Keep DOM order equal to list order: an updated document keeps its place, while
  // a new one (save-copy, next capture) can land at the head without a rebuild.
  let reference = null
  for (const card of ordered) {
    const expected = reference ? reference.nextElementSibling : grid.firstElementChild
    if (expected !== card) grid.insertBefore(card, reference ? reference.nextElementSibling : grid.firstElementChild)
    reference = card
  }
  // Selection is not part of the signature (it must not invalidate a thumbnail), so
  // it is synchronised explicitly after the patch.
  for (const card of ordered) {
    const selected = historySelectedIds.has(card.dataset.historyDocument)
    card.classList.toggle('selected', selected)
    const checkbox = card.querySelector('[data-history-select]')
    if (checkbox) checkbox.checked = selected
  }
}

// N02 follow-up: renders a changed filter result set through the same card diff the background
// refresh uses. Records that stay in the result keep their element (and already loaded
// thumbnail), so an incremental search does not flash every thumbnail on each keystroke.
function historyRenderFilteredResults(state) {
  if (!state?.results) return
  if (!state.items.length) {
    state.results.innerHTML = '<div class="empty">' + t('config.history.empty') + '</div>'
  } else {
    historyPatchCards(state, state.items)
  }
  state.renderedCount = state.items.length
  historyUpdateLoadedCount(state)
  state.loadMore.hidden = !state.hasMore
  state.loadMore.disabled = false
  historyUpdateSelectionControls(state)
}

// Only `history:list` is refetched: stats, filters and the batch bar stay exactly as
// the full render built them, and the scroll offset is restored afterwards.
async function refreshHistoryList() {
  const state = historyListState
  if (!state?.results || !state.results.isConnected) return false
  const refreshVersion = historyRenderVersion
  const previousIds = new Set(state.items.map((item) => historyDocumentId(item)))
  const targetCount = Math.max(HISTORY_PAGE_SIZE, state.items.length)
  let page
  try {
    page = await historyLoadLoadedPages(targetCount)
  } catch {
    // Keep the cards already on screen; the next push retries.
    return false
  }
  // A full render (route re-entry, filter change) superseded this refresh.
  if (currentRoute !== 'history' || refreshVersion !== historyRenderVersion || historyListState !== state) return false
  // The list on screen now corresponds to this render generation; "load more" compares this
  // token after its own await and refuses to append rows fetched for a superseded filter.
  state.version = refreshVersion
  // Read the offset after the fetch, right before the DOM mutation: the user may
  // have scrolled while the list was loading, and the patch must not rewind them.
  const scrollTop = view.scrollTop || 0
  const nextIds = new Set(page.items.map((item) => historyDocumentId(item)))
  historySelectedIds = historySelectionAfterRefresh(historySelectedIds, previousIds, nextIds)
  state.items = page.items
  state.renderedCount = page.items.length
  state.nextCursor = page.nextCursor
  state.hasMore = page.hasMore
  state.totalCount = page.totalCount
  if (!page.items.length) state.results.innerHTML = '<div class="empty">' + t('config.history.empty') + '</div>'
  else historyPatchCards(state, page.items)
  historyUpdateLoadedCount(state)
  state.loadMore.hidden = !state.hasMore
  state.loadMore.disabled = false
  historyUpdateSelectionControls(state)
  historyRestoreScroll(scrollTop)
  // N02 follow-up: the tag dropdown's counts and the OCR bar change on the same background
  // writes that patched the cards (a tag edit, a recognition finishing), so re-read both once
  // per refresh. Failures are swallowed by refreshHistoryMeta; the patched list still stands.
  void refreshHistoryMeta(state, refreshVersion)
  return true
}

// `history:changed` entry point. Deliberately not `renderHistory()`: entering the
// route or changing a filter still goes through the full render it always did.
function refreshHistoryOnChange() {
  if (currentRoute !== 'history') return
  // A search debounce already queued a full render for the query being typed.
  if (historySearchTimer) return
  if (historyRenderInFlight) {
    historyRefreshPending = true
    return
  }
  if (historyRefreshTimer) clearTimeout(historyRefreshTimer)
  historyRefreshTimer = setTimeout(() => {
    historyRefreshTimer = null
    void refreshHistoryInPlace()
  }, HISTORY_REFRESH_DELAY)
}

async function refreshHistoryInPlace() {
  if (currentRoute !== 'history') return
  if (historyRefreshRunning) {
    historyRefreshPending = true
    return
  }
  // Nothing rendered to patch (first load failed, or the route is being entered):
  // fall back to the full render so the page still converges.
  if (!historyListState) {
    await renderHistory()
    return
  }
  historyRefreshRunning = true
  try {
    await refreshHistoryList()
  } finally {
    historyRefreshRunning = false
    if (historyRefreshPending) {
      historyRefreshPending = false
      refreshHistoryOnChange()
    }
  }
}

// ---------------------------------------------------------------------------
// Filter change (search text / source / tag) - results only
// ---------------------------------------------------------------------------

// N02 follow-up: one debounce for the search box. It is only armed for committed text, never
// during an IME composition, and it updates the result grid in place instead of rebuilding the
// page - the focused input (and the composition attached to it) survives every keystroke.
function historyScheduleSearch() {
  clearTimeout(historySearchTimer)
  historySearchTimer = setTimeout(() => {
    historySearchTimer = null
    void historyApplyFilters()
  }, 220)
}

// Re-queries the list for the current filters and swaps only the result grid. Stats, filters
// and the batch bar stay exactly as they are, so there is no loading flash and the search box
// keeps its focus, caret and IME composition.
async function historyApplyFilters() {
  if (currentRoute !== 'history') return
  const state = historyListState
  // Nothing to patch (first load failed, or the route is being entered): converge through the
  // full render instead of racing a half-built page.
  if (!state) { await renderHistory(); return }
  const renderVersion = ++historyRenderVersion
  try {
    const page = await window.electronAPI.getHistory({
      query: historyQuery,
      source: historySource,
      tag: historyTag,
      limit: HISTORY_PAGE_SIZE
    })
    if (currentRoute !== 'history' || renderVersion !== historyRenderVersion || historyListState !== state) return
    state.version = renderVersion
    state.items = Array.isArray(page?.items) ? page.items : []
    state.renderedCount = 0
    state.nextCursor = page?.nextCursor || ''
    state.hasMore = page?.hasMore === true
    state.totalCount = Math.max(state.items.length, Number(page?.totalCount) || 0)
    const visibleIds = new Set(state.items.map((item) => historyDocumentId(item)))
    historySelectedIds = new Set([...historySelectedIds].filter((id) => visibleIds.has(id)))
    view.scrollTop = 0
    historyRenderFilteredResults(state)
  } catch (error) {
    if (currentRoute === 'history' && renderVersion === historyRenderVersion) {
      toast(errorMessage(error) || t('config.history.load-failed'))
    }
  }
}

// ---------------------------------------------------------------------------
// Full render
// ---------------------------------------------------------------------------

async function renderHistory() {
  const renderVersion = ++historyRenderVersion
  // While the page is being rebuilt there is nothing to patch, so a push arriving
  // mid-render is folded into one refresh once it completes.
  historyListState = null
  historyRenderInFlight = true
  try {
    await renderHistoryPage(renderVersion)
  } finally {
    historyRenderInFlight = false
    if (historyRefreshPending) {
      historyRefreshPending = false
      refreshHistoryOnChange()
    }
  }
}

async function renderHistoryPage(renderVersion) {
  // U05: an in-flight render (or the debounced search below) may still complete after the user
  // navigated away; writing the history grid into the next page's DOM was the reported bug.
  if (currentRoute !== 'history') return
  historyThumbnailObserver?.disconnect()
  historyThumbnailObserver = null
  const headerActions = '<div class="page-head-actions action-group"><button class="button subtle" id="cleanupHistory">' + t('config.history.cleanup-invalid') + '</button><button class="button subtle danger" id="clearHistory">' + t('config.history.clear-all') + '</button></div>'
  view.innerHTML = `<div class="page">${pageHeader(t('config.route.history'), t('config.history.description'), headerActions)}<div class="empty">${t('config.history.loading')}</div></div>`
  let firstPage
  let sources
  let stats
  // `null` means "the tag read failed": the dropdown then keeps the previous/selected tag
  // instead of clearing the user's filter because an optional read failed.
  let tags = null
  let ocrSnapshot = null
  try {
    const [page, sourceList, statistics, tagList, ocrState] = await Promise.all([
      window.electronAPI.getHistory({
        query: historyQuery,
        source: historySource,
        tag: historyTag,
        limit: HISTORY_PAGE_SIZE
      }),
      window.electronAPI.getHistorySources(),
      window.electronAPI.getHistoryStats(),
      // N02 follow-up: both are optional reads. A failed tag read must not silently clear an
      // active tag filter; a failed OCR read only hides the bar.
      window.electronAPI.getHistoryTags().catch(() => null),
      window.electronAPI.getHistoryOcrState().catch(() => null)
    ])
    firstPage = page
    sources = sourceList
    stats = statistics
    tags = Array.isArray(tagList) ? tagList : null
    ocrSnapshot = ocrState
  } catch (error) {
    if (currentRoute === 'history' && renderVersion === historyRenderVersion) {
      view.innerHTML = `<div class="page">${pageHeader(t('config.route.history'), t('config.history.description'), headerActions)}<div class="empty">${t('config.history.load-failed')}</div></div>`
      toast(error?.message || t('config.history.load-failed'))
    }
    return
  }
  if (currentRoute !== 'history' || renderVersion !== historyRenderVersion) return
  // The selected tag can disappear with its last record. Reset the filter and refetch once so
  // the page does not open on an invisible "no results" state. The comparison is
  // case-insensitive because the tag store groups tags that way.
  if (historyTag && Array.isArray(tags)) {
    const wanted = historyTag.toLocaleLowerCase()
    if (!tags.some((entry) => String(entry?.tag || '').toLocaleLowerCase() === wanted)) {
      historyTag = ''
      try {
        firstPage = await window.electronAPI.getHistory({
          query: historyQuery,
          source: historySource,
          tag: historyTag,
          limit: HISTORY_PAGE_SIZE
        })
      } catch {
        // Keep the empty page; the next filter change retries.
      }
      // The refetch is a second await: a newer render may have superseded this one meanwhile.
      if (currentRoute !== 'history' || renderVersion !== historyRenderVersion) return
    }
  }
  // The rendered list. `refreshHistoryList()` mutates this object in place, so the
  // handlers bound below (load more / select all / export) always read fresh rows.
  const state = {
    version: renderVersion,
    items: Array.isArray(firstPage?.items) ? firstPage.items : [],
    renderedCount: 0,
    nextCursor: firstPage?.nextCursor || '',
    hasMore: firstPage?.hasMore === true,
    totalCount: 0,
    results: null,
    loadedCount: null,
    loadMore: null,
    selectAll: null,
    selectedCount: null,
    exportSelected: null,
    exportSelectedPdf: null,
    deleteSelected: null,
    // N02 follow-up: the tag dropdown and the page-level OCR bar.
    tagSelect: null,
    ocrBar: null,
    ocrText: null,
    indexMissingOcr: null
  }
  state.totalCount = Math.max(state.items.length, Number(firstPage?.totalCount) || 0)
  const visibleIds = new Set(state.items.map((item) => historyDocumentId(item)))
  historySelectedIds = new Set([...historySelectedIds].filter((id) => visibleIds.has(id)))
  const container = document.querySelector('.page')
  container.querySelector('.empty')?.remove()
  const sourceOptions = sources.map((source) => `<option value="${escapeHtml(source)}">${escapeHtml(historySourceLabel(source))}</option>`).join('')
  const statsMarkup = `<div class="history-stats card"><div><b>${formatBytes(stats.totalBytes)}</b><span>${t('config.history.stats-space')}</span></div><div><b>${stats.availableCount}</b><span>${t('config.history.stats-available')}</span></div><div class="${stats.missingCount ? 'warning' : ''}"><b>${stats.missingCount}</b><span>${t('config.history.stats-missing')}</span></div><div class="${stats.orphanCount ? 'warning' : ''}"><b>${stats.orphanCount}</b><span>${t('config.history.stats-orphan', { size: formatBytes(stats.orphanBytes) })}</span></div></div>`
  // N02 follow-up: the tag becomes a dropdown over the tags that actually exist (with counts)
  // instead of asking the user to type a tag into the free-text search box. When the tag read
  // failed (`tags === null`) the selected tag is kept as a bare option so the <select> cannot
  // show "all tags" while the list is still filtered.
  const tagOptionList = Array.isArray(tags) ? tags : []
  const selectedTagFallback = !Array.isArray(tags) && historyTag
    ? `<option value="${escapeHtml(historyTag)}" selected>${escapeHtml(historyTag)}</option>`
    : ''
  const filtersMarkup = `<div class="history-filters card"><input class="input" id="historySearch" type="search" value="${escapeHtml(historyQuery)}" placeholder="${t('config.history.search-placeholder')}"><select id="historySource"><option value="">${t('config.history.all-sources')}</option>${sourceOptions}</select><select id="historyTag" title="${escapeHtml(t('config.history.all-tags'))}"><option value="">${escapeHtml(t('config.history.all-tags'))}</option>${selectedTagFallback}${historyTagOptionsMarkup(tagOptionList)}</select><span id="historyLoadedCount"></span></div>`
  // N02 follow-up: page-level recognition state. Hidden while the history is fully indexed, so
  // the answer to "is OCR still running, or is there really nothing?" is visible when it matters.
  const ocrBarMarkup = `<div class="history-ocr-bar card" id="historyOcrBar" hidden><span id="historyOcrStateText"></span><button class="button subtle" id="indexMissingOcr" hidden>${t('config.history.ocr-index-missing')}</button></div>`
  const batchMarkup = `<div class="history-batch action-group card"><label><input type="checkbox" id="selectAllHistory"> ${t('config.history.select-all')}</label><span id="historySelectedCount" aria-live="polite">${t('config.history.selected-count', { count: 0 })}</span><div class="action-group" id="historyBatchActions" hidden><button class="button" id="exportSelectedHistory" disabled>${t('config.history.export-selected')}</button><button class="button" id="exportSelectedHistoryPdf" disabled>${t('config.history.export-pdf')}</button><button class="button danger" id="deleteSelectedHistory" disabled>${t('config.history.delete-selected')}</button></div></div>`
  container.insertAdjacentHTML('beforeend', `${statsMarkup}${filtersMarkup}${ocrBarMarkup}${batchMarkup}<div id="historyResults"></div><div class="history-load-more"><button class="button" id="loadMoreHistory" hidden>${t('config.history.load-more')}</button></div>`)

  const searchInput = document.getElementById('historySearch')
  const sourceSelect = document.getElementById('historySource')
  state.tagSelect = document.getElementById('historyTag')
  state.selectAll = document.getElementById('selectAllHistory')
  state.selectedCount = document.getElementById('historySelectedCount')
  state.batchActions = document.getElementById('historyBatchActions')
  state.exportSelected = document.getElementById('exportSelectedHistory')
  state.exportSelectedPdf = document.getElementById('exportSelectedHistoryPdf')
  state.deleteSelected = document.getElementById('deleteSelectedHistory')
  state.loadedCount = document.getElementById('historyLoadedCount')
  state.results = document.getElementById('historyResults')
  state.loadMore = document.getElementById('loadMoreHistory')
  state.ocrBar = document.getElementById('historyOcrBar')
  state.ocrText = document.getElementById('historyOcrStateText')
  state.indexMissingOcr = document.getElementById('indexMissingOcr')
  // Published only once the markup exists: a refresh started earlier would
  // otherwise patch a half-built page.
  historyListState = state
  sourceSelect.value = historySource
  historyRenderTagOptions(state, tags)
  historyRenderLoadedItems(state)
  historyRenderOcrBar(state, ocrSnapshot)
  // N02 follow-up: the search box is IME-aware and results-only.
  //  * `compositionstart` stops the debounce and suppresses `input` events until the IME
  //    commits; a full page rebuild in the middle of a composition is exactly what made the
  //    Chinese input fail and left only the pinyin letters in the box.
  //  * `compositionend` (and Enter outside a composition) searches the committed value.
  //  * `historyApplyFilters()` replaces the result grid only, so the input keeps focus/caret
  //    and the page does not flash a loading state on every keystroke.
  // A fresh input node starts clean: a composition cannot span a page rebuild.
  historySearchComposing = false
  searchInput.oninput = (event) => {
    // `isComposing` is the authoritative signal for an intermediate IME keystroke. The flag is
    // a backup for the short window after compositionstart; if an event arrives with
    // isComposing=false while the flag is still set, the composition ended without delivering
    // compositionend (window deactivate, node replacement), so recover instead of swallowing
    // every future keystroke.
    if (event?.isComposing === true) return
    historySearchComposing = false
    historyQuery = searchInput.value
    historyScheduleSearch()
  }
  searchInput.oncompositionstart = () => {
    historySearchComposing = true
    clearTimeout(historySearchTimer)
    historySearchTimer = null
  }
  searchInput.oncompositionend = () => {
    historySearchComposing = false
    historyQuery = searchInput.value
    historyScheduleSearch()
  }
  // Focus leaving with no compositionend would otherwise leave the flag stuck for the rest of
  // the page's life.
  searchInput.onblur = () => { historySearchComposing = false }
  searchInput.onkeydown = (event) => {
    if (event.key !== 'Enter') return
    // The IME owns Enter while a candidate window is open; entering a candidate must not run
    // a search (Chromium reports keyCode 229 on some IMEs where isComposing is still false).
    if (historySearchComposing || event.isComposing === true || event.keyCode === 229) return
    event.preventDefault()
    clearTimeout(historySearchTimer)
    historySearchTimer = null
    historyQuery = searchInput.value
    void historyApplyFilters()
  }
  sourceSelect.onchange = () => {
    historySource = sourceSelect.value
    void historyApplyFilters()
  }
  // N02 follow-up: picking a tag is an exact filter; it no longer has to be typed into the
  // free-text search box (which still substring-matches tags for compatibility).
  if (state.tagSelect) {
    state.tagSelect.onchange = () => {
      historyTag = state.tagSelect.value
      void historyApplyFilters()
    }
  }
  // N02 follow-up: page-level "index the captures that have no text yet". One click enqueues
  // every unindexed record; the per-card badges and the bar then update through history:changed.
  if (state.indexMissingOcr) {
    state.indexMissingOcr.onclick = async () => {
      if (state.indexMissingOcr.disabled) return
      state.indexMissingOcr.disabled = true
      try {
        const result = await window.electronAPI.indexHistoryOcr({ all: true })
        if (result?.disabled) toast(t('config.history.ocr-index-unavailable'))
        else if (Number(result?.accepted) > 0) {
          toast(t('config.history.ocr-index-queued', { count: result.accepted }))
          // Pending is derived from the indexer's in-memory job set; re-read the projection so
          // the cards flip to "recognizing" without a store write.
          void historyApplyFilters()
        } else toast(t('config.history.ocr-nothing-to-index'))
        void refreshHistoryOcrState(state)
      } catch (error) {
        toast(errorMessage(error) || t('config.history.ocr-index-failed'))
      } finally {
        if (state.indexMissingOcr.isConnected) state.indexMissingOcr.disabled = false
      }
    }
  }
  state.selectAll.onchange = () => {
    historySelectedIds = state.selectAll.checked ? new Set(state.items.map((item) => historyDocumentId(item))) : new Set()
    for (const checkbox of state.results.querySelectorAll('[data-history-select]')) {
      checkbox.checked = state.selectAll.checked
      checkbox.closest('.history-item')?.classList.toggle('selected', state.selectAll.checked)
    }
    historyUpdateSelectionControls(state)
  }
  state.exportSelected.onclick = async () => {
    let result
    try {
      result = await window.electronAPI.exportHistory([...historySelectedIds])
    } catch (error) {
      toast(errorMessage(error) || t('config.history.export-failed'))
      return
    }
    if (result.canceled) return
    const suffix = result.failures?.length ? t('config.history.failure-suffix', { count: result.failures.length }) : ''
    toast(t('config.history.exported', { count: result.exportedCount, failures: suffix }))
  }
  // Batch PDF: the main process renders one PDF page per selected capture and asks
  // for the destination itself, so this button follows the same cancel/failure
  // reporting shape as the copy export above.
  state.exportSelectedPdf.onclick = async () => {
    let result
    try {
      result = await window.electronAPI.exportHistoryPdf([...historySelectedIds])
    } catch (error) {
      toast(errorMessage(error) || t('config.history.export-pdf-failed'))
      return
    }
    if (result.canceled) return
    const suffix = result.failures?.length ? t('config.history.failure-suffix', { count: result.failures.length }) : ''
    toast(t('config.history.export-pdf-done', { count: result.exportedCount, failures: suffix }))
  }
  state.deleteSelected.onclick = async () => {
    if (!confirm(t('config.history.confirm-delete-selected', { count: historySelectedIds.size }))) return
    let result
    try {
      result = await window.electronAPI.deleteHistoryMany([...historySelectedIds])
    } catch (error) {
      toast(errorMessage(error) || t('config.history.delete-failed'))
      return
    }
    historySelectedIds.clear()
    const suffix = result.failures?.length ? t('config.history.failure-suffix', { count: result.failures.length }) : ''
    toast(t('config.history.deleted', { count: result.deletedCount, failures: suffix }))
    renderHistory()
  }
  state.loadMore.onclick = async () => {
    if (!state.hasMore || state.loadMore.disabled) return
    // This closure belongs to the full render that built the page, but a filter/search change
    // reuses the same state object and bumps state.version. Compare against that token (not the
    // closure's renderVersion) after the await: otherwise the first keystroke would make "load
    // more" permanently dead, and a superseded fetch could append rows for an old filter.
    const token = state.version
    state.loadMore.disabled = true
    try {
      const page = await window.electronAPI.getHistory({
        query: historyQuery,
        source: historySource,
        tag: historyTag,
        cursor: state.nextCursor,
        limit: HISTORY_PAGE_SIZE
      })
      if (currentRoute !== 'history' || historyListState !== state || state.version !== token) return
      state.items = state.items.concat(Array.isArray(page?.items) ? page.items : [])
      state.nextCursor = page?.nextCursor || ''
      state.hasMore = page?.hasMore === true
      state.totalCount = Math.max(state.items.length, Number(page?.totalCount) || state.totalCount)
      historyRenderLoadedItems(state, { append: true })
    } catch (error) {
      toast(errorMessage(error) || t('config.history.load-failed'))
    } finally {
      if (currentRoute === 'history' && historyListState === state) state.loadMore.disabled = false
    }
  }
  document.getElementById('cleanupHistory').onclick = async () => {
    if (!stats.missingCount && !stats.orphanCount) { toast(t('config.history.nothing-to-clean')); return }
    if (!confirm(t('config.history.confirm-cleanup', { missing: stats.missingCount, orphans: stats.orphanCount }))) return
    let result
    try {
      result = await window.electronAPI.cleanupHistory()
    } catch (error) {
      toast(errorMessage(error) || t('config.history.cleanup-failed'))
      return
    }
    const suffix = result.failures?.length ? t('config.history.failure-suffix', { count: result.failures.length }) : ''
    toast(t('config.history.cleaned', { entries: result.removedEntries, files: result.removedFiles, failures: suffix }))
    renderHistory()
  }
  document.getElementById('clearHistory').onclick = async () => {
    if (!confirm(t('config.history.confirm-clear-all'))) return
    try { historySelectedIds.clear(); await window.electronAPI.clearHistory(); renderHistory() }
    catch (error) { toast(errorMessage(error) || t('config.history.clear-failed')); renderHistory() }
  }
}

// D2-2（S14）：登记到主壳 renderRoute() 的分派表（config.html 里本文件先于 config.js 加载）。
// 包一层箭头函数：登记语句本身不解析被指的标识符，调用时才解析（与拆分前调用形态一致）。
// U05: called by the shell's navigate() when the history route is left. The debounced search
// timer belongs to this page and must not fire against another route's DOM.
function historyDeactivate() {
  if (historySearchTimer) {
    clearTimeout(historySearchTimer)
    historySearchTimer = null
  }
  // A composition belongs to the input we are leaving behind; the next entry starts clean.
  historySearchComposing = false
}

window.configRoutes = window.configRoutes || {}
window.configRoutes['renderHistory'] = () => renderHistory()
