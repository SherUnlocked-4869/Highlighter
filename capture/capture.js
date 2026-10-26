const backgroundCanvas = document.getElementById('backgroundStage')
const backgroundCtx = backgroundCanvas.getContext('2d')
const canvas = document.getElementById('stage')
const ctx = canvas.getContext('2d')
const toolbar = document.getElementById('toolbar')
const toolOptions = document.getElementById('toolOptions')
const elementBar = document.getElementById('elementBar')
// P0-5 PR4：层级 ↑↓ 两个按钮（#elementBar 内，加在删除与取消选中之间 —— 工具栏不塞按钮）。
const elementFront = document.getElementById('elementFront')
const elementBack = document.getElementById('elementBack')
// B6 (D8): the multi-selection counter on #elementBar.
const elementCount = document.getElementById('elementCount')
const sizeBadge = document.getElementById('sizeBadge')
// Feature B (plan §5.3/B3): the region size / preset popover and its toggle.
const regionPanel = document.getElementById('regionPanel')
const regionToggle = document.getElementById('regionToggle')
const regionWidthInput = document.getElementById('regionWidth')
const regionHeightInput = document.getElementById('regionHeight')
const regionApplySize = document.getElementById('regionApplySize')
const regionReuseLast = document.getElementById('regionReuseLast')
const regionSavePreset = document.getElementById('regionSavePreset')
const regionPresets = document.getElementById('regionPresets')
const regionDeletePreset = document.getElementById('regionDeletePreset')
// Feature D3: the magnifier attribute panel. One delegated listener per control kind, mirroring the
// declaration in capture.html; the panel shows while the tool is active or a magnifier is selected.
const magnifierPanel = document.getElementById('magnifierPanel')
const magnifierStatusEl = document.getElementById('magnifierStatus')
const magnifierStrokeWidthInput = document.getElementById('magnifierStrokeWidth')
const magnifierStrokeWidthValue = document.getElementById('magnifierStrokeWidthValue')
const magnifierFactorButtons = Array.from(document.querySelectorAll('[data-magnifier-factor]'))
const magnifierConnectorButtons = Array.from(document.querySelectorAll('[data-magnifier-connector]'))
const regionStatus = document.getElementById('regionStatus')
// Feature C (plan §6.1/§6.3): the finished-look panel and its strip toggle. Both are static
// markup, so a missing element here is a build error rather than a state to defend against.
const outputStylePanelRoot = document.getElementById('outputStylePanel')
const outputStylePreviewCanvas = document.getElementById('outputStylePreview')
const outputStyleStatusEl = document.getElementById('outputStyleStatus')
// Feature B: the ratio lock group. The active lock lives in a module variable rather than on a
// <select>, because capture.html deliberately carries no native <option> elements.
let regionRatioValue = 'free'
const regionRatioButtons = Array.from(document.querySelectorAll('[data-region-ratio]'))
const tip = document.getElementById('tip')
const loading = document.getElementById('loading')
const loadingText = loading.querySelector('b')
const shutterSound = document.getElementById('shutterSound')
let shutterSoundPlayed = false
const colorInput = document.getElementById('color')
const colorPreview = document.getElementById('colorSwatch')
const colorButton = document.getElementById('colorButton')
const colorPalette = document.getElementById('colorPalette')
// P1 (2026-10-18 snow migration section 6.2 item 2): the image-to-Markdown/HTML trigger and its
// two-format popover. Both are static markup, so a missing element here is a build
// error rather than a state to defend against.
const convertDocButton = document.getElementById('convertDoc')
const convertDocMenu = document.getElementById('convertDocMenu')
const recentColorList = document.getElementById('recentColors')
const lineWidthGroup = document.getElementById('widthGroup')
const watermarkPanel = document.getElementById('watermarkPanel')
const watermarkContentInput = document.getElementById('watermarkContent')
const watermarkOpacityInput = document.getElementById('watermarkOpacity')
const watermarkOpacityValue = document.getElementById('watermarkOpacityValue')
const watermarkColorInput = document.getElementById('watermarkColor')
const watermarkSpacingInput = document.getElementById('watermarkSpacing')
const watermarkSpacingValue = document.getElementById('watermarkSpacingValue')
const watermarkFontSizeInput = document.getElementById('watermarkFontSize')
const watermarkRotationInput = document.getElementById('watermarkRotation')
const watermarkDateSuffixInput = document.getElementById('watermarkDateSuffix')
const watermarkApplyButton = document.getElementById('watermarkApply')
const resultPanel = document.getElementById('resultPanel')
const resultTitle = document.getElementById('resultTitle')
const resultSource = document.getElementById('resultSource')
const resultText = document.getElementById('resultText')
const ocrOverlay = document.getElementById('ocrOverlay')
const ocrResultBar = document.getElementById('ocrResultBar')
const ocrSummary = document.getElementById('ocrSummary')
const ocrToggleSource = document.getElementById('ocrToggleSource')
const ocrPlainText = document.getElementById('ocrPlainText')
const ocrCopyAll = document.getElementById('ocrCopyAll')
const {
  getResizeHandle,
  getSourcePixelRect,
  resizeSelection,
  selectionCursor,
  resolveFloatingPlacement,
  toolbarWidthLimit,
  revalidateSelection,
  commonSelectionValue,
  rectsIntersect
} = window.selectionUtils
const {
  PRESET_COLORS,
  DEFAULT_COLOR: DEFAULT_ANNOTATION_COLOR,
  FILL_ALPHA,
  TOOL_OPTION_FIELDS,
  TOOL_STYLE_TOOLS,
  resolveWidth: resolveAnnotationWidth,
  normalizeAnnotationColor,
  nextWidthPreset,
  resolveFill,
  resolveDash,
  resolveRadius,
  resolveAlpha,
  dashPattern,
  resolveToolOptions,
  resolveToolStyle,
  resolveToolStyles,
  textFontSize,
  serialRadius,
  highlightWidth,
  blurBrushWidth,
  MOSAIC_CELL
} = window.annotationStyleUtils
// P0-5 PR1：命中测试/选中框/快照深拷贝都走纯函数模块（屏幕 CSS 坐标，方案 §8.3）。
// PR2 追加 translateAnnotation（生成位移副本）与 clampAnnotationToStage（边界 clamp）。
// PR3 追加 resizeAnnotationToBox（把标注按新 box 缩放的纯函数，永远返回新对象）。
// PR4 追加 reorderAnnotation（层级 ↑↓ 的纯函数：数组顺序即 z 序，永远返回新数组）。
// 注意：新条目一律插在最前/最后，不要打断下面这条既有的相对顺序断言
// （test/capture-annotation-geometry.test.js 里 resizeAnnotationToBox → … → MAX_PEN_POINTS 的链条）。
const {
  movedBeyondThreshold,
  penContinuationTarget,
  MOVE_THRESHOLD,
  reorderAnnotation,
  resizeAnnotationToBox,
  annotationBounds,
  findAnnotationAt,
  translateAnnotation,
  clampAnnotationToStage,
  cloneAnnotations,
  MAX_ANNOTATION_HISTORY,
  MAX_PEN_POINTS
} = window.annotationGeometry
// Brush plan (§3.1/§4): the freehand-stroke primitives. A separate destructure on purpose -
// the block above is pinned verbatim (and its item order, MAX_PEN_POINTS last) by the
// geometry contract tests, so new names must not be inserted into it.
const { STROKE_TYPES, hasStrokePoints, strokeWidth, strokeBox } = window.annotationGeometry

let initData = null
let image = null
// Batch 1 (docs/plans/2026-10-25-history-reedit-batch0-contracts.md §4/§7): when this window
// was opened with `documentEditor`, it is editing a *document*, not taking a new screenshot.
// Commit eligibility, dirty tracking and the close negotiation all hang off this being non-null.
//   { sessionId, documentId, revisionId, version, legacy, storageFormat, degraded,
//     document, crop, infoHeight, cleanFingerprint, dirty, saving, requestSeq }
let documentEditor = null
let selection = null
let selecting = false
let dragging = false
let resizing = null
let startPoint = null
let currentTool = 'select'
let activeAnnotation = null
let annotations = []
// P0-5 PR1：历史从"数组即栈（pop 末尾）"升级为**深拷贝快照栈**——编辑已有元素（位置/样式/层级）
// 无法用 pop 表达，且 pen 的点集必须深拷贝，否则撤销后仍然指向同一个数组（方案 §8.2）。
// annotationHistory[historyIndex] 始终等于"当前已提交状态"；redo 不再是独立数组，
// 而是 historyIndex 之后仍然保留的那一段快照。
let annotationHistory = [[]]
let historyIndex = 0
// 单调递增 id：选中/快照/撤销都按 id 重解析对象（快照还原会换掉对象身份）。
let annotationSeq = 0
let selectedAnnotation = null
// B6 (D8): the authoritative multi-selection. selectedAnnotation stays the primary
// (anchor) item, so every single-selection path that shipped before keeps reading
// selectedAnnotationItem() unchanged; this set is what tells the multi-aware paths
// (echo, style edit, delete, nudge, element bar) how many items are really selected.
let selectedIds = new Set()
// B6 wave 2 (D8): the shift+drag marquee. start/current are screen CSS points; the
// rectangle is derived, so the gesture never accumulates drift.
let marquee = null
// P0-5 PR2 + A1 (D2): the element drag state. origin is always the UNTOUCHED
// original object and every frame re-translates from it, so clamping cannot
// accumulate drift and pointerup can tell "did it actually move". thresholdPassed
// is A1's addition: a press below MOVE_THRESHOLD stays a plain click.
let pendingMove = null
// P0-5 PR3：8 手柄缩放交互态，与 pendingMove 同构（origin/originBounds 也是**未被改动的**
// 原对象与其屏幕 CSS 坐标 bbox，每帧从它重算，绝不就地改）。
let resizingAnnotation = null
// PR3：选中元素手柄的命中半径（比选区手柄默认的 8px 更紧 —— 元素普遍更小，太宽会整块吃掉
// "元素体内拖动"）；绘制时手柄落在选中虚线框上，与 SELECTED_OUTLINE_PAD 同源。
const ELEMENT_HANDLE_HIT = 6
const SELECTED_OUTLINE_PAD = 5
// 方向键微调：连续按键合并为一次可撤销操作，静默 NUDGE_COMMIT_DELAY 毫秒后才压一帧快照。
let nudgeTimer = 0
let nudgeDirty = false
const NUDGE_STEP = 1
const NUDGE_STEP_FAST = 10
const NUDGE_COMMIT_DELAY = 500
// P0-5 PR4：样式（颜色）作用于选中项的合帧计时器 —— 系统取色器拖动时会连发 input，与方向键
// 微调同构：应用即时可见，快照静默 STYLE_COMMIT_DELAY 毫秒后才收口（change 也会立刻收口）。
let styleTimer = 0
let styleDirty = false
const STYLE_COMMIT_DELAY = 300
let elementBarSize = null
let serialNumber = 1
let initialSerialNumber = 1
let annotationWidth = 4
// A3 (D3): the persisted default colour that new annotations use. colorInput is
// only its UI mirror - A4's selection echo may repaint the toolbar without
// touching this value, so the next stroke must not inherit a selected item's colour.
let annotationColor = DEFAULT_ANNOTATION_COLOR
// A3: the last few custom colours, window-session only (never persisted, so the
// settings schema does not grow another list).
const MAX_RECENT_COLORS = 3
let recentAnnotationColors = []
// A2: one wheel burst must not write the store per notch, so persistence trails.
let widthPersistTimer = 0
const WIDTH_PERSIST_DELAY = 500
// A2: the tools whose stroke width is meaningful (all but select/watermark).
// Brush plan (D2-B'): blur joined - the mosaic brush is a real width-bearing tool now, and
// its width is remembered (TOOL_STYLE_TOOLS), so the wheel step survives the gesture.
const WIDTH_TOOLS = new Set(['rect', 'ellipse', 'arrow', 'line', 'pen', 'highlight', 'text', 'serial', 'blur'])
// Brush plan (§3.3): the tools drawn as a freehand polyline. Everything below hangs off
// this set plus "the item really carries points", so a legacy two-endpoint object keeps
// rendering exactly what it rendered before.
const STROKE_TOOL_SET = new Set(STROKE_TYPES)
// Brush plan (§3.3, D5): the minimum distance between two sampled points, in CSS px. A
// duplicate/jitter point buys nothing visually and only burns the MAX_PEN_POINTS budget.
const STROKE_MIN_STEP = 1.5
// B2-B5 (D9) + B4 (D7): the remembered style per tool, keyed by tool and holding only
// the fields that tool owns. B4 persists it into screenshot.annotationStyles; every
// lookup goes through resolveToolStyle, so a hand-edited store or a partially written
// block still degrades to the shipped defaults.
let toolStyles = {}
// B7 (D11): the pen being continued. The original is lifted out of the layer list for
// the duration of the gesture, so an interrupted one has to be put back.
let continuedPen = null
const PEN_CONTINUATION_DISTANCE = 12
let dpr = window.devicePixelRatio || 1
let autoActionStarted = false
let renderReadySent = false
let renderReadyPending = false
let renderReadyTimer = 0
let renderReadyFrame = 0
const FIRST_PAINT_MAX_WAIT_MS = 80
let selectState = 'manual'
let pointerDownPoint = null
let smartCandidates = []
let smartCandidateLevel = 0
let smartQueryRunning = false
let smartQueryPending = null
let activeOcrResult = null
let processingAction = null
let renderRequest = 0
let toolbarSize = null
let imageObjectUrl = ''
// P0-2（S9b）：预解码的光标位图。exportSelectionCanvas 是同步函数，不能在里面等解码，
// 所以在 onInit 里建好；没带光标（开关关闭）时恒为 null。
let cursorImage = null
let pdfExporting = false
// section 6.2 item 2: the format chosen from the image-to-document popover. Module state (not a
// parameter) because the shared `performAction('convert')` path encodes the image
// and only then asks for the format - keeping the two decisions in one place.
let convertOutputFormat = 'markdown'
// Mosaic patch cache (§5.2). One offscreen canvas per committed stroke, keyed by a
// fingerprint of every input the patch depends on - NOT by object identity: translate,
// resize and style edits all return brand-new objects, so an identity cache would happily
// keep a patch of the old position. WeakMap so a dropped annotation takes its patch with
// it. Active strokes are never cached (they change every frame).
// Reassignable rather than const because WeakMap has no clear(): invalidating means
// dropping the whole map, which is exactly what a new capture / undo / stage resize wants.
let mosaicPatchCache = new WeakMap()
// Total bytes the cache may hold (§5.2): past this the strokes render uncached, which is
// slower but always correct.
const MOSAIC_PATCH_BUDGET = 16 * 1024 * 1024
let mosaicPatchBytes = 0

// P0-7-T5：主进程确认窗口已显示后播一次快门音，受 screenshot.shutterSound 控制。
// play() 在 CSP 拦截 / 自动播放被拒时会 reject，这里必须吞掉，否则渲染层报未处理拒绝。
function playShutterSound() {
  if(!shutterSound)return
  try{
    shutterSound.currentTime=0
    const played=shutterSound.play()
    if(played?.catch)played.catch(()=>{})
  }catch{}
}

// P0-7-T7：每次截图都是新窗口，序号必须在初始化路径里显式重置；
// screenshot.keepSerialAcrossCaptures 打开时由主进程下发接续值。
function resetSerialNumber(data) {
  const start=Math.round(Number(data?.serialNumber))
  serialNumber=Number.isFinite(start)&&start>0?start:1
  initialSerialNumber=serialNumber
}

// P0-7-T7 精确接续（2026-10-10 真机验收修正）：落过序号就把"下一个该用的号"回报给主进程
// （沿用 capture:save / capture:pin 等既有通道的 meta 字段，不新增通道）；没落过就不回报，
// 避免空截图白白吃掉号段。必须在导出/编码之后取值 —— 否则拿到的是上一次的旧计数。
function serialMeta() {
  return serialNumber>initialSerialNumber?{serialNumber}:{}
}

// 关窗（✕ / Esc）同样要回报已落过的序号，否则"落过就推进"会在取消路径上失效。
// Batch 1: a document-editor window negotiates before closing (contracts §7.3). Every exit
// path funnels through requestCloseDocumentEditor() so "✕", Esc, and the native close all
// behave the same; a plain capture window keeps the shipped behaviour byte for byte.
function closeCaptureWindow() {
  if (documentEditor) { requestCloseDocumentEditor(); return }
  cancelRenderReady()
  window.captureAPI.close(serialNumber>initialSerialNumber?serialNumber:0)
}

function pointFromEvent(event) { return { x: event.clientX, y: event.clientY } }
function normalizeRect(a, b) { return { x: Math.min(a.x,b.x), y: Math.min(a.y,b.y), w: Math.abs(b.x-a.x), h: Math.abs(b.y-a.y) } }
function insideSelection(point) { return selection && point.x >= selection.x && point.x <= selection.x + selection.w && point.y >= selection.y && point.y <= selection.y + selection.h }
// A4 (D4) + B2-B5 (D9) + B4 (D7): new annotations read the current tool's remembered
// style - never the toolbar mirror, which the echo repaints for a selected item
// without hijacking what the next stroke will look like.
function annotationStyle() {
  return resolveToolStyle(currentTool, toolStyles[currentTool])
}
function imageDisplayBounds() {
  const bounds=initData?.imageBounds
  return bounds
    ? {x:Number(bounds.x)||0,y:Number(bounds.y)||0,w:Math.max(1,Number(bounds.width)||1),h:Math.max(1,Number(bounds.height)||1)}
    : {x:0,y:0,w:innerWidth,h:innerHeight}
}

// §3.2② (Snow a7673a353): Ctrl+A level 2. The capture window covers ONE display, so the
// union of every display can only be expressed as a selection that reaches past the
// stage. The main process ships the union as DIP `desktopBounds`; the stage's origin is
// `captureBounds`, so subtracting it is the whole coordinate conversion (both values are
// DIP, the same space innerWidth/innerHeight live in). Two guards keep the second level
// out of editors whose "display" is not a screen: the pin re-annotate flow ships
// imageBounds (a scaled image, not desktop pixels) and the blank canvas is not desktop
// content. The scope is deliberately "bounds only": nothing here promises that a
// non-active display's pixels are capturable, and the export path keeps clamping the
// selection to the captured image (getSourcePixelRect), exactly the boundary the plan
// locked down to keep this a P1 instead of a cross-display-canvas project.
function desktopSelectionBounds() {
  if (initData?.imageBounds) return null
  if (['image', 'canvas'].includes(initData?.mode)) return null
  const desktop = initData?.desktopBounds
  if (!desktop) return null
  const width = Number(desktop.width)
  const height = Number(desktop.height)
  if (!(width > 0) || !(height > 0)) return null
  const origin = initData?.captureBounds || initData?.displayBounds || { x: 0, y: 0 }
  return {
    x: (Number(desktop.x) || 0) - (Number(origin.x) || 0),
    y: (Number(desktop.y) || 0) - (Number(origin.y) || 0),
    w: width,
    h: height
  }
}

// Integer DIP rects never agree exactly when a user hand-dragged a selection to the
// screen edge, and the capture handshake itself allows a 2px size drift
// (captureImageReady). The same tolerance decides "the selection covers this rectangle".
const CTRL_A_COVER_TOLERANCE = 2

function rectsNearlyEqual(a, b, tolerance = CTRL_A_COVER_TOLERANCE) {
  if (!a || !b) return false
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.w - b.w) <= tolerance && Math.abs(a.h - b.h) <= tolerance
}

// Should this Ctrl+A press be the SECOND level? It is when the selection already covers
// the whole current display image AND the desktop union is genuinely larger (on a single
// display the union equals the image, so the level collapses back to the shipped
// behaviour with zero user-visible difference). The all-displays rectangle itself maps
// back to the current display, so repeated presses make a two-way choice instead of
// sticking at level 2 - the same "current screen OR all screens" pair Snow's
// expandToAllScreens flag chooses between.
function ctrlASelectionExpandsToDesktop() {
  // The shipped key clears an active OCR result AND selects the display in one press;
  // that press must keep exactly that meaning. Expanding on the same press would move a
  // selection the user cannot see yet (the OCR overlay is on top of it), so the clear
  // press stays level 1 and the next press can expand. Same for the pin re-annotate
  // editor, which has no desktop at all (guard inside desktopSelectionBounds).
  if (activeOcrResult) return false
  if (!selection) return false
  const desktop = desktopSelectionBounds()
  if (!desktop) return false
  const display = imageDisplayBounds()
  if (rectsNearlyEqual(desktop, display)) return false
  if (rectsNearlyEqual(selection, desktop)) return false
  return rectsNearlyEqual(selection, display)
}

// §3.2②: the pixel consumers (copy/save/pdf/ocr) all read one captured image, which
// still covers only the current display. A level-2 Ctrl+A selection reaches past it, so
// the export intersects the two: the crop already clamps through getSourcePixelRect, and
// this makes the ANNOTATION space use the same clamped rectangle - otherwise every
// annotation would be drawn at the union scale (half size on a 3840-wide union) and
// shifted by a negative origin, i.e. a corrupt copy instead of a simply narrower one.
// Returns null when nothing of the selection is inside the image (nothing to export).
// For any selection that already sits inside the image this returns the same numbers, so
// every shipped flow keeps byte-identical output.
function selectionInsideImage(rect, bounds) {
  if (!rect || !bounds) return null
  const left = Math.max(rect.x, bounds.x)
  const top = Math.max(rect.y, bounds.y)
  const right = Math.min(rect.x + rect.w, bounds.x + bounds.w)
  const bottom = Math.min(rect.y + rect.h, bounds.y + bounds.h)
  if (right - left < 1 || bottom - top < 1) return null
  return { x: left, y: top, w: right - left, h: bottom - top }
}

function usesNativeBackgroundPixels() {
  return !!(
    image?.naturalWidth &&
    image?.naturalHeight &&
    initData?.mode !== 'canvas' &&
    !initData?.imageBounds
  )
}

function updateSelectionCursor(point) {
  if (currentTool !== 'select') {
    canvas.style.cursor = 'crosshair'
    return
  }
  // 优先级与 pointerdown 一致：选区手柄 > 选中元素手柄 > 元素体内(move)/新建(crosshair)。
  const handle = resizing?.handle || getResizeHandle(selection, point) || resizingAnnotation?.handle || selectedResizeHandle(point)
  canvas.style.cursor = selectionCursor(handle, insideSelection(point))
}

function resizeCanvas() {
  dpr = window.devicePixelRatio || 1
  const nativeBackground=usesNativeBackgroundPixels()
  backgroundCanvas.width=nativeBackground?image.naturalWidth:Math.round(innerWidth*dpr)
  backgroundCanvas.height=nativeBackground?image.naturalHeight:Math.round(innerHeight*dpr)
  backgroundCanvas.style.width=`${innerWidth}px`
  backgroundCanvas.style.height=`${innerHeight}px`
  backgroundCanvas.classList.toggle('native-pixels',nativeBackground)
  canvas.width=Math.round(innerWidth*dpr)
  canvas.height=Math.round(innerHeight*dpr)
  canvas.style.width=`${innerWidth}px`
  canvas.style.height=`${innerHeight}px`
  invalidateToolbarSize()
  // B6 (D8): the element bar's cached rect has the same single invalidation point now,
  // so a counter change and a resize can never disagree about the bar's size.
  invalidateElementBarSize()
  if (image && initData && ['fullscreen', 'image', 'canvas'].includes(initData.mode)) {
    selection = imageDisplayBounds()
  }
  drawBackground()
  // Brush plan (§5.2): a stage or DPR change invalidates every cached mosaic patch (the
  // device-pixel scale they were built with no longer holds).
  invalidateMosaicPatches()
  render()
  maybeRunAutoAction()
  reportRenderReady()
}

function drawBackground() {
  const nativeBackground=usesNativeBackgroundPixels()
  backgroundCtx.setTransform(nativeBackground?1:dpr,0,0,nativeBackground?1:dpr,0,0)
  backgroundCtx.clearRect(0,0,nativeBackground?backgroundCanvas.width:innerWidth,nativeBackground?backgroundCanvas.height:innerHeight)
  if (image) {
    if(nativeBackground){backgroundCtx.imageSmoothingEnabled=false;backgroundCtx.drawImage(image,0,0)}
    else if (documentEditor) {
      // Batch 1: a document editor loads the WHOLE base image but the window only reserves an
      // area for the CROP - so the shipped `drawImage(image, bounds)` would squash the entire
      // screenshot into the crop box while annotations are mapped crop->box, i.e. a visibly
      // wrong backdrop that also disagrees with the exported result. Draw the crop region of
      // the base image into the image area instead, which is exactly the export mapping
      // (contracts §2.1: outX = sourceX - crop.x, then scaled by the viewport).
      const bounds=imageDisplayBounds()
      const crop=documentCrop()
      const view=documentViewport()
      const zoom=view?view.zoom:1
      backgroundCtx.imageSmoothingEnabled=zoom!==1
      backgroundCtx.drawImage(
        image,
        crop.x, crop.y, crop.w, crop.h,
        bounds.x, bounds.y, crop.w*zoom, crop.h*zoom
      )
    }
    else{const bounds=imageDisplayBounds();backgroundCtx.drawImage(image,bounds.x,bounds.y,bounds.w,bounds.h)}
  }
}

function captureImageReady() {
  if (!image?.complete || !image.naturalWidth || !initData) return false
  const expected = initData.captureBounds || initData.displayBounds
  return !expected || (Math.abs(innerWidth - expected.width) <= 2 && Math.abs(innerHeight - expected.height) <= 2)
}

function cancelRenderReady() {
  clearTimeout(renderReadyTimer)
  cancelAnimationFrame(renderReadyFrame)
  renderReadyTimer = 0
  renderReadyFrame = 0
  renderReadyPending = false
}

function reportRenderReady() {
  if (renderReadySent || renderReadyPending || !captureImageReady()) return
  renderReadyPending = true
  const pendingImage = image
  const finish = () => {
    cancelRenderReady()
    if (renderReadySent || image !== pendingImage || !captureImageReady()) return
    // Hidden Windows compositors can deliver rAF only once a second even with
    // backgroundThrottling disabled. Paint the mask before releasing the window
    // so the timeout path cannot reveal an unpainted overlay.
    if (renderRequest) {
      cancelAnimationFrame(renderRequest)
      renderRequest = 0
    }
    renderOverlay()
    renderReadySent = true
    window.captureAPI.renderReady()
  }
  renderReadyTimer = setTimeout(finish, FIRST_PAINT_MAX_WAIT_MS)
  renderReadyFrame = requestAnimationFrame(() => {
    renderReadyFrame = requestAnimationFrame(finish)
  })
}

function maybeRunAutoAction() {
  if (!image || !selection || !initData?.autoAction || autoActionStarted) return
  if (['fullscreen', 'image', 'canvas'].includes(initData.mode)) {
    const expected = initData.captureBounds || initData.displayBounds
    if (expected && (Math.abs(innerWidth - expected.width) > 2 || Math.abs(innerHeight - expected.height) > 2)) return
    autoActionStarted = true
    setTimeout(() => performAction(initData.autoAction), 120)
  }
}

// B3 (D9): the shaft is stroked first, then each requested head is filled at its own
// endpoint. The default (startHead false, endHead true) draws exactly what shipped:
// one head at the tip, after the stroke.
function drawArrow(context, x1, y1, x2, y2, width, startHead = false, endHead = true) {
  const angle = Math.atan2(y2-y1,x2-x1)
  const head = Math.max(10,width*3)
  context.beginPath(); context.moveTo(x1,y1); context.lineTo(x2,y2); context.stroke()
  if (startHead) { context.beginPath(); context.moveTo(x1,y1); context.lineTo(x1-head*Math.cos(angle-Math.PI/6),y1-head*Math.sin(angle-Math.PI/6)); context.lineTo(x1-head*Math.cos(angle+Math.PI/6),y1-head*Math.sin(angle+Math.PI/6)); context.closePath(); context.fill() }
  if (endHead) { context.beginPath(); context.moveTo(x2,y2); context.lineTo(x2-head*Math.cos(angle-Math.PI/6),y2-head*Math.sin(angle-Math.PI/6)); context.lineTo(x2-head*Math.cos(angle+Math.PI/6),y2-head*Math.sin(angle+Math.PI/6)); context.closePath(); context.fill() }
}

function formatWatermarkDateSuffix(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function resolveWatermarkText(content, dateSuffix) {
  const base = typeof content === 'string' ? content : ''
  if (!dateSuffix) return base
  return `${base}${formatWatermarkDateSuffix()}`
}

function drawWatermark(context, item, scaleX, scaleY, offsetX, offsetY) {
  const w = item.w * scaleX, h = item.h * scaleY
  const text = resolveWatermarkText(item.content, item.dateSuffix)
  if (!(w > 1) || !(h > 1) || !text) return
  const x = (item.x - offsetX) * scaleX, y = (item.y - offsetY) * scaleY
  const fontSize = Math.max(8, item.fontSize * Math.max(scaleX, scaleY))
  const stepX = Math.max(fontSize * 2, w * (item.spacing / 100))
  const stepY = Math.max(fontSize * 2, h * (item.spacing / 100))
  context.save()
  context.beginPath(); context.rect(x, y, w, h); context.clip()
  context.translate(x + w / 2, y + h / 2)
  context.rotate((item.rotation || 0) * Math.PI / 180)
  context.globalAlpha = Math.min(1, Math.max(0.02, (item.opacity ?? 100) / 100))
  context.fillStyle = item.color
  context.font = `${fontSize}px -apple-system,"Microsoft YaHei",sans-serif`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  const reach = Math.hypot(w, h) / 2
  for (let row = -reach; row <= reach; row += stepY) {
    for (let col = -reach; col <= reach; col += stepX) {
      context.fillText(text, col, row)
    }
  }
  context.restore()
}

// ---------- Brush plan (docs/plans/2026-10-19-brush-highlight-mosaic-interaction-design.md) ----------

// The polyline path every freehand stroke shares: round caps and joins, one moveTo then
// lineTo per sample. `points` are already in the target coordinate space.
// A single point traces a 0.01px segment on purpose - a zero-length subpath is not stroked
// at all (§7.3), so without this a tap would paint nothing. record/annotation-utils.js:150
// carries the same patch, and the pen branch below uses this helper too (D6).
function traceStroke(context, points, lineWidth) {
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.lineWidth = lineWidth
  context.beginPath()
  if (!points.length) return false
  if (points.length === 1) {
    context.moveTo(points[0].x, points[0].y)
    context.lineTo(points[0].x + 0.01, points[0].y)
    return true
  }
  points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y))
  return true
}

