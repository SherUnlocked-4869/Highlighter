const test = require('node:test')
const assert = require('node:assert/strict')
const {
  NIGHTSHIFT_AMBER,
  LEGACY_MAIN_COLORS,
  migrateAppearanceSettings,
  resolveMainColor
} = require('../main/services/appearance-migration')

test('legacy Ant Design blue mainColor migrates to Nightshift amber', () => {
  for (const legacy of LEGACY_MAIN_COLORS) {
    const migration = migrateAppearanceSettings({ mainColor: legacy, theme: 'dark' })
    assert.equal(migration.changed, true)
    assert.equal(migration.settings.mainColor, NIGHTSHIFT_AMBER)
    assert.equal(migration.settings.theme, 'dark')
  }
})

test('custom non-legacy accent is preserved', () => {
  const migration = migrateAppearanceSettings({ mainColor: '#8b5cf6' })
  assert.equal(migration.changed, false)
  assert.equal(migration.settings.mainColor, '#8b5cf6')
})

test('resolveMainColor maps legacy accents and empty values to amber', () => {
  assert.equal(resolveMainColor('#1677ff'), NIGHTSHIFT_AMBER)
  assert.equal(resolveMainColor(''), NIGHTSHIFT_AMBER)
  assert.equal(resolveMainColor(undefined), NIGHTSHIFT_AMBER)
  assert.equal(resolveMainColor('#c45c26'), '#c45c26')
})

test('default accent constant matches the Nightshift design token', () => {
  assert.equal(NIGHTSHIFT_AMBER, '#e5a44c')
})
