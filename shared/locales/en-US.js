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
  'common.language.zh-hant': '繁體中文'
})