// Maps a stored point set (screen CSS px) into the drawing space of `context`, which is
// whatever scaleX/scaleY/offset the caller applies - screen path 1:1, export path times
// the export factor minus the selection origin.
function offsetPoints(points, scaleX, scaleY, offsetX, offsetY) {
  return points.map((point) => ({ x: (point.x - offsetX) * scaleX, y: (point.y - offsetY) * scaleY }))
}

// §5.6: target pixels per CSS px is the ONLY bridge between the three coordinate spaces.
// On screen the stage context carries a devicePixelRatio transform and the callers pass
// 1/1; on export the context is untransformed and the callers pass the export factor. So
// the honest answer is "the factor the caller passed" times "what the context already
// applies" - never a guess about which path this is. `widthScale` is the caller's factor.
function contextPixelScale(context) {
  let matrix = null
  try { matrix = typeof context.getTransform === 'function' ? context.getTransform() : null } catch {}
  if (!matrix) return 1
  const scale = Math.max(Math.abs(Number(matrix.a) || 0), Math.abs(Number(matrix.d) || 0))
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}

function mosaicPatchKey(item, deviceScale) {
  const box = strokeBox(item)
  const points = item.points
  const first = points[0]
  const last = points[points.length - 1]
  return [item.width, deviceScale, box.x, box.y, box.w, box.h, points.length, first.x, first.y, last.x, last.y].join('|')
}

// Drops every cached patch. Called from the invalidation points §5.2 lists (new capture,
// undo/redo replacing the array, style/geometry writes, stage resize). The fingerprint
// already covers content changes; this covers the canvases whose owner is gone.
function invalidateMosaicPatches() {
  mosaicPatchCache = new WeakMap()
  mosaicPatchBytes = 0
}
// §3.2.2: the mosaic stroke = a pixelated layer of the *source image* masked by the
// stroke's alpha. Three coordinate spaces meet here and must not be mixed (§5.6):
//   · annotation points/bbox and MOSAIC_CELL are CSS px;
//   · sourceImage is device px (naturalWidth/Height);
//   · the offscreen patch canvas is device px too (its .width/.height always are).
// `deviceScale` = device px per CSS px (devicePixelRatio on screen, the export factor on
// export; see contextPixelScale). The final drawImage back onto the target stays in CSS
// px, because the caller's context already carries the rest of the transform.
function buildMosaicPatch(item, deviceScale, sourceImage) {
  const cell = MOSAIC_CELL * deviceScale
  const brush = blurBrushWidth(item.width) * deviceScale
  const pad = brush / 2 + 2
  const box = strokeBox(item)
  // Snap the grid phase to the canvas origin, never to this stroke's own box: two
  // neighbouring strokes would otherwise interleave two different phases and show
  // "brick seams" where they overlap (§3.2.2, §7.2).
  const left = Math.floor((box.x - pad) / MOSAIC_CELL) * MOSAIC_CELL
  const top = Math.floor((box.y - pad) / MOSAIC_CELL) * MOSAIC_CELL
  const cssW = Math.ceil((box.x + box.w + pad - left) / MOSAIC_CELL) * MOSAIC_CELL
  const cssH = Math.ceil((box.y + box.h + pad - top) / MOSAIC_CELL) * MOSAIC_CELL
  if (!(cssW > 1) || !(cssH > 1)) return null
  const devW = Math.max(1, Math.round(cssW * deviceScale))
  const devH = Math.max(1, Math.round(cssH * deviceScale))
  const tinyW = Math.max(1, Math.round(devW / cell))
  const tinyH = Math.max(1, Math.round(devH / cell))

  const bounds = imageDisplayBounds()
  const sourceScaleX = (sourceImage.naturalWidth || 1) / Math.max(1, bounds.w)
  const sourceScaleY = (sourceImage.naturalHeight || 1) / Math.max(1, bounds.h)

  const tiny = document.createElement('canvas')
  tiny.width = tinyW; tiny.height = tinyH
  const tinyCtx = tiny.getContext('2d')
  tinyCtx.imageSmoothingEnabled = true
  tinyCtx.drawImage(
    sourceImage,
    (left - bounds.x) * sourceScaleX, (top - bounds.y) * sourceScaleY, cssW * sourceScaleX, cssH * sourceScaleY,
    0, 0, tinyW, tinyH
  )

  const patch = document.createElement('canvas')
  patch.width = devW; patch.height = devH
  const patchCtx = patch.getContext('2d')
  patchCtx.imageSmoothingEnabled = false
  patchCtx.drawImage(tiny, 0, 0, tinyW, tinyH, 0, 0, devW, devH)
  patchCtx.imageSmoothingEnabled = true
  // Intersect with the stroke: everything outside the brush must keep the source pixels.
  patchCtx.globalCompositeOperation = 'destination-in'
  patchCtx.strokeStyle = '#000'
  traceStroke(
    patchCtx,
    item.points.map((point) => ({ x: (point.x - left) * deviceScale, y: (point.y - top) * deviceScale })),
    brush
  )
  patchCtx.stroke()
  patchCtx.globalCompositeOperation = 'source-over'
  return { canvas: patch, left, top, w: cssW, h: cssH }
}

function drawMosaicStroke(context, item, scaleX, scaleY, offsetX, offsetY, sourceImage) {
  const deviceScale = Math.max(scaleX, scaleY) * contextPixelScale(context)
  const key = mosaicPatchKey(item, deviceScale)
  const cached = mosaicPatchCache.get(item)
  let patch = cached && cached.key === key ? cached.patch : null
  if (!patch) {
    patch = buildMosaicPatch(item, deviceScale, sourceImage)
    if (!patch) return
    // Committed annotations (they carry an id) are cached; the stroke being drawn right now
    // is deliberately rebuilt every frame (§5.2), so a live gesture never pays the
    // fingerprint bookkeeping and never pins a stale canvas.
    const bytes = patch.canvas.width * patch.canvas.height * 4
    if (item.id && bytes <= MOSAIC_PATCH_BUDGET) {
      if (cached) mosaicPatchBytes -= cached.patch.canvas.width * cached.patch.canvas.height * 4
      if (mosaicPatchBytes + bytes <= MOSAIC_PATCH_BUDGET) {
        mosaicPatchCache.set(item, { key, patch })
        mosaicPatchBytes += bytes
      }
    }
  }
  // Destination stays in the caller's units: transform by the same scale/offset the item's
  // own x/y got, so the patch lands exactly where the stroke is.
  context.drawImage(patch.canvas, (patch.left - offsetX) * scaleX, (patch.top - offsetY) * scaleY, patch.w * scaleX, patch.h * scaleY)
}

function drawAnnotation(context, item, scaleX = 1, scaleY = 1, offsetX = 0, offsetY = 0, sourceImage = image) {
  const x = (item.x-offsetX)*scaleX, y = (item.y-offsetY)*scaleY
  const x2 = ((item.x2 ?? item.x)-offsetX)*scaleX, y2 = ((item.y2 ?? item.y)-offsetY)*scaleY
  const widthScale = Math.max(scaleX,scaleY)
  const baseWidth = item.width
  const width = baseWidth * widthScale
  context.save(); context.strokeStyle = item.color; context.fillStyle = item.color; context.lineWidth = width; context.lineCap = 'round'; context.lineJoin = 'round'
  // B2/B3 (D9): dashed and dotted strokes. A solid (or missing) dash leaves the canvas
  // default untouched, so pre-B2 annotations keep rendering byte-identically.
  const dash = dashPattern(item.dash, width)
  if (dash.length) context.setLineDash(dash)
  if (item.type === 'rect') {
    // Normalised box: a reversed drag draws the same shape, rounded or not.
    const left = Math.min(x, x + (item.x2-item.x)*scaleX), top = Math.min(y, y + (item.y2-item.y)*scaleY)
    const w = Math.abs((item.x2-item.x)*scaleX), h = Math.abs((item.y2-item.y)*scaleY)
    const radius = resolveRadius(item.radius) * widthScale
    const fill = resolveFill(item.fill)
    if (radius > 0) {
      const corner = Math.min(radius, w/2, h/2)
      context.beginPath(); context.roundRect(left, top, w, h, corner)
      if (fill !== 'none') { context.save(); if (fill === 'translucent') context.globalAlpha = FILL_ALPHA; context.fill(); context.restore() }
      context.stroke()
    } else {
      if (fill !== 'none') { context.save(); if (fill === 'translucent') context.globalAlpha = FILL_ALPHA; context.fillRect(left, top, w, h); context.restore() }
      context.strokeRect(left, top, w, h)
    }
  }
  if (item.type === 'ellipse') {
    const fill = resolveFill(item.fill)
    context.beginPath(); context.ellipse((x+x2)/2,(y+y2)/2,Math.abs(x2-x)/2,Math.abs(y2-y)/2,0,0,Math.PI*2)
    if (fill !== 'none') { context.save(); if (fill === 'translucent') context.globalAlpha = FILL_ALPHA; context.fill(); context.restore() }
    context.stroke()
  }
  if (item.type === 'line') { context.beginPath(); context.moveTo(x,y); context.lineTo(x2,y2); context.stroke() }
  if (item.type === 'arrow') drawArrow(context,x,y,x2,y2,width,item.startHead === true,item.endHead !== false)
  if (item.type === 'pen') {
    // Brush plan (D6): the shared helper adds the 0.01px dot patch, so a single tap now
    // paints a dot instead of nothing (the pre-D6 branch silently drew nothing).
    traceStroke(context, offsetPoints(item.points, scaleX, scaleY, offsetX, offsetY), width)
    context.stroke()
  }
  if (item.type === 'highlight') {
    context.globalAlpha=resolveAlpha(item.alpha)
    // Brush plan (§3.2.1): with points it is one round-capped polyline - the freehand
    // marker the plan is about. Without points (every pre-change annotation) it stays the
    // shipped moveTo/lineTo, byte for byte.
    if (hasStrokePoints(item)) {
      traceStroke(context, offsetPoints(item.points, scaleX, scaleY, offsetX, offsetY), highlightWidth(baseWidth,widthScale))
    } else {
      context.lineWidth=highlightWidth(baseWidth,widthScale)
      context.beginPath(); context.moveTo(x,y); context.lineTo(x2,y2)
    }
    context.stroke()
  }
  if (item.type === 'text') { context.font = `${item.bold === true ? 'bold ' : ''}${textFontSize(baseWidth,widthScale)}px -apple-system,"Microsoft YaHei",sans-serif`; context.textBaseline='top'; context.fillText(item.text,x,y) }
  if (item.type === 'serial') { const radius=serialRadius(baseWidth,widthScale); context.beginPath(); context.arc(x,y,radius,0,Math.PI*2); context.fill(); context.fillStyle='#fff'; context.font=`bold ${radius}px sans-serif`; context.textAlign='center'; context.textBaseline='middle'; context.fillText(String(item.number),x,y+1) }
  if (item.type === 'watermark') drawWatermark(context,item,scaleX,scaleY,offsetX,offsetY)
  // Feature D3 (plan §7.1): the magnifier. It has NO flat x/y - its geometry is a nested source rect
  // plus a lens origin, both in the SAME space as every other annotation (viewport CSS on the
  // overlay, source pixels in the export), so the very same offset/scale arguments map it correctly
  // in both places. That is what makes "what the user sees" and "what gets written" one code path.
  if (item.type === 'magnifier') drawMagnifier(context, item, scaleX, scaleY, offsetX, offsetY)
  if (item.type === 'blur' && sourceImage) {
    // Brush plan (§3.2.2): with points the mosaic is the pixelated layer intersected with
    // the stroke mask. Without points it stays the shipped rectangle resample.
    if (hasStrokePoints(item)) {
      drawMosaicStroke(context,item,scaleX,scaleY,offsetX,offsetY,sourceImage)
    } else {
    const left=Math.min(x,x2), top=Math.min(y,y2), w=Math.abs(x2-x), h=Math.abs(y2-y)
    if (w>2&&h>2) { const tiny=document.createElement('canvas'); tiny.width=Math.max(1,Math.round(w/12)); tiny.height=Math.max(1,Math.round(h/12)); const t=tiny.getContext('2d'); const bounds=imageDisplayBounds(); const sourceScaleX=sourceImage.naturalWidth/bounds.w, sourceScaleY=sourceImage.naturalHeight/bounds.h; t.drawImage(sourceImage,(Math.min(item.x,item.x2)-bounds.x)*sourceScaleX,(Math.min(item.y,item.y2)-bounds.y)*sourceScaleY,Math.abs(item.x2-item.x)*sourceScaleX,Math.abs(item.y2-item.y)*sourceScaleY,0,0,tiny.width,tiny.height); context.imageSmoothingEnabled=false; context.drawImage(tiny,left,top,w,h); context.imageSmoothingEnabled=true }
    }
  }
  context.restore()
}

// Feature D3 (plan §7.1): the magnifier's painter.
//
// The nested geometry is normalised by shared/magnifier-geometry.js, so this function only converts
// it into the target space and paints. Two rules it must keep:
//
//   * the LENS CONTENT comes from the sampler (base image + opaque blur mask), never from the
//     composed canvas - otherwise a lens could magnify a blur away (§7.2);
//   * the lens is clipped to the region like every other annotation, so a lens hanging over the
//     edge is cut, not expanded into a bigger base image (§7.1).
//
// `scaleX/scaleY/offsetX/offsetY` are the same arguments every other pen/rect branch receives, so
// the overlay (viewport CSS) and the export (source pixels) share this one implementation.
function drawMagnifier(context, item, scaleX = 1, scaleY = 1, offsetX = 0, offsetY = 0) {
  const api = magnifierApi()
  if (!api) return
  const magnifier = api.normalizeMagnifier(item)
  const mapX = (value) => (value - offsetX) * scaleX
  const mapY = (value) => (value - offsetY) * scaleY
  const widthScale = Math.max(scaleX, scaleY)
  const source = magnifier.sourceRect
  const lens = api.lensRect(magnifier)
  const left = mapX(lens.x)
  const top = mapY(lens.y)
  const right = mapX(lens.x + lens.w)
  const bottom = mapY(lens.y + lens.h)
  const lensWidth = right - left
  const lensHeight = bottom - top
  const strokeWidth = Math.max(1, magnifier.stroke.widthPx * widthScale)
  // A degenerate lens has nothing to show and nothing to frame.
  if (!(lensWidth > 0.5) || !(lensHeight > 0.5)) return

  context.save()
  // Everything the lens paints stays inside it: a lens over the region edge is cut, exactly like a
  // rect blur is.
  context.beginPath()
  context.rect(left, top, lensWidth, lensHeight)
  context.clip()
  const sampled = magnifierLensCanvas(item)
  if (sampled && sampled.width > 0 && sampled.height > 0) {
    context.imageSmoothingEnabled = true
    context.drawImage(sampled, left, top, lensWidth, lensHeight)
  } else {
    // No sampler (missing module / impossible plan): a neutral fill is the honest render. Drawing
    // the composed stage here would be the leak §7.2 exists to prevent.
    context.fillStyle = 'rgba(0,0,0,.06)'
    context.fillRect(left, top, lensWidth, lensHeight)
  }
  context.restore()

  // Frame: same colour/width the annotation carries, drawn after the content so it stays visible.
  context.save()
  context.strokeStyle = magnifier.stroke.color
  context.lineWidth = strokeWidth
  context.strokeRect(left, top, lensWidth, lensHeight)
  // A source marker makes it obvious WHERE the lens is reading from - without it a lens floating
  // over unrelated content is ambiguous. Dashed and thin so it never competes with the picture.
  context.setLineDash([Math.max(3, strokeWidth * 2), Math.max(2, strokeWidth)])
  context.lineWidth = Math.max(1, strokeWidth / 2)
  context.strokeRect(mapX(source.x), mapY(source.y), source.w * scaleX, source.h * scaleY)
  context.restore()

  if (magnifier.connector === 'line') {
    const from = api.sourceCenter(magnifier)
    const to = api.lensCenter(magnifier)
    context.save()
    context.strokeStyle = magnifier.stroke.color
    context.lineWidth = Math.max(1, strokeWidth / 2)
    context.setLineDash([Math.max(4, strokeWidth * 2), Math.max(2, strokeWidth)])
    context.beginPath()
    context.moveTo(mapX(from.x), mapY(from.y))
    context.lineTo(mapX(to.x), mapY(to.y))
    context.stroke()
    context.restore()
  }
}

function renderOverlay() {
  if (!image) return  ctx.setTransform(dpr,0,0,dpr,0,0)
  ctx.clearRect(0,0,innerWidth,innerHeight)
  if (!selection) {
    ctx.fillStyle = initData?.settings?.screenshot?.selectionMask || 'rgba(0,0,0,.46)'
    ctx.fillRect(0,0,innerWidth,innerHeight)
    return
  }
  if(!initData?.imageBounds){ctx.save(); ctx.fillStyle=initData?.settings?.screenshot?.selectionMask||'rgba(0,0,0,.46)'; ctx.beginPath(); ctx.rect(0,0,innerWidth,innerHeight); ctx.rect(selection.x,selection.y,selection.w,selection.h); ctx.fill('evenodd'); ctx.restore()}
  // The region border follows the user's accent like every other selection
  // affordance. It used to be a hardcoded #36a3ff, which is the colour of the
  // theme this product replaced: under the shipped Nightshift amber and under
  // every theme direction it read as a second, unrelated accent. selectedAccent()
  // is the same resolver drawSelectedOutline() already used.
  ctx.save(); ctx.strokeStyle=selectedAccent(); ctx.lineWidth=1; ctx.setLineDash([4,3]); ctx.strokeRect(selection.x+.5,selection.y+.5,selection.w,selection.h); ctx.restore()
  annotations.forEach((item) => drawAnnotation(ctx,item))
  if (activeAnnotation) drawAnnotation(ctx,activeAnnotation)
  drawSelectedOutline()
  drawHandles()
  // B6 wave 2: the marquee is the last overlay, so it is never hidden by an
  // annotation drawn above it.
  drawMarquee()
  updateFloatingUi()
}

function render() {
  if (renderRequest) return
  renderRequest = requestAnimationFrame(() => {
    renderRequest = 0
    renderOverlay()
  })
}

// White pad + accent ring. The ring used to be a hardcoded #e5a44c (Nightshift's
// shipped default), which stopped tracking the accent the moment the user picked a
// different colour, and no longer matched the region border once that became
// accent-driven. Kept outside the body because
// test/capture-annotation-geometry.test.js pins that the eight pads are 8x8
// fillRects drawn within 600 characters of the function head.
function drawHandles() {
  if (!selection || currentTool !== 'select') return
  const points=[[selection.x,selection.y],[selection.x+selection.w/2,selection.y],[selection.x+selection.w,selection.y],[selection.x,selection.y+selection.h/2],[selection.x+selection.w,selection.y+selection.h/2],[selection.x,selection.y+selection.h],[selection.x+selection.w/2,selection.y+selection.h],[selection.x+selection.w,selection.y+selection.h]]
  ctx.save(); ctx.fillStyle='#fff'; ctx.strokeStyle=selectedAccent(); ctx.lineWidth=1; points.forEach(([x,y])=>{ctx.fillRect(x-4,y-4,8,8);ctx.strokeRect(x-4,y-4,8,8)}); ctx.restore()
}

// 选中项虚线框：画在标注之后、手柄之前（方案 §8.4 指定插入点）。坐标同样是屏幕 CSS
// 坐标；颜色取 shared/tokens.css 的 --primary（onInit 已把用户主色写进 :root）。
function selectedAccent() {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()
  // Fallback is the shipped accent, not the retired blue: this only runs when the
  // custom property is unavailable, and it should still look like this product.
  return value || '#e5a44c'
}

// B6 (D8): one dashed outline per selected item, so a multi-selection is visible on the
// stage; the 8 resize handles stay on the anchor, the only item they can resize.
function drawSelectionOutlineBox(box) {
  if (!box) return
  const pad = SELECTED_OUTLINE_PAD
  ctx.strokeRect(Math.round(box.x - pad) + .5, Math.round(box.y - pad) + .5, Math.round(box.w + pad * 2), Math.round(box.h + pad * 2))
}

function drawSelectedOutline() {
  const selected = selectedAnnotations()
  const item = selectedAnnotationItem()
  if (!item || !selected.length) return
  const bounds = annotationBounds(item)
  if (!bounds) return
  ctx.save()
  ctx.strokeStyle = selectedAccent()
  ctx.lineWidth = 1
  ctx.setLineDash([5, 4])
  selected.forEach((entry) => drawSelectionOutlineBox(entry === item ? bounds : annotationBounds(entry)))
  ctx.restore()
  // PR3：虚线框之后立刻画 8 个缩放手柄 —— 手柄必须有可见落点，否则用户无从发现缩放。
  drawSelectedHandles(bounds)
}

// PR3 的 8 个元素手柄：画在选中虚线框的 4 角 + 4 边中点，样式是**实心圆点 + 白描边**，
// 与选区手柄（白底橙边 8×8 方块，见 drawHandles()）刻意区分，避免两套手柄视觉混淆。
// 命中判定仍用 annotationBounds 本身：圆点距真实角点约 SELECTED_OUTLINE_PAD(5) < 6px 命中半径。
// 零尺寸元素（单点 pen、退化线/椭圆）不画 —— getResizeHandle() 对这些形状本来就不出手柄。
function drawSelectedHandles(bounds) {
  if (!bounds || bounds.w <= 0 || bounds.h <= 0) return
  const left = bounds.x - SELECTED_OUTLINE_PAD
  const top = bounds.y - SELECTED_OUTLINE_PAD
  const right = bounds.x + bounds.w + SELECTED_OUTLINE_PAD
  const bottom = bounds.y + bounds.h + SELECTED_OUTLINE_PAD
  const midX = (left + right) / 2
  const midY = (top + bottom) / 2
  const points = [[left, top], [midX, top], [right, top], [left, midY], [right, midY], [left, bottom], [midX, bottom], [right, bottom]]
  ctx.save()
  ctx.fillStyle = selectedAccent()
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 1
  points.forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke() })
  ctx.restore()
}

// 浮动元素条（#elementBar）：元素操作走独立浮动条，不往已近满宽的工具栏塞按钮（方案 §8 风险⑦）。
function updateElementBar() {
  const item = selectedAnnotationItem()
  const visible = !!item && !!selection && !activeOcrResult && !processingAction && !selecting && !dragging && !resizing && !pendingMove?.thresholdPassed && !resizingAnnotation && selectState !== 'auto'
  if (!visible) { elementBar.classList.add('hidden'); return }
  elementBar.classList.remove('hidden')
  // P0-5 PR4：层级按钮的可用态 —— 已在最上层/最下层时置灰，no-op 就不该给出可点的错觉。
  const index = annotations.indexOf(item)
  elementFront.disabled = index < 0 || index >= annotations.length - 1
  elementBack.disabled = index <= 0
  // B6 (D8): the counter label. It changes the bar's width, so it must drop the cached
  // rect - otherwise the placement below keeps using the single-selection width.
  syncElementBarCount()
  const bounds = annotationBounds(item) || { x: 0, y: 0, w: 0, h: 0 }
  const rect = elementBarSize || (elementBarSize = elementBar.getBoundingClientRect())
  // The element bar shares the strip's placement rule, so the two floating surfaces can
  // never disagree about where the strip is.
  const own = resolveFloatingPlacement({
    anchor: bounds,
    size: { width: rect.width, height: rect.height },
    viewport: { width: innerWidth, height: innerHeight },
    gap: 10,
    padding: 6
  })
  let left = own.left
  let top = own.top
  // 与工具栏避让：水印的 bounds 按设计等于选区，而本条的落位与工具栏同源、z-index 更高
  // （6 > 5），于是选中水印时浮动条会整条压在工具栏右端，挡住 保存/导出PDF/复制/取消 四个按钮。
  // 重叠时改放到选区上方外侧；上方也放不下（贴顶）则落到工具栏下方。
  if (!toolbar.classList.contains('hidden') && selection) {
    const toolbarRect = toolbarSize || (toolbarSize = toolbar.getBoundingClientRect())
    // Same function and same inputs as updateFloatingUi: one answer to "where is the strip".
    const toolbarPlace = resolveFloatingPlacement({
      anchor: selection,
      size: { width: toolbarRect.width, height: toolbarRect.height },
      viewport: { width: innerWidth, height: innerHeight },
      gap: 10,
      padding: 6
    })
    const overlaps = left < toolbarPlace.left + toolbarRect.width && left + rect.width > toolbarPlace.left &&
      top < toolbarPlace.top + toolbarRect.height && top + rect.height > toolbarPlace.top
    if (overlaps) {
      let nextTop = bounds.y - rect.height - 10
      if (nextTop < 6) nextTop = Math.min(innerHeight - rect.height - 6, toolbarPlace.top + toolbarRect.height + 10)
      top = Math.max(6, nextTop)
    }
  }
  elementBar.style.left = `${Math.round(left)}px`
  elementBar.style.top = `${Math.round(top)}px`
}

// ---------- B1 (D5/D6): the two-row strip ----------

// B2-B5 add one group per option role; each group declares the tools it belongs to
// (`data-option-tools="rect ellipse"`), so the second row is a projection of the
// current tool and needs no per-tool wiring of its own.
const TOOL_OPTION_GROUPS = Array.from(document.querySelectorAll('[data-option-tools]'))

// D6/R3: the toolbar's own size is cached, so anything that can change the
// container's height must drop the cache - otherwise the next placement reuses a
// stale height and the second row can push the whole strip off screen.
function invalidateToolbarSize() {
  toolbarSize = null
}

// Plan 2 (D12): the strip narrows itself to hug the region instead of always asking for
// "viewport minus 20px" (the CSS default below). The rule is the pure function
// toolbarWidthLimit() in selection-utils.js; this is the single write point for the
// element's inline max-width, and a change here is a height change (a narrower strip
// wraps into more rows), so it must go through the same size-invalidation helper as
// every other size-changing event. Called from updateFloatingUi(), which renderOverlay()
// runs every frame, so a region resize and a stage resize both re-apply it without
// extra hooks.
const TOOLBAR_MIN_WIDTH = 420
const TOOLBAR_WIDTH_SLACK = 160
let toolbarMaxWidth = null

// The pin re-annotate editor is the one flow that hands the renderer a fixed imageBounds
// to lay the strip out around, and the main process pre-reserves its strip from a
// single-line assumption (main/domains/pin/index.js: stripRows / actionSpace). Wrapping
// the strip there would outgrow that reservation and push the strip back over the image,
// so this flow keeps the shipped CSS cap; test/capture-floating-placement.test.js pins
// both halves of that trade-off.
function stripFollowsRegion() {
  return !initData?.imageBounds
}

function applyToolbarWidthLimit() {
  const limit = stripFollowsRegion() && selection
    ? toolbarWidthLimit({
      anchor: selection,
      viewport: { width: innerWidth, height: innerHeight },
      minimum: TOOLBAR_MIN_WIDTH,
      slack: TOOLBAR_WIDTH_SLACK
    })
    : null
  if (limit === toolbarMaxWidth) return
  toolbarMaxWidth = limit
  toolbar.style.maxWidth = limit === null ? '' : `${limit}px`
  invalidateToolbarSize()
}

// B6 (D8): the element bar caches its own rect too, and the multi-selection counter
// changes that rect's width. Same discipline as the strip: one write point, called from
// the places that can change the bar's content or the stage size.
function invalidateElementBarSize() {
  elementBarSize = null
}

// B6 (D8): the counter is plain text written by the controller (like the size badge),
// so it is not a data-i18n marker; the wording still comes from the locale table.
function syncElementBarCount() {
  const count = selectedIds.size
  const label = count > 1 ? t('capture.element.selected-count', { count }) : ''
  if (elementCount.textContent !== label) elementCount.textContent = label
  const visible = count > 1
  if (elementCount.classList.contains('hidden') === visible) {
    elementCount.classList.toggle('hidden', !visible)
    invalidateElementBarSize()
  }
}

function toolOptionGroups(tool) {
  if (!tool) return []
  return TOOL_OPTION_GROUPS.filter((group) => group.dataset.optionTools.split(' ').includes(tool))
}

// B2: the row follows the selection when the selected element owns options (so a
// rect stays editable while the select tool is active) and otherwise the active tool.
function optionRowTool() {
  const item = selectedAnnotationItem()
  if (item && TOOL_OPTION_FIELDS[item.type]) return item.type
  return TOOL_OPTION_FIELDS[currentTool] ? currentTool : ''
}

// The style the row displays: the selected item's own options when it owns the row
// (A4 echo), otherwise the remembered style of that tool.
function rowToolOptions(tool) {
  const item = selectedAnnotationItem()
  if (item && item.type === tool) return resolveToolOptions(tool, item)
  return resolveToolOptions(tool, toolStyles[tool])
}

