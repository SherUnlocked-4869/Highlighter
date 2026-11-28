'use strict'

// B04: the per-take audio preflight, end to end.
//
// Three layers:
//   1. source contracts for the files that had to change (the recording bar's
//      markup/flow, the workbench summary + check wiring, the loopback flag main
//      now reports);
//   2. locale contracts, including the one this review item is easy to get wrong:
//      window mode must say the system audio ALSO contains other apps and must never
//      be labelled "window only";
//   3. a vm harness that runs the REAL config/routes/recording.js against a fake
//      DOM/devices/clock, so "no click = no device", the three executable actions and
//      the release of the test tracks are behaviour, not string matches.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const {
  createPreflight,
  deviceErrorCode,
  preflightActions,
  summarizeCapture,
  SAMPLE_BUDGET_MS,
  RELEASE_BUDGET_MS
} = require('../shared/audio-preflight')

const ROOT = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n')

const routeSource = read('config/routes/recording.js')
const recordHtml = read('record/record.html')
const recordScript = read('record/record.js')
const mainRecordSource = read('main', 'domains', 'record', 'index.js')
const recordLocaleSource = read('shared', 'locales', 'record.js')
const configLocaleSource = read('shared', 'locales', 'config.js')
const LANGUAGES = ['zh-CN', 'en-US', 'zh-TW']

function loadTables() {
  globalThis.__LOCALES = {}
  for (const name of fs.readdirSync(path.join(ROOT, 'shared', 'locales')).filter((entry) => entry.endsWith('.js')).sort()) {
    const file = path.join(ROOT, 'shared', 'locales', name)
    delete require.cache[require.resolve(file)]
    require(file)
  }
  const tables = {}
  for (const language of LANGUAGES) tables[language] = globalThis.__LOCALES[language] || {}
  return tables
}

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  assert.ok(start >= 0, 'missing ' + startMarker)
  const end = endMarker ? source.indexOf(endMarker, start) : source.length
  assert.ok(end > start, 'missing ' + endMarker + ' after ' + startMarker)
  return source.slice(start, end)
}

// ---------------------------------------------------------------------------
// recording bar (record/record.html + record/record.js)
// ---------------------------------------------------------------------------

test('the recording bar loads the shared preflight module before its own script', () => {
  const preflight = recordHtml.search(/<script src="\.\.\/shared\/audio-preflight\.js"><\/script>/)
  const recorder = recordHtml.search(/<script src="record\.js"><\/script>/)
  assert.ok(preflight >= 0, 'record.html loads shared/audio-preflight.js')
  assert.ok(preflight < recorder, 'the module must be defined before record.js reads it')
  // The existing dependency order is untouched.
  assert.match(recordHtml, /shared\/recording-quality\.js[\s\S]*annotation-utils\.js[\s\S]*recording-utils\.js[\s\S]*audio-mixer\.js[\s\S]*shared\/audio-preflight\.js[\s\S]*record\.js/)
})

test('the bar exposes the two-lane panel and its executable actions', () => {
  for (const id of [
    'preflight', 'preflightPanel', 'preflightAudio', 'preflightNote',
    'preflightSystemBar', 'preflightSystemText', 'preflightMicBar', 'preflightMicText',
    'preflightRetry', 'preflightClose',
    'preflightSystemOnly', 'preflightMicOnly', 'preflightSilent'
  ]) {
    assert.match(recordHtml, new RegExp('id="' + id + '"'), 'record.html exposes #' + id)
  }
  for (const testId of ['audio-preflight', 'audio-preflight-panel', 'audio-preflight-actions']) {
    assert.match(recordHtml, new RegExp('data-testid="' + testId + '"'), 'record.html exposes data-testid=' + testId)
  }
  // Start is a real button and the check entry sits beside it in the same action row.
  assert.match(recordHtml, /id="preflight"[^>]*data-i18n="record\.preflight\.check"[^>]*hidden>Check sound<\/button>\s*<button id="start"/)
  // The panel is an overlay inside the fixed bar, exactly like the "more" panel, so
  // opening it cannot resize the capture-protected window.
  assert.match(recordHtml, /\.preflight-panel\{[^}]*position:absolute[^}]*inset:0/)
  // Every visible string is a locale key (the P0-3 rule: no audio copy in markup).
  assert.doesNotMatch(recordHtml, /microphone/i)
})

