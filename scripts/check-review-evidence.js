#!/usr/bin/env node
'use strict'

// D06 (docs/reviews/2026-11-24-windows-product-architecture-review.md): every ticket in the
// review must point at a regression test that lives in the repository, and every P0 must have
// at least one. The registry is a markdown table so it stays reviewable next to the review
// itself; this script is the gate that stops a ticket from being closed with a claim only.

const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const registryPath = process.argv[2] || path.join(projectRoot, 'docs', 'evidence', '2026-11-25-windows-architecture-review-evidence.md')
const REQUIRED_P0 = ['D01', 'D02', 'C01', 'A01']

function fail(message) {
  console.error('check-review-evidence: ' + message)
  process.exitCode = 1
}

function parseRows(markdown) {
  const rows = []
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const match = /^\|\s*([A-Z]\d{2})\s*\|\s*(P[0-2])\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|$/.exec(line.trim())
    if (!match) continue
    const tests = match[4].split(',').map((item) => item.trim()).filter(Boolean)
    rows.push({ ticket: match[1], priority: match[2], status: match[3], tests, hardware: match[5] })
  }
  return rows
}

function main() {
  if (!fs.existsSync(registryPath)) {
    fail('registry not found: ' + path.relative(projectRoot, registryPath))
    return
  }
  const rows = parseRows(fs.readFileSync(registryPath, 'utf8'))
  if (!rows.length) {
    fail('registry has no ticket rows')
    return
  }
  const seen = new Set()
  for (const row of rows) {
    if (seen.has(row.ticket)) fail('duplicate ticket ' + row.ticket)
    seen.add(row.ticket)
    if (!row.tests.length) {
      fail(row.ticket + ' lists no regression test')
      continue
    }
    for (const relative of row.tests) {
      const file = path.join(projectRoot, relative)
      if (!fs.existsSync(file)) {
        fail(row.ticket + ' references a missing test: ' + relative)
        continue
      }
      const source = fs.readFileSync(file, 'utf8')
      // The ticket id may appear in a test name or in the comment that explains the rule;
      // either way the test file is traceable back to the ticket.
      if (!new RegExp('\\b' + row.ticket + '\\b').test(source)) {
        fail(row.ticket + ' is not mentioned by ' + relative)
      }
    }
  }
  for (const ticket of REQUIRED_P0) {
    if (!seen.has(ticket)) fail('required P0 ticket ' + ticket + ' is missing from the registry')
  }
  if (!process.exitCode) {
    console.log('check-review-evidence: ok (' + rows.length + ' tickets, ' + REQUIRED_P0.length + ' required P0)')
  }
}

main()

module.exports = { parseRows }
