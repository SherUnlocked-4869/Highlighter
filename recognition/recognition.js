const title = document.getElementById('title')
const summary = document.getElementById('summary')
const badge = document.getElementById('badge')
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
const exportExcel = document.getElementById('exportExcel')
const exportPdf = document.getElementById('exportPdf')
const copyButton = document.getElementById('copy')

// P0-1-T5 (S12): `shared/i18n.js` is a classic script, so its `t`, `setLanguage`
// and `applyTranslations` bindings are already visible here. They must NOT be
// re-declared (the runtime's top-level `const`s share this script's global
// lexical scope, so destructuring them from `window` throws).

let tableResult = null
let qrResult = ''
let activeUrl = ''
let loadingKey = 'recognition.status.loading'
// The summary line doubles as the status line for an export error, so the keys
// that produced the current view are kept to restore it after the message.
let summarySpec = { key: '', params: null }

function setSummary(key, params) {
  summarySpec = { key, params }
  summary.textContent = t(key, params)
}

// A failed export reports on the summary line (same surface the open-link error
// uses); the view's own copy returns after a few seconds instead of staying
// replaced until the next render.
function showTransientError(error) {
  summary.textContent = t('recognition.error.export-failed', { detail: error?.message || String(error) })
  setTimeout(() => {
    if (summarySpec.key) setSummary(summarySpec.key, summarySpec.params)
  }, 4000)
}

function setBadge(text, failed = false) {
  badge.textContent = text
  badge.classList.toggle('is-error', failed)
}

// The views are rendered by the script, so each one records which key produced
// its copy: a language switch re-renders the current view instead of only the
// markup that applyTranslations() reaches. This is the single writer of #title
// for every state, which is why the `<h1 data-i18n>` boot paint cannot survive a
// switch: the marked element is re-applied by applyTranslations() first and then
// re-rendered here from the branch that is actually on screen.
function renderCurrentView() {
  loadingText.textContent = t(loadingKey)
  if (!errorView.classList.contains('hidden')) {
    title.textContent = t('recognition.error.title')
    setBadge(t('recognition.error.title'), true)
    return
  }
  if (tableResult) {
    renderTable(tableResult)
    return
  }
  if (!qrView.classList.contains('hidden')) {
    renderQr(qrResult)
    return
  }
  // Still loading, or nothing recognized yet: the markup's own header copy.
  title.textContent = t('recognition.header.title')
}

function showError(error) {
  loading.classList.add('hidden')
  tableView.classList.add('hidden')
  qrView.classList.add('hidden')
  actions.classList.add('hidden')
  exportExcel.classList.add('hidden')
  exportPdf.classList.add('hidden')
  // The error view owns the copy now; a pending export-error timer must not
  // resurrect a summary from the previous result.
  summarySpec = { key: '', params: null }
  setBadge(t('recognition.error.title'), true)
  errorText.textContent = error?.message || String(error)
  errorView.classList.remove('hidden')
}

// Export buttons live in the shared footer, so each renderer decides which of
// them apply: Excel only exists for a recovered table, PDF exists for both.
function setExportVisibility({ excel }) {
  exportExcel.classList.toggle('hidden', !excel)
  exportPdf.classList.remove('hidden')
}

function renderTable(result) {
  tableResult = result
  title.textContent = t('recognition.table.title')
  setSummary('recognition.table.summary', { rows: result.rowCount, columns: result.columnCount })
  setBadge(t('recognition.badge.local-ocr'))
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
  copyButton.textContent = t('recognition.action.copy-table')
  loading.classList.add('hidden')
  errorView.classList.add('hidden')
  tableView.classList.remove('hidden')
  format.classList.remove('hidden')
  setExportVisibility({ excel: true })
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
  tableResult = null
  activeUrl = parseHttpUrl(qrResult)
  title.textContent = t('recognition.qr.title')
  setSummary(activeUrl ? 'recognition.qr.summary-link' : 'recognition.qr.summary-text')
  setBadge(t('recognition.badge.local-ocr'))
  qrText.value = qrResult
  copyButton.textContent = t('recognition.action.copy-content')
  loading.classList.add('hidden')
  errorView.classList.add('hidden')
  tableView.classList.add('hidden')
  qrView.classList.remove('hidden')
  openLink.classList.toggle('hidden', !activeUrl)
  setExportVisibility({ excel: false })
  actions.classList.remove('hidden')
  format.classList.add('hidden')
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
    image.onerror = () => reject(new Error(t('recognition.error.read-qr-image')))
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
  if (!result?.data) throw new Error(t('recognition.error.qr-not-found'))
  renderQr(result.data)
}

