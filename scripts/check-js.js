const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const sourceDirectories = [
  'action',
  'capture',
  'config',
  'long-capture',
  'main',
  'pin',
  'recognition',
  'record',
  'scripts',
  'test',
  'tests',
  'toolbar'
]

function collectJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) return collectJavaScriptFiles(target)
      return entry.isFile() && entry.name.endsWith('.js') ? [target] : []
    })
}

const rootFiles = fs.readdirSync(projectRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
  .map((entry) => path.join(projectRoot, entry.name))
const sourceFiles = sourceDirectories
  .map((directory) => path.join(projectRoot, directory))
  .filter((directory) => fs.existsSync(directory))
  .flatMap(collectJavaScriptFiles)
const files = [...new Set([...rootFiles, ...sourceFiles])].sort()

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status || 1)
}

console.log(`Syntax check passed for ${files.length} JavaScript files.`)
