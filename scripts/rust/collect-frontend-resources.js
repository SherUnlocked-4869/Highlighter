'use strict'

// 前端资源打包白名单收集器（Rust 改造计划 §3.1 首批任务）。
//
// 只把 whitelist 登记的页面目录、shared、assets 收集到受控输出目录，并生成
// 确定性的 manifest（路径/字节数/sha256）。禁止 main/、preload、测试、用户数据、
// native/ 和 node_modules 被无差别嵌入；开发临时输出必须在 .tmp*/ 下，正式输出
// 只能写入 whitelist.outputs.releaseOutDir。
//
// 用法：
//   node scripts/rust/collect-frontend-resources.js --check
//   node scripts/rust/collect-frontend-resources.js --list
//   node scripts/rust/collect-frontend-resources.js --out <dir>
//
// --check 只做校验（源根存在、白名单自检、文件可哈希），不写盘。
// --list  把 manifest JSON 打到 stdout（确定性顺序，便于 CI diff）。
// --out   收集并复制到受控目录，同时写 manifest。

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const WHITELIST_PATH = path.join(__dirname, 'frontend-resources.whitelist.json')
const MANIFEST_KIND = 'highlighter.frontend-manifest'

class WhitelistError extends Error {}

function fail(message) {
  throw new WhitelistError(message)
}

function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/')
}

function loadWhitelist(whitelistPath = WHITELIST_PATH) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(whitelistPath, 'utf8'))
  } catch (error) {
    fail(`cannot read whitelist ${path.basename(whitelistPath)}: ${error.message}`)
  }
  return validateWhitelist(parsed)
}

function validateWhitelist(whitelist, repoRoot = REPO_ROOT) {
  if (!whitelist || typeof whitelist !== 'object' || Array.isArray(whitelist)) fail('whitelist must be an object')
  if (whitelist.schemaVersion !== 1) fail('unsupported whitelist schemaVersion')
  if (whitelist.kind !== 'highlighter.frontend-resources') fail('unexpected whitelist kind')
  if (!whitelist.outputs || typeof whitelist.outputs !== 'object') fail('whitelist.outputs missing')
  const defaultOutDir = whitelist.outputs.defaultOutDir
  const releaseOutDir = whitelist.outputs.releaseOutDir
  const manifestName = whitelist.outputs.manifestName
  if (typeof defaultOutDir !== 'string' || !defaultOutDir) fail('whitelist.outputs.defaultOutDir missing')
  if (typeof releaseOutDir !== 'string' || !releaseOutDir) fail('whitelist.outputs.releaseOutDir missing')
  if (typeof manifestName !== 'string' || !/^[a-z0-9.-]+$/.test(manifestName)) fail('whitelist.outputs.manifestName invalid')
  if (!Array.isArray(whitelist.sources) || whitelist.sources.length === 0) fail('whitelist.sources must not be empty')
  if (!Array.isArray(whitelist.exclude)) fail('whitelist.exclude must be an array')
  if (!Array.isArray(whitelist.forbiddenRoots)) fail('whitelist.forbiddenRoots must be an array')
  if (!Array.isArray(whitelist.forbiddenPathSegments)) fail('whitelist.forbiddenPathSegments must be an array')
  const deniedExtensions = new Set(Array.isArray(whitelist.deniedExtensions) ? whitelist.deniedExtensions : [])
  if (!Number.isInteger(whitelist.maxFileBytes) || whitelist.maxFileBytes <= 0) fail('whitelist.maxFileBytes invalid')
  if (!Number.isInteger(whitelist.maxFiles) || whitelist.maxFiles <= 0) fail('whitelist.maxFiles invalid')

  const forbiddenRoots = new Set(whitelist.forbiddenRoots)
  const seenIds = new Set()
  const seenRoots = new Set()
  for (const source of whitelist.sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) fail('whitelist source must be an object')
    if (typeof source.id !== 'string' || !/^[a-z0-9-]+$/.test(source.id)) fail('whitelist source id invalid')
    if (seenIds.has(source.id)) fail(`duplicate whitelist source id: ${source.id}`)
    seenIds.add(source.id)
    if (!['page', 'shared', 'assets'].includes(source.role)) fail(`whitelist source role invalid: ${source.id}`)
    if (typeof source.root !== 'string' || !source.root) fail(`whitelist source root missing: ${source.id}`)
    const normalizedRoot = path.normalize(source.root)
    if (path.isAbsolute(source.root) || normalizedRoot.split(path.sep).includes('..')) {
      fail(`whitelist source root must be repo-relative without traversal: ${source.id}`)
    }
    if (!isInside(repoRoot, path.resolve(repoRoot, normalizedRoot))) fail(`whitelist source escapes repo: ${source.id}`)
    const segments = toPosix(normalizedRoot).split('/')
    if (segments.some((segment) => forbiddenRoots.has(segment))) {
      fail(`whitelist source root is forbidden: ${source.id}`)
    }
    if (segments.length !== 1 && source.role !== 'shared') {
      fail(`whitelist source root must be a top-level directory: ${source.id}`)
    }
    const dedupeKey = toPosix(normalizedRoot)
    if (seenRoots.has(dedupeKey)) fail(`duplicate whitelist source root: ${source.id}`)
    seenRoots.add(dedupeKey)
    if (!Array.isArray(source.allowExtensions) || source.allowExtensions.length === 0) {
      fail(`whitelist source allowExtensions missing: ${source.id}`)
    }
    for (const extension of source.allowExtensions) {
      if (typeof extension !== 'string' || !/^\.[a-z0-9]+$/.test(extension)) {
        fail(`whitelist source allowExtensions invalid: ${source.id}`)
      }
      if (deniedExtensions.has(extension)) {
        fail(`whitelist source allowExtensions contains denied extension ${extension}: ${source.id}`)
      }
    }
  }

  for (const outputDir of [defaultOutDir, releaseOutDir]) {
    const normalizedOut = path.normalize(outputDir)
    if (path.isAbsolute(outputDir) || normalizedOut.split(path.sep).includes('..')) {
      fail('whitelist output directory must be repo-relative without traversal')
    }
    // 只限制顶层目录：正式产物 `rust-app/dist/frontend` 是计划 §3.1 的专属输出；
    // 顶层 `dist/` 是 Electron 候选包目录，禁止前端收集器写入。
    if (forbiddenRoots.has(normalizedOut.split(path.sep)[0])) {
      fail('whitelist output directory is forbidden')
    }
  }
  return whitelist
}

