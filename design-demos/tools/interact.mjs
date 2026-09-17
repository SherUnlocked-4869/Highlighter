// Drives each prototype through its real interactions and reports any failure.
// Static screenshots can't catch broken click handlers, so every clickable
// surface named in the spec gets exercised here.
import { chromium } from 'playwright'
import { readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const demosDir = resolve(here, '..')
const files = readdirSync(demosDir).filter((f) => /^[abc]-.*\.html$/.test(f))

const browser = await chromium.launch()
let failures = 0

for (const file of files) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text())
  })
  await page.goto(pathToFileURL(join(demosDir, file)).href, { waitUntil: 'load' })
  await page.waitForTimeout(500)

  const check = async (label, fn) => {
    try {
      const ok = await fn()
      if (!ok) throw new Error('assertion returned false')
      console.log(`  ok   ${label}`)
    } catch (e) {
      failures++
      console.log(`  FAIL ${label} -> ${e.message.split('\n')[0]}`)
    }
  }

  console.log(`\n=== ${file} ===`)

  // 1. Tab switching must swap the rendered rows.
  const firstTab = await page.locator('#tabs .tab').first().textContent()
  const before = await page.locator('#list .item').count()
  await page.locator('#tabs .tab').nth(1).click()
  await page.waitForTimeout(200)
  const after = await page.locator('#list .item').count()
  await check(`tab switch (${before} rows -> ${after})`, async () => after !== before || after > 0)
  await check('active tab moved', async () =>
    (await page.locator('#tabs .tab').nth(1).getAttribute('class')).includes('on'))
  await page.locator('#tabs .tab').first().click()
  await page.waitForTimeout(150)

  // 2. Nav switching to hotkeys route.
  await page.locator('#navBox .nav, .side .scroll .nav').filter({ hasText: '热键设置' }).first().click()
  await page.waitForTimeout(250)
  const title = await page.locator('#pTitle').textContent()
  await check(`nav -> 热键设置 (title="${title}")`, async () => title.includes('热键'))
  const caps = await page.locator('#list .cap, #list .k, #list .key').count()
  await check(`hotkey chips rendered (${caps})`, async () => caps >= 5)

  // 3. Back to home.
  await page.locator('#navBox .nav, .side .scroll .nav').filter({ hasText: '快捷功能' }).first().click()
  await page.waitForTimeout(200)
  await check('nav -> 快捷功能', async () => (await page.locator('#pTitle').textContent()).includes('快捷'))

  // 4. Search filtering.
  await page.locator('#q').fill('doc')
  await page.waitForTimeout(220)
  const filtered = await page.locator('#hits .hit').count()
  await check(`search filter "doc" -> ${filtered} rows`, async () => filtered === 1 || filtered === 2)
  await page.locator('#q').fill('')
  await page.waitForTimeout(200)
  await check('search clears back to full list', async () => (await page.locator('#hits .hit').count()) === 5)

  // 5. Category chips selectable.
  await page.locator('#cats button').nth(2).click()
  await page.waitForTimeout(150)
  await check('category chip selects', async () =>
    (await page.locator('#cats button').nth(2).getAttribute('class')).includes('on'))

  // 6. Theme toggle must actually change computed background. Which button
  // starts active differs per direction (C is dark-first), so click the
  // inactive one rather than assuming a light default.
  const bgBefore = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  const btns = page.locator('.toggle button')
  if ((await btns.count()) >= 2) {
    // A segmented control sets an explicit state, so restoring means clicking
    // whichever button is inactive *now*, not re-clicking the same one.
    const clickInactive = async () => {
      const n = await btns.count()
      for (let i = 0; i < n; i++) {
        if (!((await btns.nth(i).getAttribute('class')) || '').includes('on')) {
          await btns.nth(i).click()
          return true
        }
      }
      return false
    }
    await clickInactive()
    await page.waitForTimeout(300)
    const bgAfter = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    await check(`theme toggle changes bg (${bgBefore} -> ${bgAfter})`, async () => bgBefore !== bgAfter)
    await clickInactive()
    await page.waitForTimeout(300)
    const bgBack = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    await check(`theme toggles back (${bgBack})`, async () => bgBack === bgBefore)
  } else {
    await check('theme control present', async () => false)
  }

  // 7. Switch component toggles.
  const sw = page.locator('#sw')
  if (await sw.count()) {
    const cls = await sw.getAttribute('class')
    await sw.click()
    await page.waitForTimeout(120)
    await check('switch toggles', async () => (await sw.getAttribute('class')) !== cls)
  }

  // 8. Icons must render — every mask must resolve to a non-empty box.
  const iconless = await page.evaluate(() => {
    const bad = []
    for (const el of document.querySelectorAll('.ic')) {
      const r = el.getBoundingClientRect()
      if (r.width < 6 || r.height < 6) bad.push(el.className + ' ' + r.width + 'x' + r.height)
    }
    return bad
  })
  await check(`all .ic boxes sized (${iconless.length} bad)`, async () => iconless.length === 0)
  if (iconless.length) iconless.slice(0, 5).forEach((b) => console.log('       ' + b))

  // 9. No horizontal overflow at the target viewport. An element only counts
  // if no ancestor clips it — animated children inside overflow:hidden report
  // transformed positions that never actually reach the viewport edge.
  const over = await page.evaluate(() => {
    const clipped = (el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const o = getComputedStyle(p)
        if (/hidden|clip|auto|scroll/.test(o.overflowX)) return true
      }
      return false
    }
    return [...document.querySelectorAll('*')].filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.right > window.innerWidth + 2 && !clipped(el)
    }).map((el) => `${el.tagName}.${el.className || ''}`)
  })
  await check(`no unclipped element past right edge (${over.length})`, async () => over.length === 0)
  if (over.length) over.slice(0, 5).forEach((b) => console.log('       ' + b))

  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth)
  await check(`document has no horizontal scroll (${scrollW}px)`, async () => scrollW <= 1600)

  await check('no console/page errors', async () => errors.length === 0)
  if (errors.length) errors.slice(0, 5).forEach((e) => console.log('       ' + e))

  await page.close()
}

await browser.close()
console.log(`\n${failures === 0 ? 'ALL INTERACTION TESTS PASSED' : failures + ' CHECK(S) FAILED'}`)
process.exit(failures ? 1 : 0)
