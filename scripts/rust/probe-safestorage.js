'use strict'

// R0-06 合成凭据探针（Electron side）：只使用合成明文，禁止读取真实凭据。
//
// 用法：
//   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe --no-sandbox \
//     scripts/rust/probe-safestorage.js
//   env -u ELECTRON_RUN_AS_NODE ... scripts/rust/probe-safestorage.js \
//     --decrypt <ciphertext-base64-file> --out <result-json>
//
// 输出（默认）: .tmp-r0-credential/safestorage.json
//   { available, backend, electronVersion, plaintextBase64, ciphertextBase64,
//     roundtripOk, ciphertextBytes }
// 输出（--decrypt）: { decryptOk, plaintextBase64, error }

const fs = require('fs')
const path = require('path')
const { app, safeStorage } = require('electron')

const SYNTHETIC_PLAINTEXT = 'synthetic-r0-credential-do-not-use-0123456789'
const DEFAULT_OUT_DIR = path.join(__dirname, '..', '..', '.tmp-r0-credential')

function parseArgs(argv) {
  const options = { mode: 'roundtrip', decryptFile: '', outFile: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (current === '--decrypt') {
      options.mode = 'decrypt'
      options.decryptFile = argv[index + 1] || ''
      index += 1
    } else if (current === '--out') {
      options.outFile = argv[index + 1] || ''
      index += 1
    } else if (current === '--roundtrip') {
      options.mode = 'roundtrip'
    }
  }
  return options
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function describeBackend() {
  if (process.platform === 'win32') return 'dpapi'
  if (process.platform === 'darwin') return 'keychain'
  return 'linux-secret-store'
}

function runRoundtrip(options) {
  const available = safeStorage.isEncryptionAvailable()
  const result = {
    probe: 'safeStorage.roundtrip',
    available,
    backend: describeBackend(),
    electronVersion: process.versions.electron,
    chromiumVersion: process.versions.chrome,
    plaintextBase64: Buffer.from(SYNTHETIC_PLAINTEXT, 'utf8').toString('base64'),
    ciphertextBase64: '',
    ciphertextBytes: 0,
    roundtripOk: false,
    error: ''
  }
  if (!available) {
    result.error = 'safeStorage.isEncryptionAvailable() === false'
  } else {
    try {
      const ciphertext = safeStorage.encryptString(SYNTHETIC_PLAINTEXT)
      result.ciphertextBytes = Buffer.from(ciphertext).length
      result.ciphertextBase64 = Buffer.from(ciphertext).toString('base64')
      result.roundtripOk = safeStorage.decryptString(Buffer.from(ciphertext)) === SYNTHETIC_PLAINTEXT
    } catch (error) {
      result.error = `${error && error.name ? error.name : 'Error'}: ${error && error.message ? error.message : String(error)}`
    }
  }
  writeJson(options.outFile || path.join(DEFAULT_OUT_DIR, 'safestorage.json'), result)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

function runDecrypt(options) {
  const result = {
    probe: 'safeStorage.decrypt-rust-ciphertext',
    decryptOk: false,
    plaintextBase64: '',
    error: ''
  }
  try {
    if (!options.decryptFile) throw new Error('--decrypt requires a base64 file path')
    const ciphertextBase64 = fs.readFileSync(options.decryptFile, 'utf8').trim()
    const plaintext = safeStorage.decryptString(Buffer.from(ciphertextBase64, 'base64'))
    result.plaintextBase64 = Buffer.from(plaintext, 'utf8').toString('base64')
    result.decryptOk = true
  } catch (error) {
    result.error = `${error && error.name ? error.name : 'Error'}: ${error && error.message ? error.message : String(error)}`
  }
  writeJson(options.outFile || path.join(DEFAULT_OUT_DIR, 'safestorage-decrypt.json'), result)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

app.whenReady().then(() => {
  // 无窗口；任何未捕获异常都会让 app 挂起，因此统一退出。
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.mode === 'decrypt') runDecrypt(options)
    else runRoundtrip(options)
    app.exit(0)
  } catch (error) {
    process.stderr.write(`probe-safestorage failed: ${error && error.stack ? error.stack : error}\n`)
    app.exit(1)
  }
})

// 防止意外挂起（例如 whenReady 不触发）；15 秒后强制退出。
setTimeout(() => {
  process.stderr.write('probe-safestorage: timeout\n')
  app.exit(2)
}, 15000).unref()
