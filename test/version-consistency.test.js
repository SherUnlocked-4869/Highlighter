const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  normalizeTag,
  resolveReleaseTag,
  validateVersionConsistency
} = require('../scripts/check-version')

const root = path.join(__dirname, '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))

test('repository package versions and an optional release tag stay aligned', () => {
  assert.deepEqual(
    validateVersionConsistency(packageJson, packageLock),
    { version: packageJson.version, releaseTag: '' }
  )
  assert.deepEqual(
    validateVersionConsistency(packageJson, packageLock, `refs/tags/v${packageJson.version}`),
    { version: packageJson.version, releaseTag: `v${packageJson.version}` }
  )
})

test('version consistency rejects lockfile drift and a mismatched tag', () => {
  assert.throws(
    () => validateVersionConsistency(
      { version: '2.1.0' },
      { version: '2.0.0', packages: { '': { version: '2.0.0' } } },
      'v2.2.0'
    ),
    /package-lock\.json version 2\.0\.0[\s\S]*root package version 2\.0\.0[\s\S]*release tag v2\.2\.0/
  )
})

test('release tag resolution ignores branch refs', () => {
  assert.equal(normalizeTag('refs/tags/v2.1.0-beta.1'), 'v2.1.0-beta.1')
  assert.equal(resolveReleaseTag([], { GITHUB_REF: 'refs/heads/master', GITHUB_REF_NAME: 'master' }), '')
  assert.equal(resolveReleaseTag([], { GITHUB_REF: 'refs/tags/v2.1.0' }), 'v2.1.0')
  assert.equal(resolveReleaseTag([], { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v2.1.0' }), 'v2.1.0')
  assert.equal(resolveReleaseTag(['v2.2.0'], {}), 'v2.2.0')
})
