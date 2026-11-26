'use strict'

// U01 (docs/reviews/2026-11-26-code-review-and-optimization-report.md §4.1): the canvas-inline
// text editor that replaces the blocking `window.prompt()` for text annotations.
//
// The capture window is a full-screen overlay with no framework and no bundler, so this is a
// classic-script UMD module (same shape as capture/export-result-bar.js): the window loads it
// with `<script src>` and reads `window.annotationInlineEditor`, while a node test `require()`s
// the very same file. It owns ONLY the floating `<textarea>` - its styling, positioning and the
// key contract - and never touches annotations, the canvas or the undo stack (capture.js does).
//
// Contract:
//   * Enter commits, Ctrl/Cmd/Alt+Enter inserts a line break (multi-line text), Escape cancels.
//   * An IME composition owns Enter/Escape until it finishes, so typing Chinese cannot submit
//     the annotation while the candidate list is still open.
//   * Losing focus commits (a click on the toolbar applies to the text being edited); only an
//     explicit Escape discards it.
//   * The textarea IS the live preview: it sits at the annotation's canvas coordinates with the
//     annotation's own font size/weight/colour and the shared line height, so what the user sees
//     while typing is what the export paints. (A transparent-textarea-over-canvas-preview
//     arrangement cannot show an IME candidate list, which would break Chinese input.)
//
// No new stylesheet entry: capture.css is not part of this ticket's write scope, so the few
// properties the editor needs are set inline (the page's CSP allows inline styles).

