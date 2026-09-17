// Local unsigned build: NSIS setup with Electron fuses hardening, no code signing.
// Extends the release config but drops the mandatory code-signing requirement,
// which requires signing certificates not present on dev machines.
const release = require('./electron-builder.release.cjs')

module.exports = {
  ...release,
  forceCodeSigning: false
}
