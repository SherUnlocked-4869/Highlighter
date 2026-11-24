const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { MAX_EDGE, MAX_PIXELS, capabilities } = require('../shared/long-capture-limits')
const { copyExclusive } = require('../main/services/long-capture-output')

const ROOT = path.resolve(__dirname, '..')
const domain = fs.readFileSync(path.join(ROOT, 'main', 'domains', 'long-capture', 'index.js'), 'utf8').replace(/\r\n/g, '\n')
const controller = fs.readFileSync(path.join(ROOT, 'long-capture', 'long-capture.js'), 'utf8').replace(/\r\n/g, '\n')
const controllerHtml = fs.readFileSync(path.join(ROOT, 'long-capture', 'long-capture.html'), 'utf8')

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

test('B06: the copy/pin ceiling is checked on both sides of the thresholds', () => {
  // Edge: exactly at the limit is still copyable, one pixel more is not.
  assert.equal(capabilities({ width: MAX_EDGE, height: 1 }).copy, true)
  const edge = capabilities({ width: MAX_EDGE + 1, height: 1 })
  assert.equal(edge.copy, false)
  assert.equal(edge.pin, false)
  assert.equal(edge.save, true)
  assert.equal(edge.reason, 'edge')
  // Pixels: 10,000 x 8,000 is exactly 80,000,000.
  assert.equal(MAX_PIXELS, 80000000)
  assert.equal(capabilities({ width: 10000, height: 8000 }).copy, true)
  const pixels = capabilities({ width: 10000, height: 8001 })
  assert.equal(pixels.copy, false)
  assert.equal(pixels.reason, 'pixels')
  assert.equal(pixels.save, true)
  // Empty output: nothing can be produced at all.
  const empty = capabilities({ width: 0, height: 0 })
  assert.equal(empty.save, false)
  assert.equal(empty.copy, false)
  assert.equal(empty.reason, 'empty')
})

test('B06: a fast save never overwrites an existing file and keeps its hash', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'highlighter-long-output-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'source.png')
  await fsp.writeFile(source, 'new-bytes')
  const target = path.join(root, 'capture.png')
  await fsp.writeFile(target, 'old-bytes')
  const before = hash(target)

  const written = await copyExclusive(source, target)
  assert.equal(path.basename(written), 'capture (1).png')
  assert.equal(hash(target), before, 'the pre-existing file is untouched')
  assert.equal(fs.readFileSync(written, 'utf8'), 'new-bytes')
})

test('B06: concurrent fast saves land on distinct names', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'highlighter-long-race-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'source.png')
  await fsp.writeFile(source, 'bytes')
  const target = path.join(root, 'same.png')
  const paths = await Promise.all([
    copyExclusive(source, target),
    copyExclusive(source, target),
    copyExclusive(source, target)
  ])
  assert.equal(new Set(paths).size, 3)
  assert.equal(paths[0], target)
  for (const file of paths) assert.equal(fs.readFileSync(file, 'utf8'), 'bytes')
})

test('B06: a non-collision error is reported instead of silently retried', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'highlighter-long-error-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  await assert.rejects(() => copyExclusive(path.join(root, 'missing.png'), path.join(root, 'out.png')), /ENOENT/)
})

test('B06: the main process refuses copy/pin BEFORE composing, and the page says why', () => {
  // The check precedes render(), so an oversized copy never pays for a composition.
  const checkIndex = domain.indexOf('const output = capabilities(size)')
  const renderIndex = domain.indexOf('const outputPath = await state.session.render()')
  assert.ok(checkIndex > 0 && checkIndex < renderIndex, 'capabilities are checked before render')
  assert.match(domain, /code: 'long-capture-too-large'/)
  assert.match(domain, /saveAvailable: output\.save/)
  // Fast save uses the exclusive helper; a dialog save keeps the user's overwrite choice.
  assert.match(domain, /savedPath = await copyExclusive\(outputPath, filePath\)/)
  // The controller knows the same ceiling and disables the two actions with a reason.
  assert.match(controllerHtml, /long-capture-limits\.js[\s\S]*long-capture\.js/)
  assert.match(controller, /const \{ capabilities: outputCapabilities \} = window\.longCaptureLimits/)
  assert.match(controller, /button\.disabled = !total\.strips \|\| busy \|\| blocked/)
  assert.match(controller, /result\?\.code === 'long-capture-too-large'/)
  assert.match(controller, /long-capture\.tip\.save-only/)
})
