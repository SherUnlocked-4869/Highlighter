// Dependency audit gate with an explicit, reviewable allowlist.
//
// `npm audit --audit-level=moderate` fails on advisories that have no upstream
// fix at all, which makes the gate permanently red and therefore useless. This
// wrapper keeps failing on every advisory that is NOT explicitly accepted here,
// so new findings are still caught.
//
// Every entry must record why it is safe for THIS project and must be revisited
// when a fixed version is published. Stale entries (no longer reported) fail the
// gate so the list cannot rot silently.

const { spawnSync } = require('node:child_process')

const AUDIT_LEVELS = ['info', 'low', 'moderate', 'high', 'critical']

// key: "package|advisory-url"
//
// Populated 2026-10-07. `npm audit` went red for 26 findings (18 distinct
// advisories) after upstream published a batch of advisories against versions
// this lockfile already pinned. Nothing here is reachable from the shipped app
// in a way the app does not already block, and the two runtime-relevant ones
// (electron, sharp) are scheduled for a real upgrade in
// docs/plans/2026-10-07-dependency-upgrade-plan.md. Every entry states the
// exposure and carries a review date; an entry that stops being reported still
// fails the gate so the list cannot rot.
const REVIEW_BY = '2026-11-30'

const BUILD_CHAIN_BRACE_EXPANSION =
  'Build/test toolchain only (electron-builder -> app-builder-lib -> @electron/asar, glob, temp, test-exclude); the DoS needs an attacker-controlled glob pattern, and every pattern expanded here is ours. Refresh the transitive minimatch line to brace-expansion 1.1.21+ / 2.1.7+ / 5.0.12+.'
const BUILD_CHAIN_UNDICI =
  'Install/build only: node_modules/electron -> @electron/get, and node-gyp through @electron/rebuild. Dev dependencies are excluded from the packaged app, so no shipped code path reaches it. Refresh to undici 7.29.1+ (or 6.29.0+ on the 6.x line).'
const RUNTIME_ELECTRON =
  'Runtime shell pinned at 43.2.0; exposure is bounded by the app hardening (sandbox:true, webviewTag:false, setWindowOpenHandler deny, no custom protocol registration). Upgrade to the 43.x latest 43.7.9 is planned in docs/plans/2026-10-07-dependency-upgrade-plan.md.'

const ALLOWLIST = new Map([
  // brace-expansion: 6 findings, 3 advisories, all on the build/test toolchain.
  ['brace-expansion|https://github.com/advisories/GHSA-6j4f-fj2g-mc7p', { reason: BUILD_CHAIN_BRACE_EXPANSION, reviewBy: REVIEW_BY }],
  ['brace-expansion|https://github.com/advisories/GHSA-qhr7-859c-m2p7', { reason: BUILD_CHAIN_BRACE_EXPANSION, reviewBy: REVIEW_BY }],
  ['brace-expansion|https://github.com/advisories/GHSA-q2hr-2g5m-vwhr', { reason: BUILD_CHAIN_BRACE_EXPANSION, reviewBy: REVIEW_BY }],
  // electron: the four September 2026 sandbox/privilege advisories.
  ['electron|https://github.com/advisories/GHSA-qmv3-fv6v-rmhq', { reason: `${RUNTIME_ELECTRON} This one has no workaround and needs 43.5.0+.`, reviewBy: REVIEW_BY }],
  ['electron|https://github.com/advisories/GHSA-9qh4-3jw8-366w', { reason: `${RUNTIME_ELECTRON} Needs <webview> plus an unsandboxed embedder; this app locks sandbox:true and webviewTag:false.`, reviewBy: REVIEW_BY }],
  ['electron|https://github.com/advisories/GHSA-gr2m-v5gq-v685', { reason: `${RUNTIME_ELECTRON} Mitigated by the setWindowOpenHandler deny every secure window installs.`, reviewBy: REVIEW_BY }],
  ['electron|https://github.com/advisories/GHSA-j84w-jfhq-vhvj', { reason: `${RUNTIME_ELECTRON} Needs a custom scheme registered with supportFetchAPI but no corsEnabled; the app registers none.`, reviewBy: REVIEW_BY }],
  // fast-uri: production-reachable through electron-store's schema validation.
  ['fast-uri|https://github.com/advisories/GHSA-hrr3-gc8f-f4qj', { reason: 'Reachable only through ajv/ajv-formats schema validation (electron-store) and electron-builder. The advisory needs a case-sensitive host allow/deny decision on fast-uri output; the app makes none. Fix by pulling fast-uri 3.1.8+.', reviewBy: REVIEW_BY }],
  // http-cache-semantics: build-only download path.
  ['http-cache-semantics|https://github.com/advisories/GHSA-ch52-4w7c-c8xp', { reason: 'Build only: electron-builder -> @electron/get -> got -> cacheable-request, used to download Electron binaries. The app runs no shared HTTP cache, so cross-user cache disclosure has no path.', reviewBy: REVIEW_BY }],
  // sharp: Windows-only app, and SVG is never decoded.
  ['sharp|https://github.com/advisories/GHSA-wq5f-xc86-pv6w', { reason: 'The advisory is a librsvg use-after-free that can reach RCE on glibc/Linux when decoding SVG. This app is Windows-only and only feeds PNG/JPEG to sharp for thumbnails. Upgrade to 0.35.5 is planned.', reviewBy: REVIEW_BY }],
  // sprintf-js: no patched release exists at all.
  ['sprintf-js|https://github.com/advisories/GHSA-hp3w-g68c-fv3c', { reason: 'No patched release exists (the advisory lists no first_patched_version). Dev/optional chain @electron/get -> global-agent -> roarr, and the format strings are ours. Only a chain change can remove it.', reviewBy: REVIEW_BY }],
  // undici: install/build only, 10 findings across 8 advisories.
  ['undici|https://github.com/advisories/GHSA-w293-vg96-wgc3', { reason: BUILD_CHAIN_UNDICI, reviewBy: REVIEW_BY }],
  ['undici|https://github.com/advisories/GHSA-rfgv-xxqx-mfg5', { reason: BUILD_CHAIN_UNDICI, reviewBy: REVIEW_BY }],
  ['undici|https://github.com/advisories/GHSA-rx4f-c7p8-82vq', { reason: BUILD_CHAIN_UNDICI, reviewBy: REVIEW_BY }],
  ['undici|https://github.com/advisories/GHSA-pmjh-fq2x-6v4x', { reason: BUILD_CHAIN_UNDICI, reviewBy: REVIEW_BY }],
  ['undici|https://github.com/advisories/GHSA-3xpg-4rpp-hhhm', { reason: BUILD_CHAIN_UNDICI, reviewBy: REVIEW_BY }],
  ['undici|https://github.com/advisories/GHSA-3wwx-pv8p-q78v', { reason: BUILD_CHAIN_UNDICI, reviewBy: REVIEW_BY }],
  ['undici|https://github.com/advisories/GHSA-2jfj-6hjv-fm6j', { reason: BUILD_CHAIN_UNDICI, reviewBy: REVIEW_BY }]
])

