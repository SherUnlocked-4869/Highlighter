const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const toolbarDirectory = path.join(root, 'toolbar')
const iconDirectory = path.join(toolbarDirectory, 'icons')

const metaSource = fs.readFileSync(path.join(toolbarDirectory, 'toolbar-action-meta.js'), 'utf8')
const toolbarJs = fs.readFileSync(path.join(toolbarDirectory, 'toolbar.js'), 'utf8')
const toolbarHtml = fs.readFileSync(path.join(toolbarDirectory, 'toolbar.html'), 'utf8')
const configJs = fs.readFileSync(path.join(root, 'config', 'config.js'), 'utf8')
const captureHtml = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')

const { TOOLBAR_ACTION_META } = require('../toolbar/toolbar-action-meta')
const { CUSTOM_ACTION_ICON } = require('../toolbar/toolbar-utils')

const ICON_NAME = /^[a-z0-9-]+$/
// Normalized wrapper produced by the icon import step: a 16x16 Bootstrap Icons
// asset with no intrinsic size, painted through a mask. `currentColor` is
// deliberately not used — the file is fetched as a standalone image with no
// inherited colour, so the fill is hardcoded and only its alpha channel matters.
// The trailing newline is matched loosely on purpose: the repo runs with
// core.autocrlf=true, so the checked-out working tree holds CRLF even though the
// blob is LF. The assets themselves are always a single line of markup.
const MASK_ASSET = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 16 16" fill="#000">(?:<path [^>]*\/>\s*)+<\/svg>\r?\n$/

test('selection toolbar icon metadata names an asset that exists on disk', () => {
  // The window loads the assets through a CSS var, so a typo or a missing file
  // fails silently as a blank button — there is no runtime error to notice.
  const names = Object.values(TOOLBAR_ACTION_META).map((action) => action.icon)
  names.push(CUSTOM_ACTION_ICON)

  for (const name of names) {
    assert.match(name, ICON_NAME, `${name} must be a bare asset name, not a glyph`)
    assert.equal(
      fs.existsSync(path.join(iconDirectory, `${name}.svg`)),
      true,
      `toolbar/icons/${name}.svg should exist`
    )
  }

  // A glyph would still match none of the above only by luck; pin the shape of
  // the source too so a revert to a pictographic mark is caught here.
  assert.doesNotMatch(metaSource, /icon: '(?![a-z0-9-]+')/, 'metadata icons must be asset names')
})

test('every toolbar icon asset is a normalized mask image', () => {
  const files = fs.readdirSync(iconDirectory).filter((file) => file.endsWith('.svg'))
  assert.ok(files.length > 0)
  for (const file of files) {
    const svg = fs.readFileSync(path.join(iconDirectory, file), 'utf8')
    assert.match(svg, MASK_ASSET, `${file} must be a single-line 16x16 fill="#000" mask asset`)
  }
})

test('no orphaned toolbar icon assets', () => {
  const referenced = new Set([...Object.values(TOOLBAR_ACTION_META).map((action) => action.icon), CUSTOM_ACTION_ICON])
  const orphans = fs.readdirSync(iconDirectory)
    .filter((file) => file.endsWith('.svg'))
    .map((file) => path.basename(file, '.svg'))
    .filter((name) => !referenced.has(name))
  assert.deepEqual(orphans, [], 'toolbar/icons should only hold assets the toolbar resolves')
})

test('both renderers resolve the icon name through a mask, and the strip styles it', () => {
  assert.match(toolbarHtml, /\.toolbar \.toolbar-icon\s*\{[^}]*background:\s*currentColor/)
  assert.match(toolbarHtml, /-webkit-mask:\s*var\(--icon\)\s+center\/contain\s+no-repeat/)
  assert.match(toolbarHtml, /\.toolbar \.btn \.label\s*\{[^}]*text-overflow:\s*ellipsis/)

  assert.match(toolbarJs, /setProperty\('--icon'/)
  assert.match(toolbarJs, /url\('icons\/\$\{toolbarIconName\(action\)\}\.svg'\)/)

  assert.match(configJs, /\.\.\/toolbar\/icons\/\$\{asset\}\.svg/)
  assert.match(configJs, /\$\{toolbarIconMarkup\(info\.icon\)\}/)
})

test('capture toolbar assets are normalized mask images too', () => {
  // line.svg is the deliberate exception: config's window titlebar reuses it as
  // the minimize glyph, so the annotation tool got its own line-tool.svg.
  const iconPaths = [...captureHtml.matchAll(/--icon:url\('([^']+\.svg)'\)/g)].map((match) => match[1])
  assert.ok(iconPaths.length > 0)
  for (const iconPath of iconPaths) {
    assert.notEqual(iconPath, 'icons/line.svg', 'the line tool must not reuse the titlebar glyph')
    const svg = fs.readFileSync(path.join(root, 'capture', iconPath), 'utf8')
    assert.match(svg, MASK_ASSET, `capture/${iconPath} must be a normalized mask asset`)
  }
})
