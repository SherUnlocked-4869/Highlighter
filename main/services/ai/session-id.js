'use strict'

const { randomUUID } = require('crypto')

// Stable per-launch session id. Coding plan providers that require a session
// header (OpenCode Go's x-opencode-session) reference it through the
// ${sessionId} placeholder, which stays unresolved on disk and rotates on every
// launch instead of freezing into the stored config (design D6 / §4.2).
let sessionId = randomUUID()

function getAiSessionId() {
  return sessionId
}

function resetAiSessionIdForTests(value = '') {
  sessionId = value || randomUUID()
  return sessionId
}

module.exports = {
  getAiSessionId,
  resetAiSessionIdForTests
}
