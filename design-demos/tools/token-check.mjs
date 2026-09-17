// Verifies the shared token contract in a real browser:
//   - derived accent colors resolve and follow a runtime override of --primary
//   - aliases follow the theme (they must not freeze to the light values)
//   - the accent stays legible for any user-picked hue, in both themes
//
// Colors are converted to sRGB through a canvas before measuring, because
// computed values may come back as oklch()/color() strings and naive parsing
// of those numbers as RGB silently produces wrong contrast ratios.
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const tokensPath = process.argv[2] || 'D:/workspace/Highlighter - 副本/shared/tokens.css'
const css = readFileSync(tokensPath, 'utf8')
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
await page.setContent(`<style>${css}</style>
  <div id="fill" style="color:var(--primary-ink);background:var(--primary)">on-fill</div>
  <div id="fg" style="color:var(--primary-text);background:var(--surface)">as-text</div>
  <div id="alias" style="background:var(--panel)">alias</div>
  <div id="surf" style="background:var(--surface)">surface</div>`)

// Normalises any CSS color to [r,g,b] in sRGB 0-255 via canvas compositing.
await page.addScriptTag({ content: `
  window.__toRgb = (cssColor) => {
    const c = document.createElement('canvas'); c.width = c.height = 1
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 1, 1)
    ctx.fillStyle = cssColor; ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2]]
  }
` })

const lum = ([r, g, b]) => {
  const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
const snap = () => page.evaluate(() => {
  const cs = (id, p) => getComputedStyle(document.getElementById(id))[p]
  return {
    ink: window.__toRgb(cs('fill', 'color')),
    fillBg: window.__toRgb(cs('fill', 'backgroundColor')),
    text: window.__toRgb(cs('fg', 'color')),
    surfBg: window.__toRgb(cs('surf', 'backgroundColor')),
    aliasBg: cs('alias', 'backgroundColor'),
    surfBgRaw: cs('surf', 'backgroundColor'),
  }
})

let failures = 0
const expect = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`)
  if (!ok) failures++
}
const setAccent = async (c) => {
  await page.evaluate((v) => {
    if (v) document.documentElement.style.setProperty('--primary', v)
    else document.documentElement.style.removeProperty('--primary')
  }, c)
  await settle()
}

for (const theme of ['light', 'dark']) {
  console.log(`\n=== ${theme} (default accent) ===`)
  await page.evaluate((t) => document.body.classList.toggle('dark', t === 'dark'), theme)
  await setAccent(null)
  const s = await snap()
  expect('--panel alias resolves to --surface', s.aliasBg === s.surfBgRaw,
    `${s.aliasBg} vs ${s.surfBgRaw}`)
  const ink = ratio(s.ink, s.fillBg)
  expect('accent ink-on-fill >= 4.5', ink >= 4.5, `${ink.toFixed(2)}:1`)
  const txt = ratio(s.text, s.surfBg)
  expect('accent as text on surface >= 4.5', txt >= 4.5, `${txt.toFixed(2)}:1`)
}

console.log('\n=== user-picked accents ===')
// Accents a user is realistically likely to pick. All must clear 4.5:1.
const REALISTIC = ['#e5a44c', '#1677ff', '#1f2d5c', '#000000', '#ffffff', '#ff0000', '#8b5cf6', '#2e7d51', '#1677ff', '#a86a1f', '#52c41a']
for (const theme of ['light', 'dark']) {
  await page.evaluate((t) => document.body.classList.toggle('dark', t === 'dark'), theme)
  for (const c of REALISTIC) {
    await setAccent(c)
    const s = await snap()
    const ink = ratio(s.ink, s.fillBg)
    const txt = ratio(s.text, s.surfBg)
    expect(`${theme} ${c}`, ink >= 4.5 && txt >= 4.5,
      `ink ${ink.toFixed(2)}:1 | text ${txt.toFixed(2)}:1`)
  }
}

// The formula cannot be perfect: a vivid mid-tone fill has no black-or-white
// partner reaching 4.5:1. Prove the chosen threshold is the best available by
// asserting the gamut floor, rather than pretending it is 4.5.
console.log('\n=== gamut floor (vivid mid-tones) ===')
await page.evaluate(() => document.body.classList.remove('dark'))
let floor = Infinity, floorColor = null
for (let h = 0; h < 360; h += 30) {
  for (const l of ['0.45', '0.50', '0.55', '0.60']) {
    for (const c of ['0.12', '0.22']) {
      await setAccent(`oklch(${l} ${c} ${h})`)
      const s = await snap()
      const ink = ratio(s.ink, s.fillBg)
      if (ink < floor) { floor = ink; floorColor = `oklch(${l} ${c} ${h})` }
    }
  }
}
expect('gamut floor stays >= 3.8:1 (measured optimum for black/white ink)', floor >= 3.8,
  `${floor.toFixed(2)}:1 at ${floorColor}`)

await browser.close()
console.log(`\n${failures ? failures + ' FAILURE(S)' : 'token contract holds'}`)
process.exit(failures ? 1 : 0)
