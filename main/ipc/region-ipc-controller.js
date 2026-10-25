// Region reuse + size preset IPC (feature B, plan §5.2).
//
// Four invoke channels, all under the `capture` role:
//   region:get-preferences -> what the overlay may show (presets + "is there a last region?")
//   region:save-preset     -> add or update one named output size
//   region:delete-preset   -> remove one
//   region:resolve         -> "the last region" / "this preset" -> a validated DIP rect
//
// Deliberate omissions (plan §5.2): there is NO channel that accepts a desktop rectangle and
// stores it as the remembered region. Remembering a region is a domain-internal action - the
// capture/record domains call `recordLastRegion` themselves once a region is actually confirmed
// and an effective action happened, so a renderer can never teach the feature a forged geometry.
//
// Read path returns DIP (`rect`), not device pixels: the overlay draws in CSS px and its own
// origin is the capture window's DIP origin, so DIP is the only space it can use directly. The
// pixel space stays a main-process concept; `resolveLastRegion`/`resolvePresetRect` already did
// the per-axis pixel->DIP mapping, and this module does not re-derive it.
//
// Electron display mapping lives here (not in the service), because this is the layer allowed to
// know about `screen.getAllDisplays()`: pixelSize comes from the display's native bounds via
// `dipToScreenRect`, which is the same primitive main.js already uses for display diagnostics.

const REGION_MODES = Object.freeze(['capture', 'record'])
const MAX_PRESET_ID_LENGTH = 64
const MAX_PRESET_NAME_LENGTH = 40

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

// Electron `Display` -> the descriptor `shared/region-presets.js` consumes.
// `pixelSize` is measured, never assumed: on a mixed-DPI desktop the ratio between bounds and
// native bounds is not `scaleFactor` for every display, so deriving it from the DIP rect and the
// native rect is the only reliable source.
function describeDisplay(display, dipToScreenRect) {
  if (!display || !display.bounds) return null
  const bounds = display.bounds
  const boundsDip = {
    x: Math.round(finiteNumber(bounds.x) ?? 0),
    y: Math.round(finiteNumber(bounds.y) ?? 0),
    width: Math.round(finiteNumber(bounds.width) ?? 0),
    height: Math.round(finiteNumber(bounds.height) ?? 0)
  }
  if (!(boundsDip.width > 0) || !(boundsDip.height > 0)) return null
  let pixelSize = null
  if (typeof dipToScreenRect === 'function') {
    try {
      const native = dipToScreenRect(null, bounds)
      const width = Math.round(finiteNumber(native?.width) ?? 0)
      const height = Math.round(finiteNumber(native?.height) ?? 0)
      if (width > 0 && height > 0) pixelSize = { width, height }
    } catch {
      pixelSize = null
    }
  }
  if (!pixelSize) {
    // Fallback for hosts without a native rect probe (and for tests): scaleFactor is advisory,
    // but it is the only second source and a wrong ratio only shifts the remembered rect.
    const scale = finiteNumber(display.scaleFactor) || 1
    const width = Math.round(boundsDip.width * scale)
    const height = Math.round(boundsDip.height * scale)
    if (!(width > 0) || !(height > 0)) return null
    pixelSize = { width, height }
  }
  return {
    key: display.id === undefined || display.id === null ? String(boundsDip.x) + ':' + String(boundsDip.y) : String(display.id),
    boundsDip,
    pixelSize,
    scaleFactor: finiteNumber(display.scaleFactor) || 1
  }
}

// The descriptor list the service resolves against. The first entry must be the CURRENT display:
// `region-preferences` resolves presets against `displays[0]` (v1 is single-display by design),
// so the ordering is the contract, not a convenience.
function createDisplayProvider({ screen, dipToScreenRect, getCursorPoint } = {}) {
  if (!screen || typeof screen.getAllDisplays !== 'function') {
    throw new TypeError('Region display provider requires a screen module')
  }
  return function getRegionDisplays() {
    const all = screen.getAllDisplays()
    const cursor = typeof getCursorPoint === 'function' ? getCursorPoint() : null
    const current = cursor && typeof screen.getDisplayNearestPoint === 'function'
      ? screen.getDisplayNearestPoint(cursor)
      : null
    const ordered = current ? [current, ...all.filter((display) => display.id !== current.id)] : all
    return ordered.map((display) => describeDisplay(display, dipToScreenRect)).filter(Boolean)
  }
}

function fail(code, message) {
  return { ok: false, code, ...(message ? { message } : {}) }
}

