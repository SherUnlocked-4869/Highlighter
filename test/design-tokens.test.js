const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { configSourceFiles } = require('./helpers/config-source')

const root = path.join(__dirname, '..')
const tokens = fs.readFileSync(path.join(root, 'shared/tokens.css'), 'utf8')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

test('shared design tokens define the canonical palette variables', () => {
  // Surfaces: depth is expressed as a four-step ladder, base to raised.
  // FILM (direction B1, chosen 2026-10-24). Asserting the exact hex made this
  // guard a change-detector rather than a quality gate, so the literal checks now
  // only prove the ladder is present and ordered; the readability of the values is
  // proven by the contrast test below.
  assert.match(tokens, /--bg:\s*#[0-9a-f]{6}/)
  assert.match(tokens, /--surface:\s*#[0-9a-f]{6}/)
  assert.match(tokens, /--surface-2:\s*#[0-9a-f]{6}/)
  assert.match(tokens, /--surface-3:\s*#[0-9a-f]{6}/)
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
  assert.match(tokens, /--radius:\s*13px/)
  assert.match(tokens, /--font-ui:/)
  assert.match(tokens, /--font-mono:/)
  assert.match(tokens, /--focus-ring:/)
})

// ── readability gate ─────────────────────────────────────────────────────────
//
// The real risk in a palette change is not a wrong hex, it is unreadable text: a
// warm paper surface with insufficient ink, or a dark theme whose "muted" is only
// muted to the designer. This is the same WCAG formula the design lint uses, run
// against the actual token values, so a future palette edit cannot land a surface
// and ink pair under the bar.
function hexToRgb(hex) {
  const h = String(hex).replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
function relativeLuminance(rgb) {
  const channel = (v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
}
function contrastRatio(a, b) {
  const la = relativeLuminance(hexToRgb(a))
  const lb = relativeLuminance(hexToRgb(b))
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function paletteOf(selector) {
  const block = selector === ':root'
    ? tokens.slice(tokens.indexOf(':root {'), tokens.indexOf('body.dark {'))
    : tokens.slice(tokens.indexOf('body.dark {'))
  const value = (name) => {
    const m = block.match(new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{6})'))
    assert.ok(m, `${selector} declares --${name}`)
    return m[1]
  }
  return { value }
}

for (const theme of [':root', 'body.dark']) {
  test(`body text clears 4.5:1 on every surface (${theme})`, () => {
    const p = paletteOf(theme)
    const ink = p.value('ink')
    const surfaces = ['bg', 'surface', 'surface-2', 'surface-3']
    for (const surface of surfaces) {
      const ratio = contrastRatio(ink, p.value(surface))
      assert.ok(ratio >= 4.5, `--ink on --${surface} is ${ratio.toFixed(2)}:1, needs 4.5:1 (${theme})`)
    }
  })

  test(`secondary ink clears 4.5:1 where it is used as text (${theme})`, () => {
    // --muted and --faint are TEXT colours: settings descriptions, captions and the
    // 11px nav group headings all read them. --faint was the one that failed in the
    // first FILM pass (3.9-4.3:1 on the warm sand), so it is pinned here.
    const p = paletteOf(theme)
    for (const name of ['muted', 'faint']) {
      const ratio = contrastRatio(p.value(name), p.value('bg'))
      assert.ok(ratio >= 4.5, `--${name} on --bg is ${ratio.toFixed(2)}:1, needs 4.5:1 (${theme})`)
      const onSurface = contrastRatio(p.value(name), p.value('surface'))
      assert.ok(onSurface >= 4.5, `--${name} on --surface is ${onSurface.toFixed(2)}:1, needs 4.5:1 (${theme})`)
    }
  })

  test(`the surface ladder steps are distinguishable (${theme})`, () => {
    // The ladder IS the depth model, so two adjacent steps that resolve to nearly
    // the same luminance make the elevation invisible.
    const p = paletteOf(theme)
    const order = ['bg', 'surface', 'surface-2', 'surface-3']
    const lums = order.map((n) => relativeLuminance(hexToRgb(p.value(n))))
    for (let i = 1; i < lums.length; i++) {
      const delta = Math.abs(lums[i] - lums[i - 1])
      assert.ok(delta > 0.002, `${order[i - 1]} -> ${order[i]} luminance step is ${delta.toFixed(4)}, too flat to read as a step (${theme})`)
    }
  })

  test(`status colours stay legible as text (${theme})`, () => {
    const p = paletteOf(theme)
    for (const name of ['ok', 'warn', 'danger']) {
      const ratio = contrastRatio(p.value(name), p.value('surface'))
      assert.ok(ratio >= 4.5, `--${name} on --surface is ${ratio.toFixed(2)}:1, needs 4.5:1 (${theme})`)
    }
  })
}

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
    ['clipboard/clipboard.css', 'clipboard panel'],
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
    ['action/action.html', 'action.css'],
    ['clipboard/clipboard.html', 'clipboard.css']
  ]) {
    const html = fs.readFileSync(path.join(root, page), 'utf8')
    const tokensIndex = html.indexOf('../shared/tokens.css')
    const cssIndex = html.indexOf(css)
    assert.ok(tokensIndex >= 0, `${page} links tokens.css`)
    assert.ok(cssIndex > tokensIndex, `${page} loads tokens before ${css}`)
  }
})

test('the default accent matches the design system', () => {
  const settingsDefaults = fs.readFileSync(path.join(root, 'main', 'services', 'settings-defaults.js'), 'utf8')
  assert.match(settingsDefaults, /mainColor:\s*'#e5a44c'/, 'the default mainColor is the Nightshift amber')
})

test('legacy blue accents are migrated to Nightshift amber', () => {
  const migration = fs.readFileSync(path.join(root, 'main/services/appearance-migration.js'), 'utf8')
  assert.match(migration, /#1677ff/)
  assert.match(migration, /NIGHTSHIFT_AMBER\s*=\s*'#e5a44c'/)
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  assert.match(main, /migrateAppearanceSettings/, 'main.js wires appearance migration')
  const normalizer = fs.readFileSync(path.join(root, 'main/services/settings-normalize.js'), 'utf8')
  assert.match(normalizer, /resolveMainColor/, 'settings normalization resolves legacy accents at runtime')
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

test('the clipboard panel consumes the shared palette and ships no private colours', () => {
  // The Nightshift redesign deleted the window's old :root/:root.dark palette.
  // A literal hex or a locally declared colour variable would ignore both the
  // theme switch and the user-configured accent, so hold the file to tokens only.
  const css = fs.readFileSync(path.join(root, 'clipboard/clipboard.css'), 'utf8')
  assert.doesNotMatch(css, /:root\s*\{/, 'the clipboard panel must not declare a private :root palette')
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, 'clipboard.css must not hardcode hex colours')
  assert.doesNotMatch(css, /--[a-z0-9-]+\s*:\s*#/i, 'clipboard.css must not declare colour variables')
  // It must actually consume the Nightshift surface ladder and type tokens.
  for (const token of ['--bg', '--surface', '--surface-2', '--surface-3', '--primary', '--font-mono', '--font-display']) {
    assert.match(css, new RegExp(`var\\(${token}\\)`), `clipboard.css consumes ${token}`)
  }
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
    'config/config.css',
    'clipboard/clipboard.html', 'clipboard/clipboard.js', 'clipboard/clipboard.css'
  ]
  const pictographic = /\p{Extended_Pictographic}/u
  const withEmojiPresentation = /[\u{1F300}-\u{1FAFF}]|[\u2600-\u27BF]\uFE0F/u
  for (const file of [...files, ...configSourceFiles().map((entry) => path.relative(root, entry))]) {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    assert.doesNotMatch(text, pictographic, `${file} must not use emoji as icons`)
    assert.doesNotMatch(text, withEmojiPresentation, `${file} must not use emoji-presentation glyphs`)
  }
})

test('every page whose stylesheet uses shared tokens links tokens.css', () => {
  // A window can reference var(--primary) in its CSS yet never load
  // shared/tokens.css — the declarations then silently resolve to nothing and
  // the element renders transparent. long-capture shipped exactly that bug.
  const dirs = ['config', 'capture', 'search', 'action', 'record', 'long-capture', 'pin', 'toolbar', 'recognition', 'clipboard']
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
    'long-capture/overlay.css', 'record/record.css', 'record/frame.css',
    'clipboard/clipboard.css'
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
    'long-capture/overlay.html', 'record/record.html', 'record/frame.html', 'toolbar/toolbar.html',
    'clipboard/clipboard.html'
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

// ── material + motion slots (2026-10-24) ─────────────────────────────────────
//
// The theme direction selected in design-demos/theme-2026 needs two things this
// palette could not express, and one thing it expressed with a formula that
// assumed a near-white surface:
//
//   --chrome        .sidebar and .card are painted from the SAME --surface, so a
//                   direction whose signature is "body one step darker than the
//                   panel" had nowhere to put that step. Measured in the real
//                   Electron window (design-demos/theme-2026/tools/landing-preview.js):
//                   without it, the direction's signature renders inverted.
//   --grain / --grain-opacity   a material texture (sand, fibre, enamel) with no
//                   window-local values.
//   --primary-text-l  the accent-as-foreground ceiling. 0.48 works on #fffefb but
//                   a mid-tone bench (A1's #bfc2c7) needs ~0.35 before the accent
//                   reaches 4.5:1 as text. Making the cap a token lets a theme
//                   lower it without forking the oklch formula.
//
// Every default is a no-op, so the shipped look is unchanged.
test('material and motion slots exist and default to no-ops', () => {
  assert.match(tokens, /--chrome:\s*var\(--surface\)/, '--chrome defaults to the panel colour')
  assert.match(tokens, /--grain:\s*none/, '--grain defaults to no texture')
  assert.match(tokens, /--grain-opacity:\s*0/, '--grain-opacity defaults to invisible')
  for (const token of ['--dur-press', '--dur-hover', '--dur-overlay', '--dur-page']) {
    assert.match(tokens, new RegExp(token + ':'), `${token} is defined`)
  }
  for (const token of ['--ease-out', '--ease-soft', '--ease-press']) {
    assert.match(tokens, new RegExp(token + ':'), `${token} is defined`)
  }
})

test('--primary-text reads its lightness ceiling from a token, not a literal', () => {
  // The formula must consume the token, or a theme lowering --primary-text-l
  // would have no effect.
  assert.match(tokens, /--primary-text-l:\s*0?\.48/)
  assert.match(tokens, /--primary-text:\s*oklch\(from var\(--primary\) min\(l, var\(--primary-text-l\)\) c h\)/)
})

test('the material slots are repeated in dark mode so they do not leak light values', () => {
  // Same rule 2 as every other derived token: --chrome: var(--surface) resolves
  // once, where it is declared, so a single :root declaration would hand dark mode
  // the light surface.
  const darkBlock = tokens.slice(tokens.indexOf('body.dark {'))
  assert.match(darkBlock, /--chrome:\s*var\(--surface\)/, '--chrome is declared for dark mode')
  assert.match(darkBlock, /--grain:\s*none/, '--grain is declared for dark mode')
  assert.match(darkBlock, /--dur-press:/, 'the motion scale is declared for dark mode')
})

// ── glass: the material must stay readable ───────────────────────────────────
//
// FILM's identity is a ladder of glass surfaces, so the palette carries a
// translucency film per step. The risk is obvious and specific: text on glass is
// text on a COMPOSITE of the film and whatever is behind it, so a too-clear film
// can drop body copy under 4.5:1 even though the token values look fine in
// isolation.
//
// This gate composites every glass layer over both extremes it can sit on (the
// bench, and a pure white / pure black worst case) and asserts the ink still
// clears the bar. It also asserts the film is ACTUALLY translucent — the first
// landing shipped opaque fills under a "glass" name, which is the failure this
// detects.
function parseRgba(value) {
  const nums = String(value).match(/[\d.]+/g) || []
  if (nums.length < 4) return null
  return { r: Number(nums[0]), g: Number(nums[1]), b: Number(nums[2]), a: Number(nums[3]) }
}
function composite(fg, bg) {
  // fg is {r,g,b,a} over an opaque bg hex
  const base = hexToRgb(bg)
  const mix = (i) => Math.round(fg[[ 'r', 'g', 'b' ][i]] * fg.a + base[i] * (1 - fg.a))
  return `#${[mix(0), mix(1), mix(2)].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

test('the glass is FROSTED: large blur radius, not a clear pane', () => {
  // Blur is what turns a translucent fill into frost. History: the first cut used
  // 14-26px while the settings window itself was translucent, a desktop window edge
  // behind a card stayed recognisable, and the user asked for frosted, so the radius
  // went up and the alpha with it. The window itself then went opaque (the frosted
  // pass was rejected too, "算了，把磨砂也去掉"), but the recipe still applies to the
  // surfaces that DO have something real behind them: --glass-3 on the transparent
  // selection toolbar, and --glass-1/2 over the in-window bench wash. A future edit
  // that lowers the radius turns those back into clear panes.
  for (const [name, floor] of [['--glass-blur-1', 30], ['--glass-blur-2', 26], ['--glass-blur-3', 30]]) {
    // Escaped properly: a shell-heredoc pass once ate the backslashes and the
    // pattern matched nothing, which read as "the token is undeclared".
    const m = tokens.match(new RegExp(name + ':\\s*(\\d+)px'))
    assert.ok(m, `${name} is declared`)
    assert.ok(Number(m[1]) >= floor, `${name} is ${m[1]}px; frosted glass wants >= ${floor}px`)
  }
})

for (const theme of [':root', 'body.dark']) {
  test(`glass films are genuinely translucent (${theme})`, () => {
    const block = theme === ':root'
      ? tokens.slice(tokens.indexOf(':root {'), tokens.indexOf('body.dark {'))
      : tokens.slice(tokens.indexOf('body.dark {'))
    for (const step of ['--glass-1', '--glass-2', '--glass-3']) {
      const m = block.match(new RegExp(step + ':\s*([^;]+);'))
      assert.ok(m, `${step} is declared (${theme})`)
      const rgba = parseRgba(m[1])
      assert.ok(rgba, `${step} is an rgba() film, got: ${m[1]}`)
      // Two-sided constraint, both halves learned from a real round trip:
      //   * too clear (alpha below ~0.8) and the backdrop's SHAPE shows through —
      //     an edge, a line of text behind a card — so reading becomes work (a dark
      //     window behind the film dropped --muted to 3.85:1). That is the "太透"
      //     the user reported on 2026-10-24. The settings window has since gone
      //     opaque, but --glass-3 still floats over real desktop content;
      //   * at or near 1.0 it is an opaque fill wearing a glass name.
      // The design decision is FROSTED: transmit colour, not detail. The floor is
      // therefore 0.8, not 0.4.
      assert.ok(rgba.a >= 0.8, `${step} alpha ${rgba.a} is too clear for frosted glass (floor 0.8)`)
      assert.ok(rgba.a < 0.95, `${step} alpha ${rgba.a} is an opaque fill wearing a glass name`)
    }
  })

  test(`text on glass stays readable over the backdrops it can really have (${theme})`, () => {
    const p = paletteOf(theme)
    const block = theme === ':root'
      ? tokens.slice(tokens.indexOf(':root {'), tokens.indexOf('body.dark {'))
      : tokens.slice(tokens.indexOf('body.dark {'))
    const ink = p.value('ink')
    const muted = p.value('muted')
    // What can actually sit behind each glass layer. The white/black entries are
    // deliberately extreme bounds: they are stronger than anything the opaque
    // settings window can produce (its skin feature tints the bench by at most 18%),
    // and they cover the one layer that really does float over arbitrary screen
    // content.
    //
    //   glass-1 (chrome)         -> the bench, plus the window's own light wash
    //   glass-2 (panel/card)     -> the bench (inside the opaque window)
    //   glass-3 (selection bar)  -> a real screen capture, anywhere: so the bench
    //                               AND a deliberately extreme light/dark pair
    const backdrops = {
      '--glass-1': [ ':bench' , '#ffffff' ],
      '--glass-2': [ ':shell' ],
      '--glass-3': [ ':bench', '#ffffff', '#000000' ],
    }
    const bench = p.value('bg')
    const shellRgba = parseRgba((block.match(/--glass-1:\s*([^;]+);/) || [])[1])
    const shellFace = shellRgba ? composite(shellRgba, bench) : bench
    const resolve = (name) => (name === ':bench' ? bench : name === ':shell' ? shellFace : name)

    for (const [step, list] of Object.entries(backdrops)) {
      const rgba = parseRgba((block.match(new RegExp(step + ':\s*([^;]+);')) || [])[1])
      if (!rgba) continue
      for (const raw of list) {
        const backdrop = resolve(raw)
        const face = composite(rgba, backdrop)
        const body = contrastRatio(ink, face)
        assert.ok(body >= 4.5,
          `body ink on ${step} over ${raw} is ${body.toFixed(2)}:1, needs 4.5:1 (${theme})`)
        const secondary = contrastRatio(muted, face)
        assert.ok(secondary >= 4.5,
          `--muted on ${step} over ${raw} is ${secondary.toFixed(2)}:1, needs 4.5:1 (${theme})`)
      }
    }
  })
}
