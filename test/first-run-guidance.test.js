'use strict'

// A06 (docs/reviews/2026-11-24-windows-product-architecture-review.md): first-run guidance.
//
// The settings window is a classic-script page with no module boundary, so this file
// checks the feature in two layers:
//   1. the settings contract (default, normalizer, patch template) in plain Node;
//   2. a vm harness that runs config/routes/home.js against a fake DOM and a fake
//      electronAPI, so the card's render condition and its three actions are exercised as
//      behaviour. The fake DOM implements only what the route touches
//      (querySelector[All] / innerHTML / dataset / onclick), which is itself a contract:
//      a route that starts reaching for more DOM API stops being covered here.
//
// Deliberately NOT covered: the real capture window. "Try a capture" only has to prove it
// calls the existing screenshot command - the capture pipeline has its own tests.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const { DEFAULT_SETTINGS } = require('../main/services/settings-defaults')
const { createSettingsNormalizer } = require('../main/services/settings-normalize')
const { assertSettingsPatch } = require('../main/services/settings-validation')

const ROOT = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')
const homeSource = read('config', 'routes', 'home.js')
const mainSource = read('main.js')

const HISTORY_DIRECTORY = 'C:/data/capture-history'
const LANGUAGES = ['zh-CN', 'en-US', 'zh-TW']
// The tables the home route resolves its copy from, in config.html order.
const LOCALE_SCRIPTS = ['zh-CN.js', 'en-US.js', 'zh-TW.js', 'config.js']

// --- settings contract -------------------------------------------------------

function normalizeWith(mutate = () => {}) {
  const settings = structuredClone(DEFAULT_SETTINGS)
  mutate(settings)
  return createSettingsNormalizer({ defaultHistoryDirectory: HISTORY_DIRECTORY })(settings)
}

test('the first-run flag ships off and is a whitelisted boolean', () => {
  assert.equal(DEFAULT_SETTINGS.system.firstRunGuidanceDone, false)
  // DEFAULT_SETTINGS is the patch template, so the write below must pass validation:
  // an unlisted key would be rejected with "unsupported settings item".
  assert.deepEqual(
    assertSettingsPatch({ system: { firstRunGuidanceDone: true } }, DEFAULT_SETTINGS),
    { system: { firstRunGuidanceDone: true } }
  )
  assert.throws(() => assertSettingsPatch({ system: { firstRunGuidanceDone: 'yes' } }, DEFAULT_SETTINGS), /类型无效/)
})

test('the normalizer keeps the flag a strict boolean, and a missing key reads as "not done"', () => {
  assert.equal(normalizeWith().system.firstRunGuidanceDone, false)
  assert.equal(normalizeWith((settings) => { settings.system.firstRunGuidanceDone = true }).system.firstRunGuidanceDone, true)
  for (const value of [1, 'yes', {}, null]) {
    assert.equal(
      normalizeWith((settings) => { settings.system.firstRunGuidanceDone = value }).system.firstRunGuidanceDone,
      false,
      `${JSON.stringify(value)} must not count as done`
    )
  }
  // A store written before this key existed has no key at all - that is the migration
  // case, and it must NOT be read as "already seen".
  assert.equal(normalizeWith((settings) => { delete settings.system.firstRunGuidanceDone }).system.firstRunGuidanceDone, false)
  // The neighbouring system switches stay untouched.
  assert.equal(normalizeWith((settings) => { settings.system.firstRunGuidanceDone = true }).system.autoCheckUpdates, false)
})

test('the copy exists in all three language tables', () => {
  globalThis.__LOCALES = {}
  for (const file of fs.readdirSync(path.join(ROOT, 'shared', 'locales')).filter((name) => name.endsWith('.js')).sort()) {
    const target = path.join(ROOT, 'shared', 'locales', file)
    delete require.cache[require.resolve(target)]
    require(target)
  }
  const keys = [
    'config.first-run.title',
    'config.first-run.description',
    'config.first-run.try-screenshot',
    'config.first-run.shortcuts',
    'config.first-run.usage-on',
    'config.first-run.usage-off',
    'config.first-run.usage-saved',
    'config.first-run.dismiss'
  ]
  for (const language of LANGUAGES) {
    for (const key of keys) {
      assert.equal(typeof globalThis.__LOCALES[language]?.[key], 'string', `${language} is missing ${key}`)
    }
  }
})

