const fs = require('node:fs')
const path = require('node:path')

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function normalizeTag(value) {
  const tag = String(value || '').trim()
  if (!tag) return ''
  return tag.startsWith('refs/tags/') ? tag.slice('refs/tags/'.length) : tag
}

function resolveReleaseTag(argv = process.argv.slice(2), env = process.env) {
  if (argv[0]) return normalizeTag(argv[0])
  if (String(env.GITHUB_REF || '').startsWith('refs/tags/')) return normalizeTag(env.GITHUB_REF)
  if (env.GITHUB_REF_TYPE === 'tag') return normalizeTag(env.GITHUB_REF_NAME)
  return ''
}

function validateVersionConsistency(packageJson, packageLock, releaseTag = '') {
  const version = String(packageJson?.version || '')
  const lockVersion = String(packageLock?.version || '')
  const rootLockVersion = String(packageLock?.packages?.['']?.version || '')
  const errors = []

  if (!SEMVER_PATTERN.test(version)) errors.push(`package.json version is not valid semver: ${version || '(blank)'}`)
  if (lockVersion !== version) errors.push(`package-lock.json version ${lockVersion || '(blank)'} does not match ${version || '(blank)'}`)
  if (rootLockVersion !== version) {
    errors.push(`package-lock.json root package version ${rootLockVersion || '(blank)'} does not match ${version || '(blank)'}`)
  }

  const tag = normalizeTag(releaseTag)
  if (tag) {
    const expectedTag = `v${version}`
    if (tag !== expectedTag) errors.push(`release tag ${tag} does not match ${expectedTag}`)
  }

  if (errors.length) throw new Error(errors.join('\n'))
  return { version, releaseTag: tag }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function main() {
  const projectRoot = path.resolve(__dirname, '..')
  const packageJson = readJson(path.join(projectRoot, 'package.json'))
  const packageLock = readJson(path.join(projectRoot, 'package-lock.json'))
  const result = validateVersionConsistency(packageJson, packageLock, resolveReleaseTag())
  const tagSuffix = result.releaseTag ? ` (${result.releaseTag})` : ''
  console.log(`Version consistency check passed: ${result.version}${tagSuffix}`)
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error.message || String(error))
    process.exitCode = 1
  }
}

module.exports = {
  normalizeTag,
  resolveReleaseTag,
  validateVersionConsistency
}
