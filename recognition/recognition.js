const title = document.getElementById('title')
const summary = document.getElementById('summary')
const loading = document.getElementById('loading')
const loadingText = document.getElementById('loadingText')
const errorView = document.getElementById('error')
const errorText = document.getElementById('errorText')
const tableView = document.getElementById('tableView')
const tableElement = document.getElementById('table')
const qrView = document.getElementById('qrView')
const qrText = document.getElementById('qrText')
const actions = document.getElementById('actions')
const format = document.getElementById('format')
const openLink = document.getElementById('openLink')
const copyButton = document.getElementById('copy')

let tableResult = null
let qrResult = ''
let activeUrl = ''

function showError(error) {
  loading.classList.add('hidden')
  tableView.classList.add('hidden')
  qrView.classList.add('hidden')
  actions.classList.add('hidden')
  errorText.textContent = error?.message || String(error)
  errorView.classList.remove('hidden')
}

function renderTable(result) {
  tableResult = result
  title.textContent = '表格识别'
  summary.textContent = `${result.rowCount} 行 × ${result.columnCount} 列`
  const head = document.createElement('thead')
  const headRow = document.createElement('tr')
  result.rows[0].forEach((value) => {
    const cell = document.createElement('th')
    cell.textContent = value
    headRow.appendChild(cell)
  })
  head.appendChild(headRow)
  const body = document.createElement('tbody')
  result.rows.slice(1).forEach((row) => {
    const element = document.createElement('tr')
    row.forEach((value) => {
      const cell = document.createElement('td')
      cell.textContent = value
      element.appendChild(cell)
    })
    body.appendChild(element)
  })
  tableElement.replaceChildren(head, body)
  copyButton.textContent = '复制表格'
  loading.classList.add('hidden')
  tableView.classList.remove('hidden')
  format.classList.remove('hidden')
  actions.classList.remove('hidden')
}

function parseHttpUrl(value) {
  try {
    const url = new URL(String(value).trim())
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : ''
  } catch {
    return ''
  }
}

function renderQr(value) {
  qrResult = String(value)
  activeUrl = parseHttpUrl(qrResult)
  title.textContent = '二维码识别'
  summary.textContent = activeUrl ? '已识别链接' : '已识别文本内容'
  qrText.value = qrResult
  copyButton.textContent = '复制内容'
  loading.classList.add('hidden')
  qrView.classList.remove('hidden')
  openLink.classList.toggle('hidden', !activeUrl)
  actions.classList.remove('hidden')
}

function resizedCanvas(source, scale) {
  const output = document.createElement('canvas')
  output.width = Math.max(1, Math.round(source.width * scale))
  output.height = Math.max(1, Math.round(source.height * scale))
  const context = output.getContext('2d')
  context.imageSmoothingEnabled = false
  context.drawImage(source, 0, 0, output.width, output.height)
  return output
}

function decodeImageData(imageData, enhanced = false) {
  if (!window.jsQR) return null
  let pixels = imageData.data
  if (enhanced) {
    pixels = new Uint8ClampedArray(pixels)
    for (let index = 0; index < pixels.length; index += 4) {
      const gray = 0.299 * pixels[index] + 0.587 * pixels[index + 1] + 0.114 * pixels[index + 2]
      const value = Math.max(0, Math.min(255, (gray - 128) * 1.65 + 128))
      pixels[index] = value
      pixels[index + 1] = value
      pixels[index + 2] = value
    }
  }
  return window.jsQR(pixels, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' })
}

function decodeCanvas(source) {
  if (!window.jsQR) return null
  const maxDimension = Math.max(source.width, source.height)
  const minDimension = Math.min(source.width, source.height)
  const base = maxDimension > 2400 ? resizedCanvas(source, 2400 / maxDimension) : source
  const candidates = [base]
  if (minDimension < 900) {
    const scale = Math.min(3, 900 / Math.max(1, minDimension), 2400 / Math.max(1, maxDimension))
    if (scale > 1.15) candidates.push(resizedCanvas(source, scale))
  }
  for (const candidate of candidates) {
    const imageData = candidate.getContext('2d').getImageData(0, 0, candidate.width, candidate.height)
    const direct = decodeImageData(imageData)
    if (direct) return direct
    const enhanced = decodeImageData(imageData, true)
    if (enhanced) return enhanced
  }
  return null
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('无法读取二维码图片'))
    image.src = dataUrl
  })
}

async function recognizeQr(dataUrl) {
  await new Promise((resolve) => requestAnimationFrame(resolve))
  const image = await loadImage(dataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  canvas.getContext('2d').drawImage(image, 0, 0)
  const result = decodeCanvas(canvas)
  if (!result?.data) throw new Error('未识别到二维码，请保持二维码完整并适当扩大选区')
  renderQr(result.data)
}

function currentOutput() {
  if (tableResult) return tableResult[format.value] || tableResult.tsv || ''
  return qrResult
}

window.recognitionAPI.onInit(async (data) => {
  document.documentElement.style.setProperty('--primary', data.mainColor || '#1677ff')
  try {
    if (data.type === 'table') {
      title.textContent = '表格识别'
      loadingText.textContent = '正在恢复表格结构…'
      renderTable(await window.recognitionAPI.recognizeTable(data.dataUrl, data.scaleFactor))
    } else {
      title.textContent = '二维码识别'
      loadingText.textContent = '正在扫描二维码…'
      await recognizeQr(data.dataUrl)
    }
  } catch (error) {
    showError(error)
  }
})

document.getElementById('close').onclick = () => window.recognitionAPI.close()
copyButton.onclick = async () => {
  await window.recognitionAPI.copyText(currentOutput())
  const original = tableResult ? '复制表格' : '复制内容'
  copyButton.textContent = '已复制'
  setTimeout(() => { copyButton.textContent = original }, 1000)
}
openLink.onclick = () => { if (activeUrl) window.recognitionAPI.openExternal(activeUrl) }
addEventListener('keydown', (event) => { if (event.key === 'Escape') window.recognitionAPI.close() })
window.recognitionAPI.ready()
