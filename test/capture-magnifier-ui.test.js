// 功能 D3/D4：放大镜的渲染层接线契约（plan §7.1/§7.2/§7.3）。
//
// 这里钉的是渲染层必须遵守的部分，不是纯函数层的行为（那在 test/magnifier-geometry.test.js）：
//   ① 手势：在选区内拖出源区 → pointerup 时**一次**定位镜头并压一帧；拖动中不压帧；
//   ② 命中：hitTestMagnifier 的三分支决定拖哪一半；引线属于镜头侧；
//   ③ 一次手势一次撤销（拖动/改倍率/改边框各自只压一帧）；
//   ④ 上限：每文档 8 个，超限拒绝而不是静默丢弃；
//   ⑤ 绘制：overlay 与导出走**同一个** drawAnnotation 分支，镜头内容来自采样器
//      （底图 + 不透明遮罩），绝不来自合成后的画布 —— 这是 D 的隐私核心；
//   ⑥ 缓存生命周期：新一次 init / 关闭编辑器时释放；
//   ⑦ 载入时把越界的放大镜**移除**（不是夹紧，也不是可撤销的编辑）。
//
// 真机像素（镜头里确实是放大的内容、马赛克不被放大出来）由
// test/occlusion-recognition-runtime.test.js 的采样底图断言 + 实机清单覆盖。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const script = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const html = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')
const css = fs.readFileSync(path.join(root, 'capture', 'capture.css'), 'utf8')
const magnifierApi = require('../shared/magnifier-geometry')
const maskApi = require('../shared/occlusion-mask')
const samplerApi = require('../capture/magnifier-sampler')
const docApi = require('../shared/capture-document')

function sliceBetween(source, from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start)
  assert.ok(start >= 0 && end > start, `could not slice ${from} .. ${to}`)
  return source.slice(start, end)
}

// ---------- ① 手势与绘制接线 ----------

test('§7.1 the magnifier is a drawing tool on the strip and loads every shared module it needs', () => {
  // A drag on the region is how the object is created, so it belongs to the drawing tool group.
  assert.match(html, /<button data-tool="magnifier"[^>]*data-i18n-title="capture\.toolbar\.magnifier"/)
  assert.match(html, /--icon:url\('icons\/magnifier\.svg'\)/)
  assert.equal(fs.existsSync(path.join(root, 'capture', 'icons', 'magnifier.svg')), true)
  // The renderer reads all three contract modules through their UMD globals. A missing <script>
  // would make each one silently undefined at first use, which is exactly what the loading-order
  // test exists to catch; these three assertions are the renderer half of that pair.
  assert.match(script, /window\.magnifierGeometry/)
  assert.match(script, /window\.magnifierSampler/)
  assert.match(script, /window\.occlusionMask/)
})

