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
const tip = document.getElementById('tip')
const loading = document.getElementById('loading')
const loadingText = loading.querySelector('b')
const shutterSound = document.getElementById('shutterSound')
const colorInput = document.getElementById('color')
const colorPreview = document.getElementById('colorSwatch')
const colorButton = document.getElementById('colorButton')
const colorPalette = document.getElementById('colorPalette')
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
  highlightWidth
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

let initData = null
let image = null
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
// A2: the tools whose stroke width is meaningful (all but select/blur/watermark).
const WIDTH_TOOLS = new Set(['rect', 'ellipse', 'arrow', 'line', 'pen', 'highlight', 'text', 'serial'])
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

// P0-7-T5：每次截图窗口初始化时播一次快门音，受 screenshot.shutterSound 控制。
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
function closeCaptureWindow() {
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
    else{const bounds=imageDisplayBounds();backgroundCtx.drawImage(image,bounds.x,bounds.y,bounds.w,bounds.h)}
  }
}

function reportRenderReady() {
  if (renderReadySent || renderReadyPending || !image?.complete || !image.naturalWidth || !initData) return
  const expected = initData.captureBounds || initData.displayBounds
  if (expected && (Math.abs(innerWidth - expected.width) > 2 || Math.abs(innerHeight - expected.height) > 2)) return
  renderReadyPending = true
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (renderReadySent || !image?.complete || !image.naturalWidth) {
      renderReadyPending = false
      return
    }
    renderReadySent = true
    renderReadyPending = false
    window.captureAPI.renderReady()
  }))
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
  if (item.type === 'pen') { context.beginPath(); item.points.forEach((point,index) => { const px=(point.x-offsetX)*scaleX, py=(point.y-offsetY)*scaleY; index?context.lineTo(px,py):context.moveTo(px,py) }); context.stroke() }
  if (item.type === 'highlight') { context.globalAlpha=resolveAlpha(item.alpha); context.lineWidth=highlightWidth(baseWidth,widthScale); context.beginPath(); context.moveTo(x,y); context.lineTo(x2,y2); context.stroke() }
  if (item.type === 'text') { context.font = `${item.bold === true ? 'bold ' : ''}${textFontSize(baseWidth,widthScale)}px -apple-system,"Microsoft YaHei",sans-serif`; context.textBaseline='top'; context.fillText(item.text,x,y) }
  if (item.type === 'serial') { const radius=serialRadius(baseWidth,widthScale); context.beginPath(); context.arc(x,y,radius,0,Math.PI*2); context.fill(); context.fillStyle='#fff'; context.font=`bold ${radius}px sans-serif`; context.textAlign='center'; context.textBaseline='middle'; context.fillText(String(item.number),x,y+1) }
  if (item.type === 'watermark') drawWatermark(context,item,scaleX,scaleY,offsetX,offsetY)
  if (item.type === 'blur' && sourceImage) {
    const left=Math.min(x,x2), top=Math.min(y,y2), w=Math.abs(x2-x), h=Math.abs(y2-y)
    if (w>2&&h>2) { const tiny=document.createElement('canvas'); tiny.width=Math.max(1,Math.round(w/12)); tiny.height=Math.max(1,Math.round(h/12)); const t=tiny.getContext('2d'); const bounds=imageDisplayBounds(); const sourceScaleX=sourceImage.naturalWidth/bounds.w, sourceScaleY=sourceImage.naturalHeight/bounds.h; t.drawImage(sourceImage,(Math.min(item.x,item.x2)-bounds.x)*sourceScaleX,(Math.min(item.y,item.y2)-bounds.y)*sourceScaleY,Math.abs(item.x2-item.x)*sourceScaleX,Math.abs(item.y2-item.y)*sourceScaleY,0,0,tiny.width,tiny.height); context.imageSmoothingEnabled=false; context.drawImage(tiny,left,top,w,h); context.imageSmoothingEnabled=true }
  }
  context.restore()
}

