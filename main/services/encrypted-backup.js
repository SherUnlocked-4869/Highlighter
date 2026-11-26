'use strict'

// N06 (docs/reviews/2026-11-26-code-review-and-optimization-report.md section 5.6):
// single-file backup archives for the settings window, with an OPTIONAL password.
//
// The existing D04 backup (./data-root-backup.js) is the source of truth: this
// module never walks the live data root on its own. It calls the existing
// createBackup() into a throw-away directory, zips that package (including the
// existing `.highlighter-backup.json` marker and modules.json manifest), and - if
// a password was supplied - encrypts the zip with scrypt + AES-256-GCM.
//
// Archive layout, unencrypted (the file is a normal ZIP):
//
//   highlighter-archive.json   descriptor (format/version/createdAt/summary)
//   .highlighter-backup.json   the existing backup marker (verbatim)
//   modules.json               the existing backup manifest (verbatim)
//   modules/<module>/...       the existing package files (verbatim)
//
// Archive layout, encrypted (still a normal ZIP, so the extension is honest):
//
//   highlighter-archive.json   descriptor with `encrypted: true` + the KDF
//                              parameters, salt, iv and auth tag
//   payload.bin                AES-256-GCM ciphertext of the unencrypted ZIP
//
// Import: read descriptor -> reject a future format -> require a password when
// encrypted -> derive the key and decrypt -> extract into a temp directory ->
// hand the directory to the existing inspectBackup()/restore path. The import
// path never re-implements the backup validation: a tampered or truncated
// package fails through the same `modules.json`/sha256 checks the directory
// backup uses, on top of the GCM authentication tag.
//
// Safety properties:
//   * the plaintext zip and the derived key never leave memory; the derived key
//     buffer is zeroed after use;
//   * every failure path removes its temp directory and never publishes a
//     partial output file (the output is written to a sibling temp name and
//     renamed only after the archive is complete);
//   * archive extraction rejects absolute/`..`/backslash entries and enforces
//     entry-count/size bounds, so a malicious zip cannot escape the temp dir;
//   * passwords are never interpolated into a result message or a log line.

const crypto = require('node:crypto')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const AdmZip = require('adm-zip')
const backupService = require('./data-root-backup')

const ARCHIVE_FORMAT = 'highlighter-backup-archive'
const ARCHIVE_FORMAT_VERSION = 1
const ARCHIVE_EXTENSION = '.hlbackup.zip'
const ARCHIVE_DESCRIPTOR = 'highlighter-archive.json'
const ENCRYPTED_PAYLOAD_ENTRY = 'payload.bin'
const ENCRYPTION_ALGORITHM = 'aes-256-gcm'
const KDF_ALGORITHM = 'scrypt'
const KEY_BYTES = 32
const SALT_BYTES = 16
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16
// 128 * N * r bytes = 16 MiB at these parameters. maxmem is explicit because
// Node's default (32 MiB) leaves no headroom for a future bump.
const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
// Bounds applied to parameters read back from an untrusted archive: a crafted
// descriptor must not be able to make decryption allocate gigabytes.
const SCRYPT_LIMITS = Object.freeze({ minN: 4096, maxN: 1024 * 1024, maxR: 32, maxP: 16 })
const MAX_PASSWORD_LENGTH = 256
// adm-zip is an in-memory API (it reads the whole zip and materialises every
// entry), so archive mode is bounded. The directory backup stays the option for
// very large data sets; the UI explains the limit through an error code.
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
const MAX_ENTRY_COUNT = 100000
const MAX_TOTAL_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024
const IO_ERROR_CODES = new Set(['ENOSPC', 'EACCES', 'EPERM', 'EROFS'])

function failure (code, message = '', extra = {}) {
  return { ok: false, code, message, ...extra }
}

function errorMessage (error) {
  return error && typeof error.message === 'string' ? error.message : String(error || '')
}

function classifyIoError (error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  return IO_ERROR_CODES.has(code) ? 'archive-write-failed' : 'archive-failed'
}

function isAbsolutePath (value) {
  return typeof value === 'string' && value.length > 0 && path.isAbsolute(value)
}

function isWithin (parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

// ---------------------------------------------------------------------------
// Password handling
// ---------------------------------------------------------------------------

function normalizePassword (value) {
  if (value === undefined || value === null || value === '') return { password: '' }
  if (typeof value !== 'string') return { error: failure('invalid-password', 'the backup password must be a string') }
  // NFC so the same visible password produces the same key on every platform.
  const password = value.normalize('NFC')
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { error: failure('password-too-long', 'the backup password is too long', { limit: MAX_PASSWORD_LENGTH }) }
  }
  return { password }
}