test('the bar opens devices only after begin(), cancels on every exit and releases tracks', () => {
  const start = sourceBetween(recordScript, 'async function startAudioPreflight()', '// Applies one of the panel')
  const beginIndex = start.indexOf('preflight.begin(')
  const noteOpenIndex = start.indexOf("preflight.noteOpen('system')")
  const systemOpenIndex = start.indexOf('acquirePreflightSystemStream()')
  assert.ok(beginIndex > 0 && beginIndex < noteOpenIndex, 'begin() comes before the first noteOpen()')
  assert.ok(noteOpenIndex < systemOpenIndex, 'the system lane is counted before its device opens')
  assert.ok(start.indexOf("preflight.noteOpen('microphone')") < start.indexOf('acquirePreflightMicrophoneStream()'))
  // The system lane reuses the take's own acquisition path (main's display-media
  // handler is the only source of loopback audio). The video track exists only
  // because Chromium requires it; it is never drawn and is released together with
  // the audio, because stopping it early could tear down the capture device (and
  // the audio lane) on some drivers.
  const systemAcquire = sourceBetween(recordScript, 'async function acquirePreflightSystemStream()', 'async function acquirePreflightMicrophoneStream()')
  assert.match(systemAcquire, /getDisplayMedia/)
  assert.doesNotMatch(systemAcquire, /getVideoTracks/)
  assert.match(systemAcquire, /releasePreflightDevices\(\)/)
  // The microphone asks for the same constraints the take uses.
  const micAcquire = sourceBetween(recordScript, 'async function acquirePreflightMicrophoneStream()', 'function attachPreflightAnalyser')
  assert.match(micAcquire, /microphoneConstraints\(mixer, audioRequest\.microphoneDeviceId\)/)
  // Release: every track stopped and the AudioContext closed.
  const release = sourceBetween(recordScript, 'function releasePreflightDevices()', 'function stopAudioPreflight')
  assert.match(release, /track\.stop\(\)/)
  assert.match(release, /context\.close\(\)/)
  assert.match(sourceBetween(recordScript, 'function stopAudioPreflight', 'function cancelAudioPreflight'), /markReleased\(Date\.now\(\)\)/)
  // A take takes the devices back, and closing the bar releases them.
  assert.match(sourceBetween(recordScript, 'async function beginRecording()', 'try {'), /cancelAudioPreflight\(\)/)
  assert.match(sourceBetween(recordScript, "addEventListener('beforeunload'", 'stopSource()'), /cancelAudioPreflight\(\)/)
  // The panel copy follows the active language, not the language it was captured in.
  assert.match(recordScript, /renderPreflight\(\)\n  \/\/ The hidden-window warning/)
})

test('the bar reports the loopback capability main sends, never a window-only mix', () => {
  assert.match(mainRecordSource, /audioLoopback: process\.platform === 'win32'/)
  // The flag must be the SAME condition the display-media handler uses.
  assert.match(mainRecordSource, /const audio = request\.audioRequested && process\.platform === 'win32' \? 'loopback' : undefined/)
  assert.match(recordScript, /preflightLoopback = data && data\.audioLoopback === false \? false : true/)
  assert.match(recordScript, /record\.preflight\.system-window-note/)
})

// ---------------------------------------------------------------------------
// workbench (config/routes/recording.js)
// ---------------------------------------------------------------------------

test('the workbench puts the capture summary and the check beside the Start button', () => {
  const startBlock = sourceBetween(routeSource, 'function recordingStartBlockMarkup(choices)', 'function recordingStartButtonMarkup')
  assert.match(startBlock, /recordingSummaryMarkup\(choices\)/)
  assert.match(startBlock, /recordingStartButtonMarkup\(choices\)/)
  assert.match(startBlock, /data-recording-preflight/)
  // The summary is three static rows plus the mix note; it never opens a device.
  assert.match(routeSource, /function recordingSummarySourceText\(choices\)/)
  assert.match(routeSource, /function recordingSummaryMicrophoneText\(choices\)/)
  // The row ids travel as string literals (two through the row() helper, the system
  // row is written inline because it carries the mix note).
  assert.match(routeSource, /'preflight-source'/)
  assert.match(routeSource, /data-testid="preflight-system"/)
  assert.match(routeSource, /'preflight-microphone'/)
  assert.match(routeSource, /recording\.preflight\.system-window-note/)
  // The bar owns the two-lane check, and the summary says where to look.
  assert.match(routeSource, /recording\.preflight\.bar-hint/)
})

test('the workbench check is click-only, cancellable and releases inside the budget', () => {
  const run = sourceBetween(routeSource, 'async function runRecordingMicrophonePreflight()', 'async function openWindowsMicrophoneSettings()')
  assert.match(run, /recordingPreflight\.noteOpen\('microphone'\)/)
  assert.match(run, /getUserMedia\(\{ audio: recordingPreflightConstraints\(choices\), video: false \}\)/)
  assert.ok(run.indexOf('recordingPreflight.begin(') < run.indexOf('noteOpen('), 'begin() gates the device open')
  // A route change while the permission prompt is open releases what arrived.
  assert.match(run, /currentRoute !== 'recording'[\s\S]{0,240}releaseRecordingPreflight\(\)/)
  const release = sourceBetween(routeSource, 'function releaseRecordingPreflight()', 'function stopRecordingPreflight')
  assert.match(release, /track\.stop\(\)/)
  assert.match(release, /context\.close\(\)/)
  assert.match(sourceBetween(routeSource, 'function stopRecordingPreflight', 'function cancelRecordingPreflight'), /markReleased\(Date\.now\(\)\)/)
  // The sampling loop is bounded by the shared budget and stops on a route change.
  const tick = sourceBetween(routeSource, 'function recordingPreflightTick()', 'async function runRecordingMicrophonePreflight()')
  assert.match(tick, /recordingPreflight\.expired\(\)/)
  assert.match(tick, /currentRoute !== 'recording'/)
  assert.match(tick, /Math\.min\(150, recordingPreflight\.remaining\(\)\)/)
  // Starting a take and leaving the page both release the device.
  assert.match(routeSource, /cancelRecordingPreflight\(\)\n  recordingWorkbenchBusy = true/)
})

