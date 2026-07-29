const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'stop-running.ps1'), 'utf8')

test('native build shutdown avoids WMI and scopes Electron termination to this project', () => {
  assert.doesNotMatch(script, /Get-CimInstance|Win32_Process|CommandLine/)
  assert.match(script, /node_modules\\electron\\dist\\electron\.exe/)
  assert.match(script, /Get-Process -Name 'electron'/)
  assert.match(script, /\$process\.Path/)
  assert.match(script, /StringComparison\]::OrdinalIgnoreCase/)
  assert.match(script, /Sort-Object Id -Unique/)
})
