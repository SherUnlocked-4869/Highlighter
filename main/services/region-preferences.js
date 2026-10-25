// Region reuse + size presets: main-process service (feature B, plan
// docs/plans/2026-10-25-snow-apps-feature-development-plan.md §5.2, backend half).
//
// Layering (plan §3.1):
//   * every domain rule, coordinate conversion and preset/last-region check lives in
//     shared/region-presets.js - the renderer and the main process must share ONE
//     interpretation, so this file never re-implements any of it;
//   * this file only persists the `screenshot.regionPreferences` block, allocates ids,
//     and translates "which mode / which preset / the remembered region" into one
//     domain resolution;
//   * this file does NOT require Electron. The display list is injected
//     (getDisplays / resolveDisplay), which is what keeps resolveInput unit-testable
//     and gives the v1 "single display only" rule a single place to live.
//
// The persistence key is exactly `screenshot.regionPreferences` (plan §5.1). An older
// store without `lastByMode` / `presets` is legal: reads always normalize first
// (plan §5.2 - a missing lastByMode and an empty array must not be mis-rejected by the
// template type validation).
//
// Return style matches the rest of main/services: expected business failures come back
// as `{ ok:false, code }` instead of throwing (exceptions are reserved for programmer
// error, e.g. a missing getSettings collaborator). Every `code` is an English
// identifier; the copy is the caller's job (main/** must stay CJK-free, which the
// check-i18n gate enforces).

const regionPresets = require('../../shared/region-presets')

const { LIMITS, REGION_MODES } = regionPresets

// read() runs once per IPC call, so a legacy store must not re-log the same diagnostic
// on every poll. The dedupe key is code+path and lives for the process.
const MAX_LOGGED_DIAGNOSTICS = 200

function noop() {}