function matchesExclude(patterns, relativePath) {
  const posixPath = toPosix(relativePath)
  return patterns.some((pattern) => {
    if (pattern.startsWith('**/')) {
      const suffix = pattern.slice(3)
      if (posixPath === suffix || posixPath.endsWith(`/${suffix}`)) return true
      // 支持 `**/*.ext` 形式：任意目录深度上的文件名后缀。
      if (suffix.startsWith('*') && posixPath.endsWith(suffix.slice(1))) return true
      return false
    }
    return posixPath === toPosix(path.normalize(pattern))
  })
}

function hashFile(absolutePath) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(absolutePath))
  return hash.digest('hex')
}

function walkSource(source, sourceRoot, repoRoot, whitelist, files, seenPaths) {
  const stack = [sourceRoot]
  while (stack.length > 0) {
    const current = stack.pop()
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name)
      if (entry.isSymbolicLink()) fail(`symbolic link not allowed in frontend resources: ${toPosix(path.relative(repoRoot, absolutePath))}`)
      if (entry.isDirectory()) {
        stack.push(absolutePath)
        continue
      }
      if (!entry.isFile()) continue
      const relativePath = path.relative(repoRoot, absolutePath)
      const posixPath = toPosix(relativePath)
      const segments = posixPath.split('/')
      if (segments.some((segment) => whitelist.forbiddenPathSegments.includes(segment))) {
        fail(`forbidden path segment in frontend resources: ${posixPath}`)
      }
      if (matchesExclude(whitelist.exclude, relativePath)) continue
      const extension = path.extname(entry.name).toLowerCase()
      if (!source.allowExtensions.includes(extension)) continue
      if (seenPaths.has(posixPath)) fail(`file matched by more than one whitelist source: ${posixPath}`)
      seenPaths.add(posixPath)
      const stat = fs.statSync(absolutePath)
      if (stat.size > whitelist.maxFileBytes) fail(`frontend resource exceeds maxFileBytes: ${posixPath}`)
      files.push({
        path: posixPath,
        sourceId: source.id,
        bytes: stat.size,
        sha256: hashFile(absolutePath)
      })
      if (files.length > whitelist.maxFiles) fail('frontend resource count exceeds maxFiles')
    }
  }
}

function collectResources(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || REPO_ROOT)
  const whitelist = options.whitelist || loadWhitelist()
  validateWhitelist(whitelist, repoRoot)
  const files = []
  const seenPaths = new Set()
  for (const source of whitelist.sources) {
    const sourceRoot = path.resolve(repoRoot, path.normalize(source.root))
    if (!isInside(repoRoot, sourceRoot)) fail(`whitelist source escapes repo: ${source.id}`)
    let stat
    try {
      stat = fs.lstatSync(sourceRoot)
    } catch {
      fail(`whitelist source root missing on disk: ${source.root}`)
    }
    if (stat.isSymbolicLink()) fail(`whitelist source root must not be a symbolic link: ${source.root}`)
    if (!stat.isDirectory()) fail(`whitelist source root must be a directory: ${source.root}`)
    walkSource(source, sourceRoot, repoRoot, whitelist, files, seenPaths)
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return {
    schemaVersion: 1,
    kind: MANIFEST_KIND,
    whitelistSchemaVersion: whitelist.schemaVersion,
    files,
    totals: {
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0)
    }
  }
}

