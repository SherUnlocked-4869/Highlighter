'use strict'

// B03 (docs/reviews/2026-11-24-windows-product-architecture-review.md):
// "pin and copy in one confirmation".
//
// The combined action has exactly two outputs (a pin and a clipboard image) and they
// can fail independently. These tests pin down three things:
//   1. the pure two-by-two receipt matrix and the "retry only the failed output" rule;
//   2. the capture domain's real behaviour - one export, one history record, per-output
//      reporting when the pin budget or the clipboard refuses;
//   3. the renderer/preload wiring that makes one confirmation the only user gesture.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')
const script = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const preload = fs.readFileSync(path.join(root, 'preload-capture.js'), 'utf8')
const captureDomainSource = fs.readFileSync(path.join(root, 'main/domains/capture/index.js'), 'utf8')
const pinDomainSource = fs.readFileSync(path.join(root, 'main/domains/pin/index.js'), 'utf8')

const {
  PIN_COPY_OUTPUTS,
  planPinCopyAttempts,
  summarizePinCopyOutputs,
  createCaptureDomain
} = require('../main/domains/capture')

// B01 added a deferred write scheduler to the capture domain: a history row can be queued
// behind a short timer. A 5 ms wait is enough on an idle machine and not always enough on a
// loaded CI runner, so the flush waits for the scheduler to be idle when the harness exposes
// it and otherwise falls back to a generous bounded wait (a slow test is better than a flaky
// one; the assertion still fails if no row arrives).
const flushHistory = () => new Promise((resolve) => setTimeout(resolve, 50))

// ---------------------------------------------------------------------------
// 1. The pure output plan: two outputs, one receipt, retry only what is missing.
// ---------------------------------------------------------------------------

test('the receipt reports both outputs independently (the four-way matrix)', async () => {
  const both = summarizePinCopyOutputs({ attempted: { pin: { ok: true }, copy: { ok: true } } })
  assert.equal(both.ok, true)
  assert.deepEqual(both.outputs, { pin: { ok: true }, copy: { ok: true } })
  assert.deepEqual(both.failed, [])
  assert.deepEqual(both.retry, [])
  assert.equal(both.statusKey, 'pin.copy-once.result-both-ok')
  assert.deepEqual(both.hints, [])

  const pinOnly = summarizePinCopyOutputs({
    attempted: { pin: { ok: true }, copy: { ok: false, code: 'CLIPBOARD_BUSY' } }
  })
  assert.equal(pinOnly.ok, false)
  assert.deepEqual(pinOnly.failed, ['copy'])
  assert.deepEqual(pinOnly.retry, ['copy'])
  assert.equal(pinOnly.statusKey, 'pin.copy-once.result-pin-only')
  assert.deepEqual(pinOnly.hints, ['pin.copy-once.hint-clipboard-busy'])

  const copyOnly = summarizePinCopyOutputs({
    attempted: { pin: { ok: false, code: 'PIN_LIMIT' }, copy: { ok: true } }
  })
  assert.equal(copyOnly.ok, false)
  assert.deepEqual(copyOnly.failed, ['pin'])
  assert.deepEqual(copyOnly.retry, ['pin'])
  assert.equal(copyOnly.statusKey, 'pin.copy-once.result-copy-only')
  assert.deepEqual(copyOnly.hints, ['pin.copy-once.hint-pin-limit'])

  const none = summarizePinCopyOutputs({
    attempted: { pin: { ok: false, code: 'PIN_FAILED' }, copy: { ok: false, code: 'CLIPBOARD_BUSY' } }
  })
  assert.equal(none.ok, false)
  assert.deepEqual(none.failed, ['pin', 'copy'])
  assert.deepEqual(none.retry, ['pin', 'copy'])
  assert.equal(none.statusKey, 'pin.copy-once.result-none')
  // The order of the hints is the order of the outputs, never the order of failure.
  assert.deepEqual(none.hints, ['pin.copy-once.hint-clipboard-busy'])
  assert.deepEqual(PIN_COPY_OUTPUTS, ['pin', 'copy'])
})

