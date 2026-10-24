// Produces the screenshots the review board and README point at:
//   index-tab{0,1,2}.png   the review board, one per direction
//   dir-N-win-{light,dark}.png   the main window only (no review board)
//
// Element screenshots, not viewport clips: the three boards start at different
// Y offsets, so a fixed clip box cut dir-3's window to 681px tall and read as a
// layout bug. locator.screenshot() captures exactly the element's box.
import { chromium } from 'playwright'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const url = (f) => pathToFileURL(join(root, f)).href
const out = (f) => join(root, 'shots', f)
const errors = []

const b = await chromium.launch()

const board = await b.newPage({ viewport: { width: 1600, height: 1000 } })
board.on('pageerror', (e) => errors.push('board: ' + e.message))
for (const i of [0, 1, 2]) {
  await board.goto(url('index.html'))
  await board.waitForTimeout(900)
  if (i) await board.locator('.tabs button').nth(i).click()
  await board.waitForTimeout(1600)
  await board.screenshot({ path: out(`index-tab${i}.png`) })
  console.log(`index-tab${i}.png`)
}
await board.close()

const win = await b.newPage({ viewport: { width: 1700, height: 1400 }, deviceScaleFactor: 1 })
win.on('pageerror', (e) => errors.push('win: ' + e.message))
for (const d of ['dir-1', 'dir-2', 'dir-3']) {
  await win.goto(url(`${d}.html`))
  await win.waitForTimeout(700)
  for (const theme of ['light', 'dark']) {
    const cur = await win.evaluate(() => document.documentElement.dataset.theme || 'light')
    if (cur !== theme) {
      await win.locator('#themeToggle').click()
      await win.waitForTimeout(500)
    }
    const el = win.locator('#appWin')
    await el.scrollIntoViewIfNeeded()
    const box = await el.boundingBox()
    if (Math.round(box.width) !== 1120 || Math.round(box.height) !== 760) {
      errors.push(`${d}/${theme}: main window is ${box.width}x${box.height}, expected 1120x760`)
    }
    await el.screenshot({ path: out(`${d}-win-${theme}.png`) })
    console.log(`${d}-win-${theme}.png`)
  }
}
await win.close()
await b.close()

if (errors.length) { console.log('ERRORS:', errors); process.exit(1) }
console.log('all screenshots written')
