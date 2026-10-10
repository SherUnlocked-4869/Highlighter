'use strict'

// Locale table for English (United States).
//
// W0-4 (2026-10-10) lands the empty skeleton so the checker and the shared
// runtime exist before batch C; S1 fills the tables. The key set must stay
// symmetric with zh-CN and zh-TW (scripts/check-i18n.js enforces it).
globalThis.__LOCALES = globalThis.__LOCALES || {}
globalThis.__LOCALES['en-US'] = {}