test('the workbench offers the three executable actions when the microphone is refused', () => {
  const apply = sourceBetween(routeSource, 'function applyRecordingPreflightAction(action)', '// --- markup')
  assert.match(apply, /action === 'open-microphone-settings'/)
  assert.match(apply, /record-system-only/)
  assert.match(apply, /choices\.audioMicrophone = false/)
  assert.match(apply, /record-silent/)
  assert.match(apply, /choices\.audioSystem = false/)
  // The settings action tries the Windows deep link and prints the manual path; the
  // shell channel behind openExternal only grants HTTP(S), so it may refuse.
  assert.match(routeSource, /const WINDOWS_MICROPHONE_SETTINGS_URI = 'ms-settings:privacy-microphone'/)
  assert.match(sourceBetween(routeSource, 'async function openWindowsMicrophoneSettings()', 'function applyRecordingPreflightAction'), /openExternal\(WINDOWS_MICROPHONE_SETTINGS_URI\)/)
  assert.match(routeSource, /recording\.preflight\.settings-hint/)
  assert.match(routeSource, /recording\.preflight\.settings-failed/)
})

test('no workbench code path opens a device before the check is clicked', () => {
  // The microphone API may only be reached from the check's own run function: a
  // render, a poll or a mode switch must never touch it.
  const calls = [...routeSource.matchAll(/getUserMedia\(/g)].map((match) => match.index)
  assert.equal(calls.length, 1, 'exactly one microphone-open call exists')
  const runStart = routeSource.indexOf('async function runRecordingMicrophonePreflight()')
  const runEnd = routeSource.indexOf('async function openWindowsMicrophoneSettings()', runStart)
  assert.ok(calls[0] > runStart && calls[0] < runEnd, 'the open call must stay inside the click-driven run function')
  assert.doesNotMatch(routeSource, /getDisplayMedia\(/, 'the workbench never captures a screen to check sound')
  // The module itself refuses to count an open before begin(), which is what makes
  // the "no click" rule structural rather than a UI convention.
  const offline = createPreflight()
  assert.equal(offline.noteOpen('microphone'), false)
  assert.equal(offline.status().opens, 0)
})

// ---------------------------------------------------------------------------
// locale contracts
// ---------------------------------------------------------------------------

test('every preflight key used by either window exists in the three tables', () => {
  const tables = loadTables()
  const used = new Set()
  for (const match of routeSource.matchAll(/'((?:recording)\.preflight\.[a-z0-9.-]+)'/g)) used.add(match[1])
  for (const match of routeSource.matchAll(/'((?:recording)\.(?:workbench|records)\.[a-z0-9.-]+)'/g)) used.add(match[1])
  assert.ok([...used].filter((key) => key.includes('preflight')).length >= 20, 'the route resolves the preflight copy')
  // The bar's own literals (dynamic keys are declared in the two maps).
  const barKeys = new Set([...recordScript.matchAll(/'((?:record)\.preflight\.[a-z0-9.-]+)'/g)].map((match) => match[1]))
  assert.ok(barKeys.size >= 15, 'record.js resolves the bar copy')
  const missing = []
  for (const key of [...used, ...barKeys]) {
    for (const language of LANGUAGES) {
      if (typeof tables[language][key] !== 'string') missing.push(language + ': ' + key)
    }
  }
  assert.deepEqual(missing, [])
  // The workbench table and the bar table each carry the strings their window loads.
  assert.match(configLocaleSource, /'recording\.preflight\.system-window-note'/)
  assert.match(recordLocaleSource, /'record\.preflight\.system-window-note'/)
})

test('window mode never labels the system mix as window-only', () => {
  const tables = loadTables()
  for (const language of LANGUAGES) {
    const workbench = tables[language]['recording.preflight.system-window-note']
    const bar = tables[language]['record.preflight.system-window-note']
    assert.equal(typeof workbench, 'string')
    assert.equal(typeof bar, 'string')
    // The warning must exist and must say the mix contains other applications.
    assert.match(workbench, /其他应用|other apps|其他應用/i)
    assert.match(bar, /其他应用|other apps|其他應用/i)
    // And the warning itself may not promise isolation while recording a window
    // (the display-mode note deliberately says "not window-only audio", which is the
    // opposite claim and is checked below).
    for (const key of ['recording.preflight.system-window-note', 'record.preflight.system-window-note']) {
      const value = tables[language][key]
      assert.doesNotMatch(value, /only this window|only the window|window-only/i, language + ' ' + key + ' must not claim isolation')
    }
  }
  // The summary model itself has no isolation flag, only the "also contains others" one.
  const summary = summarizeCapture({ mode: 'window', system: true, microphone: true })
  assert.equal(summary.system.windowNote, true)
  assert.equal(summary.system.scope, 'system-mix')
})

test('the shared prompt map covers every code the module can emit', () => {
  const codes = [
    deviceErrorCode({ name: 'NotAllowedError' }),
    deviceErrorCode({ name: 'NotFoundError' }),
    deviceErrorCode({ name: 'NotReadableError' }),
    deviceErrorCode({ name: 'DeviceLost' }),
    deviceErrorCode({ name: 'Weird' })
  ]
  assert.deepEqual(codes, [
    'microphone-denied', 'microphone-missing', 'microphone-busy', 'microphone-lost', 'microphone-failed'
  ])
  const tables = loadTables()
  const microphone = [...codes, 'microphone-silent']
  const system = ['system-denied', 'system-unavailable', 'system-lost', 'system-silent', 'system-failed']
  // The workbench checks the microphone only (the system mix needs the recording
  // window's display-media handler), so its table carries the microphone prompts.
  for (const code of microphone) {
    for (const language of LANGUAGES) {
      assert.equal(typeof tables[language]['recording.preflight.prompt-' + code], 'string', language + ' workbench prompt ' + code)
    }
  }
  // The bar renders both lanes, so it carries both families.
  for (const code of [...microphone, ...system]) {
    for (const language of LANGUAGES) {
      assert.equal(typeof tables[language]['record.preflight.prompt-' + code], 'string', language + ' bar prompt ' + code)
    }
    // Every prompt either window can show must offer an executable action.
    assert.ok(preflightActions(code, { openSettings: false }).length > 0, code + ' has an executable action')
  }
  assert.equal(RELEASE_BUDGET_MS, 1000)
})

// ---------------------------------------------------------------------------
// behaviour: the real route file in a fake window
// ---------------------------------------------------------------------------

function camelCase(name) {
  return name.replace(/-([a-z0-9])/g, (_, character) => character.toUpperCase())
}

function createFakeDom() {
  const viewElements = []
  const fragments = new Map()

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

  function parse(html) {
    const elements = []
    for (const match of String(html).matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b([^<>]*)>/g)) {
      const tagName = match[1].toLowerCase()
      if (tagName === 'script' || tagName === 'style') continue
      const attributes = parseAttributes(match[2])
      const element = {
        tagName,
        attrs: attributes,
        dataset: {},
        textContent: '',
        style: {},
        value: Object.hasOwn(attributes, 'value') ? attributes.value : '',
        disabled: Object.hasOwn(attributes, 'disabled'),
        hidden: Object.hasOwn(attributes, 'hidden'),
        onclick: null,
        onchange: null,
        setAttribute(name, value) { this.attrs[name] = String(value) },
        getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null }
      }
      for (const [name, value] of Object.entries(attributes)) {
        if (name.startsWith('data-')) element.dataset[camelCase(name.slice(5))] = value
      }
      Object.defineProperty(element, 'innerHTML', {
        get() { return element._html || '' },
        set(value) {
          element._html = String(value)
          if (attributes.id) {
            if (attributes.id === 'view') {
              viewElements.length = 0
              viewElements.push(...parse(element._html))
              fragments.clear()
            } else {
              fragments.set(attributes.id, parse(element._html))
            }
          }
        }
      })
      elements.push(element)
    }
    return elements
  }

  const view = { attrs: { id: 'view' }, dataset: {}, _html: '' }
  Object.defineProperty(view, 'innerHTML', {
    get() { return view._html },
    set(value) {
      view._html = String(value)
      viewElements.length = 0
      viewElements.push(...parse(view._html))
      fragments.clear()
    }
  })

  function allElements() {
    return viewElements.concat(...fragments.values())
  }

  function matches(selector, element) {
    const attributeMatch = selector.match(/^\[([a-zA-Z0-9-]+)(?:="([^"]*)")?\]$/)
    if (attributeMatch) {
      const name = attributeMatch[1]
      const value = attributeMatch[2]
      if (!Object.hasOwn(element.attrs, name)) return false
      return value === undefined || element.attrs[name] === value
    }
    const idMatch = selector.match(/^#([A-Za-z0-9-]+)$/)
    if (idMatch) return element.attrs.id === idMatch[1]
    throw new Error('fake DOM does not support selector ' + selector)
  }

  const document = {
    documentElement: { dataset: {} },
    getElementById(id) {
      return allElements().find((element) => element.attrs.id === id) || null
    },
    querySelector(selector) {
      return allElements().find((element) => matches(selector, element)) || null
    },
    querySelectorAll(selector) {
      return allElements().filter((element) => matches(selector, element))
    }
  }

  return { document, view }
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character])
}

