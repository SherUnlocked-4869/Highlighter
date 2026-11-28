'use strict'

// P1-02 (docs/reviews/2026-11-28-review-optimization-follow-up-delivery-review.md):
// runtime probe for the trusted native keyboard-focus classification of the DEV-04 shortcut
// channel (vendor/selection-hook/src/windows/core/keyboard_focus.cc).
//
// It opens a small test application (a separate PowerShell/WinForms process) with
//   * an ordinary text input      -> must classify as "text"     (sensitive, zero events)
//   * a password text input       -> must classify as "password" (sensitive, zero events)
//   * a form without text inputs  -> must classify as "safe"     (allowed demo surface)
// and classifies those window/control handles through the rebuilt addon's
// `__testClassifyFocusedContext({ hwnd })` bridge. No key is pressed and no input is synthesized:
// the real hardware keyboard matrix (demo page / text input / password input / IME composition /
// unknown focus) remains a real-device step, because injected synthetic input is LLKHF_INJECTED
// and is correctly rejected by the native combo channel.
//
// Returns exit code 0 when every class matches, 1 otherwise. Run with:
//   node scripts/probe-keyboard-focus-context.js

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const ADDON_PATH = path.join(ROOT, 'vendor', 'selection-hook', 'build', 'Release', 'selection-hook.node')
const SCRATCH = path.join(ROOT, '.tmp-focus-probe')
const HELPER_PATH = path.join(SCRATCH, 'focus-probe-window.ps1')
const OUT_FILE = path.join(SCRATCH, 'handles.txt')
const STOP_FILE = path.join(SCRATCH, 'stop.txt')

const HELPER_SCRIPT = `
param([string]$OutFile, [string]$StopFile)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Default: keep the visible test window on a secondary display so the primary stays free
# (AGENTS.md). With a single display the probe window is created off-screen instead, so nothing
# user-visible is opened; UIA classifies the control handles either way.
$position = New-Object System.Drawing.Point(-30000, -30000)
$screens = [System.Windows.Forms.Screen]::AllScreens
if ($screens.Count -gt 1) {
  $secondary = $screens[1]
  $position = New-Object System.Drawing.Point(($secondary.Bounds.X + 60), ($secondary.Bounds.Y + 60))
}

$script:lines = [System.Collections.Generic.List[string]]::new()
$forms = @()
function New-ProbeForm([string]$kind) {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = "highlighter-focus-probe-$kind"
  $form.StartPosition = 'Manual'
  $form.Location = $position
  $form.Size = New-Object System.Drawing.Size(420, 260)
  $form.ShowInTaskbar = $false
  $input = $null
  if ($kind -eq 'text' -or $kind -eq 'password') {
    $input = New-Object System.Windows.Forms.TextBox
    $input.Location = New-Object System.Drawing.Point(20, 30)
    $input.Size = New-Object System.Drawing.Size(320, 28)
    if ($kind -eq 'password') { $input.UseSystemPasswordChar = $true }
    $form.Controls.Add($input)
  } else {
    $label = New-Object System.Windows.Forms.Label
    $label.Text = 'non-text application surface'
    $label.Location = New-Object System.Drawing.Point(20, 30)
    $label.AutoSize = $true
    $form.Controls.Add($label)
  }
  $form.Show()
  [System.Windows.Forms.Application]::DoEvents()
  $controlHandle = 0
  if ($null -ne $input) { $controlHandle = $input.Handle.ToInt64() }
  $script:lines.Add($kind + [char]9 + $controlHandle + [char]9 + $form.Handle.ToInt64())
  return $form
}

foreach ($kind in @('text', 'password', 'safe')) { $forms += New-ProbeForm $kind }
Set-Content -Path $OutFile -Value ($script:lines -join [Environment]::NewLine) -Encoding ASCII
while (-not (Test-Path $StopFile)) {
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 50
}
foreach ($form in $forms) { $form.Close() }
`