// B6 (D8): the option map for a multi-selection. A field keeps the value its items
// agree on, or null where they disagree - String(null) matches no button value, so a
// mixed field simply shows nothing active. Items of another type are ignored, which is
// what keeps the row honest when the selection mixes a rect with a pen.
function selectionToolOptions(tool, selected) {
  const fields = TOOL_OPTION_FIELDS[tool]
  if (!fields) return {}
  const rows = selected.filter((entry) => entry.type === tool).map((entry) => resolveToolOptions(tool, entry))
  if (!rows.length) return resolveToolOptions(tool, toolStyles[tool])
  const options = {}
  fields.forEach((field) => { options[field] = commonSelectionValue(rows.map((row) => row[field])) })
  return options
}

function syncToolOptionControls() {
  const tool = optionRowTool()
  const selected = selectedAnnotations()
  const options = !tool ? {} : (selected.length > 1 ? selectionToolOptions(tool, selected) : rowToolOptions(tool))
  toolOptions.querySelectorAll('[data-annotation-option]').forEach((button) => {
    const key = button.dataset.annotationOption
    if (!Object.hasOwn(options, key)) return
    const active = String(options[key]) === button.dataset.annotationOptionValue
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', String(active))
  })
}

// Show only the groups the row's tool owns; the row itself hides when none is
// visible. A visibility or family change is one of the size-invalidating events
// (the other is a window resize).
function syncToolOptionsRow() {
  const tool = optionRowTool()
  const visible = toolOptionGroups(tool)
  let changed = false
  TOOL_OPTION_GROUPS.forEach((group) => {
    const show = visible.includes(group)
    if (group.classList.contains('hidden') === show) {
      group.classList.toggle('hidden', !show)
      changed = true
    }
  })
  const rowVisible = visible.length > 0
  if (toolOptions.classList.contains('hidden') === rowVisible) {
    toolOptions.classList.toggle('hidden', !rowVisible)
    changed = true
  }
  syncToolOptionControls()
  if (!changed) return
  invalidateToolbarSize()
  render()
}

// B2/B3/B5: an option click writes the row tool's memory and, when the selected item
// belongs to that tool, the item itself in one discrete undo frame. Typed parsing is
// what lets one delegated listener serve numbers, booleans and strings.
const OPTION_VALUE_PARSERS = { radius: Number, startHead: (value) => value === 'true', endHead: (value) => value === 'true', bold: (value) => value === 'true' }

// The boolean option groups are TOGGLES, not one-way switches: the same button states
// "on", and pressing it again states "off". Their markup can only carry one value
// (`data-annotation-option-value="true"`), so a click used to submit `true` forever and
// the control could be turned on but never off (reported 2026-10-19: the arrow start/end
// heads could not be deselected once picked; `text.bold` had the identical defect). The
// flip reads the state the button is currently DISPLAYING - `aria-pressed` is written by
// syncToolOptionControls from the same resolved options the next annotation will use -
// so the click always inverts what the user sees, including after a selection change
// re-pointed the echo.
const TOGGLE_OPTION_KEYS = new Set(['startHead', 'endHead', 'bold'])

// Every non-boolean option group is a radio-style pick among fixed values, so its
// click keeps the declarative `data-annotation-option-value`; only toggles invert.
function resolveOptionClickValue(key, rawValue, button) {
  if (!TOGGLE_OPTION_KEYS.has(key)) {
    const parse = OPTION_VALUE_PARSERS[key]
    return parse ? parse(rawValue) : rawValue
  }
  // aria-pressed mirrors the resolved value; anything else means "not currently on".
  const displayed = button?.getAttribute?.('aria-pressed') === 'true'
  return !displayed
}

function setAnnotationOption(key, rawValue, button) {
  const tool = optionRowTool()
  const fields = TOOL_OPTION_FIELDS[tool]
  if (!fields || !fields.includes(key)) return
  const value = resolveOptionClickValue(key, rawValue, button)
  writeToolStyle(tool, { [key]: value }, true)
  const item = selectedAnnotationItem()
  if (item && item.type === tool) commitSelectedStyle({ [key]: value })
  syncToolOptionControls()
  render()
}

// The strip's position has exactly one source: the pure placement rule in
// selection-utils.js. Both the region capture and the pin re-annotate editor go
// through it, and updateElementBar reads it to know what to avoid.
function toolbarPlacement() {
  const rect = toolbarSize || (toolbarSize = toolbar.getBoundingClientRect())
  return resolveFloatingPlacement({
    anchor: selection,
    size: { width: rect.width, height: rect.height },
    viewport: { width: innerWidth, height: innerHeight },
    gap: 10,
    padding: 6
  })
}

function updateFloatingUi() {
  // Plan 2 (D12): the region's width cap must be on the element before anything reads
  // the cached strip rect (the element bar avoids that rect below).
  applyToolbarWidthLimit()
  updateElementBar()
  syncOutputStyleUi()
  if (!selection || selection.w<2 || selection.h<2) { toolbar.classList.add('hidden'); sizeBadge.style.display='none'; syncWatermarkPanel(); syncMagnifierPanel(); return }
  document.getElementById('record').disabled=selection.w<16||selection.h<16
  const hideSizeBadge=['ocr','translate'].includes(processingAction)||!!activeOcrResult||['ocr','translate'].includes(initData?.autoAction)
  sizeBadge.style.display=hideSizeBadge?'none':'block'; sizeBadge.textContent=`${Math.round(selection.w)} × ${Math.round(selection.h)}`; sizeBadge.style.left=`${Math.max(4,selection.x)}px`; sizeBadge.style.top=`${Math.max(4,selection.y-27)}px`
  if (activeOcrResult) { toolbar.classList.add('hidden'); positionOcrResultBar(); syncWatermarkPanel(); syncMagnifierPanel(); return }
  if (selectState==='auto'||selecting||dragging||resizing) { toolbar.classList.add('hidden'); syncWatermarkPanel(); syncMagnifierPanel(); return }
  toolbar.classList.remove('hidden')
  // D6 + the pin re-annotate fix: below the region when it fits, above it when only that
  // fits, otherwise docked inside hugging the region's bottom - never clipped, and never
  // clamped into the top of the region the way the old fallback did.
  const placement=toolbarPlacement()
  toolbar.style.left=`${placement.left}px`; toolbar.style.top=`${placement.top}px`; toolbar.classList.toggle('above',placement.above)
  syncWatermarkPanel()
  syncMagnifierPanel()
  syncRegionUi()
}

function positionOcrResultBar() {
  if (!selection||ocrResultBar.classList.contains('hidden')) return
  const rect=ocrResultBar.getBoundingClientRect()
  let left=selection.x+(selection.w-rect.width)/2
  let top=selection.y+selection.h+10
  if(top+rect.height>innerHeight-8)top=selection.y-rect.height-10
  left=Math.max(8,Math.min(left,innerWidth-rect.width-8))
  top=Math.max(8,Math.min(top,innerHeight-rect.height-8))
  ocrResultBar.style.left=`${left}px`
  ocrResultBar.style.top=`${top}px`
}

// Switching the active tool. The two statements below are order-sensitive, and that
// order is a bug fix (2026-10-19): the style echo (`syncToolbarStyleFromSelection`,
// reached through setSelectedAnnotation) reads `currentTool` to pick the remembered
// block it displays. Clearing the selection FIRST meant the echo still saw the
// PREVIOUS tool, so the swatch showed one tool behind the one that would actually
// draw: pick rect after a blue-rect session and the swatch said red while the next
// rect was blue, then switch to ellipse and it showed blue while the next ellipse
// was red. `currentTool` therefore moves ABOVE the selection clear - it is the state
// the echo is a function of.
function setTool(tool) {
  currentTool=tool
  // 方案 §8.4：换工具即清选中，避免虚线框/浮动条挂在另一个工具上。
  setSelectedAnnotation(null)
  document.querySelectorAll('[data-tool]').forEach((button)=>button.classList.toggle('active',button.dataset.tool===tool))
  canvas.style.cursor=tool==='select'?(selection?'move':'crosshair'):'crosshair'
  if(tool==='watermark'){activeAnnotation=buildWatermarkAnnotation();render()}
  else if(activeAnnotation?.type==='watermark'){activeAnnotation=null;render()}
  // Feature D3: switching away from the magnifier tool drops a draft that never settled (it has no
  // committed object, so there is nothing to undo - same rule as an interrupted stroke).
  if(tool!=='magnifier'&&magnifierBuild){magnifierBuild=null;magnifierDrag=null;activeAnnotation=null;render()}
  if(tool==='magnifier')setMagnifierStatus('',null,false)
  // B1: the second row follows the tool (and, once B2-B5 land, also the selection).
  syncToolOptionsRow()
  syncWatermarkPanel()
  syncMagnifierPanel()
}

// A1/A4: one place paints the toolbar's width and colour controls, so the
// selection echo (A4) can repaint them WITHOUT going through the edit paths
// (which would push an undo frame for a mere selection change).
function applyToolbarWidth(width) {
  lineWidthGroup.querySelectorAll('[data-annotation-width]').forEach((button) => {
    const active = Number(button.dataset.annotationWidth) === width
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', String(active))
  })
}

function applyToolbarColor(color) {
  colorInput.value = color
  // B6 (D8): a concrete colour always leaves the mixed state behind.
  colorPreview.classList.remove('mixed')
  colorPreview.style.background = color
  colorPalette.querySelectorAll('[data-annotation-color]').forEach((button) => {
    const active = button.dataset.annotationColor === color
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', String(active))
  })
}

// B6 (D8): "mixed" is the cheapest honest display for a field the selected items
// disagree on - no option looks active and the swatch shows a two-colour split.
function applyToolbarMixedColor() {
  colorPreview.classList.add('mixed')
  colorPreview.style.background = ''
  colorPalette.querySelectorAll('[data-annotation-color]').forEach((button) => {
    button.classList.remove('active')
    button.setAttribute('aria-pressed', 'false')
  })
}

function applyToolbarMixedWidth() {
  lineWidthGroup.querySelectorAll('[data-annotation-width]').forEach((button) => {
    button.classList.remove('active')
    button.setAttribute('aria-pressed', 'false')
  })
}

// B6 (D8): the toolbar echo for a multi-selection. Each of the two main controls keeps
// its shared value or goes indeterminate; the second row gets the same treatment in
// syncToolOptionControls(). UI-only, exactly like the single-selection echo.
function applyToolbarSelection(selected) {
  const sharedColor = commonSelectionValue(selected.map((entry) => normalizeAnnotationColor(entry.color)))
  const sharedWidth = commonSelectionValue(selected.map((entry) => resolveAnnotationWidth(entry.width)))
  if (sharedColor === null) applyToolbarMixedColor()
  else applyToolbarColor(sharedColor)
  if (sharedWidth === null) applyToolbarMixedWidth()
  else applyToolbarWidth(sharedWidth)
}

// A3 (D3): recents are session memory only (never persisted); the newest custom
// colour leads and a preset never enters the list - it already has its own swatch.
function rememberRecentColor(value) {
  const color = normalizeAnnotationColor(value)
  if (!PRESET_COLORS.some((preset) => preset.color === color)) {
    recentAnnotationColors = [color, ...recentAnnotationColors.filter((entry) => entry !== color)]
      .slice(0, MAX_RECENT_COLORS)
  }
  renderRecentColors()
}

function renderRecentColors() {
  recentColorList.replaceChildren()
  recentColorList.classList.toggle('hidden', !recentAnnotationColors.length)
  recentAnnotationColors.forEach((color) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.annotationColor = color
    button.style.setProperty('--swatch', color)
    button.title = color
    button.setAttribute('aria-label', color)
    button.setAttribute('aria-pressed', String(color === colorInput.value))
    recentColorList.appendChild(button)
  })
}

function openColorPalette() {
  renderRecentColors()
  colorPalette.classList.remove('hidden')
  colorButton.setAttribute('aria-expanded', 'true')
}

function closeColorPalette() {
  colorPalette.classList.add('hidden')
  colorButton.setAttribute('aria-expanded', 'false')
}

function toggleColorPalette() {
  if (colorPalette.classList.contains('hidden')) openColorPalette()
  else closeColorPalette()
}

// B4 (D7): one write path for a remembered style. The value is normalised through
// resolveToolStyle, so the in-memory map and the persisted block always agree on the
// shape (and a hand-edited store cannot smuggle a bad value into a new annotation).
function writeToolStyle(tool, patch, persist) {
  if (!tool) return
  toolStyles[tool] = Object.assign(resolveToolStyle(tool, toolStyles[tool]), patch)
  if (persist) persistToolStyles()
}

// B4 (D7): always submit the WHOLE canonical map (all eight tools). settings:update
// deep-merges, so a field-by-field write could leave another tool's block stale; one
// atomic object is what makes "always merge with the newest store" safe.
function annotationStylesPayload() {
  return resolveToolStyles(toolStyles)
}

function persistToolStyles() {
  window.captureAPI.saveAnnotationStyles(annotationStylesPayload()).catch(() => {})
}

// B4 (D7) + A4 (D4): the tool whose style the toolbar edits - the selected element's
// own tool when there is one, otherwise the active tool. This is also the echo's
// source of truth, which is why deselecting restores a tool style and not a global.
function toolbarStyleTool() {
  const item = selectedAnnotationItem()
  if (item && TOOL_STYLE_TOOLS.includes(item.type)) return item.type
  return TOOL_STYLE_TOOLS.includes(currentTool) ? currentTool : ''
}

function currentToolStyle() {
  return resolveToolStyle(currentTool, toolStyles[currentTool])
}

// A3 (D4) + B4: the colour lands on the row tool's remembered style; when something is
// selected it also lands on that item in one discrete undo frame (applyStyle is a
// no-op for an unchanged value, so selecting and re-picking costs no frame). The
// legacy scalar key is still written so an older build keeps its last choice.
function setAnnotationColor(color, persist = false) {
  const resolved = normalizeAnnotationColor(color)
  annotationColor = resolved
  writeToolStyle(toolbarStyleTool(), { color: resolved }, persist)
  applyToolbarColor(resolved)
  commitSelectedStyle({ color: resolved })
  if (!persist) return
  window.captureAPI.saveAnnotationColor(resolved).catch(() => {})
}

// Persist only user clicks; restoring the stored value on init must not write back.
function setAnnotationWidth(width, persist = false) {
  const resolved = resolveAnnotationWidth(width)
  annotationWidth = resolved
  writeToolStyle(toolbarStyleTool(), { width: resolved }, persist)
  applyToolbarWidth(resolved)
  // P0-5 PR4：线宽不再只服务"下一次新建"—— 有选中项时改的是**该选中项**（生成新副本 →
  // 替换数组项 → 一帧快照）；没有选中项时是 no-op，新建仍照旧读 annotationStyle()。
  commitSelectedStyle({ width: resolved })
  if (!persist) return
  window.captureAPI.saveAnnotationWidth(resolved).catch(() => {})
}

// A2: a wheel burst must not write the store once per notch, so persistence trails.
function scheduleAnnotationWidthPersist() {
  if (widthPersistTimer) clearTimeout(widthPersistTimer)
  widthPersistTimer = setTimeout(() => {
    widthPersistTimer = 0
    window.captureAPI.saveAnnotationWidth(annotationWidth).catch(() => {})
    persistToolStyles()
  }, WIDTH_PERSIST_DELAY)
}

function cancelAnnotationWidthPersist() {
  if (widthPersistTimer) { clearTimeout(widthPersistTimer); widthPersistTimer = 0 }
}

// A2/B4: what the toolbar currently shows. The wheel and the width echo must agree on
// this, otherwise the first tick would jump to a value derived from the legacy mirror
// instead of the tool (or element) the user is looking at.
function displayedToolWidth() {
  const item = selectedAnnotationItem()
  return item ? resolveAnnotationWidth(item.width) : currentToolStyle().width
}

// A2: the wheel steps thickness only when that is unambiguous - a width-bearing
// tool is active (or a selected item can absorb it) and no region gesture is running.
function canStepAnnotationWidth() {
  if (!selection || selecting || dragging || resizing || selectState === 'auto') return false
  return WIDTH_TOOLS.has(currentTool) || !!selectedAnnotationItem()
}

// ---------- P0-5 PR1：选中 + 删除 + 快照栈 ----------

// 当前仍然有效的选中项（快照还原会换掉对象身份，所以按引用校验一次）。
function selectedAnnotationItem() {
  return selectedAnnotation && annotations.includes(selectedAnnotation) ? selectedAnnotation : null
}

// B6 (D8): the whole selection in z-order. The primary item is guaranteed to be one of
// them, so `length === 1` is exactly the pre-B6 single-selection case and every existing
// single-item path stays correct because it reads selectedAnnotationItem().
function selectedAnnotations() {
  return annotations.filter((item) => selectedIds.has(item.id))
}

// B6 (D8): shift+click adds one item and promotes it to the primary (the anchor whose
// style the toolbar echoes). Adding is also what shift+right-click does: a right press
// is a pick-up-and-drag gesture, so it can only grow the selection.
function addSelectedAnnotation(item) {
  if (!item || selectedIds.has(item.id)) return
  selectedIds = new Set(selectedIds).add(item.id)
  selectedAnnotation = item
  syncToolbarStyleFromSelection()
  render()
}

// B6 (D8): shift+click on an already selected item removes it. Removing the primary
// hands the anchor to the topmost survivor, and removing the last item clears the
// selection through the one path that keeps the set and the anchor in step.
function toggleSelectedAnnotation(item) {
  if (!item) return
  if (!selectedIds.has(item.id)) { addSelectedAnnotation(item); return }
  const next = new Set(selectedIds)
  next.delete(item.id)
  selectedIds = next
  const remaining = selectedAnnotations()
  if (!remaining.length) { setSelectedAnnotation(null); return }
  if (!next.has(selectedAnnotation?.id)) selectedAnnotation = remaining[remaining.length - 1]
  syncToolbarStyleFromSelection()
  render()
}

// B6 (D8) + A4-T1: a snapshot restore replaces the objects, so both the set and the
// anchor are re-resolved by id. The topmost survivor becomes the anchor when the old one
// is gone, which keeps the single-selection case identical to the pre-B6 behaviour.
function reResolveSelectedAnnotation(annotations, ids, current) {
  const id = current?.id
  const resolved = ids.has(id) ? annotations.find((item) => item.id === id) || null : null
  if (resolved) return resolved
  return ids.size ? annotations.filter((item) => ids.has(item.id)).pop() || null : null
}

// ---------- B6 wave 2 (D8): shift+drag marquee ----------

// The derived rectangle. `start`/`current` are screen CSS points, so the marquee shares
// the coordinate space of annotationBounds() and needs no export conversion (§8.3).
function marqueeRect() {
  return marquee ? normalizeRect(marquee.start, marquee.current) : null
}

function beginMarquee(point, event) {
  marquee = { start: point, current: point }
  try { canvas.setPointerCapture(event.pointerId) } catch {}
  render()
}

function updateMarquee(point) {
  if (!marquee) return
  marquee.current = point
  render()
}

// Release: a sub-threshold press is a plain shift+click and keeps the selection as it
// was, so a stray click can never wipe a multi-selection. Otherwise everything the
// rectangle touches is ADDED (the gesture requires shift, so it can only grow the set)
// and the topmost hit becomes the anchor.
function finishMarquee(point) {
  const state = marquee
  marquee = null
  if (!state) return
  if (!movedBeyondThreshold(state.start, point, MOVE_THRESHOLD)) { render(); return }
  const rect = normalizeRect(state.start, point)
  const hits = annotations.filter((item) => rectsIntersect(annotationBounds(item), rect))
  if (!hits.length) { render(); return }
  const next = new Set(selectedIds)
  hits.forEach((item) => next.add(item.id))
  selectedIds = next
  selectedAnnotation = hits[hits.length - 1]
  syncToolbarStyleFromSelection()
  render()
}

// pointercancel: an interrupted marquee changes nothing (no frame, no selection edit).
function cancelMarquee() {
  if (!marquee) return
  marquee = null
  render()
}

function drawMarquee() {
  const rect = marqueeRect()
  if (!rect) return
  ctx.save()
  ctx.fillStyle = 'rgba(54,163,255,.14)'
  ctx.strokeStyle = selectedAccent()
  ctx.lineWidth = 1
  ctx.setLineDash([5, 4])
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
  ctx.strokeRect(Math.round(rect.x) + .5, Math.round(rect.y) + .5, Math.round(rect.w), Math.round(rect.h))
  ctx.restore()
}

// A4 (D4): selection echo is UI-only. It repaints the width/colour controls from
// the selected item so the toolbar stops lying about what is on screen; it must
// never call commitSelectedStyle/stageSelectedStyle, or a mere selection would
// create an undo frame. With nothing selected the committed defaults come back.
function syncToolbarStyleFromSelection() {
  const selected = selectedAnnotations()
  const item = selectedAnnotationItem()
  // B4 (D4): with nothing selected the toolbar shows the active tool's remembered
  // style (which the migration seeded from the legacy colour/width keys).
  const fallback = currentToolStyle()
  // B6 (D8): a multi-selection echoes the value the items agree on, or an
  // indeterminate control where they disagree. Still UI-only - never a commit path.
  if (selected.length > 1) {
    applyToolbarSelection(selected)
    syncToolOptionsRow()
    return
  }
  applyToolbarColor(item ? normalizeAnnotationColor(item.color) : fallback.color)
  applyToolbarWidth(item ? resolveAnnotationWidth(item.width) : fallback.width)
  // B2: the second row belongs to whichever tool can offer options right now, so a
  // selection change is also a row change.
  syncToolOptionsRow()
}

function syncSelectedAnnotation() {
  selectedIds = revalidateSelection(annotations, selectedIds)
  selectedAnnotation = reResolveSelectedAnnotation(annotations, selectedIds, selectedAnnotation)
  syncToolbarStyleFromSelection()
}

function setSelectedAnnotation(item) {
  selectedAnnotation = item || null
  selectedIds = item ? new Set([item.id]) : new Set()
  syncToolbarStyleFromSelection()
  render()
  // Feature D3/D4: the magnifier panel is gated on "the tool is active OR a magnifier is selected",
  // so a selection change has to re-evaluate it - otherwise selecting a lens with the select tool
  // never reveals its factor/connector controls. Kept AFTER render() so the shipped echo path
  // (style echo -> render) is byte-identical, and it is a pure UI visibility toggle: it never edits
  // an object, so it cannot reach the undo or commit paths.
  syncMagnifierPanel()
}

// 提交一帧快照：截断 redo 分支 → 深拷贝当前 annotations → 上限 60 条（丢最旧的一条）。
// 注意：这里**不再**取消待收口的微调/样式帧 —— 那会把两次用户操作合并进同一帧（Ctrl+Z 一次退两步）。
// 每个"用户动作"路径在压帧前先调 flushCoalescedEdits()，让待收口的合并型编辑各自独立成帧。
function snapshotAnnotations() {
  const base = historyIndex + 1
  annotationHistory.length = base
  annotationHistory.push(cloneAnnotations(annotations))
  let dropped = 0
  if (annotationHistory.length > MAX_ANNOTATION_HISTORY) {
    dropped = annotationHistory.length - MAX_ANNOTATION_HISTORY
    annotationHistory.splice(0, dropped)
  }
  historyIndex = annotationHistory.length - 1
  pushOutputStyleFrame(base - dropped)
  // Batch 1: every committed content change funnels through here, so this is the one place
  // that can keep `dirty` honest. Undo/redo also lands here via restoreAnnotations, which is
  // exactly what makes "undo back to the baseline -> clean" work (§6.5.6).
  if (documentEditor) refreshDocumentDirty()
}

// Feature C (plan §6.3): advance the finished-look timeline with the SAME structural edits the
// annotation stack just made (see capture/output-style-panel.js createStyleFrames), so
// `frameAt(historyIndex)` is the style that was current at that undo step. `base` is the pre-push
// length and `dropped` the overflow trim; without both, an overflowed stack would shift every
// style one step out of phase and Ctrl+Z would restore the wrong card.
function pushOutputStyleFrame(index) {
  if (!outputStyleController) return
  outputStyleController.truncateFrames(index)
  outputStyleController.pushFrame()
}

// 把"已生效但未收口"的合并型编辑（方向键微调、取色器连续改色）各自压成独立一帧。
// 顺序固定为 微调 → 样式；两者互不吞并（commitNudge/commitStyle 只清自己的标志位）。
function flushCoalescedEdits() {
  if (nudgeDirty) commitNudge()
  if (styleDirty) commitStyle()
}

function restoreAnnotations(index) {
  cancelNudge()
  // PR4：撤销/重做会整体换掉 annotations，未收口的样式改动随这次还原一起作废（与微调同口径）。
  cancelStyleCommit()
  historyIndex = Math.max(0, Math.min(annotationHistory.length - 1, index))
  annotations = cloneAnnotations(annotationHistory[historyIndex])
  // Brush plan (§5.2): the restored objects are fresh clones, so every patch is stale.
  invalidateMosaicPatches()
  syncSelectedAnnotation()
  // Batch 1: undo/redo does not go through snapshotAnnotations (it moves historyIndex instead),
  // so dirty has to be re-derived here too - that is what makes "undo back to the committed
  // state" turn clean again (§6.5.6) instead of staying dirty forever.
  if (documentEditor) refreshDocumentDirty()
  render()
  // Feature C (§6.3): the style rides the same undo step, so "undo back to original" is a normal
  // Ctrl+Z and a redo restores the card. Placed last so the annotation path above stays identical.
  restoreOutputStyleFrame()
}

// Moves the session's style to the frame recorded at the restored undo index. `restoreFrame` does
// NOT push a frame - this is a restore of the same user action, not a new edit.
function restoreOutputStyleFrame() {
  if (!outputStyleController) return
  outputStyleController.restoreFrame(outputStyleController.frameAt(historyIndex))
  outputStylePanel?.syncControls()
  renderOutputStylePreview()
}

function undoAnnotations() {
  // 待收口的微调/样式各自先落一帧，Ctrl+Z 才是"精确回退一步"（不会连上一个操作一起撤掉，
  // 也不会把微调直接丢掉）。flush 必须在 restoreAnnotations 之前 —— 后者会整体换掉 annotations。
  flushCoalescedEdits()
  if (historyIndex <= 0) return
  restoreAnnotations(historyIndex - 1)
}

function redoAnnotations() {
  // 与 undo 同口径：存在 redo 分支时 Ctrl+Y 也不该静默丢掉未收口的改动。
  // flush 会把 redo 分支截断（新编辑作废 redo，正确语义），随后 historyIndex 已到栈顶 → no-op。
  flushCoalescedEdits()
  if (historyIndex >= annotationHistory.length - 1) return
  restoreAnnotations(historyIndex + 1)
}

// 删除选中项：序列号删除后**不重编号**（方案 §8 风险⑥），空隙保留。
// B6 (D8): the whole selection goes in one frame - Delete on a multi-selection must not
// force the user to repeat the key per item.
function deleteSelectedAnnotation() {
  const targets = selectedAnnotations()
  if (!targets.length) return
  flushCoalescedEdits()
  targets.forEach((item) => {
    const index = annotations.indexOf(item)
    if (index >= 0) annotations.splice(index, 1)
  })
  selectedAnnotation = null
  selectedIds = new Set()
  syncToolbarStyleFromSelection()
  snapshotAnnotations()
  // Brush plan (§5.2): the deleted objects must not keep their patches alive.
  invalidateMosaicPatches()
  render()
}

// D4 落地项：重划选区会丢弃全部已提交标注——改为**先确认**；
// 取消（返回 false）时调用方必须原样保留选区与标注，不得先改状态再问。
function confirmDiscardAnnotations() {
  if (!annotations.length) return true
  return confirm(t('capture.confirm.reset-selection'))
}

// 确认后清空；仍然压一帧快照，使这次清空也能被 Ctrl+Z 精确回退。
function clearAnnotationsForNewSelection() {
  // 没有标注可清时不压帧：否则首次手动划选区会在栈底多出一个与初始状态相同的死撤销步。
  if (!annotations.length) { selectedAnnotation = null; selectedIds = new Set(); syncToolbarStyleFromSelection(); return }
  flushCoalescedEdits()
  annotations = []
  selectedAnnotation = null
  selectedIds = new Set()
  syncToolbarStyleFromSelection()
  snapshotAnnotations()
}

// ---------- P0-5 PR2：元素拖动 + 方向键微调 ----------

// 舞台矩形：命中/拖动/clamp 一律是屏幕 CSS 坐标（方案 §8.3），导出坐标不参与。
function stageRect() {
  return { w: innerWidth, h: innerHeight }
}

// 拖动入口：点必须落在**当前已选中**元素的 annotationBounds 内（方案 §8.4 优先级里
// "选中元素手柄 > 元素体内"）。rect/ellipse 的命中测试只认描边环带，选中之后这里按
// bbox 判定，才能从图形内部拖着走。
function pointInAnnotationBounds(item, point) {
  const bounds = annotationBounds(item)
  if (!bounds || !point) return false
  return point.x >= bounds.x && point.x <= bounds.x + bounds.w && point.y >= bounds.y && point.y <= bounds.y + bounds.h
}

// A1 (D2): the press that may become a move. thresholdPassed flips on the first
// pointermove past MOVE_THRESHOLD; until then nothing is translated, so a plain
// click on an element neither jitters it nor pushes an undo frame.
//
// Feature D3: `part` says which half of a magnifier the gesture is dragging ('lens' / 'source' /
// 'connector'), decided once at press time by shared/magnifier-geometry.hitTestMagnifier(). It is
// fixed for the whole gesture on purpose - re-testing on every move would let a lens dragged over
// its own source rect switch halves mid-drag.
function beginPendingMove(item, point, event, part = '') {
  if (!item) return
  pendingMove = { id: item.id, origin: item, start: { x: point.x, y: point.y }, thresholdPassed: false, part }
  try { canvas.setPointerCapture(event.pointerId) } catch {}
  render()
}

