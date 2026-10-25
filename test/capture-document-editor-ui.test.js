// 批次 1 渲染层契约用例：capture/ 里的「编辑一份文档」链路。
//
// 钉的是 docs/plans/2026-10-25-history-reedit-batch0-contracts.md 里渲染层必须遵守的部分：
//   §2.1 坐标：文档单位是底图源像素，视口 CSS 只是投影；导出只减一次 crop
//   §4   提交协议：sessionId + requestId + intent + 冻结快照/结果图；四种返回状态都处理
//   §7.2 dirty 来自内容指纹，不依赖撤销栈下标
//   §7.3 所有退出路径走同一个关闭协商
//   §6.1 A2 恢复 = 换会话 + 清撤销栈（打开后 Ctrl+Z 不跨到别的图）
//
// 这些是**源码结构 + 纯函数**断言，不是真机验证。真机项（窗口首帧、实际焦点归还、
// 可见信息区的排版）在本机无法验证，见最终报告的「未验证」部分。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const script = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const html = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')
const css = fs.readFileSync(path.join(root, 'capture', 'capture.css'), 'utf8')
const preload = fs.readFileSync(path.join(root, 'preload-capture.js'), 'utf8')
const captureDomain = fs.readFileSync(path.join(root, 'main/domains/capture/index.js'), 'utf8')
const documentApi = require('../shared/capture-document')

function sliceBetween(source, from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start)
  assert.ok(start >= 0 && end > start, `could not slice ${from} .. ${to}`)
  return source.slice(start, end)
}

const documentBlock = sliceBetween(script, 'function documentApi()', 'function renderDocumentInfo()')

