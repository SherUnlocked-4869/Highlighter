'use strict'

// I18n bootstrap for the CommonJS main process (S13 / P0-1-T6).
//
// Why this file exists: `t()` from shared/i18n.js resolves keys against
// `globalThis.__LOCALES`, which in the main process is populated as a side effect
// of requiring shared/locales/*.js. A window gets that for free from its
// `<script>` tags; a main-process module does not, so something has to require
// the tables before the first `t()` call. Requiring them from `main.js` would be
// a Lead-owned edit to a file S13 must not touch, and would leave every module
// silently untranslated in unit tests (which require modules directly). Instead
// each translating module requires this file at the top:
//
//   const { t } = require('./i18n-bootstrap')
//
// Registration is not done once at module scope but on every entry into this
// module, because the tables are process-global mutable state: a test file may
// reset `globalThis.__LOCALES` and reload shared/locales/* itself
// (test/i18n.test.js does exactly that), and a once-only bootstrap would then
// hand back an empty bag. Re-entering on each call into the module keeps the
// tables present without ever clearing what a caller registered, so it can only
// add the keys this module knows about — it never subtracts or overwrites the
// tables another stream owns.
//
// `shared/locales/*.js` is enumerated rather than hard-coded so a domain file
// added later is picked up automatically (same rule scripts/check-i18n.js uses).

const fs = require('node:fs')
const path = require('node:path')

const localesDirectory = path.join(__dirname, '..', '..', 'shared', 'locales')

function localeFiles() {
  return fs.readdirSync(localesDirectory)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => path.join(localesDirectory, name))
}

function registerLocales() {
  globalThis.__LOCALES = globalThis.__LOCALES || {}
  for (const file of localeFiles()) {
    // A fresh evaluation per call: a test that replaced the bag must be able to
    // get the tables back without restarting the process.
    delete require.cache[require.resolve(file)]
    require(file)
  }
  return globalThis.__LOCALES
}

// The bag is now populated; the cached shared/i18n.js keeps its own module state
// (`activeLanguage`), so its `t`/`setLanguage` are the ones the main process uses.
const i18n = require('../../shared/i18n')

registerLocales()

module.exports = {
  ...i18n,
  localeFiles,
  registerLocales
}