function assertCoverage(manifest, whitelist) {
  const bySource = new Map()
  for (const file of manifest.files) {
    if (!bySource.has(file.sourceId)) bySource.set(file.sourceId, [])
    bySource.get(file.sourceId).push(file)
  }
  for (const source of whitelist.sources) {
    const collected = bySource.get(source.id) || []
    if (collected.length === 0) fail(`whitelist source collected no files: ${source.root}`)
    if (source.role === 'page' && !collected.some((file) => file.path.toLowerCase().endsWith('.html'))) {
      fail(`page source collected no HTML entry point: ${source.root}`)
    }
  }
  const pageCount = whitelist.sources.filter((source) => source.role === 'page').length
  if (pageCount === 0) fail('whitelist has no page sources')
  return true
}

function resolveOutputDir(outDir, whitelist, repoRoot = REPO_ROOT) {
  if (typeof outDir !== 'string' || !outDir) fail('output directory missing')
  const absoluteOutDir = path.resolve(repoRoot, outDir)
  if (!isInside(repoRoot, absoluteOutDir) || absoluteOutDir === repoRoot) {
    fail('output directory must be inside the repository and must not be the repository root')
  }
  const relativeOutDir = toPosix(path.relative(repoRoot, absoluteOutDir))
  for (const source of whitelist.sources) {
    const sourceRoot = path.resolve(repoRoot, path.normalize(source.root))
    if (isInside(sourceRoot, absoluteOutDir) || isInside(absoluteOutDir, sourceRoot)) {
      fail(`output directory must not overlap whitelist source: ${source.root}`)
    }
  }
  const allowedOutputs = [whitelist.outputs.defaultOutDir, whitelist.outputs.releaseOutDir].map((value) => toPosix(path.normalize(value)))
  const allowed = allowedOutputs.includes(relativeOutDir) || relativeOutDir.split('/')[0].startsWith('.tmp')
  if (!allowed) fail(`output directory must be one of ${allowedOutputs.join(', ')} or a .tmp*/ directory`)
  return absoluteOutDir
}

function writeResources(manifest, outDir, options = {}) {
  const repoRoot = path.resolve(options.repoRoot || REPO_ROOT)
  const whitelist = options.whitelist || loadWhitelist()
  validateWhitelist(whitelist, repoRoot)
  if (!manifest || manifest.kind !== MANIFEST_KIND) fail('invalid frontend manifest')
  const absoluteOutDir = resolveOutputDir(outDir, whitelist, repoRoot)
  fs.rmSync(absoluteOutDir, { recursive: true, force: true })
  for (const file of manifest.files) {
    const sourcePath = path.join(repoRoot, file.path)
    const targetPath = path.join(absoluteOutDir, file.path)
    if (!isInside(absoluteOutDir, targetPath)) fail(`manifest path escapes output directory: ${file.path}`)
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.copyFileSync(sourcePath, targetPath)
  }
  const manifestPath = path.join(absoluteOutDir, whitelist.outputs.manifestName)
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { outDir: absoluteOutDir, manifestPath, totals: manifest.totals }
}

const USAGE = [
  'usage:',
  '  node scripts/rust/collect-frontend-resources.js --check',
  '  node scripts/rust/collect-frontend-resources.js --list',
  '  node scripts/rust/collect-frontend-resources.js --out <dir>'
].join('\n')

function main(argv) {
  const command = argv[0]
  if (!command || command === '--help' || command === '-h') {
    console.error(USAGE)
    return 2
  }
  try {
    const whitelist = loadWhitelist()
    if (command === '--check') {
      const manifest = collectResources({ whitelist })
      assertCoverage(manifest, whitelist)
      console.log(`frontend-resources: OK ${manifest.totals.files} files, ${manifest.totals.bytes} bytes`)
      return 0
    }
    if (command === '--list') {
      const manifest = collectResources({ whitelist })
      assertCoverage(manifest, whitelist)
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
      return 0
    }
    if (command === '--out') {
      const outDir = argv[1]
      if (!outDir) fail('--out requires a directory argument')
      const manifest = collectResources({ whitelist })
      assertCoverage(manifest, whitelist)
      const written = writeResources(manifest, outDir, { whitelist })
      console.log(`frontend-resources: wrote ${written.totals.files} files, ${written.totals.bytes} bytes to ${toPosix(path.relative(REPO_ROOT, written.outDir))}`)
      return 0
    }
    console.error(USAGE)
    return 2
  } catch (error) {
    console.error(`frontend-resources: ${error.message}`)
    return 1
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2))
}

module.exports = {
  REPO_ROOT,
  WHITELIST_PATH,
  WhitelistError,
  loadWhitelist,
  validateWhitelist,
  collectResources,
  assertCoverage,
  resolveOutputDir,
  writeResources,
  main
}