// 拖动中：从 origin 重新平移 + clamp，把新副本放回数组；绝不就地改 state.origin。
function moveAnnotationTo(point) {
  const state = pendingMove
  if (!state) return
  if (!state.thresholdPassed) {
    if (!movedBeyondThreshold(state.start, point, MOVE_THRESHOLD)) return
    state.thresholdPassed = true
  }
  const index = annotations.findIndex((item) => item.id === state.id)
  if (index < 0) return
  const dx = point.x - state.start.x
  const dy = point.y - state.start.y
  const moved = clampAnnotationToStage(
    state.part ? moveMagnifierPart(state.origin, state.part, dx, dy) : translateAnnotation(state.origin, dx, dy),
    stageRect()
  )
  if (!moved) return
  annotations[index] = moved
  selectedAnnotation = moved
  render()
}

// Feature D3: move ONE half of a magnifier. The shared module owns each translation, so a lens drag
// can never accidentally move the source rect (they are separate objects the user can place
// independently, §7.1) and a whole-object drag moves both by the same delta.
function moveMagnifierPart(item, part, dx, dy) {
  const api = magnifierApi()
  if (!api || item?.type !== 'magnifier') return translateAnnotation(item, dx, dy)
  if (part === 'lens') return api.translateLens(item, dx, dy)
  if (part === 'source') return api.translateSource(item, dx, dy)
  return api.translateMagnifier(item, dx, dy)
}

// Feature D3: "did this gesture actually move it?" A magnifier has no flat x/y, so the historical
// `item.x !== origin.x` test would always be false and a lens drag would never push an undo frame -
// a silent "the edit is not undoable" bug. Compare the nested geometry instead.
function annotationWasMoved(item, origin) {
  if (!item || !origin) return false
  if (item.type === 'magnifier' || origin.type === 'magnifier') {
    const api = magnifierApi()
    if (!api) return false
    const left = api.normalizeMagnifier(item)
    const right = api.normalizeMagnifier(origin)
    return left.sourceRect.x !== right.sourceRect.x || left.sourceRect.y !== right.sourceRect.y ||
      left.lensOrigin.x !== right.lensOrigin.x || left.lensOrigin.y !== right.lensOrigin.y
  }
  return item.x !== origin.x || item.y !== origin.y
}

// ---------- B7 (D11): pen endpoint continuation ----------

// A press within PEN_CONTINUATION_DISTANCE of either endpoint of the topmost stroke
// continues that stroke instead of starting a new one. The original leaves the layer
// list for the duration of the gesture (the growing stroke is the active annotation),
// keeps its z-index slot, and is superseded by commitAnnotation on pointerup - so the
// whole continuation is still exactly one undo frame.
function beginPenContinuation(item, point, event) {
  const index = annotations.indexOf(item)
  if (index < 0) return false
  const points = item.points.map((entry) => ({ x: entry.x, y: entry.y }))
  const first = points[0]
  const last = points[points.length - 1]
  const fromStart = Math.hypot(point.x-first.x, point.y-first.y) <= Math.hypot(point.x-last.x, point.y-last.y)
  if (fromStart) points.reverse()
  annotations.splice(index, 1)
  continuedPen = { item, index }
  activeAnnotation = Object.assign({}, item, {
    x: point.x, y: point.y, x2: point.x, y2: point.y,
    points: points.concat([{ x: point.x, y: point.y }])
  })
  try { canvas.setPointerCapture(event.pointerId) } catch {}
  render()
  return true
}

// pointercancel: the gesture never happened, so the original stroke comes back
// untouched and no frame is pushed (same rule as cancelMoveAnnotation).
function restoreContinuedPen() {
  if (!continuedPen) return
  const { item, index } = continuedPen
  continuedPen = null
  if (annotations.some((entry) => entry.id === item.id)) return
  annotations.splice(Math.max(0, Math.min(index, annotations.length)), 0, item)
}

// pointerup：只有真的产生了位移才压帧 —— 0 位移不制造无效 undo 步（方案 §8.4 PR2）。
// A1: a press that never crossed the threshold stays a plain click - the selection
// it made survives, but no move frame is pushed.
function finishMoveAnnotation() {
  const state = pendingMove
  pendingMove = null
  if (!state) return
  if (!state.thresholdPassed) { render(); return }
  const current = annotations.find((item) => item.id === state.id)
  if (current && annotationWasMoved(current, state.origin)) { flushCoalescedEdits(); snapshotAnnotations() }
  render()
}

// pointercancel：手势被中断 = 这次编辑作废，原对象放回数组且不压帧。
function cancelMoveAnnotation() {
  const state = pendingMove
  pendingMove = null
  if (!state) return
  const index = annotations.findIndex((item) => item.id === state.id)
  if (index >= 0) {
    annotations[index] = state.origin
    if (selectedAnnotation && selectedAnnotation.id === state.id) selectedAnnotation = state.origin
  }
  render()
}

// 方向键微调：1px，按住 Shift 10px。返回 true 表示这次按键已被消费。
// Ctrl/Alt/Meta 组合一律放行给既有快捷键（Ctrl+A/Z/Y/S 等），不做位移。
const NUDGE_DIRECTIONS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }

function nudgeSelectedAnnotation(event) {
  const direction = NUDGE_DIRECTIONS[event.key]
  if (!direction) return false
  if (event.ctrlKey || event.altKey || event.metaKey) return false
  const targets = selectedAnnotations()
  if (!targets.length) return false
  event.preventDefault()
  const step = event.shiftKey ? NUDGE_STEP_FAST : NUDGE_STEP
  // B6 (D8): the whole selection moves together and still merges into one undo frame.
  let moved = false
  targets.forEach((item) => {
    const index = annotations.indexOf(item)
    if (index < 0) return
    const next = clampAnnotationToStage(
      translateAnnotation(item, direction[0] * step, direction[1] * step),
      stageRect()
    )
    // 贴舞台边时 clamp 会把这一步位移吃掉 —— 此时不算位移，否则 500ms 后会压入与上一帧
    // 完全相同的快照，Ctrl+Z 变成空按（违反"0 位移不压帧"）。
    if (!next || !annotationWasMoved(next, item)) return
    annotations[index] = next
    if (selectedAnnotation && selectedAnnotation.id === item.id) selectedAnnotation = next
    moved = true
  })
  if (!moved) { render(); return true }
  nudgeDirty = true
  if (nudgeTimer) clearTimeout(nudgeTimer)
  nudgeTimer = setTimeout(commitNudge, NUDGE_COMMIT_DELAY)
  render()
  return true
}

// 微调静默收口：连续按键合并成一次可撤销操作。
function commitNudge() {
  if (nudgeTimer) { clearTimeout(nudgeTimer); nudgeTimer = 0 }
  if (!nudgeDirty) return
  nudgeDirty = false
  snapshotAnnotations()
  render()
}

// 别的编辑抢先压帧时丢掉待提交的微调（它的结果已包含在那一帧里）。
function cancelNudge() {
  if (nudgeTimer) { clearTimeout(nudgeTimer); nudgeTimer = 0 }
  nudgeDirty = false
}

// ---------- P0-5 PR3：选中元素的 8 手柄缩放 ----------

// 手柄命中：只用 annotationBounds（屏幕 CSS 坐标，方案 §8.3），不掺任何导出换算。
// 零尺寸元素拿不到手柄 —— 与 getResizeHandle() 自身的 no-op 条件（w<=0||h<=0）一致。
function selectedResizeHandle(point) {
  const item = selectedAnnotationItem()
  if (!item) return ''
  const bounds = annotationBounds(item)
  if (!bounds || bounds.w <= 0 || bounds.h <= 0) return ''
  return getResizeHandle(bounds, point, ELEMENT_HANDLE_HIT)
}

// 缩放中：每帧都从**未被改动的** state.origin / originBounds 重算，绝不就地改原对象，
// 所以反向拖拽（镜像）不会累积翻转、松开时也能可靠判断"到底变没变"。
// bounds 传**舞台**而不是选区（方案 §8.4 PR3）：缩放结果整体落在舞台内。
function resizeAnnotationTo(point) {
  const state = resizingAnnotation
  if (!state) return
  const index = annotations.findIndex((item) => item.id === state.id)
  if (index < 0) return
  const box = resizeSelection(state.originBounds, state.handle, point, { width: innerWidth, height: innerHeight })
  const resized = resizeAnnotationToBox(state.origin, box)
  if (!resized) return
  annotations[index] = resized
  selectedAnnotation = resized
  render()
}

// 只有真的产生了变化才值得压帧（与 PR2 的 annotationWasMoved 同一套 editDirty 口径）。
// 逐字段比较：text/serial 的缩放可能是"盒变了但字号/半径仍落在同一预设"→ 不该制造无效 undo 步。
function annotationWasResized(item, origin) {
  return JSON.stringify(item) !== JSON.stringify(origin)
}

// pointerup：有变化才压一帧快照（一次手势 = 一帧），0 变化不制造无效撤销步。
function finishResizeAnnotation() {
  const state = resizingAnnotation
  resizingAnnotation = null
  if (!state) return
  const current = annotations.find((item) => item.id === state.id)
  if (current && annotationWasResized(current, state.origin)) { flushCoalescedEdits(); snapshotAnnotations() }
  render()
}

// pointercancel：手势被中断 = 这次缩放作废，原对象放回数组且不压帧（与 PR2 cancel 同一口径）。
function cancelResizeAnnotation() {
  const state = resizingAnnotation
  resizingAnnotation = null
  if (!state) return
  const index = annotations.findIndex((item) => item.id === state.id)
  if (index >= 0) {
    annotations[index] = state.origin
    if (selectedAnnotation && selectedAnnotation.id === state.id) selectedAnnotation = state.origin
  }
  render()
}

// ---------- P0-5 PR4：层级 ↑↓ + 颜色/线宽作用于选中项 ----------

// 样式补丁落到**选中项**上：生成新副本 → 替换数组项（绝不就地改原对象，与 translateAnnotation /
// resizeAnnotationToBox 同一契约）。id 与 serial.number 等字段原样带过 —— 样式编辑不重编号。
// 补丁里的每一项都与现值相等时返回 false：0 变化不制造无效撤销步（与 PR2/PR3 的 editDirty 同口径）。
// B6 (D8): with more than one item selected the same patch lands on the whole selection,
// still as one undo frame - the pre-B6 single-item behaviour is passed through untouched.
function applyStyleToSelectedAnnotation(patch) {
  const item = selectedAnnotationItem()
  if (!item || !patch) return false
  const keys = Object.keys(patch)
  if (!keys.length) return false
  const selected = selectedAnnotations()
  if (selected.length > 1) return writeAnnotationStyles(selected, patch, keys, true)
  return writeAnnotationStyles([item], patch, keys, false)
}

// Does this tool own the patched field? Colour and width belong to every remembered
// style tool; the fields of the second row belong to the tool that declares them. B6
// uses this to let one patch cross a mixed-type selection without giving a pen a fill.
function ownsAnnotationField(tool, field) {
  if (field === 'color' || field === 'width') return TOOL_STYLE_TOOLS.includes(tool)
  const fields = TOOL_OPTION_FIELDS[tool]
  return !!fields && fields.includes(field)
}

// B6 (D8): the one write-back point for a style patch. Every target gets a fresh copy
// (never an in-place edit); the whole selection is written before a single render, so a
// multi-selection edit is still exactly one undo frame. `ownership` restricts a target
// to the fields its own tool owns (only the multi-selection path asks for that).
function writeAnnotationStyles(targets, patch, fields, ownership) {
  let changed = false
  targets.forEach((target) => {
    const keys = ownership ? fields.filter((key) => ownsAnnotationField(target.type, key)) : fields
    if (!keys.length || !keys.some((key) => target[key] !== patch[key])) return
    const index = annotations.indexOf(target)
    if (index < 0) return
    const styled = Object.assign({}, target)
    keys.forEach((key) => { styled[key] = patch[key] })
    annotations[index] = styled
    if (selectedAnnotation && selectedAnnotation.id === target.id) selectedAnnotation = styled
    changed = true
    // Brush plan (§5.2): a new object means the width/colour a mosaic patch was built
    // from may have changed; drop its cache entry with it.
    mosaicPatchCache.delete(target)
  })
  if (changed) render()
  return changed
}

// §4.4 (Snow 048583130): a style edit is ALSO a change of that tool's creation default.
// Snow computes `next_default = default.merged(style, properties)` before it paints the
// selected set, because editing the element only would leave the NEXT element the user
// draws in the old style until they first deselect - a semantic inconsistency of an
// existing feature, not a missing one. The owner is the tool the toolbar edits (the
// selected element's own tool, else the active tool), and only the fields that tool
// DECLARES are adopted, so a mixed selection can never teach a pen a fill or a rect an
// alpha. The discrete setters already write their tool block before they commit, so this
// adoption is a no-op for them; it exists for the continuous/staged path and for any
// future caller that reaches a commit without a default write. A field that already
// equals the remembered value is skipped instead of persisted again: one user action must
// never push the whole settings map twice (the contract's single-writer shape).
function writeSelectedStyleDefault(patch, persist) {
  const tool = toolbarStyleTool()
  if (!tool || !patch) return false
  const current = resolveToolStyle(tool, toolStyles[tool])
  const changed = Object.keys(patch).filter((key) => ownsAnnotationField(tool, key) && current[key] !== patch[key])
  if (!changed.length) return false
  const next = {}
  changed.forEach((key) => { next[key] = patch[key] })
  writeToolStyle(tool, next, persist)
  return true
}

// 离散样式操作（线宽按钮）：立刻压一帧。若还有未收口的颜色改动，先把它单独收一帧 —— 两次
// 用户操作不该挤进同一个撤销步（这正是"undo/redo 不串"）。
function commitSelectedStyle(patch) {
  // 待收口的微调/样式先各自成帧，再压这次离散样式改动 —— 保证"一次用户操作一帧"。
  flushCoalescedEdits()
  writeSelectedStyleDefault(patch, true)
  if (!applyStyleToSelectedAnnotation(patch)) return false
  snapshotAnnotations()
  render()
  return true
}

// §4.4: the picker drag is a user style edit even before it settles, so the tool's
// creation default follows it in memory. Persistence deliberately stays on the `change`
// path (setAnnotationColor(..., true)): a picker drag fires input at mouse rate, and a
// trailing commit must not turn one gesture into one settings:update per event - the
// same discipline as scheduleAnnotationWidthPersist for the wheel.
// 连续样式操作（取色器 input）：应用即时可见，快照静默 STYLE_COMMIT_DELAY 毫秒后收口；
// 取色器关闭时触发的 change 会立刻收口（见文件末尾的 colorInput 监听）。
function stageSelectedStyle(patch) {
  writeSelectedStyleDefault(patch, false)
  if (!applyStyleToSelectedAnnotation(patch)) return false
  styleDirty = true
  if (styleTimer) clearTimeout(styleTimer)
  styleTimer = setTimeout(commitStyle, STYLE_COMMIT_DELAY)
  return true
}

// 丢掉"待收口的样式帧"（**不**还原已应用的样式）：它的结果已经包含在别的帧里时用。
function cancelStyleCommit() {
  if (styleTimer) { clearTimeout(styleTimer); styleTimer = 0 }
  styleDirty = false
}

// 把"已应用但未收口"的样式改动压成一帧；没有待收口改动时是 no-op。
function commitStyle() {
  if (styleTimer) { clearTimeout(styleTimer); styleTimer = 0 }
  if (!styleDirty) return false
  styleDirty = false
  snapshotAnnotations()
  render()
  return true
}

// 层级 ↑↓：只改数组顺序（§8.1 下标即 z 序）。renderOverlay() 与 exportSelectionCanvas() 都是
// 顺序 forEach，所以屏幕层序与导出层序同时改变 —— 绘制代码一行都不用动。一次操作一帧快照；
// 边界 no-op（已在最上/最下层）不压帧；syncSelectedAnnotation() 让选中项跟着新数组重新解析。
function reorderSelectedAnnotation(direction) {
  const item = selectedAnnotationItem()
  if (!item) return
  const ordered = reorderAnnotation(annotations, annotations.indexOf(item), direction)
  if (ordered.every((entry, position) => entry === annotations[position])) return
  flushCoalescedEdits()
  annotations = ordered
  snapshotAnnotations()
  syncSelectedAnnotation()
  render()
}

function resetAnnotationState() {
  annotations = []
  selectedAnnotation = null
  selectedIds = new Set()
  pendingMove = null
  resizingAnnotation = null
  // B7: a continuation that never settled belongs to the previous capture.
  continuedPen = null
  cancelNudge()
  // PR4：新一次截图不得让上一张的样式计时器落进这一次的历史里。
  cancelStyleCommit()
  // A2: a pending width write belongs to the previous capture.
  cancelAnnotationWidthPersist()
  // B6 wave 2: a marquee that never settled belongs to the previous capture.
  marquee = null
  annotationHistory = [[]]
  historyIndex = 0
  invalidateElementBarSize()
  // Brush plan (§5.2): patches belong to the previous capture's annotation objects.
  invalidateMosaicPatches()
  // Feature C: a new capture gets a new style session (fresh timeline + the persisted preset), so
  // the previous screenshot's card can never leak into this one's undo history.
  resetOutputStyleState()
  // Feature D3: the in-progress magnifier gesture and the sample cache belong to the previous image.
  magnifierBuild = null
  magnifierDrag = null
  magnifierFactor = 2
  magnifierConnector = 'none'
  releaseLensSampler()
  if (magnifierPanel) magnifierPanel.classList.add('hidden')
  setMagnifierStatus('', null, false)
}

function commitAnnotation(item) {
  if (!item) return
  item.id = ++annotationSeq
  annotations.push(item)
  activeAnnotation = null
  // B7: the gesture ended in a commit, so the continued original is superseded for good.
  continuedPen = null
  flushCoalescedEdits()
  snapshotAnnotations()
  render()
}