;(function exposeAnnotationInlineEditor(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.annotationInlineEditor = api
})(typeof globalThis === 'object' ? globalThis : window, () => {
  const EDITOR_CLASS = 'annotation-text-editor'
  const DEFAULT_FONT_SIZE = 20
  // 1.2em single spacing; capture/annotation-geometry.js owns the same ratio for the painted
  // box, so the editor and the canvas cannot disagree about how tall a multi-line text is.
  const DEFAULT_LINE_HEIGHT_RATIO = 1.2
  // An empty annotation still needs a usable editing surface; a longer line grows it.
  const MINIMUM_WIDTH = 160
  const FONT_FAMILY = '-apple-system,"Microsoft YaHei",sans-serif'
  const KEY_INTENTS = Object.freeze({ COMMIT: 'commit', NEWLINE: 'newline', CANCEL: 'cancel' })

  // While a composition is running Enter confirms the candidate list, not the annotation.
  // Chromium reports keyCode 229 on some IMEs where `isComposing` is still false.
  function isComposingEvent(event) {
    return !!event && (event.isComposing === true || event.keyCode === 229)
  }

  // The whole key contract as one pure function, so a node test can pin it without a DOM:
  //   Escape                -> 'cancel'
  //   Ctrl/Cmd/Alt + Enter  -> 'newline' (multi-line input; never submits)
  //   plain Enter           -> 'commit'
  //   anything else         -> '' (the textarea keeps it: typing, undo, caret movement)
  function textEditorKeyIntent(event) {
    if (!event || isComposingEvent(event)) return ''
    if (event.key === 'Escape') return KEY_INTENTS.CANCEL
    if (event.key !== 'Enter') return ''
    if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) return KEY_INTENTS.NEWLINE
    return KEY_INTENTS.COMMIT
  }

  // Insert one line break at the current selection and return the new value. `setRangeText`
  // keeps the browser's own undo stack and the caret correct; the splice is the fallback for a
  // minimal DOM (and for tests).
  function insertNewline(textarea) {
    if (!textarea) return ''
    const value = String(textarea.value ?? '')
    const start = Number(textarea.selectionStart)
    const end = Number(textarea.selectionEnd)
    const hasRange = Number.isFinite(start) && Number.isFinite(end)
    if (hasRange && typeof textarea.setRangeText === 'function') {
      textarea.setRangeText('\n', start, end, 'end')
      return String(textarea.value ?? '')
    }
    const caret = hasRange ? Math.max(0, Math.min(value.length, end)) : value.length
    textarea.value = `${value.slice(0, caret)}\n${value.slice(caret)}`
    if (typeof textarea.setSelectionRange === 'function') {
      try {
        textarea.setSelectionRange(caret + 1, caret + 1)
      } catch {}
    }
    return String(textarea.value ?? '')
  }

  function createInlineTextEditor(options = {}) {
    const documentRef = options.document || null
    const translate = typeof options.translate === 'function' ? options.translate : (key) => key
    const log = typeof options.log === 'function' ? options.log : () => {}
    const getViewport = typeof options.getViewport === 'function'
      ? options.getViewport
      : () => ({
          width: typeof innerWidth === 'number' ? innerWidth : 0,
          height: typeof innerHeight === 'number' ? innerHeight : 0
        })

    let textarea = null
    let opened = null
    let closing = false

    function viewportSize() {
      const viewport = getViewport() || {}
      return {
        width: Math.max(0, Number(viewport.width) || 0),
        height: Math.max(0, Number(viewport.height) || 0)
      }
    }

    // Approximate fallback when the caller did not pass a real measurer: only used to size the
    // editing surface, never to position the painted annotation.
    function fallbackTextWidth(value, fontSize) {
      let width = 0
      for (const character of String(value ?? '')) {
        const codePoint = character.codePointAt(0)
        const fullWidth = (codePoint >= 0x2E80 && codePoint <= 0x9FFF) ||
          (codePoint >= 0xAC00 && codePoint <= 0xD7A3) ||
          (codePoint >= 0xFF00 && codePoint <= 0xFF60)
        width += fullWidth ? fontSize : fontSize * 0.6
      }
      return width
    }

    function editorSize() {
      const value = textarea ? String(textarea.value ?? '') : ''
      const lines = value.split(/\r\n|\r|\n/)
      const fontSize = opened?.fontSize || DEFAULT_FONT_SIZE
      const lineHeight = opened?.lineHeight || fontSize * DEFAULT_LINE_HEIGHT_RATIO
      let textWidth = 0
      if (opened?.measureWidth) {
        const measured = Number(opened.measureWidth(value))
        if (Number.isFinite(measured) && measured > 0) textWidth = measured
      }
      if (!textWidth) textWidth = fallbackTextWidth(value, fontSize)
      let width = Math.max(opened?.minimumWidth || MINIMUM_WIDTH, Math.ceil(textWidth) + Math.ceil(fontSize * 0.6))
      if (opened?.maxWidth > 0) width = Math.min(width, opened.maxWidth)
      return { width, height: lineHeight * Math.max(1, lines.length) }
    }

    function applyLayout() {
      if (!textarea || !opened) return
      const size = editorSize()
      const viewport = viewportSize()
      let top = opened.top
      if (viewport.height > 0 && top + size.height > viewport.height) {
        top = Math.max(0, viewport.height - size.height)
      }
      textarea.style.left = `${Math.round(opened.left)}px`
      textarea.style.top = `${Math.round(top)}px`
      textarea.style.width = `${Math.round(size.width)}px`
      textarea.style.height = `${Math.round(size.height)}px`
    }

    function ensureMounted() {
      if (textarea) return textarea
      if (!documentRef || typeof documentRef.createElement !== 'function') return null
      textarea = documentRef.createElement('textarea')
      textarea.id = 'annotationTextEditor'
      textarea.className = EDITOR_CLASS
      textarea.setAttribute('wrap', 'off')
      textarea.setAttribute('spellcheck', 'false')
      textarea.setAttribute('autocomplete', 'off')
      textarea.setAttribute('autocapitalize', 'off')
      textarea.setAttribute('aria-label', translate('capture.input.text'))
      const style = textarea.style
      style.position = 'fixed'
      style.zIndex = '2147483000'
      style.margin = '0'
      style.padding = '0'
      // The outline is outside the content box, so the glyph origin matches the canvas text
      // origin (drawAnnotation paints at item.x/item.y with textBaseline 'top').
      style.border = '0'
      style.outline = '1px dashed rgba(255,255,255,.75)'
      style.background = 'rgba(0,0,0,.22)'
      style.borderRadius = '2px'
      style.color = '#ff3b30'
      style.fontFamily = FONT_FAMILY
      style.fontSize = `${DEFAULT_FONT_SIZE}px`
      style.lineHeight = `${DEFAULT_FONT_SIZE * DEFAULT_LINE_HEIGHT_RATIO}px`
      style.whiteSpace = 'pre'
      style.overflow = 'hidden'
      style.resize = 'none'
      style.boxSizing = 'border-box'
      style.display = 'none'
      textarea.addEventListener('input', handleInput)
      textarea.addEventListener('keydown', handleKeyDown)
      textarea.addEventListener('blur', handleBlur)
      // A press INSIDE the editor must never reach the capture canvas behind it.
      textarea.addEventListener('pointerdown', stopEvent)
      const host = documentRef.body || documentRef.documentElement
      if (!host || typeof host.appendChild !== 'function') {
        textarea = null
        return null
      }
      host.appendChild(textarea)
      return textarea
    }

    function stopEvent(event) {
      if (typeof event?.stopPropagation === 'function') event.stopPropagation()
    }

    function handleInput() {
      if (!opened || closing) return
      applyLayout()
      if (opened.onInput) opened.onInput(String(textarea.value ?? ''))
    }

    function handleBlur() {
      if (!opened || closing) return
      close(true)
    }

    function handleKeyDown(event) {
      if (!opened || closing) return
      const intent = textEditorKeyIntent(event)
      if (!intent) return
      // Enter/Escape belong to the editor, not to the capture window's shortcut ladder: the
      // window handler bails on `defaultPrevented`, and stopping propagation keeps the event
      // away from every other listener in the window.
      if (typeof event.preventDefault === 'function') event.preventDefault()
      if (typeof event.stopPropagation === 'function') event.stopPropagation()
      if (intent === KEY_INTENTS.CANCEL) {
        close(false)
        return
      }
      if (intent === KEY_INTENTS.NEWLINE) {
        const value = insertNewline(textarea)
        applyLayout()
        if (opened?.onInput) opened.onInput(value)
        return
      }
      close(true)
    }

    function close(commit) {
      if (!textarea || !opened) return false
      const state = opened
      const value = String(textarea.value ?? '')
      closing = true
      opened = null
      try {
        textarea.style.display = 'none'
        textarea.classList?.add('hidden')
        if (typeof textarea.blur === 'function') textarea.blur()
      } catch (error) {
        log('Inline text editor could not be hidden:', error?.message || error)
      }
      closing = false
      if (commit) {
        if (state.onCommit) state.onCommit(value)
      } else if (state.onCancel) {
        state.onCancel()
      }
      return true
    }

    function open(settings = {}) {
      if (closing) return false
      const element = ensureMounted()
      if (!element) return false
      const fontSize = Math.max(1, Number(settings.fontSize) || DEFAULT_FONT_SIZE)
      const lineHeight = Math.max(fontSize, Number(settings.lineHeight) || fontSize * DEFAULT_LINE_HEIGHT_RATIO)
      const viewport = viewportSize()
      const rect = settings.rect || {}
      const pointX = Number(rect.x)
      const pointY = Number(rect.y)
      const left = Number.isFinite(pointX) ? Math.max(0, pointX) : 0
      const top = Number.isFinite(pointY) ? Math.max(0, pointY) : 0
      opened = {
        fontSize,
        lineHeight,
        minimumWidth: Math.max(1, Number(settings.minimumWidth) || MINIMUM_WIDTH),
        // Keep the surface on screen: a text annotation can start in the last few pixels of a
        // display, and an editor that opens off-canvas would be unusable.
        maxWidth: viewport.width > 0 ? Math.max(1, viewport.width - left) : 0,
        left: viewport.width > 0 ? Math.min(left, Math.max(0, viewport.width - (Number(settings.minimumWidth) || MINIMUM_WIDTH))) : left,
        top: viewport.height > 0 ? Math.min(top, Math.max(0, viewport.height - lineHeight)) : top,
        measureWidth: typeof settings.measureWidth === 'function' ? settings.measureWidth : null,
        onInput: typeof settings.onInput === 'function' ? settings.onInput : null,
        onCommit: typeof settings.onCommit === 'function' ? settings.onCommit : null,
        onCancel: typeof settings.onCancel === 'function' ? settings.onCancel : null
      }
      element.value = String(settings.text ?? '')
      element.placeholder = String(settings.placeholder ?? '')
      element.style.color = String(settings.color || '#ff3b30')
      element.style.fontSize = `${fontSize}px`
      element.style.lineHeight = `${lineHeight}px`
      element.style.fontWeight = settings.bold === true ? 'bold' : 'normal'
      element.style.display = 'block'
      element.hidden = false
      element.classList?.remove('hidden')
      applyLayout()
      if (typeof element.focus === 'function') element.focus()
      const value = String(element.value ?? '')
      const caret = settings.selectAll === true
        ? { start: 0, end: value.length }
        : { start: value.length, end: value.length }
      if (typeof element.setSelectionRange === 'function') {
        try {
          element.setSelectionRange(caret.start, caret.end)
        } catch {}
      }
      // A re-edit opens with the whole wording selected (type-over replaces it); a new
      // annotation opens with the caret at the end of its empty value.
      if (opened.onInput) opened.onInput(value)
      return true
    }

    function isOpen() {
      return !!opened
    }

    function value() {
      return textarea ? String(textarea.value ?? '') : ''
    }

    function commit() {
      return close(true)
    }

    function cancel() {
      return close(false)
    }

    function dispose() {
      opened = null
      closing = true
      try {
        if (textarea?.parentNode) textarea.parentNode.removeChild(textarea)
      } catch {}
      textarea = null
      closing = false
    }

    return {
      open,
      close,
      commit,
      cancel,
      isOpen,
      value,
      dispose,
      getElement: () => textarea
    }
  }

  return {
    EDITOR_CLASS,
    DEFAULT_FONT_SIZE,
    DEFAULT_LINE_HEIGHT_RATIO,
    MINIMUM_WIDTH,
    KEY_INTENTS,
    isComposingEvent,
    textEditorKeyIntent,
    insertNewline,
    createInlineTextEditor
  }
})
