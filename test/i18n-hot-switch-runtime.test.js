// Runtime coverage for the "language hot switch leaves stale copy" defect class
// (plan §23.4 / handoff §4.5). The shared checker and the data-i18n tests both merge
// every locale table, so neither can see copy that a script rendered from an
// already-translated sentence, or dynamic text on an element that also carries a
// static `data-i18n`. This test boots each window in a real Electron renderer with its
// real preload, emits the real `i18n:language` broadcast and compares the DOM.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const electronPath = require('electron')
const resultPrefix = 'HIGHLIGHTER_I18N_HOT_SWITCH_PROBE='

// `zh` may be null when the boot value is not pinned by the contract under test; the
// switch assertion (en) is always enforced, and `before !== after` is asserted too.
const expectations = {
  'search-ready': {
    zh: (tables) => ({ status: tables.zh['search.status.ready-version'].replace('{version}', '1.5') }),
    en: (tables) => ({ status: tables.en['search.status.ready-version'].replace('{version}', '1.5') })
  },
  'search-message-key': {
    zh: (tables) => ({ status: tables.zh['main.everything.unavailable'] }),
    en: (tables) => ({ status: tables.en['main.everything.unavailable'] })
  },
  'long-capture-status': {
    zh: (tables) => ({ status: tables.zh['long-capture.status.ready'] }),
    en: (tables) => ({ status: tables.en['long-capture.status.ready'] })
  },
  'record-audio-notice': {
    zh: (tables) => ({ status: `${tables.zh['record.status.recording']} · ${tables.zh['record.audio.notice.system-interrupted']}` }),
    en: (tables) => ({ status: `${tables.en['record.status.recording']} · ${tables.en['record.audio.notice.system-interrupted']}` })
  },
  'recognition-error-title': {
    zh: null,
    en: (tables) => ({ title: tables.en['recognition.error.title'] })
  },
  'action-header-explain': {
    zh: (tables) => ({ title: tables.zh['action.answer.label.explain'], loading: tables.zh['action.loading.thinking'] }),
    en: (tables) => ({ title: tables.en['action.answer.label.explain'], loading: tables.en['action.loading.thinking'] })
  }
}

test('every script-owned copy re-renders from the locale table after an i18n:language broadcast', { timeout: 120000 }, (t) => {
  const probeUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-i18n-hot-switch-'))
  t.after(() => fs.rmSync(probeUserData, { recursive: true, force: true }))

  const result = spawnSync(electronPath, [path.join(root, 'scripts', 'probe-i18n-hot-switch.js')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 100000,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: '0',
      HIGHLIGHTER_I18N_HOT_SWITCH_USER_DATA: probeUserData
    }
  })

  assert.equal(
    result.status,
    0,
    `i18n hot-switch probe failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  )
  const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith(resultPrefix))
  assert.ok(line, `i18n hot-switch probe returned no JSON.\nstdout:\n${result.stdout}`)
  const report = JSON.parse(line.slice(resultPrefix.length))

  assert.deepEqual(
    report.cases.map((entry) => entry.name),
    Object.keys(expectations),
    'probe cases'
  )

  for (const entry of report.cases) {
    const spec = expectations[entry.name]
    assert.equal(entry.afterLanguage, 'en-US', `${entry.name}: the broadcast reached the renderer`)
    if (spec.zh) {
      assert.equal(entry.beforeLanguage, 'zh-CN', `${entry.name}: the fresh boot language`)
      assert.deepEqual(entry.before, spec.zh(entry.tables), `${entry.name}: boot copy`)
    }
    assert.notDeepEqual(entry.before, entry.after, `${entry.name}: the broadcast changed the copy`)
    assert.deepEqual(entry.after, spec.en(entry.tables), `${entry.name}: copy after the en-US broadcast`)
  }
})

// The long-capture markup carries `data-i18n="long-capture.status.preparing"` on the
// same element the script writes: `applyTranslations()` must not win over the live
// status after the switch.
test('the long-capture live status survives applyTranslations on a language switch', { timeout: 120000 }, (t) => {
  const probeUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-i18n-hot-switch-'))
  t.after(() => fs.rmSync(probeUserData, { recursive: true, force: true }))

  const result = spawnSync(electronPath, [path.join(root, 'scripts', 'probe-i18n-hot-switch.js')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 100000,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: '0',
      HIGHLIGHTER_I18N_HOT_SWITCH_USER_DATA: probeUserData
    }
  })

  assert.equal(result.status, 0, `i18n hot-switch probe failed.\n${result.stderr}`)
  const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith(resultPrefix))
  assert.ok(line, 'i18n hot-switch probe returned no JSON')
  const report = JSON.parse(line.slice(resultPrefix.length))
  const entry = report.cases.find((item) => item.name === 'long-capture-status')
  assert.ok(entry, 'long-capture case present')
  assert.notEqual(
    entry.after.status,
    entry.tables.en['long-capture.status.preparing'],
    'the live status must not fall back to the static data-i18n text'
  )
})