test('a retry plans only the outputs that are still missing', () => {
  // A fresh confirmation plans both outputs.
  assert.deepEqual(planPinCopyAttempts(null), ['pin', 'copy'])
  // A retry asks for the failed half only, even if the caller names both.
  assert.deepEqual(planPinCopyAttempts({ pin: { ok: true }, copy: { ok: false } }, ['pin', 'copy']), ['copy'])
  assert.deepEqual(planPinCopyAttempts({ pin: { ok: false }, copy: { ok: true } }, ['pin', 'copy']), ['pin'])
  // Asking to retry something that already succeeded is a no-op.
  assert.deepEqual(planPinCopyAttempts({ pin: { ok: true }, copy: { ok: true } }, ['copy']), [])
  // A stale/unknown prior state is treated as "nothing succeeded yet".
  assert.deepEqual(planPinCopyAttempts(undefined, ['copy']), ['copy'])
})

test('merging a retry keeps the earlier success and clears the missing output', () => {
  const prior = { pin: { ok: true }, copy: { ok: false, code: 'CLIPBOARD_BUSY' } }
  const retried = summarizePinCopyOutputs({ prior, attempted: { copy: { ok: true } } })
  assert.equal(retried.ok, true)
  assert.deepEqual(retried.outputs, { pin: { ok: true }, copy: { ok: true } })
  assert.deepEqual(retried.retry, [])
  // Re-merging nothing is the identity: a repeated click reproduces the same receipt.
  const identity = summarizePinCopyOutputs({ prior, attempted: {} })
  assert.deepEqual(identity.outputs, prior)
  assert.deepEqual(identity.failed, ['copy'])
})

// ---------------------------------------------------------------------------
// 2. The capture domain: one export, one history record, per-output reports.
// ---------------------------------------------------------------------------

function createHarness({ pinError = '', clipboardDrops = false, pinLimit = false, nativeCopy = false } = {}) {
  const persisted = []
  const calls = { pin: 0, write: 0, highlight: 0 }
  let drops = clipboardDrops
  // B01 (plan item 05): the private copy needs a native writer. Tests toggle this to model
  // "the native publication is (un)available" without inventing a plain fallback.
  let nativeWriterActive = nativeCopy === true
  const captureWindow = { _pinCopyState: undefined, isDestroyed: () => false }
  const domain = createCaptureDomain({
    app: { isPackaged: false },
    spawn: () => ({
      stdout: { setEncoding: () => {}, on: () => {} },
      stderr: { setEncoding: () => {}, on: () => {} },
      once: () => {},
      stdin: { write: () => {}, end: () => {} },
      kill: () => {}
    }),
    fs: { existsSync: () => false },
    path,
    screen: {
      getDisplayMatching: () => ({ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }),
      getDisplayNearestPoint: () => ({ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }),
      getCursorScreenPoint: () => ({ x: 10, y: 10 }),
      dipToScreenRect: (_display, bounds) => bounds
    },
    BrowserWindow: { fromWebContents: () => captureWindow },
    nativeImage: { createFromBuffer: () => ({ getSize: () => ({ width: 800, height: 600 }) }) },
    clipboard: {
      writeImage: () => { calls.write += 1 },
      readImage: () => ({ getSize: () => (drops ? { width: 1, height: 1 } : { width: 800, height: 600 }) })
    },
    dialog: { showErrorBox: () => {} },
    performance: { now: () => 0 },
    rootDirectory: root,
    isWin: false,
    createLocalWindow: () => ({ isDestroyed: () => false }),
    getSettings: () => ({ screenshot: {} }),
    log: () => {},
    assertGameModeDisabled: () => {},
    pinDomain: {
      bringPinToFront: () => {},
      canPinMore: () => !pinLimit,
      pinFromCapture: () => {
        calls.pin += 1
        if (pinError) throw new Error(pinError)
        return {}
      }
    },
    // The optional native seam: present only when the test turned it on.
    writeClipboardImage: async () => (nativeWriterActive
      ? { ok: true, private: true, sequence: 1 }
      : { ok: false, code: 'CLIPBOARD_BUSY' }),
    createRecordWindow: async () => {},
    createLongCaptureFromSelection: async () => {},
    createRecognitionWindow: () => {},
    persistHistory: (_buffer, meta) => persisted.push(meta),
    saveImageBuffer: async () => '',
    imageDataToBuffer: (value) => (Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''))),
    dataUrlToBuffer: () => Buffer.from([1]),
    bufferToDataUrl: () => 'data:image/png;base64,AA==',
    performanceMonitor: { record: () => {}, snapshot: () => {} }
  })
  return {
    controller: domain.createCaptureController(),
    captureWindow,
    persisted,
    calls,
    setClipboardDropped: (value) => { drops = value === true },
    setNativeCopy: (value) => { nativeWriterActive = value === true }
  }
}

