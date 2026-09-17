const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const tokens = fs.readFileSync(path.join(root, 'shared/tokens.css'), 'utf8')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

test('shared design tokens define the canonical palette variables', () => {
  // Surfaces: depth is expressed as a four-step ladder, base to raised.
  assert.match(tokens, /--bg:\s*#eeebe4/)
  assert.match(tokens, /--surface:\s*#fffefb/)
  assert.match(tokens, /--surface-2:\s*#f6f3ed/)
  assert.match(tokens, /--surface-3:\s*#ece8e0/)
  assert.match(tokens, /--line:/)
  assert.match(tokens, /--line-2:/)

  // Accent plus the two derived tokens that keep a user-picked color legible.
  assert.match(tokens, /--primary:\s*#e5a44c/)
  assert.match(tokens, /--primary-ink:/)
  assert.match(tokens, /--primary-text:/)

  // Status and the remaining shared knobs.
  assert.match(tokens, /--danger:/)
  assert.match(tokens, /--ok:/)
  assert.match(tokens, /--warn:/)
  assert.match(tokens, /--radius:\s*9px/)
  assert.match(tokens, /--font-ui:/)
  assert.match(tokens, /--font-mono:/)
  assert.match(tokens, /--focus-ring:/)
})

test('each derived token and alias is declared in both themes', () => {
  // A custom property containing var() resolves once, where it is declared, and
  // descendants inherit that resolved value. So any token that composes other
  // tokens must be repeated under body.dark or the light value leaks into dark.
  const darkBlock = tokens.slice(tokens.indexOf('body.dark {'))
  for (const token of [
    '--primary-ink', '--primary-text', '--primary-soft', '--primary-line',
    '--ok-soft', '--warn-soft', '--danger-soft',
    '--radius-sm', '--radius-lg', '--radius-pill',
    '--panel', '--panel-soft', '--text', '--text-dim', '--border',
    '--focus-ring', '--shadow', '--inline-code'
  ]) {
    assert.match(darkBlock, new RegExp(token + ':'), `${token} is declared for dark mode`)
  }
})

test('the accent is never re-declared in dark mode', () => {
  // Runtime code (applyAppearance) sets --primary as an inline style on <html>.
  // Re-declaring it under body.dark would silently override the user's choice.
  const darkBlock = tokens.slice(tokens.indexOf('body.dark {'))
  assert.doesNotMatch(darkBlock, /(^|\s)--primary:\s*#/m)
})

test('window stylesheets consume the shared tokens instead of private palettes', () => {
  // These windows each used to declare their own :root palette, which shadowed
  // shared/tokens.css and let the surfaces drift apart. Guard against regression.
  const cases = [
    ['config/config.css', 'config window'],
    ['search/search.css', 'search window'],
    ['recognition/recognition.css', 'recognition window'],
    ['action/action.css', 'selection assistant'],
    ['capture/capture.css', 'capture overlay'],
    ['long-capture/overlay.css', 'long-capture overlay']
  ]
  for (const [file, label] of cases) {
    const css = fs.readFileSync(path.join(root, file), 'utf8')
    assert.doesNotMatch(css, /--primary:\s*#/, `${label} must not hardcode --primary`)
    assert.doesNotMatch(css, /--bg:\s*#/, `${label} must not hardcode --bg`)
  }
})

test('overlay windows load shared tokens before their own stylesheet', () => {
  for (const [page, css] of [
    ['recognition/recognition.html', 'recognition.css'],
    ['toolbar/toolbar.html', null],
    ['record/frame.html', 'frame.css'],
    ['long-capture/overlay.html', 'overlay.css']
  ]) {
    const html = fs.readFileSync(path.join(root, page), 'utf8')
    const tokensIndex = html.indexOf('shared/tokens.css')
    assert.ok(tokensIndex >= 0, `${page} links shared/tokens.css`)
    if (css) {
      const cssIndex = html.indexOf(css)
      assert.ok(cssIndex > tokensIndex, `${page} loads tokens before ${css}`)
    }
  }
})

test('core renderer shells load shared tokens before window CSS', () => {
  for (const [page, css] of [
    ['config/config.html', 'config.css'],
    ['capture/capture.html', 'capture.css'],
    ['search/search.html', 'search.css'],
    ['record/record.html', 'record.css'],
    ['action/action.html', 'action.css']
  ]) {
    const html = fs.readFileSync(path.join(root, page), 'utf8')
    const tokensIndex = html.indexOf('../shared/tokens.css')
    const cssIndex = html.indexOf(css)
    assert.ok(tokensIndex >= 0, `${page} links tokens.css`)
    assert.ok(cssIndex > tokensIndex, `${page} loads tokens before ${css}`)
  }
})

test('the default accent matches the design system', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  assert.match(main, /mainColor:\s*'#e5a44c'/, 'main.js default mainColor is the Nightshift amber')
})

test('legacy blue accents are migrated to Nightshift amber', () => {
  const migration = fs.readFileSync(path.join(root, 'main/services/appearance-migration.js'), 'utf8')
  assert.match(migration, /#1677ff/)
  assert.match(migration, /NIGHTSHIFT_AMBER\s*=\s*'#e5a44c'/)
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  assert.match(main, /migrateAppearanceSettings/, 'main.js wires appearance migration')
  assert.match(main, /resolveMainColor/, 'normalizeSettings resolves legacy accents at runtime')
})

test('recognition window follows the Nightshift result design', () => {
  const html = fs.readFileSync(path.join(root, 'recognition/recognition.html'), 'utf8')
  const css = fs.readFileSync(path.join(root, 'recognition/recognition.css'), 'utf8')
  assert.match(html, /id="badge"/)
  assert.match(css, /font-display/)
  assert.match(css, /--ok-soft/)
  assert.match(css, /var\(--primary\)/)
  assert.doesNotMatch(css, /#1677ff|#1890ff|rgba\(22,\s*135,\s*255/)
})

test('history thumbnails use a clean surface plate, not a checkerboard', () => {
  const css = fs.readFileSync(path.join(root, 'config/config.css'), 'utf8')
  assert.match(css, /\.history-image\{[^}]*background:var\(--surface-2\)/)
  assert.doesNotMatch(css, /repeating-conic-gradient/)
})

test('selection toolbar carries a Nightshift status LED and primary copy', () => {
  const html = fs.readFileSync(path.join(root, 'toolbar/toolbar.html'), 'utf8')
  const js = fs.readFileSync(path.join(root, 'toolbar/toolbar.js'), 'utf8')
  assert.match(html, /\.toolbar \.led\s*\{/)
  assert.match(html, /\.toolbar \.btn\.pri\s*\{/)
  assert.match(js, /led\.className = 'led'/)
  assert.match(js, /action\.id === 'copy' \? ' pri' : ''/)
})

test('no renderer ships an emoji glyph as an icon', () => {
  // Windows substitutes the colour emoji font for Extended_Pictographic
  // characters, so they render differently across OS versions and carry no
  // product signal. Icon roles use inline SVG or the mask-icon set.
  // Plain typographic marks (✦ ▸ ↑ ↓ ›) are deliberately allowed: they are not
  // Extended_Pictographic and always render as monochrome text.
  const files = [
    'action/action.html', 'action/action.js',
    'long-capture/long-capture.html',
    'config/config.js', 'config/config.css'
  ]
  const pictographic = /\p{Extended_Pictographic}/u
  const withEmojiPresentation = /[\u{1F300}-\u{1FAFF}]|[\u2600-\u27BF]\uFE0F/u
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    assert.doesNotMatch(text, pictographic, `${file} must not use emoji as icons`)
    assert.doesNotMatch(text, withEmojiPresentation, `${file} must not use emoji-presentation glyphs`)
  }
})

test('every page whose stylesheet uses shared tokens links tokens.css', () => {
  // A window can reference var(--primary) in its CSS yet never load
  // shared/tokens.css — the declarations then silently resolve to nothing and
  // the element renders transparent. long-capture shipped exactly that bug.
  const dirs = ['config', 'capture', 'search', 'action', 'record', 'long-capture', 'pin', 'toolbar', 'recognition']
  const tokenUse = /var\(--(primary|primary-ink|primary-text|primary-soft|primary-line|bg|surface|surface-2|surface-3|line|line-2|ink|muted|faint|font-ui|font-mono|radius|ok|warn|danger)\b/
  for (const dir of dirs) {
    const dirPath = path.join(root, dir)
    if (!fs.existsSync(dirPath)) continue
    for (const file of fs.readdirSync(dirPath)) {
      if (!file.endsWith('.html')) continue
      const html = fs.readFileSync(path.join(dirPath, file), 'utf8')
      const linksTokens = html.includes('shared/tokens.css')
      // Check inline styles and any stylesheets the page loads.
      const inlineUsesTokens = tokenUse.test(html)
      const cssUsesTokens = fs.readdirSync(dirPath)
        .filter((f) => f.endsWith('.css'))
        .some((f) => tokenUse.test(fs.readFileSync(path.join(dirPath, f), 'utf8')))
      if ((inlineUsesTokens || cssUsesTokens) && !linksTokens) {
        assert.fail(`${dir}/${file} uses shared tokens but does not link shared/tokens.css`)
      }
    }
  }
})

test('every icon referenced from CSS exists on disk', () => {
  // A mask:url() pointing at a missing file fails silently at runtime — the icon
  // is simply blank — and only surfaces as a console error, which is how the
  // empty-state glyph shipped broken. Resolve each path against the stylesheet
  // that declares it.
  const cssFiles = [
    'config/config.css', 'capture/capture.css', 'search/search.css',
    'action/action.css', 'recognition/recognition.css', 'long-capture/long-capture.css',
    'long-capture/overlay.css', 'record/record.css', 'record/frame.css'
  ]
  const missing = []
  for (const cssFile of cssFiles) {
    const full = path.join(root, cssFile)
    if (!fs.existsSync(full)) continue
    const css = fs.readFileSync(full, 'utf8')
    for (const match of css.matchAll(/url\(\s*['"]?([^'")]+\.svg)['"]?\s*\)/g)) {
      const ref = match[1]
      if (ref.startsWith('data:')) continue
      const resolved = path.resolve(path.dirname(full), ref)
      if (!fs.existsSync(resolved)) missing.push(`${cssFile} -> ${ref}`)
    }
  }
  assert.deepEqual(missing, [], 'CSS references icons that do not exist')
})

test('every icon referenced from renderer HTML exists on disk', () => {
  const pages = [
    'config/config.html', 'capture/capture.html', 'search/search.html',
    'action/action.html', 'recognition/recognition.html', 'long-capture/long-capture.html',
    'long-capture/overlay.html', 'record/record.html', 'record/frame.html', 'toolbar/toolbar.html'
  ]
  const missing = []
  for (const page of pages) {
    const full = path.join(root, page)
    if (!fs.existsSync(full)) continue
    const html = fs.readFileSync(full, 'utf8')
    for (const match of html.matchAll(/url\(\s*['"]?([^'")]+\.svg)['"]?\s*\)/g)) {
      const ref = match[1]
      if (ref.startsWith('data:')) continue
      const resolved = path.resolve(path.dirname(full), ref)
      if (!fs.existsSync(resolved)) missing.push(`${page} -> ${ref}`)
    }
  }
  assert.deepEqual(missing, [], 'HTML references icons that do not exist')
})

test('packaged builds include the shared token stylesheet', () => {
  assert.ok(packageJson.build.files.includes('shared/**/*'))
})