function fail(message) {
  console.error(`FAIL ${message}`)
  process.exitCode = 1
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('SKIP keyboard focus probe: Windows-only native classification')
    return
  }
  if (!fs.existsSync(ADDON_PATH)) {
    throw new Error(`rebuilt native addon not found: ${ADDON_PATH} (run npm run build:selection)`)
  }
  const addon = require(ADDON_PATH)
  if (typeof addon.__testClassifyFocusedContext !== 'function') {
    throw new Error('the rebuilt addon does not expose __testClassifyFocusedContext (native build is stale)')
  }

  fs.mkdirSync(SCRATCH, { recursive: true })
  fs.writeFileSync(HELPER_PATH, HELPER_SCRIPT, 'utf8')
  fs.rmSync(OUT_FILE, { force: true })
  fs.rmSync(STOP_FILE, { force: true })

  console.log('opening the focus probe test windows (separate PowerShell process, no key presses)')
  const helper = spawn('pwsh', ['-NoProfile', '-STA', '-File', HELPER_PATH, '-OutFile', OUT_FILE, '-StopFile', STOP_FILE], {
    stdio: 'ignore',
    windowsHide: true
  })
  const results = []
  try {
    await waitFor(() => fs.existsSync(OUT_FILE) && fs.readFileSync(OUT_FILE, 'utf8').trim().length > 0, 45000, 'probe window handles')
    const lines = fs.readFileSync(OUT_FILE, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const windows = new Map()
    for (const line of lines) {
      const [kind, controlHandle, formHandle] = line.split('\t')
      windows.set(kind, { controlHandle: Number(controlHandle), formHandle: Number(formHandle) })
    }
    for (const kind of ['text', 'password', 'safe']) {
      if (!windows.has(kind)) throw new Error(`probe helper did not report the ${kind} window`)
    }

    const expectations = [
      ['text input', windows.get('text').controlHandle, 'text'],
      ['password input', windows.get('password').controlHandle, 'password'],
      ['non-text form', windows.get('safe').formHandle, 'safe'],
      ['invalid handle', 0x12345678, 'unknown']
    ]
    for (const [label, hwnd, expected] of expectations) {
      const verdict = addon.__testClassifyFocusedContext({ hwnd })
      results.push({ label, hwnd, expected, ...verdict })
      const ok = verdict.classification === expected
      console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: expected=${expected} actual=${verdict.classification} reason=${verdict.reason}`)
      if (!ok) fail(`${label} classified as ${verdict.classification}`)
    }

    // The production path: classify whatever currently has focus. This is diagnostic only (the
    // host's foreground window depends on the desktop session), so it must return a known class
    // from the bounded classifier, not throw or block.
    const current = addon.__testClassifyFocusedContext()
    console.log(`INFO current foreground: classification=${current.classification} reason=${current.reason} ` +
      `pid=${current.pid} classifierAvailable=${current.classifierAvailable}`)
    if (current.classifierAvailable !== true) fail('bounded IUIAutomation2 classifier is unavailable')
    if (!['safe', 'password', 'text', 'ime', 'unknown'].includes(current.classification)) {
      fail(`unexpected current foreground classification: ${current.classification}`)
    }
  } finally {
    fs.writeFileSync(STOP_FILE, 'stop', 'utf8')
    await Promise.race([
      new Promise((resolve) => helper.once('exit', resolve)),
      sleep(5000)
    ])
    try { helper.kill() } catch {}
    fs.rmSync(OUT_FILE, { force: true })
    fs.rmSync(STOP_FILE, { force: true })
    fs.rmSync(HELPER_PATH, { force: true })
    fs.rmSync(SCRATCH, { recursive: true, force: true })
  }

  const summary = { ok: process.exitCode !== 1, results }
  console.log(JSON.stringify(summary, null, 2))
  if (process.exitCode === 1) process.exitCode = 1
}

main().catch((error) => {
  fail(error?.message || String(error))
  process.exitCode = 1
})
