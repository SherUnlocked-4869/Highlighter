'use strict'

// A06 (docs/reviews/2026-11-24-windows-product-architecture-review.md): the tray is a
// two-level menu. This file pins the new shape as behaviour, not as string matches:
//   * the five everyday tasks stay on the top level, with the live-capture safety
//     entries at the very top (A01) and the long tail inside two submenus;
//   * a disabled clipboard feature stays visible, says how to enable itself, and has a
//     dedicated settings entry right below it;
//   * the copy resolves through the shared table in every language, so a language switch
//     plus the caller's rebuild is enough.
// The labels below are resolved through t() rather than written as literals: the table is
// the single source of the copy, and the language round-trip at the end proves it moves.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { buildTrayMenuTemplate } = require('../main/services/tray-menu')
const { t, registerLocales, setLanguage, currentLanguage } = require('../main/services/i18n-bootstrap')

registerLocales()
const label = (key, params) => t(key, params)
const LANGUAGES = ['zh-CN', 'en-US', 'zh-TW']

function withLanguage(language, run) {
  const previous = currentLanguage()
  setLanguage(language)
  try {
    return run()
  } finally {
    setLanguage(previous)
  }
}

function createMenu(gameMode, { hasConversation = true, ...options } = {}, recording = null) {
  const calls = []
  const template = buildTrayMenuTemplate({
    gameMode,
    hasConversation,
    screenshotAccelerator: 'F1',
    ...options,
    recording,
    executeFunction: (name) => calls.push(['execute', name]),
    setGameModeEnabled: (enabled) => calls.push(['game-mode', enabled]),
    openHistory: () => calls.push(['history']),
    openMainWindow: () => calls.push(['main']),
    showConversation: () => calls.push(['conversation']),
    quit: () => calls.push(['quit'])
  })
  return { calls, template }
}

// Top-level only: the hierarchy is part of the contract, so a test that means "the first
// screen" must never accidentally match an entry that moved into a submenu.
function topLevel(template, key, params) {
  return template.find((item) => item.label === label(key, params))
}

function submenu(template, key) {
  const parent = topLevel(template, key)
  assert.ok(parent, `the "${key}" entry exists on the top level`)
  assert.ok(Array.isArray(parent.submenu), `the "${key}" entry opens a submenu`)
  return parent.submenu
}

function submenuItem(template, submenuKey, key, params) {
  const item = submenu(template, submenuKey).find((entry) => entry.label === label(key, params))
  assert.ok(item, `the "${key}" entry lives in the "${submenuKey}" submenu`)
  return item
}

function visibleLabels(items) {
  return items.filter((item) => typeof item.label === 'string').map((item) => item.label)
}

test('the top level keeps the everyday tasks and hides the long tail in submenus', () => {
  const { template } = createMenu(false, { clipboardEnabled: true })
  assert.deepEqual(visibleLabels(template), [
    label('main.tray.screenshot'),
    label('main.tray.recording-workbench'),
    label('clipboard.title'),
    label('main.tray.more-screenshot-modes'),
    label('main.tray.tools'),
    label('main.tray.game-mode'),
    label('main.tray.capture-history'),
    label('main.tray.show-main-window'),
    label('main.tray.quit')
  ])
  const screenshot = topLevel(template, 'main.tray.screenshot')
  assert.equal(screenshot.enabled, true)
  assert.equal(screenshot.accelerator, 'F1')

  // The moved entries are gone from the first screen; they exist exactly once, inside
  // their new parent.
  for (const key of [
    'main.tray.screenshot-full-screen',
    'main.tray.screenshot-focused-window',
    'main.tray.pin-image',
    'main.tray.local-search',
    'main.tray.exit-all-click-through',
    'main.tray.show-selection-chat'
  ]) assert.equal(template.some((item) => item.label === label(key)), false, `${key} moved into a submenu`)
  for (const key of ['main.tray.more-screenshot-modes', 'main.tray.tools']) {
    assert.equal(template.filter((item) => item.label === label(key)).length, 1, `${key} appears once`)
  }
  // Two separators keep the groups readable: tools | mode switch + windows | quit.
  assert.equal(template.filter((item) => item.type === 'separator').length, 2)
})