function clampSettingNumber(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function watermarkParams() {
  return {
    content: watermarkContentInput.value.trim(),
    opacity: clampSettingNumber(watermarkOpacityInput.value, 80, 5, 100),
    color: /^#[0-9a-fA-F]{6}$/.test(watermarkColorInput.value) ? watermarkColorInput.value : '#ffffff',
    spacing: clampSettingNumber(watermarkSpacingInput.value, 30, 5, 100),
    fontSize: clampSettingNumber(watermarkFontSizeInput.value, 24, 8, 200),
    rotation: clampSettingNumber(watermarkRotationInput.value, 30, -180, 180),
    dateSuffix: watermarkDateSuffixInput.checked
  }
}

function buildWatermarkAnnotation() {
  if (!selection) return null
  const params = watermarkParams()
  if (!params.content && !params.dateSuffix) return null
  return { type: 'watermark', x: selection.x, y: selection.y, w: selection.w, h: selection.h, ...params }
}

function applyWatermarkSettings(settings) {
  if (!settings || typeof settings !== 'object') return
  watermarkContentInput.value = String(settings.content ?? '')
  watermarkOpacityInput.value = String(clampSettingNumber(settings.opacity, 80, 5, 100))
  watermarkColorInput.value = /^#[0-9a-fA-F]{6}$/.test(String(settings.color || '')) ? String(settings.color) : '#ffffff'
  watermarkSpacingInput.value = String(clampSettingNumber(settings.spacing, 30, 5, 100))
  watermarkFontSizeInput.value = String(clampSettingNumber(settings.fontSize, 24, 8, 200))
  watermarkRotationInput.value = String(clampSettingNumber(settings.rotation, 30, -180, 180))
  watermarkDateSuffixInput.checked = Boolean(settings.dateSuffix)
  watermarkOpacityValue.textContent = `${watermarkOpacityInput.value}%`
  watermarkSpacingValue.textContent = `${watermarkSpacingInput.value}%`
}

function updateWatermarkPreview() {
  watermarkOpacityValue.textContent = `${watermarkOpacityInput.value}%`
  watermarkSpacingValue.textContent = `${watermarkSpacingInput.value}%`
  if (currentTool !== 'watermark') return
  activeAnnotation = buildWatermarkAnnotation()
  render()
}

function syncWatermarkPanel() {
  const visible = currentTool === 'watermark' && !!selection && !toolbar.classList.contains('hidden')
  watermarkPanel.classList.toggle('hidden', !visible)
  if (!visible) return
  const barRect = toolbar.getBoundingClientRect()
  const panelRect = watermarkPanel.getBoundingClientRect()
  const left = Math.max(6, Math.min(barRect.left, innerWidth - panelRect.width - 6))
  let top = barRect.bottom + 6
  if (top + panelRect.height > innerHeight - 6) top = Math.max(6, barRect.top - panelRect.height - 6)
  watermarkPanel.style.left = `${Math.round(left)}px`
  watermarkPanel.style.top = `${Math.round(top)}px`
}

// Feature D3 (plan §7.1): the magnifier attribute panel. It is a sibling of the watermark panel
// rather than a tool-option group: #toolOptions is a projection of `data-option-tools`, and the
// magnifier's factor/connector are properties of the OBJECT, not of the next stroke.
//
// Visibility rule: the magnifier tool is active, or a magnifier is selected (so editing one after
// switching back to the select tool does not require re-picking the tool).
function magnifierPanelVisible() {
  if (!selection || toolbar.classList.contains('hidden')) return false
  if (activeOcrResult || processingAction) return false
  if (selectState === 'auto' || selecting || dragging || resizing) return false
  return currentTool === 'magnifier' || !!selectedMagnifier()
}

function setMagnifierStatus(key, params, isError) {
  if (!magnifierStatusEl) return
  magnifierStatusEl.textContent = key ? t(key, params) : ''
  magnifierStatusEl.classList.toggle('hidden', !key)
  magnifierStatusEl.classList.toggle('error', isError === true)
}

function syncMagnifierPanel() {
  if (!magnifierPanel) return
  const visible = magnifierPanelVisible()
  magnifierPanel.classList.toggle('hidden', !visible)
  if (!visible) return
  const item = selectedMagnifier()
  const factor = item ? item.factor : magnifierFactor
  const connector = item ? item.connector : magnifierConnector
  const width = item ? item.stroke.widthPx : Math.max(1, Math.round(annotationWidth))
  for (const button of magnifierFactorButtons) {
    const active = Number(button.dataset.magnifierFactor) === factor
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', String(active))
  }
  for (const button of magnifierConnectorButtons) {
    const active = button.dataset.magnifierConnector === connector
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', String(active))
  }
  if (magnifierStrokeWidthInput && document.activeElement !== magnifierStrokeWidthInput) {
    magnifierStrokeWidthInput.value = String(width)
  }
  if (magnifierStrokeWidthValue) magnifierStrokeWidthValue.textContent = `${width}px`
  const barRect = toolbar.getBoundingClientRect()
  const panelRect = magnifierPanel.getBoundingClientRect()
  const left = Math.max(6, Math.min(barRect.left, innerWidth - panelRect.width - 6))
  let top = barRect.bottom + 6
  if (top + panelRect.height > innerHeight - 6) top = Math.max(6, barRect.top - panelRect.height - 6)
  magnifierPanel.style.left = `${Math.round(left)}px`
  magnifierPanel.style.top = `${Math.round(top)}px`
}

// A factor/connector click while a magnifier is selected edits THAT object in one undo frame; with
// nothing selected it only changes the default for the next one (no frame - nothing was edited).
function chooseMagnifierFactor(factor) {
  const api = magnifierApi()
  if (!api) return
  magnifierFactor = api.normalizeMagnifier({ factor }).factor
  if (selectedMagnifier()) editSelectedMagnifier({ factor: magnifierFactor })
  else { syncMagnifierPanel(); setMagnifierStatus('', null, false) }
}

function chooseMagnifierConnector(connector) {
  magnifierConnector = connector === 'line' ? 'line' : 'none'
  if (selectedMagnifier()) editSelectedMagnifier({ connector: magnifierConnector })
  else { syncMagnifierPanel(); setMagnifierStatus('', null, false) }
}

function finishSelection() {  // A tool strip that just moved must not leave the image-to-document popover floating
  // over the new region (it is positioned from the old toolbar rect).
  closeConvertDocMenu()
  render()
  if(selection&&initData?.autoAction&&!autoActionStarted){autoActionStarted=true;setTimeout(()=>performAction(initData.autoAction),80)}
}

// B4 (D7): load the per-tool styles for this capture. A store without the structured
// key is the migration path: every tool is seeded from the legacy scalars, once, and
// nothing is written back until the user edits a style.
function applyAnnotationStyles(settings) {
  const stored = settings?.screenshot?.annotationStyles
  const hasStructured = !!stored && typeof stored === 'object' && !Array.isArray(stored)
  toolStyles = hasStructured ? Object.assign({}, stored) : {}
  const legacyColor = normalizeAnnotationColor(settings?.screenshot?.annotationColor)
  const legacyWidth = resolveAnnotationWidth(settings?.screenshot?.annotationWidth)
  annotationColor = legacyColor
  annotationWidth = legacyWidth
  if (!hasStructured) {
    TOOL_STYLE_TOOLS.forEach((tool) => { toolStyles[tool] = { color: legacyColor, width: legacyWidth } })
  }
  syncToolbarStyleFromSelection()
}

function applySmartCandidates(candidates) {
  smartCandidates=(Array.isArray(candidates)?candidates:[]).filter((item)=>item&&item.w>=3&&item.h>=3)
  smartCandidateLevel=0
  selection=smartCandidates.length?{...smartCandidates[0]}:null
  render()
}

async function requestSmartSelection(point) {
  if(selectState!=='auto'||!initData?.smartSelect)return
  smartQueryPending={x:point.x,y:point.y}
  if(smartQueryRunning)return
  smartQueryRunning=true
  try{
    while(smartQueryPending){
      const current=smartQueryPending;smartQueryPending=null
      try{
        const candidates=await window.captureAPI.smartSelectAt(current)
        if(selectState==='auto'&&!smartQueryPending)applySmartCandidates(candidates)
      }catch{}
    }
  }finally{smartQueryRunning=false}
}


// ---------- Brush plan (§3.3): sampling a freehand stroke ----------

// Appends the pointer samples between two events. `getCoalescedEvents()` is what makes a
// fast flick a curve instead of a polygon: a high-refresh screen can otherwise deliver
// samples 20-40px apart (§3.3). Browsers without it fall back to the event itself.
function strokeSamples(event, point) {
  let samples = null
  try { samples = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : null } catch {}
  if (!samples || !samples.length) return [point]
  const collected = []
  for (const sample of samples) {
    const x = Number(sample.clientX)
    const y = Number(sample.clientY)
    if (Number.isFinite(x) && Number.isFinite(y)) collected.push({ x, y })
  }
  return collected.length ? collected : [point]
}

// One pointermove worth of samples. The bounding box (x2/y2) follows the LAST accepted
// sample and the point set is filtered by STROKE_MIN_STEP, so joggle and duplicate events
// do not burn the MAX_PEN_POINTS budget. The filter is deliberately brush-only: the pen
// keeps the exact sampling it shipped with (§3.3, D5).
function appendStrokePoint(point, event) {
  const item = activeAnnotation
  if (!item) return
  const samples = STROKE_TOOL_SET.has(item.type) ? strokeSamples(event, point) : [point]
  const last = samples[samples.length - 1]
  item.x2 = last.x
  item.y2 = last.y
  if (!Array.isArray(item.points)) return
  for (const sample of samples) {
    if (item.points.length >= MAX_PEN_POINTS) return
    const tail = item.points[item.points.length - 1]
    if (tail && Math.hypot(sample.x - tail.x, sample.y - tail.y) < STROKE_MIN_STEP) continue
    item.points.push({ x: sample.x, y: sample.y })
  }
}

// pointermove self-heal (D7): settle the stroke so the ink stops following a pointer whose
// button was released without a pointerup. Same rule as the other self-heals above it.
function finishStrokeAnnotation() {
  if (!activeAnnotation || activeAnnotation.type === 'watermark') return
  commitAnnotation(activeAnnotation)
}

// A1 (D1): the right button is a quick-select + drag gesture in every tool
// (Snow Shot's quick_selection). It never draws and never re-runs the region
// selection, which is why it lives in front of every tool branch below.
function quickSelectAnnotation(event, point) {
  if (selectState === 'auto') return
  const hit = findAnnotationAt(annotations, point)
  if (hit) {
    // B6 (D8): shift+right-click extends the selection; the press still starts a move
    // on the item it grabbed (a right press never removes anything from the set).
    if (event.shiftKey) addSelectedAnnotation(hit)
    else setSelectedAnnotation(hit)
    beginPendingMove(hit, point, event, magnifierPartAt(hit, point))
    return
  }
  if (currentTool === 'select') setSelectedAnnotation(null)
}

// Feature D3 (plan §7.1): which half of a magnifier a press grabbed.
//
// The shared hit test owns the geometry (lens wins over source when they overlap, because the lens
// is drawn on top). A connector press drags the LENS: the connector belongs to the lens side (it is
// drawn from the source's centre to the lens's centre), so grabbing the line and having the source
// slide instead would feel like the wrong half moved.
function magnifierPartAt(item, point) {
  const api = magnifierApi()
  if (!api || item?.type !== 'magnifier') return ''
  const zoom = documentEditor && documentViewport() ? documentViewport().zoom : 1
  // The tolerance is a viewport-CSS constant, so it has to be divided by the zoom before it means
  // anything in the annotation's own space.
  const part = api.hitTestMagnifier(item, point, FRAME_HIT_TOLERANCE / Math.max(1e-6, zoom))
  if (part === 'connector') return 'lens'
  return part || ''
}

canvas.addEventListener('pointerdown',(event)=>{
  if (!resultPanel.classList.contains('hidden')) return
  if(activeOcrResult){clearOcrResult();return}
  const point=pointFromEvent(event); startPoint=point
  // PR2 防御：上一次元素拖动若没等到 pointerup（被模态框/系统手势吞掉），新一次按下先把它
  // 收口，避免两个手势叠在同一个 pendingMove 上（选区拖动有同款自愈，见 pointermove）。
  if(pendingMove)finishMoveAnnotation()
  // PR3 同款防御：上一次元素缩放没收到 pointerup 时先收口。
  if(resizingAnnotation)finishResizeAnnotation()
  // A1 (D1): only the primary button edits. The right button is handled above every
  // tool branch (quick select + drag); any other button is ignored, so a stray
  // middle-drag can no longer create an annotation.
  if(event.button!==0){if(event.button===2)quickSelectAnnotation(event,point);return}
  if(selectState==='auto'){pointerDownPoint=point;return}
  const resizeHandle=currentTool==='select'?getResizeHandle(selection,point):''
  // A5 (D10): a select-tool press that misses the region still selects an element.
  // Dragging an element out of the region used to make it unreachable - the next
  // press re-ran "replace the region" (and asked to discard every annotation)
  // before the element could ever be hit again. The selection handle keeps its
  // priority through the !resizeHandle guard.
  const outsideSelection=currentTool==='select'&&!resizeHandle&&!insideSelection(point)
  if (outsideSelection) {
    const outsideHit=findAnnotationAt(annotations,point)
    if(outsideHit){
      // B6 (D8): shift extends the selection here too, but without starting a move -
      // the item the user just added must not be dragged away by the same gesture.
      if(event.shiftKey){toggleSelectedAnnotation(outsideHit);updateSelectionCursor(point);return}
      setSelectedAnnotation(outsideHit);beginPendingMove(outsideHit,point,event);return
    }
  }
  if (!selection || outsideSelection) {
    // D4 落地项：重划选区会丢弃全部已提交标注 —— 先弹确认；取消则标注与选区都保持原状。
    if(!confirmDiscardAnnotations())return
    selectState='manual';selecting=true; selection={x:point.x,y:point.y,w:0,h:0}; clearAnnotationsForNewSelection(); tip.style.display='none'; canvas.style.cursor='crosshair'; render(); return
  }
  if (resizeHandle) { resizing={handle:resizeHandle,initial:{...selection}}; updateSelectionCursor(point); try{canvas.setPointerCapture(event.pointerId)}catch{}; render(); return }
  if (currentTool==='select') {
    // PR2 Lead 决策：按住 Alt 在选区内拖动 = 直接移动选区。PR1 让"元素命中"优先于拖选区，
    // 当 watermark（按设计铺满整个选区）或大范围 blur 覆盖选区时，用户将无法移动选区；Alt 是
    // 逃生门，它跳过下面所有元素分支，直接落到既有的选区拖动路径（提示见 #elementBar）。
    if(event.altKey){setSelectedAnnotation(null);dragging=true;return}
    // PR3 选中元素手柄（8 手柄缩放）：优先级 = 选区手柄 > **选中元素手柄** > 元素体内 > 元素命中。
    // 命中与缩放一律屏幕 CSS 坐标；resizeSelection 的 bounds 传**舞台**（见 resizeAnnotationTo）。
    const elementHandle=selectedResizeHandle(point)
    if(elementHandle){const target=selectedAnnotationItem();resizingAnnotation={id:target.id,origin:target,originBounds:annotationBounds(target),handle:elementHandle};try{canvas.setPointerCapture(event.pointerId)}catch{};updateSelectionCursor(point);render();return}
    // PR2 元素体内拖动：点落在**已选中**元素的 annotationBounds 内 → 进入 move 态。
    // B6 (D8): any selected element accepts the body press. Shift over one of them
    // removes it from the selection instead of starting a move (the standard toggle).
    const bodyItem=selectedAnnotations().find((entry)=>pointInAnnotationBounds(entry,point))
    if(bodyItem&&event.shiftKey){toggleSelectedAnnotation(bodyItem);updateSelectionCursor(point);return}
    if(bodyItem){beginPendingMove(bodyItem,point,event,magnifierPartAt(bodyItem,point));return}
    // PR1 元素命中（逆序取最上层）→ 选中；未命中才退回"拖选区"。
    const hit=findAnnotationAt(annotations,point)
    if(hit){
      // B6 (D8): shift+click toggles the hit item in or out of the selection.
      if(event.shiftKey){toggleSelectedAnnotation(hit);updateSelectionCursor(point);return}
      setSelectedAnnotation(hit)
      // Feature D3: a magnifier is grabbed by one of its halves, so the press that just selected it
      // also starts the move it asked for (a plain click stays a click thanks to the threshold).
      const part=magnifierPartAt(hit,point)
      if(part){beginPendingMove(hit,point,event,part);return}
      updateSelectionCursor(point);return
    }
    // B6 wave 2 (D8): shift on empty space starts a marquee instead of moving the
    // region - it must run BEFORE the deselect below, because the marquee adds to the
    // current selection. The plain region-drag path stays untouched.
    if(event.shiftKey){beginMarquee(point,event);return}
    setSelectedAnnotation(null)
    dragging=true; return
  }
  if (currentTool==='watermark') return
  if (!insideSelection(point)) return
  const style=annotationStyle()
  if (currentTool==='text') { const text=prompt(t('capture.input.text')); if(text)commitAnnotation({type:'text',x:point.x,y:point.y,text,...style}); return }
  if (currentTool==='serial') { commitAnnotation({type:'serial',x:point.x,y:point.y,number:serialNumber++,...style}); return }
  // Feature D3 (§7.1): the magnifier gesture is "drag the source area first". The lens is positioned
  // by createFromSourceRect() at pointerup - once, from the final rect - so it cannot jitter around
  // while the user is still shaping the source area. `magnifierBuild` carries the press origin.
  if (currentTool==='magnifier') { magnifierBuild={start:point,current:point}; activeAnnotation=buildMagnifierDraft(point); magnifierDrag='source'; try{canvas.setPointerCapture(event.pointerId)}catch{}; render(); return }
  // B7 (D11): a pen press on either endpoint of the topmost stroke continues it.
  if (currentTool==='pen') {
    const target=penContinuationTarget(annotations,point,PEN_CONTINUATION_DISTANCE)
    if(target&&beginPenContinuation(target,point,event))return
  }
  activeAnnotation={type:currentTool,x:point.x,y:point.y,x2:point.x,y2:point.y,...style}
  if (STROKE_TOOL_SET.has(currentTool)) activeAnnotation.points=[{x:point.x,y:point.y}]
})

// Feature D3 (plan §7.1): the magnifier gesture.
//
// Two phases, and the split is deliberate:
//   * while dragging, the DRAFT only tracks the source rect (`magnifierBuild`), so the picture the
//     user is framing follows the pointer and nothing else moves;
//   * at pointerup, `createFromSourceRect` positions the lens once from the FINAL rect, so the lens
//     does not jump around during the drag (a lens that re-derives its origin from the gap on every
//     pointermove visibly shivers when the drag reverses direction).
//
// The lens itself is drawn at its default offset while dragging (right/below the source, flipping
// when it would leave the region), because a user needs to SEE where the lens will land before
// releasing - a draft with no lens would look like the tool did nothing.
function buildMagnifierDraft(point) {
  const api = magnifierApi()
  const build = magnifierBuild
  if (!api || !build) return null
  const rect = normalizeRect(build.start, point)
  const created = api.createFromSourceRect(
    { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
    { factor: magnifierFactor, crop: magnifierCropForLens(), stroke: magnifierStrokeStyle(), connector: magnifierConnector }
  )
  // A source rect smaller than the legal minimum cannot become a magnifier; show nothing rather than
  // a degenerate object the user would have to undo.
  if (!created) return null
  return Object.assign({ id: -1 }, created)
}

// The lens must be bounded by the exported content, not by the window: in a document editor that is
// the document crop; in a plain capture window it is the selection's pixel rect expressed in the
// window's own CSS space (which is what the annotations live in).
function magnifierCropForLens() {
  if (documentEditor) return documentCrop()
  if (!selection) return null
  return { x: selection.x, y: selection.y, w: selection.w, h: selection.h }
}

function magnifierStrokeStyle() {
  return { color: annotationColor, widthPx: Math.max(1, Math.round(annotationWidth)) }
}

// Commit the pending magnifier draft as one undo frame. Returns true when something was committed.
function commitMagnifierDraft() {
  const api = magnifierApi()
  const draft = activeAnnotation
  const build = magnifierBuild
  magnifierBuild = null
  magnifierDrag = null
  activeAnnotation = null
  if (!api || !draft || !build) { render(); return false }
  if (magnifierCount() >= api.MAX_PER_DOCUMENT) {
    // §3.3 budget: refuse rather than silently drop the oldest lens. The message names the limit.
    setMagnifierStatus('capture.magnifier.limit', { max: api.MAX_PER_DOCUMENT }, true)
    render()
    return false
  }
  // Re-derive from the final rect so the stored object is exactly what createFromSourceRect says it
  // should be (the draft's lens is a preview placement, not the committed one).
  const final = api.createFromSourceRect(
    { x: draft.sourceRect.x, y: draft.sourceRect.y, w: draft.sourceRect.w, h: draft.sourceRect.h },
    { factor: draft.factor, crop: magnifierCropForLens(), stroke: draft.stroke, connector: draft.connector }
  )
  if (!final) { render(); return false }
  commitAnnotation(final)
  setMagnifierStatus('', null, false)
  syncMagnifierPanel()
  return true
}

function magnifierCount() {
  return annotations.filter((item) => item?.type === 'magnifier').length
}

// Feature D3: which magnifier (if any) the attribute panel is editing - the selected one.
function selectedMagnifier() {
  const item = selectedAnnotationItem()
  return item && item.type === 'magnifier' ? item : null
}

// Apply a change to the selected magnifier as ONE undo frame. The shared module owns each operation
// (withFactor keeps the lens centre, clipToCrop keeps it inside the region), so this only picks one.
function editSelectedMagnifier(patch) {
  const api = magnifierApi()
  const item = selectedMagnifier()
  if (!api || !item) return false
  let next = item
  if (patch.factor !== undefined) next = api.withFactor(next, patch.factor)
  if (patch.stroke) next = Object.assign({}, next, { stroke: Object.assign({}, next.stroke, patch.stroke) })
  if (patch.connector !== undefined) next = Object.assign({}, next, { connector: patch.connector })
  const index = annotations.indexOf(item)
  if (index < 0) return false
  // Keep the id: it is the only link the selection set has to the new object.
  const committed = Object.assign({}, next, { id: item.id })
  const clipped = api.clipToCrop(committed, magnifierCropForLens())
  if (!clipped.ok) {
    setMagnifierStatus('capture.magnifier.outside', null, true)
    return false
  }
  flushCoalescedEdits()
  annotations[index] = clipped.magnifier
  selectedAnnotation = clipped.magnifier
  snapshotAnnotations()
  render()
  syncMagnifierPanel()
  return true
}

canvas.addEventListener('pointermove',(event)=>{
  const point=pointFromEvent(event)
  if(selectState==='auto'){
    if(pointerDownPoint){
      if(Math.hypot(point.x-pointerDownPoint.x,point.y-pointerDownPoint.y)>6){if(!confirmDiscardAnnotations()){pointerDownPoint=null;return}selectState='manual';selecting=true;startPoint=pointerDownPoint;pointerDownPoint=null;selection=normalizeRect(startPoint,point);clearAnnotationsForNewSelection();smartCandidates=[];tip.style.display='none';render()}
    }else requestSmartSelection(point)
    return
  }
  // D4 副作用防护：pointerdown 里的 confirm() 是主线程模态对话框，用户点掉它时那次
  // pointerup 可能交不回页面（Chromium 把它交给了对话框），拖拽态就会一直挂着、选区
  // 跟着没按键的鼠标乱跑。没有按键按下的 move 说明按钮已经抬起 —— 按 pointerup 的
  // 收尾动作补一次隐式结束。
  if ((selecting||dragging||resizing)&&event.buttons===0) {
    if(selecting){selecting=false;if(selection&&(selection.w<3||selection.h<3))selection=null;selectState=selection?'selected':'manual'}
    if(dragging)dragging=false
    if(resizing)resizing=null
    finishSelection(); updateSelectionCursor(point); return
  }
  // PR2/A1 同款自愈：元素拖动期间 pointerup 被吞掉时，没有按键的 move 也要把这次拖动收口。
  if (pendingMove&&event.buttons===0) { finishMoveAnnotation(); updateSelectionCursor(point); return }
  // PR3 同款自愈：元素缩放期间 pointerup 被吞掉时同样要收口。
  if (resizingAnnotation&&event.buttons===0) { finishResizeAnnotation(); updateSelectionCursor(point); return }
  // B6 wave 2 self-heal: a swallowed pointerup during a marquee also settles it
  // (the current point is the final corner).
  if (marquee&&event.buttons===0) { finishMarquee(point); updateSelectionCursor(point); return }
  // Feature D3: the magnifier draft follows the pointer by re-deriving the SOURCE rect only. The lens
  // is placed once at commit time (see buildMagnifierDraft) so it cannot shiver mid-drag.
  if (magnifierBuild) { magnifierBuild.current=point; activeAnnotation=buildMagnifierDraft(point); render(); return }
  if (selecting) { selection=normalizeRect(startPoint,point); render(); return }
  if (resizing&&selection) { selection=resizeSelection(resizing.initial,resizing.handle,point,{width:innerWidth,height:innerHeight}); updateSelectionCursor(point); render(); return }
  if (pendingMove) { moveAnnotationTo(point); return }
  // PR3 元素缩放：新 box 由 resizeSelection 在**舞台**坐标系里算出，再交给纯函数写回新对象。
  if (resizingAnnotation) { resizeAnnotationTo(point); updateSelectionCursor(point); return }
  if (dragging&&selection) { const dx=point.x-startPoint.x,dy=point.y-startPoint.y; selection.x=Math.max(0,Math.min(innerWidth-selection.w,selection.x+dx)); selection.y=Math.max(0,Math.min(innerHeight-selection.h,selection.y+dy)); startPoint=point; render(); return }
  // B6 wave 2: the marquee grows with the pointer and repaints itself (no frame).
  if (marquee) { updateMarquee(point); return }
  // Brush plan (D7): a swallowed pointerup during a stroke leaves the ink following a
  // button-less pointer. Same self-heal the three state-machine paths above already have;
  // the stroke stays (it is dropped only on pointercancel), it just stops growing.
  if (activeAnnotation && event.buttons === 0 && activeAnnotation.type !== 'watermark') { finishStrokeAnnotation(); updateSelectionCursor(point); return }
  if (activeAnnotation) { appendStrokePoint(point, event); render() }
  else updateSelectionCursor(point)
})


canvas.addEventListener('pointerup',(event)=>{
  if(selectState==='auto'&&pointerDownPoint){const point=pointFromEvent(event);const moved=Math.hypot(point.x-pointerDownPoint.x,point.y-pointerDownPoint.y)>6;pointerDownPoint=null;if(moved){selectState='selected';selection=normalizeRect(startPoint,point);if(selection.w<3||selection.h<3)selection=null}else if(selection){selectState='selected'}tip.style.display='none';finishSelection();updateSelectionCursor(point);return}
  if(selecting){const point=pointFromEvent(event);selecting=false;if(selection.w<3||selection.h<3)selection=null;selectState=selection?'selected':'manual';finishSelection();updateSelectionCursor(point);return}
  if(resizing){resizing=null;finishSelection();updateSelectionCursor(pointFromEvent(event));return}
  if(pendingMove){finishMoveAnnotation();updateSelectionCursor(pointFromEvent(event));return}
  if(resizingAnnotation){finishResizeAnnotation();updateSelectionCursor(pointFromEvent(event));return}
  if(marquee){const point=pointFromEvent(event);finishMarquee(point);updateSelectionCursor(point);return}
  if(dragging){dragging=false;render();updateSelectionCursor(pointFromEvent(event));return}
  // Feature D3: the magnifier draft commits from its FINAL rect (lens placed once, §7.1).
  if(magnifierBuild){commitMagnifierDraft();updateSelectionCursor(pointFromEvent(event));return}
  if(activeAnnotation&&activeAnnotation.type!=='watermark')commitAnnotation(activeAnnotation)
})

canvas.addEventListener('pointercancel',()=>{
  selecting=false
  dragging=false
  resizing=null
  cancelMoveAnnotation()
  cancelResizeAnnotation()
  // B7: an interrupted continuation puts the original stroke back (no frame).
  restoreContinuedPen()
  // B6 wave 2: an interrupted marquee edits nothing (no frame).
  cancelMarquee()
  // Feature D3: an interrupted magnifier draft is discarded, exactly like a stroke that never
  // settled - the gesture produced no object and therefore no frame.
  magnifierBuild=null
  magnifierDrag=null
  activeAnnotation=currentTool==='watermark'?buildWatermarkAnnotation():null
  render()
})

canvas.addEventListener('wheel',(event)=>{
  // A2: the smart-selection stepper keeps priority in auto mode.
  if(selectState==='auto'){
    if(smartCandidates.length<2)return
    event.preventDefault()
    const delta=event.deltaY<0?1:-1
    smartCandidateLevel=Math.max(0,Math.min(smartCandidates.length-1,smartCandidateLevel+delta))
    selection={...smartCandidates[smartCandidateLevel]}
    render()
    return
  }
  // A2: otherwise the wheel steps the stroke width (up = thicker, same direction as
  // the smart-selection stepper) and a stroke being drawn right now follows along.
  if(!canStepAnnotationWidth())return
  event.preventDefault()
  const width=nextWidthPreset(displayedToolWidth(),event.deltaY<0?1:-1)
  setAnnotationWidth(width)
  if(activeAnnotation&&activeAnnotation.type!=='watermark')activeAnnotation.width=width
  scheduleAnnotationWidthPersist()
  render()
},{passive:false})

canvas.addEventListener('dblclick',()=>{ if(selection&&initData?.settings?.screenshot?.doubleClickCopy) performAction('copy') })

// §3.2②: the pixel consumers (copy/save/pdf/ocr) all read ONE captured image, which
// still covers only the current display. A level-2 Ctrl+A selection reaches past it by
// design ("bounds only" - see desktopSelectionBounds), so every pixel path works on the
// intersection. The crop already clamps inside getSourcePixelRect, but the annotation
// transform inside exportSelectionCanvas reads the global `selection`; without this
// projection every annotation would be drawn at the union scale (half size on a
// 3840-wide union) and shifted by a negative origin, i.e. a corrupt copy instead of a
// merely narrower one. Returns the SAME object when the selection already sits inside
// the image, so every shipped flow is untouched.
function exportSelectionRect() {
  const projected = selectionInsideImage(selection, imageDisplayBounds())
  if (!projected) return selection
  const same = projected.x === selection.x && projected.y === selection.y &&
    projected.w === selection.w && projected.h === selection.h
  return same ? selection : projected
}

// Feature C (plan §6.1/§6.3): the ONE finished-look entry point for every pixel consumer.
// `composeOutputCanvas` returns null in original mode, in which case the caller keeps the content
// canvas it already had - that is what makes "original is pixel-identical to v1" a property of the
// code path rather than a promise. An over-budget result is reported, never silently scaled: the
// export falls back to the original and the user is told (plan §3.3 "boundaries must be visible").
function composeFinishedOutput(contentCanvas, outputStyle) {
  const compositor = window.captureOutputCompositor
  if (!contentCanvas || !compositor) return null
  try {
    return compositor.composeOutputCanvas({ contentCanvas, outputStyle })
  } catch (error) {
    if (error?.code === 'output-too-large') {
      setOutputStyleStatus('capture.output.too-large', { width: error.width, height: error.height }, true)
    }
    return null
  }
}

// The projection is applied around the one synchronous export call and swapped back
// immediately: no await runs inside the window, and rAF cannot interleave, so no frame
// ever observes the projected rectangle (the selection drawn on screen, handles
// included, stays the all-displays one the user asked for). `rect` is passed in so the
// caller can record the exact rectangle it exported into the consumer metadata.
//
// Feature C: `options.compose` is an EXPLICIT dimension of its own, never inferred from the action
// and never folded into `includeAnnotations`. The two answer different questions - "may the model
// see my arrows?" and "may the model see a card frame?" - and R0.4 added a THIRD one (`mask`, below)
// for the same reason: one shared boolean would have made each new dimension impossible to add.
// Defaults: annotations follow the shipped behaviour; composition and masking both stay OFF for
// anything that does not explicitly ask for them.
//
// R0.4 (contracts §8, plan §2): the recognition entries previously received the raw crop, so
// anything the user had covered with a mosaic was still handed to the model as readable pixels.
// `options.mask` applies the occlusion plan to the SAME canvas, at source resolution and before
// anything is scaled - masking after scaling would leave the interpolation halo of the un-masked
// pixels outside the blur rect, which is exactly the leak the mask exists to prevent.
function exportSelectionCanvasForAction(includeAnnotations, rect = exportSelectionRect(), options = {}) {
  const compose = options.compose === true
  const mask = options.mask === true
  if (!selection) return null
  const finish = (content) => {
    if (!content) return content
    // A `null` from the occlusion step means "there is a blur to protect but the mask could not be
    // computed". Returning the content anyway would hand the model the very pixels the user covered,
    // so the whole export fails instead (see applyRecognitionOcclusion's fail-closed note).
    const masked = mask ? applyRecognitionOcclusion(content, rect) : content
    if (mask && !masked) return null
    return compose ? (composeFinishedOutput(masked, currentOutputStyle()) || masked) : masked
  }
  if (rect === selection) return finish(exportSelectionCanvas(includeAnnotations))
  const raw = selection
  selection = rect
  try { return finish(exportSelectionCanvas(includeAnnotations)) } finally { selection = raw }
}

// Annotations in the source-pixel space of the EXPORT canvas, for the occlusion plan only.
//
// A document editor already stores its annotations in source pixels, so the plan can use them as
// they are. A plain capture window stores them in viewport CSS, so they have to go through the same
// projection `drawAnnotation` uses - doing it here (rather than drawing the mask in CSS space and
// scaling the canvas afterwards) is what keeps the mask at source resolution.
//
// CROP RULE (critical defect found by review - do not "restore" documentCrop() here):
// the plan's `crop` is the origin the op coordinates are expressed against, and the ops are painted
// straight onto the canvas `exportSelectionCanvas` produced. In a document editor that canvas is the
// WHOLE BASE IMAGE (selection = imageDisplayBounds() and the image is the full base, see
// exportSelectionCanvas -> getSourcePixelRect), NOT the crop rectangle. `documentCrop()` therefore
// must not be used as the plan crop: planOcclusion subtracts it from every op, so a crop origin of
// (100,80) shifted the whole mask by (-100,-80) and the user's mosaic stayed readable.
// The correct crop origin for this canvas is (0,0) at the full base size.
function annotationsForMask(rect) {
  if (documentEditor) {
    // Whole-base canvas: origin 0,0, sized to the base image (not the crop).
    const base = documentBaseSize()
    return {
      crop: { x: 0, y: 0, w: Math.max(1, Math.round(base.width)), h: Math.max(1, Math.round(base.height)) },
      annotations: annotationsToDocument(),
      transform: null
    }
  }
  const bounds = imageDisplayBounds()
  const source = getSourcePixelRect(rect, bounds, { width: image.naturalWidth, height: image.naturalHeight })
  const scaleX = source.width / Math.max(1, rect.w)
  const scaleY = source.height / Math.max(1, rect.h)
  return {
    crop: { x: 0, y: 0, w: source.width, h: source.height },
    annotations,
    transform: { scaleX, scaleY, offsetX: rect.x, offsetY: rect.y }
  }
}

// One occluder, moved from its annotation's coordinate space into the export canvas. The stroke
// width scales by the larger axis, exactly like drawAnnotation's widthScale, so a mosaic stroke
// covers the same relative band it covers on screen. `margin` stays as-is: it is a pixel budget for
// anti-aliasing at the final resolution, not a document length.
function transformOccluder(occluder, transform) {
  if (!occluder || !transform) return occluder
  const { scaleX, scaleY, offsetX, offsetY } = transform
  const widthScale = Math.max(scaleX, scaleY)
  if (occluder.kind === 'rect') {
    const rect = occluder.rect || {}
    return {
      kind: 'rect',
      rect: {
        x: (rect.x - offsetX) * scaleX,
        y: (rect.y - offsetY) * scaleY,
        w: rect.w * scaleX,
        h: rect.h * scaleY
      },
      margin: occluder.margin
    }
  }
  if (occluder.kind === 'polyline') {
    return {
      kind: 'polyline',
      points: (occluder.points || []).map((point) => ({
        x: (point.x - offsetX) * scaleX,
        y: (point.y - offsetY) * scaleY
      })),
      width: (occluder.width || 0) * widthScale
    }
  }
  return occluder
}

// Paints the occlusion plan onto the recognition canvas: opaque black, rounded caps, no blending.
// The plan's coordinates are already relative to the crop, i.e. exactly this canvas's pixels.
function paintOcclusionPlan(context, plan) {
  const mask = window.occlusionMask
  if (!context || !plan || !mask) return false
  context.save()
  context.globalAlpha = mask.MASK_ALPHA
  context.fillStyle = mask.MASK_COLOR
  context.strokeStyle = mask.MASK_COLOR
  context.lineCap = 'round'
  context.lineJoin = 'round'
  for (const op of plan.ops) {
    if (op.kind === 'rect') {
      context.fillRect(op.x, op.y, Math.max(1, op.w), Math.max(1, op.h))
      continue
    }
    if (op.kind === 'polyline' && op.points.length) {
      context.lineWidth = Math.max(1, op.width)
      context.beginPath()
      context.moveTo(op.points[0].x, op.points[0].y)
      for (let index = 1; index < op.points.length; index += 1) {
        context.lineTo(op.points[index].x, op.points[index].y)
      }
      // A single-point stroke draws nothing, so give it a dot (same patch as traceStroke).
      if (op.points.length === 1) context.lineTo(op.points[0].x + 0.01, op.points[0].y)
      context.stroke()
    }
  }
  context.restore()
  return true
}

// R0.4: the recognition input. Base crop + opaque mask over every blur that still exists in the
// document; NO ordinary annotations, NO finished-look frame, NO cursor. Returns the same canvas it
// was given (it is a fresh one per export, so mutating it can never touch the edit base image).
//
// FAIL-CLOSED, including the degenerate cases. An earlier version returned the untouched canvas when
// `window.occlusionMask` was missing, when the canvas had no 2D context, or when `image` was not
// loaded. Each of those is a state where the mask CANNOT be computed - and "cannot compute the
// mask" must never mean "send the model the pixels the user covered". The only acceptable outcomes
// are (a) a correct mask, or (b) an unusable canvas the caller cannot send at all. (b) is returned
// as `null` and the caller aborts the action: the user sees "recognition failed" instead of having
// the secret read, which is strictly the better failure.
function applyRecognitionOcclusion(contentCanvas, rect) {
  if (!contentCanvas) return null
  // Nothing to protect: no blur object was ever drawn, so there is no secret to mask and the
  // shipped behaviour is correct. This is the ONLY branch allowed to skip the mask.
  if (!hasOccludableBlur(rect)) return contentCanvas
  const context = typeof contentCanvas.getContext === 'function' ? contentCanvas.getContext('2d') : null
  const mask = window.occlusionMask
  if (!mask || !context || !image) {
    // There IS a blur to protect but its geometry cannot be computed or painted. Refuse.
    return null
  }
  let plan
  try {
    const input = annotationsForMask(rect)
    const occluders = mask.buildOccluders(input.annotations)
    const transformed = input.transform ? occluders.map((occluder) => transformOccluder(occluder, input.transform)) : occluders
    plan = mask.planOcclusion({ crop: input.crop, occluders: transformed })
  } catch (error) {
    // A mask that cannot be planned must not silently fall back to sending unmasked pixels: the
    // whole point of R0.4 is that a blur is never readable by a model. Cover the whole input.
    plan = { masked: true, ops: [{ kind: 'rect', x: 0, y: 0, w: contentCanvas.width, h: contentCanvas.height }] }
  }
  // `masked === false` while a blur exists means the plan found nothing to cover - that is a
  // geometry bug, not an absence of secrets. Cover everything rather than trust it.
  if (!plan.masked) {
    plan = { masked: true, ops: [{ kind: 'rect', x: 0, y: 0, w: contentCanvas.width, h: contentCanvas.height }] }
  }
  paintOcclusionPlan(context, plan)
  return contentCanvas
}

// Does the current document/selection actually contain a blur object? Cheap structural test, used
// only to decide whether the occlusion path is required at all (see the fail-closed note above).
// A failure to even enumerate the annotations counts as "there may be something to protect".
function hasOccludableBlur(rect) {
  let annotationsList
  try {
    annotationsList = annotationsForMask(rect).annotations
  } catch (error) {
    return true
  }
  if (!Array.isArray(annotationsList)) return true
  return annotationsList.some((item) => item?.type === 'blur')
}

function exportSelectionCanvas(includeAnnotations = true) {
  if (!selection) return null
  const bounds=imageDisplayBounds()
  const source=getSourcePixelRect(selection,bounds,{width:image.naturalWidth,height:image.naturalHeight})
  const output=document.createElement('canvas'); output.width=source.width; output.height=source.height
  const out=output.getContext('2d'); out.imageSmoothingEnabled=false; out.drawImage(image,source.x,source.y,source.width,source.height,0,0,source.width,source.height)
  if(includeAnnotations){const scaleX=source.width/selection.w,scaleY=source.height/selection.h;annotations.forEach((item)=>drawAnnotation(out,item,scaleX,scaleY,selection.x,selection.y,image))}
  // P0-2（S9b）：光标贴在**标注之后**，且只在 includeAnnotations 时贴 —— OCR/翻译/表格/
  // 二维码等识别路径用 includeAnnotations=false 取图，绝不能把光标混进识别输入。
  // 坐标契约（shared/cursor-geometry.js 头注释）：cursorScreenPoint / captureBounds 用 DIP，
  // imageSize / hotspot / selectionRect 用物理像素。provider 的 physicalPoint 是**物理像素**，
  // 这里先按 scaleFactor 换回 DIP 再喂纯函数；热点由纯函数按 1:1 减（位图已被系统按 DPI
  // 缩放，热点与它同一像素空间），这里不得再乘 scaleFactor。
  if(includeAnnotations&&initData?.cursor&&cursorImage&&cursorImage.complete&&cursorImage.naturalWidth>0&&window.cursorGeometry){
    const cursor=initData.cursor,pointScale=Number(initData.scaleFactor)||1
    const placement=window.cursorGeometry.resolveCursorPlacement({
      cursorScreenPoint:{x:(Number(cursor.physicalPoint?.x)||0)/pointScale,y:(Number(cursor.physicalPoint?.y)||0)/pointScale},
      captureBounds:initData.captureBounds,
      imageSize:{width:image.naturalWidth,height:image.naturalHeight},
      hotspot:cursor.hotspot,
      selectionRect:source,
      cursorSize:{width:cursor.width,height:cursor.height},
      scaleFactor:initData.scaleFactor
    })
    if(placement.visible)out.drawImage(cursorImage,placement.x-source.x,placement.y-source.y,placement.width||cursorImage.naturalWidth,placement.height||cursorImage.naturalHeight)
  }
  return output
}

function canvasPngBuffer(sourceCanvas) {
  return new Promise((resolve, reject) => {
    sourceCanvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error(t('capture.error.encode-failed')))
        return
      }
      blob.arrayBuffer().then(resolve, reject)
    }, 'image/png')
  })
}