test('§7.1 the draft tracks only the source rect and the lens is placed once, at commit', () => {
  const draft = sliceBetween(script, 'function buildMagnifierDraft(point)', '// The lens must be bounded by')
  // While dragging, only the source rect follows the pointer.
  assert.match(draft, /const rect = normalizeRect\(build\.start, point\)/)
  assert.match(draft, /api\.createFromSourceRect\(/)
  // The pointermove branch rebuilds the draft and RETURNS: it never commits.
  const move = sliceBetween(script, "canvas.addEventListener('pointermove'", "canvas.addEventListener('pointerup'")
  assert.match(move, /if \(magnifierBuild\) \{ magnifierBuild\.current=point; activeAnnotation=buildMagnifierDraft\(point\); render\(\); return \}/)
  assert.doesNotMatch(move, /commitMagnifierDraft|commitAnnotation\(/m, 'a drag move must never push a frame')
  // The commit happens exactly once, from the final rect.
  const up = sliceBetween(script, "canvas.addEventListener('pointerup'", "canvas.addEventListener('pointercancel'")
  assert.match(up, /if\(magnifierBuild\)\{commitMagnifierDraft\(\);/)
  const commit = sliceBetween(script, 'function commitMagnifierDraft()', 'function magnifierCount()')
  assert.match(commit, /api\.createFromSourceRect\(/)
  assert.match(commit, /commitAnnotation\(final\)/)
  assert.equal((commit.match(/commitAnnotation\(/g) || []).length, 1, 'a finished gesture is exactly one frame')
})

test('§7.1 a press names which half it grabbed, and a connector press drags the lens', () => {
  const part = sliceBetween(script, 'function magnifierPartAt(item, point)', "canvas.addEventListener('pointerdown'")
  assert.match(part, /api\.hitTestMagnifier\(item, point, FRAME_HIT_TOLERANCE \/ Math\.max\(1e-6, zoom\)\)/)
  // The connector belongs to the lens side: grabbing the line must move the lens, not the source.
  assert.match(part, /if \(part === 'connector'\) return 'lens'/)
  // The part is decided ONCE at press time (re-testing per move would let a drag switch halves).
  const move = sliceBetween(script, 'function moveAnnotationTo(point)', 'function annotationWasMoved(')
  assert.match(move, /state\.part \? moveMagnifierPart\(state\.origin, state\.part, dx, dy\) : translateAnnotation\(state\.origin, dx, dy\)/)
  const mover = sliceBetween(script, 'function moveMagnifierPart(', 'function annotationWasMoved(')
  assert.match(mover, /if \(part === 'lens'\) return api\.translateLens\(item, dx, dy\)/)
  assert.match(mover, /if \(part === 'source'\) return api\.translateSource\(item, dx, dy\)/)
  assert.match(mover, /return api\.translateMagnifier\(item, dx, dy\)/)
})

test('§7.1 "did it move" compares the nested geometry, so a lens drag is undoable', () => {
  const moved = sliceBetween(script, 'function annotationWasMoved(item, origin)', '// ---------- B7 (D11)')
  // A magnifier has no flat x/y; the shipped `item.x !== origin.x` test would always be false and the
  // whole gesture would silently produce no undo frame.
  assert.match(moved, /if \(item\.type === 'magnifier' \|\| origin\.type === 'magnifier'\)/)
  assert.match(moved, /const left = api\.normalizeMagnifier\(item\)/)
  assert.match(moved, /left\.sourceRect\.x !== right\.sourceRect\.x/)
  assert.match(moved, /left\.lensOrigin\.x !== right\.lensOrigin\.x/)
  // Every other type keeps the shipped comparison byte for byte.
  assert.match(moved, /return item\.x !== origin\.x \|\| item\.y !== origin\.y/)
})

test('§7.1 the overlay and the export share ONE drawAnnotation branch', () => {
  const draw = sliceBetween(script, 'function drawAnnotation(context, item', 'function drawMagnifier(')
  // A single dispatch point, so an export cannot render differently from the overlay.
  assert.match(draw, /if \(item\.type === 'magnifier'\) drawMagnifier\(context, item, scaleX, scaleY, offsetX, offsetY\)/)
  // The overlay path draws every annotation through it (no separate magnifier painter on the stage).
  const overlay = sliceBetween(script, 'function renderOverlay()', 'function render()')
  assert.match(overlay, /annotations\.forEach\(\(item\) => drawAnnotation\(ctx,item\)\)/)
  // The export path likewise, with the shared crop transform.
  const exportCanvas = sliceBetween(script, 'function exportSelectionCanvas(includeAnnotations = true)', 'function canvasPngBuffer(')
  assert.match(exportCanvas, /annotations\.forEach\(\(item\)=>drawAnnotation\(out,item,scaleX,scaleY,selection\.x,selection\.y,image\)\)/)
})

// ---------- ② 镜头内容的隐私来源 ----------

test('§7.2 the lens samples the base image + an opaque blur mask, never the composed stage', () => {
  const base = sliceBetween(script, 'function ensureSampleBase()', '// The sampled lens canvas')
  // The sample base is built from the shared occlusion plan: a lens must never be able to magnify a
  // mosaic away, which is the one privacy hazard the feature introduces (§7.2).
  assert.match(base, /const mask = window\.occlusionMask/)
  // The occluders must come from SOURCE-PIXEL annotations: a plain capture window stores viewport CSS,
  // so handing them straight to a source-resolution sample base would paint the mask in the wrong
  // place and defeat it entirely (a real defect the runtime probe caught). `annotationsForSampling`
  // is the projection that makes the two agree; the document editor case passes through unchanged.
  assert.match(base, /const occluders = mask\.buildOccluders\(annotationsForSampling\(\)\)/)
  const sampling = sliceBetween(script, 'function annotationsForSampling()', '// The sampled lens canvas')
  assert.match(sampling, /if \(documentEditor\) return annotationsToDocument\(\)/)
  assert.match(sampling, /const scaleX = source\.width \/ Math\.max\(1, rect\.w\)/)
  assert.match(sampling, /x: source\.x \+ \(point\.x - rect\.x\) \* scaleX/)
  assert.match(base, /const fingerprint = mask\.maskFingerprint\(occluders\)/)
  assert.match(base, /sampler\.composeSampleBase\(\{\s*baseImage: image,/)
  assert.match(base, /adoptSampleBase\(\{ canvas: composed\.canvas, fingerprint: key \}\)/)
  // It must NOT read the already-composed canvas: that one contains the mosaic's own pixels and the
  // ordinary annotations, so sampling it would both leak and duplicate.
  assert.doesNotMatch(base, /composeOutputCanvas|exportSelectionCanvas|outputStyle/)
  // The painter uses the sampled canvas and falls back to a neutral fill - never to the stage.
  const draw = sliceBetween(script, 'function drawMagnifier(context, item', 'function renderOverlay()')
  assert.match(draw, /const sampled = magnifierLensCanvas\(item\)/)
  assert.match(draw, /context\.drawImage\(sampled, left, top, lensWidth, lensHeight\)/)
  assert.match(draw, /context\.fillStyle = 'rgba\(0,0,0,\.06\)'/)
  assert.doesNotMatch(draw, /drawImage\(image,|backgroundCanvas|ctx\.drawImage/)
})

test('§7.2 the sample cache is byte-budgeted and released with the session', () => {
  const base = sliceBetween(script, 'function resetLensSampler()', '// The sampled lens canvas')
  assert.match(base, /sampler\.createLensSampler\(\{/)
  assert.match(base, /sampleBaseKey = ''/)
  const release = sliceBetween(script, 'function releaseLensSampler()', '// The base the lens samples from')
  assert.match(release, /if \(lensSampler\) lensSampler\.reset\(\)/)
  assert.match(release, /lensSampler = null/)
  // A new capture drops it (the cache belongs to the previous image).
  const reset = sliceBetween(script, 'function resetAnnotationState()', 'function commitAnnotation(item)')
  assert.match(reset, /releaseLensSampler\(\)/)
  // The shared cache honours the §3.3 budget: an entry larger than the whole budget is not cached.
  const cache = samplerApi.createSampleCache({ budgetBytes: 1024 })
  const huge = { width: 100, height: 100 }
  assert.equal(cache.set('huge', huge), null, 'an entry over budget is returned but never cached')
  assert.equal(cache.stats().entries, 0)
  const small = { width: 2, height: 2 }
  cache.set('small', small)
  assert.equal(cache.stats().entries, 1)
  assert.equal(cache.get('small'), small)
  cache.clear()
  assert.equal(cache.stats().entries, 0)
})

test('§7.2 moving the lens does not invalidate the sample cache (only the source rect does)', () => {
  const crop = { x: 0, y: 0, w: 800, h: 600 }
  const base = magnifierApi.createFromSourceRect({ x: 100, y: 100, w: 120, h: 80 }, { factor: 2, crop })
  const movedLens = magnifierApi.translateLens(base, 40, 25)
  const movedSource = magnifierApi.translateSource(base, 10, 0)
  const keyOf = (magnifier) => magnifierApi.sampleCacheKey({
    baseImageId: 'img',
    crop,
    maskFingerprint: 'mask',
    sourceRect: magnifier.sourceRect,
    factor: magnifier.factor
  })
  assert.equal(keyOf(base), keyOf(movedLens), 'dragging the lens must not re-sample the base image')
  assert.notEqual(keyOf(base), keyOf(movedSource), 'moving the source rect must re-sample')
  // A factor change re-samples too (the lens is a different upscale).
  assert.notEqual(keyOf(base), keyOf(magnifierApi.withFactor(base, 3)))
})

// ---------- ③ 属性面板：倍率 / 边框 / 引线 ----------

test('§7.1 the attribute panel edits the SELECTED magnifier in one frame, or only the default', () => {
  const panel = sliceBetween(script, 'function syncMagnifierPanel()', '// A factor/connector click')
  // Visibility: the tool is active OR a magnifier is selected (so editing after switching back to
  // the select tool does not require re-picking the tool).
  const visible = sliceBetween(script, 'function magnifierPanelVisible()', 'function setMagnifierStatus(')
  assert.match(visible, /return currentTool === 'magnifier' \|\| \!\!selectedMagnifier\(\)/)
  // The widget state is read from the selected object when there is one, from the defaults otherwise.
  assert.match(panel, /const item = selectedMagnifier\(\)/)
  assert.match(panel, /const factor = item \? item\.factor : magnifierFactor/)
  assert.match(panel, /const connector = item \? item\.connector : magnifierConnector/)
  // Both groups are latched buttons written through aria-pressed, like every other choice group.
  assert.match(panel, /button\.setAttribute\('aria-pressed', String\(active\)\)/)
  // Choosing with a selection edits that object; with nothing selected it only moves the default and
  // pushes no frame (nothing was edited).
  const choose = sliceBetween(script, 'function chooseMagnifierFactor(', 'function finishSelection()')
  assert.match(choose, /if \(selectedMagnifier\(\)\) editSelectedMagnifier\(\{ factor: magnifierFactor \}\)/)
  assert.match(choose, /else \{ syncMagnifierPanel\(\); setMagnifierStatus\('', null, false\) \}/)
  assert.match(choose, /if \(selectedMagnifier\(\)\) editSelectedMagnifier\(\{ connector: magnifierConnector \}\)/)
  // The edit itself is one frame and keeps the id (the only link the selection set has).
  const edit = sliceBetween(script, 'function editSelectedMagnifier(patch)', "canvas.addEventListener('pointermove'")
  assert.match(edit, /if \(patch\.factor !== undefined\) next = api\.withFactor\(next, patch\.factor\)/)
  assert.match(edit, /const committed = Object\.assign\(\{\}, next, \{ id: item\.id \}\)/)
  assert.match(edit, /flushCoalescedEdits\(\)/)
  assert.match(edit, /snapshotAnnotations\(\)/)
  // A source rect that left the crop is refused with a message rather than silently clamped.
  assert.match(edit, /if \(!clipped\.ok\) \{[\s\S]{0,160}?setMagnifierStatus\('capture\.magnifier\.outside', null, true\)/)
})

test('§7.1 the border-width slider coalesces into one frame (live preview, commit on change)', () => {
  const wiring = sliceBetween(script, 'if (magnifierStrokeWidthInput) {', "document.getElementById('undo').onclick")
  // `input` repaints without a frame; `change`/`pointerup` commit exactly one.
  // The live-preview function is named, so pin the NAMES and their bodies rather than a slice: the
  // preview must not commit, the committer must.
  assert.match(wiring, /const previewStrokeWidth = \(\) => \{/)
  const preview = wiring.slice(wiring.indexOf('const previewStrokeWidth'), wiring.indexOf("magnifierStrokeWidthInput.addEventListener('input'"))
  assert.doesNotMatch(preview, /snapshotAnnotations|editSelectedMagnifier/, 'the live preview must never push a frame')
  assert.match(wiring, /magnifierStrokeWidthInput\.addEventListener\('change', commitStrokeWidth\)/)
  assert.match(wiring, /magnifierStrokeWidthInput\.addEventListener\('pointerup', commitStrokeWidth\)/)
  assert.match(wiring, /if \(selectedMagnifier\(\)\) editSelectedMagnifier\(\{ stroke: \{ widthPx: value \} \}\)/)
})

test('§7.1 the panel is a floating surface, not part of the per-tool option row', () => {
  assert.match(html, /<div id="magnifierPanel" class="magnifier-panel hidden">/)
  assert.match(css, /\.magnifier-panel \{[\s\S]{0,240}?position: fixed/)
  // #toolOptions is a projection of data-option-tools; the magnifier's attributes are properties of
  // the object, so they must not live there (they would vanish whenever no tool owns options).
  const toolOptions = html.slice(html.indexOf('<div id="toolOptions"'), html.indexOf('<div id="elementBar"'))
  assert.doesNotMatch(toolOptions, /data-magnifier-factor|data-magnifier-connector/)
  // Every control the controller drives exists in the markup.
  assert.match(html, /data-magnifier-factor="2"/)
  assert.match(html, /data-magnifier-factor="3"/)
  assert.match(html, /data-magnifier-factor="4"/)
  assert.match(html, /data-magnifier-connector="none"/)
  assert.match(html, /data-magnifier-connector="line"/)
  assert.match(html, /id="magnifierStrokeWidth"/)
})

// ---------- ④ 上限 / 载入裁剪 ----------

test('§3.3 the per-document limit refuses a new lens instead of dropping an existing one', () => {
  const commit = sliceBetween(script, 'function commitMagnifierDraft()', 'function magnifierCount()')
  assert.match(commit, /if \(magnifierCount\(\) >= api\.MAX_PER_DOCUMENT\) \{/)
  assert.match(commit, /setMagnifierStatus\('capture\.magnifier\.limit', \{ max: api\.MAX_PER_DOCUMENT \}, true\)/)
  // It returns without committing - no frame, no silent removal of an older lens.
  const limitBranch = commit.slice(commit.indexOf('if (magnifierCount()'), commit.indexOf('// Re-derive from the final rect'))
  assert.doesNotMatch(limitBranch, /commitAnnotation|annotations\.splice/)
  assert.equal(magnifierApi.MAX_PER_DOCUMENT, 8)
  // The document contract enforces the same number on the commit path.
  assert.equal(docApi.MAX_MAGNIFIERS, magnifierApi.MAX_PER_DOCUMENT)
})

test('§7.1 loading removes out-of-crop magnifiers inside the load frame (not as an undoable edit)', () => {
  const clip = sliceBetween(script, 'function clipRestoredMagnifiers()', 'function restoreOutputStyleForDocument(')
  assert.match(clip, /const clipped = api\.clipToCrop\(item, crop\)/)
  assert.match(clip, /if \(!clipped\.ok\) \{ changed = true; continue \}/)
  // The load frame is rebuilt from the state AFTER the removal, so Ctrl+Z right after opening is a
  // no-op and cannot resurrect an object that samples pixels the document no longer has.
  assert.match(clip, /annotationHistory = \[cloneAnnotations\(annotations\)\]/)
  assert.match(clip, /historyIndex = 0/)
  assert.doesNotMatch(clip, /snapshotAnnotations\(\)/, 'the load frame is not an edit')
  // It runs inside the restore funnel.
  const restore = sliceBetween(script, 'function restoreDocumentEditor(payload)', 'function clipRestoredMagnifiers(')
  assert.match(restore, /clipRestoredMagnifiers\(\)/)
})

test('§7.1 a gesture that is interrupted leaves no object and no frame', () => {
  const cancel = sliceBetween(script, "canvas.addEventListener('pointercancel'", "canvas.addEventListener('wheel'")
  assert.match(cancel, /magnifierBuild=null/)
  assert.match(cancel, /magnifierDrag=null/)
  assert.doesNotMatch(cancel, /commitMagnifierDraft|snapshotAnnotations/)
  // Switching tools drops an unsettled draft the same way.
  const setTool = sliceBetween(script, 'function setTool(tool)', '// A1/A4: one place paints')
  assert.match(setTool, /if\(tool!=='magnifier'&&magnifierBuild\)\{magnifierBuild=null;magnifierDrag=null;activeAnnotation=null;render\(\)\}/)
})

// ---------- ⑤ 端到端：文档往返 + 出口一致 ----------

test('§7.3 a magnifier round-trips through the document, so a reopened record stays editable', () => {
  const magnifier = magnifierApi.createFromSourceRect(
    { x: 100, y: 80, w: 160, h: 100 },
    { factor: 3, crop: { x: 0, y: 0, w: 800, h: 600 }, stroke: { color: '#ff3b30', widthPx: 3 }, connector: 'line' }
  )
  const document = docApi.createInitialDocument({
    assetId: 'placeholder',
    width: 800,
    height: 600,
    annotations: [magnifier]
  })
  const reopened = docApi.parseDocument(JSON.stringify(document))
  assert.equal(reopened.ok, true, 'a document carrying a magnifier must validate')
  const restored = reopened.document.annotations.find((item) => item.type === 'magnifier')
  assert.ok(restored, 'the magnifier survives serialize + parse')
  // The nested geometry and the derived lens size are both preserved: the lens size is recomputed
  // from sourceRect * factor, never persisted, so a reload cannot accumulate rounding.
  assert.equal(restored.factor, 3)
  assert.equal(restored.connector, 'line')
  assert.deepEqual(restored.sourceRect, magnifier.sourceRect)
  assert.deepEqual(restored.lensOrigin, magnifier.lensOrigin)
  assert.deepEqual(magnifierApi.lensRect(restored), magnifierApi.lensRect(magnifier))
})

test('§7.1 the viewport round-trip of a magnifier is exact (overlay and export agree)', () => {
  // This is the pair shared/capture-document.js implements for the nested object; the renderer relies
  // on it for "what you see is what gets written", so a drift here is a wrong export.
  const magnifier = magnifierApi.createFromSourceRect(
    { x: 120, y: 90, w: 200, h: 120 },
    { factor: 2, crop: { x: 0, y: 0, w: 800, h: 600 } }
  )
  const viewport = { baseSize: { width: 800, height: 600 }, crop: { x: 0, y: 0, w: 800, h: 600 }, zoom: 0.65, offsetX: 40, offsetY: 26 }
  const inViewport = docApi.annotationsToViewport([magnifier], viewport)
  const back = docApi.annotationsFromViewport(inViewport, viewport)
  assert.equal(back.length, 1)
  assert.equal(back[0].type, 'magnifier')
  for (const field of ['x', 'y', 'w', 'h']) {
    assert.ok(Math.abs(back[0].sourceRect[field] - magnifier.sourceRect[field]) < 1e-6, `sourceRect.${field} round trip`)
  }
  for (const field of ['x', 'y']) {
    assert.ok(Math.abs(back[0].lensOrigin[field] - magnifier.lensOrigin[field]) < 1e-6, `lensOrigin.${field} round trip`)
  }
  assert.equal(back[0].factor, magnifier.factor)
  assert.equal(back[0].connector, magnifier.connector)
  // The stroke width is a DOCUMENT LENGTH (§6.2.1 "cannot convert only the endpoints and skip the
  // style geometry"), so at zoom != 1 it must round-trip exactly too. It used to drift by up to a
  // pixel because normalizeMagnifier both rounded to integers and clamped into the document range -
  // the second half was the subtler bug, because a 1px stroke at zoom 0.5 is 0.5 in viewport space
  // and the clamp silently raised it to 1. Both ends are fixed in the shared layer now, so this is
  // an exact assertion rather than a tolerance.
  assert.ok(
    Math.abs(back[0].stroke.widthPx - magnifier.stroke.widthPx) < 1e-6,
    `stroke width must round-trip exactly (got ${back[0].stroke.widthPx} vs ${magnifier.stroke.widthPx})`
  )
  // And the midpoint really is scaled by the zoom, not silently clamped back into the document range.
  assert.ok(
    Math.abs(inViewport[0].stroke.widthPx - magnifier.stroke.widthPx * viewport.zoom) < 1e-6,
    `the viewport stroke width must be widthPx * zoom (got ${inViewport[0].stroke.widthPx})`
  )
})

test('§7.2 a magnifier never widens what a recognition input can read', () => {
  // The recognition path masks blur areas; a magnifier is an ordinary annotation for that purpose and
  // must not appear in the model's input at all (includeAnnotations=false). Structurally: the
  // recognition branch passes compose:false / mask:true and the magnifier is drawn by drawAnnotation,
  // which only runs when includeAnnotations is true.
  const apply = sliceBetween(script, 'function applyRecognitionOcclusion(', 'function exportSelectionCanvas(includeAnnotations')
  assert.doesNotMatch(apply, /magnifier|drawAnnotation/, 'the recognition input must not render annotations of any type')
  const exportCanvas = sliceBetween(script, 'function exportSelectionCanvas(includeAnnotations = true)', 'function canvasPngBuffer(')
  assert.match(exportCanvas, /if\(includeAnnotations\)\{[\s\S]{0,200}?drawAnnotation\(out,item/)
  // And the occlusion plan only ever reads blur objects, so a magnifier is neither an occluder nor a
  // way around one.
  const occluders = maskApi.buildOccluders([{ type: 'magnifier', sourceRect: { x: 0, y: 0, w: 10, h: 10 }, lensOrigin: { x: 20, y: 20 }, factor: 2 }])
  assert.equal(occluders.length, 0)
})

// ---------- ⑥ D4：出口一致 + 重开回显 ----------

test('§7.3 every export exit renders the magnifier through the same path', () => {
  // Copy / save / pin / PDF / history result image all funnel through exportSelectionCanvas plus
  // documentResultBuffer, and both call drawAnnotation - so the one magnifier branch in
  // drawAnnotation is what makes every exit agree. Assert the funnel, not each exit separately.
  const action = sliceBetween(script, 'async function performAction(action)', 'function showResult(')
  assert.match(action, /const output=exportSelectionCanvasForAction\(/)
  for (const exit of ["if(action==='copy')", "if(action==='save')", "if(action==='pdf')", "if(action==='pin')"]) {
    assert.ok(action.includes(exit), `${exit} must still ship`)
  }
  // The document commit path (history result image / thumbnail source) draws the same annotations.
  const result = sliceBetween(script, 'async function documentResultBuffer()', '// Commit the frozen content state')
  assert.match(result, /for \(const item of viewsForExport\) drawAnnotation\(out, item, 1, 1, crop\.x, crop\.y, image\)/)
  // And the finished-look composition wraps that same content, so a card and a lens compose in the
  // documented order (§6.1: content first, frame around it).
  assert.match(result, /const composed = composeFinishedOutput\(output, currentOutputStyle\(\)\)/)
})

test('§7.3 reopening a record echoes the saved lens attributes (factor, connector, width)', () => {
  const restore = sliceBetween(script, 'function restoreDocumentEditor(payload)', 'function clipRestoredMagnifiers(')
  // Out-of-crop objects are dropped first, then the defaults follow what survived.
  assert.ok(restore.indexOf('clipRestoredMagnifiers()') < restore.indexOf('adoptMagnifierDefaultsFromDocument()'))
  assert.match(restore, /syncMagnifierPanel\(\)/)
  const adopt = sliceBetween(script, 'function adoptMagnifierDefaultsFromDocument()', '// Feature C: install the session')
  assert.match(adopt, /const lenses = annotations\.filter\(\(item\) => item\?\.type === 'magnifier'\)/)
  assert.match(adopt, /magnifierFactor = last\.factor/)
  assert.match(adopt, /magnifierConnector = last\.connector/)
  assert.match(adopt, /annotationWidth = Math\.max\(1, Math\.min\(24, Math\.round\(last\.stroke\.widthPx\)\)\)/)
  // A document without lenses resets to the shipped defaults instead of keeping the previous image's.
  assert.match(adopt, /if \(!lenses\.length\) \{\s*magnifierFactor = 2\s*magnifierConnector = 'none'/)
  // The panel reads from the SELECTED object, so selecting a restored lens shows its own values rather
  // than the defaults - that is what makes the echo honest.
  const panel = sliceBetween(script, 'function syncMagnifierPanel()', '// A factor/connector click')
  assert.match(panel, /const factor = item \? item\.factor : magnifierFactor/)
  assert.match(panel, /const width = item \? item\.stroke\.widthPx : Math\.max\(1, Math\.round\(annotationWidth\)\)/)
})

test('§7.3 the same document produces the same magnifier geometry on every exit (no drift)', () => {
  // Structural: the export path subtracts the crop ONCE and passes it as the offset, so a magnifier's
  // nested rects are mapped by the same transform as every other annotation. Re-deriving them per exit
  // is what would let a preview and a save disagree.
  const exportCanvas = sliceBetween(script, 'function exportSelectionCanvas(includeAnnotations = true)', 'function canvasPngBuffer(')
  assert.equal((exportCanvas.match(/getSourcePixelRect\(/g) || []).length, 1, 'exactly one crop subtraction')
  const draw = sliceBetween(script, 'function drawMagnifier(context, item', 'function renderOverlay()')
  // The painter maps through the SAME offset/scale it was handed - no second, local crop subtraction.
  assert.match(draw, /const mapX = \(value\) => \(value - offsetX\) \* scaleX/)
  assert.match(draw, /const mapY = \(value\) => \(value - offsetY\) \* scaleY/)
  assert.doesNotMatch(draw, /crop\.x|crop\.y|documentCrop\(\)/, 'the painter must not re-apply the crop')
  // The lens canvas is drawn at the mapped lens rect, so overlay and export cannot diverge.
  assert.match(draw, /const lens = api\.lensRect\(magnifier\)/)
  assert.match(draw, /const left = mapX\(lens\.x\)/)
  assert.match(draw, /const top = mapY\(lens\.y\)/)
})
