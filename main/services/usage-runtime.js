// Tiny registry for the usage feature.
//
// The data-root domain has to quiesce the usage SQLite writer before a data-root
// migration, but main.js assembles the usage feature after the domain object is
// created. A module-level registry keeps that dependency direction-free so the
// feature can be wired with the one main.js line the architecture gate budget
// allows (see docs/plans/2026-10-21-tokentracker-usage-page-development-plan.md
// §2.9 G1).
//
// main.js calls setActiveUsageFeature(); the data-root domain only ever reads it
// through getActiveUsageFeature() and tolerates null (feature not assembled yet,
// disabled, or fully shut down).

let activeFeature = null

function setActiveUsageFeature(feature) {
  activeFeature = feature && typeof feature === 'object' ? feature : null
}

function getActiveUsageFeature() {
  return activeFeature
}

module.exports = {
  setActiveUsageFeature,
  getActiveUsageFeature
}
