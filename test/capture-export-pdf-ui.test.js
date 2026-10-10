const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')
const script = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const preload = fs.readFileSync(path.join(root, 'preload-capture.js'), 'utf8')
const captureIpc = fs.readFileSync(path.join(root, 'main', 'ipc', 'capture-ipc.js'), 'utf8')

// The normalized wrapper every capture icon has to match (see toolbar-icons.test.js).
const MASK_ASSET = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 16 16" fill="#000">(?:<path [^>]*\/>\s*)+<\/svg>\r?\n$/

function pdfBranchSource () {
  const start = script.indexOf("if(action==='pdf')")
  const end = script.indexOf("if(action==='pin')")
  assert.ok(start > 0 && end > start, 'the pdf action branch sits between the copy/save branches and the pin branch')
  return script.slice(start, end)
}

test('capture toolbar exposes an export-PDF button that reuses the print icon (P0-4-T7②)', () => {
  assert.match(html, /<button id="exportPdf" title="导出 PDF" aria-label="导出 PDF"><span class="toolbar-icon" style="--icon:url\('icons\/print\.svg'\)" aria-hidden="true"><\/span><\/button>/)

  const iconPath = path.join(root, 'capture', 'icons', 'print.svg')
  assert.equal(fs.existsSync(iconPath), true, 'capture/icons/print.svg must exist')
  assert.match(fs.readFileSync(iconPath, 'utf8'), MASK_ASSET, 'print.svg must be a normalized mask asset')

  assert.match(script, /document\.getElementById\('exportPdf'\)\.onclick=\(\)=>performAction\('pdf'\)/)
})

test('export-PDF requests the default A4 mode and leaves the capture window open', () => {
  const branch = pdfBranchSource()
  assert.match(branch, /window\.captureAPI\.exportPdf\(imageBuffer,meta,'a4'\)/, 'the default mode is a4')
  assert.doesNotMatch(branch, /captureAPI\.close\(/, 'the handler does not close the window, so the renderer must not either')
  // One export at a time: the native save dialog would otherwise stack.
  assert.match(branch, /if\(pdfExporting\)return/)
  assert.match(branch, /try\{await window\.captureAPI\.exportPdf/)
  assert.match(branch, /finally\{pdfExporting=false;if\(exportButton\)exportButton\.disabled=false\}/)
})

test('the preload and IPC handler the button depends on stay in shape', () => {
  // P0-4-T5 landed in Wave 1 and needs no main.js wiring; pin the two halves so a
  // rename here cannot silently turn the button into a no-op.
  assert.match(preload, /exportPdf: \(imageBuffer, meta, mode\) => ipcRenderer\.invoke\('capture:export-pdf', \{ imageBuffer, meta, mode \}\)/)
  assert.match(captureIpc, /ipcMain\.handle\('capture:export-pdf', controller\.exportPdf\)/)
})