function renderOverlay() {
  if (!image) return
  ctx.setTransform(dpr,0,0,dpr,0,0)
  ctx.clearRect(0,0,innerWidth,innerHeight)
  if (!selection) {
    ctx.fillStyle = initData?.settings?.screenshot?.selectionMask || 'rgba(0,0,0,.46)'
    ctx.fillRect(0,0,innerWidth,innerHeight)
    return
  }
  if(!initData?.imageBounds){ctx.save(); ctx.fillStyle=initData?.settings?.screenshot?.selectionMask||'rgba(0,0,0,.46)'; ctx.beginPath(); ctx.rect(0,0,innerWidth,innerHeight); ctx.rect(selection.x,selection.y,selection.w,selection.h); ctx.fill('evenodd'); ctx.restore()}
  ctx.save(); ctx.strokeStyle='#36a3ff'; ctx.lineWidth=1; ctx.setLineDash([4,3]); ctx.strokeRect(selection.x+.5,selection.y+.5,selection.w,selection.h); ctx.restore()
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

function drawHandles() {
  if (!selection || currentTool !== 'select') return
  const points=[[selection.x,selection.y],[selection.x+selection.w/2,selection.y],[selection.x+selection.w,selection.y],[selection.x,selection.y+selection.h/2],[selection.x+selection.w,selection.y+selection.h/2],[selection.x,selection.y+selection.h],[selection.x+selection.w/2,selection.y+selection.h],[selection.x+selection.w,selection.y+selection.h]]
  ctx.save(); ctx.fillStyle='#fff'; ctx.strokeStyle='#e5a44c'; ctx.lineWidth=1; points.forEach(([x,y])=>{ctx.fillRect(x-4,y-4,8,8);ctx.strokeRect(x-4,y-4,8,8)}); ctx.restore()
}

// 选中项虚线框：画在标注之后、手柄之前（方案 §8.4 指定插入点）。坐标同样是屏幕 CSS
// 坐标；颜色取 shared/tokens.css 的 --primary（onInit 已把用户主色写进 :root）。
function selectedAccent() {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()
  return value || '#36a3ff'
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

function setAnnotationOption(key, rawValue) {
  const tool = optionRowTool()
  const fields = TOOL_OPTION_FIELDS[tool]
  if (!fields || !fields.includes(key)) return
  const parse = OPTION_VALUE_PARSERS[key]
  const value = parse ? parse(rawValue) : rawValue
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
  updateElementBar()
  if (!selection || selection.w<2 || selection.h<2) { toolbar.classList.add('hidden'); sizeBadge.style.display='none'; syncWatermarkPanel(); return }
  document.getElementById('record').disabled=selection.w<16||selection.h<16
  const hideSizeBadge=['ocr','translate'].includes(processingAction)||!!activeOcrResult||['ocr','translate'].includes(initData?.autoAction)
  sizeBadge.style.display=hideSizeBadge?'none':'block'; sizeBadge.textContent=`${Math.round(selection.w)} × ${Math.round(selection.h)}`; sizeBadge.style.left=`${Math.max(4,selection.x)}px`; sizeBadge.style.top=`${Math.max(4,selection.y-27)}px`
  if (activeOcrResult) { toolbar.classList.add('hidden'); positionOcrResultBar(); syncWatermarkPanel(); return }
  if (selectState==='auto'||selecting||dragging||resizing) { toolbar.classList.add('hidden'); syncWatermarkPanel(); return }
  toolbar.classList.remove('hidden')
  // D6 + the pin re-annotate fix: below the region when it fits, above it when only that
  // fits, otherwise docked inside hugging the region's bottom - never clipped, and never
  // clamped into the top of the region the way the old fallback did.
  const placement=toolbarPlacement()
  toolbar.style.left=`${placement.left}px`; toolbar.style.top=`${placement.top}px`; toolbar.classList.toggle('above',placement.above)
  syncWatermarkPanel()
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

function setTool(tool) {
  // 方案 §8.4：换工具即清选中，避免虚线框/浮动条挂在另一个工具上。
  setSelectedAnnotation(null)
  currentTool=tool
  document.querySelectorAll('[data-tool]').forEach((button)=>button.classList.toggle('active',button.dataset.tool===tool))
  canvas.style.cursor=tool==='select'?(selection?'move':'crosshair'):'crosshair'
  if(tool==='watermark'){activeAnnotation=buildWatermarkAnnotation();render()}
  else if(activeAnnotation?.type==='watermark'){activeAnnotation=null;render()}
  // B1: the second row follows the tool (and, once B2-B5 land, also the selection).
  syncToolOptionsRow()
  syncWatermarkPanel()
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
}

// 提交一帧快照：截断 redo 分支 → 深拷贝当前 annotations → 上限 60 条（丢最旧的一条）。
// 注意：这里**不再**取消待收口的微调/样式帧 —— 那会把两次用户操作合并进同一帧（Ctrl+Z 一次退两步）。
// 每个"用户动作"路径在压帧前先调 flushCoalescedEdits()，让待收口的合并型编辑各自独立成帧。
function snapshotAnnotations() {
  annotationHistory.length = historyIndex + 1
  annotationHistory.push(cloneAnnotations(annotations))
  if (annotationHistory.length > MAX_ANNOTATION_HISTORY) annotationHistory.splice(0, annotationHistory.length - MAX_ANNOTATION_HISTORY)
  historyIndex = annotationHistory.length - 1
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
  syncSelectedAnnotation()
  render()
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
function beginPendingMove(item, point, event) {
  if (!item) return
  pendingMove = { id: item.id, origin: item, start: { x: point.x, y: point.y }, thresholdPassed: false }
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
  const moved = clampAnnotationToStage(
    translateAnnotation(state.origin, point.x - state.start.x, point.y - state.start.y),
    stageRect()
  )
  if (!moved) return
  annotations[index] = moved
  selectedAnnotation = moved
  render()
}

function annotationWasMoved(item, origin) {
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
  })
  if (changed) render()
  return changed
}

// 离散样式操作（线宽按钮）：立刻压一帧。若还有未收口的颜色改动，先把它单独收一帧 —— 两次
// 用户操作不该挤进同一个撤销步（这正是"undo/redo 不串"）。
function commitSelectedStyle(patch) {
  // 待收口的微调/样式先各自成帧，再压这次离散样式改动 —— 保证"一次用户操作一帧"。
  flushCoalescedEdits()
  if (!applyStyleToSelectedAnnotation(patch)) return false
  snapshotAnnotations()
  render()
  return true
}

// 连续样式操作（取色器 input）：应用即时可见，快照静默 STYLE_COMMIT_DELAY 毫秒后收口；
// 取色器关闭时触发的 change 会立刻收口（见文件末尾的 colorInput 监听）。
function stageSelectedStyle(patch) {
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

function finishSelection() {
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
    beginPendingMove(hit, point, event)
    return
  }
  if (currentTool === 'select') setSelectedAnnotation(null)
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
    if(bodyItem){beginPendingMove(bodyItem,point,event);return}
    // PR1 元素命中（逆序取最上层）→ 选中；未命中才退回"拖选区"。
    const hit=findAnnotationAt(annotations,point)
    if(hit){
      // B6 (D8): shift+click toggles the hit item in or out of the selection.
      if(event.shiftKey){toggleSelectedAnnotation(hit);updateSelectionCursor(point);return}
      setSelectedAnnotation(hit);updateSelectionCursor(point);return
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
  // B7 (D11): a pen press on either endpoint of the topmost stroke continues it.
  if (currentTool==='pen') {
    const target=penContinuationTarget(annotations,point,PEN_CONTINUATION_DISTANCE)
    if(target&&beginPenContinuation(target,point,event))return
  }
  activeAnnotation={type:currentTool,x:point.x,y:point.y,x2:point.x,y2:point.y,...style}
  if (currentTool==='pen') activeAnnotation.points=[point]
})

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
  if (selecting) { selection=normalizeRect(startPoint,point); render(); return }
  if (resizing&&selection) { selection=resizeSelection(resizing.initial,resizing.handle,point,{width:innerWidth,height:innerHeight}); updateSelectionCursor(point); render(); return }
  if (pendingMove) { moveAnnotationTo(point); return }
  // PR3 元素缩放：新 box 由 resizeSelection 在**舞台**坐标系里算出，再交给纯函数写回新对象。
  if (resizingAnnotation) { resizeAnnotationTo(point); updateSelectionCursor(point); return }
  if (dragging&&selection) { const dx=point.x-startPoint.x,dy=point.y-startPoint.y; selection.x=Math.max(0,Math.min(innerWidth-selection.w,selection.x+dx)); selection.y=Math.max(0,Math.min(innerHeight-selection.h,selection.y+dy)); startPoint=point; render(); return }
  // B6 wave 2: the marquee grows with the pointer and repaints itself (no frame).
  if (marquee) { updateMarquee(point); return }
  if (activeAnnotation) { activeAnnotation.x2=point.x; activeAnnotation.y2=point.y; if(activeAnnotation.type==='pen'&&activeAnnotation.points.length<MAX_PEN_POINTS)activeAnnotation.points.push(point); render() }
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
  const selectionBounds={x:Math.round(captureBounds.x+selection.x),y:Math.round(captureBounds.y+selection.y),width:Math.max(1,Math.round(selection.w)),height:Math.max(1,Math.round(selection.h))}
  if(action==='record'){
    try{await window.captureAPI.startRegionRecording(selectionBounds,serialMeta())}catch(error){alert(error.message||String(error))}
    return
  }
  if(action==='long'){
    if(annotations.length&&!confirm(t('capture.confirm.long-capture')))return
    try{await window.captureAPI.startLongCapture({...selection},serialMeta())}catch(error){alert(error.message||String(error))}
    return
  }
  const recognitionActions=['ocr','translate','table','qr']
  const output=exportSelectionCanvas(!recognitionActions.includes(action)); if(!output)return
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
toolOptions.addEventListener('click',(event)=>{const button=event.target.closest('[data-annotation-option]');if(button)setAnnotationOption(button.dataset.annotationOption,button.dataset.annotationOptionValue)})
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
document.getElementById('close').onclick=()=>closeCaptureWindow()
document.getElementById('resultClose').onclick=document.getElementById('resultDone').onclick=()=>resultPanel.classList.add('hidden')
document.getElementById('resultCopy').onclick=async()=>{await navigator.clipboard.writeText(resultText.value);document.getElementById('resultCopy').textContent=t('capture.action.copied');setTimeout(()=>document.getElementById('resultCopy').textContent=t('capture.result.copy'),1000)}
ocrToggleSource.onclick=()=>{if(!activeOcrResult||activeOcrResult.mode!=='translate')return;activeOcrResult.showingSource=!activeOcrResult.showingSource;renderActiveOcrOverlay()}
ocrPlainText.onclick=()=>{if(!activeOcrResult)return;const translated=activeOcrResult.mode==='translate';resultSource.classList.toggle('hidden',!translated);resultTitle.textContent=translated?t('capture.result.title-translate'):t('capture.result.title-ocr');resultSource.textContent=translated?activeOcrResult.sourceText:'';resultText.value=activeOcrResult.text||'';resultPanel.classList.remove('hidden')}
ocrCopyAll.onclick=async()=>{if(!activeOcrResult)return;const text=activeOcrResult.mode==='translate'&&activeOcrResult.showingSource?activeOcrResult.sourceText:activeOcrResult.text;await navigator.clipboard.writeText(text||'');ocrCopyAll.textContent=t('capture.action.copied');setTimeout(()=>ocrCopyAll.textContent=t('capture.ocr.copy-all'),1000)}
document.getElementById('ocrResultClose').onclick=clearOcrResult

addEventListener('keydown',(event)=>{
  if(event.key==='Escape'){if(!resultPanel.classList.contains('hidden'))resultPanel.classList.add('hidden');else if(!colorPalette.classList.contains('hidden'))closeColorPalette();else if(activeOcrResult)clearOcrResult();else if(!watermarkPanel.classList.contains('hidden'))setTool('select');else if(selectedAnnotationItem())setSelectedAnnotation(null);else closeCaptureWindow();return}
  const focused=document.activeElement
  if(['INPUT','TEXTAREA','SELECT'].includes(focused?.tagName||''))return
  if(focused?.closest?.('#widthGroup'))return
  // P0-5 PR2：方向键微调选中元素（1px；Shift 10px）。方向键不与 Ctrl+A/Z/Y/S、Delete、
  // Enter、Esc 同键，Ctrl/Alt/Meta 组合在 nudgeSelectedAnnotation 里直接放行给下面的既有分支。
  if(nudgeSelectedAnnotation(event))return
  if(event.key==='Enter'&&!event.ctrlKey&&!activeOcrResult&&resultPanel.classList.contains('hidden'))performAction('copy')
  if(event.ctrlKey&&event.key.toLowerCase()==='s'){event.preventDefault();performAction('save')}
  // P0-7-T6：Ctrl+A 选中当前显示器（imageDisplayBounds() 已按 imageBounds/displayBounds 解析）。
  if(event.ctrlKey&&event.key.toLowerCase()==='a'&&!event.shiftKey&&!event.altKey){event.preventDefault();if(activeOcrResult)clearOcrResult();selection={...imageDisplayBounds()};selectState='selected';pointerDownPoint=null;tip.style.display='none';render()}
  if(event.ctrlKey&&event.key.toLowerCase()==='z'){event.preventDefault();document.getElementById('undo').click()}
  if(event.ctrlKey&&event.key.toLowerCase()==='y'){event.preventDefault();document.getElementById('redo').click()}
  if(event.key==='Delete'){event.preventDefault();deleteSelectedAnnotation()}
})

window.captureAPI.onInit((data)=>{
  clearOcrResult();setProcessingState(null);initData=data; renderReadySent=false; renderReadyPending=false; selectState=data.smartSelect&&data.mode==='region'?'auto':'manual'; pointerDownPoint=null; smartCandidates=[]; smartCandidateLevel=0; document.documentElement.style.setProperty('--primary',data.settings.mainColor||'#e5a44c')
  resetAnnotationState()
  resetSerialNumber(data)
  if(data.settings?.screenshot?.shutterSound!==false)playShutterSound()
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
})

function makeBlankCanvas(){const blank=document.createElement('canvas');blank.width=Math.max(1,innerWidth*dpr);blank.height=Math.max(1,innerHeight*dpr);const c=blank.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,blank.width,blank.height);return blank.toDataURL()}
addEventListener('resize',resizeCanvas)
addEventListener('beforeunload',()=>{if(renderRequest)cancelAnimationFrame(renderRequest);if(imageObjectUrl)URL.revokeObjectURL(imageObjectUrl)})
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
