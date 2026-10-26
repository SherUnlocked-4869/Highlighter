// R0.4：识别隐私遮罩的渲染层接线契约（contracts §8 / plan §2 R0.4 / §7.2）。
//
// 背景：在 R0.4 之前，所有识别入口（OCR / 翻译 / 表格 / QR / 转文档）拿到的是**未遮罩**的裁剪
// 图 —— 用户用马赛克盖住的文字仍然以可读像素送进模型。这是一个真实的隐私缺陷，不是显示效果。
//
// 本文件钉三件事：
//   ① 三个开关（includeAnnotations / compose / mask）是**独立维度**，不是互相推导，
//      也不是一个布尔；
//   ② 识别路径遮罩、普通导出路径不遮罩（遮了会把用户自己想保存的内容涂黑）；
//   ③ 遮罩在源像素画布上施加、早于任何缩放；遮罩版输入是一次性的，绝不回流成编辑底图/保存结果。
//
// 纯函数 + 桩画布：真实的像素覆盖由 test/occlusion-mask.test.js（Lead 的范围）负责，
// 这里只证明渲染层把正确的输入喂给了正确的函数。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const script = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const maskApi = require('../shared/occlusion-mask')
const docApi = require('../shared/capture-document')

function sliceBetween(source, from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start)
  assert.ok(start >= 0 && end > start, `could not slice ${from} .. ${to}`)
  return source.slice(start, end)
}

// ---------- ① 三个开关互相独立 ----------

test('R0.4 recognition is false/false/true and every user-facing export is true/true/false', () => {
  const action = sliceBetween(script, 'async function performAction(action)', 'function showResult(')
  assert.match(action, /const pixelOnlyActions = recognitionActions\.includes\(action\)/)
  assert.match(action, /const composedActions = !pixelOnlyActions/)
  assert.match(action, /const maskedActions = pixelOnlyActions/)
  // The defaults live in the helper and are all OFF, so a caller that forgets cannot leak pixels.
  const helper = sliceBetween(script, 'function exportSelectionCanvasForAction(', 'function annotationsForMask(')
  assert.match(helper, /const compose = options\.compose === true/)
  assert.match(helper, /const mask = options\.mask === true/)
  // mask=true must NOT imply compose: the recognition input stays undecorated even when the user
  // has a card preset selected (a frame would be pixels a model tries to read).
  assert.doesNotMatch(helper, /mask\s*=\s*options\.compose|compose\s*=\s*options\.mask/)
  assert.doesNotMatch(helper, /includeAnnotations\s*=\s*!?mask|mask\s*=\s*!?includeAnnotations/)
})

