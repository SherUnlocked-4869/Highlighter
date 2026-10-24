// Builds self-contained design prototypes from src/*.html.
//
// Two markers are substituted:
//   /*__ICON_SHEET__*/  -> :root { --ico-<name>: url("data:image/svg+xml;base64,...") }
//   /*__CONTENT__*/     -> the shared content model (window.HL)
//
// Why inline the icons: every window CSP is `font-src 'self' data:` and the
// prototype is opened over file://, where an external .svg referenced by a CSS
// mask is treated as cross-origin and silently blocked (origin "null"). Inlining
// keeps each prototype double-clickable while icons still inherit currentColor.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const srcDir = join(root, 'src')
const iconsDir = join(root, 'assets', 'icons')

const buildIconSheet = () => {
  const files = readdirSync(iconsDir).filter((f) => f.endsWith('.svg')).sort()
  const decls = files.map((f) => {
    const name = basename(f, '.svg')
    const raw = readFileSync(join(iconsDir, f), 'utf8').replace(/<\?xml[^>]*\?>/g, '').trim()
    const b64 = Buffer.from(raw, 'utf8').toString('base64')
    return `--ico-${name}:url("data:image/svg+xml;base64,${b64}")`
  })
  return `:root{\n${decls.join(';\n')};\n}`
}

const iconSheet = buildIconSheet()
const content = readFileSync(join(root, 'content.js'), 'utf8')

// Optional argv: build only the named sources (e.g. `node tools/build.mjs dir-1.html`).
// Teammates own one direction each and must not rewrite the other two outputs.
const only = process.argv.slice(2).filter((a) => a.endsWith('.html'))
const sources = (only.length ? only : readdirSync(srcDir).filter((f) => /^dir-\d+\.html$/.test(f)).sort())
  .map((f) => f.replace(/^src\//, ''))
if (!sources.length) {
  console.error('no src/dir-N.html found in ' + srcDir)
  process.exit(1)
}

for (const file of sources) {
  const src = readFileSync(join(srcDir, file), 'utf8')
  const missing = ['/*__ICON_SHEET__*/', '/*__CONTENT__*/'].filter((m) => !src.includes(m))
  if (missing.length) {
    console.error(`  FAIL ${file} is missing ${missing.join(', ')}`)
    process.exitCode = 1
    continue
  }
  if (/https?:\/\//.test(src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, ''))) {
    console.warn(`  warn ${file} contains a live http(s) reference — the window CSP will block it`)
  }
  const out = src.replace('/*__ICON_SHEET__*/', iconSheet).replace('/*__CONTENT__*/', content)
  writeFileSync(join(root, file), out, 'utf8')
  const icons = (iconSheet.match(/--ico-/g) || []).length
  console.log(`built ${file}  (${(out.length / 1024).toFixed(0)} KB, ${icons} icons)`)
}
