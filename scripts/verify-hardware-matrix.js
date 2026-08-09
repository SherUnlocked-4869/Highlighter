const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const projectRoot = path.resolve(__dirname, '..')
const defaultMatrixPath = path.join(projectRoot, 'config', 'release-hardware-matrix.json')

function requireString(value, label, errors) {
  if (typeof value !== 'string' || !value.trim()) errors.push(`${label} is required`)
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function listEvidenceFiles(evidenceDir) {
  if (!fs.existsSync(evidenceDir)) return []
  return fs.readdirSync(evidenceDir)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .sort()
    .map((name) => path.join(evidenceDir, name))
}

function validateClaimEnvironment(requirement, environment, fileName, errors) {
  const expected = requirement.environment || {}
  if (expected.osFamily && environment.osFamily !== expected.osFamily) {
    errors.push(`${fileName}: claim ${requirement.id} requires ${expected.osFamily}`)
  }
  if (expected.osVersion && environment.osVersion !== expected.osVersion) {
    errors.push(`${fileName}: claim ${requirement.id} requires OS version ${expected.osVersion}`)
  }
  if (expected.sessionType && environment.sessionType !== expected.sessionType) {
    errors.push(`${fileName}: claim ${requirement.id} requires an ${expected.sessionType} session`)
  }
  const displays = Array.isArray(environment.displays) ? environment.displays : []
  if (Number.isFinite(expected.scaleFactor) && !displays.some((display) => display?.scaleFactor === expected.scaleFactor)) {
    errors.push(`${fileName}: claim ${requirement.id} requires scale factor ${expected.scaleFactor}`)
  }
  if (expected.minimumDisplays && displays.length < expected.minimumDisplays) {
    errors.push(`${fileName}: claim ${requirement.id} requires at least ${expected.minimumDisplays} displays`)
  }
  if (expected.mixedScaleFactors && new Set(displays.map((display) => display?.scaleFactor)).size < 2) {
    errors.push(`${fileName}: claim ${requirement.id} requires mixed display scale factors`)
  }
  if (expected.negativeCoordinates && !displays.some((display) => display?.bounds?.x < 0 || display?.bounds?.y < 0)) {
    errors.push(`${fileName}: claim ${requirement.id} requires a negative-coordinate display`)
  }
}

function validateEvidence(evidence, fileName, expectedVersion, claimsById, expectedSourceCommit) {
  const errors = []
  if (evidence.schemaVersion !== 1) errors.push(`${fileName}: schemaVersion must be 1`)
  if (evidence?.candidate?.version !== expectedVersion) {
    errors.push(`${fileName}: candidate.version must equal ${expectedVersion}`)
  }
  if (!/^[0-9a-f]{40}$/i.test(evidence?.candidate?.sourceCommit || '')) {
    errors.push(`${fileName}: candidate.sourceCommit must be a full Git commit hash`)
  }
  if (expectedSourceCommit && evidence?.candidate?.sourceCommit !== expectedSourceCommit) {
    errors.push(`${fileName}: candidate.sourceCommit must equal ${expectedSourceCommit}`)
  }

  const environment = evidence.environment || {}
  requireString(environment.osFamily, `${fileName}: environment.osFamily`, errors)
  requireString(environment.osVersion, `${fileName}: environment.osVersion`, errors)
  requireString(environment.osBuild, `${fileName}: environment.osBuild`, errors)
  requireString(environment.architecture, `${fileName}: environment.architecture`, errors)
  if (!['local', 'rdp'].includes(environment.sessionType)) {
    errors.push(`${fileName}: environment.sessionType must be local or rdp`)
  }
  if (!['nsis', 'portable', 'source'].includes(environment.packageType)) {
    errors.push(`${fileName}: environment.packageType must be nsis, portable, or source`)
  }

  const execution = evidence.execution || {}
  if (execution.result !== 'pass') errors.push(`${fileName}: execution.result must be pass`)
  requireString(execution.completedAt, `${fileName}: execution.completedAt`, errors)
  requireString(execution.notes, `${fileName}: execution.notes`, errors)
  const claims = Array.isArray(execution.claims) ? execution.claims : []
  if (claims.length === 0) errors.push(`${fileName}: execution.claims must not be empty`)
  for (const claim of claims) {
    const requirement = claimsById.get(claim)
    if (!requirement) {
      errors.push(`${fileName}: unknown claim ${claim}`)
    } else if (!requirement.packageTypes.includes(environment.packageType)) {
      errors.push(`${fileName}: claim ${claim} does not accept ${environment.packageType} evidence`)
    } else {
      validateClaimEnvironment(requirement, environment, fileName, errors)
    }
  }
  const checks = Array.isArray(execution.checks) ? execution.checks : []
  const passedChecks = new Set(checks.filter((check) => check?.result === 'pass').map((check) => check.id))
  for (const claim of claims) {
    if (!passedChecks.has(claim)) errors.push(`${fileName}: claim ${claim} has no passing check`)
  }

  const defects = Array.isArray(execution.defects) ? execution.defects : []
  for (const defect of defects) {
    const severity = String(defect?.severity || '').toUpperCase()
    if (severity === 'P0' || severity === 'P1') {
      errors.push(`${fileName}: unresolved ${severity} defect blocks release`)
    } else if (severity === 'P2') {
      requireString(defect.issueUrl, `${fileName}: P2 defect issueUrl`, errors)
      requireString(defect.workaround, `${fileName}: P2 defect workaround`, errors)
    } else {
      errors.push(`${fileName}: defect severity must be P0, P1, or P2`)
    }
  }

  requireString(evidence?.signoff?.reviewer, `${fileName}: signoff.reviewer`, errors)
  requireString(evidence?.signoff?.reviewedAt, `${fileName}: signoff.reviewedAt`, errors)
  const artifact = evidence.artifact || {}
  const expectedArtifactName = environment.packageType === 'nsis'
    ? `Highlighter-Setup-${expectedVersion}.exe`
    : `Highlighter-${expectedVersion}-portable.exe`
  if (artifact.name !== expectedArtifactName) {
    errors.push(`${fileName}: artifact.name must equal ${expectedArtifactName}`)
  }
  requireString(artifact.sha256, `${fileName}: artifact.sha256`, errors)
  if (!/^[0-9a-f]{64}$/i.test(artifact.sha256 || '')) {
    errors.push(`${fileName}: artifact.sha256 must be a SHA-256 hash`)
  }
  if (artifact.signatureStatus !== 'Valid') errors.push(`${fileName}: artifact signature must be Valid`)
  requireString(artifact.publisher, `${fileName}: artifact.publisher`, errors)
  requireString(artifact.timestampSubject, `${fileName}: artifact.timestampSubject`, errors)
  const runtimeProbe = evidence?.probes?.runtime || {}
  if (runtimeProbe.status !== 'pass') errors.push(`${fileName}: runtime probe must pass`)
  if (runtimeProbe.nativeRuntimeBuilt !== true) errors.push(`${fileName}: native runtime must be built`)
  if (runtimeProbe.ocrFilesValidated !== true) errors.push(`${fileName}: OCR runtime files must validate`)
  if (runtimeProbe?.nativeCapture?.required !== true || runtimeProbe?.nativeCapture?.nonBlank !== true) {
    errors.push(`${fileName}: native capture probe must return a non-blank frame`)
  }
  return { errors, claims, sourceCommit: evidence?.candidate?.sourceCommit }
}

function getChangedPaths(sourceCommit, repositoryRoot = projectRoot) {
  execFileSync('git', ['merge-base', '--is-ancestor', sourceCommit, 'HEAD'], {
    cwd: repositoryRoot,
    stdio: 'pipe'
  })
  const output = execFileSync('git', ['diff', '--name-only', `${sourceCommit}..HEAD`], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  })
  return output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
}

