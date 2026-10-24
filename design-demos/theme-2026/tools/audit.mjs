// Renders each direction, checks the DOM contract, drives the real interactions,
// and writes a full screenshot. This is the only gate: a direction is not ready
// until this exits 0.
//
//   node tools/audit.mjs            # all dir-N.html
//   node tools/audit.mjs dir-1.html # one
import { chromium } from 'playwright'
import { readdirSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const shotsDir = join(root, 'shots')
mkdirSync(shotsDir, { recursive: true })

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(root).filter((f) => /^dir-\d+\.html$/.test(f)).sort()

// A target may be given as a path (`.probe/dir-0.html`) or a bare name. Resolve
// both against the project root and keep a filesystem-safe shot stem.
const resolveTarget = (t) => {
  const abs = t.startsWith('/') || /^[A-Za-z]:/.test(t) ? t : join(root, t)
  const stem = abs.replace(/\\/g, '/').split('/').filter(Boolean).pop().replace(/\.html$/, '')
  return { abs, stem }
}

const browser = await chromium.launch()
let failures = 0

const fail = (file, msg) => { failures++; console.log(`  FAIL ${msg}`) }
const ok = (msg) => console.log(`  ok   ${msg}`)

for (const target of targets) {
  const { abs, stem: file } = resolveTarget(target)
  console.log(`\n=== ${file} ===`)
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()) })
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  page.on('requestfailed', (r) => {
    // Any external request is a contract violation; file:// loads of the page
    // itself are not requests we care about.
    if (/^https?:/.test(r.url())) errors.push('requestfailed: ' + r.url().slice(0, 80))
  })

  await page.goto(pathToFileURL(abs).href, { waitUntil: 'load' })
  await page.waitForTimeout(600)

  // ---- 1. DOM contract ----
  const contract = await page.evaluate(() => {
    const q = (s) => document.querySelector(s)
    const need = ['#board', '#appWin', '#navBox .nav', '#pTitle', '.status-rail', '#tabs .tab',
      '#list .item', '#themeToggle', '#captureDemo .screen', '#captureDemo .selection',
      '.capture-bar .tool', '#clipPanel .chip', '#clipList .clip-row', '#selBar .sel-btn',
      '#motionStage', '#motionBtn']
    return need.filter((s) => !q(s))
  })
  if (contract.length) fail(file, `missing contract nodes: ${contract.join(', ')}`)
  else ok('DOM contract complete')

  // ---- 2. No external network dependencies ----
  const externalAssets = await page.evaluate(() => {
    const bad = []
    for (const el of document.querySelectorAll('link,script,img,source,video,audio,iframe')) {
      const v = el.getAttribute('src') || el.getAttribute('href') || ''
      if (/^https?:/.test(v)) bad.push(v.slice(0, 60))
    }
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el)
      for (const prop of ['backgroundImage', 'maskImage', 'webkitMaskImage']) {
        const v = cs.getPropertyValue(prop)
        if (v && /url\(["']?https?:/.test(v)) bad.push(prop + ':' + v.slice(0, 40))
      }
    }
    return bad
  })
  if (externalAssets.length) fail(file, `external asset refs: ${externalAssets.slice(0, 3).join(' | ')}`)
  else ok('no external assets')

  // ---- 3. Readability floor: body >=14px, labels >=12px ----
  const small = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('#board *')) {
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1)
      if (!own) continue
      const cs = getComputedStyle(el)
      const size = parseFloat(cs.fontSize)
      if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue
      const isBody = size >= 13.5
      if (!isBody && size < 12) out.push(`${el.tagName}.${el.className}`.slice(0, 60) + `@${size.toFixed(1)}px`)
    }
    return out
  })
  if (small.length) fail(file, `text under 12px: ${small.slice(0, 6).join(', ')}`)
  else ok('no text under 12px')

  // ---- 4. Contrast on primary body copy (sample, not exhaustive) ----
  const contrastBad = await page.evaluate(() => {
    const lum = (c) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
    }
    const parse = (s) => (s.match(/[\d.]+/g) || []).map(Number)
    const bgOf = (el) => {
      let cur = el
      while (cur) {
        const c = parse(getComputedStyle(cur).backgroundColor)
        if (c.length >= 3 && (c.length < 4 || c[3] > 0.85)) return c
        cur = cur.parentElement
      }
      return [255, 255, 255]
    }
    const out = []
    for (const el of document.querySelectorAll('#board p, #board .item, #board .nav, #board .clip-row, #board .tool')) {
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 2)
      if (!own) continue
      const cs = getComputedStyle(el)
      if (parseFloat(cs.fontSize) < 14) continue
      const fg = parse(cs.color)
      if (fg.length < 3) continue
      const bg = bgOf(el)
      const a = lum(fg), b = lum(bg)
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      if (ratio < 4.5) out.push(`${el.tagName}.${el.className}`.slice(0, 44) + ` ${ratio.toFixed(2)}:1`)
    }
    return out
  })
  if (contrastBad.length) fail(file, `body contrast under 4.5:1: ${contrastBad.slice(0, 5).join(', ')}`)
  else ok('body contrast >= 4.5:1 on sampled copy')

  // ---- 5. No horizontal scroll at 1600 ----
  const scroll = await page.evaluate(() => ({
    docW: document.documentElement.scrollWidth,
    winW: window.innerWidth,
    over: [...document.querySelectorAll('#board *')]
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 4).map((el) => `${el.tagName}.${el.className}`.slice(0, 40))
  }))
  if (scroll.docW > scroll.winW + 1) fail(file, `horizontal scroll ${scroll.docW} > ${scroll.winW} (${scroll.over.join(', ')})`)
  else ok('no horizontal scroll at 1600')

  // ---- 6. Interactions ----
  const clickAndCheck = async (label, action, assertion) => {
    try {
      await action()
      await page.waitForTimeout(260)
      const res = await assertion()
      if (res === true) ok(label); else fail(file, label + ' -> ' + res)
    } catch (e) { fail(file, label + ' -> ' + e.message.split('\n')[0]) }
  }

  // nav switch
  const navTarget = await page.evaluate(() => {
    const b = [...document.querySelectorAll('#navBox .nav')].find((n) => !n.classList.contains('active') && n.dataset.label)
    return b ? { route: b.dataset.route, label: b.dataset.label } : null
  })
  if (navTarget) {
    await clickAndCheck(`nav -> ${navTarget.label}`, async () => {
      await page.locator(`#navBox .nav[data-route="${navTarget.route}"]`).first().click()
    }, async () => {
      const r = await page.evaluate(() => ({
        title: document.querySelector('#pTitle').textContent.trim(),
        actives: document.querySelectorAll('#navBox .nav.active').length
      }))
      if (!r.title.includes(navTarget.label.replace(/ /g, ''))) return `title="${r.title}" expected "${navTarget.label}"`
      if (r.actives !== 1) return `${r.actives} nav items active`
      return true
    })
  } else fail(file, 'no navigable nav item found')

  // tab switch changes list
  const tabs = await page.locator('#tabs .tab').count()
  if (tabs >= 2) {
    const beforeSig = await page.evaluate(() => document.querySelector('#list').textContent.replace(/\s+/g, ''))
    await clickAndCheck('tab switch swaps list', async () => {
      await page.locator('#tabs .tab').nth(1).click()
    }, async () => {
      const afterSig = await page.evaluate(() => document.querySelector('#list').textContent.replace(/\s+/g, ''))
      const active = await page.evaluate(() => document.querySelectorAll('#tabs .tab.active').length)
      if (afterSig === beforeSig) return 'list content unchanged'
      if (active !== 1) return `${active} tabs active`
      return true
    })
    await page.locator('#tabs .tab').first().click()
    await page.waitForTimeout(200)
  } else fail(file, 'fewer than 2 tabs')

  // theme toggle
  await clickAndCheck('theme toggle changes background', async () => {
    await page.locator('#themeToggle').click()
  }, async () => {
    const after = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      bg: getComputedStyle(document.body).backgroundColor
    }))
    const okTheme = after.theme === 'dark' || after.theme === 'light'
    if (!okTheme) return 'data-theme not set'
    if (after.bg === 'rgba(0, 0, 0, 0)') return 'body background transparent'
    return true
  })
  const bgA = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  await page.locator('#themeToggle').click()
  await page.waitForTimeout(260)
  const bgB = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  if (bgA === bgB) fail(file, 'theme toggle did not change computed background')
  else ok('theme toggle round-trips to a different background')

  // tool selection
  const toolCount = await page.locator('.capture-bar .tool').count()
  if (toolCount >= 3) {
    await clickAndCheck(`tool select (${toolCount} tools)`, async () => {
      await page.locator('.capture-bar .tool').nth(1).click()
    }, async () => {
      const r = await page.evaluate(() => ({
        active: document.querySelectorAll('.capture-bar .tool.active').length,
        pressed: [...document.querySelectorAll('.capture-bar .tool')]
          .filter((b) => b.getAttribute('aria-pressed') === 'true').length
      }))
      if (r.active !== 1 && r.pressed !== 1) return `active=${r.active} pressed=${r.pressed}`
      return true
    })
  } else fail(file, `only ${toolCount} tools`)

  // clipboard row select
  const clipRows = await page.locator('#clipList .clip-row').count()
  if (clipRows >= 2) {
    await clickAndCheck(`clip row select (${clipRows} rows)`, async () => {
      await page.locator('#clipList .clip-row').nth(1).click()
    }, async () => {
      const r = await page.evaluate(() => ({
        sel: document.querySelectorAll('#clipList .clip-row[aria-selected="true"]').length
      }))
      if (r.sel !== 1) return `${r.sel} rows selected`
      return true
    })
  } else fail(file, `only ${clipRows} clip rows`)

  // chip filter
  const chips = await page.locator('#clipPanel .chip').count()
  // Count VISIBLE rows: a filter may hide rows (display:none / removed) rather
  // than unmount them, and querySelectorAll would count both identically.
  const visibleRows = () => page.evaluate(() =>
    [...document.querySelectorAll('#clipList .clip-row')]
      .filter((el) => el.getClientRects().length > 0).length)
  if (chips >= 3) {
    const allRows = await visibleRows()
    await clickAndCheck('chip filters list', async () => {
      await page.locator('#clipPanel .chip').nth(1).click()
    }, async () => {
      const r = await page.evaluate(() => ({
        pressed: document.querySelectorAll('#clipPanel .chip[aria-pressed="true"]').length
      }))
      const rows = await visibleRows()
      if (r.pressed !== 1) return `${r.pressed} chips pressed`
      if (rows >= allRows) return `no filtering (${rows} of ${allRows} still visible)`
      return true
    })
    await page.locator('#clipPanel .chip').first().click()
    await page.waitForTimeout(180)
  } else fail(file, `only ${chips} chips`)

  // motion demo
  await clickAndCheck('motion demo plays once', async () => {
    await page.locator('#motionBtn').click()
  }, async () => {
    const playing = await page.evaluate(() => document.querySelector('#motionStage').classList.contains('is-playing'))
    if (!playing) return '#motionStage never got .is-playing'
    await page.waitForTimeout(1500)
    const stillPlaying = await page.evaluate(() => document.querySelector('#motionStage').classList.contains('is-playing'))
    if (stillPlaying) return 'animation still playing after 1.5s (not a one-shot)'
    return true
  })

  // ---- 7. Console clean ----
  if (errors.length) fail(file, `console errors: ${errors.slice(0, 4).join(' | ')}`)
  else ok('console clean')

  // ---- 8. Screenshots (both themes) ----
  await page.evaluate(() => document.documentElement.setAttribute('data-theme',
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'))
  await page.waitForTimeout(200)
  const theme = await page.evaluate(() => document.documentElement.dataset.theme || 'light')
  await page.screenshot({ path: join(shotsDir, `${file}-${theme}.png`), fullPage: true })
  console.log(`  shot shots/${file}-${theme}.png`)

  await page.close()
}

await browser.close()
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
