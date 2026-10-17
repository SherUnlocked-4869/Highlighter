// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 最先加载：被多个路由共用的纯 helper、共享状态访问与全局小常量。
// 顶层 function/const 在本文件内自洽；互相引用只发生在吊装（声明本文件时）之后。

// 分派容器：本文件是 config.html 里第一个 routes/*.js，路由文件顶层登记依赖它，
// 而 CSP 禁止内联脚本，所以只能在这里建（见 config.html 的 script 注释）。
window.configRoutes = window.configRoutes || {}

let modalOverlay = null

const selectionToolbarBuiltinMeta = window.toolbarActionMeta.TOOLBAR_ACTION_META

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char])
}

const SEARCH_DEFAULT_CATEGORIES = window.searchUtils.DEFAULT_CATEGORIES

function errorMessage(error) {

  return String(error?.message || error || '').replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
}

function iconMarkup(iconPath) {
  return `<span class="svg-icon" style="--icon:url('${escapeHtml(iconPath)}')" aria-hidden="true"></span>`
}

// Selection-toolbar actions carry a Bootstrap Icons asset name (see
// toolbar/toolbar-action-meta.js). The settings page owns the same icons as the
// strip itself, so it resolves the name against the toolbar folder rather than
// shipping a second copy under config/icons.
const TOOLBAR_ICON_NAME = /^[a-z0-9-]+$/
const TOOLBAR_ICON_FALLBACK = 'stars'

function toolbarIconMarkup(name) {
  const asset = TOOLBAR_ICON_NAME.test(name || '') ? name : TOOLBAR_ICON_FALLBACK
  return iconMarkup(`../toolbar/icons/${asset}.svg`)
}

function toast(message) {
  toastElement.textContent = message
  toastElement.classList.add('show')
  clearTimeout(toastElement._timer)
  toastElement._timer = setTimeout(() => toastElement.classList.remove('show'), 1800)
}

function applyAppearance() {
  if (!settings) return
  const theme = settings.theme === 'system'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : settings.theme
  document.body.classList.toggle('dark', theme === 'dark')
  document.body.classList.toggle('compact', !!settings.compact)
  document.body.classList.toggle('has-skin', !!settings.skinPath)
  document.documentElement.style.setProperty('--primary', settings.mainColor || '#e5a44c')
  document.documentElement.style.setProperty('--radius', `${Number(settings.borderRadius) || 8}px`)
  document.documentElement.style.setProperty('--skin', settings.skinPath ? `url("file:///${String(settings.skinPath).replace(/\\/g, '/')}")` : 'none')
  document.documentElement.style.setProperty('--skin-opacity', String((Number(settings.skinOpacity) || 0) / 100))
  let customStyle = document.getElementById('customStyle')
  if (!customStyle) { customStyle = document.createElement('style'); customStyle.id = 'customStyle'; document.head.appendChild(customStyle) }
  customStyle.textContent = settings.customCss || ''
}

async function updateSettings(patch, message = t('config.setting.saved')) {
  settings = await window.electronAPI.updateSettings(patch)
  if (patch.shortcuts) await refreshShortcutStatuses()
  applyAppearance()
  void refreshStatusRail()
  if (message) toast(message)
  return settings
}

async function refreshShortcutStatuses() {
  shortcutStatuses = await window.electronAPI.getShortcutStatuses()
}

function shortcutPresentation(name, accelerator) {
  if (!accelerator) {
    return { className: '', text: t('config.shortcut.unset'), title: t('config.shortcut.unset-title') }
  }
  const status = shortcutStatuses[name]
  if (!status || status.registered) {
    return { className: 'set', text: accelerator, title: t('config.shortcut.enabled') }
  }
  let message = t('config.shortcut.not-registered')
  if (status.reason === 'duplicate') {
    const conflicts = (status.conflictWith || [])
      .map((owner) => {
        const label = Object.values(functionGroups).flat().find(([itemName]) => itemName === owner)?.[1]
        return label ? t(label) : owner
      })
      .join(t('config.common.list-separator'))
    message = conflicts ? t('config.shortcut.duplicate-with', { names: conflicts }) : t('config.shortcut.duplicate-other')
  } else if (status.reason === 'unavailable') {
    message = t('config.shortcut.system-taken')
  } else if (status.reason === 'invalid') {
    message = t('config.shortcut.invalid')
  } else if (status.reason === 'game-mode') {
    message = t('config.shortcut.game-mode')
  }
  return {
    className: 'set unavailable',
    // The chip carries the reason in its tooltip and signals the state with the
    // .unavailable styling; a trailing warning glyph added no information and
    // rendered as an emoji on Windows.
    text: accelerator,
    title: message,
    message
  }
}

function shortcutButton(name, accelerator) {
  const presentation = shortcutPresentation(name, accelerator)
  return `<button class="shortcut ${presentation.className}" data-shortcut="${name}" title="${escapeHtml(presentation.title)}">${escapeHtml(presentation.text)}</button>`
}

function pageHeader(title, description, extra = '') {
  return `<div class="page-head"><div><h1>${title}</h1><p>${description || ''}</p></div>${extra}</div>`
}

const OCR_PROFILE_LABELS = { 'ppocr-v4-ch': 'config.status.ocr-profile-chinese-english' }

