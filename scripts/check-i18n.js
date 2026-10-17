#!/usr/bin/env node
'use strict'

// i18n gate.
//
// W0-4 (2026-10-10) freezes the interface; S1 (batch C) tightens --max to 0.
//
//   node scripts/check-i18n.js                 summary + un-migrated count
//   node scripts/check-i18n.js --list          print every un-migrated line
//   node scripts/check-i18n.js --max 900       fail when the count exceeds 900
//   node scripts/check-i18n.js --json          machine-readable report
//   node scripts/check-i18n.js --area config   limit the scan to one area
//
// Locale sources: every `shared/locales/*.js`, in file-name order (S1, 2026-10-11).
// The three per-language files carry the cross-window keys; each `<domain>.js`
// file registers that domain's keys for all three languages at once, so one
// domain is one file and the wave-9 streams never share a write target. A
// hard-coded three-file list would silently skip every new domain file.
//
// Three checks:
//   1. the three locale tables have an empty key-set symmetric difference;
//   2. every key follows <domain>.<module>.<semantic>;
//   3. every data-i18n* key used by a window exists in all three tables.
// The CJK scan reports un-migrated UI text. `main/**` lines that are `throw`
// statements are counted separately: decision D6 keeps them out of scope for
// this release, so they are not part of the enforced total.

const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const LANGUAGES = ['zh-CN', 'en-US', 'zh-TW']
// 每一段都允许连字符：domain 用目录名，而 `long-capture` 是合法 domain（它同时是目录名与
// IPC surface 的 role）。原实现只允许**第一段**无连字符，会把整套 long-capture 键判为非法。
const KEY_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/
const CJK = /[\u4e00-\u9fff]/
const SCAN_AREAS = ['config', 'capture', 'clipboard', 'record', 'long-capture', 'action', 'search', 'recognition', 'toolbar', 'pin', 'main']
const SCAN_EXTENSIONS = new Set(['.js', '.html', '.css'])
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', 'test-results', '.git', '.tmp', 'target'])

function readArgument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function hasFlag(name) {
  return process.argv.includes(name)
}

function walk(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      files.push(...walk(path.join(directory, entry.name)))
      continue
    }
    if (SCAN_EXTENSIONS.has(path.extname(entry.name))) files.push(path.join(directory, entry.name))
  }
  return files
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join('/')
}

// Scans shared/locales/*.js (file-name order). Each file registers one or more
// languages into the shared globalThis.__LOCALES bag, so requiring all of them
// and reading the bag back is the same merge the windows perform with <script>.
function localeFiles() {
  const directory = path.join(root, 'shared', 'locales')
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => path.join(directory, name))
}

function loadLocales() {
  // A fresh bag per run: require() caches, so the files must be re-evaluated and
  // the bag reset to keep repeated in-process calls independent.
  globalThis.__LOCALES = {}
  const files = localeFiles()
  const registrations = new Map()
  for (const file of files) {
    delete require.cache[require.resolve(file)]
    require(file)
    registrations.set(relative(file), languagesIn(globalThis.__LOCALES))
  }
  const tables = {}
  for (const language of LANGUAGES) tables[language] = globalThis.__LOCALES[language] || {}
  return { tables, files: files.map(relative), registrations }
}

function languagesIn(bag) {
  return LANGUAGES.filter((language) => {
    const table = bag[language]
    return !!table && typeof table === 'object' && Object.keys(table).length > 0
  })
}

// Every domain file must register all three languages: a file that only fills
// zh-CN produces a cross-language key gap that the symmetric-difference check
// reports per key rather than per file (S1, 2026-10-11).
function localeCoverageProblems(registrations) {
  const problems = []
  for (const [file, languages] of registrations) {
    if (languages.length === 0) {
      problems.push(`${file} registers none of ${LANGUAGES.join(' / ')}`)
      continue
    }
    const absent = LANGUAGES.filter((language) => !languages.includes(language))
    if (absent.length > 0) {
      problems.push(`${file} registers ${languages.join(' / ')} but not ${absent.join(' / ')}`)
    }
  }
  return problems
}

function keySetOf(table) {
  return Object.keys(table).sort()
}

function symmetricDifference(tables) {
  const problems = []
  const reference = keySetOf(tables[LANGUAGES[0]])
  for (const language of LANGUAGES.slice(1)) {
    const keys = keySetOf(tables[language])
    const missing = reference.filter((key) => !keys.includes(key))
    const extra = keys.filter((key) => !reference.includes(key))
    for (const key of missing) problems.push(`${language} is missing "${key}" (present in ${LANGUAGES[0]})`)
    for (const key of extra) problems.push(`${language} defines "${key}" which ${LANGUAGES[0]} does not`)
  }
  return problems
}

function keyShapeProblems(tables) {
  const problems = []
  for (const language of LANGUAGES) {
    for (const key of keySetOf(tables[language])) {
      if (!KEY_PATTERN.test(key)) problems.push(`${language}: "${key}" does not follow <domain>.<module>.<semantic>`)
    }
  }
  return problems
}

