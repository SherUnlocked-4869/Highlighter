const assert = require('node:assert/strict')
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

const profile = process.env.HIGHLIGHTER_SEARCH_PROBE_PROFILE
app.setPath('userData', profile)
app.setPath('sessionData', profile)

const results = Array.from({ length: 35 }, (_, index) => ({
  name: `report-${index}.txt`, path: 'C:\\fixture',
  fullPath: `C:\\fixture\\report-${index}.txt`, extension: 'txt'
}))

async function runProbe() {
  const opened = []
  const copied = []
  let releaseOldQuery
  const oldQuery = new Promise((resolve) => { releaseOldQuery = resolve })
  ipcMain.handle('search:ensure-ready', () => ({ phase: 'ready' }))
  ipcMain.handle('search:file-icon', () => null)
  ipcMain.handle('search:open-path', (_event, { path: file }) => { opened.push(file) })
  ipcMain.handle('search:copy-path', (_event, { path: file }) => { copied.push(file) })
  ipcMain.handle('search:query', async (_event, { search }) => {
    if (search.startsWith('slow')) await oldQuery
    if (search.startsWith('fail')) throw new Error('Fixture query failed')
    return { items: results, total: results.length }
  })

  const win = new BrowserWindow({
    width: 750, height: 650, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload-search.js'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false
    }
  })
  await win.loadFile(path.join(__dirname, '..', 'search', 'search.html'))
  win.webContents.send('search:init', { search: { pageSize: 30, matchPath: false }, restore: { keyword: 'report' } })
  const evaluate = (fn) => win.webContents.executeJavaScript(`(${fn.toString()})()`)

  const first = await evaluate(async () => {
    const list = document.getElementById('resultList')
    const input = document.getElementById('searchInput')
    const key = (target, name, extra = {}) => target.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extra }))
    const count = () => list.querySelectorAll('.result-row').length
    for (let attempt = 0; !count() && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const firstPage = count()
    list.scrollTop = list.scrollHeight
    list.dispatchEvent(new Event('scroll'))
    const indices = [...list.children].map((row) => Number(row.dataset.index))

    input.focus()
    const composingEnter = key(input, 'Enter', { isComposing: true })
    const legacyImeEnter = key(input, 'Enter', { keyCode: 229 })
    const normalTab = key(input, 'Tab')
    const tab = document.querySelector('.category-tab[aria-pressed="true"]')
    tab.focus()
    key(tab, 'ArrowRight')
    const categoryChanged = document.activeElement !== tab && document.activeElement.getAttribute('aria-pressed') === 'true'
    for (let attempt = 0; !count() && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const initialRow = list.querySelector('.result-row[tabindex="0"]')
    initialRow.focus()
    key(initialRow, 'ArrowDown')
    const focused = document.activeElement
    const copy = focused.querySelector('[data-act="copy"]')
    const copyReachable = copy.tabIndex === 0 && getComputedStyle(copy.parentElement).display !== 'none'
    copy.click()
    input.value = 'slow'
    runSearch()
    return { firstPage, indices, composingEnter, legacyImeEnter, normalTab, categoryChanged,
      focusedIndex: Number(focused.dataset.index), copyReachable, rowsWhileLoading: count(),
      announcementWhileLoading: document.getElementById('resultStatus').textContent }
  })
  assert.equal(first.firstPage, 30)
  assert.deepEqual(first.indices, Array.from({ length: 35 }, (_, index) => index))
  assert.equal(first.composingEnter, true)
  assert.equal(first.legacyImeEnter, true)
  assert.equal(first.normalTab, true)
  assert.equal(first.categoryChanged, true)
  assert.equal(first.focusedIndex, 1)
  assert.equal(first.copyReachable, true)
  assert.equal(first.rowsWhileLoading, 0)
  assert.equal(first.announcementWhileLoading, '')
  assert.deepEqual(opened, [])
  assert.deepEqual(copied, [results[1].fullPath])

  await evaluate(async () => {
    document.getElementById('searchInput').value = 'fail'
    runSearch()
    while (state.searching) await new Promise((resolve) => setTimeout(resolve, 20))
  })
  releaseOldQuery()
  const failure = await evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    return {
      rows: document.getElementById('resultList').children.length,
      count: document.getElementById('countText').textContent,
      message: document.getElementById('emptyState').textContent,
      announcement: document.getElementById('resultStatus').textContent
    }
  })
  assert.deepEqual(failure, { rows: 0, count: '', message: 'Fixture query failed', announcement: 'Fixture query failed' })
  win.destroy()
}

app.whenReady().then(runProbe).then(() => app.exit(0)).catch((error) => {
  console.error(error)
  app.exit(1)
})
