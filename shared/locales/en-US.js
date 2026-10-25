'use strict'

// Locale table for English (United States).
//
// W0-4 (2026-10-10) lands the empty skeleton so the checker and the shared
// runtime exist before batch C; S1 (2026-10-11) fills it. The key set must stay
// symmetric with zh-CN and zh-TW (scripts/check-i18n.js enforces it).
globalThis.__LOCALES = globalThis.__LOCALES || {}
Object.assign(globalThis.__LOCALES['en-US'] = globalThis.__LOCALES['en-US'] || {}, {
  'common.button.ok': 'OK',
  'common.button.cancel': 'Cancel',
  'common.button.save': 'Save',
  'common.button.close': 'Close',
  'common.button.apply': 'Apply',
  'common.button.reset': 'Reset to defaults',
  'common.button.retry': 'Retry',
  'common.button.copy': 'Copy',
  'common.button.delete': 'Delete',
  'common.button.confirm': 'Confirm',
  'common.label.language': 'Interface language',
  'common.label.loading': 'Loading…',
  'common.label.empty': 'Nothing here yet',
  'common.label.error': 'Something went wrong',
  'common.language.zh': '简体中文',
  'common.language.en': 'English',
  'common.language.zh-hant': '繁體中文',
  // Feature A (plan §4.1/§4.2): the export result bar, shared by the capture and recognition
  // windows. It lives in the cross-window table because BOTH windows render it.
  'capture.export-result.saved': 'Saved: {fileName}',
  'capture.export-result.open': 'Open',
  'capture.export-result.copy-path': 'Address',
  'capture.export-result.reveal': 'Open folder',
  'capture.export-result.copied': 'Path copied',
  'capture.export-result.pending': 'Working…',
  'capture.export-result.open-failed': 'The file was saved, but no default app could open it.',
  'capture.export-result.file-missing': 'The file is no longer where it was saved; it may have been moved or deleted.',
  'capture.export-result.expired': 'This export result has expired. Export again to get a new one.',
  'capture.export-result.action-failed': 'The file was saved, but the action failed.',
})