// ---------------------------------------------------------------------------
// Crypto envelope
// ---------------------------------------------------------------------------

function deriveKey (password, salt, params = SCRYPT_PARAMS) {
  const options = { N: params.N, r: params.r, p: params.p, maxmem: params.maxmem || SCRYPT_PARAMS.maxmem }
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_BYTES, options, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

// The associated data binds the KDF parameters and the IV to the ciphertext, so
// editing the descriptor (e.g. swapping the salt) invalidates the tag. The tag
// itself is deliberately not part of the input.
function encryptionAssociatedData (encryption) {
  const parts = [
    ARCHIVE_FORMAT,
    String(ARCHIVE_FORMAT_VERSION),
    encryption.algorithm,
    encryption.keyDerivation,
    String(encryption.keyLength),
    String(encryption.scrypt.N),
    String(encryption.scrypt.r),
    String(encryption.scrypt.p),
    encryption.salt,
    encryption.iv
  ]
  return Buffer.from(parts.join('|'), 'utf8')
}

function validateScryptParams (scryptParams) {
  const params = scryptParams && typeof scryptParams === 'object' ? scryptParams : {}
  const N = Number(params.N)
  const r = Number(params.r)
  const p = Number(params.p)
  if (!Number.isInteger(N) || N < SCRYPT_LIMITS.minN || N > SCRYPT_LIMITS.maxN || (N & (N - 1)) !== 0) {
    return failure('invalid-archive', 'the archive declares unsupported scrypt parameters')
  }
  if (!Number.isInteger(r) || r < 1 || r > SCRYPT_LIMITS.maxR) return failure('invalid-archive', 'the archive declares unsupported scrypt parameters')
  if (!Number.isInteger(p) || p < 1 || p > SCRYPT_LIMITS.maxP) return failure('invalid-archive', 'the archive declares unsupported scrypt parameters')
  if (128 * N * r > 1024 * 1024 * 1024) return failure('invalid-archive', 'the archive declares unsupported scrypt parameters')
  return null
}

function decodeBase64Field (value, expectedBytes, field) {
  if (typeof value !== 'string' || !value) throw Object.assign(new Error(`the archive is missing ${field}`), { code: 'invalid-archive' })
  const buffer = Buffer.from(value, 'base64')
  if (buffer.length !== expectedBytes) throw Object.assign(new Error(`the archive ${field} has the wrong length`), { code: 'invalid-archive' })
  return buffer
}

async function encryptPlainZip ({ plainZip, password, summary, now, version, randomBytes = crypto.randomBytes }) {
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = await deriveKey(password, salt)
  try {
    const encryption = {
      algorithm: ENCRYPTION_ALGORITHM,
      keyDerivation: KDF_ALGORITHM,
      keyLength: KEY_BYTES,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      scrypt: { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p },
      authTag: ''
    }
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv)
    cipher.setAAD(encryptionAssociatedData(encryption))
    const ciphertext = Buffer.concat([cipher.update(plainZip), cipher.final()])
    encryption.authTag = cipher.getAuthTag().toString('base64')
    const descriptor = createArchiveDescriptor({
      summary,
      now,
      version,
      encryption: { ...encryption, plaintextBytes: plainZip.length }
    })
    const zip = new AdmZip()
    zip.addFile(ARCHIVE_DESCRIPTOR, Buffer.from(JSON.stringify(descriptor, null, 2), 'utf8'))
    zip.addFile(ENCRYPTED_PAYLOAD_ENTRY, ciphertext)
    return { buffer: zip.toBuffer(), descriptor }
  } finally {
    // The key is a plain Buffer; overwrite it so it does not sit in the heap.
    key.fill(0)
  }
}

