const fs = require('node:fs')
const path = require('node:path')
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses')

const FUSE_OFF = 48
const FUSE_ON = 49
const EXPECTED_FUSES = Object.freeze([
  [FuseV1Options.RunAsNode, FUSE_OFF, 'RunAsNode'],
  [FuseV1Options.EnableCookieEncryption, FUSE_ON, 'EnableCookieEncryption'],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FUSE_OFF, 'EnableNodeOptionsEnvironmentVariable'],
  [FuseV1Options.EnableNodeCliInspectArguments, FUSE_OFF, 'EnableNodeCliInspectArguments'],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FUSE_ON, 'EnableEmbeddedAsarIntegrityValidation'],
  [FuseV1Options.OnlyLoadAppFromAsar, FUSE_ON, 'OnlyLoadAppFromAsar'],
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FUSE_OFF, 'LoadBrowserProcessSpecificV8Snapshot'],
  [FuseV1Options.GrantFileProtocolExtraPrivileges, FUSE_ON, 'GrantFileProtocolExtraPrivileges']
])

function assertFuseStates(wire) {
  if (!wire || wire.version !== '1') throw new Error(`Unsupported Electron fuse wire: ${wire?.version || '(missing)'}`)
  const failures = []
  for (const [index, expected, name] of EXPECTED_FUSES) {
    const actual = wire[index]
    if (actual !== expected) failures.push(`${name} expected ${expected === FUSE_ON ? 'on' : 'off'}, got ${actual}`)
  }
  if (failures.length) throw new Error(`Electron fuse verification failed:\n${failures.join('\n')}`)
  return EXPECTED_FUSES.map(([, state, name]) => ({ name, enabled: state === FUSE_ON }))
}

async function verifyElectronFuses(executablePath) {
  const resolved = path.resolve(executablePath)
  if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) throw new Error(`Electron executable not found: ${resolved}`)
  const wire = await getCurrentFuseWire(resolved)
  return assertFuseStates(wire)
}

async function main() {
  const executablePath = process.argv[2]
  if (!executablePath) throw new Error('Usage: node scripts/verify-electron-fuses.js <path-to-electron-exe>')
  const states = await verifyElectronFuses(executablePath)
  process.stdout.write(`Electron fuses verified: ${states.map((item) => `${item.name}=${item.enabled ? 'on' : 'off'}`).join(', ')}\n`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || String(error))
    process.exitCode = 1
  })
}

module.exports = {
  EXPECTED_FUSES,
  assertFuseStates,
  verifyElectronFuses
}