// --- fake DOM ----------------------------------------------------------------

function camelCase(name) {
  return name.replace(/-([a-z0-9])/g, (_, character) => character.toUpperCase())
}

function parseAttributes(text) {
  const attributes = {}
  if (!text) return attributes
  for (const match of text.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) {
    const name = match[1]
    if (!name || name === '/') continue
    attributes[name] = match[2] === undefined ? '' : match[2]
  }
  return attributes
}

function createFakeDom(language = 'zh-CN') {
  let elements = []
  const view = { attrs: { id: 'view' }, dataset: {}, _html: '' }

  function parse(html) {
    const parsed = []
    for (const match of String(html).matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b([^<>]*)>/g)) {
      const tagName = match[1].toLowerCase()
      if (tagName === 'script' || tagName === 'style') continue
      const attributes = parseAttributes(match[2])
      const dataset = {}
      for (const [name, value] of Object.entries(attributes)) {
        if (name.startsWith('data-')) dataset[camelCase(name.slice(5))] = value
      }
      parsed.push({
        tagName,
        attrs: attributes,
        dataset,
        focus() {},
        onclick: null
      })
    }
    return parsed
  }

  Object.defineProperty(view, 'innerHTML', {
    get() { return view._html },
    set(value) {
      view._html = String(value)
      elements = parse(view._html)
    }
  })

  function matches(selector, element) {
    const attributeMatch = selector.match(/^\[([a-zA-Z0-9-]+)(?:="([^"]*)")?\]$/)
    if (attributeMatch) {
      const [, name, value] = attributeMatch
      if (!Object.hasOwn(element.attrs, name)) return false
      return value === undefined || element.attrs[name] === value
    }
    throw new Error(`fake DOM does not support selector ${selector}`)
  }

  const document = {
    documentElement: { dataset: { language } },
    getElementById(id) { return elements.find((element) => element.attrs.id === id) || null },
    querySelector(selector) { return elements.find((element) => matches(selector, element)) || null },
    querySelectorAll(selector) { return elements.filter((element) => matches(selector, element)) }
  }

  return { document, view }
}

// --- shared helpers the route expects to find as globals ----------------------

const escapeHtml = (value) => String(value ?? '')
const iconMarkup = (iconPath) => `<span class="svg-icon" data-icon="${escapeHtml(iconPath)}"></span>`
const pageHeader = (title, description) => `<div class="page-head"><h1>${title}</h1><p>${description || ''}</p></div>`
const shortcutButton = (name, accelerator) => `<button data-shortcut="${name}">${accelerator || 'unset'}</button>`