test('the capture submenu carries the other screenshot modes', () => {
  const { calls, template } = createMenu(false, { clipboardEnabled: true })
  const modes = submenu(template, 'main.tray.more-screenshot-modes')
  assert.deepEqual(visibleLabels(modes), [
    label('main.tray.screenshot-full-screen'),
    label('main.tray.screenshot-focused-window'),
    label('main.tray.screenshot-long'),
    label('main.tray.screenshot-delay')
  ])
  for (const item of modes) assert.equal(item.enabled, true)
  for (const item of modes) item.click()
  assert.deepEqual(calls, [
    ['execute', 'screenshotFullScreen'],
    ['execute', 'screenshotFocusedWindow'],
    ['execute', 'screenshotLong'],
    ['execute', 'screenshotDelay']
  ])
  // The fullscreen quick start still has no row of its own.
  assert.equal(template.some((item) => item.label === label('main.tray.video-record')), false)
})

test('the tools submenu groups the low-frequency entries and keeps the recovery entries usable', () => {
  const { calls, template } = createMenu(false, {
    clipboardEnabled: true,
    translationProxy: { running: true, busy: false },
    setTranslationProxyEnabled: (enabled) => calls.push(['proxy', enabled]),
    recentExport: { resultId: 'r1', fileName: 'Highlighter_2026-10-25.png', kind: 'png' },
    openRecentExport: (receipt) => calls.push(['recent', receipt.resultId])
  })
  const tools = submenu(template, 'main.tray.tools')
  assert.deepEqual(visibleLabels(tools), [
    label('main.tray.local-search'),
    label('main.tray.pin-image'),
    label('main.tray.translation-proxy'),
    label('main.tray.exit-all-click-through'),
    label('main.tray.show-selection-chat'),
    label('main.tray.recent-export', { fileName: 'Highlighter_2026-10-25.png' })
  ])
  // The bulk click-through exit and the conversation/summon entries sit in their own
  // group, below the tool toggles.
  const exitIndex = tools.findIndex((item) => item.label === label('main.tray.exit-all-click-through'))
  assert.equal(tools[exitIndex - 1].type, 'separator')

  tools.find((item) => item.label === label('main.tray.local-search')).click()
  tools.find((item) => item.label === label('main.tray.pin-image')).click()
  tools.find((item) => item.label === label('main.tray.exit-all-click-through')).click()
  tools.find((item) => item.label === label('main.tray.show-selection-chat')).click()
  tools.find((item) => item.label === label('main.tray.recent-export', { fileName: 'Highlighter_2026-10-25.png' })).click()
  assert.deepEqual(calls, [
    ['execute', 'localSearch'],
    ['execute', 'fixedContent'],
    // No exitClickThrough handler was injected, so this is the router fallback.
    ['execute', 'togglePinClickThrough'],
    ['conversation'],
    ['recent', 'r1']
  ])
})

test('the click-through exit prefers the injected domain handler', () => {
  const calls = []
  const template = buildTrayMenuTemplate({
    exitClickThrough: () => calls.push(['exit-all']),
    executeFunction: (name) => calls.push(['execute', name]),
    setGameModeEnabled: () => {},
    openHistory: () => {},
    openMainWindow: () => {},
    showConversation: () => {},
    quit: () => {}
  })
  submenuItem(template, 'main.tray.tools', 'main.tray.exit-all-click-through').click()
  assert.deepEqual(calls, [['exit-all']])
})