function iconMarkup(iconPath) {
  return '<span class="svg-icon" data-icon="' + escapeHtml(iconPath) + '"></span>'
}

function pageHeader(title, description, extra = '') {
  return '<div class="page-head"><div><h1>' + title + '</h1><p>' + (description || '') + '</p></div>' + extra + '</div>'
}

function formatBytes(value) {
  return Math.max(0, Number(value) || 0) + ' B'
}

const DISPLAYS = [
  { id: '2528732444', name: 'DISPLAY2', width: 1920, height: 1080, scaleFactor: 1, primary: false, label: '2' }
]

function workbenchConfig(overrides = {}) {
  return {
    mode: 'display',
    displayId: '2528732444',
    frameRate: 30,
    quality: 'high',
    countdown: 3,
    audioSystem: true,
    audioMicrophone: true,
    audioMicrophoneDeviceId: '',
    saveDirectory: 'D:/Videos',
    ...overrides
  }
}

function workbenchState(overrides = {}) {
  return {
    config: workbenchConfig(),
    displays: DISPLAYS,
    active: null,
    recent: [],
    ...overrides
  }
}

function plain(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

function createHarness({ state = workbenchState(), devices = [{ kind: 'audioinput', deviceId: 'mic-a', label: 'USB Microphone' }], rejectMic = null, deferMic = null } = {}) {
  const dom = createFakeDom()
  const clock = { value: 1_700_000_000_000, now() { return this.value } }
  const media = { micCalls: [], displayCalls: [], stops: [], contexts: 0, closed: 0, startPayloads: [] }
  const toasts = []
  const opened = []
  const timers = []
  let nextTimerId = 0

  function fakeStream() {
    const tracks = [{
      kind: 'audio',
      readyState: 'live',
      listeners: {},
      addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler) },
      emit(type) { for (const handler of this.listeners[type] || []) handler({ type }) },
      stop() {
        this.readyState = 'ended'
        media.stops.push('audio')
        // A real track fires 'ended' after stop(); the preflight must not turn that
        // into a "device lost" prompt for the run that just finished.
        this.emit('ended')
      }
    }]
    const stream = {
      getTracks: () => tracks,
      getAudioTracks: () => tracks,
      getVideoTracks: () => []
    }
    media.lastStream = stream
    return stream
  }

  class FakeAudioContext {
    constructor() { media.contexts += 1 }
    createAnalyser() {
      return {
        fftSize: 0,
        smoothingTimeConstant: 1,
        getFloatTimeDomainData(samples) { samples.fill(0.3) }
      }
    }
    createMediaStreamSource() { return { connect() {} } }
    close() { media.closed += 1; return Promise.resolve() }
  }

  const RealDate = Date
  function FakeDate(...args) {
    if (args.length === 0) return new RealDate(clock.value)
    return new RealDate(...args)
  }
  FakeDate.now = () => clock.value
  FakeDate.parse = RealDate.parse
  FakeDate.UTC = RealDate.UTC
  FakeDate.prototype = RealDate.prototype

  const sandbox = {
    console,
    document: dom.document,
    Date: FakeDate,
    AudioContext: FakeAudioContext,
    navigator: {
      mediaDevices: {
        enumerateDevices: async () => devices,
        getUserMedia: async (constraints) => {
          media.micCalls.push(plain(constraints))
          if (deferMic) return deferMic(constraints)
          if (rejectMic) throw rejectMic
          return fakeStream()
        },
        getDisplayMedia: async (constraints) => {
          media.displayCalls.push(plain(constraints))
          throw Object.assign(new Error('display media is not available in the workbench'), { name: 'NotAllowedError' })
        }
      }
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    setInterval: (fn, ms) => { timers.push({ id: ++nextTimerId, fn, ms, interval: true, cleared: false }); return nextTimerId },
    clearInterval: (id) => { const timer = timers.find((entry) => entry.id === id); if (timer) timer.cleared = true },
    setTimeout: (fn, ms) => { timers.push({ id: ++nextTimerId, fn, ms, interval: false, cleared: false }); return nextTimerId },
    clearTimeout: (id) => { const timer = timers.find((entry) => entry.id === id); if (timer) timer.cleared = true },
    escapeHtml,
    iconMarkup,
    pageHeader,
    formatBytes,
    errorMessage: (error) => String((error && error.message) || error || ''),
    toast: (message) => toasts.push(String(message)),
    prompt: () => null,
    confirm: () => true,
    currentRoute: 'recording',
    view: dom.view
  }
  sandbox.window = sandbox
  sandbox.window.electronAPI = {
    workbenchState: async () => state,
    workbenchStart: async (payload) => { media.startPayloads.push(plain(payload)); return { ok: true } },
    workbenchFocus: async () => ({ ok: true }),
    workbenchWindows: async () => ({ ok: true, windows: [] }),
    projectList: async () => ({ items: [], total: 0, offset: 0, limit: 20 }),
    // The shipped shell channel validates HTTP(S) and refuses ms-settings:; the
    // fake mirrors that so the renderer's fallback is exercised.
    openExternal: async (url) => { opened.push(String(url)); throw new Error('only http(s) links are allowed') }
  }
  const context = vm.createContext(sandbox)

  for (const file of ['shared/locales/zh-CN.js', 'shared/locales/en-US.js', 'shared/locales/zh-TW.js', 'shared/locales/config.js', 'shared/locales/recording.js']) {
    vm.runInContext(read(...file.split('/')), context, { filename: file })
  }
  vm.runInContext(read('shared/recording-quality.js'), context, { filename: 'shared/recording-quality.js' })
  // The shared preflight runs INSIDE this context, so its injected clock is the fake
  // one above - exactly like the real page's <script> tag.
  vm.runInContext(read('shared/audio-preflight.js'), context, { filename: 'shared/audio-preflight.js' })
  vm.runInContext(read('shared/i18n.js'), context, { filename: 'shared/i18n.js' })
  vm.runInContext(routeSource, context, { filename: 'config/routes/recording.js' })

  return {
    dom,
    media,
    toasts,
    opened,
    clock,
    context,
    fakeStream,
    run: (code) => vm.runInContext(code, context),
    async settle(rounds = 20) {
      for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve))
    },
    runTimers(count = 1) {
      let ran = 0
      while (ran < count) {
        const timer = timers.find((entry) => !entry.cleared && !entry.interval)
        if (!timer) break
        timer.cleared = true
        timer.fn()
        ran += 1
      }
      return ran
    }
  }
}

