// Renders the six-thumbnail sheet at the two widths the review board is opened at.
import { chromium } from 'playwright'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const b = await chromium.launch()
for (const [w, h, name] of [[1660, 1000, 'thumbs.png'], [1180, 900, 'thumbs-1180.png']]) {
  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message))
  await p.goto(pathToFileURL(join(root, 'thumbs.html')).href)
  await p.waitForTimeout(400)
  await p.screenshot({ path: join(root, 'shots', name), fullPage: true })
  console.log(name, 'errors:', errs.length ? errs : 'none')
  await p.close()
}
await b.close()
