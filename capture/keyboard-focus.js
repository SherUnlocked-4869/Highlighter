(function initCaptureKeyboardFocus(globalScope) {
  // A02 (docs/reviews/2026-11-24-windows-product-architecture-review.md): the capture window
  // listens for keys at window level, so a focused control must win. This predicate is the
  // single rule both the keydown handler and the tests use:
  //
  //   * no focus / body / documentElement  -> the canvas owns the keyboard;
  //   * a real control (button, link, input, switch, menu item ...) -> the control does.
  //
  // Kept as a pure helper (not inline in capture.js) because the keyboard contract is
  // otherwise only testable by launching a real window.
  const CONTROL_SELECTOR = [
    'button',
    'a[href]',
    'summary',
    'input',
    'textarea',
    'select',
    '[role="button"]',
    '[role="switch"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[contenteditable="true"]'
  ].join(',')

  function focusedControlElement(root, selector = CONTROL_SELECTOR) {
    const focused = root?.activeElement
    if (!focused) return null
    if (focused === root.body || focused === root.documentElement) return null
    if (typeof focused.closest !== 'function') return null
    return focused.closest(selector)
  }

  function canvasOwnsKeyboard(root, selector) {
    return focusedControlElement(root, selector) === null
  }

  const api = { CONTROL_SELECTOR, canvasOwnsKeyboard, focusedControlElement }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (globalScope) globalScope.captureKeyboardFocus = api
})(typeof window !== 'undefined' ? window : null)