function createHarness({ firstRunGuidanceDone = false, language = 'zh-CN' } = {}) {
  const dom = createFakeDom(language)
  const calls = { execute: [], settings: [] }
  const toasts = []
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.system.firstRunGuidanceDone = firstRunGuidanceDone

  function merge(target, patch) {
    for (const [key, value] of Object.entries(patch)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        target[key] = target[key] && typeof target[key] === 'object' ? target[key] : {}
        merge(target[key], value)
      } else target[key] = value
    }
    return target
  }

  const sandbox = {
    console,
    document: dom.document,
    view: dom.view,
    settings,
    iconMarkup,
    pageHeader,
    shortcutButton,
    errorMessage: (error) => String(error?.message || error || ''),
    toast: (message) => toasts.push(String(message)),
    prompt: () => '3',
    updateSettings: (patch, message) => {
      calls.settings.push(JSON.parse(JSON.stringify(patch)))
      merge(sandbox.settings, patch)
      if (message) toasts.push(String(message))
      return Promise.resolve(sandbox.settings)
    },
    refreshShortcutStatuses: () => Promise.resolve(),
    shortcutStatuses: {},
    currentRoute: 'home'
  }
  sandbox.window = sandbox
  sandbox.window.electronAPI = {
    // "Try a capture" is the one action that goes through the preload API; the settings
    // writes go through the shared updateSettings() helper stubbed above.
    executeFunction: (name, payload) => {
      calls.execute.push([name, payload])
      return Promise.resolve({ ok: true })
    }
  }
  // home.js resolves shortcut presentation through window.shortcutKeys; the recorders are
  // only bound, never clicked here, so the object stays inert.
  sandbox.window.shortcutKeys = {
    isIgnoredRecordingEvent: () => false,
    isModifierOnlyKey: () => false,
    acceleratorFromKeyboardEvent: () => '',
    isRecordableShortcut: () => false,
    describeShortcutRejection: () => ''
  }
  const context = vm.createContext(sandbox)
  for (const file of LOCALE_SCRIPTS) {
    vm.runInContext(read('shared', 'locales', file), context, { filename: `shared/locales/${file}` })
  }
  vm.runInContext(read('shared', 'i18n.js'), context, { filename: 'shared/i18n.js' })
  vm.runInContext(homeSource, context, { filename: 'config/routes/home.js' })

  return {
    dom,
    calls,
    toasts,
    run: (code) => vm.runInContext(code, context),
    render() { vm.runInContext('renderHome()', context) },
    async settle(rounds = 8) {
      for (let index = 0; index < rounds; index++) await new Promise((resolve) => setImmediate(resolve))
    },
    button(action) {
      const element = dom.document.querySelector(`[data-first-run="${action}"]`)
      assert.ok(element, `the "${action}" action is rendered`)
      assert.equal(typeof element.onclick, 'function', `the "${action}" action is wired`)
      return element
    }
  }
}

// --- behaviour: rendering ----------------------------------------------------

test('the card renders on the landing tab while the guidance has not been completed', () => {
  const harness = createHarness()
  harness.render()
  const html = harness.dom.view.innerHTML
  assert.match(html, /data-testid="first-run-guidance"/)
  // The three actions plus the skip entry, all labelled through the table.
  for (const action of ['try-screenshot', 'shortcuts', 'usage-on', 'usage-off', 'dismiss']) {
    assert.match(html, new RegExp(`data-first-run="${action}"`), `${action} is rendered`)
  }
  const zhTitle = harness.run("t('config.first-run.title')")
  assert.ok(html.includes(zhTitle), 'the title comes from the table')
  assert.ok(!html.includes('config.first-run.title'), 'no locale key leaks into the markup')
})

test('the card is skipped once the flag is true', () => {
  const harness = createHarness({ firstRunGuidanceDone: true })
  harness.render()
  assert.doesNotMatch(harness.dom.view.innerHTML, /data-testid="first-run-guidance"/)
  // The page itself still renders.
  assert.match(harness.dom.view.innerHTML, /data-home-tab="screenshot"/)
})

test('the card belongs to the landing tab and never follows the user to the shortcuts tab', () => {
  const harness = createHarness()
  harness.render()
  assert.match(harness.dom.view.innerHTML, /data-testid="first-run-guidance"/)
  harness.dom.document.querySelector('[data-home-tab="shortcuts"]').onclick()
  assert.doesNotMatch(harness.dom.view.innerHTML, /data-testid="first-run-guidance"/)
  assert.match(harness.dom.view.innerHTML, /data-home-tab="shortcuts" aria-pressed="true"/)
})

test('the copy follows the interface language on the next render', () => {
  const harness = createHarness()
  harness.render()
  const zhTitle = harness.run("t('config.first-run.title')")
  assert.ok(harness.dom.view.innerHTML.includes(zhTitle))
  harness.run("setLanguage('en-US')")
  harness.render()
  const enTitle = harness.run("t('config.first-run.title')")
  assert.notEqual(enTitle, zhTitle)
  assert.ok(harness.dom.view.innerHTML.includes(enTitle))
  assert.doesNotMatch(harness.dom.view.innerHTML, new RegExp(zhTitle), 'the previous language is gone')
})