async function decryptPlainZip ({ archive, descriptor, password }) {
  const encryption = descriptor.encryption
  if (!encryption || typeof encryption !== 'object') return failure('invalid-archive', 'the archive is missing its encryption record')
  if (encryption.algorithm !== ENCRYPTION_ALGORITHM || encryption.keyDerivation !== KDF_ALGORITHM) {
    return failure('invalid-archive', 'the archive uses an unsupported encryption algorithm')
  }
  const paramsFailure = validateScryptParams(encryption.scrypt)
  if (paramsFailure) return paramsFailure
  let salt
  let iv
  let authTag
  try {
    salt = decodeBase64Field(encryption.salt, SALT_BYTES, 'salt')
    iv = decodeBase64Field(encryption.iv, IV_BYTES, 'iv')
    authTag = decodeBase64Field(encryption.authTag, AUTH_TAG_BYTES, 'authentication tag')
  } catch (error) {
    return failure(error.code || 'invalid-archive', errorMessage(error))
  }
  const payloadEntry = archive.getEntry(ENCRYPTED_PAYLOAD_ENTRY)
  if (!payloadEntry) return failure('invalid-archive', 'the archive payload is missing')
  const payload = payloadEntry.getData()
  if (!payload.length) return failure('invalid-archive', 'the archive payload is empty')
  const key = await deriveKey(password, salt, encryption.scrypt)
  try {
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv)
    decipher.setAAD(encryptionAssociatedData(encryption))
    decipher.setAuthTag(authTag)
    let plaintext
    try {
      plaintext = Buffer.concat([decipher.update(payload), decipher.final()])
    } catch {
      // GCM cannot distinguish a wrong password from a modified ciphertext or
      // tag; one stable code with a clear message is the honest answer.
      return failure('decrypt-failed', 'the archive password is wrong or the archive was modified')
    }
    return { ok: true, code: 'ok', plainZip: plaintext }
  } finally {
    key.fill(0)
  }
}

// ---------------------------------------------------------------------------
// Descriptor
// ---------------------------------------------------------------------------

function summarizeBackup (created) {
  return {
    format: backupService.BACKUP_FORMAT,
    formatVersion: Number(created.formatVersion) || backupService.BACKUP_FORMAT_VERSION,
    version: typeof created.version === 'string' ? created.version : '',
    createdAt: typeof created.createdAt === 'string' ? created.createdAt : '',
    completedAt: typeof created.completedAt === 'string' ? created.completedAt : '',
    modules: Array.isArray(created.moduleOrder) ? [...created.moduleOrder] : [],
    totalFiles: Number(created.totalFiles) || 0,
    totalBytes: Number(created.totalBytes) || 0,
    checksum: typeof created.checksum === 'string' ? created.checksum : '',
    containsSensitive: created.containsSensitive === true
  }
}

function createArchiveDescriptor ({ summary, now, version, encryption = null }) {
  const descriptor = {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    createdAt: new Date(now).toISOString(),
    appVersion: typeof version === 'string' ? version : '',
    encrypted: encryption !== null,
    backup: { ...summary }
  }
  if (encryption) {
    descriptor.encryption = {
      algorithm: encryption.algorithm,
      keyDerivation: encryption.keyDerivation,
      keyLength: encryption.keyLength,
      scrypt: { ...encryption.scrypt },
      salt: encryption.salt,
      iv: encryption.iv,
      authTag: encryption.authTag
    }
    descriptor.payload = { entry: ENCRYPTED_PAYLOAD_ENTRY, bytes: Number(encryption.plaintextBytes) || undefined }
  }
  return descriptor
}

function readArchiveDescriptor (archive) {
  let descriptor
  try {
    const entry = archive.getEntry(ARCHIVE_DESCRIPTOR)
    if (!entry) return failure('invalid-archive', 'the file is not a Highlighter backup archive')
    descriptor = JSON.parse(entry.getData().toString('utf8'))
  } catch {
    return failure('invalid-archive', 'the archive descriptor is not valid JSON')
  }
  if (!descriptor || typeof descriptor !== 'object' || descriptor.format !== ARCHIVE_FORMAT) {
    return failure('invalid-archive', 'the archive descriptor is not a Highlighter archive')
  }
  if (!Number.isSafeInteger(descriptor.formatVersion) || descriptor.formatVersion < 1) {
    return failure('invalid-archive', 'the archive format version is invalid')
  }
  if (descriptor.formatVersion > ARCHIVE_FORMAT_VERSION) {
    return failure('future-archive', 'the archive was created by a newer Highlighter build', {
      formatVersion: descriptor.formatVersion,
      supportedFormatVersion: ARCHIVE_FORMAT_VERSION
    })
  }
  return { ok: true, code: 'ok', descriptor }
}

// ---------------------------------------------------------------------------
// ZIP building and safe extraction
// ---------------------------------------------------------------------------