test('§2.1 the renderer loads the shared document contract and never re-implements the transforms', () => {
  // capture.html must load the SAME module the main process requires, before capture.js.
  const documentScript = html.indexOf('../shared/capture-document.js')
  const captureScript = html.indexOf('src="capture.js"')
  assert.ok(documentScript > 0, 'capture.html must load shared/capture-document.js')
  assert.ok(documentScript < captureScript, 'the contract module must load before capture.js')

  // Both directions come from the shared module: no local zoom/offset arithmetic may exist.
  assert.match(documentBlock, /api\.annotationsFromViewport\(annotations, viewport\)/)
  assert.match(documentBlock, /api\.annotationsToViewport\(sourceAnnotations, viewport\)/)
  assert.match(documentBlock, /api\.fitViewport\(\{/)
  // A hand-rolled transform inside the renderer is exactly the drift the shared module exists
  // to prevent, so it must not appear in the document block.
  assert.doesNotMatch(documentBlock, /\*\s*\(?\s*zoom\s*\)?/)
  assert.doesNotMatch(documentBlock, /\/\s*zoom\b/)
})

test('§2.1 the export path subtracts the crop exactly once and is sized from crop', () => {
  const result = sliceBetween(script, 'async function documentResultBuffer()', '// Commit the frozen content state')
  // Canvas is crop-sized: source pixels, no resampling, no window/DPI influence.
  assert.match(result, /output\.width = Math\.max\(1, crop\.w\)/)
  assert.match(result, /output\.height = Math\.max\(1, crop\.h\)/)
  // The single crop subtraction lives here (drawImage source rect = crop), and annotations are
  // drawn with offsetX/offsetY = crop.x/crop.y by the shared export convention.
  assert.match(result, /out\.drawImage\(image, crop\.x, crop\.y, crop\.w, crop\.h, 0, 0, crop\.w, crop\.h\)/)
  assert.match(result, /drawAnnotation\(out, item, 1, 1, crop\.x, crop\.y, image\)/)
  // It must NOT shrink the result by the viewport zoom (that would resample the product).
  assert.doesNotMatch(result, /zoom/)
})

test('§4 the renderer sends sessionId + requestId + intent + frozen snapshot + result, nothing else', () => {
  const commit = sliceBetween(script, 'async function commitDocumentEditor(', '// Apply a commit result')
  assert.match(commit, /window\.captureAPI\.commitDocument\(\{/)
  assert.match(commit, /sessionId: documentEditor\.sessionId/)
  assert.match(commit, /requestId,/)
  assert.match(commit, /intent,/)
  assert.match(commit, /expectedRevisionId: intent === 'update' \? documentEditor\.revisionId : null/)
  assert.match(commit, /snapshot,/)
  assert.match(commit, /resultBuffer/)
  // The renderer must never name a document id / path / resource id in the payload: the main
  // process owns identity (contracts §4.1 "渲染器从不提交 paths/ids").
  assert.doesNotMatch(commit, /documentId:/)
  assert.doesNotMatch(commit, /filePath|docPath|baseImagePath|resultPath/)
  // A commit is one frozen snapshot: coalesced micro-edits are settled first.
  assert.match(commit, /flushCoalescedEdits\(\)/)
  // Re-entry guard so a double Ctrl+S cannot produce two revisions.
  assert.match(commit, /if \(documentEditor\.saving\) return/)
})

test('§4 every documented commit outcome is handled, and success is what establishes the clean baseline', () => {
  const handler = sliceBetween(script, 'function handleCommitResponse(', '// Unified close negotiation')
  for (const status of ['committed', 'unchanged', 'conflict']) {
    assert.ok(handler.includes(`'${status}'`), `commit handler must branch on ${status}`)
  }
  // conflict must never silently overwrite: it offers save-copy and otherwise keeps editing.
  assert.match(handler, /status === 'conflict'[\s\S]{0,400}?commitDocumentEditor\('save-copy'\)/)
  // Success accepts the main process's identity FIRST, then re-derives the fingerprint -
  // establishing the baseline before accepting the ids is how a temporary id causes false dirty.
  const acceptIndex = handler.indexOf('documentEditor.revisionId =')
  const baselineIndex = handler.indexOf('documentEditor.cleanFingerprint = documentFingerprintNow()')
  assert.ok(acceptIndex >= 0 && baselineIndex > acceptIndex, 'accept ids, then set the clean baseline')
  // A failure keeps the work: no dirty reset in the failure branch.
  const failureBranch = handler.slice(handler.indexOf("if (response.status === 'conflict')"))
  assert.doesNotMatch(failureBranch, /documentEditor\.dirty = false/)
})

test('§7.2 dirty is derived from the content fingerprint and re-derived on undo/redo', () => {
  const refresh = sliceBetween(script, 'function refreshDocumentDirty()', 'function renderDocumentInfo()')
  // Uses the shared fingerprint; viewport/selection/OCR state must not participate.
  assert.match(refresh, /documentFingerprintNow\(\)/)
  assert.match(refresh, /documentEditor\.cleanFingerprint/)
  assert.doesNotMatch(refresh, /selection/)
  assert.doesNotMatch(refresh, /activeOcrResult/)
  // It keys off the fingerprint, not the undo-stack index.
  assert.doesNotMatch(refresh, /historyIndex/)
  // Both mutation funnels must call it: a committed change (snapshotAnnotations) and an
  // undo/redo (restoreAnnotations, which moves historyIndex instead).
  assert.match(script, /function snapshotAnnotations\(\)[\s\S]{0,700}?if \(documentEditor\) refreshDocumentDirty\(\)/)
  assert.match(script, /function restoreAnnotations\(index\)[\s\S]{0,700}?if \(documentEditor\) refreshDocumentDirty\(\)/)
})

test('§6.1 A2 restoring a document swaps the session and resets the undo stack to one frame', () => {
  const restore = sliceBetween(script, 'function restoreDocumentEditor(', '// Encode the committed result')
  // Undo stack becomes exactly the loaded state: Ctrl+Z right after opening is a no-op and can
  // never walk back into another document's content.
  assert.match(restore, /annotationHistory = \[cloneAnnotations\(annotations\)\]/)
  assert.match(restore, /historyIndex = 0/)
  assert.match(restore, /invalidateMosaicPatches\(\)/)
  // Legacy flat records have no vector objects to restore - they must not be silently "empty".
  assert.match(restore, /payload\.legacy \? \[\]/)
  // The clean baseline is taken from the content we just loaded (opening is immediately clean).
  assert.match(restore, /documentEditor\.dirty = false/)
})

test('§7.3 every exit path goes through the same close negotiation', () => {
  // The single close funnel must consult the document editor first.
  const close = sliceBetween(script, 'function closeCaptureWindow()', 'function pointFromEvent')
  assert.match(close, /if \(documentEditor\) \{ requestCloseDocumentEditor\(\); return \}/)
  const negotiate = sliceBetween(script, 'async function requestCloseDocumentEditor()', '// Three-way prompt')
  // clean -> close immediately; dirty -> ask, and only close after a CONFIRMED commit.
  assert.match(negotiate, /if \(!documentEditor\.dirty\) \{ finishDocumentClose\(\); return \}/)
  assert.match(negotiate, /const result = await commitDocumentEditor\('update'\)/)
  assert.match(negotiate, /if \(result\.ok\) finishDocumentClose\(\)/)
  // "keep editing" must be reachable and must not close.
  assert.match(negotiate, /choice === 'discard'\) finishDocumentClose\(\)/)
  // A save in flight must not be able to close underneath the user.
  assert.match(negotiate, /if \(documentEditor\.saving\) return/)
})

test('§6 Ctrl+S commits the document and Ctrl+Shift+S saves a copy, without an external PNG dialog', () => {
  const keys = sliceBetween(script, "if(event.ctrlKey&&event.key.toLowerCase()==='s'&&documentEditor)", "if(event.key==='Enter'&&!event.ctrlKey&&!activeOcrResult")
  assert.match(keys, /const intent=event\.shiftKey\?'save-copy':'update'/)
  assert.match(keys, /commitDocumentEditor\(intent\)/)
  // The document branch must return before the image-save branch can run.
  assert.ok(keys.indexOf('return') < keys.indexOf("performAction('save')") || !keys.includes("performAction('save')"))
  // Plain capture windows keep the shipped behaviour.
  assert.match(script, /if\(event\.ctrlKey&&event\.key\.toLowerCase\(\)==='s'\)\{event\.preventDefault\(\);performAction\('save'\)\}/)
})

test('the identity bar exists in markup, is height-matched to the reserved window space, and is i18n-wired', () => {
  // The info area is what makes the version/name visible in a frameless window (contracts §5.3).
  assert.match(html, /<div id="documentInfo" class="document-info hidden">/)
  assert.match(html, /<span id="documentInfoText"><\/span>/)
  assert.match(html, /id="documentDirtyMark"/)
  assert.match(html, /id="documentSavingMark"/)
  // The renderer must write into the text span, not the bar (or it would erase the marks).
  assert.match(script, /document\.getElementById\('documentInfoText'\)/)
  assert.doesNotMatch(script, /bar\.textContent = t\('capture\.document\.info'/)
  // The reserved window height and the CSS height must agree, or the strip overlaps the image.
  const cssHeight = Number(/\.document-info \{[^}]*height:\s*(\d+)px/.exec(css)[1])
  const reserved = Number(/const DOCUMENT_EDITOR_INFO_HEIGHT = (\d+)/.exec(captureDomain)[1])
  assert.equal(cssHeight, reserved, `capture.css .document-info height ${cssHeight} must equal DOCUMENT_EDITOR_INFO_HEIGHT ${reserved}`)
  // Every new visible string goes through the locale table (no hardcoded CJK in the markup).
  assert.match(html, /data-i18n-title="capture\.document\.dirty-tip"/)
  assert.match(html, /data-i18n="capture\.document\.saving"/)
})

test('the preload exposes exactly the three new document channels and no path-taking API', () => {
  assert.match(preload, /commitDocument: \(payload\) => ipcRenderer\.invoke\('capture:commit-document', payload\)/)
  assert.match(preload, /commitStatus: \(payload\) => ipcRenderer\.invoke\('capture:commit-status', payload\)/)
  assert.match(preload, /loadDocument: \(payload\) => ipcRenderer\.invoke\('capture:load-document', payload\)/)
  // The renderer must not be able to name a file: the payload carries ids only.
  const block = preload.slice(preload.indexOf('commitDocument:'))
  assert.doesNotMatch(block, /filePath|docPath|historyDirectory/)
})

test('§5.3 the editor window reuses the pin geometry with the info row reserved, not a full screen overlay', () => {
  const open = sliceBetween(captureDomain, 'async function createDocumentEditorWindow(', 'async function createCaptureWindow(')
  // Reuses the shared layout (the whole point of §3.2: history must reuse what pin got right).
  assert.match(open, /resolveEditorLayout\(\{/)
  assert.match(open, /windowBounds: layout\.editorBounds/)
  assert.match(open, /imageBounds: layout\.imageBounds/)
  // Transparent so the reserved strip does not paint over the image.
  assert.match(open, /transparent: true/)
  // The info row is passed as extra height, not hardcoded elsewhere.
  assert.match(open, /extraRows: 1/)
  assert.match(open, /extraRowHeight: DOCUMENT_EDITOR_INFO_HEIGHT/)
  // The crop - not the whole base image - decides the fitting size.
  assert.match(open, /imageWidth: crop\.w/)
  assert.match(open, /imageHeight: crop\.h/)
  // It loads the document through the session-bound service, and reports real failures.
  assert.match(open, /documentService\.loadDocument\(documentId/)
  assert.match(open, /beginSession\(\{/)
})

test('§6.7 a legacy flat record opens as bitmap-only with no editable objects, and says so', () => {
  const open = sliceBetween(captureDomain, 'async function createDocumentEditorWindow(', 'async function createCaptureWindow(')
  // Legacy load path still works (it falls back to the committed result as the base image).
  assert.match(open, /loaded\.baseImagePath \|\| loaded\.resultImagePath/)
  // The documented boundary is surfaced to the renderer rather than silently ignored.
  assert.match(open, /legacy: loaded\.legacy === true/)
  assert.match(open, /storageFormat: loaded\.storageFormat \|\| 'legacy-bitmap'/)
  assert.match(open, /degraded: loaded\.degraded === true/)
})

test('the IPC handler reports structured failures instead of "always true"', () => {
  const edit = sliceBetween(captureDomain, 'async function editHistoryDocument(', 'function createCaptureController(')
  // Game mode must become a visible status, not an unhandled rejection (contracts §6 / §10 C10).
  assert.match(edit, /code: 'game-mode'/)
  assert.match(edit, /code: 'file-missing'/)
  assert.match(edit, /code: 'superseded'/)
  // Every path returns an object; the old `return true` is gone.
  assert.doesNotMatch(edit, /return true/)
})

// ---------- pure-function cross-check against the shared contract ----------

test('§2.1 the document editor paints the CROP, not the whole base image, into the image area', () => {
  // A document editor is handed the whole base image (it needs surrounding pixels when the
  // user re-crops later) but the window only reserves an area for the current crop. Drawing
  // the full image with the shipped `drawImage(image, bounds)` would squash the entire
  // screenshot into the crop box while annotations are mapped crop->box: a wrong backdrop that
  // also disagrees with the exported result. The document branch must slice the crop instead.
  const background = sliceBetween(script, 'function drawBackground()', 'function captureImageReady()')
  assert.match(background, /else if \(documentEditor\) \{/)
  assert.match(background, /const crop=documentCrop\(\)/)
  assert.match(background, /const view=documentViewport\(\)/)
  // Source rect = crop, destination size = crop * zoom (the same mapping the export uses).
  assert.match(background, /crop\.x, crop\.y, crop\.w, crop\.h,/)
  assert.match(background, /bounds\.x, bounds\.y, crop\.w\*zoom, crop\.h\*zoom/)
  // The shipped non-document branch must stay byte-identical for every capture window.
  assert.match(background, /else\{const bounds=imageDisplayBounds\(\);backgroundCtx\.drawImage\(image,bounds\.x,bounds\.y,bounds\.w,bounds\.h\)\}/)
})

test('the renderer viewport and the shared contract agree on a crop-offset document', () => {
  // Mirrors documentViewport(): fitViewport + re-anchor into the window image area.
  const baseSize = { width: 3840, height: 2160 }
  const crop = { x: 120, y: 80, w: 2400, h: 1600 }
  const imageBounds = { x: 40, y: 26, w: 900, h: 600 }
  const view = documentApi.fitViewport({ baseSize, crop, bounds: { width: imageBounds.w, height: imageBounds.h } })
  const viewport = Object.assign({}, view, {
    offsetX: imageBounds.x + view.offsetX,
    offsetY: imageBounds.y + view.offsetY
  })
  // The crop origin maps to the top-left of the image area (no double subtraction).
  const topLeft = documentApi.sourceToViewport({ x: crop.x, y: crop.y }, viewport)
  assert.ok(Math.abs(topLeft.x - imageBounds.x) < 1e-9)
  assert.ok(Math.abs(topLeft.y - imageBounds.y) < 1e-9)
  // An annotation at the crop centre round-trips through a commit unchanged.
  const annotation = { type: 'arrow', x: 1320, y: 880, x2: 1500, y2: 900, width: 8, color: '#ff0000' }
  const inViewport = documentApi.annotationsToViewport([annotation], viewport)
  const back = documentApi.annotationsFromViewport(inViewport, viewport)
  for (const field of ['x', 'y', 'x2', 'y2', 'width']) {
    assert.ok(Math.abs(back[0][field] - annotation[field]) < 1e-6, `${field} round trip`)
  }
  // Repeated window resizes must not accumulate drift (contracts §2.1: resize is projection only).
  let current = viewport
  for (let index = 0; index < 5; index += 1) {
    current = Object.assign({}, current, { offsetX: imageBounds.x + 5, offsetY: imageBounds.y + 7 })
    const roundTrip = documentApi.annotationsFromViewport(documentApi.annotationsToViewport([annotation], current), current)
    for (const field of ['x', 'y', 'x2', 'y2']) {
      assert.ok(Math.abs(roundTrip[0][field] - annotation[field]) < 1e-6, `${field} drift after resize ${index}`)
    }
  }
})
