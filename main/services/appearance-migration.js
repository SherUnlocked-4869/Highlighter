/*
 * Nightshift appearance migration.
 *
 * Before the UI-language redesign the default accent was Ant Design blue
 * (#1677ff). That value was persisted into settings.mainColor on every machine
 * that ran the app, so a code-only default change cannot help those users:
 * switches, primary buttons and checkboxes keep painting blue.
 *
 * Remap only the known pre-redesign accents. A user who picked some other
 * custom hue keeps it.
 */

const NIGHTSHIFT_AMBER = '#e5a44c'

const LEGACY_MAIN_COLORS = new Set([
  '#1677ff',
  '#1687ff',
  '#1890ff'
])

function normalizeHexColor(value) {
  const raw = String(value || '').trim().toLowerCase()
  return /^#[0-9a-f]{6}$/.test(raw) ? raw : ''
}

function migrateAppearanceSettings(settings) {
  const source = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {}
  const current = normalizeHexColor(source.mainColor)
  if (!LEGACY_MAIN_COLORS.has(current)) return { settings: source, changed: false }
  return {
    settings: { ...source, mainColor: NIGHTSHIFT_AMBER },
    changed: true
  }
}

function resolveMainColor(value) {
  const current = normalizeHexColor(value)
  if (!current) return NIGHTSHIFT_AMBER
  return LEGACY_MAIN_COLORS.has(current) ? NIGHTSHIFT_AMBER : current
}

module.exports = {
  NIGHTSHIFT_AMBER,
  LEGACY_MAIN_COLORS,
  migrateAppearanceSettings,
  resolveMainColor
}
