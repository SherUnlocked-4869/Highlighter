'use strict'

// Locale table for Simplified Chinese.
//
// W0-4 (2026-10-10) lands the empty skeleton so the checker and the shared
// runtime exist before batch C; S1 (2026-10-11) fills it with the cross-window
// keys. A `<domain>.js` file (see shared/locales/config.js) merges its keys into
// the same bag for all three languages, so the windows only have to load the
// files they use and their order does not matter.
//
// Key convention: <domain>.<module>.<semantic>  (e.g. capture.toolbar.save)
// Tables are plain <script> globals on purpose: every Highlighter window runs
// under `default-src 'none'; connect-src 'none'`, so JSON cannot be fetched.
globalThis.__LOCALES = globalThis.__LOCALES || {}
Object.assign(globalThis.__LOCALES['zh-CN'] = globalThis.__LOCALES['zh-CN'] || {}, {
  'common.button.ok': '确定',
  'common.button.cancel': '取消',
  'common.button.save': '保存',
  'common.button.close': '关闭',
  'common.button.apply': '应用',
  'common.button.reset': '恢复默认',
  'common.button.retry': '重试',
  'common.button.copy': '复制',
  'common.button.delete': '删除',
  'common.button.confirm': '确认',
  'common.label.language': '界面语言',
  'common.label.loading': '加载中…',
  'common.label.empty': '暂无内容',
  'common.label.error': '出错了',
  'common.language.zh': '简体中文',
  'common.language.en': 'English',
  'common.language.zh-hant': '繁體中文'
})