// ---------- Feature D2/D3: the magnifier (plan §7.1/§7.2) ----------
//
// The magnifier is the first annotation whose geometry is NESTED (a source rect plus a lens origin,
// with the lens SIZE derived from the factor) and the first one that reads pixels from elsewhere in
// the image. Both of those live in shared modules:
//
//   shared/magnifier-geometry.js  - normalize/lensRect/withFactor/hitTest/clip
//   capture/magnifier-sampler.js  - the sample base + the byte-budgeted cache
//   shared/occlusion-mask.js      - the opaque mask the sample base must carry
//
// This block only owns the SESSION: the sampler instance, its cache lifetime, and the "which part
// of the gesture is dragging" state. Nothing here re-derives geometry.
function magnifierApi() { return window.magnifierGeometry || null }
function magnifierSamplerApi() { return window.magnifierSampler || null }

// One sampler per editor session. It is recreated on every init and released on close, which is what
// keeps the 32 MiB sample cache from outliving the document it belongs to (§7.2).
let lensSampler = null
// The sampler's identity depends on (base image, crop, blur set). `sampleBaseKey` remembers what the
// current base was built from so a style/annotation edit that does not touch those does not rebuild.
let sampleBaseKey = ''
// The part of a magnifier a drag is moving: 'lens' | 'source' | 'connector'.
let magnifierDrag = null
// Feature D3 state: the in-progress magnifier gesture, and the attribute defaults a new magnifier
// takes (factor / connector) - window-session state, never persisted (they are the same class of
// preference as the annotation colour, which is why they live here and not in the settings block).
let magnifierBuild = null
let magnifierFactor = 2
let magnifierConnector = 'none'
// Viewport-CSS tolerance for grabbing a magnifier's frame. It is a screen-space constant (a frame is
// thin at any zoom), so the call sites convert it into the annotation's own units.
const FRAME_HIT_TOLERANCE = 4

function resetLensSampler() {
  const sampler = magnifierSamplerApi()
  if (!sampler) return
  lensSampler = sampler.createLensSampler({
    createCanvas: (width, height) => {
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(width))
      canvas.height = Math.max(1, Math.round(height))
      return canvas
    }
  })
  sampleBaseKey = ''
}

// Release the cache when the session ends (editor close, new init). Explicit rather than relying on
// GC: §7.2 asks for the cache to be released when the editor closes, and a 32 MiB backing store is
// exactly the kind of thing a GC is allowed to keep around for a long time.
function releaseLensSampler() {
  if (lensSampler) lensSampler.reset()
  lensSampler = null
  sampleBaseKey = ''
  magnifierDrag = null
}

// The base the lens samples from: the crop of the BASE IMAGE with every blur still in the document
// painted opaque, at source resolution (§7.2 "mask before scaling"). Ordinary annotations and the
// finished-look frame are deliberately absent - a lens must never show a card frame or an arrow that
// is not part of the picture it is magnifying.
//
// COORDINATE RULE (the bug this comment exists for): composeSampleBase works in source pixels, so the
// occluders it receives must be in source pixels too. A document editor's annotations already are. A
// plain capture window's annotations are viewport CSS, so they have to go through the SAME projection
// the lens rect uses - handing CSS-space masks to a source-pixel canvas paints them at the wrong
// place, which silently defeats the privacy mask (the lens would show the un-masked secret).
function ensureSampleBase() {
  const sampler = magnifierSamplerApi()
  const mask = window.occlusionMask
  if (!sampler || !mask || !image) return null
  if (!lensSampler) resetLensSampler()
  if (!lensSampler) return null
  const crop = documentEditor ? documentCrop() : { x: 0, y: 0, w: image.naturalWidth, h: image.naturalHeight }
  // NOTE: uses buildOccludersForSampling(), not the raw occluder builder - the raw one leaves the
  // brush width un-scaled relative to what the painter actually drew. See the WIDTH RULE comment on
  // annotationsForSampling().
  const occluders = buildOccludersForSampling()
  const fingerprint = mask.maskFingerprint(occluders)
  const key = `${image.naturalWidth}x${image.naturalHeight}|${crop.x},${crop.y},${crop.w},${crop.h}|${fingerprint}`
  if (key === sampleBaseKey) return lensSampler
  let composed = null
  try {
    composed = sampler.composeSampleBase({
      baseImage: image,
      crop,
      occluders,
      createCanvas: (width, height) => {
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(width))
        canvas.height = Math.max(1, Math.round(height))
        return canvas
      }
    })
  } catch (error) {
    return null
  }
  lensSampler.reset()
  lensSampler.adoptSampleBase({ canvas: composed.canvas, fingerprint: key })
  sampleBaseKey = key
  return lensSampler
}

// Annotations in SOURCE pixels, for the lens sample base's occlusion plan.
//
// A document editor stores source pixels already, so this is just the document projection (which also
// drops every non-magnifier's flat fields for the sheet, but the occluder builder only reads type +
// geometry, so the plain list is enough). A plain capture window stores viewport CSS, so each blur is
// projected with the same scale/offset the lens uses - a mask painted in the wrong coordinate space
// would leave the secret readable through the lens.
//
// WIDTH RULE (a real defect found by review - do not "simplify" this back):
// the blur's stroke width must NOT be pre-multiplied by `widthScale` before the occluder builder sees
// it. `shared/occlusion-mask.brushStrokeWidth()` quantises its input against the {2,4,8} preset table
// and floors the result at 18, so feeding it `cssWidth * widthScale` makes any scale != 1 land
// between presets and snap DOWN to the floor. The display path (`drawMosaicStroke` ->
// `blurBrushWidth(item.width) * deviceScale`) quantises FIRST and scales AFTER, so a pre-scaled width
// produces a mask narrower than the painted mosaic - up to 60 source px per side at preset 8 / 3x,
// which is enough to expose whole glyphs the user covered. The recognition path already gets this
// right because `transformOccluder` scales the already-quantised occluder. So: quantise first, scale
// after, exactly like the painter.
function annotationsForSampling() {
  if (documentEditor) return annotationsToDocument()
  const rect = selection ? exportSelectionRect() : null
  if (!rect || !image) return []
  const bounds = imageDisplayBounds()
  const source = getSourcePixelRect(rect, bounds, { width: image.naturalWidth, height: image.naturalHeight })
  const scaleX = source.width / Math.max(1, rect.w)
  const scaleY = source.height / Math.max(1, rect.h)
  return annotations.map((item) => {
    if (item?.type !== 'blur') return item
    // Geometry is projected here; the WIDTH is left in CSS px so buildOccluders can quantise it
    // against the preset table first. `widthScale` rides along and is applied by
    // buildOccludersForSampling() below, i.e. after quantisation.
    const projected = {
      type: 'blur',
      width: item.width,
      color: item.color
    }
    if (Array.isArray(item.points) && item.points.length) {
      projected.points = item.points.map((point) => ({
        x: source.x + (point.x - rect.x) * scaleX,
        y: source.y + (point.y - rect.y) * scaleY
      }))
      return projected
    }
    projected.x = source.x + (Math.min(item.x, item.x2 ?? item.x) - rect.x) * scaleX
    projected.y = source.y + (Math.min(item.y, item.y2 ?? item.y) - rect.y) * scaleY
    projected.x2 = projected.x + Math.abs((item.x2 ?? item.x) - item.x) * scaleX
    projected.y2 = projected.y + Math.abs((item.y2 ?? item.y) - item.y) * scaleY
    return projected
  })
}

// Occluders for the lens sample base: quantise the brush width FIRST (via the occluder builder),
// then scale it into source pixels - the same order the painter uses. Kept as a named function so
// the ordering is one asserted thing rather than a property of inline code.
//
// The sample base is built from a crop that starts at `crop`, but `annotationsForSampling` projects
// into BASE-IMAGE source pixels (it adds `source.x/y`), which is what `composeSampleBase` expects for
// its occluders (it re-origins them relative to the crop itself). So only the WIDTH needs scaling
// here; the coordinates are already final.
function buildOccludersForSampling() {
  const mask = window.occlusionMask
  if (!mask) return []
  const rect = documentEditor ? null : (selection ? exportSelectionRect() : null)
  const widthScale = (() => {
    if (documentEditor || !rect || !image) return 1
    const bounds = imageDisplayBounds()
    const source = getSourcePixelRect(rect, bounds, { width: image.naturalWidth, height: image.naturalHeight })
    return Math.max(source.width / Math.max(1, rect.w), source.height / Math.max(1, rect.h))
  })()
  const occluders = mask.buildOccluders(annotationsForSampling())
  if (!(widthScale > 0) || widthScale === 1) return occluders
  // Scale the width AFTER quantisation, mirroring capture.js:639 (`blurBrushWidth(w) * deviceScale`).
  return occluders.map((occluder) => {
    if (occluder?.kind !== 'polyline') return occluder
    return { ...occluder, width: (Number(occluder.width) || 0) * widthScale }
  })
}

// The sampled lens canvas for one magnifier, or null when sampling is impossible. Null means the
// caller draws the frame only, which is still a correct (if less useful) render - never a wrong one.
//
// The magnifier handed in is in ANNOTATION space: viewport CSS in a plain capture window, source
// pixels in a document editor. The sample base is always source pixels, so a plain window has to be
// projected first - sampling the CSS rect directly would read the wrong part of the image (a 1.5x
// HiDPI capture would be off by a third of the region).
function magnifierLensCanvas(item) {
  const sampler = ensureSampleBase()
  if (!sampler) return null
  const projected = magnifierInSourceSpace(item)
  if (!projected) return null
  const crop = documentEditor ? documentCrop() : { x: 0, y: 0, w: image?.naturalWidth || 1, h: image?.naturalHeight || 1 }
  try {
    return sampler.sample({
      baseImageId: `${image?.naturalWidth || 0}x${image?.naturalHeight || 0}`,
      crop,
      maskFingerprint: sampleBaseKey,
      magnifier: projected
    })
  } catch (error) {
    return null
  }
}

// Feature D3: annotation space -> source pixels for the SAMPLER only.
//
// The sampler works on a SOURCE-RESOLUTION sample base, so whatever space `item` is in has to be
// projected into base-image source pixels first. The space is decided by where the annotation list
// came from, NOT by whether a document is open:
//
//   * a plain capture window stores its annotations in viewport CSS - projected with the same
//     `getSourcePixelRect` mapping the export uses (this was the first defect, see handoff §6.1);
//   * a document editor ALSO stores them in viewport CSS: `restoreDocumentEditor()` does
//     `annotations = annotationsFromDocument(...)`, i.e. `annotationsToViewport`. The vector
//     objects on disk are source pixels, but the LIVE array the painter and hit-tester use is
//     viewport CSS - that is what `drawAnnotation(ctx, item)` expects.
//
// There used to be an `if (documentEditor) return magnifier` short-circuit here on the belief that a
// document editor's live annotations were already source pixels. They are not, so the lens sampled
// the viewport rect as if it were a source rect: with a zero-origin crop the offset is purely
// `sourceRect * (1/zoom - 1)` which is hundreds of pixels at a fit-to-window zoom, and the lens then
// magnified whatever happened to be over there (measured 541 px off, canvas came back all black).
// The projection below is the identity when zoom === 1 and the offsets are 0, so removing the
// short-circuit cannot hurt the case the short-circuit was trying to serve.
function magnifierInSourceSpace(item) {
  const api = magnifierApi()
  if (!api || !item) return null
  const magnifier = api.normalizeMagnifier(item)
  if (documentEditor) return magnifierFromViewportSpace(magnifier)
  if (!selection || !image) return null
  const rect = exportSelectionRect()
  const bounds = imageDisplayBounds()
  const source = getSourcePixelRect(rect, bounds, { width: image.naturalWidth, height: image.naturalHeight })
  const scaleX = source.width / Math.max(1, rect.w)
  const scaleY = source.height / Math.max(1, rect.h)
  const widthScale = Math.max(scaleX, scaleY)
  // `source.x/y` is the crop origin the sample base is built from; subtracting it here puts the
  // result in the same space sampleMagnifier expects (base-image source pixels).
  const toX = (value) => source.x + (value - rect.x) * scaleX
  const toY = (value) => source.y + (value - rect.y) * scaleY
  return api.normalizeMagnifier({
    sourceRect: {
      x: toX(magnifier.sourceRect.x),
      y: toY(magnifier.sourceRect.y),
      w: magnifier.sourceRect.w * scaleX,
      h: magnifier.sourceRect.h * scaleY
    },
    lensOrigin: { x: toX(magnifier.lensOrigin.x), y: toY(magnifier.lensOrigin.y) },
    factor: magnifier.factor,
    stroke: { color: magnifier.stroke.color, widthPx: magnifier.stroke.widthPx * widthScale },
    connector: magnifier.connector
  })
}

// Viewport-CSS magnifier -> source pixels, for a DOCUMENT EDITOR. The shared module owns the exact
// inverse of `magnifierToViewport` (used when the document was loaded), so both directions come from
// one implementation and cannot drift. Re-normalizing the result is safe: `normalizeMagnifier` is a
// fixed point for a value produced by its inverse.
function magnifierFromViewportSpace(magnifier) {
  const api = documentApi()
  const viewport = documentViewport()
  if (!api || !viewport || typeof api.annotationsFromViewport !== 'function') return magnifier
  const [projected] = api.annotationsFromViewport([magnifier], viewport)
  return projected ? magnifierApi().normalizeMagnifier(projected) : magnifier
}

// ---------- Feature C: finished-look state (plan §6.1/§6.2/§6.3) ----------
//
// One style object drives three things: the live preview (primitive painted by the shared
// compositor), the document snapshot (`buildDocumentSnapshot`), and the exported pixels
// (`composeFinishedOutput`). Nothing here approximates geometry - every number ultimately comes
// from `shared/capture-output-style.js`, which the main process uses for the same decision.
//
// The preset ID is UI preference only (§6.2): it is persisted so the next capture starts from it,
// but it never enters the document. A document's own `outputStyle` is the product truth.
let outputStyleController = null
let outputStylePanel = null
// Content size the preview was last painted for. syncOutputStyleUi() runs every frame, so the
// preview must only be repainted when the content rect actually changed.
let outputStylePreviewSignature = ''

function outputStyleApi() { return window.captureOutputStyle || null }
function outputCompositorApi() { return window.captureOutputCompositor || null }

// The style to use for a screenshot window that is NOT editing a document. Such a window has no
// document to carry a style, so it reads the persisted preset preference - and only the preset:
// hand-tuned parameters deliberately do not leak from one screenshot to the next (§6.2 "presetId
// is UI preference; the product is decided by the fully resolved parameters").
//
// Image/canvas modes are excluded on purpose. Those are re-annotation editors (pin re-annotate, and
// the history editor falls in here too but has a document), and their base bitmap may already BE a
// composed result: applying the persisted card on top of it would stack a second frame, which §6.3
// forbids ("repeated saves and pin re-edits must not accumulate frames"). They therefore start in
// original mode and only compose when the user explicitly picks a preset in this session.
function preferredOutputStylePreset() {
  const api = outputStyleApi()
  if (!api) return 'original'
  if (['image', 'canvas'].includes(initData?.mode)) return 'original'
  const stored = initData?.settings?.screenshot?.outputStylePreset
  return api.PRESET_IDS.includes(stored) ? stored : 'original'
}

// The style the CURRENT session is producing. Inside a document editor the document owns it, so
// reopening a record shows the card it was saved with; a plain capture window starts from the
// persisted preset. Always normalized, so a hand-edited store cannot inject a bad shape.
function currentOutputStyle() {
  const api = outputStyleApi()
  if (!api) return null
  if (outputStyleController) return outputStyleController.getStyle()
  return api.presetStyle(preferredOutputStylePreset())
}

function setOutputStyleStatus(key, params, isError) {
  if (outputStylePanel) outputStylePanel.setStatus(key, params, isError)
  else if (outputStyleStatusEl) {
    outputStyleStatusEl.textContent = key ? t(key, params) : ''
    outputStyleStatusEl.classList.toggle('hidden', !key)
    outputStyleStatusEl.classList.toggle('error', isError === true)
  }
}

// The panel is anchored to the strip and only meaningful once there is something to frame, so it
// closes with the same rule that hides the strip. The toggle itself lives ON the strip (it is
// hidden with it by updateFloatingUi), so there is no separate floating affordance to place.
//
// Called from updateFloatingUi(), i.e. on every rendered frame - so it must not repaint the
// preview unconditionally. The size hint and the preview both depend on the content rect, so the
// repaint is keyed off that rect instead of the frame.
function syncOutputStyleUi() {
  if (!outputStylePanel) return
  const available = !!selection && selection.w >= 8 && selection.h >= 8 &&
    !activeOcrResult && !processingAction && !selecting && !dragging && !resizing &&
    selectState !== 'auto' && !toolbar.classList.contains('hidden')
  if (!available) {
    outputStylePanel.close()
    return
  }
  const size = outputContentSize()
  const signature = size ? `${size.width}x${size.height}` : ''
  if (signature !== outputStylePreviewSignature) {
    outputStylePreviewSignature = signature
    outputStylePanel.syncControls()
    renderOutputStylePreview()
  }
  if (outputStylePanel.isOpen()) outputStylePanel.position()
}

// Content-layer width/height for the current session, in source pixels. A document editor works on
// its crop; a plain capture window works on the selection's pixel rect (the same rect the export
// uses), so the size hint and the real result agree.
function outputContentSize() {
  if (documentEditor) {
    const crop = documentCrop()
    return { width: Math.max(1, Math.round(crop.w)), height: Math.max(1, Math.round(crop.h)) }
  }
  if (!selection || !image) return null
  const rect = exportSelectionRect()
  const source = getSourcePixelRect(rect, imageDisplayBounds(), { width: image.naturalWidth, height: image.naturalHeight })
  return { width: Math.max(1, source.width), height: Math.max(1, source.height) }
}

function outputStyleGeometry(style) {
  const api = outputStyleApi()
  const size = outputContentSize()
  if (!api || !size) return null
  return api.resolveOutputGeometry({
    contentWidth: size.width,
    contentHeight: size.height,
    outputStyle: style || currentOutputStyle()
  })
}

// The panel's live preview. It is the SHARED compositor's output drawn into a small canvas, not a
// CSS approximation: plan §6.1 forbids a CSS-only shadow precisely because it would let the
// preview and the export disagree. The content layer is a scaled-down copy of what would be
// exported (base crop + annotations + cursor), so the preview shows the real composition.
function renderOutputStylePreview() {
  const canvasEl = outputStylePreviewCanvas
  const compositor = outputCompositorApi()
  if (!canvasEl || !compositor || !image) return
  const size = outputContentSize()
  if (!size) return
  const style = currentOutputStyle()
  if (!style || !style.enabled) {
    // Original mode has no decoration to preview; the panel shows an empty frame rather than a
    // misleading miniature (the size hint still reports the crop size).
    const ctx = canvasEl.getContext('2d')
    if (ctx) ctx.clearRect(0, 0, canvasEl.width, canvasEl.height)
    return
  }
  const content = previewContentCanvas(size)
  if (!content) return
  const box = previewBox(canvasEl, style, size)
  let composed = null
  try {
    composed = compositor.composeOutputCanvas({ contentCanvas: content, outputStyle: style, scale: box.scale })
  } catch (error) {
    composed = null
  }
  const ctx = canvasEl.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height)
  if (composed) ctx.drawImage(composed, box.left, box.top)
}

// Scale that fits the composed result into the preview canvas (letterboxed, never upscaled past 1
// so a tiny selection is not blown up into a blurry block).
function previewBox(canvasEl, style, size) {
  const api = outputStyleApi()
  const availableWidth = Math.max(32, (canvasEl.width || 240) - 2)
  const availableHeight = Math.max(32, (canvasEl.height || 140) - 2)
  const geometry = api.resolveOutputGeometry({
    contentWidth: size.width,
    contentHeight: size.height,
    outputStyle: style
  })
  const scale = Math.max(1e-4, Math.min(1, availableWidth / geometry.width, availableHeight / geometry.height))
  return {
    scale,
    left: Math.round((canvasEl.width - geometry.width * scale) / 2),
    top: Math.round((canvasEl.height - geometry.height * scale) / 2)
  }
}

// Scaled content layer for the preview: the SAME draw calls the export makes, at preview scale, so
// a difference between preview and export can only come from the compositor (which is shared).
function previewContentCanvas(size) {
  if (!image || !size) return null
  const canvasEl = previewContentCanvas.cache || (previewContentCanvas.cache = document.createElement('canvas'))
  canvasEl.width = Math.max(1, size.width)
  canvasEl.height = Math.max(1, size.height)
  const ctx = canvasEl.getContext('2d')
  if (!ctx) return null
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height)
  ctx.imageSmoothingEnabled = true
  if (documentEditor) {
    const crop = documentCrop()
    ctx.drawImage(image, crop.x, crop.y, crop.w, crop.h, 0, 0, size.width, size.height)
    const scaleX = size.width / Math.max(1, crop.w)
    const scaleY = size.height / Math.max(1, crop.h)
    for (const item of annotationsToDocument()) drawAnnotation(ctx, item, scaleX, scaleY, crop.x * scaleX, crop.y * scaleY, image)
  } else {
    const rect = exportSelectionRect()
    const source = getSourcePixelRect(rect, imageDisplayBounds(), { width: image.naturalWidth, height: image.naturalHeight })
    ctx.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, size.width, size.height)
    const scaleX = size.width / Math.max(1, rect.w)
    const scaleY = size.height / Math.max(1, rect.h)
    for (const item of annotations) drawAnnotation(ctx, item, scaleX, scaleY, rect.x, rect.y, image)
  }
  return canvasEl
}

// Rebuild the panel for the current session. `initialStyle` is the document's own style when a
// record is reopened, or the persisted preset for a fresh capture.
function mountOutputStylePanelFor(initialStyle, initialPresetId) {
  if (!outputStylePanelRoot || !outputStyleApi() || !window.outputStylePanel) return null
  outputStyleController = window.outputStylePanel.createOutputStyleController({
    styleApi: outputStyleApi(),
    initialStyle,
    initialPresetId,
    onPreview: () => { renderOutputStylePreview() },
    onCommit: () => { commitOutputStyleGesture() },
    onPreset: (presetId) => {
      // Only the preset choice persists (plan §6.2); the parameters belong to the document. The
      // call is guarded because the preload method may not exist in an older window build.
      try { window.captureAPI.saveOutputStylePreset?.(presetId) } catch (error) { /* best effort */ }
    }
  })
  outputStylePanel = window.outputStylePanel.mountOutputStylePanel({
    document,
    styleApi: outputStyleApi(),
    controller: outputStyleController,
    translate: (key, params) => t(key, params),
    getGeometry: (style) => outputStyleGeometry(style),
    // The panel's preview is painted by the shared compositor, never by CSS, and nothing else
    // repaints it just because the panel became visible.
    onOpen: () => renderOutputStylePreview(),
    getAnchor: () => {
      const rect = toolbar.classList.contains('hidden') ? null : toolbar.getBoundingClientRect()
      return {
        left: rect ? rect.left : 8,
        top: rect ? rect.top : 8,
        width: rect ? rect.width : 0,
        height: rect ? rect.height : 0,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight
      }
    },
    log: (...args) => console.warn(...args)
  })
  renderOutputStylePreview()
  return outputStylePanel
}

// A style gesture (preset click or one completed slider drag) is ONE undo step (§6.3). It goes
// through the same snapshot funnel the annotations use, so every window has a single Ctrl+Z
// timeline: the frame captures both the annotation array (unchanged) and the new style, and undo
// restores both. That is what makes "restore the original picture" itself undoable - it is a
// regular edit here, not a reset.
function commitOutputStyleGesture() {
  snapshotAnnotations()
  renderOutputStylePreview()
}

// Fresh style session for a new capture. Runs from resetAnnotationState(), i.e. before any image is
// decoded, so the panel exists but reports nothing until outputContentSize() has a selection.
function resetOutputStyleState() {
  const api = outputStyleApi()
  outputStyleController = null
  outputStylePanel = null
  outputStylePreviewSignature = ''
  if (!api || !window.outputStylePanel) return
  const presetId = preferredOutputStylePreset()
  mountOutputStylePanelFor(api.presetStyle(presetId), presetId)
}

// ---------- Batch 1: editing a *document* rather than taking a screenshot ----------
//
// Design: docs/plans/2026-10-25-history-reedit-batch0-contracts.md §4 (commit protocol),
// §7 (dirty + close negotiation). The contract module owns coordinates/schema/fingerprint;
// this block only translates between "what the user sees" and "what a document is":
//
//   renderer annotations  = viewport CSS px (what annotation-geometry.js already speaks)
//   document annotations  = base-image source px (what gets persisted)
//
// Every commit therefore converts exactly once, with the crop removed once in the export
// path. Nothing here may reset `crop`, rewrite object coordinates, or create undo steps
// when the window resizes or the DPI changes (contracts §2.1).
function documentApi() { return window.captureDocument || null }

function documentEditorActive() { return !!documentEditor }

// Source-pixel size of the base image. Falls back to the loaded image, then the crop.
function documentBaseSize() {
  const base = documentEditor?.document?.baseImage
  if (base && Number(base.width) > 0 && Number(base.height) > 0) {
    return { width: Math.round(Number(base.width)), height: Math.round(Number(base.height)) }
  }
  return { width: image?.naturalWidth || 1, height: image?.naturalHeight || 1 }
}

function documentCrop() {
  const crop = documentEditor?.crop
  if (crop && Number(crop.w) > 0 && Number(crop.h) > 0) return crop
  const size = documentBaseSize()
  return { x: 0, y: 0, w: size.width, h: size.height }
}

// The viewport maps the *crop* into the image area the window reserved for it. zoom is
// source-px -> CSS-px; offset centres the crop inside imageBounds. This is the only place
// that builds it, and both directions come from the shared module so they stay inverses.
function documentViewport() {
  const api = documentApi()
  if (!api) return null
  const bounds = imageDisplayBounds()
  const crop = documentCrop()
  const view = api.fitViewport({
    baseSize: documentBaseSize(),
    crop,
    bounds: { width: bounds.w, height: bounds.h }
  })
  // fitViewport centres the crop at (0,0); re-anchor into the window's image area.
  return Object.assign({}, view, { offsetX: bounds.x + view.offsetX, offsetY: bounds.y + view.offsetY })
}

// Viewport-CSS annotations -> source-pixel annotations (what gets persisted).
function annotationsToDocument() {
  const api = documentApi()
  const viewport = documentViewport()
  if (!api || !viewport) return cloneAnnotations(annotations)
  return api.annotationsFromViewport(annotations, viewport)
}

// Source-pixel annotations -> viewport CSS (what the renderer draws / hit-tests).
function annotationsFromDocument(sourceAnnotations) {
  const api = documentApi()
  const viewport = documentViewport()
  if (!api || !viewport) return cloneAnnotations(sourceAnnotations)
  return api.annotationsToViewport(sourceAnnotations, viewport)
}

// Build the current document snapshot (source-pixel coordinates + real crop).
function buildDocumentSnapshot() {
  const api = documentApi()
  if (!api) return null
  const base = documentEditor?.document?.baseImage || {}
  return api.normalizeDocument({
    schemaVersion: api.SCHEMA_VERSION,
    coordinateSpace: api.COORDINATE_SPACE,
    // Identity is the main process's job; send it empty so the fingerprint can never be
    // influenced by a stale id the renderer happens to hold.
    documentId: '',
    revisionId: '',
    baseImage: {
      // Placeholder asset id: the service rewrites it to the session's real base before
      // fingerprinting (contracts §4 note on asset normalisation).
      assetId: 'placeholder',
      width: documentBaseSize().width,
      height: documentBaseSize().height
    },
    crop: documentCrop(),
    annotations: annotationsToDocument(),
    captureAttachments: documentEditor?.document?.captureAttachments || { cursor: null },
    captureMetadata: documentEditor?.document?.captureMetadata || { sourceScaleFactor: Number(initData?.scaleFactor) || 1 },
    // Feature C (plan §6.2): the style is part of the document's CONTENT (it participates in the
    // content fingerprint), so changing padding/radius/shadow is a real revision. The contract
    // layer normalizes it, so a partial object from the UI cannot produce an invalid document.
    outputStyle: currentOutputStyle() || undefined,
    source: initData?.source || 'history'
  })
}

