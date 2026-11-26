#!/usr/bin/env node
'use strict'

// D06 (docs/reviews/2026-11-24-windows-product-architecture-review.md): every ticket in the
// review must point at a regression test that lives in the repository, and every P0 must have
// at least one. The registry is a markdown table so it stays reviewable next to the review
// itself; this script is the gate that stops a ticket from being closed with a claim only.

const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
// Every review that ships with a ticket registry is checked. A new review only has to add an
// entry here; the CLI argument still overrides the list so a single registry can be inspected.
const REGISTRIES = [
  {
    path: path.join(projectRoot, 'docs', 'evidence', '2026-11-25-windows-architecture-review-evidence.md'),
    requiredP0: ['D01', 'D02', 'C01', 'A01']
  },
  {
    // H05: the 2026-11-26 full review. Same table shape, its own required P0 set.
    path: path.join(projectRoot, 'docs', 'evidence', '2026-11-26-review-optimization-evidence.md'),
    requiredP0: ['H01', 'H02', 'H03', 'H04', 'H05']
  }
]

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

function checkRegistry(registryPath, requiredP0) {
  const label = path.relative(projectRoot, registryPath).split(path.sep).join('/')
  if (!fs.existsSync(registryPath)) {
    fail('registry not found: ' + label)
    return 0
  }
  const rows = parseRows(fs.readFileSync(registryPath, 'utf8'))
  if (!rows.length) {
    fail(label + ' has no ticket rows')
    return 0
  }
  const seen = new Set()
  for (const row of rows) {
    if (seen.has(row.ticket)) fail(label + ': duplicate ticket ' + row.ticket)
    seen.add(row.ticket)
    if (!row.tests.length) {
      fail(label + ': ' + row.ticket + ' lists no regression test')
      continue
    }
    for (const relative of row.tests) {
      const file = path.join(projectRoot, relative)
      if (!fs.existsSync(file)) {
        fail(label + ': ' + row.ticket + ' references a missing test: ' + relative)
        continue
      }
      const source = fs.readFileSync(file, 'utf8')
      // The ticket id may appear in a test name or in the comment that explains the rule;
      // either way the test file is traceable back to the ticket.
      if (!new RegExp('\\b' + row.ticket + '\\b').test(source)) {
        fail(label + ': ' + row.ticket + ' is not mentioned by ' + relative)
      }
    }
  }
  for (const ticket of requiredP0) {
    if (!seen.has(ticket)) fail(label + ': required P0 ticket ' + ticket + ' is missing from the registry')
  }
  return rows.length
}

function main() {
  // A CLI argument still selects one registry (useful when adding a ticket), otherwise every
  // registered review is enforced.
  const single = process.argv[2]
  const registries = single
    ? [{
        path: path.resolve(single),
        requiredP0: (REGISTRIES.find((entry) => path.resolve(entry.path) === path.resolve(single)) || { requiredP0: [] }).requiredP0
      }]
    : REGISTRIES
  let totalTickets = 0
  let totalRequired = 0
  for (const registry of registries) {
    totalTickets += checkRegistry(registry.path, registry.requiredP0 || [])
    totalRequired += (registry.requiredP0 || []).length
  }
  if (!process.exitCode) {
    console.log(
      'check-review-evidence: ok (' + registries.length + ' registries, ' + totalTickets + ' tickets, ' +
      totalRequired + ' required P0)'
    )
  }
}

main()

module.exports = { parseRows }
