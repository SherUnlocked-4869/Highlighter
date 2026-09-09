const fs = require('fs')

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true })
  return directory
}

module.exports = { ensureDirectory }
