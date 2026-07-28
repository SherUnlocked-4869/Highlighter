const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const LOCATOR_NAME = 'Highlighter.location.json'
const PENDING_NAME = 'Highlighter.location.pending.json'

function resolvePortableDirectory(env = process.env) {
  return env.PORTABLE_EXECUTABLE_DIR ? path.resolve(env.PORTABLE_EXECUTABLE_DIR) : ''
}

function createDataPaths(value) {
  const root = path.resolve(value)
  return {
    root,
    config: path.join(root, 'config'),
    logs: path.join(root, 'logs'),
    history: path.join(root, 'history'),
    cache: path.join(root, 'cache'),
    electronCache: path.join(root, 'cache', 'electron'),
    ocrCache: path.join(root, 'cache', 'ocr'),
    recordingCache: path.join(root, 'cache', 'recordings'),
    longCaptureCache: path.join(root, 'cache', 'long-capture'),
    runtime: path.join(root, 'runtime')
  }
}

async function ensureDataLayout(paths) {
  await Promise.all(Object.entries(paths)
    .filter(([name]) => name !== 'root')
    .map(([, directory]) => fsp.mkdir(directory, { recursive: true })))
  return paths
}

function ensureDataLayoutSync(paths) {
  for (const [name, directory] of Object.entries(paths)) {
    if (name !== 'root') fs.mkdirSync(directory, { recursive: true })
  }
  return paths
}

async function atomicWriteJson(filePath, value, operations = fsp) {
  await operations.mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  const backupPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.bak`
  let hasBackup = false

  try {
    await operations.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    try {
      await operations.rename(temporaryPath, filePath)
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error.code)) throw error

      await operations.rename(filePath, backupPath)
      hasBackup = true
      try {
        await operations.rename(temporaryPath, filePath)
      } catch (replacementError) {
        await operations.rename(backupPath, filePath).catch(() => {})
        throw replacementError
      }
      try {
        await operations.rm(backupPath, { force: true })
        hasBackup = false
      } catch {}
    }
  } finally {
    await operations.rm(temporaryPath, { force: true }).catch(() => {})
    if (!hasBackup) await operations.rm(backupPath, { force: true }).catch(() => {})
  }
}

function parseLocator(value) {
  if (!value || value.version !== 1 || typeof value.dataRoot !== 'string' || !path.isAbsolute(value.dataRoot)) {
    throw new Error('Highlighter 数据目录引导文件无效')
  }
  return { version: 1, dataRoot: path.resolve(value.dataRoot) }
}

async function readLocator(filePath) {
  return parseLocator(JSON.parse(await fsp.readFile(filePath, 'utf8')))
}

function readLocatorSync(filePath) {
  return parseLocator(JSON.parse(fs.readFileSync(filePath, 'utf8')))
}

async function writeLocator(filePath, dataRoot) {
  const locator = parseLocator({ version: 1, dataRoot: path.resolve(dataRoot) })
  await atomicWriteJson(filePath, locator)
  return locator
}

function isNestedPath(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function rejectLinks(directory) {
  const resolved = path.resolve(directory)
  const parsed = path.parse(resolved)
  let cursor = parsed.root

  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    const stat = await fsp.lstat(cursor).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (stat?.isSymbolicLink()) {
      throw new Error(`数据目录不能包含符号链接或目录联接：${cursor}`)
    }
  }
}

async function canonicalPath(directory) {
  const resolved = path.resolve(directory)
  return fsp.realpath(resolved).catch((error) => {
    if (error.code === 'ENOENT') return resolved
    throw error
  })
}

async function validateDataRoot(directory, sourceRoot = '') {
  const input = String(directory || '').trim()
  if (!input || !path.isAbsolute(input)) throw new Error('数据目录必须是绝对路径')

  const root = path.resolve(input)
  const sourceInput = String(sourceRoot || '').trim()
  if (sourceInput && !path.isAbsolute(sourceInput)) throw new Error('旧数据目录必须是绝对路径')

  const source = sourceInput && path.resolve(sourceInput)
  if (source) await rejectLinks(source)

  if (source && (isNestedPath(source, root) || isNestedPath(root, source))) {
    throw new Error('新旧数据目录不能互相包含')
  }

  const canonicalSource = source && await canonicalPath(source)
  const initialCanonicalRoot = await canonicalPath(root)
  if (source && (isNestedPath(canonicalSource, initialCanonicalRoot) || isNestedPath(initialCanonicalRoot, canonicalSource))) {
    throw new Error('新旧数据目录不能互相包含')
  }

  await rejectLinks(root)
  await fsp.mkdir(root, { recursive: true })
  await rejectLinks(root)

  const canonicalRoot = await canonicalPath(root)
  if (source && (isNestedPath(canonicalSource, canonicalRoot) || isNestedPath(canonicalRoot, canonicalSource))) {
    throw new Error('新旧数据目录不能互相包含')
  }

  const probe = path.join(root, `.highlighter-write-${crypto.randomUUID()}`)
  const renamed = `${probe}.renamed`
  try {
    await fsp.writeFile(probe, 'ok', 'utf8')
    await fsp.rename(probe, renamed)
  } finally {
    await Promise.all([
      fsp.rm(probe, { force: true }).catch(() => {}),
      fsp.rm(renamed, { force: true }).catch(() => {})
    ])
  }
  return root
}

module.exports = {
  LOCATOR_NAME,
  PENDING_NAME,
  atomicWriteJson,
  createDataPaths,
  ensureDataLayout,
  ensureDataLayoutSync,
  isNestedPath,
  parseLocator,
  readLocator,
  readLocatorSync,
  resolvePortableDirectory,
  validateDataRoot,
  writeLocator
}