async function listBackupFiles (directory) {
  const files = []
  async function walk (current, prefix) {
    const entries = await fsp.readdir(current, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name)
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(absolute, relativePath)
        continue
      }
      if (!entry.isFile()) continue
      files.push(relativePath)
    }
  }
  await walk(directory, '')
  return files
}

async function buildPlainZip ({ backupDirectory, summary, now, version }) {
  const files = await listBackupFiles(backupDirectory)
  const descriptor = createArchiveDescriptor({ summary, now, version })
  const zip = new AdmZip()
  for (const relativePath of files) {
    const absolute = path.join(backupDirectory, ...relativePath.split('/'))
    zip.addFile(relativePath, await fsp.readFile(absolute))
  }
  zip.addFile(ARCHIVE_DESCRIPTOR, Buffer.from(JSON.stringify(descriptor, null, 2), 'utf8'))
  return { buffer: zip.toBuffer(), descriptor }
}

// A ZIP entry name is attacker-controlled. The backup manifest only ever uses
// forward-slash relative paths, so anything else is rejected instead of being
// "repaired" into a path that could leave the extraction directory.
function normalizeEntryName (value) {
  const raw = typeof value === 'string' ? value : ''
  if (!raw || raw.includes('\\') || raw.includes('\0')) return null
  if (raw.startsWith('/')) return null
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.')
  if (!parts.length || parts.includes('..')) return null
  if (/^[A-Za-z]:/.test(parts[0])) return null
  return parts.join('/')
}

function hasBackupPackageShape (directory) {
  return Promise.all([
    fsp.lstat(path.join(directory, backupService.MARKER_FILE)).then((stat) => stat.isFile(), () => false),
    fsp.lstat(path.join(directory, backupService.MANIFEST_FILE)).then((stat) => stat.isFile(), () => false)
  ]).then(([marker, manifest]) => marker && manifest)
}

async function extractPlainZip ({ plainZip, destination }) {
  let archive
  let entries
  try {
    archive = new AdmZip(plainZip)
    entries = archive.getEntries()
  } catch {
    return failure('invalid-archive', 'the archive payload is not a readable zip')
  }
  if (entries.length > MAX_ENTRY_COUNT) {
    return failure('archive-too-large', 'the archive contains too many entries', { limit: MAX_ENTRY_COUNT })
  }
  const planned = []
  let totalBytes = 0
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const name = normalizeEntryName(entry.entryName)
    if (!name) return failure('invalid-archive', 'the archive contains an unsafe path')
    if (name === ARCHIVE_DESCRIPTOR) continue
    const size = Number(entry.header.size)
    if (!Number.isSafeInteger(size) || size < 0) return failure('invalid-archive', 'the archive contains an invalid entry size')
    totalBytes += size
    if (totalBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      return failure('archive-too-large', 'the archive expands beyond the supported size', { limitBytes: MAX_TOTAL_UNCOMPRESSED_BYTES })
    }
    planned.push({ name, entry })
  }
  await fsp.mkdir(destination, { recursive: true })
  let writtenBytes = 0
  for (const { name, entry } of planned) {
    const target = path.join(destination, ...name.split('/'))
    if (!isWithin(destination, target)) return failure('invalid-archive', 'the archive contains an unsafe path')
    // The local header size is advisory; measure what actually came out of the
    // inflater before writing it (zip-bomb guard) and reject a mismatch.
    const data = entry.getData()
    if (data.length !== Number(entry.header.size)) return failure('invalid-archive', 'the archive entry size does not match its contents')
    writtenBytes += data.length
    if (writtenBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      return failure('archive-too-large', 'the archive expands beyond the supported size', { limitBytes: MAX_TOTAL_UNCOMPRESSED_BYTES })
    }
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, data)
  }
  if (!(await hasBackupPackageShape(destination))) {
    return failure('invalid-archive', 'the archive does not contain a Highlighter backup package')
  }
  return { ok: true, code: 'ok', directory: destination }
}