function documentFingerprintNow() {
  const api = documentApi()
  if (!api) return ''
  const snapshot = buildDocumentSnapshot()
  return snapshot ? api.documentFingerprint(snapshot) : ''
}

// dirty = "content differs from the last successful commit". Viewport, selection and the
// OCR panel deliberately do not participate (contracts §7.2).
function refreshDocumentDirty() {
  if (!documentEditor) return false
  const fingerprint = documentFingerprintNow()
  if (!fingerprint) return documentEditor.dirty === true
  const dirty = documentEditor.cleanFingerprint ? fingerprint !== documentEditor.cleanFingerprint : true
  if (dirty !== documentEditor.dirty) {
    documentEditor.dirty = dirty
    renderDocumentInfo()
  }
  return dirty
}

// The visible info area (contracts §5.3): "Editing: <name> (version N)" plus a dirty dot.
// A native window title is not enough for a frameless window.
function renderDocumentInfo() {
  const bar = document.getElementById('documentInfo')
  if (!bar) return
  if (!documentEditor) { bar.classList.add('hidden'); return }
  bar.classList.remove('hidden')
  const version = Math.max(1, Number(documentEditor.version) || 1)
  // Write into the text span, never into the bar itself: replacing bar.textContent would
  // destroy the dirty dot and the saving label that live alongside it.
  const text = document.getElementById('documentInfoText')
  if (text) {
    text.textContent = t('capture.document.info', {
      name: documentEditor.documentName || t('capture.document.unnamed'),
      version
    })
  }
  const dirtyMark = document.getElementById('documentDirtyMark')
  if (dirtyMark) dirtyMark.classList.toggle('hidden', documentEditor.dirty !== true)
  const savingMark = document.getElementById('documentSavingMark')
  if (savingMark) savingMark.classList.toggle('hidden', documentEditor.saving !== true)
}

// Restore a loaded document into the editor. This is a session swap, not an edit: the
// annotation array is replaced wholesale and the undo stack is reset to a single frame
// (contracts §6.1 A2 - "restore = new session + clear stack", never undoable to the
// previous image).
function restoreDocumentEditor(payload) {
  const api = documentApi()
  if (!payload) return
  documentEditor = {
    sessionId: String(payload.sessionId || ''),
    documentId: String(payload.documentId || ''),
    revisionId: String(payload.revisionId || ''),
    version: Math.max(1, Number(payload.version) || 1),
    legacy: payload.legacy === true,
    storageFormat: payload.storageFormat || 'legacy-bitmap',
    degraded: payload.degraded === true,
    document: payload.document || null,
    crop: payload.crop || null,
    infoHeight: Number(payload.infoHeight) || 0,
    documentName: String(payload.documentName || ''),
    cleanFingerprint: '',
    dirty: false,
    saving: false,
    requestSeq: 0
  }
  // Legacy flat records keep their pixels in the base image: no vector objects to restore,
  // and the info bar says so instead of pretending the old arrows are editable (§6.7).
  const sourceAnnotations = payload.legacy ? [] : (payload.document?.annotations || [])
  annotations = api ? annotationsFromDocument(sourceAnnotations) : cloneAnnotations(sourceAnnotations)
  // Re-number ids so the restored objects are addressable by the existing selection code;
  // ids are session state and never part of the content fingerprint (§6.5.3).
  annotationSeq = 0
  for (const item of annotations) item.id = ++annotationSeq
  selectedAnnotation = null
  selectedIds = new Set()
  // One "initial state" frame: Ctrl+Z right after opening is a no-op (§11.1).
  annotationHistory = [cloneAnnotations(annotations)]
  historyIndex = 0
  invalidateMosaicPatches()
  // Feature C (plan §6.3): a reopen shows the card the record was saved with, and the undo stack
  // starts at that style - so Ctrl+Z right after opening cannot walk back to a style the record
  // never had. `legacy` records are forced to original by the contract layer (their bitmap may
  // already carry baked-in decoration, and adding a frame would stack a second one).
  restoreOutputStyleForDocument(payload)
  // Feature D3: a reopened record may hold magnifiers whose source rect falls outside the crop
  // (removed by an earlier version, or a corrupted document). §7.1 requires such an object to be
  // REMOVED, not clamped - keeping a lens that samples cut-off pixels would paint back content the
  // user deleted. The removal happens in the load frame, not as an undoable edit: opening is not an
  // edit, and undoing it must not resurrect an out-of-bounds object.
  clipRestoredMagnifiers()
  // Feature D4: the panel and the next-lens defaults follow what the document actually holds.
  adoptMagnifierDefaultsFromDocument()
  syncMagnifierPanel()
  // The baseline for dirty is the content we just loaded, so opening is immediately clean.
  documentEditor.cleanFingerprint = ''
  documentEditor.cleanFingerprint = documentFingerprintNow()
  documentEditor.dirty = false
  renderDocumentInfo()
  render()
}

// Feature D3 (plan §7.1): drop (or shrink) magnifiers whose source rect left the crop. Runs inside
// the load frame, so the result is what "opened" means - the undo stack starts from it.
//
// SPACE RULE (critical defect found by review - do not reintroduce the shortcut):
// `clipToCrop` is defined in SOURCE pixels - its `crop` argument and the magnifier's `sourceRect` are
// both document-space. But `annotations` here is the LIVE array, i.e. viewport CSS (the same array
// `drawAnnotation` and the hit-tester consume). Passing a source-pixel crop to a viewport object
// compared two different spaces: a perfectly legal lens was reported outside the crop and removed
// outright (or shrunk), in the load frame, which is not undoable - so opening a record could destroy
// objects the user never edited. The fix is to project to source space, clip there, and project back.
function clipRestoredMagnifiers() {
  const api = magnifierApi()
  if (!api) return
  const crop = documentCrop()
  const viewport = documentViewport()
  const docApi = documentApi()
  const toSource = (item) => {
    if (!docApi || !viewport || typeof docApi.annotationsFromViewport !== 'function') return item
    const [projected] = docApi.annotationsFromViewport([item], viewport)
    return projected || item
  }
  const toViewport = (item) => {
    if (!docApi || !viewport || typeof docApi.annotationsToViewport !== 'function') return item
    const [projected] = docApi.annotationsToViewport([item], viewport)
    return projected || item
  }
  let changed = false
  const kept = []
  for (const item of annotations) {
    if (item.type !== 'magnifier') { kept.push(item); continue }
    const clipped = api.clipToCrop(toSource(item), crop)
    if (!clipped.ok) { changed = true; continue }
    if (clipped.adjusted) changed = true
    // Back to viewport CSS, preserving the id (ids are session state, never part of the fingerprint).
    const restored = toViewport(clipped.magnifier)
    kept.push(item.id !== undefined ? Object.assign({}, restored, { id: item.id }) : restored)
  }
  if (!changed) return
  annotations = kept
  // The load frame is the state AFTER the removal, so rebuild it (and re-seed the ids so the
  // selection code can still address the objects).
  annotationSeq = 0
  for (const item of annotations) item.id = ++annotationSeq
  annotationHistory = [cloneAnnotations(annotations)]
  historyIndex = 0
  selectedAnnotation = null
  selectedIds = new Set()
  invalidateMosaicPatches()
  // The sample base depends on the blur set, which the removal does not touch - but the magnifier
  // set did change, so cached lens samples for the removed objects are dropped.
  ensureSampleBase()
}

// Feature D4 (plan §7.3): a reopened record shows its lenses with the attributes they were saved
// with, so the panel is a faithful echo of the selected object (syncMagnifierPanel reads it). This
// also seeds the DEFAULTS for the next magnifier from the last one in the document, so drawing a
// second lens does not silently snap back to 2x/no-connector after a reload.
function adoptMagnifierDefaultsFromDocument() {
  const api = magnifierApi()
  if (!api) return
  const lenses = annotations.filter((item) => item?.type === 'magnifier')
  if (!lenses.length) {
    magnifierFactor = 2
    magnifierConnector = 'none'
    return
  }
  const last = api.normalizeMagnifier(lenses[lenses.length - 1])
  magnifierFactor = last.factor
  magnifierConnector = last.connector
  // A saved stroke width is a good default for the next lens (same reasoning as the annotation
  // colour: the user's last choice should not be thrown away by a reload).
  annotationWidth = Math.max(1, Math.min(24, Math.round(last.stroke.widthPx)))
}

// Feature C: install the session's style controller from a loaded document.
//
// The document's own `outputStyle` is the product truth (§6.2): a reopened record must look the way
// it was saved, not the way the last unrelated capture looked. The preset id is derived back from
// the parameters so the panel's buttons show something honest - a style that matches no preset
// simply leaves every preset button unpressed (there is no "custom" preset to invent).
function restoreOutputStyleForDocument(payload) {
  const api = outputStyleApi()
  if (!api) return
  const document = payload?.document && typeof payload.document === 'object' ? payload.document : null
  const style = api.normalizeOutputStyle(document?.outputStyle)
  const presetId = matchOutputStylePreset(style)
  mountOutputStylePanelFor(style, presetId)
  if (outputStyleController) outputStyleController.resetFrames(style)
}

// Which preset (if any) the given parameters equal exactly. Returns 'original' for a disabled
// style; an enabled style that matches no preset returns '' so no button claims to be active.
function matchOutputStylePreset(style) {
  const api = outputStyleApi()
  if (!api) return 'original'
  if (!api.isOutputStyleEnabled(style)) return 'original'
  for (const presetId of api.PRESET_IDS) {
    if (presetId === 'original') continue
    if (api.outputStyleEquals(api.presetStyle(presetId), style)) return presetId
  }
  return ''
}

// Encode the committed result for the current crop (source pixels, no resampling).
//
// Feature C (plan §6.1/§6.3): the content layer is rebuilt from the BASE IMAGE + annotations every
// time and then handed to the shared compositor. It deliberately never reads the previous result
// PNG - that is what stops repeated saves and pin re-edits from stacking a second frame.
// In original mode the compositor returns null and this exact crop-sized canvas is the result, so
// a v1-shaped document keeps writing byte-identical pixels (the service re-validates the size).
async function documentResultBuffer() {
  const crop = documentCrop()
  const output = document.createElement('canvas')
  output.width = Math.max(1, crop.w)
  output.height = Math.max(1, crop.h)
  const out = output.getContext('2d')
  out.imageSmoothingEnabled = false
  // Base image slice: draw the crop region 1:1 (export subtracts the crop origin once).
  out.drawImage(image, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h)
  // Annotations are stored in source px, so re-project them into export px for drawing.
  const viewsForExport = annotationsToDocument()
  for (const item of viewsForExport) drawAnnotation(out, item, 1, 1, crop.x, crop.y, image)
  const composed = composeFinishedOutput(output, currentOutputStyle())
  return canvasPngBuffer(composed || output)
}

// Commit the frozen content state (contracts §4). One requestId per frozen snapshot:
// a retry of the SAME requestId returns the same receipt instead of a new revision.
async function commitDocumentEditor(intent = 'update') {
  if (!documentEditor || !documentApi()) return { ok: false, status: 'failed', code: 'unavailable' }
  if (documentEditor.saving) return { ok: false, status: 'failed', code: 'busy' }
  const api = documentApi()
  documentEditor.saving = true
  renderDocumentInfo()
  // Tell the user something is happening; the toolbar otherwise looks frozen during I/O.
  document.body.classList.add('document-saving')
  try {
    // settle any coalesced micro-edits so the snapshot matches what is on screen
    flushCoalescedEdits()
    const snapshotDocument = buildDocumentSnapshot()
    if (!snapshotDocument) return { ok: false, status: 'failed', code: 'invalid-document' }
    const snapshot = api.serializeDocument(snapshotDocument)
    const resultBuffer = await documentResultBuffer()
    documentEditor.requestSeq += 1
    const requestId = `req-${Date.now()}-${documentEditor.requestSeq}`
    const response = await window.captureAPI.commitDocument({
      sessionId: documentEditor.sessionId,
      requestId,
      intent,
      expectedRevisionId: intent === 'update' ? documentEditor.revisionId : null,
      snapshot,
      resultBuffer
    })
    return handleCommitResponse(response, intent)
  } catch (error) {
    alert(error?.message || String(error))
    return { ok: false, status: 'failed', code: 'request-failed', message: error?.message || String(error) }
  } finally {
    documentEditor.saving = false
    document.body.classList.remove('document-saving')
    renderDocumentInfo()
  }
}

// Apply a commit result. Success -> accept the ids the main process assigned, then (and only
// then) establish the clean baseline, so a temporary resource id can never look like dirty.
function handleCommitResponse(response, intent) {
  if (!response || typeof response !== 'object') {
    alert(t('capture.document.save-failed'))
    return { ok: false, status: 'failed', code: 'empty-response' }
  }
  if (response.status === 'committed' || response.status === 'unchanged') {
    documentEditor.documentId = response.documentId || documentEditor.documentId
    documentEditor.revisionId = response.headRevisionId || response.revisionId || documentEditor.revisionId
    documentEditor.version = Math.max(1, Number(response.version) || documentEditor.version)
    documentEditor.cleanFingerprint = documentFingerprintNow()
    documentEditor.dirty = false
    if (intent === 'save-copy') {
      // "Save as new record" switches this session to the copy (§6.5.1): the next Ctrl+S
      // must update the copy, not the original document.
      documentEditor.version = 1
    }
    renderDocumentInfo()
    return { ok: true, status: response.status }
  }
  if (response.status === 'conflict') {
    // Never overwrite a newer revision silently: offer reload / save-copy, keep the work.
    const copyNow = confirm(t('capture.document.conflict-save-copy'))
    if (copyNow) return commitDocumentEditor('save-copy')
    alert(t('capture.document.conflict-keep'))
    return { ok: false, status: 'conflict' }
  }
  const code = response.code || 'failed'
  alert(code === 'deleted' ? t('capture.document.deleted') : t('capture.document.save-failed'))
  return { ok: false, status: 'failed', code }
}

// Unified close negotiation (contracts §7.3). dirty -> save / discard / keep editing.
async function requestCloseDocumentEditor() {
  if (!documentEditor) { cancelRenderReady(); window.captureAPI.close(0); return }
  if (documentEditor.saving) return
  refreshDocumentDirty()
  if (!documentEditor.dirty) { finishDocumentClose(); return }
  const choice = await askDocumentCloseChoice()
  if (choice === 'save') {
    const result = await commitDocumentEditor('update')
    // Only close after a confirmed success; a failure keeps the window and the work.
    if (result.ok) finishDocumentClose()
    return
  }
  if (choice === 'discard') finishDocumentClose()
  // 'keep' / dismissed: stay exactly where we are.
}

// Three-way prompt. window.confirm only offers two buttons, so the discard path asks a
// second, explicit question; both are cancelled by Esc, which means "keep editing".
function askDocumentCloseChoice() {
  const save = confirm(t('capture.document.close-save'))
  if (save) return 'save'
  const discard = confirm(t('capture.document.close-discard'))
  return discard ? 'discard' : 'keep'
}

function finishDocumentClose() {
  const sessionId = documentEditor?.sessionId || ''
  documentEditor = null
  cancelRenderReady()
  window.captureAPI.close({ sessionId, serialNumber: serialNumber > initialSerialNumber ? serialNumber : 0 })
}

function clearOcrResult() {
  activeOcrResult=null
  ocrOverlay.replaceChildren()
  ocrOverlay.classList.add('hidden')
  ocrResultBar.classList.add('hidden')
  ocrToggleSource.classList.add('hidden')
  ocrToggleSource.textContent=t('capture.ocr.show-source')
  if(selection&&initData)updateFloatingUi()
}

function setProcessingState(action) {
  processingAction=action||null
  const active=!!processingAction
  document.body.classList.toggle('processing',active)
  loadingText.textContent=action==='translate'?t('capture.loading.translate'):t('capture.loading.ocr')
  loading.classList.toggle('hidden',!active)
  if(active&&selection){
    if(['ocr','translate'].includes(action))sizeBadge.style.display='none'
    toolbar.classList.add('hidden')
    const rect=loading.getBoundingClientRect()
    let left=selection.x+(selection.w-rect.width)/2
    let top=selection.y+selection.h+10
    if(top+rect.height>innerHeight-8)top=selection.y-rect.height-10
    loading.style.left=`${Math.max(8,Math.min(left,innerWidth-rect.width-8))}px`
    loading.style.top=`${Math.max(8,top)}px`
  }else if(!active&&selection&&initData)updateFloatingUi()
  syncWatermarkPanel()
}

function fitOverlayText(element, width, height, initialSize, vertical) {
  let lower=7
  let upper=Math.max(lower,initialSize)
  let fitted=lower
  for(let attempt=0;attempt<8;attempt++){
    const fontSize=(lower+upper)/2
    element.style.fontSize=`${fontSize}px`
    element.style.lineHeight=vertical?`${Math.max(8,fontSize*1.08)}px`:`${Math.min(height,Math.max(8,fontSize*1.18))}px`
    if(element.scrollWidth<=element.clientWidth+1&&element.scrollHeight<=element.clientHeight+1){fitted=fontSize;lower=fontSize}else upper=fontSize
  }
  element.style.fontSize=`${fitted}px`
  element.style.lineHeight=vertical?`${Math.max(8,fitted*1.08)}px`:`${Math.min(height,Math.max(8,fitted*1.18))}px`
}

function renderOcrOverlayBlocks(result, blocks, translated) {
  ocrOverlay.replaceChildren()
  if(!selection||!result||!Array.isArray(blocks))return 0
  const scaleX=selection.w/Math.max(1,result.imageWidth||1)
  const scaleY=selection.h/Math.max(1,result.imageHeight||1)
  const configuredConfidence=Number(initData?.settings?.ocr?.minConfidence)
  const minConfidence=Number.isFinite(configuredConfidence)?configuredConfidence:.3
  let visibleCount=0
  blocks.forEach((block)=>{
    if(!block?.text||!Array.isArray(block.box_points)||block.box_points.length<4||Number(block.text_score)<minConfidence)return
    const points=block.box_points.map((point)=>({x:Number(point.x)*scaleX,y:Number(point.y)*scaleY}))
    const width=Math.hypot(points[1].x-points[0].x,points[1].y-points[0].y)
    const height=Math.hypot(points[3].x-points[0].x,points[3].y-points[0].y)
    if(width<2||height<2)return
    const centerX=points.reduce((sum,point)=>sum+point.x,0)/points.length
    const centerY=points.reduce((sum,point)=>sum+point.y,0)/points.length
    const angle=Math.atan2(points[1].y-points[0].y,points[1].x-points[0].x)*180/Math.PI
    const vertical=height>width*1.5
    const element=document.createElement('div')
    element.className=`ocr-text-block${vertical?' vertical':''}${translated?' translation':''}`
    element.textContent=block.text
    element.title=translated&&block.sourceText?t('capture.ocr.tooltip-source',{text:block.sourceText}):t('capture.ocr.tooltip-confidence',{value:Math.round(Number(block.text_score)*100)})
    element.style.left=`${centerX-width/2}px`
    element.style.top=`${centerY-height/2}px`
    element.style.width=`${width}px`
    element.style.height=`${height}px`
    element.style.transform=`rotate(${Math.abs(angle)<3?0:angle}deg)`
    element.addEventListener('pointerdown',(event)=>event.stopPropagation())
    ocrOverlay.appendChild(element)
    const initialSize=Math.max(9,Math.min(36,(vertical?width:height)*.72))
    if(translated)fitOverlayText(element,width,height,initialSize,vertical)
    else{element.style.fontSize=`${initialSize}px`;element.style.lineHeight=`${Math.max(10,height)}px`}
    visibleCount++
  })
  return visibleCount
}

function renderActiveOcrOverlay() {
  if(!activeOcrResult)return
  const showingSource=activeOcrResult.mode==='translate'&&activeOcrResult.showingSource
  const result=showingSource?activeOcrResult.sourceResult:activeOcrResult.displayResult
  const visibleCount=renderOcrOverlayBlocks(result,result?.textBlocks,activeOcrResult.mode==='translate'&&!showingSource)
  if(activeOcrResult.mode==='translate'){
    ocrSummary.textContent=showingSource?t('capture.ocr.source-count',{count:visibleCount}):t('capture.ocr.translated-count',{count:visibleCount})
    ocrToggleSource.textContent=showingSource?t('capture.ocr.show-translation'):t('capture.ocr.show-source')
  }else{
    ocrSummary.textContent=result.cached?t('capture.ocr.count-cached',{count:visibleCount}):t('capture.ocr.count-timed',{count:visibleCount,ms:result.durationMs||0})
  }
}

function showOcrOverlay(result, options = {}) {
  clearOcrResult()
  if(!selection||!result||!Array.isArray(result.textBlocks))return
  const mode=options.mode==='translate'?'translate':'ocr'
  activeOcrResult={
    mode,
    displayResult:result,
    sourceResult:options.sourceResult||result,
    text:String(options.text??result.text??''),
    sourceText:String(options.sourceText??result.text??''),
    showingSource:false
  }
  ocrOverlay.style.left=`${selection.x}px`
  ocrOverlay.style.top=`${selection.y}px`
  ocrOverlay.style.width=`${selection.w}px`
  ocrOverlay.style.height=`${selection.h}px`
  ocrToggleSource.classList.toggle('hidden',mode!=='translate')
  ocrOverlay.classList.remove('hidden')
  renderActiveOcrOverlay()
  ocrResultBar.classList.remove('hidden')
  positionOcrResultBar()
  toolbar.classList.add('hidden')
  syncWatermarkPanel()
}

async function performAction(action) {
  if(processingAction)return
  if(!selection)return
  const captureBounds=initData.captureBounds||initData.displayBounds||{x:0,y:0}
  // §3.2②: a level-2 Ctrl+A selection reaches past the captured display, so everything
  // that turns the selection into pixels or screen coordinates uses its projection into
  // the image. For every shipped selection `exportRect === selection`, so this is the
  // historical value byte for byte; only the all-displays case narrows to what was
  // actually captured (the alternative is metadata describing pixels that do not exist,
  // which the pin window would then try to place).
  const exportRect=exportSelectionRect()
  const selectionBounds={x:Math.round(captureBounds.x+exportRect.x),y:Math.round(captureBounds.y+exportRect.y),width:Math.max(1,Math.round(exportRect.w)),height:Math.max(1,Math.round(exportRect.h))}
  if(action==='record'){
    try{await window.captureAPI.startRegionRecording(selectionBounds,serialMeta())}catch(error){alert(error.message||String(error))}
    return
  }
  if(action==='long'){
    if(annotations.length&&!confirm(t('capture.confirm.long-capture')))return
    // Deliberately the raw selection: long capture is a single-display scroll session of
    // its own, and the level-2 union is documented as "bounds only, no cross-display
    // content", so it must not try to reinterpret the all-displays rectangle here.
    try{await window.captureAPI.startLongCapture({...selection},serialMeta())}catch(error){alert(error.message||String(error))}
    return
  }
  // Recognition and image-to-document actions feed the model the pixels of the image
  // only, so they take the unannotated canvas; every other action is the
  // user-facing picture and keeps the annotations.
  const recognitionActions=['ocr','translate','table','qr','convert']
  // Feature C (plan §6.1) + R0.4 (contracts §8): the three switches are INDEPENDENT, never inferred
  // from the action and never folded into each other.
  //   includeAnnotations - may the consumer see my arrows/boxes/text?
  //   compose            - may the consumer see a finished-look frame?
  //   mask               - must the model be prevented from reading what I covered?
  // A recognition entry is `false / false / true`; every user-facing export is `true / true / false`.
  const pixelOnlyActions = recognitionActions.includes(action)
  const composedActions = !pixelOnlyActions
  const maskedActions = pixelOnlyActions
  // §3.2②: a level-2 Ctrl+A selection reaches past the captured display; the export runs
  // on its projection into the image (see exportSelectionCanvasForAction).
  const output=exportSelectionCanvasForAction(!pixelOnlyActions,exportRect,{ compose: composedActions, mask: maskedActions })
  if(!output){
    // R0.4 fail-closed: a recognition action refuses to run when the occlusion mask could not be
    // computed. Saying nothing would look like a dead button, so report it - and never fall back to
    // sending the unmasked image, which is the failure this whole path exists to prevent.
    if(maskedActions&&hasOccludableBlur(exportRect))alert(t('capture.ocr.mask-unavailable'))
    return
  }
  const meta={source:initData.source,width:output.width,height:output.height,scaleFactor:initData.scaleFactor,selectionBounds}
  try {
    const imageBuffer=await canvasPngBuffer(output)
    // 序号只在导出/编码完成后取值，保证带上本次截图已落的号（P0-7-T7 精确接续）。
    Object.assign(meta,serialMeta())
    if(action==='copy'){if(initData.editPin)await window.captureAPI.pin(imageBuffer,meta);else await window.captureAPI.copy(imageBuffer,meta);closeCaptureWindow()}
    // P0-7-T4：saveMode 由调用方下发（快捷保存 'fast' / 另存为 'dialog'），未下发时回落到设置项。
    if(action==='save'){window.captureAPI.save(imageBuffer,meta,initData.saveMode?initData.saveMode==='fast':!!initData.settings.screenshot.fastSave);return}
    // P0-4-T7②：导出 PDF 后不关闭截图窗口（主进程 handler 刻意不关），用户可以继续复制/保存/贴图。
    if(action==='pdf'){
      if(pdfExporting)return
      pdfExporting=true
      const exportButton=document.getElementById('exportPdf')
      if(exportButton)exportButton.disabled=true
      try{await window.captureAPI.exportPdf(imageBuffer,meta,'a4')}
      finally{pdfExporting=false;if(exportButton)exportButton.disabled=false}
      return
    }
    if(action==='pin'){await window.captureAPI.pin(imageBuffer,meta);closeCaptureWindow()}
    if(action==='convert'){
      // section 6.2 item 2: the main process owns the AI call, the save dialog and the file
      // write, so the renderer just says which format it wants. A cancelled save
      // is not an error and the capture window stays open (the user may retry).
      try{await window.captureAPI.convertImage(imageBuffer,{output:convertOutputFormat})}
      catch(error){alert(error.message||String(error))}
      return
    }
    if(['ocr','translate'].includes(action)&&!initData.editPin){await window.captureAPI.pinAndReannotate(imageBuffer,meta,action);return}
    if(action==='table'||action==='qr'){await window.captureAPI.openRecognition(action,imageBuffer,meta);return}
    if(action==='ocr'||action==='translate'){
      clearOcrResult();setProcessingState(action)
      try {
        const options={scaleFactor:Number(initData.scaleFactor)||1}
        const result=action==='ocr'?await window.captureAPI.ocr(imageBuffer,options):await window.captureAPI.translate(imageBuffer,options)
        showResult(action,result)
        if(initData.autoAction===action)initData.autoAction=''
      } finally {setProcessingState(null)}
    }
  } catch(error){alert(error.message||String(error))}
}

function showResult(type,result) {
  if(type==='ocr'&&result&&typeof result==='object'){
    resultText.value=result.text||''
    const afterAction=initData?.settings?.ocr?.afterAction||'none'
    if(result.text&&['copy','copy-and-close'].includes(afterAction))navigator.clipboard.writeText(result.text).catch(()=>{})
    if(result.text&&afterAction==='copy-and-close'){closeCaptureWindow();return}
    showOcrOverlay(result)
    if(!result.text)resultPanel.classList.remove('hidden')
    return
  }
  if(type==='translate'&&result?.translationResult){
    resultText.value=result.translation||''
    showOcrOverlay(result.translationResult,{mode:'translate',sourceResult:result.ocrResult,text:result.translation,sourceText:result.text})
    return
  }
  resultPanel.classList.remove('hidden'); resultSource.classList.add('hidden'); resultTitle.textContent=t('capture.result.title-ocr'); resultSource.textContent=''; resultText.value=result||''
}