// --- behaviour: the three actions -------------------------------------------

test('"try a capture" runs the existing screenshot command and leaves the card in place', async () => {
  const harness = createHarness()
  harness.render()
  harness.button('try-screenshot').onclick()
  await harness.settle()
  assert.deepEqual(harness.calls.execute, [['screenshot', undefined]])
  assert.deepEqual(harness.calls.settings, [], 'trying a capture does not silently dismiss the card')
  assert.match(harness.dom.view.innerHTML, /data-testid="first-run-guidance"/)
})

test('"set up shortcuts" moves to the shortcuts tab of the same route', async () => {
  const harness = createHarness()
  harness.render()
  harness.button('shortcuts').onclick()
  await harness.settle()
  assert.equal(harness.calls.settings.length, 0)
  assert.match(harness.dom.view.innerHTML, /data-home-tab="shortcuts" aria-pressed="true"/)
  assert.doesNotMatch(harness.dom.view.innerHTML, /data-testid="first-run-guidance"/)
})

test('the usage answer writes usage.enabled and completes the guidance', async () => {
  for (const [action, enabled] of [['usage-on', true], ['usage-off', false]]) {
    const harness = createHarness()
    harness.render()
    harness.button(action).onclick()
    await harness.settle()
    assert.deepEqual(harness.calls.settings, [{ usage: { enabled }, system: { firstRunGuidanceDone: true } }], action)
    assert.equal(harness.run('settings.usage.enabled'), enabled)
    assert.equal(harness.run('settings.system.firstRunGuidanceDone'), true)
    assert.deepEqual(harness.toasts, [harness.run("t('config.first-run.usage-saved')")])
    assert.doesNotMatch(harness.dom.view.innerHTML, /data-testid="first-run-guidance"/)
    // And the answer is persisted through the existing settings writer, never a bespoke
    // channel: home.js calls updateSettings(), the same helper every other route uses.
    assert.equal(harness.calls.execute.length, 0)
  }
})

test('"do not show again" is a skip: it completes the guidance and touches nothing else', async () => {
  const harness = createHarness()
  harness.render()
  harness.button('dismiss').onclick()
  await harness.settle()
  assert.deepEqual(harness.calls.settings, [{ system: { firstRunGuidanceDone: true } }])
  assert.equal(harness.run('settings.usage.enabled'), false, 'the usage default is untouched')
  assert.deepEqual(harness.toasts, [], 'the card disappearing is the feedback')
  assert.doesNotMatch(harness.dom.view.innerHTML, /data-testid="first-run-guidance"/)
})

// --- wiring: only a manual launch can ever render the card --------------------

test('a login launch still starts to the tray and therefore never renders the guidance', () => {
  // Evidence, at the wiring level: main.js only creates the first window when the launch
  // is NOT the login item, and the card is rendered by the home route itself - there is no
  // timer, marker file or tray surface that could show it on the start-to-tray path.
  assert.match(mainSource, /const startToTray = isStartToTrayLaunch\(process\.argv, \{ e2e: e2eContext\.enabled \}\)/)
  assert.match(mainSource, /if \(!startToTray\) createMainWindow\('home'\)/)
  assert.match(homeSource, /function firstRunGuidancePending\(\) \{/)
  assert.match(homeSource, /settings\?\.system\?\.firstRunGuidanceDone !== true/)
  // The condition is evaluated at render time, so the tray-only path cannot reach it.
  assert.match(homeSource, /const firstRunCard = homeTab === 'screenshot' && firstRunGuidancePending\(\)/)
  // And no other window owns the card.
  assert.doesNotMatch(read('config', 'config.js'), /firstRunGuidance/)
})
