'use strict'

// Shared i18n runtime.
//
// W0-4 (2026-10-10) freezes the interface and the key convention; S1 (batch C)
// completes the framework and migrates the windows.
//
// Key convention: <domain>.<module>.<semantic>  (e.g. capture.toolbar.save)
//
// Constraints this design answers (see the P0 plan §10.2):
//   * every window CSP is `default-src 'none'; script-src 'self'` with
//     `connect-src 'none'` -> no fetch/XHR, so locale tables are <script>
//     globals loaded from shared/locales/*.js before this file;
//   * each window adds one `<script src="../shared/i18n.js">` line and marks
//     elements with data-i18n / data-i18n-title / data-i18n-placeholder; the
//     scripts themselves call the global `t()`.
//
// Language priority: <html data-language> -> localStorage -> default.

const SUPPORTED_LANGUAGES = Object.freeze(['zh-CN', 'en-US', 'zh-TW'])
const DEFAULT_LANGUAGE = 'zh-CN'
const LANGUAGE_STORAGE_KEY = 'language'
const TRANSLATABLE_ATTRIBUTES = Object.freeze(['title', 'placeholder', 'aria-label'])

let activeLanguage = ''

function localeTables() {
  globalThis.__LOCALES = globalThis.__LOCALES || {}
  return globalThis.__LOCALES
}

function isSupportedLanguage(value) {
  return SUPPORTED_LANGUAGES.includes(value)
}

function storedLanguage() {
  try {
    return globalThis.localStorage ? globalThis.localStorage.getItem(LANGUAGE_STORAGE_KEY) : ''
  } catch {
    // A window with storage disabled must still render in a known language.
    return ''
  }
}

function declaredLanguage() {
  const declared = globalThis.document?.documentElement?.dataset?.language
  return typeof declared === 'string' ? declared : ''
}

function resolveLanguage() {
  const declared = declaredLanguage()
  if (isSupportedLanguage(declared)) return declared
  const stored = storedLanguage()
  if (isSupportedLanguage(stored)) return stored
  return DEFAULT_LANGUAGE
}

function currentLanguage() {
  if (!activeLanguage) activeLanguage = resolveLanguage()
  return activeLanguage
}

function table(language) {
  const value = localeTables()[language]
  return value && typeof value === 'object' ? value : {}
}

function interpolate(template, params) {
  if (!params || typeof template !== 'string') return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (
    Object.hasOwn(params, name) ? String(params[name]) : match
  ))
}

// Missing keys fall back to the default language and finally to the key itself,
// so a half-migrated window still renders something diagnosable.
function t(key, params) {
  if (typeof key !== 'string' || !key) return ''
  const localized = table(currentLanguage())[key]
  if (typeof localized === 'string') return interpolate(localized, params)
  const fallback = table(DEFAULT_LANGUAGE)[key]
  if (typeof fallback === 'string') return interpolate(fallback, params)
  return key
}

function setLanguage(language) {
  if (!isSupportedLanguage(language)) return currentLanguage()
  activeLanguage = language
  try {
    globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, language)
  } catch {
    // Persisting the choice is best-effort; the in-memory switch still applies.
  }
  return activeLanguage
}

function translateElement(element) {
  if (!element || typeof element.getAttribute !== 'function') return
  const key = element.getAttribute('data-i18n')
  if (key) element.textContent = t(key)
  for (const attribute of TRANSLATABLE_ATTRIBUTES) {
    const attributeKey = element.getAttribute(`data-i18n-${attribute}`)
    if (attributeKey) element.setAttribute(attribute, t(attributeKey))
  }
}

function applyTranslations(root = globalThis.document) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0
  const marked = root.querySelectorAll('[data-i18n], [data-i18n-title], [data-i18n-placeholder], [data-i18n-aria-label]')
  for (const element of marked) translateElement(element)
  return marked.length
}

// The renderers apply a broadcast by calling setLanguage(payload.language) and
// then applyTranslations(); this entry point is the boot-time half of the same
// job, for markup that has no `data-language` (the second step of the documented
// priority: data-language -> localStorage -> default).
function restoreStoredLanguage() {
  const stored = storedLanguage()
  if (!isSupportedLanguage(stored)) return currentLanguage()
  activeLanguage = stored
  applyTranslations()
  return activeLanguage
}

function observeTranslations(root = globalThis.document) {
  const Observer = globalThis.MutationObserver
  if (!root || !Observer) return null
  const observer = new Observer((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue
        translateElement(node)
        applyTranslations(node)
      }
    }
  })
  observer.observe(root, { childList: true, subtree: true })
  return observer
}

const api = {
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  TRANSLATABLE_ATTRIBUTES,
  currentLanguage,
  setLanguage,
  restoreStoredLanguage,
  interpolate,
  t,
  translateElement,
  applyTranslations,
  observeTranslations
}

if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof window !== 'undefined') Object.assign(window, api)