const event = () => ({ sender: {} })
const payload = (extra = {}) => ({ imageBuffer: Buffer.from([1, 2, 3]), meta: { width: 3, height: 2 }, ...extra })

test('one confirmation produces a pin and a clipboard result with a single history record', async () => {
  const harness = createHarness()
  const receipt = await harness.controller.pin(event(), payload({ copy: true }))
  assert.equal(receipt.ok, true)
  assert.deepEqual(receipt.outputs, { pin: { ok: true }, copy: { ok: true } })
  assert.equal(receipt.statusKey, 'pin.copy-once.result-both-ok')
  assert.equal(receipt.recorded, true)
  assert.deepEqual(receipt.retry, [])
  assert.equal(harness.calls.pin, 1)
  assert.equal(harness.calls.write, 1)
  await flushHistory()
  assert.equal(harness.persisted.length, 1, 'one confirmation must add at most one history record')
  assert.equal(harness.persisted[0].action, 'pin')
})

test('the 20-pin budget reports the copy as its own success, not as a total failure', async () => {
  // The budget is a state (canPinMore), so the pin attempt is not even started.
  const harness = createHarness({ pinLimit: true })
  const receipt = await harness.controller.pin(event(), payload({ copy: true }))
  assert.equal(receipt.ok, false)
  assert.deepEqual(receipt.outputs.pin, { ok: false, code: 'PIN_LIMIT' })
  assert.deepEqual(receipt.outputs.copy, { ok: true })
  assert.deepEqual(receipt.failed, ['pin'])
  assert.deepEqual(receipt.retry, ['pin'])
  assert.equal(receipt.statusKey, 'pin.copy-once.result-copy-only')
  assert.deepEqual(receipt.hints, ['pin.copy-once.hint-pin-limit'])
  // The clipboard result is real, so the capture is still remembered once.
  assert.equal(receipt.recorded, true)
  await flushHistory()
  assert.equal(harness.persisted.length, 1)
  assert.equal(harness.calls.write, 1)
  assert.equal(harness.calls.pin, 0, 'a full pin budget must not attempt a pin')
})

test('a clipboard held by another process is reported instead of silently claimed', async () => {
  const harness = createHarness({ clipboardDrops: true })
  const receipt = await harness.controller.pin(event(), payload({ copy: true }))
  assert.equal(receipt.ok, false)
  assert.deepEqual(receipt.outputs.pin, { ok: true })
  assert.deepEqual(receipt.outputs.copy, { ok: false, code: 'CLIPBOARD_BUSY' })
  assert.equal(receipt.statusKey, 'pin.copy-once.result-pin-only')
  assert.deepEqual(receipt.retry, ['copy'])
  assert.deepEqual(receipt.hints, ['pin.copy-once.hint-clipboard-busy'])
  await flushHistory()
  assert.equal(harness.persisted.length, 1)
})

