const video = document.getElementById('source')
const preview = document.getElementById('preview')
const previewContext = preview.getContext('2d')
const statusElement = document.getElementById('status')
const sizeElement = document.getElementById('size')
const stripsElement = document.getElementById('strips')
const confidenceElement = document.getElementById('confidence')
const emptyPreview = document.getElementById('emptyPreview')
const toggleButton = document.getElementById('toggle')
const adjustSelectionButton = document.getElementById('adjustSelection')
const trimStartInput = document.getElementById('trimStart')
const trimEndInput = document.getElementById('trimEnd')
const directionButtons = [...document.querySelectorAll('[data-axis]')]
const actionButtons = [...document.querySelectorAll('.actions button')]

let initData = null
let stream = null
let worker = null
let axis = 'vertical'
let capturing = false
let busy = false
let selectionEditing = false
let timer = null
let requestId = 0
let total = { width: 0, height: 0, strips: 0, trimStart: 0, trimEnd: 0 }
const workerRequests = new Map()
const cropCanvas = document.createElement('canvas')
const cropContext = cropCanvas.getContext('2d', { willReadFrequently: true })
const analysisCanvas = document.createElement('canvas')
const analysisContext = analysisCanvas.getContext('2d', { willReadFrequently: true })

function setStatus(message, confidence) {
  statusElement.textContent = message
  if (Number.isFinite(confidence)) confidenceElement.textContent = `${Math.round(confidence * 100)}%`
}

function updateControls() {
  document.body.classList.toggle('capturing', capturing)
  toggleButton.textContent = capturing ? '暂停' : (total.strips ? '继续' : '开始')
  directionButtons.forEach((button) => { button.disabled = total.strips > 0 })
  adjustSelectionButton.disabled = capturing || busy
  adjustSelectionButton.classList.toggle('active', selectionEditing)
  adjustSelectionButton.textContent = selectionEditing ? '✓ 完成' : '⌖ 选区'
  trimStartInput.disabled = !total.strips || capturing || busy
  trimEndInput.disabled = !total.strips || capturing || busy
  actionButtons.forEach((button) => { button.disabled = !total.strips || busy })
}

function updateTrimPreview() {
  const rawLength = (axis === 'vertical' ? total.height : total.width) + (total.trimStart || 0) + (total.trimEnd || 0)
  if (!rawLength) { preview.style.clipPath = ''; return }
  const start = Math.min(49.5, (total.trimStart || 0) / rawLength * 100)
  const end = Math.min(49.5, (total.trimEnd || 0) / rawLength * 100)
  preview.style.clipPath = axis === 'vertical'
    ? `inset(${start}% 0 ${end}% 0)`
    : `inset(0 ${end}% 0 ${start}%)`
}

function workerFrame(rgba, width, height) {
  return new Promise((resolve) => {
    const id = ++requestId
    workerRequests.set(id, resolve)
    worker.postMessage({ type: 'frame', id, rgba: rgba.buffer, width, height, axis }, [rgba.buffer])
  })
}

function getCropRect() {
  const display = initData.displayBounds
  const selection = initData.selectionBounds
  const scaleX = video.videoWidth / display.width
  const scaleY = video.videoHeight / display.height
  return {
    x: Math.max(0, Math.round((selection.x - display.x) * scaleX)),
    y: Math.max(0, Math.round((selection.y - display.y) * scaleY)),
    width: Math.max(1, Math.round(selection.width * scaleX)),
    height: Math.max(1, Math.round(selection.height * scaleY))
  }
}

function drawCurrentFrame() {
  const crop = getCropRect()
  crop.width = Math.min(crop.width, video.videoWidth - crop.x)
  crop.height = Math.min(crop.height, video.videoHeight - crop.y)
  cropCanvas.width = crop.width
  cropCanvas.height = crop.height
  cropContext.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height)
  if (axis === 'vertical') {
    analysisCanvas.width = Math.min(96, crop.width)
    analysisCanvas.height = crop.height
  } else {
    analysisCanvas.width = crop.width
    analysisCanvas.height = Math.min(96, crop.height)
  }
  analysisContext.drawImage(cropCanvas, 0, 0, analysisCanvas.width, analysisCanvas.height)
  return analysisContext.getImageData(0, 0, analysisCanvas.width, analysisCanvas.height)
}

