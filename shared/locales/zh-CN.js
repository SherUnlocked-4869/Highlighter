'use strict'

// Locale table for Simplified Chinese.
//
// W0-4 (2026-10-10) lands the empty skeleton so the checker and the shared
// runtime exist before batch C; S1 fills the tables.
//
// Key convention: <domain>.<module>.<semantic>  (e.g. capture.toolbar.save)
// Tables are plain <script> globals on purpose: every Highlighter window runs
// under `default-src 'none'; connect-src 'none'`, so JSON cannot be fetched.
globalThis.__LOCALES = globalThis.__LOCALES || {}
globalThis.__LOCALES['zh-CN'] = {}