function usedKeys(areas) {
  const used = new Map()
  for (const area of areas) {
    const directory = path.join(root, area)
    if (!fs.existsSync(directory)) continue
    for (const file of walk(directory)) {
      if (path.extname(file) !== '.html') continue
      const text = fs.readFileSync(file, 'utf8')
      for (const match of text.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) {
        if (!used.has(match[1])) used.set(match[1], relative(file))
      }
    }
  }
  return used
}

function scanUntranslated(areas) {
  const perArea = {}
  const lines = []
  for (const area of areas) {
    const directory = path.join(root, area)
    if (!fs.existsSync(directory)) continue
    let count = 0
    let outOfScope = 0
    for (const file of walk(directory)) {
      const contents = fs.readFileSync(file, 'utf8').split(/\r?\n/)
      contents.forEach((text, index) => {
        if (!CJK.test(text)) return
        const isMainThrow = area === 'main' && /\bthrow\b/.test(text)
        if (isMainThrow) {
          // D6: main-process `throw` text is a separate, later project.
          outOfScope += 1
          return
        }
        count += 1
        lines.push({ area, file: relative(file), line: index + 1, text: text.trim() })
      })
    }
    perArea[area] = { lines: count, outOfScope }
  }
  return { perArea, lines }
}

function main() {
  const areaFilter = readArgument('--area')
  const areas = areaFilter
    ? SCAN_AREAS.filter((area) => areaFilter.split(',').includes(area))
    : SCAN_AREAS
  const max = readArgument('--max')
  const maxValue = max === undefined ? null : Number(max)
  if (max !== undefined && (!Number.isInteger(maxValue) || maxValue < 0)) {
    console.error('check-i18n: --max expects a non-negative integer')
    process.exitCode = 2
    return
  }

  const { tables, files: localeFileList, registrations } = loadLocales()
  const symmetry = symmetricDifference(tables)
  const shapes = [
    // A domain file that forgets one language would otherwise surface only as a
    // giant symmetric-difference list; naming the file is what makes it fixable.
    ...localeCoverageProblems(registrations),
    ...keyShapeProblems(tables)
  ]
  const used = usedKeys(areas)
  const missingKeys = [...used.entries()].filter(([key]) => LANGUAGES.some((language) => !Object.hasOwn(tables[language], key)))
  const { perArea, lines } = scanUntranslated(areas)
  const total = lines.length
  const outOfScope = Object.values(perArea).reduce((sum, entry) => sum + entry.outOfScope, 0)

  if (hasFlag('--json')) {
    console.log(JSON.stringify({
      languages: LANGUAGES,
      localeFiles: localeFileList,
      keys: Object.fromEntries(LANGUAGES.map((language) => [language, keySetOf(tables[language]).length])),
      symmetry,
      shapes,
      missingKeys: missingKeys.map(([key, file]) => ({ key, file })),
      perArea,
      total,
      outOfScope,
      max: maxValue
    }, null, 2))
  } else {
    console.log('i18n check')
    console.log(`  locale files     : ${localeFileList.length} (${localeFileList.join(', ')})`)
    console.log(`  locale keys      : ${LANGUAGES.map((language) => `${language}=${keySetOf(tables[language]).length}`).join(' ')}`)
    console.log(`  symmetric diff   : ${symmetry.length === 0 ? 'ok' : `${symmetry.length} problem(s)`}`)
    console.log(`  key shape        : ${shapes.length === 0 ? 'ok' : `${shapes.length} problem(s)`}`)
    console.log(`  data-i18n keys   : ${used.size} used, ${missingKeys.length} missing from a table`)
    console.log('  un-migrated CJK  :')
    for (const area of areas) {
      const entry = perArea[area]
      if (!entry) continue
      const suffix = entry.outOfScope ? ` (+${entry.outOfScope} main throw lines, out of scope per D6)` : ''
      console.log(`    ${area.padEnd(14)}${String(entry.lines).padStart(6)}${suffix}`)
    }
    console.log(`    ${'TOTAL'.padEnd(14)}${String(total).padStart(6)}`)
    if (hasFlag('--list')) {
      for (const entry of lines) console.log(`      ${entry.file}:${entry.line}: ${entry.text}`)
    }
    for (const problem of symmetry) console.log(`  ! ${problem}`)
    for (const problem of shapes) console.log(`  ! ${problem}`)
    for (const [key, file] of missingKeys) console.log(`  ! ${file} uses "${key}" which is missing from at least one table`)
  }

  const failures = symmetry.length + shapes.length + missingKeys.length + (maxValue !== null && total > maxValue ? 1 : 0)
  if (maxValue !== null && total > maxValue) {
    console.error(`check-i18n: ${total} un-migrated lines exceed --max ${maxValue}`)
  }
  process.exitCode = failures === 0 ? 0 : 1
}

main()