function makeStripCanvas(shift, initialized) {
  const strip = document.createElement('canvas')
  let sourceX = 0
  let sourceY = 0
  if (initialized) {
    strip.width = cropCanvas.width
    strip.height = cropCanvas.height
  } else if (axis === 'vertical') {
    const amount = Math.min(cropCanvas.height - 1, Math.abs(shift))
    strip.width = cropCanvas.width
    strip.height = amount
    sourceY = shift > 0 ? cropCanvas.height - amount : 0
  } else {
    const amount = Math.min(cropCanvas.width - 1, Math.abs(shift))
    strip.width = amount
    strip.height = cropCanvas.height
    sourceX = shift > 0 ? cropCanvas.width - amount : 0
  }
  strip.getContext('2d').drawImage(cropCanvas, sourceX, sourceY, strip.width, strip.height, 0, 0, strip.width, strip.height)
  return strip
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('长截图条带编码失败')), 'image/png'))
}

function appendPreview(strip, position) {
  const old = document.createElement('canvas')
  old.width = preview.width
  old.height = preview.height
  old.getContext('2d').drawImage(preview, 0, 0)
  if (!total.strips) {
    if (axis === 'vertical') {
      preview.width = 160
      preview.height = Math.max(1, Math.round(strip.height * 160 / strip.width))
    } else {
      preview.height = 160
      preview.width = Math.max(1, Math.round(strip.width * 160 / strip.height))
    }
    previewContext.drawImage(strip, 0, 0, preview.width, preview.height)
  } else if (axis === 'vertical') {
    const addition = Math.max(1, Math.round(strip.height * preview.width / strip.width))
    let nextHeight = old.height + addition
    const scale = nextHeight > 1200 ? 1000 / old.height : 1
    const preservedHeight = Math.max(1, Math.round(old.height * scale))
    const preservedWidth = Math.max(1, Math.round(old.width * scale))
    nextHeight = preservedHeight + addition
    preview.width = preservedWidth
    preview.height = nextHeight
    const y = position === 'prepend' ? addition : 0
    previewContext.drawImage(old, 0, y, preservedWidth, preservedHeight)
    previewContext.drawImage(strip, 0, position === 'prepend' ? 0 : preservedHeight, preservedWidth, addition)
  } else {
    const addition = Math.max(1, Math.round(strip.width * preview.height / strip.height))
    let nextWidth = old.width + addition
    const scale = nextWidth > 1200 ? 1000 / old.width : 1
    const preservedWidth = Math.max(1, Math.round(old.width * scale))
    const preservedHeight = Math.max(1, Math.round(old.height * scale))
    nextWidth = preservedWidth + addition
    preview.width = nextWidth
    preview.height = preservedHeight
    const x = position === 'prepend' ? addition : 0
    previewContext.drawImage(old, x, 0, preservedWidth, preservedHeight)
    previewContext.drawImage(strip, position === 'prepend' ? 0 : preservedWidth, 0, addition, preservedHeight)
  }
  emptyPreview.hidden = true
}

async function uploadStrip(strip, position) {
  const blob = await canvasBlob(strip)
  const arrayBuffer = await blob.arrayBuffer()
  const previousStrips = total.strips
  const next = await window.longCaptureAPI.addStrip(arrayBuffer, {
    width: strip.width,
    height: strip.height,
    position,
    axis
  })
  appendPreview(strip, position)
  total = next
  sizeElement.textContent = `${total.width} × ${total.height}`
  stripsElement.textContent = `${total.strips} 段`
  const outputLength = axis === 'vertical' ? total.height : total.width
  trimStartInput.max = String(Math.max(0, outputLength + (total.trimStart || 0) + (total.trimEnd || 0) - 1))
  trimEndInput.max = trimStartInput.max
  updateTrimPreview()
  if (!previousStrips) directionButtons.forEach((button) => { button.disabled = true })
  updateControls()
}