test('A06: a disabled clipboard stays visible, explains itself and offers the settings page', () => {
  // Disabled: the label carries the "enable in Settings" hint because Electron's
  // sublabel/toolTip fields are macOS-only on this version, and the entry stays visible
  // so the feature does not look missing.
  const disabledCalls = []
  const disabled = buildTrayMenuTemplate({
    clipboardEnabled: false,
    openClipboardSettings: () => disabledCalls.push(['clipboard-settings']),
    executeFunction: (name) => disabledCalls.push(['execute', name]),
    setGameModeEnabled: () => {},
    openHistory: () => {},
    openMainWindow: () => disabledCalls.push(['main']),
    showConversation: () => {},
    quit: () => {}
  })
  const historyEntry = disabled.find((item) => item.label === label('main.tray.clipboard-disabled'))
  assert.ok(historyEntry, 'the disabled clipboard entry is still listed')
  assert.equal(historyEntry.enabled, false)
  assert.notEqual(label('main.tray.clipboard-disabled'), label('clipboard.title'))
  assert.match(label('main.tray.clipboard-disabled'), new RegExp(label('clipboard.title'), 'u'), 'the hint keeps the feature name')

  const settingsEntry = disabled.find((item) => item.label === label('main.tray.open-clipboard-settings'))
  assert.ok(settingsEntry, 'a dedicated settings entry sits next to it')
  assert.equal(settingsEntry.enabled, undefined, 'the settings entry is never greyed out')
  assert.equal(disabled.indexOf(settingsEntry), disabled.indexOf(historyEntry) + 1, 'directly below the disabled entry')
  settingsEntry.click()
  assert.deepEqual(disabledCalls, [['clipboard-settings']])

  // Without a route-aware opener the entry still opens the main window (whose navigation
  // owns the clipboard page) instead of being a dead click.
  const fallbackCalls = []
  const fallback = buildTrayMenuTemplate({
    clipboardEnabled: false,
    executeFunction: () => {},
    setGameModeEnabled: () => {},
    openHistory: () => {},
    openMainWindow: () => fallbackCalls.push(['main']),
    showConversation: () => {},
    quit: () => {}
  })
  fallback.find((item) => item.label === label('main.tray.open-clipboard-settings')).click()
  assert.deepEqual(fallbackCalls, [['main']])

  // Enabled: the plain label, an active entry and no redundant settings row.
  const enabledCalls = []
  const enabled = buildTrayMenuTemplate({
    clipboardEnabled: true,
    executeFunction: (name) => enabledCalls.push(['execute', name]),
    setGameModeEnabled: () => {},
    openHistory: () => {},
    openMainWindow: () => {},
    showConversation: () => {},
    quit: () => {}
  })
  const active = enabled.find((item) => item.label === label('clipboard.title'))
  assert.ok(active)
  assert.equal(active.enabled, true)
  assert.equal(enabled.some((item) => item.label === label('main.tray.open-clipboard-settings')), false)
  active.click()
  assert.deepEqual(enabledCalls, [['execute', 'openClipboardHistory']])
})

test('the recording workbench entry opens the workbench and keeps the fullscreen quick start out of the menu', () => {
  // Without a recording domain the entry falls back to the router name, exactly like the other
  // summon entries.
  const viaRouter = createMenu(false)
  const entry = topLevel(viaRouter.template, 'main.tray.recording-workbench')
  assert.ok(entry, 'the workbench entry exists')
  entry.click()
  assert.deepEqual(viaRouter.calls, [['execute', 'openRecording']])

  // With a recording domain the entry calls the domain directly (no router round-trip).
  const calls = []
  const direct = createMenu(false, {}, { openWorkbench: () => calls.push(['open']) })
  topLevel(direct.template, 'main.tray.recording-workbench').click()
  assert.deepEqual(calls, [['open']])
})

test('tray menu exposes pause/finish only while a recording is active', () => {
  const idle = createMenu(false, {}, { active: null })
  assert.equal(idle.template.some((item) => item.label === label('main.tray.recording-pause')), false)
  assert.equal(idle.template.some((item) => item.label === label('main.tray.recording-finish')), false)
  assert.equal(idle.template[0].label, label('main.tray.screenshot'), 'an idle menu starts with the region capture')

  const calls = []
  const recording = {
    active: { status: 'recording', elapsedMs: 1200, microphoneMuted: false },
    pauseResume: () => calls.push(['pause-resume']),
    finish: () => calls.push(['finish'])
  }
  const active = createMenu(false, {}, recording)
  const pause = active.template.find((item) => item.label === label('main.tray.recording-pause'))
  const finish = active.template.find((item) => item.label === label('main.tray.recording-finish'))
  assert.ok(pause, 'a recording session offers pause')
  assert.ok(finish, 'a recording session offers finish')
  pause.click()
  finish.click()
  assert.deepEqual(calls, [['pause-resume'], ['finish']])

  const paused = createMenu(false, {}, { active: { status: 'paused' } })
  assert.ok(paused.template.find((item) => item.label === label('main.tray.recording-resume')), 'a paused capture offers resume')
  assert.equal(paused.template.some((item) => item.label === label('main.tray.recording-pause')), false)
})

