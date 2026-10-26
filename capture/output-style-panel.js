'use strict'

// Finished-look panel controller - feature C
// (docs/plans/2026-10-25-snow-apps-feature-development-plan.md §6.1/§6.2/§6.3).
//
// Why this is its own file: capture.js is already 3400+ lines and the panel needs its own
// testable state machine (presets, coalesced slider gestures, undo frames). capture.js keeps only
// the wiring - "who shows the panel", "what happens when the style changes", "which export exit
// composes" - while this module owns the controls, the throttling and the style timeline.
//
// Two rules this module exists to enforce:
//
//   1. ONE undo frame per gesture (§6.3). A range input fires `input` dozens of times while it is
//      dragged; those are live previews, not history entries. Only the gesture end (`change`, with
//      `pointerup` as the fallback for keyboard/edge cases) pushes a frame. Switching a preset is
//      itself one frame, and so is switching back to "original" - that is what makes "restore
//      original is undoable" true.
//
//   2. The panel never invents geometry. Every number it stores is a plain outputStyle field; the
//      preview and the exports both hand that object to the shared compositor, so what the user
//      sees and what gets written cannot drift (§6.1 forbids a CSS-only preview because it would).
//
// The module has no DOM at load time: `mount()` is what touches elements, and it takes the
// document (and optionally an element lookup) so a node test can drive it with stubs.
;(function exposeOutputStylePanel(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else if (root) root.outputStylePanel = api
})(typeof globalThis === 'object' ? globalThis : typeof window === 'object' ? window : this, () => {
  'use strict'

  // The style contract has to resolve the same way in both environments. In a window the
  // <script> tag that loads it runs first (capture.html); in node tests it is required directly.
  function resolveStyleApi(explicit) {
    if (explicit) return explicit
    if (typeof module === 'object' && module.exports) return require('../shared/capture-output-style.js')
    return (typeof globalThis === 'object' ? globalThis.captureOutputStyle : null) || null
  }

  // Control table. Each row is one field of outputStyle, so adding a control is one row plus one
  // element in the markup - no per-control wiring. `read`/`write` convert between the DOM value
  // (a string in 0..max) and the document value (a finite number or a #rrggbb colour).
  const CONTROLS = Object.freeze([
    { id: 'outputPadding', path: ['paddingPx'], kind: 'number', max: 512, outputId: 'outputPaddingValue', suffix: 'px' },
    { id: 'outputCornerRadius', path: ['cornerRadiusPx'], kind: 'number', max: 512, outputId: 'outputCornerRadiusValue', suffix: 'px' },
    { id: 'outputBackgroundColor', path: ['background', 'color'], kind: 'color' },
    { id: 'outputBackgroundAlpha', path: ['background', 'alpha'], kind: 'alpha', outputId: 'outputBackgroundAlphaValue' },
    { id: 'outputBorderWidth', path: ['border', 'widthPx'], kind: 'number', max: 64, outputId: 'outputBorderWidthValue', suffix: 'px' },
    { id: 'outputBorderColor', path: ['border', 'color'], kind: 'color' },
    { id: 'outputShadowEnabled', path: ['shadow', 'enabled'], kind: 'boolean' },
    { id: 'outputShadowBlur', path: ['shadow', 'blurPx'], kind: 'number', max: 256, outputId: 'outputShadowBlurValue', suffix: 'px' },
    { id: 'outputShadowOffsetX', path: ['shadow', 'offsetXPx'], kind: 'number', min: -256, max: 256, outputId: 'outputShadowOffsetXValue', suffix: 'px' },
    { id: 'outputShadowOffsetY', path: ['shadow', 'offsetYPx'], kind: 'number', min: -256, max: 256, outputId: 'outputShadowOffsetYValue', suffix: 'px' },
    { id: 'outputShadowColor', path: ['shadow', 'color'], kind: 'color' },
    { id: 'outputShadowAlpha', path: ['shadow', 'alpha'], kind: 'alpha', outputId: 'outputShadowAlphaValue' }
  ])

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value))
  }

  // A style timeline that mirrors the annotation snapshot stack index-for-index.
  //
  // capture.js has ONE undo stack; the output style has to live on that same timeline or "undo the
  // card back to the original" would need a second, competing Ctrl+Z. So the panel keeps a parallel
  // list of styles and capture.js applies the SAME structural edits to both lists:
  //
  //   annotationHistory.length = historyIndex + 1   ->  frames.truncate(sameLength)
  //   annotationHistory.push(snapshot)              ->  frames.push(currentStyle())
  //   annotationHistory.splice(0, drop)             ->  frames.trimFromFront(drop)
  //
  // Mirroring the operations (rather than being told an index) is what keeps the two lists aligned
  // even when the annotation stack overflows MAX_ANNOTATION_HISTORY and shifts every index by one.
  function createStyleFrames(styleApi, initialStyle) {
    const normalize = (value) => styleApi.normalizeOutputStyle(value)
    let frames = [normalize(initialStyle)]
    return {
      reset(style) {
        frames = [normalize(style)]
        return frames.length - 1
      },
      // Drops the redo branch, exactly like `annotationHistory.length = historyIndex + 1`.
      truncate(length) {
        const target = Math.max(1, Math.floor(Number(length) || 1))
        if (frames.length > target) frames.length = target
        return frames.length
      },
      // Appends the style that is current at the frame just pushed.
      push(style) {
        frames.push(normalize(style))
        return frames.length - 1
      },
      // Drops the oldest frames, exactly like the annotation stack's own cap.
      trimFromFront(count) {
        const drop = Math.max(0, Math.floor(Number(count) || 0))
        if (drop > 0) frames.splice(0, drop)
        if (!frames.length) frames = [normalize(initialStyle)]
        return frames.length
      },
      at(index) {
        const position = clamp(Math.floor(Number(index) || 0), 0, frames.length - 1)
        return normalize(frames[position])
      },
      get length() {
        return frames.length
      }
    }
  }

  function readControl(element, control) {
    if (!element) return undefined
    if (control.kind === 'boolean') return element.checked === true
    if (control.kind === 'color') return typeof element.value === 'string' ? element.value : undefined
    const raw = Number(element.value)
    if (!Number.isFinite(raw)) return undefined
    if (control.kind === 'alpha') return clamp(raw / 100, 0, 1)
    return clamp(Math.round(raw), control.min ?? 0, control.max ?? Infinity)
  }

  function writeControl(element, control, style) {
    if (!element) return
    const value = control.path.reduce((target, key) => (isPlainObject(target) ? target[key] : undefined), style)
    if (control.kind === 'boolean') {
      element.checked = value === true
      return
    }
    if (control.kind === 'color') {
      element.value = typeof value === 'string' ? value : '#000000'
      return
    }
    if (control.kind === 'alpha') {
      const percent = Math.round(clamp(Number(value) || 0, 0, 1) * 100)
      element.value = String(percent)
      return
    }
    element.value = String(Number.isFinite(Number(value)) ? Number(value) : 0)
  }

  function describeValue(control, style) {
    const value = control.path.reduce((target, key) => (isPlainObject(target) ? target[key] : undefined), style)
    if (control.kind === 'alpha') return `${Math.round(clamp(Number(value) || 0, 0, 1) * 100)}%`
    return `${Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0}${control.suffix || ''}`
  }

  // Deep patch merge for the two nested blocks (background/border/shadow) plus the flat fields.
  // Returns a NEW object: the controller never mutates the style a frame holds, because a frame is
  // what Ctrl+Z restores.
  function mergeStyle(style, patch) {
    const next = Object.assign({}, style)
    for (const [key, value] of Object.entries(patch || {})) {
      next[key] = isPlainObject(value) ? Object.assign({}, style[key], value) : value
    }
    return next
  }

  /**
   * Build the panel state machine.
   *
   * @param {object} options
   * @param {object} options.styleApi        shared/capture-output-style.js
   * @param {object} [options.initialStyle]  starting style (document restore / preset preference)
   * @param {function} [options.onPreview]   called with the new style on every live change
   * @param {function} [options.onCommit]    called once per completed gesture, with
   *                                         `{ style, previous, presetId }`; the caller pushes ONE
   *                                         undo frame here
   * @param {function} [options.onPreset]    called with the preset id when a preset is chosen
   * @param {function} [options.onStatus]    called with `{ key, params }` or null for the status line
   */
  function createOutputStyleController(options = {}) {
    const styleApi = resolveStyleApi(options.styleApi)
    if (!styleApi) throw new Error('output style controller requires shared/capture-output-style.js')
    const onPreview = typeof options.onPreview === 'function' ? options.onPreview : () => {}
    const onCommit = typeof options.onCommit === 'function' ? options.onCommit : () => {}
    const onPreset = typeof options.onPreset === 'function' ? options.onPreset : () => {}
    const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {}
    const frames = createStyleFrames(styleApi, options.initialStyle)
    let style = styleApi.normalizeOutputStyle(options.initialStyle)
    // The chosen preset id is UI state only (§6.2): it is never written into the document, so it
    // lives beside the style rather than inside it. A manual parameter change leaves the last
    // preset id alone (it is still "the preset the user started from"), which is what keeps the
    // buttons honest while a value differs from that preset.
    let presetId = typeof options.initialPresetId === 'string' ? options.initialPresetId : 'original'
    // One gesture may deliver many `input` events; `dirty` marks "the live style is ahead of the
    // last frame" so the commit is emitted exactly once and a no-op commit is never pushed.
    let dirty = false

    function emitPreview(next) {
      onPreview(next)
    }

    function commit(meta) {
      if (!dirty) return false
      dirty = false
      onCommit({ style, previous: meta?.previous || null, presetId })
      return true
    }

    // A single patch, either live (preview only) or committed (one frame).
    function applyPatch(patch, settings) {
      const previous = style
      const merged = mergeStyle(style, patch)
      const next = styleApi.normalizeOutputStyle(merged)
      if (styleApi.outputStyleEquals(next, style)) {
        // Nothing moved (a slider landed on the same integer, a colour popup was dismissed):
        // do not schedule an undo frame for a no-op.
        return false
      }
      style = next
      dirty = true
      emitPreview(style)
      if (settings?.commit === true) commit({ previous })
      return true
    }

    function setStyle(value, settings) {
      const previous = style
      const next = styleApi.normalizeOutputStyle(value)
      if (styleApi.outputStyleEquals(next, style)) return false
      style = next
      dirty = true
      emitPreview(style)
      if (settings?.commit === true) commit({ previous })
      return true
    }

    // Choosing a preset replaces the whole parameter block (that is what a preset IS) and is one
    // discrete undo frame. Choosing "original" goes through the same path, which is what makes
    // "restore original can be undone" true (§6.3) - it is a regular edit, not a reset.
    function selectPreset(id) {
      const preset = styleApi.OUTPUT_STYLE_PRESETS[String(id || '')]
      const resolvedId = preset ? preset.id : 'original'
      const previous = style
      const next = styleApi.presetStyle(resolvedId)
      presetId = resolvedId
      if (styleApi.outputStyleEquals(next, style)) {
        // Same geometry/parameters: no new revision, but the chosen preset id still updates (it is
        // UI preference, and it is what the next capture starts from).
        onPreset(resolvedId)
        return false
      }
      style = next
      dirty = true
      emitPreview(style)
      commit({ previous })
      onPreset(resolvedId)
      return true
    }

    return {
      getStyle() {
        return styleApi.normalizeOutputStyle(style)
      },
      getPresetId() {
        return presetId
      },
      isEnabled() {
        return styleApi.isOutputStyleEnabled(style)
      },
      applyPatch,
      setStyle,
      selectPreset,
      // Gesture boundary. `begin` is called on pointerdown; `end` on pointerup/change. Both are
      // safe to call in any order and more than once - only `end` after a real change commits.
      beginGesture() {
        dirty = false
      },
      endGesture() {
        return commit()
      },
      // Frame plumbing for capture.js's single undo stack (see createStyleFrames).
      frames,
      pushFrame() {
        return frames.push(style)
      },
      truncateFrames(length) {
        return frames.truncate(length)
      },
      trimFramesFromFront(count) {
        return frames.trimFromFront(count)
      },
      resetFrames(value) {
        const next = styleApi.normalizeOutputStyle(value === undefined ? style : value)
        style = next
        dirty = false
        return frames.reset(next)
      },
      frameAt(index) {
        return frames.at(index)
      },
      // Applies a frame restored by undo/redo WITHOUT emitting a commit (that would push a second
      // frame for the same user action). Preview still runs so the stage repaints.
      restoreFrame(value) {
        const next = styleApi.normalizeOutputStyle(value)
        if (styleApi.outputStyleEquals(next, style)) return false
        style = next
        dirty = false
        emitPreview(style)
        return true
      },
      onStatus
    }
  }

  /**
   * Mount the DOM half: find the panel's elements, wire one delegated listener per control kind,
   * sync the widgets from the current style and keep the panel anchored to the strip.
   *
   * Everything it needs is passed in, so a node test can run it against a tiny fake document -
   * the interesting behaviour (one undo frame per gesture, preset switching, no-op suppression) is
   * in the controller above and is exercised without a real DOM.
   */
  function mountOutputStylePanel(options = {}) {
    const styleApi = resolveStyleApi(options.styleApi)
    const doc = options.document || null
    if (!styleApi || !doc || typeof doc.getElementById !== 'function') return null
    const controller = options.controller || createOutputStyleController(Object.assign({ styleApi }, options))
    const translate = typeof options.translate === 'function' ? options.translate : (key) => key
    const log = typeof options.log === 'function' ? options.log : () => {}
    const panel = doc.getElementById('outputStylePanel')
    const toggle = doc.getElementById('outputStyleToggle')
    const status = doc.getElementById('outputStyleStatus')
    if (!panel) return null

    const elements = new Map()
    for (const control of CONTROLS) {
      elements.set(control.id, {
        input: doc.getElementById(control.id),
        output: control.outputId ? doc.getElementById(control.outputId) : null,
        control
      })
    }
    const presetButtons = typeof panel.querySelectorAll === 'function'
      ? Array.from(panel.querySelectorAll('[data-output-preset]'))
      : []

    function setStatus(key, params, isError) {
      if (!status) return
      status.textContent = key ? translate(key, params) : ''
      status.classList.toggle('hidden', !key)
      status.classList.toggle('error', isError === true)
    }

    // Repaints every widget from the current style. Called after a preset click and after an
    // undo/redo restore (the frame swapped the whole style underneath the controls).
    function syncControls() {
      const style = controller.getStyle()
      for (const { input, output, control } of elements.values()) {
        writeControl(input, control, style)
        if (output) output.textContent = describeValue(control, style)
      }
      // A preset button is latched only while the current parameters still EQUAL that preset. Tuning
      // one slider therefore un-latches every preset, which is the honest state: the product is no
      // longer "the light card", it is "a card based on it". The same comparison decides which
      // preset is labelled active when a record is reopened, so the two paths cannot disagree.
      for (const button of presetButtons) {
        const presetStyle = styleApi.presetStyle(button.dataset.outputPreset)
        const active = styleApi.outputStyleEquals(presetStyle, style)
        button.classList.toggle('active', active)
        button.setAttribute('aria-pressed', String(active))
      }
      syncSizeHint()
    }

    // The panel shows the finished size, which is the one number that tells the user what they
    // are about to write. It comes from the shared geometry function, never from local math.
    function syncSizeHint() {
      const hint = doc.getElementById('outputStyleSize')
      if (!hint || typeof options.getGeometry !== 'function') return
      const geometry = options.getGeometry(controller.getStyle())
      if (!geometry) {
        hint.textContent = ''
        hint.classList.add('hidden')
        return
      }
      hint.textContent = translate('capture.output.size', { width: geometry.width, height: geometry.height })
      hint.classList.remove('hidden')
    }

    function patch(path, value) {
      const target = path.length === 1 ? { [path[0]]: value } : { [path[0]]: { [path[1]]: value } }
      // Parameters only exist for an enabled style; editing one while "original" is selected would
      // be a silent no-op, so the first real edit turns the effect on. The two go into ONE patch so
      // the live preview and the single undo frame both see the final geometry.
      if (!controller.isEnabled()) target.enabled = true
      controller.applyPatch(target)
      syncControls()
    }

    for (const { input, output, control } of elements.values()) {
      if (!input) continue
      if (input.addEventListener) {
        // Live preview while the value changes; the undo frame waits for the gesture to end.
        // Nothing here commits: a range/colour input fires many `input` events per drag, and
        // §6.3 requires exactly one undo step for the gesture.
        input.addEventListener('input', () => {
          const value = readControl(input, control)
          if (value === undefined) return
          patch(control.path, value)
          if (output) output.textContent = describeValue(control, controller.getStyle())
        })
        // `change` is the gesture end for a range/colour input; pointerup covers the rest.
        input.addEventListener('change', () => {
          controller.endGesture()
          syncControls()
        })
        input.addEventListener('pointerup', () => controller.endGesture())
        input.addEventListener('keyup', () => controller.endGesture())
      }
    }

    if (typeof panel.addEventListener === 'function') {
      panel.addEventListener('click', (event) => {
        const button = event.target?.closest?.('[data-output-preset]')
        if (!button) return
        event.stopPropagation?.()
        controller.selectPreset(button.dataset.outputPreset)
        syncControls()
        setStatus('', null, false)
      })
    }

    // Clicking elsewhere dismisses the panel, like the colour palette and the region panel.
    if (doc.addEventListener) {
      doc.addEventListener('click', (event) => {
        if (!isOpen()) return
        if (panel.contains?.(event.target) || toggle?.contains?.(event.target)) return
        close()
      })
    }

    function isOpen() {
      return !panel.classList.contains('hidden')
    }

    function open() {
      panel.classList.remove('hidden')
      if (toggle) toggle.setAttribute('aria-expanded', 'true')
      syncControls()
      position()
      // The preview canvas is only ever painted by the shared compositor, and nothing repaints it
      // merely because the panel became visible - so opening it asks the caller for one paint.
      if (typeof options.onOpen === 'function') options.onOpen()
    }

    function close() {
      panel.classList.add('hidden')
      if (toggle) toggle.setAttribute('aria-expanded', 'false')
      setStatus('', null, false)
    }

    function togglePanel() {
      if (isOpen()) close()
      else open()
      return isOpen()
    }

    // Anchored above the strip when it fits, otherwise below it - the same preference order the
    // floating placement rule uses for every other surface.
    function position() {
      if (!isOpen() || typeof options.getAnchor !== 'function') return
      const anchor = options.getAnchor()
      if (!anchor) return
      const rect = typeof panel.getBoundingClientRect === 'function'
        ? panel.getBoundingClientRect()
        : { width: 300, height: 320 }
      const gap = 8
      let left = anchor.left + anchor.width - rect.width
      let top = anchor.top - rect.height - gap
      if (top < gap) top = anchor.top + rect.height + gap
      left = Math.max(gap, Math.min(left, Math.max(gap, anchor.viewportWidth - rect.width - gap)))
      top = Math.max(gap, Math.min(top, Math.max(gap, anchor.viewportHeight - rect.height - gap)))
      panel.style.left = `${Math.round(left)}px`
      panel.style.top = `${Math.round(top)}px`
    }

    if (toggle && toggle.addEventListener) {
      toggle.addEventListener('click', (event) => {
        event.stopPropagation?.()
        togglePanel()
      })
    }

    syncControls()
    return {
      controller,
      open,
      close,
      toggle: togglePanel,
      isOpen,
      position,
      syncControls,
      setStatus,
      getStyle: () => controller.getStyle(),
      getPresetId: () => controller.getPresetId(),
      // Test surface: the control table is what a static markup test cross-checks.
      controls: CONTROLS,
      log
    }
  }

  // Every locale key this module resolves at runtime. capture-i18n.test.js feeds this list into
  // its "no dead key / no missing golden entry" check, so the panel cannot ship copy that the
  // locale table does not carry (and a removed key cannot linger in the table unnoticed).
  const LOCALE_KEYS = Object.freeze([
    'capture.output.title',
    'capture.output.presets',
    'capture.output.preset-original',
    'capture.output.preset-card-light',
    'capture.output.preset-card-dark',
    'capture.output.padding',
    'capture.output.background',
    'capture.output.background-alpha',
    'capture.output.corner-radius',
    'capture.output.border-width',
    'capture.output.border-color',
    'capture.output.shadow',
    'capture.output.shadow-enabled',
    'capture.output.shadow-blur',
    'capture.output.shadow-offset-x',
    'capture.output.shadow-offset-y',
    'capture.output.shadow-color',
    'capture.output.shadow-alpha',
    'capture.output.size',
    'capture.output.too-large'
  ])

  return {
    CONTROLS,
    LOCALE_KEYS,
    createStyleFrames,
    createOutputStyleController,
    mountOutputStylePanel,
    mergeStyle,
    readControl,
    writeControl,
    describeValue
  }
})