async function writeFileAtomic (filePath, buffer) {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  try {
    await fsp.writeFile(temporary, buffer, { mode: 0o600 })
    await fsp.rename(temporary, filePath)
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

function normalizeModuleIds (modules) {
  const source = Array.isArray(modules) ? modules : backupService.DEFAULT_MODULES
  const normalized = []
  for (const value of source) {
    const id = typeof value === 'string' ? value : value && typeof value.id === 'string' ? value.id : ''
    if (!backupService.MODULE_DEFINITIONS[id]) return null
    if (!normalized.includes(id)) normalized.push(id)
  }
  if (!normalized.length) return null
  return normalized
}

// Export: existing createBackup -> zip -> optional encryption -> atomic write.
// `createBackup` is injectable so the settings-window IPC can pass the data-root
// domain wrapper (which pauses the SQLite writers) while unit tests use the
// service directly.
async function exportArchive (options = {}) {
  const {
    dataRoot,
    modules,
    version = '',
    password = '',
    outputPath,
    tmpRoot = os.tmpdir(),
    now = Date.now(),
    createBackup = backupService.createBackup,
    randomBytes = crypto.randomBytes
  } = options

  const moduleIds = normalizeModuleIds(modules)
  if (!moduleIds) return failure('invalid-request', 'the archive request has no supported backup module')
  const passwordCheck = normalizePassword(password)
  if (passwordCheck.error) return passwordCheck.error
  const secret = passwordCheck.password
  if (!isAbsolutePath(dataRoot)) return failure('invalid-request', 'dataRoot must be an absolute path')
  if (!isAbsolutePath(outputPath)) return failure('invalid-request', 'outputPath must be an absolute path')

  let tempRoot
  try {
    await fsp.mkdir(tmpRoot, { recursive: true })
    tempRoot = await fsp.mkdtemp(path.join(tmpRoot, 'highlighter-archive-export-'))
  } catch (error) {
    return failure(classifyIoError(error), errorMessage(error))
  }
  try {
    const created = await createBackup({
      dataRoot,
      modules: moduleIds,
      targetDirectory: path.join(tempRoot, 'package'),
      version
    })
    if (!created || created.ok !== true) return created || failure('backup-failed', 'the backup package could not be created')
    const estimatedBytes = Number(created.totalBytes) || 0
    if (estimatedBytes > MAX_ARCHIVE_BYTES) {
      return failure('archive-too-large', 'the selected modules are too large for a single-file archive', {
        requiredBytes: estimatedBytes,
        limitBytes: MAX_ARCHIVE_BYTES
      })
    }
    const summary = summarizeBackup(created)
    const plain = await buildPlainZip({ backupDirectory: created.directory, summary, now, version })
    let output = plain.buffer
    let descriptor = plain.descriptor
    if (secret) {
      const sealed = await encryptPlainZip({ plainZip: plain.buffer, password: secret, summary, now, version, randomBytes })
      output = sealed.buffer
      descriptor = sealed.descriptor
    }
    if (output.length > MAX_ARCHIVE_BYTES) {
      return failure('archive-too-large', 'the single-file archive is larger than the supported limit', {
        requiredBytes: output.length,
        limitBytes: MAX_ARCHIVE_BYTES
      })
    }
    try {
      const resolvedOutput = path.resolve(outputPath)
      await fsp.mkdir(path.dirname(resolvedOutput), { recursive: true })
      await writeFileAtomic(resolvedOutput, output)
    } catch (error) {
      return failure(classifyIoError(error), errorMessage(error))
    }
    return {
      ok: true,
      code: 'ok',
      filePath: path.resolve(outputPath),
      encrypted: secret !== '',
      format: ARCHIVE_FORMAT,
      formatVersion: ARCHIVE_FORMAT_VERSION,
      createdAt: descriptor.createdAt,
      archiveBytes: output.length,
      extension: ARCHIVE_EXTENSION,
      backup: summary
    }
  } catch (error) {
    return failure(classifyIoError(error), errorMessage(error))
  } finally {
    // The package (plaintext) is scratch data; never leave it behind.
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

// Inspect/decrypt/extract an archive into a private temp directory and validate
// it with the EXISTING inspectBackup(). The caller owns the directory (it is the
// `backupDirectory` a restore consumes) and must call result.cleanup().
async function inspectArchive (options = {}) {
  const {
    archivePath,
    password = '',
    tmpRoot = os.tmpdir(),
    maxArchiveBytes = MAX_ARCHIVE_BYTES,
    inspectBackup = backupService.inspectBackup
  } = options

  if (!isAbsolutePath(archivePath)) return failure('invalid-request', 'archivePath must be an absolute path')
  const passwordCheck = normalizePassword(password)
  if (passwordCheck.error) return passwordCheck.error
  const secret = passwordCheck.password

  let stat
  try {
    stat = await fsp.stat(archivePath)
  } catch (error) {
    return failure(classifyIoError(error), errorMessage(error))
  }
  if (!stat.isFile()) return failure('invalid-archive', 'the backup archive is not a file')
  if (stat.size > maxArchiveBytes) {
    return failure('archive-too-large', 'the backup archive is larger than the supported limit', {
      requiredBytes: stat.size,
      limitBytes: maxArchiveBytes
    })
  }
  let archive
  try {
    archive = new AdmZip(await fsp.readFile(archivePath))
  } catch {
    return failure('invalid-archive', 'the backup archive is not a readable zip')
  }
  const descriptorRead = readArchiveDescriptor(archive)
  if (!descriptorRead.ok) return descriptorRead
  const descriptor = descriptorRead.descriptor

  let plainZip = null
  if (descriptor.encrypted === true) {
    if (!secret) return failure('password-required', 'this backup archive is encrypted; enter its password')
    const decrypted = await decryptPlainZip({ archive, descriptor, password: secret })
    if (!decrypted.ok) return decrypted
    plainZip = decrypted.plainZip
  } else if (descriptor.encrypted !== false) {
    return failure('invalid-archive', 'the archive descriptor has no encryption state')
  } else {
    plainZip = await fsp.readFile(archivePath)
  }

  // The inner zip of an encrypted archive carries its own descriptor; it must be
  // a plain (unencrypted) archive of the same format/version.
  let plainArchive
  try {
    plainArchive = new AdmZip(plainZip)
  } catch {
    return failure('invalid-archive', 'the backup archive payload is not a readable zip')
  }
  const innerDescriptor = readArchiveDescriptor(plainArchive)
  if (!innerDescriptor.ok) return innerDescriptor
  if (innerDescriptor.descriptor.encrypted !== false) return failure('invalid-archive', 'the archive nesting is invalid')

  let tempRoot
  try {
    await fsp.mkdir(tmpRoot, { recursive: true })
    tempRoot = await fsp.mkdtemp(path.join(tmpRoot, 'highlighter-archive-inspect-'))
  } catch (error) {
    return failure(classifyIoError(error), errorMessage(error))
  }
  let keepDirectory = false
  try {
    const extracted = await extractPlainZip({ plainZip, destination: tempRoot })
    if (!extracted.ok) return extracted
    const inspection = await inspectBackup(tempRoot, { verifyChecksums: true })
    if (!inspection || inspection.ok !== true) return inspection || failure('invalid-archive', 'the backup package did not pass inspection')
    keepDirectory = true
    let cleaned = false
    return {
      ok: true,
      code: 'ok',
      archivePath: path.resolve(archivePath),
      encrypted: descriptor.encrypted === true,
      format: ARCHIVE_FORMAT,
      formatVersion: descriptor.formatVersion,
      createdAt: typeof descriptor.createdAt === 'string' ? descriptor.createdAt : '',
      appVersion: typeof descriptor.appVersion === 'string' ? descriptor.appVersion : '',
      directory: tempRoot,
      inspection,
      async cleanup () {
        if (cleaned) return
        cleaned = true
        await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
      }
    }
  } catch (error) {
    return failure('archive-failed', errorMessage(error))
  } finally {
    if (!keepDirectory) await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

// Test/UI helper: a stable, human-readable archive file name.
function archiveFileName (version, now = Date.now()) {
  const safeVersion = String(version || '0').replace(/[^0-9A-Za-z.-]+/g, '-').replace(/^-+|-+$/g, '') || '0'
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-')
  return `highlighter-backup-${safeVersion}-${stamp}${ARCHIVE_EXTENSION}`
}

module.exports = {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  ARCHIVE_EXTENSION,
  ARCHIVE_DESCRIPTOR,
  ENCRYPTED_PAYLOAD_ENTRY,
  ENCRYPTION_ALGORITHM,
  KDF_ALGORITHM,
  KEY_BYTES,
  SALT_BYTES,
  IV_BYTES,
  AUTH_TAG_BYTES,
  SCRYPT_PARAMS,
  MAX_PASSWORD_LENGTH,
  MAX_ARCHIVE_BYTES,
  MAX_ENTRY_COUNT,
  MAX_TOTAL_UNCOMPRESSED_BYTES,
  normalizePassword,
  deriveKey,
  encryptionAssociatedData,
  validateScryptParams,
  createArchiveDescriptor,
  readArchiveDescriptor,
  buildPlainZip,
  extractPlainZip,
  normalizeEntryName,
  normalizeModuleIds,
  archiveFileName,
  exportArchive,
  inspectArchive
}
