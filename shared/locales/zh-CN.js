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
  'common.language.zh-hant': '繁體中文',
  // Feature A (plan §4.1/§4.2): the export result bar, shared by the capture and recognition
  // windows. It lives in the cross-window table because BOTH windows render it.
  'capture.export-result.saved': '已保存：{fileName}',
  'capture.export-result.open': '打开',
  'capture.export-result.copy-path': '地址',
  'capture.export-result.reveal': '打开文件夹',
  'capture.export-result.copied': '路径已复制',
  'capture.export-result.pending': '处理中…',
  'capture.export-result.open-failed': '文件已保存，但无法用默认应用打开。',
  'capture.export-result.file-missing': '文件已不在原位置，可能已被移动或删除。',
  'capture.export-result.expired': '这条导出结果已失效，请重新导出。',
  'capture.export-result.action-failed': '文件已保存，但操作失败。',
})
