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
const ALLOWLIST = new Map([
  ['adm-zip|https://github.com/advisories/GHSA-vwc7-r8mq-g2x9', {
    reason: 'advisories 范围是 >=0.5.9 <=0.6.0，当前最新 0.6.0 本身在范围内，上游无修复版本（npm 建议的 "修复" 是降级到 0.5.8，低于本项目既有下限）。'
      + '漏洞触发路径是解压时跟随符号链接；本仓库只在 main/services/diagnostics-service.js 中用 AdmZip 写入诊断 ZIP（new AdmZip/addFile/writeZip），从不调用 extract*，路径不可达。',
    reviewBy: '2027-03-01'
  }]
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
