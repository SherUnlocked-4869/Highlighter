// Builds self-contained design prototypes from design-demos/src/*.html
//
// Two markers are substituted:
//   /*__ICON_SHEET__*/  -> :root { --ico-<name>: url("data:image/svg+xml;base64,...") }
//   /*__CONTENT__*/     -> the shared content model (window.HL)
//
// The icon sheet exists because a page opened over file:// cannot load SVGs into
// a CSS mask (origin "null" is treated as cross-origin, so every icon silently
// disappears). Inlining them as data URIs keeps each prototype double-clickable
// while still letting icons inherit currentColor through mask-image.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
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
    const raw = readFileSync(join(iconsDir, f), 'utf8')
    // Normalise: drop the XML prolog, keep the root <svg>.
    const svg = raw.replace(/<\?xml[^>]*\?>/g, '').trim()
    const b64 = Buffer.from(svg, 'utf8').toString('base64')
    return `--ico-${name}:url("data:image/svg+xml;base64,${b64}")`
  })
  return `:root{\n  ${decls.join(';\n  ')};\n}`
}

const iconSheet = buildIconSheet()
const content = readFileSync(join(srcDir, 'content.js'), 'utf8')

const sourceFiles = readdirSync(srcDir).filter((f) => f.endsWith('.html'))
if (!sourceFiles.length) {
  console.error('no sources found in ' + srcDir)
  process.exit(1)
}

for (const file of sourceFiles) {
  const src = readFileSync(join(srcDir, file), 'utf8')
  for (const marker of ['/*__ICON_SHEET__*/', '/*__CONTENT__*/']) {
    if (!src.includes(marker)) console.warn(`  warn: ${file} is missing ${marker}`)
  }
  const out = src
    .replace('/*__ICON_SHEET__*/', iconSheet)
    .replace('/*__CONTENT__*/', content)
  const target = join(root, file)
  writeFileSync(target, out, 'utf8')
  console.log(`built ${file}  (${(out.length / 1024).toFixed(0)} KB, ${iconSheet.length / 1024 > 0 ? (iconSheet.match(/--ico-/g) || []).length : 0} icons)`)
}
mkdirSync(root, { recursive: true })
