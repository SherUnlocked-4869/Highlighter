'use strict'

// A03 (docs/reviews/2026-11-24-windows-product-architecture-review.md): the rule that a rebind
// must be proven before it is persisted belongs to the shortcut domain, not to main.js's
// assembly. The service owns registration; this module owns the transaction around the
// settings write (trial -> persist -> undo on failure) and the game-mode draft rule.

function createShortcutDomain({ shortcutService, getSettings, isGameModeEnabled, t }) {
  if (!shortcutService) throw new TypeError('Shortcut domain requires the shortcut service')
  if (typeof getSettings !== 'function') throw new TypeError('Shortcut domain requires getSettings')

  function register() {
    const shortcuts = getSettings().shortcuts
    // Game mode suspends every global shortcut; a draft saved while it is on is validated
    // when the mode ends (applyGameModeState -> registerShortcuts).
    if (isGameModeEnabled()) return shortcutService.suspendAll(shortcuts, 'game-mode')
    // A03 (plan item 09): start-up and the exit from game mode are RECOVERY, not a
    // transaction. Each key is attempted on its own, so one accelerator another process owns
    // only degrades that entry; the statuses report every key's real result. A user rebind
    // still goes through preparePatch()/sync(), which keeps the old key when the new one is
    // rejected.
    return shortcutService.registerAll(shortcuts)
  }

  // Returns an undo function that restores the previous registration when the settings write
  // itself fails, or throws when the candidate combination cannot be registered. Nothing is
  // persisted before this returns.
  function preparePatch(patch) {
    if (!patch || !patch.shortcuts) return null
    if (isGameModeEnabled()) return null
    const previous = getSettings().shortcuts
    const candidate = { ...previous, ...patch.shortcuts }
    const outcome = shortcutService.sync(candidate)
    if (outcome.ok) return () => { shortcutService.sync(previous) }
    const failed = outcome.failed || {}
    const reason = failed.reason === 'invalid' ? t('main.shortcut.invalid') : t('main.shortcut.unavailable')
    const previousValue = String(previous[failed.name] || '').trim()
    const message = previousValue
      ? t('main.shortcut.rebind-failed', { accelerator: failed.accelerator || '', reason, previous: previousValue })
      : t('main.shortcut.rebind-failed-empty', { accelerator: failed.accelerator || '', reason })
    const error = new Error(message)
    error.code = 'shortcut-unavailable'
    throw error
  }

  return { register, preparePatch }
}

module.exports = { createShortcutDomain }