async function captureFrame() {
  if (busy || !capturing || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
  busy = true
  try {
    const imageData = drawCurrentFrame()
    const result = await workerFrame(imageData.data, imageData.width, imageData.height)
    if (result.status === 'initialized') {
      await uploadStrip(makeStripCanvas(0, true), 'append')
      setStatus('已记录起始画面，等待滚动', 1)
    } else if (result.status === 'matched') {
      const strip = makeStripCanvas(result.shift, false)
      await uploadStrip(strip, result.shift > 0 ? 'append' : 'prepend')
      setStatus('匹配成功', result.confidence)
    } else if (result.status === 'still') {
      setStatus('等待画面滚动', 1)
    } else {
      setStatus('未能匹配，请放慢滚动速度', result.confidence)
    }
  } catch (error) {
    setStatus(error.message || String(error))
    setCapturing(false)
  } finally {
    busy = false
    updateControls()
  }
}

function setCapturing(active) {
  capturing = !!active
  clearInterval(timer)
  timer = null
  window.longCaptureAPI.setOverlayActive(capturing)
  if (capturing) {
    setStatus(total.strips ? '继续捕获' : '正在记录起始画面')
    captureFrame()
    timer = setInterval(captureFrame, 180)
  } else if (total.strips) setStatus('已暂停')
  updateControls()
}

async function toggleSelectionEditing() {
  if (busy) return
  if (capturing) setCapturing(false)
  try {
    selectionEditing = !selectionEditing
    await window.longCaptureAPI.setSelectionEditing(selectionEditing, axis, total.strips > 0)
    setStatus(selectionEditing ? (total.strips ? '沿拼接方向拖动选区' : '可移动或缩放截图区域') : '选区调整完成')
  } catch (error) {
    selectionEditing = false
    setStatus(error.message || String(error))
  }
  updateControls()
}

async function applyTrim() {
  if (!total.strips || capturing || busy) return
  busy = true
  updateControls()
  try {
    total = await window.longCaptureAPI.setTrim(trimStartInput.value, trimEndInput.value)
    trimStartInput.value = String(total.trimStart || 0)
    trimEndInput.value = String(total.trimEnd || 0)
    sizeElement.textContent = `${total.width} × ${total.height}`
    updateTrimPreview()
    setStatus('裁剪范围已更新')
  } catch (error) {
    trimStartInput.value = String(total.trimStart || 0)
    trimEndInput.value = String(total.trimEnd || 0)
    setStatus(error.message || String(error))
  } finally {
    busy = false
    updateControls()
  }
}

async function finish(action, fast = false) {
  if (!total.strips || busy) return
  if (selectionEditing) await toggleSelectionEditing()
  setCapturing(false)
  busy = true
  updateControls()
  setStatus(action === 'copy' ? '正在复制长截图' : action === 'pin' ? '正在创建贴图' : '正在生成长截图')
  try {
    const result = await window.longCaptureAPI.finish(action, fast)
    if (result?.canceled) setStatus('已取消保存')
  } catch (error) {
    busy = false
    setStatus(error.message || String(error))
    updateControls()
  }
}

async function initialize(data) {
  initData = data
  axis = data.settings?.screenshot?.longCaptureDirection === 'horizontal' ? 'horizontal' : 'vertical'
  directionButtons.forEach((button) => button.classList.toggle('active', button.dataset.axis === axis))
  document.documentElement.style.setProperty('--primary', data.settings?.mainColor || '#1677ff')
  worker = new Worker('matcher-worker.js')
  worker.onmessage = (event) => {
    const resolve = workerRequests.get(event.data.id)
    if (!resolve) return
    workerRequests.delete(event.data.id)
    resolve(event.data)
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: data.sourceId, minFrameRate: 8, maxFrameRate: 12 } }
    })
    video.srcObject = stream
    await video.play()
    setStatus('准备就绪')
  } catch (error) {
    setStatus(`屏幕采集失败：${error.message}`)
    toggleButton.disabled = true
  }
  updateControls()
}

directionButtons.forEach((button) => button.onclick = () => {
  if (total.strips) return
  axis = button.dataset.axis
  directionButtons.forEach((item) => item.classList.toggle('active', item === button))
  worker?.postMessage({ type: 'reset' })
})
toggleButton.onclick = async () => {
  if (selectionEditing) await toggleSelectionEditing()
  setCapturing(!capturing)
}
adjustSelectionButton.onclick = toggleSelectionEditing
trimStartInput.onchange = applyTrim
trimEndInput.onchange = applyTrim
document.getElementById('copy').onclick = () => finish('copy')
document.getElementById('save').onclick = () => finish('save')
document.getElementById('fastSave').onclick = () => finish('save', true)
document.getElementById('pin').onclick = () => finish('pin')
document.getElementById('close').onclick = () => window.longCaptureAPI.close()
addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.longCaptureAPI.close()
  if (event.code === 'Space') { event.preventDefault(); toggleButton.click() }
  if (event.ctrlKey && event.key.toLowerCase() === 's') { event.preventDefault(); finish('save') }
  if (event.key === 'Enter') finish('copy')
})
addEventListener('beforeunload', () => {
  clearInterval(timer)
  stream?.getTracks().forEach((track) => track.stop())
  worker?.terminate()
})

window.longCaptureAPI.onInit(initialize)
window.longCaptureAPI.onSelectionUpdated((bounds) => {
  if (!initData || !bounds) return
  initData.selectionBounds = bounds
  setStatus('截图区域已更新')
})
window.longCaptureAPI.ready()