function click(dom, selector) {
  const element = dom.document.querySelector(selector)
  assert.ok(element, 'expected an element matching ' + selector)
  assert.equal(typeof element.onclick, 'function', 'expected ' + selector + ' to be wired with onclick')
  element.onclick()
  return element
}

test('rendering the workbench opens no device and shows the capture summary', async () => {
  const harness = createHarness()
  harness.run('renderRecording()')
  await harness.settle()
  const html = harness.dom.view.innerHTML

  assert.equal(harness.media.micCalls.length, 0, 'a render must never open a microphone')
  assert.equal(harness.media.displayCalls.length, 0, 'a render must never open desktop capture')
  assert.match(html, /data-testid="recording-start-block"/)
  assert.match(html, /data-testid="preflight-source"/)
  assert.match(html, /data-testid="preflight-system"/)
  assert.match(html, /data-testid="preflight-microphone"/)
  assert.match(html, /data-testid="preflight-check"/)
  assert.match(html, /data-testid="start-recording"/)
  // The summary names the display actually selected.
  assert.match(html, /DISPLAY2/)
  assert.match(html, /\u68c0\u67e5\u9ea6\u514b\u98ce/)
})

test('window mode warns that the system audio also contains other apps', async () => {
  const harness = createHarness({ state: workbenchState({ config: workbenchConfig({ mode: 'window' }) }) })
  harness.run('renderRecording()')
  await harness.settle()
  const html = harness.dom.view.innerHTML
  assert.match(html, /data-testid="preflight-window-note"/)
  assert.match(html, /\u7a97\u53e3\u6a21\u5f0f\u4e0b\u7cfb\u7edf\u58f0\u5305\u542b\u5176\u4ed6\u5e94\u7528/)
  assert.doesNotMatch(html, /\u4ec5\u7a97\u53e3\u58f0\u97f3/, 'window mode must not promise a window-only mix')
  // Display mode says the same thing without the window warning.
  const display = createHarness()
  display.run('renderRecording()')
  await display.settle()
  assert.doesNotMatch(display.dom.view.innerHTML, /data-testid="preflight-window-note"/)
  assert.match(display.dom.view.innerHTML, /\u4e0d\u662f\u4ec5\u7a97\u53e3\u58f0\u97f3/)
})