function currentOutput() {
  if (tableResult) return tableResult[format.value] || tableResult.tsv || ''
  return qrResult
}

window.recognitionAPI.onInit(async (data) => {
  // This window follows the app theme like every other surface. It previously
  // stayed dark regardless of the user's setting, because its stylesheet
  // hard-coded a dark palette.
  const resolvedTheme = ['light', 'dark'].includes(data.theme)
    ? data.theme
    : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  document.body.classList.toggle('dark', resolvedTheme === 'dark')
  document.documentElement.style.setProperty('--primary', data.mainColor || '#e5a44c')
  try {
    if (data.type === 'table') {
      // The title is owned by renderTable() (and by renderCurrentView() for the
      // loading state), so reloading the language mid-flight cannot leave two
      // different sentences in that one node.
      loadingKey = 'recognition.table.loading'
      loadingText.textContent = t(loadingKey)
      renderTable(await window.recognitionAPI.recognizeTable(data.dataUrl, data.scaleFactor))
    } else {
      loadingKey = 'recognition.qr.loading'
      loadingText.textContent = t(loadingKey)
      await recognizeQr(data.dataUrl)
    }
  } catch (error) {
    showError(error)
  }
})

document.getElementById('close').onclick = () => window.recognitionAPI.close()
copyButton.onclick = async () => {
  await window.recognitionAPI.copyText(currentOutput())
  // A language switch during the 1 s window must show the new language, so the
  // key is kept and only resolved inside the timer: capturing `t(key)` here would
  // restore the pre-switch sentence.
  const restoreKey = tableResult ? 'recognition.action.copy-table' : 'recognition.action.copy-content'
  copyButton.textContent = t('recognition.action.copied')
  setTimeout(() => { copyButton.textContent = t(restoreKey) }, 1000)
}
openLink.onclick = async () => {
  if (!activeUrl) return
  openLink.disabled = true
  try {
    await window.recognitionAPI.openExternal(activeUrl)
    window.recognitionAPI.close()
  } catch (error) {
    openLink.disabled = false
    summary.textContent = t('recognition.error.open-link', { detail: error?.message || String(error) })
  }
}

// The handlers disable their own button while the save dialog is open: two
// invocations would race two dialogs for the same file, and the main process has
// no reason to de-duplicate them.
exportExcel.onclick = async () => {
  if (!tableResult || exportExcel.disabled) return
  exportExcel.disabled = true
  try {
    await window.recognitionAPI.exportExcel(tableResult.rows, tableResult.merges)
  } catch (error) {
    showTransientError(error)
  } finally {
    exportExcel.disabled = false
  }
}
exportPdf.onclick = async () => {
  if (exportPdf.disabled) return
  exportPdf.disabled = true
  try {
    // The window's content size is the print area: printToPDF has no access to
    // anything the user cannot see, and the print stylesheet removes the chrome.
    await window.recognitionAPI.exportPdf({
      pxW: window.innerWidth || document.documentElement.clientWidth,
      pxH: window.innerHeight || document.documentElement.clientHeight
    })
  } catch (error) {
    showTransientError(error)
  } finally {
    exportPdf.disabled = false
  }
}
addEventListener('keydown', (event) => { if (event.key === 'Escape') window.recognitionAPI.close() })

// P0-1-T2/T5: the initial pass translates the markup; the broadcast subscription
// re-renders the view the script built (title, summary, badge, copy label).
applyTranslations()
window.recognitionAPI.onInterfaceLanguage((language) => {
  setLanguage(language)
  applyTranslations()
  renderCurrentView()
})
window.recognitionAPI.ready()