test('A01: finish and pause lead the menu, and game mode keeps them usable', () => {
  // The control bar can be covered by a fullscreen game, and game mode suspends the
  // hotkeys, so these two entries must not follow the summon entries' gate. A06 also puts
  // them first: a capture in progress outranks every summon action.
  const calls = []
  const { template } = createMenu(true, {}, {
    active: { status: 'recording', elapsedMs: 4000 },
    pauseResume: () => calls.push(['pause-resume']),
    finish: () => calls.push(['finish'])
  })
  assert.equal(template[0].label, label('main.tray.recording-finish'), 'finish is the first item')
  assert.equal(template[1].label, label('main.tray.recording-pause'), 'pause comes second')
  assert.equal(template[2].type, 'separator', 'the live group closes with a separator')
  assert.equal(template[0].enabled, true)
  assert.equal(template[1].enabled, true)
  template[0].click()
  template[1].click()
  assert.deepEqual(calls, [['finish'], ['pause-resume']])

  // The summon entries still obey game mode, including starting a NEW capture and the
  // moved capture modes.
  assert.equal(topLevel(template, 'main.tray.screenshot').enabled, false)
  assert.equal(topLevel(template, 'main.tray.recording-workbench').enabled, false)
  assert.equal(topLevel(template, 'main.tray.more-screenshot-modes').enabled, false)
  for (const item of submenu(template, 'main.tray.more-screenshot-modes')) assert.equal(item.enabled, false, item.label)
  // The tools parent stays open: the click-through exit and the proxy toggle are recovery
  // entries, not summon actions.
  assert.equal(topLevel(template, 'main.tray.tools').enabled, true)
  assert.equal(submenuItem(template, 'main.tray.tools', 'main.tray.exit-all-click-through').enabled, true)
  assert.equal(submenuItem(template, 'main.tray.tools', 'main.tray.local-search').enabled, false)

  const paused = createMenu(true, {}, { active: { status: 'paused' } }).template
  assert.equal(paused[0].label, label('main.tray.recording-finish'))
  assert.equal(paused[0].enabled, true)
  assert.equal(paused[1].label, label('main.tray.recording-resume'))
  assert.equal(paused[1].enabled, true)
  // The live group is the only separator source when a capture is running: three groups.
  assert.equal(paused.filter((item) => item.type === 'separator').length, 3)
})

test('tray live recording entries fall back to the router names', () => {
  const menu = createMenu(false, {}, { active: { status: 'paused' } })
  menu.template.find((item) => item.label === label('main.tray.recording-resume')).click()
  menu.template.find((item) => item.label === label('main.tray.recording-finish')).click()
  assert.deepEqual(menu.calls, [['execute', 'recordPauseResume'], ['execute', 'recordFinish']])
})

test('tray menu only offers the result window while a conversation is alive', () => {
  const menu = createMenu(false)
  const item = submenuItem(menu.template, 'main.tray.tools', 'main.tray.show-selection-chat')
  assert.equal(item.visible, true)
  assert.equal(item.enabled, true)
  item.click()
  assert.deepEqual(menu.calls, [['conversation']])

  const hidden = submenuItem(createMenu(false, { hasConversation: false }).template, 'main.tray.tools', 'main.tray.show-selection-chat')
  assert.equal(hidden.visible, false)
})

test('tray menu summons the conversation from a game-mode session as disabled', () => {
  // A hidden window is not reachable by a new selection without discarding the
  // conversation, so the entry exists but respects game mode like the others.
  const item = submenuItem(createMenu(true).template, 'main.tray.tools', 'main.tray.show-selection-chat')
  assert.equal(item.visible, true)
  assert.equal(item.enabled, false)
})

test('tray menu refuses to build without a conversation handler', () => {
  const base = {
    executeFunction: () => {},
    setGameModeEnabled: () => {},
    openHistory: () => {},
    openMainWindow: () => {},
    quit: () => {}
  }
  assert.throws(() => buildTrayMenuTemplate(base), /showConversation/)
})

test('the proxy bridge entry needs both the state and the handler', () => {
  // Backwards compatibility: every caller and test that predates the proxy builds
  // the template without the dependency, and a required argument would throw.
  const withoutState = createMenu(false, { clipboardEnabled: true })
  assert.equal(submenu(withoutState.template, 'main.tray.tools').some((item) => item.label === label('main.tray.translation-proxy')), false)

  const stateOnly = createMenu(false, { translationProxy: { running: false, busy: false } })
  assert.equal(submenu(stateOnly.template, 'main.tray.tools').some((item) => item.label === label('main.tray.translation-proxy')), false)

  const handlerOnly = createMenu(false, { setTranslationProxyEnabled: () => {} })
  assert.equal(submenu(handlerOnly.template, 'main.tray.tools').some((item) => item.label === label('main.tray.translation-proxy')), false)
})