test('a refused microphone renders the three executable actions', async () => {
  const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })
  const harness = createHarness({ rejectMic: denied })
  harness.run('renderRecording()')
  await harness.settle()
  assert.equal(harness.media.micCalls.length, 0)

  click(harness.dom, '[data-testid="preflight-check"]')
  await harness.settle()
  assert.equal(harness.media.micCalls.length, 1, 'one click opens the microphone exactly once')
  // The check asked for the same constraints the take uses.
  assert.deepEqual(harness.media.micCalls[0], {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
    video: false
  })

  const html = harness.dom.view.innerHTML
  assert.match(html, /data-testid="preflight-action-open-microphone-settings"/)
  assert.match(html, /data-testid="preflight-action-record-system-only"/)
  assert.match(html, /data-testid="preflight-action-record-silent"/)
  assert.match(html, /\u9ea6\u514b\u98ce/) // the prompt names the lane it is about
  assert.match(html, /\u672c\u6b21\u5f55\u5236\u5c06\u6ca1\u6709\u9ea6\u514b\u98ce\u58f0\u97f3/) // and what the file will lose
  // The manual Windows path is printed next to the action.
  assert.match(html, /data-testid="preflight-settings-hint"/)
  assert.match(html, /ms-settings:privacy-microphone/)

  // The settings action asks the shell for the Windows deep link (this build's shell
  // channel only grants HTTP(S), so the renderer also printed the manual path).
  click(harness.dom, '[data-testid="preflight-action-open-microphone-settings"]')
  await harness.settle()
  assert.deepEqual(harness.opened, ['ms-settings:privacy-microphone'])
  assert.ok(harness.toasts.some((message) => message.includes('\u65e0\u6cd5\u81ea\u52a8\u6253\u5f00')))

  // "System audio only" lands on the existing start payload.
  click(harness.dom, '[data-testid="preflight-action-record-system-only"]')
  await harness.settle()
  assert.doesNotMatch(harness.dom.view.innerHTML, /data-testid="preflight-actions"/, 'resolved prompts disappear')
  assert.match(harness.dom.view.innerHTML, /data-testid="preflight-status"/)
  click(harness.dom, '[data-testid="start-recording"]')
  await harness.settle()
  const payload = harness.media.startPayloads.at(-1)
  assert.equal(payload.config.audioMicrophone, false)
  assert.equal(payload.config.audioSystem, true)
  assert.equal(payload.config.audioMicrophoneDeviceId, '')
})