test('R0.4 the recognition branch keeps includeAnnotations=false (the mask does not re-enable annotations)', () => {
  const action = sliceBetween(script, 'async function performAction(action)', 'function showResult(')
  // Ordinary annotations (arrows/text/highlight) are noise for an OCR model and are NOT what the
  // mask is about - so the first argument stays `!pixelOnlyActions`.
  assert.match(action, /exportSelectionCanvasForAction\(!pixelOnlyActions,exportRect,\{ compose: composedActions, mask: maskedActions \}\)/)
  assert.doesNotMatch(action, /exportSelectionCanvasForAction\(true,\s*exportRect,\s*\{[^}]*mask:/)
})

test('R0.4 the mask is applied BEFORE any scaling (it is painted at source resolution)', () => {
  const apply = sliceBetween(script, 'function applyRecognitionOcclusion(', 'function exportSelectionCanvas(includeAnnotations')
  // The plan is built from the export canvas's own source-pixel geometry, and the ops are painted
  // straight onto it - no scale factor appears anywhere in the paint step. Painting the mask in CSS
  // space and scaling afterwards would leave the interpolation halo of un-masked pixels outside the
  // blur rect, i.e. leak the very content the mask exists to hide.
  assert.match(apply, /mask\.buildOccluders\(input\.annotations\)/)
  assert.match(apply, /mask\.planOcclusion\(\{ crop: input\.crop, occluders: transformed \}\)/)
  assert.match(apply, /paintOcclusionPlan\(context, plan\)/)
  const paint = sliceBetween(script, 'function paintOcclusionPlan(', 'function applyRecognitionOcclusion(')
  assert.doesNotMatch(paint, /\* *scale|scaleX|scaleY|zoom/i, 'the paint step must not scale anything')
  assert.match(paint, /context\.globalAlpha = mask\.MASK_ALPHA/)
  assert.match(paint, /context\.fillStyle = mask\.MASK_COLOR/)
  assert.match(paint, /context\.lineWidth = Math\.max\(1, op\.width\)/, 'brush strokes paint at their full source width')
  assert.match(paint, /context\.lineCap = 'round'/, 'the caps are part of the covered area (§8 "end caps")')
})

test('R0.4 a plain capture window projects its annotations into export space before masking', () => {
  const forMask = sliceBetween(script, 'function annotationsForMask(rect)', 'function transformOccluder(')
  // A document editor already stores source pixels; a plain capture window stores viewport CSS, so
  // it must be projected with the SAME transform drawAnnotation uses (scale from getSourcePixelRect).
  assert.match(forMask, /if \(documentEditor\) return \{ crop: documentCrop\(\), annotations: annotationsToDocument\(\), transform: null \}/)
  assert.match(forMask, /const source = getSourcePixelRect\(rect, bounds, \{ width: image\.naturalWidth, height: image\.naturalHeight \}\)/)
  assert.match(forMask, /const scaleX = source\.width \/ Math\.max\(1, rect\.w\)/)
  // The crop handed to the planner is the export canvas itself (origin 0,0 at the canvas corner).
  assert.match(forMask, /crop: \{ x: 0, y: 0, w: source\.width, h: source\.height \}/)
  const transform = sliceBetween(script, 'function transformOccluder(occluder, transform)', 'function paintOcclusionPlan(')
  assert.match(transform, /x: \(rect\.x - offsetX\) \* scaleX/)
  assert.match(transform, /width: \(occluder\.width \|\| 0\) \* widthScale/)
})

// ---------- ② 遮罩覆盖哪些像素（纯函数层，直接对 shared 模块） ----------

test('R0.4 a blur annotation becomes an opaque occluder; highlight and ordinary annotations do not', () => {
  const occluders = maskApi.buildOccluders([
    { type: 'rect', x: 10, y: 10, x2: 100, y2: 60, color: '#ff3b30', width: 4 },
    { type: 'blur', x: 20, y: 30, x2: 140, y2: 90, width: 4, color: '#ff3b30' },
    { type: 'highlight', x: 0, y: 0, x2: 200, y2: 20, width: 4, color: '#ffcc00' },
    { type: 'text', x: 5, y: 5, text: 'secret', width: 4, color: '#ff3b30' }
  ])
  assert.equal(occluders.length, 1, 'only blur objects are occluders')
  assert.equal(occluders[0].kind, 'rect')
  // The rect is the union of the two endpoints, not the raw x/x2 values.
  assert.deepEqual(occluders[0].rect, { x: 20, y: 30, w: 120, h: 60 })
})

test('R0.4 the mask is built from the DOCUMENT state, so a visibility preview cannot unlock it', () => {
  // §8: the criterion is "is there still a blur object in the document", not "does it look visible
  // right now". A render-only flag must therefore have no effect on the plan.
  const annotations = [{ type: 'blur', x: 40, y: 40, x2: 120, y2: 120, width: 4 }]
  const plan = maskApi.buildOcclusionPlan({ crop: { x: 0, y: 0, w: 400, h: 300 }, annotations })
  assert.equal(plan.masked, true)
  // Simulating the renderer's display-only preview state (opacity / eraser) changes nothing,
  // because those keys are not part of the geometry the plan reads.
  const previewed = [{ type: 'blur', x: 40, y: 40, x2: 120, y2: 120, width: 4, previewOpacity: 0, erased: true }]
  assert.deepEqual(
    maskApi.buildOcclusionPlan({ crop: { x: 0, y: 0, w: 400, h: 300 }, annotations: previewed }),
    plan
  )
  // Removing the object DOES unlock it (explicit delete = explicit consent).
  const removed = maskApi.buildOcclusionPlan({ crop: { x: 0, y: 0, w: 400, h: 300 }, annotations: [] })
  assert.equal(removed.masked, false)
  assert.deepEqual(removed.ops, [])
})

test('R0.4 the mask handles crop offsets and drops occluders that fall outside the crop', () => {
  const crop = { x: 100, y: 50, w: 200, h: 100 }
  const inside = maskApi.buildOcclusionPlan({
    crop,
    annotations: [{ type: 'blur', x: 120, y: 70, x2: 200, y2: 120, width: 4 }]
  })
  assert.equal(inside.masked, true)
  // Coordinates are relative to the crop origin — that is what makes them canvas coordinates.
  const op = inside.ops[0]
  assert.ok(op.x >= 0 && op.y >= 0, 'a mask op never starts before the canvas origin')
  assert.ok(op.x <= 80 && op.y <= 70, `op must be inside the canvas (got ${op.x},${op.y})`)
  const outside = maskApi.buildOcclusionPlan({
    crop,
    annotations: [{ type: 'blur', x: 500, y: 500, x2: 600, y2: 600, width: 4 }]
  })
  assert.equal(outside.masked, false, 'a blur outside the crop covers nothing that gets sampled')
})

test('R0.4 a document round-trip keeps the blur object, so a reopened record stays masked', () => {
  const document = docApi.createInitialDocument({
    assetId: 'placeholder',
    width: 640,
    height: 480,
    annotations: [{ type: 'blur', x: 10, y: 10, x2: 90, y2: 60, width: 4, color: '#ff3b30' }]
  })
  const reopened = docApi.parseDocument(JSON.stringify(document))
  assert.equal(reopened.ok, true)
  const plan = maskApi.buildOcclusionPlan({ crop: reopened.document.crop, annotations: reopened.document.annotations })
  assert.equal(plan.masked, true, 'reopening must not silently drop the protection')
})

// ---------- ③ 遮罩输入绝不回流 ----------

test('R0.4 the masked canvas never becomes the edit base image or a saved result', () => {
  // `applyRecognitionOcclusion` mutates the canvas it is given; that canvas is the fresh one created
  // by exportSelectionCanvas for this single export. Neither the decode path nor the commit path may
  // call it.
  const apply = sliceBetween(script, 'function applyRecognitionOcclusion(', 'function exportSelectionCanvas(includeAnnotations')
  assert.doesNotMatch(apply, /image\s*=/, 'the decoded base image must never be replaced by a masked copy')
  // The document commit result is built from the base image + annotations, and is NOT masked.
  const result = sliceBetween(script, 'async function documentResultBuffer()', '// Commit the frozen content state')
  assert.doesNotMatch(result, /applyRecognitionOcclusion|paintOcclusionPlan|occlusionMask/)
  // The history/save/pin/PDF file containers are written from the export path with mask=false.
  const action = sliceBetween(script, 'async function performAction(action)', 'function showResult(')
  const forSave = action.slice(action.indexOf("if(action==='copy')"), action.indexOf("if(action==='convert')"))
  assert.doesNotMatch(forSave, /applyRecognitionOcclusion|paintOcclusionPlan/)
})

test('R0.4 a mask that cannot be planned fails CLOSED, not open', () => {
  // Returning the unmasked canvas on error would defeat the entire fix. The fallback covers the
  // whole input instead, so an unexpected geometry bug cannot leak a mosaic's contents.
  const apply = sliceBetween(script, 'function applyRecognitionOcclusion(', 'function exportSelectionCanvas(includeAnnotations')
  assert.match(apply, /catch \(error\) \{[\s\S]{0,400}?plan = \{ masked: true, ops: \[\{ kind: 'rect', x: 0, y: 0, w: contentCanvas\.width, h: contentCanvas\.height \}\] \}/)
  // The OTHER degenerate states (no module, no 2D context, image not loaded) are fail-CLOSED too:
  // there IS a blur to protect but its geometry cannot be computed, so the export is refused
  // (`null`) instead of handing the model the covered pixels. An earlier version returned the input
  // here, which was a real fail-open hole - a missing module or an unloaded image silently sent the
  // mosaic's contents to the model.
  assert.match(apply, /if \(!mask \|\| !context \|\| !image\) \{/, 'the degenerate states must not return the input')
  assert.match(apply, /return null/)
  // The ONLY branch allowed to skip masking is "there is no blur object at all".
  assert.match(apply, /if \(!hasOccludableBlur\(rect\)\) return contentCanvas/)
})

test('R0.4 a mask that cannot be computed aborts the action instead of sending unmasked pixels', () => {
  // The three-switch call site must propagate the refusal. Returning the content anyway on a null
  // mask result would be the exact failure mode this whole path exists to prevent.
  const action = sliceBetween(script, 'function exportSelectionCanvasForAction(', '// Annotations in the source-pixel space of the EXPORT canvas')
  assert.match(action, /const masked = mask \? applyRecognitionOcclusion\(content, rect\) : content/)
  assert.match(action, /if \(mask && !masked\) return null/)
  // performAction must report it rather than looking like a dead button, and must NOT retry without
  // the mask.
  const perform = sliceBetween(script, 'async function performAction(action)', 'function showResult(')
  assert.match(perform, /if\(!output\)\{/)
  assert.match(perform, /capture\.ocr\.mask-unavailable/)
  assert.doesNotMatch(perform, /exportSelectionCanvasForAction\(!pixelOnlyActions,\s*exportRect,\s*\{\s*compose: composedActions\s*\}\)/)
})

test('R0.4 the "is there anything to protect" probe is structural and errs towards protecting', () => {
  const probe = sliceBetween(script, 'function hasOccludableBlur(rect)', 'function exportSelectionCanvas(includeAnnotations')
  // A failure to even enumerate the annotations counts as "there may be secrets".
  assert.match(probe, /catch \(error\) \{\s*\n\s*return true/)
  assert.match(probe, /if \(!Array\.isArray\(annotationsList\)\) return true/)
  assert.match(probe, /annotationsList\.some\(\(item\) => item\?\.type === 'blur'\)/)
})

test('R0.4 the mask module is the shared one, consumed through its UMD global', () => {
  // The renderer must not re-implement the occluder geometry: that is the privacy boundary and it
  // has exactly one implementation (shared/occlusion-mask.js), used by the sampler and the
  // recognition path alike.
  assert.match(script, /window\.occlusionMask/)
  const apply = sliceBetween(script, 'function applyRecognitionOcclusion(', 'function exportSelectionCanvas(includeAnnotations')
  assert.match(apply, /const mask = window\.occlusionMask/)
  assert.match(apply, /mask\.buildOccluders\(/)
  assert.match(apply, /mask\.planOcclusion\(/)
  assert.doesNotMatch(script, /function buildOccluders\(/, 'the renderer must not define its own occluder builder')
  // capture.html loads it before the controller (the module is consumed at call time, but a missing
  // <script> would make every recognition call silently return unmasked pixels).
  const html = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')
  assert.ok(html.indexOf('../shared/occlusion-mask.js') > 0)
  assert.ok(html.indexOf('../shared/occlusion-mask.js') < html.indexOf('src="capture.js"'))
})