function createRegionPreferences({
  getSettings,
  updateSettings,
  // Injected shared module (defaults to the shared domain layer). Tests pass a stub to
  // assert delegation; production never passes it. The name keeps the task contract's
  // `normalize`, but it is the whole domain module - every domain call goes through this
  // single injection point.
  normalize = regionPresets,
  log = noop,
  getDisplays = null,
  resolveDisplay = null,
  createId = null,
  now = Date.now
} = {}) {
  if (typeof getSettings !== 'function') throw new TypeError('region preferences require getSettings()')
  if (typeof updateSettings !== 'function') throw new TypeError('region preferences require updateSettings()')
  const domain = normalize || regionPresets

  const loggedDiagnostics = new Set()
  let idCounter = 0

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------
  function read() {
    const settings = getSettings() || {}
    const raw = settings.screenshot && typeof settings.screenshot === 'object'
      ? settings.screenshot.regionPreferences
      : undefined
    const { preferences, diagnostics } = domain.normalizeRegionPreferences(raw)
    reportDiagnostics(diagnostics)
    return preferences
  }

  function reportDiagnostics(diagnostics) {
    if (!Array.isArray(diagnostics) || !diagnostics.length) return
    for (const item of diagnostics) {
      const key = `${item.code}|${item.path}`
      if (loggedDiagnostics.has(key)) continue
      if (loggedDiagnostics.size >= MAX_LOGGED_DIAGNOSTICS) loggedDiagnostics.clear()
      loggedDiagnostics.add(key)
      log(`Region preferences: ${item.code} at ${item.path || '<root>'} - ${item.message}`)
    }
  }

  function persist(preferences) {
    // Write the whole block: arrays are replaced wholesale by the settings deep merge,
    // so a whole-block write is the only shape where "changing only presets cannot
    // silently drop lastByMode" is true by construction rather than by merge luck.
    updateSettings({ screenshot: { regionPreferences: preferences } })
    return preferences
  }

  // ---------------------------------------------------------------------------
  // Id allocation
  // ---------------------------------------------------------------------------
  function allocateId(existingPresets) {
    if (typeof createId === 'function') return String(createId(existingPresets))
    const used = new Set(existingPresets.map((preset) => preset.id))
    let candidate
    // Bounded collision retry: the timestamp + counter is effectively unique, but the
    // store may have been hand-edited, so the result is still checked instead of assumed.
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      idCounter += 1
      candidate = `preset-${now().toString(36)}-${idCounter.toString(36)}`
      if (!used.has(candidate)) return candidate
    }
    return `preset-${now().toString(36)}-${idCounter.toString(36)}-x`
  }

  // ---------------------------------------------------------------------------
  // Presets
  // ---------------------------------------------------------------------------
  // The resulting list is validated through domain.assertRegionPreferencesPatch: it is
  // already the strict entry point (per-item id/name/size/pixel-budget/duplicate-id and
  // the count cap), and a second copy here would drift from it.
  function savePreset(input = {}) {
    const source = input && typeof input === 'object' ? input : {}
    const current = read()
    const requestedId = typeof source.id === 'string' ? source.id.trim() : ''
    const existingIndex = requestedId
      ? current.presets.findIndex((preset) => preset.id === requestedId)
      : -1
    const existing = existingIndex >= 0 ? current.presets[existingIndex] : null

    const name = typeof source.name === 'string' ? source.name.trim() : ''
    if (!name) return fail('invalid-preset', 'Preset name is required')
    if (name.length > LIMITS.MAX_NAME_LENGTH) {
      return fail('invalid-preset', `Preset name must be at most ${LIMITS.MAX_NAME_LENGTH} characters`)
    }
    const widthPx = readEdge(source.widthPx)
    const heightPx = readEdge(source.heightPx)
    if (widthPx === null || heightPx === null) {
      return fail('invalid-preset', `Preset sizes must be integers between ${LIMITS.MIN_EDGE_PX} and ${LIMITS.MAX_EDGE_PX}`)
    }
    if (widthPx * heightPx > LIMITS.MAX_TOTAL_PIXELS) {
      return fail('invalid-preset', 'Preset exceeds the total pixel budget')
    }
    // Names are unique, case-insensitively: two identically named presets cannot be told
    // apart in a dropdown, so the user could not delete the right one either.
    const duplicate = current.presets.find((preset) => (
      preset.id !== existing?.id && preset.name.toLowerCase() === name.toLowerCase()
    ))
    if (duplicate) return fail('duplicate-name', `A preset named "${duplicate.name}" already exists`)

    const id = existing ? existing.id : allocateId(current.presets)
    const preset = { id, name, widthPx, heightPx }
    const presets = existing
      ? current.presets.map((item) => (item.id === existing.id ? preset : item))
      : [...current.presets, preset]
    if (!existing && presets.length > LIMITS.MAX_PRESETS) {
      return fail('limit-reached', `At most ${LIMITS.MAX_PRESETS} presets can be saved`)
    }

    const next = { ...current, presets }
    const rejection = checkPatch(next)
    if (rejection) return rejection
    persist(next)
    return { ok: true, preset, preferences: next }
  }

  function deletePreset(id) {
    const current = read()
    const target = String(id === undefined || id === null ? '' : id).trim()
    if (!target || !current.presets.some((preset) => preset.id === target)) {
      return fail('not-found', 'Preset not found')
    }
    const next = { ...current, presets: current.presets.filter((preset) => preset.id !== target) }
    persist(next)
    return { ok: true, preferences: next }
  }

  // ---------------------------------------------------------------------------
  // Resolve: preset size / remembered region -> a pixel rect on the current display
  // ---------------------------------------------------------------------------
  function readDisplays() {
    if (typeof getDisplays !== 'function') return []
    const displays = getDisplays()
    return Array.isArray(displays) ? displays : []
  }

  // v1 is single-display: a preset size resolves against the CURRENT display, which the
  // caller guarantees is the first entry of getDisplays(). "Which of several monitors
  // should a 1920x1080 preset land on" is a v2 product question, not a bug here.
  function resolvePresetAgainstCurrentDisplay(preset) {
    const displays = readDisplays()
    const target = displays[0]
    if (!target) {
      // A caller that injected only resolveDisplay(rect) cannot answer "which display is
      // current", and a preset needs the screen size to resolve. Failing explicitly sends
      // it down the documented "centre on the current screen" fallback instead of guessing.
      return fail('display-unavailable', 'No display is available to resolve the preset against')
    }
    const resolved = domain.resolvePresetRect({
      preset,
      displayPixelSize: target.pixelSize,
      displayBoundsDip: target.boundsDip
    })
    if (!resolved.ok) return fail(resolved.code || 'invalid-display', 'Preset could not be resolved against the display')
    return {
      ok: true,
      // Both rects come from the domain module's single per-axis mapping
      // (displayScale -> rectDipToDisplayPx / rectDisplayPxToDip), never a second formula.
      rectDisplayPx: resolved.rectDisplayPx,
      rectDip: resolved.rectDip,
      displayKey: target.key,
      appliedPixelSize: resolved.appliedPixelSize,
      adjusted: resolved.adjusted
    }
  }

  function resolveLastAgainstDisplays(lastRegion) {
    const displays = readDisplays()
    if (displays.length) {
      const resolved = domain.resolveLastRegion({ lastRegion, displays })
      if (!resolved.ok) return fail(resolved.code || 'display-changed', 'The remembered region no longer matches a display')
      return {
        ok: true,
        rectDisplayPx: resolved.rectDisplayPx,
        rectDip: resolved.rectDip,
        displayKey: resolved.displayKey,
        adjusted: resolved.adjusted
      }
    }
    // Second injection surface when no list is available: resolveDisplay(rect) answers
    // "which display owns this rect" directly. It is still injected by the main process,
    // so this service keeps its no-Electron property.
    if (typeof resolveDisplay === 'function') {
      const matched = resolveDisplay(lastRegion.rectDisplayPx)
      if (!matched) return fail('display-changed', 'The remembered region no longer matches a display')
      const resolved = domain.resolveLastRegion({ lastRegion, displays: [matched] })
      if (!resolved.ok) return fail(resolved.code || 'display-changed', 'The remembered region no longer matches a display')
      return {
        ok: true,
        rectDisplayPx: resolved.rectDisplayPx,
        rectDip: resolved.rectDip,
        displayKey: resolved.displayKey,
        adjusted: resolved.adjusted
      }
    }
    return fail('display-unavailable', 'No display provider is configured')
  }

  function resolveInput(input = {}) {
    const source = input && typeof input === 'object' ? input : {}
    const mode = source.mode
    if (!REGION_MODES.includes(mode)) {
      return fail('invalid-mode', `mode must be one of ${REGION_MODES.join(', ')}`)
    }
    const useLast = source.last === true
    const presetId = typeof source.presetId === 'string' ? source.presetId.trim() : ''
    if (!useLast && !presetId) {
      return fail('invalid-input', 'Provide either last:true or a presetId')
    }
    const preferences = read()
    if (useLast) {
      const lastRegion = preferences.lastByMode[mode]
      if (!lastRegion) return fail('no-last-region', `No ${mode} region has been remembered yet`)
      return resolveLastAgainstDisplays(lastRegion)
    }
    const preset = preferences.presets.find((item) => item.id === presetId)
    if (!preset) return fail('not-found', 'Preset not found')
    return resolvePresetAgainstCurrentDisplay(preset)
  }

  // Records the remembered region from a *confirmed* selection. This is the only entry point the
  // domains use, and it exists to make the unit mistake impossible: the capture/record domains
  // compute `selectionBounds` from Electron window bounds, which are DIP, NOT display pixels. The
  // conversion is therefore done here (`space: 'dip'`) instead of trusting each caller to remember
  // it - getting it wrong makes the remembered region scaleFactor-times too large on every
  // non-100% display, which is exactly the mixed-DPI acceptance case in plan §5.3.
  function recordFromDisplaySelection({ mode, display, selectionBounds } = {}) {
    if (!REGION_MODES.includes(mode)) return fail('invalid-mode', `mode must be one of ${REGION_MODES.join(', ')}`)
    const lastRegion = domain.createLastRegionFromSelection({
      selection: selectionBounds,
      display: display || {},
      space: 'dip'
    })
    // A selection too small / non-finite to represent is a normal "nothing to remember" case, not an
    // error: the previous remembered region must survive a degenerate drag (plan §5.1: a cancelled
    // selection does not overwrite the record).
    if (!lastRegion) return fail('selection-unusable', 'The selection cannot be remembered as a region')
    return recordLastRegion({ mode, lastRegion })
  }

  // ---------------------------------------------------------------------------
  // Record the remembered region (main-process internal action; plan §5.2: no
  // arbitrary write channel is exposed for it)
  // ---------------------------------------------------------------------------
  function recordLastRegion({ mode, lastRegion } = {}) {
    if (!REGION_MODES.includes(mode)) return fail('invalid-mode', `mode must be one of ${REGION_MODES.join(', ')}`)
    const checked = domain.validateLastRegion(lastRegion)
    if (!checked.ok) return fail('invalid-last-region', `Last region is invalid (${checked.code})`)
    const current = read()
    const next = { ...current, lastByMode: { ...current.lastByMode, [mode]: checked.value } }
    const rejection = checkPatch(next)
    if (rejection) return rejection
    persist(next)
    return { ok: true, lastByMode: next.lastByMode }
  }

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------
  function reset() {
    const defaults = domain.createDefaultRegionPreferences()
    // Same last gate as every other write: the defaults are supposed to be valid, but the
    // invariant "this service never stores a block the strict validator rejects" is worth
    // more than the few microseconds it costs here.
    const rejection = checkPatch(defaults)
    if (rejection) return rejection
    persist(defaults)
    return defaults
  }

  // Last gate before a write: even objects this service just built must pass the shared
  // strict validator. Otherwise a service bug would store invalid data that the read path
  // can only silently drop.
  function checkPatch(preferences) {
    try {
      domain.assertRegionPreferencesPatch(preferences)
      return null
    } catch (error) {
      return fail('invalid-preset', error && error.message ? error.message : 'Region preferences are invalid')
    }
  }

  function readEdge(value) {
    // A real number only: '1920' must be rejected, not quietly turned into 1920
    // (plan §5.2 - new IPC input is rejected, never rewritten into a different size).
    if (typeof value !== 'number' || !Number.isInteger(value)) return null
    if (value < LIMITS.MIN_EDGE_PX || value > LIMITS.MAX_EDGE_PX) return null
    return value
  }

  return {
    read,
    savePreset,
    deletePreset,
    resolveInput,
    recordLastRegion,
    recordFromDisplaySelection,
    reset
  }
}

function fail(code, message) {
  return { ok: false, code, message }
}

module.exports = {
  createRegionPreferences,
  REGION_PREFERENCES_SETTINGS_KEY: 'screenshot.regionPreferences'
}