test('the silent option records without sound and keeps the frozen payload shape', async () => {
  const denied = Object.assign(new Error('No microphone'), { name: 'NotFoundError' })
  const harness = createHarness({ rejectMic: denied })
  harness.run('renderRecording()')
  await harness.settle()
  click(harness.dom, '[data-testid="preflight-check"]')
  await harness.settle()
  assert.match(harness.dom.view.innerHTML, /\u6ca1\u6709\u627e\u5230\u9ea6\u514b\u98ce/)

  click(harness.dom, '[data-testid="preflight-action-record-silent"]')
  await harness.settle()
  click(harness.dom, '[data-testid="start-recording"]')
  await harness.settle()
  const payload = harness.media.startPayloads.at(-1)
  assert.equal(payload.config.audioSystem, false)
  assert.equal(payload.config.audioMicrophone, false)
  // The frozen shape gained exactly one additive field from the DEV-04 shortcut
  // opt-in; every pre-existing key is still there and nothing else is forwarded.
  assert.deepEqual(Object.keys(payload.config).sort(), [
    'audioMicrophone', 'audioMicrophoneDeviceId', 'audioSystem', 'countdown',
    'demoEnhance', 'demoKeystrokes', 'displayId', 'frameRate', 'mode', 'quality', 'saveDirectory'
  ])
})

test('a successful check samples the level and releases the device at once', async () => {
  const harness = createHarness()
  harness.run('renderRecording()')
  await harness.settle()
  click(harness.dom, '[data-testid="preflight-check"]')
  await harness.settle()

  assert.equal(harness.media.micCalls.length, 1)
  assert.equal(harness.media.contexts, 1, 'an AudioContext is created for the meter')
  assert.equal(harness.media.stops.length, 0, 'the device stays open while sampling')
  assert.match(harness.dom.view.innerHTML, /data-testid="preflight-retry"/)
  assert.match(harness.dom.view.innerHTML, /\u6b63\u5728\u68c0\u67e5/)

  // One tick inside the window: the meter reads the fake 0.3 peak ("good").
  harness.clock.value += 200
  harness.runTimers(1)
  const bar = harness.dom.document.getElementById('recordingPreflightBar')
  assert.ok(bar, 'the meter element exists')
  assert.ok(Number.parseFloat(bar.style.width) > 0, 'the meter moved off zero')
  assert.equal(bar.attrs['data-level'], 'good')

  // Past the five-second budget the next tick ends the run and releases everything.
  harness.clock.value += SAMPLE_BUDGET_MS
  harness.runTimers(1)
  await harness.settle()
  assert.equal(harness.media.stops.length, 1, 'the test track is stopped')
  assert.equal(harness.media.closed, 1, 'the AudioContext is closed')
  assert.match(harness.dom.view.innerHTML, /\u6709\u58f0\u97f3/)
})

test('a device unplugged mid-check is reported as lost, not as silence', async () => {
  const harness = createHarness()
  harness.run('renderRecording()')
  await harness.settle()
  click(harness.dom, '[data-testid="preflight-check"]')
  await harness.settle()

  // Bluetooth headset pulled out while the five-second sample is running.
  const track = harness.media.lastStream.getAudioTracks()[0]
  track.readyState = 'ended'
  track.emit('ended')
  await harness.settle()

  const html = harness.dom.view.innerHTML
  assert.match(html, /\u9ea6\u514b\u98ce\u5df2\u65ad\u5f00/)
  assert.match(html, /data-testid="preflight-action-record-system-only"/)
  assert.match(html, /data-testid="preflight-action-record-silent"/)
  // The run keeps its five-second budget; the track ends but nothing re-opens it.
  harness.clock.value += SAMPLE_BUDGET_MS
  harness.runTimers(1)
  await harness.settle()
  assert.equal(harness.media.micCalls.length, 1)
  assert.equal(harness.media.closed, 1)
})

test('stopping the check cancels it and releases the device', async () => {
  const harness = createHarness()
  harness.run('renderRecording()')
  await harness.settle()
  click(harness.dom, '[data-testid="preflight-check"]')
  await harness.settle()
  assert.equal(harness.media.stops.length, 0)
  click(harness.dom, '[data-testid="preflight-retry"]')
  await harness.settle()
  assert.equal(harness.media.stops.length, 1)
  assert.equal(harness.media.closed, 1)
  assert.equal(harness.media.micCalls.length, 1, 'stopping never re-opens a device')
})

test('the check is refused without a microphone lane and never opens one', async () => {
  const harness = createHarness({ state: workbenchState({ config: workbenchConfig({ audioMicrophone: false }) }) })
  harness.run('renderRecording()')
  await harness.settle()
  const check = harness.dom.document.querySelector('[data-testid="preflight-check"]')
  assert.equal(check.disabled, true, 'the check is disabled while the microphone is off')
  assert.equal(harness.media.micCalls.length, 0)
})

test('a missing shared module degrades to an explained panel instead of throwing', async () => {
  const harness = createHarness()
  // Simulate a build whose module did not load: the loader resolves null.
  harness.run('window.__realAudioPreflight = window.audioPreflight; delete window.audioPreflight')
  harness.run('audioPreflightModule = null; audioPreflightModulePromise = null')
  harness.run('renderRecording()')
  await harness.settle()
  click(harness.dom, '[data-testid="preflight-check"]')
  await harness.settle()
  assert.equal(harness.media.micCalls.length, 0, 'no device is opened without the module')
  assert.match(harness.dom.view.innerHTML, /data-testid="preflight-panel"/)
  assert.match(harness.dom.view.innerHTML, /\u65e0\u6cd5\u68c0\u67e5\u9ea6\u514b\u98ce/)
})

// ---------------------------------------------------------------------------
// B04 (plan item 13): the check owns a deadline from the click, and a permission grant
// that arrives late is stopped on arrival. The recording bar is driven through the REAL
// record/record.js in a fake window (test/helpers/record-window-harness.js).
// ---------------------------------------------------------------------------

