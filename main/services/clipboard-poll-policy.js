'use strict'
// C03 (docs/reviews/2026-11-24-windows-product-architecture-review.md):
// the clipboard sidecar used to be polled every 2 s for as long as the feature
// was enabled, including hours with the panel hidden. Visibility and the
// backend's own health now decide the cadence. The decision lives here, as a
// pure function: the service owns timers and this file owns the numbers, so a
// test can walk the whole 30-minute budget in virtual time instead of waiting.

// Foreground cadence. Unchanged from the original fixed poll: a visible panel
// must reflect a copy within one screen refresh of the user noticing it.
const POLL_VISIBLE_MS = 2000
// Hidden, but the sidecar reported work in flight (a maintenance pass, a GC
// backlog) or the last status request failed. This is the bounded health check
// the review asks for: it keeps a fault observable within 5 s instead of hiding
// it behind the idle backoff.
const POLL_DEGRADED_MS = 5000
// Hidden and quiescent. 30 min / 30 s = 60 ordinary status requests, leaving the
// five-request margin the acceptance criterion allows for open/close and events.
const POLL_HIDDEN_STABLE_MS = 30000
// Events that must not wait for the next status check: child exit, coordination
// anomaly, migration and GC backlog. They ask for the check *now*, not in 30 s.
const POLL_IMMEDIATE_MS = 0
// Opening the panel must paint the current revision within this budget. A cached
// snapshot younger than this is reused; anything older triggers a status request
// before the panel is shown.
const POLL_REVISION_FRESH_MS = 300

// Mirrors the reasons ClipboardService.notifyHealth() accepts. An unknown reason
// is ignored rather than silently driving a request.
const HEALTH_EVENTS = Object.freeze(['child-exit', 'coordination', 'migration', 'gc-backlog'])

function isHealthEvent(reason) {
  return HEALTH_EVENTS.includes(reason)
}

// "Stable" is about the sidecar having nothing in flight, not about the history
// being unchanged: a hidden panel does not care that a copy bumped the revision,
// it refetches on open. Work in flight does care, because its result is exactly
// what the next check is watching for.
function pollIsStable({ maintenancePending = false, gcBacklog = false } = {}) {
  return maintenancePending !== true && gcBacklog !== true
}

// inputs: panel visibility, whether the backend is quiescent, whether the last
// check succeeded, and the one-shot event that triggered this scheduling round.
function nextPollDelay({ visible = false, stable = true, healthy = true, event = null } = {}) {
  if (isHealthEvent(event)) return POLL_IMMEDIATE_MS
  if (visible === true) return POLL_VISIBLE_MS
  if (healthy !== true) return POLL_DEGRADED_MS
  if (stable !== true) return POLL_DEGRADED_MS
  return POLL_HIDDEN_STABLE_MS
}

module.exports = {
  POLL_VISIBLE_MS,
  POLL_DEGRADED_MS,
  POLL_HIDDEN_STABLE_MS,
  POLL_IMMEDIATE_MS,
  POLL_REVISION_FRESH_MS,
  HEALTH_EVENTS,
  isHealthEvent,
  pollIsStable,
  nextPollDelay
}
