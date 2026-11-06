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
//
// 2026-10-22: the electron entries are gone. Electron went 43.2.0 -> 43.8.3,
// which clears all five 43.x sandbox/permission/HID-USB advisories (highest
// requirement was 43.7.0, plus the npm-invisible GHSA-jr5w-w6x2-84p9 TLS
// mitigation that needs 43.8.1). The gate started failing on a brand new
// advisory (GHSA-fw47-9c62-h3vw) rather than on the pin drifting, so the fix
// was the upgrade the plan already scheduled, not another exemption.
//
// 2026-11-06: the list is EMPTY, and that is the intended steady state. Two new
// moderate advisories (glob GHSA-3g3m-2fjr-6pw4, vulnerable 9.0.0-14.0.1;
// minimatch GHSA-g3hv-75wg-m249, vulnerable 7.0.0-<11.0.1) plus the stale
// http-cache-semantics row turned the gate red on 5 consecutive runs, which in
// turn skipped every test step behind it. Fixed upstream-style instead of by
// exemption, following the electron precedent above:
//   * `overrides.minimatch = ^11.0.1` - the offenders were the dev toolchain
//     (app-builder-lib, dir-compare, test-exclude); npm's nested override did
//     not take on dir-compare's copy, so the override is global. glob 7.2.3
//     (the copy @electron/asar and rimraf use) keeps working: it calls
//     minimatch's function and Minimatch-class API, which v11 still exports.
//   * `overrides["test-exclude"].glob = ^14.0.2` - c8's coverage glob was the
//     only glob node inside the vulnerable range (glob 7.2.3 is below 9.0.0).
//   * `sharp 0.35.4 -> 0.35.5` - the patch the old sharp entry was waiting for.
// That also pulled brace-expansion 1.1.18 -> 5.0.12, which cleared the three
// brace-expansion advisories, so their rows are gone too. Re-add a row (with a
// reason and a review date) only for a finding that cannot be upgraded away.
const ALLOWLIST = new Map([])


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
