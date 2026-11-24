'use strict'

// B06: a fast save may never overwrite an existing file. The dialog path keeps its overwrite
// confirmation semantics, but the no-dialog path has to create a NEW name atomically, and a
// concurrent writer that wins the race must not be clobbered either. COPYFILE_EXCL gives the
// first writer the name; every loser retries with a numbered suffix.

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const MAX_SUFFIX = 9999

function suffixedPath(target, attempt) {
  const parsed = path.parse(target)
  return path.join(parsed.dir, `${parsed.name} (${attempt})${parsed.ext}`)
}

// Copies `source` to `target` without ever replacing an existing file; on a name collision it
// retries with ' (1)', ' (2)', ... and returns the path it actually wrote.
async function copyExclusive(source, target, { maxAttempts = MAX_SUFFIX } = {}) {
  const destination = path.resolve(String(target || ''))
  if (!destination) throw new Error('Long capture save target is required')
  let lastError = null
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const candidate = attempt === 0 ? destination : suffixedPath(destination, attempt)
    try {
      await fsp.copyFile(source, candidate, fs.constants.COPYFILE_EXCL)
      return candidate
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      lastError = error
    }
  }
  const error = new Error('Unable to choose a unique long-capture file name')
  error.code = 'EEXIST'
  error.cause = lastError
  throw error
}

module.exports = { copyExclusive, suffixedPath, MAX_SUFFIX }
