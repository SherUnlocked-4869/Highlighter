'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const sourceDir = path.resolve(__dirname, '../native/focused-window')
const outputDir = path.join(sourceDir, 'bin')
const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const executable = path.join(outputDir, 'HighlighterFocusedWindow.exe')
const temporary = path.join(outputDir, `HighlighterFocusedWindow-${process.pid}.tmp.exe`)

fs.mkdirSync(outputDir, { recursive: true })
try {
  execFileSync(compiler, [
    '/nologo', '/target:exe', '/optimize+', '/reference:System.Drawing.dll',
    `/out:${temporary}`, path.join(sourceDir, 'Program.cs')
  ], { stdio: 'inherit', windowsHide: true })
  fs.renameSync(temporary, executable)
} finally {
  fs.rmSync(temporary, { force: true })
}
