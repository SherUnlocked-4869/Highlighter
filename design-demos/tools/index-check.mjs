// Verifies the comparison shell: key switching, iframe switching, no errors.
import { chromium } from 'playwright'
import { pathToFileURL } from 'node:url'
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } })
const errs = []
p.on('pageerror', e => errs.push('pageerror: ' + e.message))
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()) })
await p.goto(pathToFileURL('D:/workspace/Highlighter - 副本/design-demos/index.html').href)
await p.waitForTimeout(1200)
const vis = async () => p.evaluate(() => [...document.querySelectorAll('#stage iframe')].filter(f => f.classList.contains('on')).map(f => f.dataset.id))
console.log('default visible:', await vis())
console.log('info title:', await p.locator('#info h2').first().textContent())
for (const k of ['2','3','1']) {
  await p.keyboard.press(k)
  await p.waitForTimeout(400)
  console.log(`after key ${k}:`, await vis(), '|', await p.locator('#info h2').first().textContent())
}
await p.locator('.tab[data-id="c"]').click()
await p.waitForTimeout(400)
console.log('after click C:', await vis())
// iframes must actually load their document
const loaded = await p.evaluate(() => [...document.querySelectorAll('#stage iframe')].map(f => {
  try { return f.dataset.id + ':' + (f.contentDocument ? f.contentDocument.querySelectorAll('.win').length + ' windows' : 'no doc') }
  catch (e) { return f.dataset.id + ':blocked' }
}))
console.log('iframe contents:', loaded)
console.log('errors:', errs.length ? errs : 'none')
await p.screenshot({ path: 'D:/workspace/Highlighter - 副本/design-demos/shots/index.png' })
await b.close()
