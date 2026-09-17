// Renders every design demo, reports console errors + layout overflow, and
// writes a full-page screenshot next to the source file.
import { chromium } from 'playwright'
import { readdirSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const demosDir = resolve(here, '..')
const shotsDir = join(demosDir, 'shots')
mkdirSync(shotsDir, { recursive: true })

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(demosDir).filter((f) => f.endsWith('.html'))

const browser = await chromium.launch()
const report = []

for (const file of targets) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  page.on('requestfailed', (r) => {
    // Icons resolved through CSS mask url() show up here when missing.
    errors.push('requestfailed: ' + r.url().split('/').slice(-2).join('/'))
  })

  const url = pathToFileURL(join(demosDir, file)).href
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForTimeout(700)

  // Missing mask icons never fire requestfailed in some builds; probe directly.
  const missingIcons = await page.evaluate(async () => {
    const urls = new Set()
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el)
      for (const prop of ['maskImage', 'webkitMaskImage', '-webkit-mask-image']) {
        const v = cs.getPropertyValue(prop)
        if (v && v.includes('url(')) {
          const m = v.match(/url\(["']?(.*?)["']?\)/)
          if (m) urls.add(m[1])
        }
      }
    }
    const bad = []
    for (const u of urls) {
      try {
        const res = await fetch(u)
        if (!res.ok) bad.push(u)
      } catch {
        bad.push(u)
      }
    }
    return bad
  })

  const metrics = await page.evaluate(() => {
    const de = document.documentElement
    return {
      scrollW: de.scrollWidth,
      scrollH: de.scrollHeight,
      viewW: window.innerWidth,
      viewH: window.innerHeight,
      // Any element extending past the right edge means a broken board layout.
      overflowing: [...document.querySelectorAll('*')]
        .filter((el) => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.right > window.innerWidth + 2
        })
        .slice(0, 6)
        .map((el) => `${el.tagName}.${el.className || '(no class)'}`),
    }
  })

  const name = file.replace(/\.html$/, '')
  await page.screenshot({ path: join(shotsDir, `${name}.full.png`), fullPage: true })

  report.push({ file, errors, missingIcons, ...metrics })
  await page.close()
}

await browser.close()

for (const r of report) {
  console.log(`\n=== ${r.file} ===`)
  console.log(`  page: ${r.scrollW}x${r.scrollH} (viewport ${r.viewW}x${r.viewH})`)
  console.log(`  console errors: ${r.errors.length}`)
  r.errors.slice(0, 8).forEach((e) => console.log(`    ! ${e}`))
  console.log(`  missing mask icons: ${r.missingIcons.length}`)
  r.missingIcons.slice(0, 8).forEach((e) => console.log(`    ! ${e}`))
  console.log(`  elements past right edge: ${r.overflowing.length}`)
  r.overflowing.forEach((e) => console.log(`    ! ${e}`))
}