const { createRecordWindowHarness } = require('./helpers/record-window-harness')

function deferredStream() {
  let resolve = null
  const promise = new Promise((onResolve) => { resolve = onResolve })
  return { promise, resolve }
}

function stoppedCount(harness) {
  return harness.media.state.stopped.length
}

test('B04 (13): the bar check ends inside the five-second budget while the microphone prompt is open', async () => {
  const pendingMic = deferredStream()
  const harness = createRecordWindowHarness({ deferMicrophone: () => pendingMic.promise })
  await harness.init()
  const started = harness.run('startAudioPreflight()')
  await harness.settle(6)
  // The system lane opened; the microphone prompt is still open and holds no device yet.
  assert.equal(harness.media.state.displayCalls.length, 1)
  assert.equal(harness.media.state.microphoneCalls.length, 1)
  assert.equal(stoppedCount(harness), 0, 'the system lane stays available while sampling')
  assert.equal(harness.run('preflight.isActive()'), true)

  // Advance past the sample budget and let the deadline tick run.
  harness.clock.value += SAMPLE_BUDGET_MS + 1
  harness.runTimers({ count: 1, advanceMs: 0 })
  await harness.settle(6)
  assert.equal(stoppedCount(harness), 2, 'the system audio AND its required video track are stopped')
  assert.equal(harness.run('preflight.isActive()'), false)
  assert.equal(harness.run('preflight.status().releasedWithinBudget'), true)
  // The permission is granted only after the deadline: the late stream must be stopped on
  // arrival, and only then does the check's own promise settle.
  const late = harness.media.stream({ audio: true, video: false })
  pendingMic.resolve(late)
  await harness.settle(6)
  assert.deepEqual(late._tracks.map((track) => track.readyState), ['ended'], 'a late grant is stopped on arrival')
  await started
  assert.equal(harness.run('preflightSystemStream === null'), true)
})

test('B04 (13): a re-check releases the previous run instead of stacking devices', async () => {
  const harness = createRecordWindowHarness()
  await harness.init()
  harness.run('startAudioPreflight()').catch(() => {})
  await harness.settle(6)
  const firstStreams = harness.media.state.livestreams.slice()
  assert.equal(firstStreams.length, 2, 'system + microphone for the first check')
  assert.equal(harness.media.state.livestreams.every((stream) => stream._tracks.every((track) => track.readyState === 'live')), true)

  // Clicking the check again while it runs cancels it (the button's own contract) and a
  // fresh click starts a new run with new devices.
  harness.run('startAudioPreflight()').catch(() => {})
  await harness.settle(6)
  assert.equal(harness.media.state.livestreams.every((stream) => stream._tracks.every((track) => track.readyState === 'ended')), true, 'cancelling releases everything it held')
  harness.run('startAudioPreflight()').catch(() => {})
  await harness.settle(6)
  const live = harness.media.state.livestreams.filter((stream) => stream._tracks.every((track) => track.readyState === 'live'))
  assert.equal(live.length, 2, 'the new run holds exactly its own two streams')
})

test('B04 (13): closing the window releases the check and invalidates its pending grant', async () => {
  const pendingMic = deferredStream()
  const harness = createRecordWindowHarness({ deferMicrophone: () => pendingMic.promise })
  await harness.init()
  const started = harness.run('startAudioPreflight()')
  await harness.settle(6)
  assert.equal(stoppedCount(harness), 0)
  // beforeunload is the window-close path of the real control bar.
  harness.run('cancelAudioPreflight()')
  await harness.settle(4)
  assert.equal(stoppedCount(harness), 2, 'the system lane is released on close')
  const late = harness.media.stream({ audio: true, video: false })
  pendingMic.resolve(late)
  await harness.settle(6)
  assert.deepEqual(late._tracks.map((track) => track.readyState), ['ended'], 'the pending grant cannot outlive the window check')
  await started
})

test('B04 (13): the workbench check ends at the five-second deadline while the prompt is open', async () => {
  let resolveMic = null
  const pending = new Promise((resolve) => { resolveMic = resolve })
  const harness = createHarness({ deferMic: () => pending })
  harness.run('renderRecording()')
  await harness.settle()
  click(harness.dom, '[data-testid="preflight-check"]')
  await harness.settle()
  assert.equal(harness.media.micCalls.length, 1)
  assert.equal(harness.media.stops.length, 0, 'no device has been granted yet')
  assert.equal(harness.run('recordingPreflight.isActive()'), true)

  // The permission prompt never answers: the deadline armed at the click ends the run.
  harness.clock.value += SAMPLE_BUDGET_MS + 1
  harness.runTimers(1)
  await harness.settle()
  assert.equal(harness.run('recordingPreflight.isActive()'), false)
  assert.equal(harness.media.contexts, 0, 'no meter was built for an expired run')

  // The grant arrives afterwards: it is stopped at once instead of being held.
  const late = harness.fakeStream()
  resolveMic(late)
  await harness.settle()
  assert.notEqual(late.getAudioTracks()[0].readyState, 'live', 'a late grant is stopped on arrival')
  assert.equal(harness.run('recordingPreflightMicStream === null'), true)
  assert.equal(harness.media.micCalls.length, 1, 'the late grant never triggers a second open')
})
