const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const sourceDir = path.resolve(__dirname, '../native/shutter-sound')
const outputDir = path.join(sourceDir, 'bin')
const executable = path.join(outputDir, 'HighlighterShutterSound.exe')
const temporary = path.join(outputDir, `HighlighterShutterSound-${process.pid}.tmp.exe`)

fs.mkdirSync(outputDir, { recursive: true })
try {
  const result = spawnSync('rustc', [
    '--edition=2021', '-C', 'opt-level=s', '-C', 'strip=symbols', '-C', 'panic=abort',
    '-o', temporary, path.join(sourceDir, 'main.rs')
  ], { stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Shutter sound helper build failed (${result.status ?? result.signal})`)
  fs.renameSync(temporary, executable)
} finally {
  fs.rmSync(temporary, { force: true })
}
