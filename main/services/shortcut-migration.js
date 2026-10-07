const { isValidAccelerator, normalizeAccelerator } = require('../../shared/shortcut-keys')

/*
 * Shortcut settings repair.
 *
 * Builds older than shared/shortcut-keys.js recorded whatever the browser
 * reported, so a keystroke captured while an input method was composing landed
 * in the settings as "Process". That value can never register, and every start
 * logged `Shortcut registration failed: Process ...`. Clearing it once here
 * fixes every machine that already has it, and normalising the surviving values
 * (modifier order, key spelling) keeps them stable across releases.
 *
 * Pure: same shape as appearance-migration.js. `log` is injected so the caller
 * keeps a single line of wiring.
 */

function migrateShortcutSettings(settings, { log = () => {} } = {}) {
  const source = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {}
  const shortcuts = source.shortcuts
  if (!shortcuts || typeof shortcuts !== 'object' || Array.isArray(shortcuts)) {
    return { settings: source, changed: false, cleared: [], normalized: [] }
  }

  const next = {}
  const cleared = []
  const normalized = []
  let changed = false

  for (const [name, value] of Object.entries(shortcuts)) {
    const raw = typeof value === 'string' ? value.trim() : ''
    if (!raw) {
      next[name] = ''
      if (value !== '') {
        changed = true
        cleared.push(name)
      }
      continue
    }
    if (!isValidAccelerator(raw)) {
      next[name] = ''
      changed = true
      cleared.push(name)
      continue
    }
    const canonical = normalizeAccelerator(raw)
    next[name] = canonical
    if (canonical !== value) {
      changed = true
      normalized.push(name)
    }
  }

  if (!changed) return { settings: source, changed: false, cleared: [], normalized: [] }
  if (cleared.length || normalized.length) log('Shortcut settings repaired:', { cleared, normalized })
  return { settings: { ...source, shortcuts: next }, changed: true, cleared, normalized }
}

module.exports = { migrateShortcutSettings }