function verifyHardwareMatrix({
  matrix,
  evidenceFiles,
  expectedVersion,
  expectedSourceCommit = '',
  repositoryRoot = projectRoot,
  changedPathsResolver = getChangedPaths
}) {
  const errors = []
  if (matrix.schemaVersion !== 1) errors.push('matrix schemaVersion must be 1')
  const requiredClaims = Array.isArray(matrix.requiredClaims) ? matrix.requiredClaims : []
  const claimIds = new Set(requiredClaims.map((claim) => claim.id))
  const claimsById = new Map(requiredClaims.map((claim) => [claim.id, claim]))
  if (claimIds.size !== requiredClaims.length || claimIds.has(undefined)) {
    errors.push('matrix required claim IDs must be present and unique')
  }
  for (const claim of requiredClaims) {
    if (!Array.isArray(claim.packageTypes) || claim.packageTypes.length === 0) {
      errors.push(`matrix claim ${claim.id} must define packageTypes`)
    }
  }
  if (evidenceFiles.length === 0) errors.push(`no hardware evidence found for ${expectedVersion}`)

  const coveredClaims = new Set()
  const sourceCommits = new Set()
  for (const filePath of evidenceFiles) {
    let evidence
    try {
      evidence = readJson(filePath)
    } catch (error) {
      errors.push(`${path.basename(filePath)}: invalid JSON (${error.message})`)
      continue
    }
    const result = validateEvidence(evidence, path.basename(filePath), expectedVersion, claimsById, expectedSourceCommit)
    errors.push(...result.errors)
    if (result.errors.length === 0) result.claims.forEach((claim) => coveredClaims.add(claim))
    if (result.sourceCommit) sourceCommits.add(result.sourceCommit)
  }

  for (const claim of requiredClaims) {
    if (!coveredClaims.has(claim.id)) errors.push(`missing passing evidence for ${claim.id}`)
  }
  if (sourceCommits.size > 1) errors.push('all hardware evidence must target the same source commit')

  if (sourceCommits.size === 1) {
    const [sourceCommit] = sourceCommits
    try {
      const changedPaths = changedPathsResolver(sourceCommit, repositoryRoot)
      const evidencePrefix = `docs/releases/evidence/${expectedVersion}/`
      const invalidatedBy = changedPaths.filter((filePath) => !filePath.replaceAll('\\', '/').startsWith(evidencePrefix))
      if (invalidatedBy.length > 0) {
        errors.push(`hardware evidence was invalidated by source changes: ${invalidatedBy.join(', ')}`)
      }
    } catch (error) {
      errors.push(`candidate source commit is not an ancestor of HEAD: ${error.message}`)
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    coveredClaims: [...coveredClaims].sort(),
    requiredClaimCount: requiredClaims.length,
    evidenceCount: evidenceFiles.length
  }
}

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--version') result.version = argv[++index]
    else if (argv[index] === '--evidence-dir') result.evidenceDir = argv[++index]
    else if (argv[index] === '--matrix') result.matrixPath = argv[++index]
    else if (argv[index] === '--source-commit') result.sourceCommit = argv[++index]
    else throw new Error(`Unknown argument: ${argv[index]}`)
  }
  return result
}

function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const packageVersion = readJson(path.join(projectRoot, 'package.json')).version
  const expectedVersion = options.version || packageVersion
  const matrixPath = path.resolve(options.matrixPath || defaultMatrixPath)
  const evidenceDir = path.resolve(options.evidenceDir || path.join(projectRoot, 'docs', 'releases', 'evidence', expectedVersion))
  const result = verifyHardwareMatrix({
    matrix: readJson(matrixPath),
    evidenceFiles: listEvidenceFiles(evidenceDir),
    expectedVersion,
    expectedSourceCommit: options.sourceCommit || ''
  })
  if (!result.valid) {
    for (const error of result.errors) process.stderr.write(`- ${error}\n`)
    throw new Error(`Hardware matrix failed with ${result.errors.length} error(s)`)
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (require.main === module) {
  try {
    runCli()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}

module.exports = {
  getChangedPaths,
  listEvidenceFiles,
  validateEvidence,
  verifyHardwareMatrix
}
