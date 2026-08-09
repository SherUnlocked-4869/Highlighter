const base = require('./package.json').build
const version = require('./package.json').version
const prereleaseChannel = version.match(/-(alpha|beta)(?:\.|$)/)?.[1]

module.exports = {
  ...base,
  asar: true,
  forceCodeSigning: true,
  generateUpdatesFilesForAllChannels: true,
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: true,
    grantFileProtocolExtraPrivileges: true
  },
  win: {
    ...base.win,
    verifyUpdateCodeSignature: true
  },
  publish: {
    provider: 'github',
    owner: 'SherUnlocked-4869',
    repo: 'Highlighter',
    channel: prereleaseChannel || 'latest',
    releaseType: 'draft'
  }
}
