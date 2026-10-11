'use strict'

// Domain locale table: the settings window (`config/`).
//
// Layout decision (2026-10-11, Lead; plan §10.3): one file per domain, each file
// registering all three languages for that domain. The three per-language files
// keep the cross-window keys; this file owns `config.*` alone, so the wave-9
// `config` migration never shares a write target with another stream.
//
// Checker contract (scripts/check-i18n.js): every file in shared/locales/ is
// loaded, every language must be registered here, and every key must match
// /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/ — hence `config.route.home`,
// `config.function.screenshot`, `config.function.screenshot-fixed`. A camelCase
// or uppercase segment is rejected by check ②, so the function ids carry a
// hyphen instead.
//
// The entries below seed the two tables that config/config.js already keeps
// centralised (`routeTitles`, `functionGroups`) plus the name of the language
// setting; the remaining strings land in P0-1-T3.
;(function () {
  const tables = (globalThis.__LOCALES = globalThis.__LOCALES || {})
  const add = (language, entries) => Object.assign((tables[language] = tables[language] || {}), entries)

  add('zh-CN', {
    'config.route.home': '快捷功能',
    'config.route.translation': '翻译',
    'config.route.chat': 'AI 对话',
    'config.route.history': '截图历史',
    'config.route.appearance': '外观配色',
    'config.route.plugins': '插件',
    'config.route.settings-general': '界面设置',
    'config.route.settings-function': '功能设置',
    'config.route.settings-hotkeys': '热键设置',
    'config.route.models': '模型',
    'config.route.selection-toolbar': '划词工具',
    'config.route.local-search': '本地搜索',
    'config.route.settings-system': '系统设置',
    'config.route.about': '关于',
    'config.function.screenshot': '截图',
    'config.function.screenshot-delay': '延迟截图',
    'config.function.screenshot-fixed': '固定到屏幕',
    'config.function.screenshot-ocr': '文本识别',
    'config.function.screenshot-table': '表格识别',
    'config.function.screenshot-qr': '二维码识别',
    'config.function.screenshot-ocr-translate': '文本识别翻译',
    'config.function.screenshot-copy': '复制到剪贴板',
    'config.function.screenshot-long': '长截图',
    'config.function.screenshot-full-screen': '截取全屏',
    'config.function.screenshot-focused-window': '当前焦点窗口',
    'config.setting.language': '界面语言'
  })

  add('en-US', {
    'config.route.home': 'Quick actions',
    'config.route.translation': 'Translation',
    'config.route.chat': 'AI chat',
    'config.route.history': 'Capture history',
    'config.route.appearance': 'Appearance',
    'config.route.plugins': 'Plugins',
    'config.route.settings-general': 'Interface',
    'config.route.settings-function': 'Features',
    'config.route.settings-hotkeys': 'Hotkeys',
    'config.route.models': 'Models',
    'config.route.selection-toolbar': 'Selection toolbar',
    'config.route.local-search': 'Local search',
    'config.route.settings-system': 'System',
    'config.route.about': 'About',
    'config.function.screenshot': 'Screenshot',
    'config.function.screenshot-delay': 'Delayed screenshot',
    'config.function.screenshot-fixed': 'Pin to screen',
    'config.function.screenshot-ocr': 'Text recognition',
    'config.function.screenshot-table': 'Table recognition',
    'config.function.screenshot-qr': 'QR code recognition',
    'config.function.screenshot-ocr-translate': 'Recognise and translate',
    'config.function.screenshot-copy': 'Copy to clipboard',
    'config.function.screenshot-long': 'Scrolling capture',
    'config.function.screenshot-full-screen': 'Full screen',
    'config.function.screenshot-focused-window': 'Active window',
    'config.setting.language': 'Interface language'
  })

  add('zh-TW', {
    'config.route.home': '快捷功能',
    'config.route.translation': '翻譯',
    'config.route.chat': 'AI 對話',
    'config.route.history': '截圖歷史',
    'config.route.appearance': '外觀配色',
    'config.route.plugins': '外掛',
    'config.route.settings-general': '介面設定',
    'config.route.settings-function': '功能設定',
    'config.route.settings-hotkeys': '快速鍵設定',
    'config.route.models': '模型',
    'config.route.selection-toolbar': '劃詞工具',
    'config.route.local-search': '本機搜尋',
    'config.route.settings-system': '系統設定',
    'config.route.about': '關於',
    'config.function.screenshot': '截圖',
    'config.function.screenshot-delay': '延遲截圖',
    'config.function.screenshot-fixed': '固定到螢幕',
    'config.function.screenshot-ocr': '文字辨識',
    'config.function.screenshot-table': '表格辨識',
    'config.function.screenshot-qr': '二維碼辨識',
    'config.function.screenshot-ocr-translate': '文字辨識翻譯',
    'config.function.screenshot-copy': '複製到剪貼簿',
    'config.function.screenshot-long': '長截圖',
    'config.function.screenshot-full-screen': '擷取全螢幕',
    'config.function.screenshot-focused-window': '目前焦點視窗',
    'config.setting.language': '介面語言'
  })
})()