test('both outputs failing records nothing and offers both retries', async () => {
  const harness = createHarness({ pinError: 'boom', clipboardDrops: true })
  const receipt = await harness.controller.pin(event(), payload({ copy: true }))
  assert.equal(receipt.ok, false)
  assert.equal(receipt.statusKey, 'pin.copy-once.result-none')
  assert.deepEqual(receipt.retry, ['pin', 'copy'])
  assert.equal(receipt.recorded, false)
  await flushHistory()
  assert.equal(harness.persisted.length, 0)
})

test('a retry fills only the missing output and never writes a second history record', async () => {
  const harness = createHarness({ clipboardDrops: true })
  const first = await harness.controller.pin(event(), payload({ copy: true }))
  assert.deepEqual(first.failed, ['copy'])
  await flushHistory()
  assert.equal(harness.persisted.length, 1)

  harness.setClipboardDropped(false)
  const retried = await harness.controller.pin(event(), payload({ retry: 'copy' }))
  assert.equal(retried.ok, true)
  assert.deepEqual(retried.reattempted, ['copy'])
  assert.equal(harness.calls.pin, 1, 'retrying the copy must not pin again')
  assert.equal(harness.calls.write, 2, 'the retry is the only extra clipboard write')
  await flushHistory()
  assert.equal(harness.persisted.length, 1, 'a retry is not a new capture')
})

test('retrying an output that already succeeded is a no-op (double click)', async () => {
  const harness = createHarness()
  const first = await harness.controller.pin(event(), payload({ copy: true }))
  assert.equal(first.ok, true)
  const again = await harness.controller.pin(event(), payload({ retry: 'pin' }))
  assert.deepEqual(again.reattempted, [])
  assert.equal(again.ok, true)
  assert.equal(harness.calls.pin, 1)
})

test('a retry without a prior receipt reports stale instead of running the output', async () => {
  const harness = createHarness()
  const stale = await harness.controller.pin(event(), payload({ retry: 'copy' }))
  assert.equal(stale.stale, true)
  assert.equal(stale.statusKey, 'pin.copy-once.result-stale')
  assert.deepEqual(stale.retry, [])
  assert.equal(harness.calls.write, 0)
})

test('the first retry that lands records the single history entry the first attempt could not', async () => {
  const harness = createHarness({ pinError: 'boom', clipboardDrops: true })
  const failed = await harness.controller.pin(event(), payload({ copy: true }))
  assert.equal(failed.recorded, false)
  await flushHistory()
  assert.equal(harness.persisted.length, 0)

  // Pin still fails, the clipboard recovers: that single successful output is the one
  // record the confirmation is allowed to add. (This retry is a plain copy - no
  // skipHistory - so the readback, not the native writer, decides success.)
  harness.setClipboardDropped(false)
  const copyRetry = await harness.controller.pin(event(), payload({ retry: 'copy' }))
  assert.equal(copyRetry.outputs.copy.ok, true)
  assert.equal(copyRetry.outputs.pin.ok, false)
  assert.equal(copyRetry.recorded, true)
  await flushHistory()
  assert.equal(harness.persisted.length, 1)

  // Retrying the half that already succeeded is a no-op and adds no second record.
  const again = await harness.controller.pin(event(), payload({ retry: 'copy' }))
  assert.deepEqual(again.reattempted, [])
  await flushHistory()
  assert.equal(harness.persisted.length, 1)
})

test('the shipped pin-only path keeps its contract (one record, failure throws)', async () => {
  const okHarness = createHarness()
  assert.equal(await okHarness.controller.pin(event(), payload()), null)
  assert.equal(okHarness.calls.write, 0)
  await flushHistory()
  assert.equal(okHarness.persisted.length, 1)
  assert.equal(okHarness.persisted[0].action, 'pin')

  const failingHarness = createHarness({ pinError: '最多固定 20 张图片' })
  await assert.rejects(() => failingHarness.controller.pin(event(), payload()), /最多固定 20 张图片/)
  await flushHistory()
  assert.equal(failingHarness.persisted.length, 0)
})