test('the proxy bridge entry toggles the service and mirrors its state', () => {
  const calls = []
  const { template } = createMenu(false, {
    translationProxy: { running: false, busy: false },
    setTranslationProxyEnabled: (enabled) => calls.push(['proxy', enabled])
  })
  const entry = submenuItem(template, 'main.tray.tools', 'main.tray.translation-proxy')
  assert.equal(entry.type, 'checkbox')
  assert.equal(entry.checked, false)
  assert.equal(entry.enabled, true)
  entry.click()
  assert.deepEqual(calls, [['proxy', true]])

  const running = submenuItem(createMenu(false, {
    translationProxy: { running: true, busy: false },
    setTranslationProxyEnabled: (enabled) => calls.push(['proxy', enabled])
  }).template, 'main.tray.tools', 'main.tray.translation-proxy')
  assert.equal(running.checked, true)
  running.click()
  assert.deepEqual(calls, [['proxy', true], ['proxy', false]])
})

test('the proxy bridge entry is disabled while a transition is in flight and survives game mode', () => {
  const busy = submenuItem(createMenu(false, {
    translationProxy: { running: false, busy: true },
    setTranslationProxyEnabled: () => {}
  }).template, 'main.tray.tools', 'main.tray.translation-proxy')
  assert.equal(busy.enabled, false)

  // A local HTTP service cannot interfere with a game, so - unlike the capture
  // entries - this one stays enabled in game mode.
  const gameMode = submenuItem(createMenu(true, {
    translationProxy: { running: true, busy: false },
    setTranslationProxyEnabled: () => {}
  }).template, 'main.tray.tools', 'main.tray.translation-proxy')
  assert.equal(gameMode.enabled, true)
  assert.equal(gameMode.checked, true)
})

test('the game mode switch stays on the first screen and mirrors the state', () => {
  const enabled = createMenu(false)
  const toggle = topLevel(enabled.template, 'main.tray.game-mode')
  assert.equal(toggle.type, 'checkbox')
  assert.equal(toggle.checked, false)
  toggle.click()
  assert.deepEqual(enabled.calls, [['game-mode', true]])

  const disabled = createMenu(true)
  assert.equal(topLevel(disabled.template, 'main.tray.game-mode').checked, true)
  topLevel(disabled.template, 'main.tray.game-mode').click()
  assert.deepEqual(disabled.calls, [['game-mode', false]])
})

test('A06: every label moves with the interface language', () => {
  const keys = ['main.tray.screenshot', 'main.tray.more-screenshot-modes', 'main.tray.tools', 'main.tray.clipboard-disabled', 'main.tray.open-clipboard-settings', 'main.tray.quit']
  const rendered = new Map()
  for (const language of LANGUAGES) {
    const labels = withLanguage(language, () => {
      const { template } = createMenu(false, { clipboardEnabled: false })
      return {
        top: visibleLabels(template),
        capture: visibleLabels(submenu(template, 'main.tray.more-screenshot-modes')),
        tools: visibleLabels(submenu(template, 'main.tray.tools')),
        expected: keys.map((key) => label(key))
      }
    })
    // Reopening the menu rebuilds the template from the (now switched) table: every key
    // is present verbatim, never the fallback key itself.
    for (const value of labels.expected) {
      assert.ok(labels.top.includes(value) || labels.capture.includes(value) || labels.tools.includes(value), `${language}: "${value}" is rendered`)
    }
    for (const value of [...labels.top, ...labels.capture, ...labels.tools]) {
      assert.doesNotMatch(value, /^(main|clipboard|config)\./, `${language}: "${value}" fell back to its key`)
    }
    rendered.set(language, labels)
  }
  // Three distinct sets: the copy really changed, not just the table lookup.
  assert.notDeepEqual(rendered.get('zh-CN').top, rendered.get('en-US').top)
  assert.notDeepEqual(rendered.get('en-US').top, rendered.get('zh-TW').top)
  assert.equal(rendered.get('zh-CN').top.length, rendered.get('en-US').top.length)
  assert.equal(rendered.get('zh-CN').top.length, rendered.get('zh-TW').top.length)
})

