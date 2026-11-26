// N06 (docs/reviews/2026-11-26-code-review-and-optimization-report.md section 5.6):
// the settings-window global search (Ctrl+K).
//
// This file is two things in one classic script:
//   1. a PURE, node-requirable data + algorithm module (the index table and
//      searchSettings()); test/n06-config-search-backup.test.js drives it with
//      node:test and no DOM;
//   2. the DOM wiring for the sidebar search box. It only runs when `document`
//      exists, so requiring this file outside a browser still returns the pure
//      API.
//
// Index entry contract:
//   route       one of the 15 config routes (same ids as config.html's data-route)
//   tab?        sub-tab id the entry belongs to (activated by clicking the route's
//               own tab button, see TAB_ATTRIBUTE_BY_ROUTE)
//   tabKey?     i18n key of the tab label (resolved with t() at search time)
//   sectionId?  data-section marker to scroll to when no element id is targeted
//   key         i18n key of the item label; ALSO used as the displayed title
//   keywords    i18n keys (translated through t()) and/or plain ASCII search
//               tokens such as "scrypt" or "zip". No hardcoded Chinese here: the
//               Chinese/English/Traditional-Chinese words all come from the
//               locale tables.
//   target?     DOM id, or an attribute selector like [data-switch="compact"]
//
// Matching is owned by searchSettings(): case-insensitive, every whitespace-
// separated token must hit, and earlier/higher-priority field hits rank first.
;(function exposeSettingsSearch (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.settingsSearch = api
})(typeof globalThis === 'object' ? globalThis : window, () => {
  'use strict'

  const MAX_QUERY_TOKENS = 8
  const RESULTS_LIMIT = 12
  // Field order = match priority. A hit in the label always outranks the same
  // hit in a keyword/context field, which is what "sort by hit position" means
  // for a flat index: position = termIndex * TERM_WEIGHT + character offset.
  const TERM_WEIGHT = 1000
  const HIGHLIGHT_CLASS = 'search-hit'
  const HIGHLIGHT_MS = 1800
  const TARGET_POLL_MS = 40
  const TARGET_POLL_ATTEMPTS = 30

  const ROUTE_SEARCH_KEYS = Object.freeze({
    home: 'config.route.home',
    translation: 'config.route.translation',
    chat: 'config.route.chat',
    history: 'config.route.history',
    recording: 'config.route.recording',
    'device-battery': 'config.route.device-battery',
    'selection-toolbar': 'config.route.selection-toolbar',
    'local-search': 'config.route.local-search',
    'clipboard-history': 'clipboard.title',
    usage: 'config.route.usage',
    'settings-general': 'config.route.settings-general',
    'settings-function': 'config.route.settings-function',
    models: 'config.route.models',
    'settings-system': 'config.route.settings-system',
    about: 'config.route.about'
  })

  // Route -> attribute of the tab button that has to be clicked before the
  // entry's section exists. Routes without sub-tabs are absent on purpose.
  const TAB_ATTRIBUTE_BY_ROUTE = Object.freeze({
    home: 'data-home-tab',
    models: 'data-models-tab',
    'settings-function': 'data-function-tab',
    recording: 'data-recording-tab'
  })

  const SETTINGS_SEARCH_INDEX = Object.freeze([
    // --- home (quick functions) ---
    { route: 'home', key: 'config.route.home', keywords: ['config.home.description', 'config.first-run.title'] },
    { route: 'home', tab: 'screenshot', tabKey: 'config.group.screenshot', key: 'config.group.screenshot', keywords: ['config.home.description'] },
    { route: 'home', tab: 'ai', tabKey: 'config.group.ai', key: 'config.group.ai', keywords: ['config.group.screenshot'] },
    { route: 'home', tab: 'translation', tabKey: 'config.group.translation', key: 'config.group.translation', keywords: ['config.group.ai'] },
    { route: 'home', tab: 'video', tabKey: 'config.group.video', key: 'config.group.video', keywords: ['config.group.screenshot', 'record'] },
    { route: 'home', tab: 'other', tabKey: 'config.group.other', key: 'config.group.other', keywords: ['config.home.description'] },
    { route: 'home', tab: 'shortcuts', tabKey: 'config.home.tab-shortcuts', key: 'config.home.tab-shortcuts', keywords: ['config.settings-hotkeys.description', 'config.shortcut.enabled', 'hotkey'] },

    // --- translation ---
    { route: 'translation', key: 'config.route.translation', keywords: ['config.translation.description', 'config.translation.translate'] },
    { route: 'translation', key: 'config.translation.target-language', target: 'targetLanguage', keywords: ['config.translation.source-language', 'config.translation.source-auto'] },
    { route: 'translation', key: 'config.translation.copy-result', target: 'copyTranslation', keywords: ['config.translation.copied'] },
    { route: 'translation', key: 'config.translation.clear', target: 'clearSource', keywords: ['config.translation.swap-text'] },
    { route: 'translation', key: 'config.translation.translate', target: 'translateNow', keywords: ['config.translation.translating'] },

    // --- chat ---
    { route: 'chat', key: 'config.route.chat', keywords: ['config.chat.input-placeholder', 'config.chat.send'] },
    { route: 'chat', key: 'config.chat.send', target: 'sendChat', keywords: ['config.chat.input-placeholder'] },

    // --- history ---
    { route: 'history', key: 'config.route.history', keywords: ['config.history.description', 'config.history.search-placeholder'] },
    { route: 'history', key: 'config.history.search-placeholder', target: 'historySearch', keywords: ['config.history.description'] },
    { route: 'history', key: 'config.history.export-selected', target: 'exportSelectedHistory', keywords: ['config.history.exported'] },
    { route: 'history', key: 'config.history.export-pdf', target: 'exportSelectedHistoryPdf', keywords: ['config.history.export-selected'] },
    { route: 'history', key: 'config.history.delete-selected', target: 'deleteSelectedHistory', keywords: ['config.history.deleted'] },
    { route: 'history', key: 'config.history.clear-all', target: 'clearHistory', keywords: ['config.history.confirm-clear-all'] },
    { route: 'history', key: 'config.history.select-all', target: 'selectAllHistory', keywords: [] },
    { route: 'history', key: 'config.history.load-more', target: 'loadMoreHistory', keywords: [] },

    // --- recording ---
    { route: 'recording', key: 'recording.workbench.title', keywords: ['recording.workbench.description', 'recording.workbench.start-display'] },
    { route: 'recording', tab: 'recent', tabKey: 'recording.records.tab-recent', key: 'recording.records.tab-recent', keywords: ['recording.workbench.records-section'] },
    { route: 'recording', tab: 'all', tabKey: 'recording.records.tab-all', key: 'recording.records.tab-all', keywords: ['recording.records.total'] },
    { route: 'recording', key: 'recording.workbench.start-display', target: 'recordingStartButton', keywords: ['recording.workbench.start-region', 'recording.workbench.start-window'] },
    { route: 'recording', key: 'recording.workbench.target-section', target: '[data-recording-tab="recent"]', keywords: ['recording.workbench.target-display-note'] },
    { route: 'recording', key: 'recording.workbench.frame-rate', target: 'frame-rate-select', keywords: ['recording.workbench.fps'] },
    { route: 'recording', key: 'recording.workbench.quality', target: 'quality-select', keywords: ['recording.workbench.params-section'] },
    { route: 'recording', key: 'recording.workbench.countdown', target: 'countdown-select', keywords: ['recording.workbench.countdown-seconds'] },
    { route: 'recording', key: 'recording.workbench.audio-section', target: 'microphone-device', keywords: ['recording.workbench.audio-system', 'recording.workbench.audio-microphone'] },
    { route: 'recording', key: 'recording.preflight.check-microphone', target: 'preflight-retry', keywords: ['recording.preflight.level-good'] },

    // --- device battery ---
    { route: 'device-battery', key: 'config.route.device-battery', keywords: ['battery', 'device'] },
    { route: 'device-battery', key: 'config.route.device-battery', target: 'deviceBatteryRefresh', keywords: ['battery', 'refresh'] },

    // --- selection toolbar ---
    { route: 'selection-toolbar', key: 'config.route.selection-toolbar', keywords: ['config.selection-toolbar.description'] },
    { route: 'selection-toolbar', key: 'config.selection-toolbar.toolbar-section', target: '[data-switch="enabled"]', keywords: ['config.selection-toolbar.enable-toolbar'] },
    { route: 'selection-toolbar', key: 'config.selection-toolbar.translate-prompt', target: 'translatePrompt', keywords: ['config.selection-toolbar.translate-target', 'config.selection-toolbar.translate-thinking'] },
    { route: 'selection-toolbar', key: 'config.selection-toolbar.explain-prompt', target: 'explainPrompt', keywords: ['config.selection-toolbar.explain-thinking'] },
    { route: 'selection-toolbar', key: 'config.selection-toolbar.search-engine', target: 'searchEngine', keywords: ['config.selection-toolbar.search-engine-hint'] },
    { route: 'selection-toolbar', key: 'config.selection-toolbar.custom-section', target: 'addCustomToolbar', keywords: ['config.selection-toolbar.custom-limit'] },
    { route: 'selection-toolbar', key: 'config.selection-toolbar.order-section', target: 'toolbarOrderList', keywords: ['config.selection-toolbar.order-hint'] },
    { route: 'selection-toolbar', key: 'config.selection-toolbar.conversation-section', target: 'conversationEnabled', keywords: ['config.selection-toolbar.conversation-turns', 'config.selection-toolbar.conversation-persist'] },

    // --- local search ---
    { route: 'local-search', key: 'config.route.local-search', keywords: ['config.local-search.description', 'everything'] },
    { route: 'local-search', key: 'config.local-search.open-window', target: 'openSearchWindow', keywords: ['config.local-search.open-window-hint'] },
    { route: 'local-search', key: 'config.local-search.max-results', target: 'searchMaxResults', keywords: ['config.local-search.max-results-hint'] },
    { route: 'local-search', key: 'config.local-search.match-path', target: '[data-switch="matchPath"]', keywords: ['config.local-search.match-path-hint'] },
    { route: 'local-search', key: 'config.local-search.auto-start', target: '[data-switch="useBundledEverything"]', keywords: ['config.local-search.auto-start-hint'] },
    { route: 'local-search', key: 'config.local-search.categories-section', target: 'searchCategoriesTitle', keywords: ['config.local-search.category-rule', 'config.local-search.save-categories'] },

    // --- clipboard history ---
    { route: 'clipboard-history', key: 'clipboard.title', keywords: ['clipboard.description', 'clipboard.manage-enabled'] },
    { route: 'clipboard-history', key: 'clipboard.open', target: 'clipboard-open', keywords: ['clipboard.refresh'] },
    { route: 'clipboard-history', key: 'clipboard.privacy', target: 'clipboard-excluded', keywords: ['clipboard.excluded-hint'] },
    { route: 'clipboard-history', key: 'clipboard.clear-all', target: 'clipboard-clear-all', keywords: ['clipboard.clear-ordinary'] },
    { route: 'clipboard-history', key: 'clipboard.capacity.title', target: 'clipboard-capacity-card', keywords: ['clipboard.capacity.disk', 'clipboard.capacity.payload'] },

    // --- usage ---
    { route: 'usage', key: 'config.route.usage', keywords: ['config.usage.subtitle', 'token'] },
    { route: 'usage', key: 'config.usage.refresh', target: 'refreshUsage', keywords: ['config.usage.scan.started'] },
    { route: 'usage', key: 'config.usage.coverage.title', target: 'usageCoverage', keywords: ['config.usage.coverage.last-scan'] },
    { route: 'usage', key: 'config.usage.heatmap.level', target: 'usageHeatmap', keywords: ['config.usage.heatmap.title'] },
    { route: 'usage', key: 'config.usage.dashboard.snapshot-row', target: 'usageSnapshots', keywords: ['config.usage.dashboard.import-preview'] },
    { route: 'usage', key: 'config.usage.range.apply', target: 'usageEvery', keywords: ['config.usage.range.from', 'config.usage.range.to'] },

    // --- general settings ---
    { route: 'settings-general', key: 'config.route.settings-general', keywords: ['config.settings-general.description'] },
    { route: 'settings-general', key: 'config.appearance.theme', target: 'theme', keywords: ['config.appearance.theme-dark', 'config.appearance.theme-light'] },
    { route: 'settings-general', key: 'config.appearance.main-color', target: 'mainColor', keywords: [] },
    { route: 'settings-general', key: 'config.appearance.border-radius', target: 'borderRadius', keywords: ['config.appearance.compact'] },
    { route: 'settings-general', key: 'config.appearance.skin-path', target: 'skinPath', keywords: ['config.appearance.skin-opacity'] },
    { route: 'settings-general', key: 'config.appearance.custom-css', target: 'customCss', keywords: ['config.appearance.compact'] },
    { route: 'settings-general', key: 'config.setting.language', target: 'interfaceLanguage', keywords: ['config.general.interface-section'] },
    { route: 'settings-general', key: 'config.settings-system.auto-start', target: '[data-switch="autoStart"]', keywords: ['config.general.startup-section'] },
    { route: 'settings-general', key: 'config.settings-system.enable-tray', target: '[data-switch="enableTray"]', keywords: [] },
    { route: 'settings-general', key: 'config.settings-system.game-mode', target: '[data-switch="gameMode"]', keywords: ['config.settings-system.game-mode-hint'] },
    { route: 'settings-general', key: 'config.settings-system.run-log', target: '[data-switch="runLog"]', keywords: [] },
    { route: 'settings-general', key: 'config.general.modules-section', target: '[data-switch="ocr"]', keywords: ['config.plugin.ocr-title', 'config.plugins.description'] },
    { route: 'settings-general', key: 'config.about.update-channel', target: 'updateChannel', keywords: ['config.about.auto-check-updates', 'config.about.channel-beta'] },
    { route: 'settings-general', key: 'config.about.update-section', target: 'updateCard', keywords: ['config.about.check-update'] },

    // --- function settings (sub-tabs) ---
    { route: 'settings-function', tab: 'capture', tabKey: 'config.function-settings.output-section', key: 'config.function-settings.output-section', keywords: ['config.route.settings-function'] },
    { route: 'settings-function', tab: 'ocr', tabKey: 'config.function-settings.ocr-section', key: 'config.function-settings.ocr-section', keywords: ['config.function-settings.ocr-model'] },
    { route: 'settings-function', tab: 'record', tabKey: 'config.function-tabs.record', key: 'config.function-tabs.record', keywords: ['config.function-settings.record-defaults-hint'] },
    { route: 'settings-function', tab: 'capture', key: 'config.function-settings.auto-save-on-copy', target: '[data-switch="autoSaveOnCopy"]', keywords: ['config.function-settings.fast-save'] },
    { route: 'settings-function', tab: 'capture', key: 'config.function-settings.shutter-sound', target: '[data-switch="shutterSound"]', keywords: ['config.function-settings.shutter-sound-hint'] },
    { route: 'settings-function', tab: 'capture', key: 'config.function-settings.capture-cursor', target: '[data-switch="captureCursor"]', keywords: ['config.function-settings.capture-cursor-hint'] },
    { route: 'settings-function', tab: 'capture', key: 'config.function-settings.long-capture-direction', target: 'longCaptureDirection', keywords: ['config.function-settings.vertical', 'config.function-settings.horizontal'] },
    { route: 'settings-function', tab: 'capture', key: 'config.function-settings.save-directory', target: 'saveDirectory', keywords: [] },
    { route: 'settings-function', tab: 'capture', key: 'config.function-settings.name-template', target: 'nameTemplate', keywords: ['config.function-settings.name-template-placeholder'] },
    { route: 'settings-function', tab: 'capture', key: 'config.function-settings.history-limit', target: 'historyLimit', keywords: ['config.function-settings.history-enabled'] },
    { route: 'settings-function', tab: 'capture', key: 'config.settings-system.history-directory', target: 'historyDirectory', keywords: ['config.function-settings.history-enabled'] },
    { route: 'settings-function', tab: 'capture', key: 'config.function-settings.watermark-content', target: 'watermarkContent', keywords: ['watermark', 'config.function-settings.watermark-date-suffix'] },
    { route: 'settings-function', tab: 'capture', key: 'config.function-settings.watermark-opacity', target: 'watermarkOpacity', keywords: ['watermark'] },
    { route: 'settings-function', tab: 'capture', key: 'config.function-settings.watermark-date-suffix', target: 'watermarkDateSuffix', keywords: ['watermark'] },
    { route: 'settings-function', tab: 'ocr', key: 'config.function-settings.ocr-hot-start', target: '[data-switch="hotStart"]', keywords: ['config.function-settings.ocr-hot-start-hint'] },
    { route: 'settings-function', tab: 'ocr', key: 'config.function-settings.ocr-min-confidence', target: 'ocrMinConfidence', keywords: ['config.function-settings.ocr-model'] },
    { route: 'settings-function', tab: 'ocr', key: 'config.function-settings.ocr-after-action', target: 'ocrAfterAction', keywords: ['config.function-settings.ocr-after-copy'] },
    { route: 'settings-function', tab: 'record', key: 'config.function-settings.record-frame-rate', target: 'frameRate', keywords: ['config.function-settings.record-frame-rate-hint'] },
    { route: 'settings-function', tab: 'record', key: 'config.function-settings.record-quality', target: 'recordQuality', keywords: [] },
    { route: 'settings-function', tab: 'record', key: 'config.function-settings.record-microphone', target: '[data-switch="audioMicrophone"]', keywords: ['config.function-settings.record-microphone-device', 'config.function-settings.record-audio-system'] },
    { route: 'settings-function', tab: 'record', key: 'config.function-settings.record-directory', target: 'recordDirectory', keywords: ['config.function-settings.record-storage-section'] },
    { route: 'settings-function', tab: 'record', key: 'config.function-settings.pin-click-through', target: '[data-switch="clickThrough"]', keywords: [] },
    { route: 'settings-function', tab: 'record', key: 'config.function-settings.pin-zoom-step', target: 'pinZoomStep', keywords: [] },

    // --- models (providers / features / defaults sub-tabs) ---
    { route: 'models', tab: 'providers', tabKey: 'config.models.tab-providers', key: 'config.models.tab-providers', keywords: ['config.models.providers-section'] },
    { route: 'models', tab: 'features', tabKey: 'config.models.tab-features', key: 'config.models.tab-features', keywords: ['config.models.features-section'] },
    { route: 'models', tab: 'defaults', tabKey: 'config.models.tab-defaults', key: 'config.models.tab-defaults', keywords: ['config.models.defaults-description'] },
    { route: 'models', tab: 'providers', key: 'config.models.add-provider', target: 'addModelProvider', keywords: ['config.models.add-coding-plan'] },
    { route: 'models', tab: 'providers', key: 'config.models.save-providers', target: 'saveProviderSettings', keywords: ['config.models.providers-saved'] },
    { route: 'models', tab: 'providers', key: 'config.models.open-config-file', target: 'openModelConfigFile', keywords: ['json'] },
    { route: 'models', tab: 'features', key: 'config.models.features-section', target: 'saveFeatureAssignments', keywords: ['config.models.feature-list-hint'] },
    { route: 'models', tab: 'defaults', key: 'config.function-settings.ai-max-tokens', target: 'aiMaxTokens', keywords: ['config.models.tab-defaults'] },
    { route: 'models', tab: 'defaults', key: 'config.function-settings.ai-target-language', target: 'aiTargetLanguage', keywords: ['config.models.tab-defaults'] },
    { route: 'models', tab: 'defaults', key: 'config.models.prompt-settings-link', target: 'openPromptSettings', keywords: ['config.route.selection-toolbar'] },

    // --- system and data ---
    { route: 'settings-system', key: 'config.route.settings-system', keywords: ['config.settings-system.description'] },
    { route: 'settings-system', key: 'config.settings-system.data-root', target: 'dataRoot', keywords: ['config.settings-system.data-section', 'config.settings-system.change'] },
    { route: 'settings-system', key: 'config.settings-system.backup-section', target: 'backupTargetDirectory', keywords: ['backup', 'config.settings-system.backup-modules'] },
    { route: 'settings-system', key: 'config.settings-system.backup-create', target: 'createBackup', keywords: ['backup', 'config.settings-system.backup-preview'] },
    { route: 'settings-system', key: 'config.settings-system.backup-restore', target: 'restoreBackup', keywords: ['backup', 'config.settings-system.backup-confirm-restore'] },
    { route: 'settings-system', key: 'config.settings-system.backup-archive-section', sectionId: 'backup-archive', keywords: ['backup', 'zip', 'hlbackup'] },
    { route: 'settings-system', key: 'config.settings-system.backup-archive-export', target: 'exportBackupArchive', keywords: ['zip', 'hlbackup', 'backup'] },
    { route: 'settings-system', key: 'config.settings-system.backup-archive-import', target: 'importBackupArchive', keywords: ['zip', 'hlbackup', 'restore'] },
    { route: 'settings-system', key: 'config.settings-system.backup-archive-password', target: 'backupArchivePassword', keywords: ['password', 'scrypt', 'aes'] },
    { route: 'settings-system', key: 'config.settings-system.proxy-section', target: 'proxyPort', keywords: ['proxy', 'config.settings-system.proxy-auto-start'] },
    { route: 'settings-system', key: 'config.settings-system.diagnostics-section', target: 'exportDiagnostics', keywords: ['diagnostics', 'config.settings-system.include-crash-dumps'] },
    { route: 'settings-system', key: 'config.settings-system.clear-history', target: 'clearData', keywords: ['config.settings-system.danger-section'] },
    { route: 'settings-system', key: 'config.settings-system.reset', target: 'resetSettings', keywords: ['config.settings-system.danger-section', 'reset'] },

    // --- about ---
    { route: 'about', key: 'config.route.about', keywords: ['config.about.tagline', 'config.about.version-line'] },
    { route: 'about', key: 'config.about.update-section', target: 'openUpdateSettings', keywords: ['config.about.check-update'] },
    { route: 'about', key: 'config.about.project-home', target: 'openProjectHome', keywords: ['config.about.release-page'] }
  ])

  function normalizeQuery (query) {
    const text = typeof query === 'string' ? query.normalize('NFC').toLowerCase().trim() : ''
    if (!text) return []
    return [...new Set(text.split(/\s+/).filter(Boolean))].slice(0, MAX_QUERY_TOKENS)
  }

  function termText (value) {
    return typeof value === 'string' ? value : ''
  }

  // Resolve i18n keys to the active language. `translate` is t() in the window
  // and an identity/mapping function in tests, which is what keeps this module
  // free of hardcoded copy.
  function resolveSettingsSearchIndex (index = SETTINGS_SEARCH_INDEX, translate = (key) => key) {
    const source = Array.isArray(index) ? index : []
    const table = typeof translate === 'function' ? translate : (key) => key
    return source.map((entry, order) => {
      const label = termText(table(entry.key)) || String(entry.key || '')
      const routeLabel = termText(table(ROUTE_SEARCH_KEYS[entry.route] || ''))
      const tabLabel = entry.tabKey ? termText(table(entry.tabKey)) : ''
      const terms = [{ text: label, kind: 'label' }]
      for (const keyword of entry.keywords || []) {
        const isKey = typeof keyword === 'string' && /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(keyword)
        const text = isKey ? termText(table(keyword)) : termText(keyword)
        if (text) terms.push({ text, kind: isKey ? 'keyword' : 'token' })
      }
      if (routeLabel) terms.push({ text: routeLabel, kind: 'context' })
      if (tabLabel) terms.push({ text: tabLabel, kind: 'context' })
      return {
        route: entry.route,
        tab: entry.tab || '',
        tabKey: entry.tabKey || '',
        sectionId: entry.sectionId || '',
        target: entry.target || '',
        key: entry.key,
        label,
        routeLabel,
        tabLabel,
        terms,
        order
      }
    })
  }

  // Pure matcher. Every token must hit (multi-word AND); the score is the
  // weighted character position of the best hit per token, so a label hit
  // outranks a keyword hit and an early hit outranks a late one.
  function searchSettings (entries, query) {
    const tokens = normalizeQuery(query)
    if (!tokens.length) return []
    const results = []
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry) continue
      // Resolved entries carry `terms`; a raw index entry still matches its own
      // i18n key names, which keeps the function usable without t() (tests,
      // diagnostics) instead of silently returning nothing.
      const terms = Array.isArray(entry.terms)
        ? entry.terms
        : [{ text: termText(entry.key) }, ...(Array.isArray(entry.keywords) ? entry.keywords.map((keyword) => ({ text: termText(keyword) })) : [])]
      if (!terms.length) continue
      let score = 0
      let matchedAll = true
      for (const token of tokens) {
        let best = -1
        for (let index = 0; index < terms.length; index += 1) {
          const text = termText(terms[index] && terms[index].text).toLowerCase()
          if (!text) continue
          const at = text.indexOf(token)
          if (at === -1) continue
          const weighted = at + index * TERM_WEIGHT
          if (best === -1 || weighted < best) best = weighted
        }
        if (best === -1) {
          matchedAll = false
          break
        }
        score += best
      }
      if (matchedAll) results.push({ ...entry, score })
    }
    results.sort((left, right) => left.score - right.score || left.order - right.order)
    return results
  }

  // -------------------------------------------------------------------------
  // DOM wiring (browser only; the pure API above is what node:test drives)
  // -------------------------------------------------------------------------

  function isBrowser () {
    return typeof document !== 'undefined' && typeof document.getElementById === 'function'
  }

  function translateKey (key) {
    try {
      if (typeof t === 'function') return t(key)
    } catch { /* locale table not ready yet */ }
    return key
  }

  function findTarget (entry) {
    if (!isBrowser() || !entry) return null
    const selector = termText(entry.target)
    if (selector) {
      if (selector.startsWith('[') || selector.startsWith('#')) {
        const found = document.querySelector(selector)
        if (found) return found
      } else {
        const byId = document.getElementById(selector)
        if (byId) return byId
      }
    }
    if (entry.sectionId) {
      const section = document.querySelector(`[data-section="${entry.sectionId}"]`)
      if (section) return section
    }
    return null
  }

  function waitForTarget (entry, attempts = TARGET_POLL_ATTEMPTS) {
    return new Promise((resolve) => {
      const found = findTarget(entry)
      if (found || attempts <= 0) {
        resolve(found)
        return
      }
      window.setTimeout(() => resolve(waitForTarget(entry, attempts - 1)), TARGET_POLL_MS)
    })
  }

  function activateTab (entry, attempts = TARGET_POLL_ATTEMPTS) {
    const attribute = TAB_ATTRIBUTE_BY_ROUTE[entry.route]
    if (!attribute || !entry.tab) return Promise.resolve(false)
    return new Promise((resolve) => {
      const selector = `[${attribute}="${entry.tab}"]`
      const button = document.querySelector(selector)
      if (button) {
        if (button.getAttribute('aria-pressed') !== 'true' && !button.classList.contains('active')) button.click()
        resolve(true)
        return
      }
      if (attempts <= 0) {
        resolve(false)
        return
      }
      window.setTimeout(() => resolve(activateTab(entry, attempts - 1)), TARGET_POLL_MS)
    })
  }

  function prefersReducedMotion () {
    try {
      return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    } catch {
      return false
    }
  }

  async function openSearchResult (entry) {
    if (!isBrowser() || !entry) return false
    if (typeof navigate === 'function') navigate(entry.route)
    if (entry.tab) await activateTab(entry)
    const target = await waitForTarget(entry)
    if (!target) return false
    try {
      target.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    } catch { /* older webview */ }
    if (typeof target.focus === 'function') {
      if (!target.hasAttribute('tabindex') && target.tagName !== 'BUTTON' && target.tagName !== 'INPUT' && target.tagName !== 'SELECT' && target.tagName !== 'TEXTAREA') {
        target.setAttribute('tabindex', '-1')
      }
      try { target.focus({ preventScroll: true }) } catch { /* ignore */ }
    }
    target.classList.add(HIGHLIGHT_CLASS)
    window.setTimeout(() => target.classList.remove(HIGHLIGHT_CLASS), HIGHLIGHT_MS)
    return true
  }

  function initSettingsSearch () {
    if (!isBrowser() || initSettingsSearch.instance) return initSettingsSearch.instance || null
    const input = document.getElementById('settingsSearchInput')
    const panel = document.getElementById('settingsSearchResults')
    if (!input || !panel) return null

    const state = { entries: [], results: [], activeIndex: -1, query: '' }
    const rebuild = () => {
      state.entries = resolveSettingsSearchIndex(SETTINGS_SEARCH_INDEX, translateKey)
    }
    const closePanel = () => {
      state.results = []
      state.activeIndex = -1
      panel.hidden = true
      panel.replaceChildren()
      input.setAttribute('aria-expanded', 'false')
      input.removeAttribute('aria-activedescendant')
    }
    const setActive = (index) => {
      if (!state.results.length) return
      state.activeIndex = (index + state.results.length) % state.results.length
      panel.querySelectorAll('[data-search-result]').forEach((element, position) => {
        const active = position === state.activeIndex
        element.classList.toggle('active', active)
        element.setAttribute('aria-selected', String(active))
        if (active) {
          input.setAttribute('aria-activedescendant', element.id)
          element.scrollIntoView({ block: 'nearest' })
        }
      })
    }
    const render = () => {
      const query = input.value
      state.query = query
      rebuild()
      state.results = searchSettings(state.entries, query).slice(0, RESULTS_LIMIT)
      state.activeIndex = -1
      panel.replaceChildren()
      if (!query.trim()) {
        closePanel()
        return
      }
      if (!state.results.length) {
        const empty = document.createElement('div')
        empty.className = 'search-result-empty'
        empty.textContent = translateKey('config.search.empty')
        panel.append(empty)
        panel.hidden = false
        input.setAttribute('aria-expanded', 'true')
        return
      }
      state.results.forEach((entry, index) => {
        const item = document.createElement('button')
        item.type = 'button'
        item.id = `settingsSearchResult-${index}`
        item.className = 'search-result'
        item.setAttribute('role', 'option')
        item.setAttribute('aria-selected', 'false')
        item.dataset.searchResult = String(index)
        const label = document.createElement('span')
        label.className = 'search-result-label'
        label.textContent = entry.label
        const meta = document.createElement('span')
        meta.className = 'search-result-meta'
        meta.textContent = [entry.routeLabel, entry.tabLabel].filter(Boolean).join(' · ')
        item.append(label, meta)
        item.addEventListener('mousedown', (event) => event.preventDefault())
        item.addEventListener('click', () => {
          closePanel()
          input.value = ''
          void openSearchResult(entry)
        })
        panel.append(item)
      })
      panel.hidden = false
      input.setAttribute('aria-expanded', 'true')
    }
    const focusInput = () => {
      input.focus()
      input.select()
    }

    input.addEventListener('input', render)
    input.addEventListener('focus', () => { if (input.value.trim()) render() })
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (panel.hidden) render()
        setActive(state.activeIndex + 1)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActive(state.activeIndex - 1)
      } else if (event.key === 'Enter') {
        const entry = state.results[state.activeIndex] || state.results[0]
        if (!entry) return
        event.preventDefault()
        closePanel()
        input.value = ''
        void openSearchResult(entry)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        closePanel()
        input.value = ''
        input.blur()
      }
    })
    document.addEventListener('keydown', (event) => {
      const isShortcut = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey &&
        (event.key === 'k' || event.key === 'K')
      if (isShortcut) {
        event.preventDefault()
        focusInput()
        render()
      }
    })
    document.addEventListener('mousedown', (event) => {
      if (panel.hidden) return
      if (input.contains(event.target) || panel.contains(event.target)) return
      closePanel()
    })
    closePanel()
    initSettingsSearch.instance = {
      input,
      panel,
      refresh () {
        rebuild()
        if (!panel.hidden) render()
      }
    }
    return initSettingsSearch.instance
  }

  function refreshSettingsSearchLanguage () {
    if (initSettingsSearch.instance) initSettingsSearch.instance.refresh()
  }

  return {
    MAX_QUERY_TOKENS,
    RESULTS_LIMIT,
    TERM_WEIGHT,
    HIGHLIGHT_CLASS,
    ROUTE_SEARCH_KEYS,
    TAB_ATTRIBUTE_BY_ROUTE,
    SETTINGS_SEARCH_INDEX,
    normalizeQuery,
    resolveSettingsSearchIndex,
    searchSettings,
    initSettingsSearch,
    refreshSettingsSearchLanguage,
    openSearchResult
  }
})