document.querySelectorAll('[data-tool]').forEach((button)=>button.addEventListener('click',()=>setTool(button.dataset.tool)))
lineWidthGroup.addEventListener('click',(event)=>{const button=event.target.closest('[data-annotation-width]');if(button)setAnnotationWidth(button.dataset.annotationWidth,true)})
// B2/B3/B5: one delegated listener for every option group (the key/value pair lives in
// data attributes, so a new group needs no new wiring).
toolOptions.addEventListener('click',(event)=>{const button=event.target.closest('[data-annotation-option]');if(button)setAnnotationOption(button.dataset.annotationOption,button.dataset.annotationOptionValue,button)})
// A3 (D3): the swatch button opens the popover; a preset click is a discrete
// two-target edit (global default + selected item) and anything outside closes it.
colorButton.addEventListener('click',(event)=>{event.stopPropagation();toggleColorPalette()})
colorPalette.addEventListener('click',(event)=>{const button=event.target.closest('[data-annotation-color]');if(!button)return;event.stopPropagation();setAnnotationColor(button.dataset.annotationColor,true)})
document.addEventListener('click',(event)=>{if(colorPalette.classList.contains('hidden'))return;if(colorPalette.contains(event.target)||colorButton.contains(event.target))return;closeColorPalette()})
// A1 (D1): the right button is a quick-select gesture now, so the native context
// menu must never appear (future-proofing the semantics of that button).
canvas.addEventListener('contextmenu',(event)=>event.preventDefault())
colorInput.addEventListener('input',()=>{colorPreview.style.background=colorInput.value;annotationColor=normalizeAnnotationColor(colorInput.value);stageSelectedStyle({color:annotationColor})})
// PR4/A3：取色器关闭时立刻把颜色改动收成一帧（input 的 300ms 兜底计时器随之取消），
// 自定义色同时进入会话内的最近色槽并持久化。
colorInput.addEventListener('change',()=>{rememberRecentColor(colorInput.value);setAnnotationColor(colorInput.value,true)})
;[watermarkContentInput,watermarkOpacityInput,watermarkColorInput,watermarkSpacingInput,watermarkFontSizeInput,watermarkRotationInput,watermarkDateSuffixInput].forEach((input)=>input.addEventListener('input',updateWatermarkPreview))
watermarkContentInput.addEventListener('keydown',(event)=>{if(event.key==='Enter'){event.preventDefault();watermarkApplyButton.click()}})
watermarkApplyButton.addEventListener('click',()=>{
  const item=buildWatermarkAnnotation()
  if(!item){watermarkContentInput.focus();return}
  commitAnnotation(item)
  const {type,x,y,w,h,...params}=item
  window.captureAPI.saveWatermarkSettings(params).catch(()=>{})
  setTool('select')
})
document.getElementById('watermarkCancel').onclick=()=>setTool('select')
// Feature D3 (plan §7.1): the magnifier panel's listeners. The factor and connector groups are
// latched buttons (aria-pressed), the border width is a slider that coalesces like every other
// annotation style: live preview on `input`, ONE undo frame on `change`/`pointerup`.
if (magnifierPanel) {
  magnifierPanel.addEventListener('click', (event) => {
    const factorButton = event.target?.closest?.('[data-magnifier-factor]')
    if (factorButton) { event.stopPropagation(); chooseMagnifierFactor(Number(factorButton.dataset.magnifierFactor)); return }
    const connectorButton = event.target?.closest?.('[data-magnifier-connector]')
    if (connectorButton) { event.stopPropagation(); chooseMagnifierConnector(connectorButton.dataset.magnifierConnector) }
  })
}
if (magnifierStrokeWidthInput) {
  const previewStrokeWidth = () => {
    const value = Math.max(1, Math.min(24, Math.round(Number(magnifierStrokeWidthInput.value) || 1)))
    if (magnifierStrokeWidthValue) magnifierStrokeWidthValue.textContent = `${value}px`
    const item = selectedMagnifier()
    if (!item) return
    const index = annotations.indexOf(item)
    if (index < 0) return
    // Live preview without a frame; the `change` handler below commits exactly one.
    annotations[index] = Object.assign({}, item, { stroke: Object.assign({}, item.stroke, { widthPx: value }) })
    selectedAnnotation = annotations[index]
    render()
  }
  magnifierStrokeWidthInput.addEventListener('input', previewStrokeWidth)
  const commitStrokeWidth = () => {
    const value = Math.max(1, Math.min(24, Math.round(Number(magnifierStrokeWidthInput.value) || 1)))
    if (selectedMagnifier()) editSelectedMagnifier({ stroke: { widthPx: value } })
    else { annotationWidth = value; syncMagnifierPanel() }
  }
  magnifierStrokeWidthInput.addEventListener('change', commitStrokeWidth)
  magnifierStrokeWidthInput.addEventListener('pointerup', commitStrokeWidth)
}
document.getElementById('undo').onclick=()=>undoAnnotations()
document.getElementById('redo').onclick=()=>redoAnnotations()
document.getElementById('elementDelete').onclick=()=>deleteSelectedAnnotation()
document.getElementById('elementDeselect').onclick=()=>setSelectedAnnotation(null)
// P0-5 PR4：层级 ↑↓ 只作用于**选中项**；一次点击一帧快照，undo/redo 精确回退且不串。
elementFront.onclick=()=>reorderSelectedAnnotation(1)
elementBack.onclick=()=>reorderSelectedAnnotation(-1)
document.getElementById('longCapture').onclick=()=>performAction('long')
document.getElementById('copy').onclick=()=>performAction('copy')
document.getElementById('save').onclick=()=>performAction('save')
document.getElementById('exportPdf').onclick=()=>performAction('pdf')
document.getElementById('pin').onclick=()=>performAction('pin')
document.getElementById('ocr').onclick=()=>performAction('ocr')
document.getElementById('table').onclick=()=>performAction('table')
document.getElementById('translate').onclick=()=>performAction('translate')
document.getElementById('record').onclick=()=>performAction('record')
document.getElementById('qr').onclick=()=>performAction('qr')
// section 6.2 item 2: one trigger, two outputs. The popover follows the colour palette's
// open/close contract (aria-expanded mirrors the state, an outside click closes it,
// Escape closes it before the window closes - see the keydown handler).
function openConvertDocMenu(){convertDocMenu.classList.remove('hidden');convertDocButton.setAttribute('aria-expanded','true')}
function closeConvertDocMenu(){convertDocMenu.classList.add('hidden');convertDocButton.setAttribute('aria-expanded','false')}
convertDocButton.onclick=(event)=>{event.stopPropagation();if(convertDocMenu.classList.contains('hidden'))openConvertDocMenu();else closeConvertDocMenu()}
convertDocMenu.addEventListener('click',(event)=>{
  const button=event.target.closest('[data-convert-output]')
  if(!button)return
  event.stopPropagation()
  convertOutputFormat=button.dataset.convertOutput==='html'?'html':'markdown'
  closeConvertDocMenu()
  performAction('convert')
})
document.addEventListener('click',(event)=>{
  if(convertDocMenu.classList.contains('hidden'))return
  if(convertDocMenu.contains(event.target)||convertDocButton.contains(event.target))return
  closeConvertDocMenu()
})
document.getElementById('close').onclick=()=>closeCaptureWindow()
document.getElementById('resultClose').onclick=document.getElementById('resultDone').onclick=()=>resultPanel.classList.add('hidden')
document.getElementById('resultCopy').onclick=async()=>{await navigator.clipboard.writeText(resultText.value);document.getElementById('resultCopy').textContent=t('capture.action.copied');setTimeout(()=>document.getElementById('resultCopy').textContent=t('capture.result.copy'),1000)}
ocrToggleSource.onclick=()=>{if(!activeOcrResult||activeOcrResult.mode!=='translate')return;activeOcrResult.showingSource=!activeOcrResult.showingSource;renderActiveOcrOverlay()}
ocrPlainText.onclick=()=>{if(!activeOcrResult)return;const translated=activeOcrResult.mode==='translate';resultSource.classList.toggle('hidden',!translated);resultTitle.textContent=translated?t('capture.result.title-translate'):t('capture.result.title-ocr');resultSource.textContent=translated?activeOcrResult.sourceText:'';resultText.value=activeOcrResult.text||'';resultPanel.classList.remove('hidden')}
ocrCopyAll.onclick=async()=>{if(!activeOcrResult)return;const text=activeOcrResult.mode==='translate'&&activeOcrResult.showingSource?activeOcrResult.sourceText:activeOcrResult.text;await navigator.clipboard.writeText(text||'');ocrCopyAll.textContent=t('capture.action.copied');setTimeout(()=>ocrCopyAll.textContent=t('capture.ocr.copy-all'),1000)}
document.getElementById('ocrResultClose').onclick=clearOcrResult

addEventListener('keydown',(event)=>{
  if(event.key==='Escape'){if(!resultPanel.classList.contains('hidden'))resultPanel.classList.add('hidden');else if(!convertDocMenu.classList.contains('hidden'))closeConvertDocMenu();else if(!colorPalette.classList.contains('hidden'))closeColorPalette();else if(activeOcrResult)clearOcrResult();else if(!watermarkPanel.classList.contains('hidden'))setTool('select');else if(selectedAnnotationItem())setSelectedAnnotation(null);else closeCaptureWindow();return}
  const focused=document.activeElement
  if(['INPUT','TEXTAREA','SELECT'].includes(focused?.tagName||''))return
  if(focused?.closest?.('#widthGroup'))return
  // P0-5 PR2：方向键微调选中元素（1px；Shift 10px）。方向键不与 Ctrl+A/Z/Y/S、Delete、
  // Enter、Esc 同键，Ctrl/Alt/Meta 组合在 nudgeSelectedAnnotation 里直接放行给下面的既有分支。
  if(nudgeSelectedAnnotation(event))return
  // Batch 1 (contracts §6): in a document editor Ctrl+S commits the document instead of
  // opening an external PNG save dialog, and Ctrl+Shift+S saves a copy as a new record.
  // Every other capture window keeps the shipped Ctrl+S = "save image" behaviour.
  if(event.ctrlKey&&event.key.toLowerCase()==='s'&&documentEditor){
    event.preventDefault()
    const intent=event.shiftKey?'save-copy':'update'
    commitDocumentEditor(intent).then((result)=>{if(result.ok)refreshDocumentDirty()})
    return
  }
  if(event.key==='Enter'&&!event.ctrlKey&&documentEditor){event.preventDefault();return}
  if(event.key==='Enter'&&!event.ctrlKey&&!activeOcrResult&&resultPanel.classList.contains('hidden'))performAction('copy')
  if(event.ctrlKey&&event.key.toLowerCase()==='s'){event.preventDefault();performAction('save')}
  // P0-7-T6：Ctrl+A 选中当前显示器（imageDisplayBounds() 已按 imageBounds/displayBounds 解析）。
  // §3.2②: the press where the selection already covers this display expands once to the
  // desktop union (bounds only - see desktopSelectionBounds). The level-1 branch below is
  // kept byte-identical, so a single-display capture, an editor with imageBounds or a
  // desktop whose union equals the current display all fall straight through to it.
  if(event.ctrlKey&&event.key.toLowerCase()==='a'&&!event.shiftKey&&!event.altKey&&ctrlASelectionExpandsToDesktop()){event.preventDefault();if(activeOcrResult)clearOcrResult();selection={...desktopSelectionBounds()};selectState='selected';pointerDownPoint=null;tip.style.display='none';render()}
  else if(event.ctrlKey&&event.key.toLowerCase()==='a'&&!event.shiftKey&&!event.altKey){event.preventDefault();if(activeOcrResult)clearOcrResult();selection={...imageDisplayBounds()};selectState='selected';pointerDownPoint=null;tip.style.display='none';render()}
  if(event.ctrlKey&&event.key.toLowerCase()==='z'){event.preventDefault();document.getElementById('undo').click()}
  if(event.ctrlKey&&event.key.toLowerCase()==='y'){event.preventDefault();document.getElementById('redo').click()}
  if(event.key==='Delete'){event.preventDefault();deleteSelectedAnnotation()}
})

window.captureAPI.onShown(() => {
  if (!renderReadySent || shutterSoundPlayed) return
  shutterSoundPlayed = true
  if(initData.settings?.screenshot?.shutterSound!==false)playShutterSound()
})

window.captureAPI.onInit((data)=>{
  cancelRenderReady()
  shutterSoundPlayed = false
  clearOcrResult();setProcessingState(null);initData=data; renderReadySent=false; renderReadyPending=false; selectState=data.smartSelect&&data.mode==='region'?'auto':'manual'; pointerDownPoint=null; smartCandidates=[]; smartCandidateLevel=0; document.documentElement.style.setProperty('--primary',data.settings.mainColor||'#e5a44c')
  resetAnnotationState()
  resetSerialNumber(data)
  applyWatermarkSettings(data.settings?.screenshot?.watermark)
  // B4: replaces the T1 setAnnotationWidth/setAnnotationColor init calls - both now
  // write the current tool's remembered block, which is meaningless before it is read.
  applyAnnotationStyles(data.settings)
  if(imageObjectUrl){URL.revokeObjectURL(imageObjectUrl);imageObjectUrl=''}
  // P0-2（S9b）：光标位图在这里预解码（每次 init 都重置，避免沿用上一张的光标）。
  // exportSelectionCanvas 是同步函数，贴图时只认"已解码"的光标，不能在里面等。
  if(data.cursor?.dataUrl){cursorImage=new Image();cursorImage.src=data.cursor.dataUrl}else cursorImage=null
  image=new Image(); image.onload=()=>{if(imageObjectUrl){URL.revokeObjectURL(imageObjectUrl);imageObjectUrl=''}if(data.mode==='fullscreen'||data.mode==='image'||data.mode==='canvas')tip.style.display='none';resizeCanvas();if(selectState==='auto'&&data.cursorPosition)requestSmartSelection(data.cursorPosition);maybeRunAutoAction()}; image.onerror=()=>window.captureAPI.renderError(t('capture.error.decode-failed'))
  if(data.mode==='canvas')image.src=makeBlankCanvas()
  else if(data.imageBuffer){imageObjectUrl=URL.createObjectURL(new Blob([data.imageBuffer],{type:'image/png'}));image.src=imageObjectUrl}
  else window.captureAPI.renderError(t('capture.error.empty-image'))
  // Batch 1: this window may be editing an existing document (history "continue editing").
  // Restore it only after the image is decoded, because the viewport needs naturalWidth.
  if(data.documentEditor){
    const editorPayload=data.documentEditor
    const previousOnload=image.onload
    image.onload=(event)=>{previousOnload?previousOnload(event):null;restoreDocumentEditor(editorPayload)}
  } else {
    documentEditor=null
    renderDocumentInfo()
  }
})

function makeBlankCanvas(){const blank=document.createElement('canvas');blank.width=Math.max(1,innerWidth*dpr);blank.height=Math.max(1,innerHeight*dpr);const c=blank.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,blank.width,blank.height);return blank.toDataURL()}

// ---------- Feature A (plan §4.1/§4.3 A3): the export result bar ----------
// After a successful external export the overlay shows "open / address / open folder" for the file
// that was just written. The renderer only ever holds the resultId; every system action is a main
// process decision (plan §4.2). `capture/export-result-bar.js` owns the DOM and the messaging, so
// this block is only the wiring: which exports produce a receipt, and which API it calls.
const exportResultBar = window.exportResultBar
  ? window.exportResultBar.createExportResultBar({
      document,
      translate: (key, params) => t(key, params),
      getAction: (resultId, action) => window.captureAPI.exportAction(resultId, action),
      log: (...args) => console.warn(...args)
    })
  : null

// Main returns either the legacy path/null (older call sites) or the receipt `{ status:'saved',
// resultId, fileName, kind }`. Only the receipt produces a bar: a cancelled save (null) and a
// failure (thrown) must never look like a successful export (plan §4.2).
function showExportResult(result) {
  if (!exportResultBar) return
  if (result && typeof result === 'object' && result.status === 'saved') exportResultBar.show(result)
}

addEventListener('resize',resizeCanvas)

// ---------- Feature B (plan §5.1/§5.3 B3): region size entry + presets ----------
// Coordinate rule (plan §5.1): this window and `selection` live in DIP. The main process resolves a
// preset / the last region and answers in DIP as well (region-preferences converts pixel<->DIP per
// axis), so nothing here converts scales - mixing display scaleFactor with the editor zoom is the
// exact bug the plan forbids.
//
// Width/height are OUTPUT pixels, but the overlay draws DIP; the two agree 1:1 on a 100% display
// and differ elsewhere. The panel therefore shows the DIP size of the current selection (what the
// user sees) and, when a preset is applied, the main process has already accounted for the display
// scale - the rect it returns is DIP, so it is applied directly.
let regionPreferencesCache = null

function setRegionStatus(key, params, isError) {
  if (!regionStatus) return
  regionStatus.textContent = key ? t(key, params) : ''
  regionStatus.classList.toggle('hidden', !key)
  regionStatus.classList.toggle('error', isError === true)
}

function positionRegionPanel() {
  if (!regionPanel || regionPanel.classList.contains('hidden') || !selection) return
  const rect = regionPanel.getBoundingClientRect()
  let left = selection.x + selection.w - rect.width
  let top = selection.y - rect.height - 10
  if (top < 8) top = selection.y + selection.h + 10
  left = Math.max(8, Math.min(left, innerWidth - rect.width - 8))
  top = Math.max(8, Math.min(top, innerHeight - rect.height - 8))
  regionPanel.style.left = `${left}px`
  regionPanel.style.top = `${top}px`
}

// The toggle only appears once a selection exists; before that there is nothing to size (plan §5.3
// keeps the common path unchanged: no selection, no extra controls).
function syncRegionUi() {
  if (!regionToggle) return
  const available = !!selection && selection.w >= 2 && selection.h >= 2 &&
    !activeOcrResult && !processingAction && !selecting && !dragging && !resizing &&
    selectState !== 'auto' && !documentEditor
  regionToggle.classList.toggle('available', available)
  if (available) {
    const rect = toolbar.classList.contains('hidden') ? null : toolbar.getBoundingClientRect()
    const badge = { left: Math.max(4, selection.x), top: Math.max(4, selection.y - 27) }
    regionToggle.style.left = `${rect ? rect.left : badge.left}px`
    regionToggle.style.top = `${rect ? Math.max(8, rect.top - 30) : badge.top}px`
  }
  if (!available) closeRegionPanel()
}

function currentSelectionSize() {
  return selection ? { width: Math.max(1, Math.round(selection.w)), height: Math.max(1, Math.round(selection.h)) } : null
}

function syncRegionInputs() {
  const size = currentSelectionSize()
  if (!size) return
  if (regionWidthInput) regionWidthInput.value = String(size.width)
  if (regionHeightInput) regionHeightInput.value = String(size.height)
}

function renderPresetOptions(preferences) {
  if (!regionPresets) return
  const presets = Array.isArray(preferences?.presets) ? preferences.presets : []
  const previous = regionPresets.value
  regionPresets.replaceChildren()
  const placeholder = document.createElement('option')
  placeholder.value = ''
  placeholder.textContent = presets.length ? t('capture.region.presets') : t('capture.region.preset-empty')
  regionPresets.appendChild(placeholder)
  for (const preset of presets) {
    const option = document.createElement('option')
    option.value = preset.id
    option.textContent = `${preset.name} (${preset.widthPx}×${preset.heightPx})`
    regionPresets.appendChild(option)
  }
  if (previous && presets.some((preset) => preset.id === previous)) regionPresets.value = previous
  if (regionDeletePreset) regionDeletePreset.disabled = !presets.length
}

async function refreshRegionPreferences() {
  try {
    const result = await window.captureAPI.regionGetPreferences()
    regionPreferencesCache = result && result.ok ? result : null
  } catch (error) {
    regionPreferencesCache = null
  }
  renderPresetOptions(regionPreferencesCache)
  if (regionReuseLast) regionReuseLast.disabled = !regionPreferencesCache?.lastAvailable?.capture
  return regionPreferencesCache
}

// Applies a resolved DIP rect to the live selection. `adjusted` is reported, never swallowed: the
// plan requires telling the user the region was adjusted instead of silently claiming the preset
// was honoured.
function applyRegionRect(result) {
  if (!result || !result.ok || !result.rect) {
    const code = result?.code || 'unresolved'
    setRegionStatus(code === 'no-last-region' ? 'capture.region.no-last' : 'capture.region.preset-invalid', null, true)
    return false
  }
  const bounds = imageDisplayBounds()
  const rect = result.rect
  const x = Math.max(bounds.x, Math.min(bounds.x + bounds.w - 1, Math.round(rect.x - (initData?.captureBounds?.x || 0))))
  const y = Math.max(bounds.y, Math.min(bounds.y + bounds.h - 1, Math.round(rect.y - (initData?.captureBounds?.y || 0))))
  const w = Math.max(1, Math.min(Math.round(rect.width), Math.round(bounds.x + bounds.w - x)))
  const h = Math.max(1, Math.min(Math.round(rect.height), Math.round(bounds.y + bounds.h - y)))
  // A geometry change to the region drops annotations exactly like a hand-redraw does (they are
  // positioned in stage coordinates); asking first keeps that reversible.
  if (annotations.length && !confirmDiscardAnnotations()) return false
  selection = { x, y, w, h }
  selectState = 'selected'
  clearAnnotationsForNewSelection()
  tip.style.display = 'none'
  render()
  syncRegionInputs()
  const adjusted = Array.isArray(result.adjusted) ? result.adjusted : []
  const clamped = adjusted.find((entry) => entry.code === 'clamped-to-screen')
  if (clamped?.appliedPixelSize) {
    setRegionStatus('capture.region.clamped', { width: clamped.appliedPixelSize.width, height: clamped.appliedPixelSize.height }, false)
  } else if (adjusted.some((entry) => entry.code === 'rect-outside-display')) {
    setRegionStatus('capture.region.rect-outside-display', null, false)
  } else if (adjusted.some((entry) => entry.code === 'display-changed')) {
    setRegionStatus('capture.region.display-changed', null, false)
  } else if (adjusted.length) {
    setRegionStatus('capture.region.adjusted', null, false)
  } else {
    setRegionStatus('', null, false)
  }
  return true
}

async function openRegionPanel() {
  if (!regionPanel) return
  regionPanel.classList.remove('hidden')
  if (regionToggle) regionToggle.setAttribute('aria-expanded', 'true')
  syncRegionInputs()
  setRegionStatus('', null, false)
  await refreshRegionPreferences()
  positionRegionPanel()
}

function closeRegionPanel() {
  if (!regionPanel) return
  regionPanel.classList.add('hidden')
  if (regionToggle) regionToggle.setAttribute('aria-expanded', 'false')
}

// Enter in the width/height fields applies the typed size. The size is clamped to the stage here
// (the main process clamps to the *screen*): both limits are real, and the smaller one wins.
function applyTypedRegionSize() {
  const typedWidth = Math.round(Number(regionWidthInput?.value))
  const typedHeight = Math.round(Number(regionHeightInput?.value))
  if (!Number.isFinite(typedWidth) || !Number.isFinite(typedHeight) || typedWidth < 1 || typedHeight < 1) {
    setRegionStatus('capture.region.preset-invalid', null, true)
    return
  }
  // A locked ratio wins over the typed pair: the user asked for that relationship, so the height is
  // derived rather than the input being rejected (plan §5.1: a fixed ratio only couples the size).
  // It never touches the document crop - only the region being captured.
  const ratio = parseRatio(regionRatioValue)
  const width = typedWidth
  const height = ratio ? Math.max(1, Math.round(typedWidth / ratio)) : typedHeight
  const bounds = imageDisplayBounds()
  const w = Math.max(1, Math.min(width, Math.round(bounds.w)))
  const h = Math.max(1, Math.min(height, Math.round(bounds.h)))
  // Preserve the region's top-left anchor (plan §5.1: a size lock keeps the drag anchor): the user
  // is resizing, not moving, so the anchor must not jump to the centre.
  const anchorX = selection ? Math.max(bounds.x, Math.min(selection.x, bounds.x + bounds.w - 1)) : bounds.x
  const anchorY = selection ? Math.max(bounds.y, Math.min(selection.y, bounds.y + bounds.h - 1)) : bounds.y
  if (annotations.length && !confirmDiscardAnnotations()) return
  selection = {
    x: Math.min(anchorX, bounds.x + bounds.w - w),
    y: Math.min(anchorY, bounds.y + bounds.h - h),
    w,
    h
  }
  selectState = 'selected'
  clearAnnotationsForNewSelection()
  tip.style.display = 'none'
  render()
  syncRegionInputs()
  positionRegionPanel()
  setRegionStatus(w !== width || h !== height ? 'capture.region.clamped' : '', w !== width || h !== height ? { width: w, height: h } : null, false)
}

if (regionToggle) {
  regionToggle.addEventListener('click', (event) => {
    event.stopPropagation()
    if (regionPanel.classList.contains('hidden')) openRegionPanel()
    else closeRegionPanel()
  })
}
if (regionApplySize) regionApplySize.addEventListener('click', applyTypedRegionSize)
if (regionReuseLast) {
  regionReuseLast.addEventListener('click', async () => {
    try {
      const result = await window.captureAPI.regionResolve({ mode: 'capture', last: true })
      applyRegionRect(result)
    } catch (error) {
      setRegionStatus('capture.region.preset-invalid', null, true)
    }
  })
}
if (regionPresets) {
  regionPresets.addEventListener('change', async () => {
    const presetId = regionPresets.value
    if (!presetId) return
    try {
      const result = await window.captureAPI.regionResolve({ mode: 'capture', presetId })
      applyRegionRect(result)
    } catch (error) {
      setRegionStatus('capture.region.preset-invalid', null, true)
    }
  })
}
if (regionSavePreset) {
  regionSavePreset.addEventListener('click', async () => {
    const size = currentSelectionSize()
    if (!size) return
    const name = prompt(t('capture.region.preset-name'), `${size.width}×${size.height}`)
    if (!name || !name.trim()) return
    try {
      const result = await window.captureAPI.regionSavePreset({ name: name.trim(), widthPx: size.width, heightPx: size.height })
      if (result?.ok === false) {
        // One direct call per code so the locale key is adjacent to the condition (and so the i18n
        // contract test can see it as a literal).
        if (result.code === 'limit-reached') {
          setRegionStatus('capture.region.preset-limit', { max: regionPreferencesCache?.limits?.maxPresets || 20 }, true)
        } else if (result.code === 'duplicate-name') {
          setRegionStatus('capture.region.preset-duplicate', null, true)
        } else {
          setRegionStatus('capture.region.preset-invalid', null, true)
        }
        return
      }
      await refreshRegionPreferences()
      if (result?.preset?.id && regionPresets) regionPresets.value = result.preset.id
      setRegionStatus('', null, false)
    } catch (error) {
      setRegionStatus('capture.region.preset-invalid', null, true)
    }
  })
}
if (regionDeletePreset) {
  regionDeletePreset.addEventListener('click', async () => {
    const presetId = regionPresets?.value
    if (!presetId) return
    try {
      const result = await window.captureAPI.regionDeletePreset(presetId)
      if (result?.ok === false) { setRegionStatus('capture.region.preset-invalid', null, true); return }
      await refreshRegionPreferences()
      setRegionStatus('', null, false)
    } catch (error) {
      setRegionStatus('capture.region.preset-invalid', null, true)
    }
  })
}
// Feature B (plan §5.1): a fixed ratio couples width and height ONLY. It must never rewrite the
// document crop or move the region, so this helper just derives the missing edge from the edited
// one, keeping the region's top-left anchor intact.
function parseRatio(value) {
  if (typeof value !== 'string' || value === 'free') return null
  const [width, height] = value.split(':').map((part) => Number(part))
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return width / height
}

// Recomputes the partner edge when the user edits one field under a locked ratio. `edited` says which
// input the user is typing in, so the typing itself is never overridden mid-keystroke.
function syncRatioPartner(edited) {
  const ratio = parseRatio(regionRatioValue)
  if (!ratio) return
  const width = Math.round(Number(regionWidthInput?.value))
  const height = Math.round(Number(regionHeightInput?.value))
  if (edited === 'width' && Number.isFinite(width) && width > 0) {
    if (regionHeightInput) regionHeightInput.value = String(Math.max(1, Math.round(width / ratio)))
    return
  }
  if (edited === 'height' && Number.isFinite(height) && height > 0) {
    if (regionWidthInput) regionWidthInput.value = String(Math.max(1, Math.round(height * ratio)))
  }
}

// One delegated listener for the ratio group: the active lock is module state, and the pressed state
// is the only UI echo. Switching to a locked ratio re-derives the height from the current width, so
// the very next "apply" already satisfies the lock.
for (const button of regionRatioButtons) {
  button.addEventListener('click', () => {
    regionRatioValue = button.dataset.regionRatio || 'free'
    for (const other of regionRatioButtons) {
      const active = other === button
      other.classList.toggle('active', active)
      other.setAttribute('aria-pressed', active ? 'true' : 'false')
    }
    syncRatioPartner('width')
  })
}
// Typing in either field keeps a locked ratio satisfied; `input` (not `change`) so the partner edge
// follows the caret rather than jumping only on blur.
if (regionWidthInput) {
  regionWidthInput.addEventListener('input', () => syncRatioPartner('width'))
  regionWidthInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); applyTypedRegionSize() } })
}
if (regionHeightInput) {
  regionHeightInput.addEventListener('input', () => syncRatioPartner('height'))
  regionHeightInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); applyTypedRegionSize() } })
}

// Clicking elsewhere dismisses the popover, like the colour palette and the convert-doc menu.
document.addEventListener('click', (event) => {
  if (!regionPanel || regionPanel.classList.contains('hidden')) return
  if (regionPanel.contains(event.target) || regionToggle?.contains(event.target)) return
  closeRegionPanel()
})
addEventListener('beforeunload',()=>{cancelRenderReady();if(renderRequest)cancelAnimationFrame(renderRequest);if(imageObjectUrl)URL.revokeObjectURL(imageObjectUrl)})
window.captureAPI.ready()

// ---------- P0-1-T4 / S11: interface language ----------
// Boot: capture.html declares no `data-language`, so the documented priority applies —
// localStorage (a choice persisted by whichever window switched last) and then the
// default zh-CN. restoreStoredLanguage() applies the stored choice; applyTranslations()
// then fills every data-i18n* marker (and is the correct no-op-with-fallback pass when
// there is no stored choice). Both must run after the markup exists, which is why they
// sit at the end of this file.
restoreStoredLanguage()
applyTranslations()
// Hot switch (mirror of `theme`): the settings effect broadcasts i18n:language to every
// open window, so re-resolve the language and re-scan the DOM.
window.captureAPI.onInterfaceLanguage((language) => {
  setLanguage(language)
  applyTranslations()
  // Strings capture.js writes itself are not data-i18n markers, so re-derive the ones
  // whose owner is still on screen. All three are idempotent re-renders of live state.
  if (processingAction) setProcessingState(processingAction)
  if (activeOcrResult) renderActiveOcrOverlay()
  if (!resultPanel.classList.contains('hidden')) resultTitle.textContent = t(activeOcrResult?.mode === 'translate' ? 'capture.result.title-translate' : 'capture.result.title-ocr')
})