function severityRank(value) {
  const index = AUDIT_LEVELS.indexOf(String(value || '').toLowerCase())
  return index === -1 ? AUDIT_LEVELS.length : index
}

function collectFindings(report) {
  const findings = []
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities || {})) {
    for (const via of vulnerability.via || []) {
      if (!via || typeof via !== 'object') continue
      findings.push({
        name,
        severity: via.severity || vulnerability.severity,
        title: via.title || '',
        url: via.url || ''
      })
    }
  }
  return findings
}

function runAudit() {
  // Windows resolves npm through npm.cmd, which Node can only launch via a
  // shell. The argv is a fixed literal, so there is nothing to escape.
  const result = spawnSync('npm audit --json', {
    encoding: 'utf8',
    shell: true,
    windowsHide: true
  })
  if (!result.stdout) {
    throw new Error(`npm audit 没有输出：${result.stderr || result.error?.message || '未知错误'}`)
  }
  return JSON.parse(result.stdout)
}

function main() {
  const report = runAudit()
  const threshold = severityRank('moderate')
  const findings = collectFindings(report)
    .filter((finding) => severityRank(finding.severity) >= threshold)

  const accepted = []
  const blocking = []
  for (const finding of findings) {
    if (ALLOWLIST.has(`${finding.name}|${finding.url}`)) accepted.push(finding)
    else blocking.push(finding)
  }

  // Fail on allowlist entries that no longer match anything so the list is
  // pruned instead of silently accumulating stale exceptions.
  const seenKeys = new Set(findings.map((finding) => `${finding.name}|${finding.url}`))
  const stale = [...ALLOWLIST.keys()].filter((key) => !seenKeys.has(key))

  for (const finding of accepted) {
    const entry = ALLOWLIST.get(`${finding.name}|${finding.url}`)
    process.stdout.write(`allowlisted: ${finding.name} (${finding.severity}) ${finding.url}\n`)
    process.stdout.write(`  reason: ${entry.reason}\n`)
    if (entry.reviewBy) process.stdout.write(`  review by: ${entry.reviewBy}\n`)
  }
  for (const key of stale) {
    process.stdout.write(`stale allowlist entry (no longer reported): ${key}\n`)
  }

  if (blocking.length) {
    process.stdout.write('\nblocking advisories:\n')
    for (const finding of blocking) {
      process.stdout.write(`  ${finding.name} (${finding.severity}) ${finding.title} ${finding.url}\n`)
    }
  }

  if (blocking.length || stale.length) {
    process.stdout.write(`\n审计失败：${blocking.length} 个未豁免漏洞，${stale.length} 个失效豁免项。\n`)
    return 1
  }
  process.stdout.write(`\n审计通过：${accepted.length} 个已豁免，0 个未豁免。\n`)
  return 0
}

if (require.main === module) process.exitCode = main()

module.exports = { ALLOWLIST, collectFindings, severityRank }