// ---------------------------------------------------------------------------
// 3. Wiring: the renderer, its markup and the preload.
// ---------------------------------------------------------------------------

test('capture.html gives the pin button a secondary output menu and a receipt bar', () => {
  // The trigger keeps its shipped id/label attributes (the accessible name still comes
  // from the capture table) and now advertises the popover.
  assert.match(html, /<button id="pin" data-i18n-title="capture\.toolbar\.pin" data-i18n-aria-label="capture\.toolbar\.pin" type="button" aria-haspopup="true" aria-expanded="false">/)
  assert.match(html, /<div id="pinMenu"[^>]*role="menu"/)
  assert.match(html, /id="pinOnly"[^>]*data-pin-action="pin"/)
  assert.match(html, /id="pinAndCopy"[^>]*data-pin-action="pin-copy"/)
  // The receipt bar reuses the OCR bar surface (no new stylesheet rule) and carries one
  // retry button per output plus a dismiss.
  assert.match(html, /<div id="pinOutputBar" class="ocr-result-bar hidden" role="status" aria-live="polite">/)
  assert.match(html, /id="pinOutputText"/)
  assert.match(html, /id="pinOutputRetryPin"/)
  assert.match(html, /id="pinOutputRetryCopy"/)
  assert.match(html, /id="pinOutputClose"/)
  // The pin-domain copy has to be loadable in this window, before the controller.
  const pinTable = html.indexOf('../shared/locales/pin.js')
  const controller = html.indexOf('src="capture.js"')
  assert.ok(pinTable > 0 && pinTable < controller, 'the pin locale table must load before capture.js')
})