// Renderer-facing projection of the stored preferences. The stored `lastByMode` entries carry the
// user's desktop geometry; the overlay does not need it (it asks `region:resolve` when the user
// actually chooses "reuse last"), so it is reduced to a boolean per mode. Presets are user-authored
// label+size pairs and are safe to send as-is.
function toPublicPreferences(preferences, limits) {
  const modes = preferences?.lastByMode || {}
  return {
    presets: Array.isArray(preferences?.presets)
      ? preferences.presets.map((preset) => ({ ...preset }))
      : [],
    lastAvailable: {
      capture: !!modes.capture,
      record: !!modes.record
    },
    limits: {
      maxPresets: Number(limits?.MAX_PRESETS) || 0,
      maxNameLength: Number(limits?.MAX_NAME_LENGTH) || 0,
      minEdgePx: Number(limits?.MIN_EDGE_PX) || 0,
      maxEdgePx: Number(limits?.MAX_EDGE_PX) || 0
    }
  }
}

function createRegionController({ preferences, limits, log = () => {} } = {}) {
  if (!preferences || typeof preferences.resolveInput !== 'function') {
    throw new TypeError('Region controller requires the region preferences service')
  }

  function publicSnapshot() {
    return toPublicPreferences(preferences.read(), limits)
  }

  return {
    getPreferences: () => {
      try {
        return { ok: true, ...publicSnapshot() }
      } catch (error) {
        log('Region preferences read failed:', error?.message || error)
        return fail('unavailable')
      }
    },
    // Resolve -> DIP rect. `adjusted` is forwarded verbatim so the overlay can tell the user the
    // region was adjusted (with the real reason) instead of pretending the preset/last region was
    // honoured exactly.
    resolve: (_event, payload = {}) => {
      const source = payload && typeof payload === 'object' ? payload : {}
      const mode = REGION_MODES.includes(source.mode) ? source.mode : ''
      if (!mode) return fail('invalid-mode')
      const presetId = typeof source.presetId === 'string' ? source.presetId.trim() : ''
      if (!presetId && source.last !== true) return fail('invalid-input')
      let result
      try {
        result = preferences.resolveInput({
          mode,
          presetId: presetId || undefined,
          last: source.last === true
        })
      } catch (error) {
        log('Region resolve failed:', error?.message || error)
        return fail('unavailable')
      }
      if (!result?.ok) return fail(result?.code || 'unresolved')
      const rect = result.rectDip
      if (!rect || !(rect.width >= 1) || !(rect.height >= 1)) return fail('unresolved')
      return {
        ok: true,
        mode,
        displayKey: result.displayKey || '',
        rect: {
          x: Math.round(Number(rect.x) || 0),
          y: Math.round(Number(rect.y) || 0),
          width: Math.max(1, Math.round(Number(rect.width) || 1)),
          height: Math.max(1, Math.round(Number(rect.height) || 1))
        },
        ...(result.appliedPixelSize ? { pixelSize: { ...result.appliedPixelSize } } : {}),
        adjusted: Array.isArray(result.adjusted) ? result.adjusted.map((entry) => ({ ...entry })) : []
      }
    },
    savePreset: (_event, payload = {}) => {
      const source = payload && typeof payload === 'object' ? payload : {}
      const name = typeof source.name === 'string' ? source.name.trim() : ''
      if (!name || name.length > MAX_PRESET_NAME_LENGTH) return fail('invalid-preset')
      const widthPx = Math.round(finiteNumber(source.widthPx) ?? 0)
      const heightPx = Math.round(finiteNumber(source.heightPx) ?? 0)
      if (!widthPx || !heightPx) return fail('invalid-preset')
      const id = typeof source.id === 'string' ? source.id.trim() : ''
      if (id && id.length > MAX_PRESET_ID_LENGTH) return fail('invalid-preset')
      let result
      try {
        result = preferences.savePreset({ ...(id ? { id } : {}), name, widthPx, heightPx })
      } catch (error) {
        log('Region preset save failed:', error?.message || error)
        return fail('unavailable')
      }
      if (!result?.ok) return { ok: false, code: result?.code || 'invalid-preset' }
      // Only the changed preset goes back; the renderer already holds the rest of the list and a
      // full preferences round trip would let a stale renderer overwrite a concurrent change.
      return { ok: true, preset: { ...result.preset }, ...publicSnapshot() }
    },
    deletePreset: (_event, payload = {}) => {
      const source = payload && typeof payload === 'object' ? payload : {}
      const id = typeof source.id === 'string' ? source.id.trim() : ''
      if (!id) return fail('not-found')
      let result
      try {
        result = preferences.deletePreset(id)
      } catch (error) {
        log('Region preset delete failed:', error?.message || error)
        return fail('unavailable')
      }
      if (!result?.ok) return { ok: false, code: result?.code || 'not-found' }
      return { ok: true, ...publicSnapshot() }
    }
  }
}

module.exports = {
  MAX_PRESET_ID_LENGTH,
  MAX_PRESET_NAME_LENGTH,
  REGION_MODES,
  createDisplayProvider,
  createRegionController,
  describeDisplay,
  toPublicPreferences
}