test('the menu source carries no copy of its own', () => {
  // The tray labels are table entries. A CJK literal (or a duplicated table value) in the
  // module would drift from the three language tables; the i18n gate cannot see a string
  // that is built at runtime, so this is the cheap invariant.
  const source = fs.readFileSync(path.join(__dirname, '..', 'main', 'services', 'tray-menu.js'), 'utf8')
  assert.doesNotMatch(source, /[\u4e00-\u9fff]/, 'tray-menu.js must not hard-code CJK copy')
})

// ---------------------------------------------------------------------------
// A07/D05 (plan items 14 and 18): the tray reflects pin layout changes and the
// retained-pin recovery submenu.
// ---------------------------------------------------------------------------

test('A07 (14): the tray template is rebuilt from the live pin layout, not a cached snapshot', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  // Both notifications the pin domain exposes are wired to the same rebuild.
  assert.match(main, /onPinLayoutChange: \(\) => createTrayIcon\(\)/)
  assert.match(main, /onRecoverableChange: \(\) => createTrayIcon\(\)/)
  // H05: the menu body moved to main/domains/tray. The assembly still hands over the live pin
  // domain as a resolver, and the tray reads the CURRENT layout / retained pins on every build.
  const tray = fs.readFileSync(path.join(__dirname, '..', 'main', 'domains', 'tray', 'index.js'), 'utf8')
  assert.match(main, /getPinDomain: \(\) => pinDomain/)
  assert.match(tray, /const pinDomain = getPinDomain\(\)/)
  assert.match(tray, /pinnedDisplays: pinDomain\.listPinsByDisplay\(\)/)
  assert.match(tray, /recoverablePins: pinDomain\.trayRecoveryMenu\(\)/)
  // The pin domain offers both notifications to the host.
  const pinDomain = fs.readFileSync(path.join(__dirname, '..', 'main', 'domains', 'pin', 'index.js'), 'utf8')
  assert.match(pinDomain, /function notifyPinLayoutChanged/)
  assert.match(pinDomain, /onPinLayoutChange/)
  assert.match(pinDomain, /onRecoverableChange/)
})

test('D05 (18): retained pins get a recoverable submenu with restore, save and discard', () => {
  const clicked = []
  const template = buildTrayMenuTemplate({
    executeFunction: () => {},
    setGameModeEnabled: () => {},
    openHistory: () => {},
    openMainWindow: () => {},
    showConversation: () => {},
    quit: () => {},
    recoverablePins: {
      items: [
        { id: 'ticket-1', index: 1, reason: 'crashed', attempts: 0, exhausted: false },
        { id: 'ticket-2', index: 2, reason: 'renderer-gone', attempts: 3, exhausted: true }
      ],
      actions: {
        recover: (id) => clicked.push(['recover', id]),
        save: (id) => clicked.push(['save', id]),
        discard: (id) => clicked.push(['discard', id])
      }
    }
  })
  const entry = template.find((item) => typeof item.label === 'string' && item.label.includes('2'))
  assert.ok(entry, 'a parent entry with the count exists')
  assert.equal(entry.submenu.length, 2)
  const first = entry.submenu[0]
  assert.equal(first.submenu.length, 3, 'restore / save as / discard')
  const [restore, save, discard] = first.submenu
  assert.equal(restore.enabled, true)
  assert.equal(save.enabled, undefined)
  restore.click()
  save.click()
  discard.click()
  assert.deepEqual(clicked, [
    ['recover', 'ticket-1'],
    ['save', 'ticket-1'],
    ['discard', 'ticket-1']
  ])
  // An exhausted ticket cannot be restored again, but it can still be saved or discarded.
  const second = entry.submenu[1]
  assert.equal(second.submenu[0].enabled, false)
  assert.equal(second.submenu[1].enabled, undefined)
  assert.equal(second.submenu[2].enabled, undefined)
})

test('D05 (18): no retained pins means no submenu at all', () => {
  const base = {
    executeFunction: () => {},
    setGameModeEnabled: () => {},
    openHistory: () => {},
    openMainWindow: () => {},
    showConversation: () => {},
    quit: () => {}
  }
  for (const recoverablePins of [null, { items: [], actions: {} }, { items: undefined }]) {
    const template = buildTrayMenuTemplate({ ...base, recoverablePins })
    const entry = template.find((item) => typeof item.label === 'string' && item.label.includes('待') === false && /recover/i.test(item.label))
    assert.equal(entry, undefined)
  }
})