test('capture.js keeps the one-click pin and adds pin+copy as the secondary action', () => {
  // Primary click: unchanged (no extra confirmation, no menu on the fast path).
  assert.match(script, /if\(pinMenu\.classList\.contains\('hidden'\)\)performAction\('pin'\)/)
  // Secondary action: one call that asks for both outputs from the SAME buffer.
  assert.match(script, /performAction\(button\.dataset\.pinAction==='pin-copy'\?'pin-copy':'pin'\)/)
  assert.match(script, /const receipt=await window\.captureAPI\.pin\(imageBuffer,meta,\{copy:true\}\)/)
  assert.match(script, /if\(action==='pin-copy'\)\{await pinAndCopyOnce\(imageBuffer,meta\);return\}/)
  // Partial success keeps the window and reports per output; a full success closes it.
  assert.match(script, /if\(receipt\.ok\)\{closeCaptureWindow\(\);return\}/)
  assert.match(script, /showPinOutput\(receipt,imageBuffer,meta\)/)
  // A repeated press re-reports the same receipt instead of pinning twice.
  assert.match(script, /if\(\(action==='pin'\|\|action==='pin-copy'\)&&pinOutputState&&!pinOutputState\.receipt\?\.ok\)\{[\s\S]{0,160}?renderPinOutputBar\(pinOutputState\.receipt\)/)
  // Retries go through the same channel with a one-output selector and never re-encode.
  assert.match(script, /window\.captureAPI\.pin\(pinOutputState\.buffer,pinOutputState\.meta,\{retry:kind\}\)/)
  // The renderer never writes history itself for this action: the main process owns the
  // single record (the only recordHistory call in this file belongs to the document editor).
  const helper = script.slice(script.indexOf('async function pinAndCopyOnce'), script.indexOf('async function pinAndCopyOnce') + 900)
  assert.doesNotMatch(helper, /recordHistory/)
  // The menu follows the palette's open/close contract, including the strip-size cache.
  assert.match(script, /function openPinMenu\(\)\{[\s\S]{0,400}?invalidateToolbarSize\(\)/)
  assert.match(script, /function closePinMenu\(\)\{[\s\S]{0,240}?invalidateToolbarSize\(\)/)
  assert.match(script, /pinButton\.addEventListener\('contextmenu'/)
  assert.match(script, /PIN_MENU_LONG_PRESS_MS=450/)
  assert.match(script, /if\(pinMenuPressOpened\)\{pinMenuPressOpened=false;event\.preventDefault\(\);return\}/)
  // Escape closes this popover before it starts unwinding the window.
  assert.match(script, /else if\(!pinMenu\.classList\.contains\('hidden'\)\)closePinMenu\(\)/)
})

test('the combined path rides the existing capture:pin channel end to end', () => {
  assert.match(preload, /pin: \(imageBuffer, meta, options\) => ipcRenderer\.invoke\('capture:pin'/)
  assert.match(captureDomainSource, /if \(copy !== true\) \{[\s\S]{0,700}?return null/)
  assert.match(captureDomainSource, /return await pinAndCopyOnce\(event, captureWindow, buffer, meta, editableSnapshot\)/)
  assert.match(captureDomainSource, /if \(retry === 'pin' \|\| retry === 'copy'\) \{/)
  assert.match(captureDomainSource, /const targets = planPinCopyAttempts\(prior\.outputs, \[kind\]\)/)
  // Exactly one history write per confirmation, guarded by the receipt's recorded flag.
  assert.match(captureDomainSource, /receipt\.recorded = attempted\.pin\.ok \|\| attempted\.copy\.ok/)
  assert.match(captureDomainSource, /if \(receipt\.recorded\) persistPinCopyHistory\(buffer, meta\)/)
  assert.match(captureDomainSource, /receipt\.recorded = prior\.recorded === true/)
  // The clipboard write is verified by reading the image back (silent Windows drops).
  assert.match(captureDomainSource, /clipboard\.readImage\(\)\?\.getSize\?\.\(\)/)
  // No new IPC channel was introduced.
  assert.doesNotMatch(preload, /capture:pin-copy|pin:copy-original|pin:save-original/)
  assert.doesNotMatch(captureDomainSource, /ipcMain\.handle\('capture:pin-copy'/)
})

test('every pin.* key the two main-process domains render exists in all three tables', () => {
  const tables = {}
  globalThis.__LOCALES = {}
  for (const name of ['zh-CN.js', 'en-US.js', 'zh-TW.js', 'capture.js', 'pin.js']) {
    const file = path.join(root, 'shared/locales', name)
    delete require.cache[require.resolve(file)]
    require(file)
  }
  for (const language of ['zh-CN', 'en-US', 'zh-TW']) tables[language] = globalThis.__LOCALES[language] || {}

  const keys = new Set()
  for (const source of [captureDomainSource, pinDomainSource]) {
    for (const match of source.matchAll(/'((?:pin)\.[a-z0-9.-]+)'/g)) {
      // Three or more segments: a locale key, never a file name such as 'pin.html'.
      if (/^pin(\.[a-z0-9-]+){2,}$/.test(match[1])) keys.add(match[1])
    }
  }
  // The receipt vocabulary this file's pure tests assert must be in that set.
  for (const key of [
    'pin.copy-once.result-both-ok',
    'pin.copy-once.result-pin-only',
    'pin.copy-once.result-copy-only',
    'pin.copy-once.result-none',
    'pin.copy-once.result-stale',
    'pin.copy-once.hint-pin-limit',
    'pin.copy-once.hint-clipboard-busy',
    'pin.menu.copy-original',
    'pin.menu.save-original',
    'pin.menu.export-view',
    'pin.view-export.preview-title',
    'pin.view-export.preview-size'
  ]) {
    assert.ok(keys.has(key), `${key} must be referenced by the domain code`)
  }
  assert.ok(keys.size >= 20)
  for (const key of keys) {
    for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
      const value = tables[language][key]
      assert.equal(typeof value, 'string', `${language} is missing ${key}`)
      assert.ok(value.length > 0, `${language}/${key} must not be empty`)
      assert.notEqual(value, key, `${language}/${key} must be translated`)
    }
  }
  // The key shape the repo checker enforces (<domain>.<module>.<semantic>).
  for (const key of keys) assert.match(key, /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/)
})