const statusRailCell = (label, value, tone = '') => {
  const cls = tone ? ` tone-${tone}` : ''
  return `<span class="cell${cls}"><i class="dot"></i>${label} <b>${escapeHtml(value)}</b></span>`
}

// The rail answers "what can this app do right now?" — engine, model, hotkey
// coverage and search index — without making the user open several settings
// pages. Any source that is slow or outside the renderer simply degrades to a
// neutral state; the rail must never block or throw.
async function refreshStatusRail() {
  if (!statusRail) return
  const showOn = new Set(['home', 'settings-function', 'models'])
  if (!showOn.has(currentRoute)) {
    statusRail.hidden = true
    return
  }
  if (!settings) {
    statusRail.hidden = true
    return
  }

  const cells = []

  const ocrProfile = settings.ocr?.modelProfile || 'ppocr-v4-ch'
  const ocrProfileKey = OCR_PROFILE_LABELS[ocrProfile]
  cells.push(statusRailCell(t('config.status.ocr-engine'), ocrProfileKey ? t(ocrProfileKey) : ocrProfile))

  const assignments = settings.ai?.assignments || []
  const primary = assignments.find((item) => item.feature === 'chat') || assignments[0]
  const provider = primary ? (settings.providers || []).find((item) => item.id === primary.providerId) : null
  if (provider && primary.model) {
    cells.push(statusRailCell(t('config.status.model'), `${provider.name} · ${primary.model}`, 'accent'))
  } else {
    cells.push(statusRailCell(t('config.status.model'), t('config.status.not-configured'), 'warn'))
  }

  const configured = Object.values(settings.shortcuts || {}).filter(Boolean).length
  const total = Object.values(functionGroups).flat().length
  cells.push(statusRailCell(t('config.status.hotkey'), t('config.status.hotkey-configured', { configured, total }), configured === 0 ? 'warn' : ''))

  // Everything is checked out of process and may not be running yet.
  let searchText = t('config.status.checking')
  let searchTone = 'off'
  try {
    const status = await window.electronAPI.getSearchStatus()
    if (status?.running && status.ipcAvailable !== false) {
      searchText = status.phase === 'ready' ? t('config.status.ready') : t('config.status.starting')
      searchTone = status.phase === 'ready' ? '' : 'warn'
    } else {
      searchText = status?.available ? t('config.status.pending') : t('config.status.component-missing')
      searchTone = 'warn'
    }
  } catch {
    searchText = t('config.status.check-failed')
    searchTone = 'warn'
  }
  cells.push(statusRailCell(t('config.status.local-search'), searchText, searchTone))

  // Guard against a route change while awaiting the IPC round trip.
  if (!showOn.has(currentRoute)) return
  statusRail.innerHTML = cells.join('')
  statusRail.hidden = false
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0)
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = bytes / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && size >= 1024; index++) {
    size /= 1024
    unit = units[index]
  }
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${unit}`
}

function switchMarkup(value, key, group) {
  return `<div class="switch ${value ? 'on' : ''}" data-switch="${key}" data-group="${group || ''}"></div>`
}

function bindSwitches() {
  document.querySelectorAll('[data-switch]').forEach((element) => element.onclick = async () => {
    const key = element.dataset.switch; const group = element.dataset.group; const value = !element.classList.contains('on')
    if (group) await updateSettings({ [group]: { [key]: value } })
    else await updateSettings({ [key]: value })
    element.classList.toggle('on', value)
  })
}

function closeModal() {
  modalOverlay?.remove()
  modalOverlay = null
  codingPlanPresetId = ''
}

function openModal(contentHtml, { onMount } = {}) {
  closeModal()
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${contentHtml}</div>`
  overlay.addEventListener('click', (event) => { if (event.target === overlay) closeModal() })
  overlay.onkeydown = (event) => { if (event.key === 'Escape') closeModal() }
  document.body.appendChild(overlay)
  modalOverlay = overlay
  const modal = overlay.querySelector('.modal')
  modal.querySelectorAll('[data-close-modal]').forEach((button) => { button.onclick = closeModal })
  onMount?.(modal)
  modal.querySelector('input,select,button')?.focus()
  return modal
}

function openDocs(url) {
  window.electronAPI.openExternal(url).catch(() => toast(t('config.error.open-docs')))
}

// D2-2（S14）：共享 helper 的显式登记面，便于测试与后续 i18n 取用。
// 只登记**本文件声明**的名字：这里是一个对象字面量，取值在载入时就完成解析，
// 引用别的路由文件里的 const（例如 home.js 的 functionGroups）会立刻 TDZ 报错。
// 路由文件仍直接调用全局名（经典脚本共享全局作用域），不经由本对象。
window.configShared = {
  escapeHtml, errorMessage, iconMarkup, toolbarIconMarkup, toast, applyAppearance,
  updateSettings, refreshShortcutStatuses, shortcutPresentation, shortcutButton,
  pageHeader, OCR_PROFILE_LABELS, statusRailCell, refreshStatusRail, formatBytes,
  switchMarkup, bindSwitches, modalOverlay, closeModal, openModal, openDocs,
  TOOLBAR_ICON_NAME, TOOLBAR_ICON_FALLBACK, SEARCH_DEFAULT_CATEGORIES,
  selectionToolbarBuiltinMeta
}
