'use strict'

// W4 recording workbench: wiring + behaviour.
//
// The settings window is a classic-script page with no module boundary, so this
// file verifies it in two layers:
//   1. source/wiring assertions for the shell, preload, settings route and the
//      locale tables (the parts that live in config/** and would otherwise only
//      fail inside a real Electron window);
//   2. a vm harness that actually runs config/routes/recording.js against a fake
//      DOM / fake electronAPI, so mode selection, the explicit display target,
//      the frozen start payload and the project-card actions are exercised as
//      behaviour, not as string matches.
//
// The fake DOM deliberately implements only the surface the route uses
// (getElementById / querySelector[All] / innerHTML / dataset / onclick), which is
// also a useful contract: if the route starts reaching for more DOM API than a
// plain settings page needs, these tests stop covering it and should be updated
// deliberately.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')

const routeSource = read('config/routes/recording.js')
const shellSource = read('config/config.js')
const htmlSource = read('config/config.html')
const settingsSource = read('config/routes/settings.js')
const homeSource = read('config/routes/home.js')
const preloadSource = read('preload.js')
const styleSource = read('config/config.css')

const LANGUAGES = ['zh-CN', 'en-US', 'zh-TW']
const LOCALE_SCRIPTS = ['zh-CN.js', 'en-US.js', 'zh-TW.js', 'config.js', 'recording.js']

// --- locale tables -----------------------------------------------------------

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

// --- fake DOM ----------------------------------------------------------------

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
        value: Object.hasOwn(attributes, 'value') ? attributes.value : '',
        disabled: Object.hasOwn(attributes, 'disabled'),
        onclick: null,
        onchange: null
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
      const [, name, value] = attributeMatch
      if (!Object.hasOwn(element.attrs, name)) return false
      return value === undefined || element.attrs[name] === value
    }
    const idMatch = selector.match(/^#([A-Za-z0-9-]+)$/)
    if (idMatch) return element.attrs.id === idMatch[1]
    throw new Error(`fake DOM does not support selector ${selector}`)
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
    },
    querySelectorAllByAttribute(name, value) {
      return allElements().filter((element) => element.attrs[name] === value)
    }
  }

  return { document, view }
}

// --- shared shell helpers the route expects to find as globals --------------

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character])
}

function iconMarkup(iconPath) {
  return `<span class="svg-icon" data-icon="${escapeHtml(iconPath)}"></span>`
}

function pageHeader(title, description, extra = '') {
  return `<div class="page-head"><div><h1>${title}</h1><p>${description || ''}</p></div>${extra}</div>`
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0)
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function createHarness({ electronAPI, devices = [], promptResult = null, confirmResult = true } = {}) {
  const dom = createFakeDom()
  const calls = { start: [], focus: [], list: [], open: [], rename: [], del: [], reveal: [] }
  const toasts = []
  const timers = []
  const sandbox = {
    console,
    document: dom.document,
    navigator: { mediaDevices: { enumerateDevices: async () => devices } },
    localStorage: { getItem: () => null, setItem: () => {} },
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearInterval: (id) => { const timer = timers[id - 1]; if (timer) timer.cleared = true },
    setTimeout: (fn) => { fn(); return 0 },
    clearTimeout: () => {},
    escapeHtml,
    iconMarkup,
    pageHeader,
    formatBytes,
    errorMessage: (error) => String((error && error.message) || error || ''),
    toast: (message) => toasts.push(String(message)),
    prompt: () => promptResult,
    confirm: () => confirmResult,
    currentRoute: 'recording',
    view: dom.view
  }
  sandbox.window = sandbox
  sandbox.window.prompt = sandbox.prompt
  sandbox.window.confirm = sandbox.confirm
  sandbox.window.electronAPI = electronAPI || {}
  const context = vm.createContext(sandbox)

  for (const file of ['shared/locales/zh-CN.js', 'shared/locales/en-US.js', 'shared/locales/zh-TW.js', 'shared/locales/config.js', 'shared/locales/recording.js']) {
    vm.runInContext(read(...file.split('/')), context, { filename: file })
  }
  vm.runInContext(read('shared/recording-quality.js'), context, { filename: 'shared/recording-quality.js' })
  vm.runInContext(read('shared/i18n.js'), context, { filename: 'shared/i18n.js' })
  vm.runInContext(routeSource, context, { filename: 'config/routes/recording.js' })

  return {
    dom,
    calls,
    toasts,
    timers,
    run: (code) => vm.runInContext(code, context),
    async settle(rounds = 14) {
      for (let index = 0; index < rounds; index++) await new Promise((resolve) => setImmediate(resolve))
    }
  }
}

function queryAll(dom, selector) {
  return dom.document.querySelectorAll(selector)
}

function click(dom, selector) {
  const element = dom.document.querySelector(selector)
  assert.ok(element, `expected an element matching ${selector}`)
  assert.equal(typeof element.onclick, 'function', `expected ${selector} to be wired with onclick`)
  element.onclick()
  return element
}

// --- fixtures ----------------------------------------------------------------

const CREATED_AT = new Date(2026, 10, 3, 17, 0, 0).getTime()
const CREATED_AT_LABEL = '2026-11-03 17:00'

const DISPLAYS = [
  { id: '2528732444', name: 'DISPLAY2', width: 1920, height: 1080, scaleFactor: 1, primary: false, label: '2 \u00b7 1920\u00d71080' },
  { id: '111', name: 'DISPLAY1', width: 2560, height: 1440, scaleFactor: 1.5, primary: true, label: '1 \u00b7 2560\u00d71440' }
]

function workbenchConfig(overrides = {}) {
  return {
    mode: 'display',
    displayId: '2528732444',
    frameRate: 30,
    quality: 'high',
    countdown: 3,
    audioSystem: true,
    audioMicrophone: false,
    audioMicrophoneDeviceId: '',
    saveDirectory: 'D:/Videos',
    ...overrides
  }
}

function projectSummary(overrides = {}) {
  return {
    id: 'project-1',
    name: 'ScreenRecording_2026-11-03_17-00-00',
    mode: 'display',
    state: 'ready',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    durationMs: 65000,
    width: 1920,
    height: 1080,
    bytes: 1048576,
    frameRate: 30,
    quality: 'high',
    hasAudio: true,
    audio: { system: true, microphone: false },
    exportCount: 0,
    lastExport: null,
    thumbnail: false,
    ...overrides
  }
}

function workbenchState(overrides = {}) {
  return {
    config: workbenchConfig(),
    displays: DISPLAYS,
    active: null,
    recent: [projectSummary()],
    ...overrides
  }
}

function plain(value) {
  // Payloads created inside the vm context carry that realm's Object prototype;
  // normalise them before deepStrictEqual so the assertion is about the data.
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

// R4 window-capture fixtures. A window row is an opaque token plus display fields;
// width/height 0 models a source whose size could not be measured.
const WINDOW_ENTRIES = [
  { token: 'window-token-1', title: 'Visual Studio Code', appName: 'Visual Studio Code', width: 1920, height: 1080 },
  { token: 'window-token-2', title: 'Untitled paint', appName: '', width: 0, height: 0 }
]

function createApi(state, {
  listResult = { items: [], total: 0, offset: 0, limit: 20 },
  renameProject = null,
  windows = WINDOW_ENTRIES,
  workbenchWindows = null
} = {}) {
  const calls = { start: [], focus: [], list: [], open: [], rename: [], del: [], reveal: [], windows: [] }
  const api = {
    workbenchState: async () => (typeof state === 'function' ? state() : state),
    workbenchStart: async (payload) => { calls.start.push(plain(payload)); return { ok: true } },
    workbenchFocus: async () => { calls.focus.push(true); return { ok: true } },
    projectList: async (query) => { calls.list.push(plain(query)); return listResult },
    projectOpen: async (projectId) => { calls.open.push(projectId); return { ok: true } },
    projectRename: async (projectId, name) => {
      calls.rename.push([projectId, name])
      if (!renameProject) return { ok: true, project: projectSummary({ id: projectId, name }) }
      return renameProject(projectId, name)
    },
    projectDelete: async (projectId) => { calls.del.push(projectId); return { ok: true } },
    projectReveal: async (projectId) => { calls.reveal.push(projectId); return { ok: true } },
    workbenchWindows: async () => {
      calls.windows.push(true)
      if (typeof workbenchWindows === 'function') return workbenchWindows()
      return { ok: true, windows }
    }
  }
  return { api, calls }
}

// --- source / wiring assertions ---------------------------------------------

test('the shell registers the recording route, its title and its poll cleanup', () => {
  assert.match(shellSource, /window\.configRoutes = window\.configRoutes \|\| \{\}/)
  assert.match(shellSource, /recording: \{ key: 'renderRecording', fallbackMessage: 'recording\.workbench\.load-failed' \}/)
  assert.match(shellSource, /recording: 'config\.route\.recording'/)
  // Leaving the route must stop the state poll; the hook is optional-call guarded
  // so an older route file cannot take the navigation down.
  assert.match(shellSource, /currentRoute === 'recording' && route !== 'recording'[\s\S]{0,160}recordingDeactivate/)
  assert.match(routeSource, /function recordingDeactivate\(\) \{\s*stopRecordingWorkbenchPolling\(\)\s*\}/)
  assert.match(routeSource, /window\.configRoutes\['renderRecording'\]/)
})

test('config.html wires the nav entry, the locale table, the quality module and the route', () => {
  assert.match(htmlSource, /data-route="recording"[\s\S]{0,200}config\.route\.recording/)
  assert.match(htmlSource, /shared\/locales\/recording\.js/)
  assert.match(htmlSource, /shared\/recording-quality\.js/)
  assert.match(htmlSource, /<script src="routes\/recording\.js"><\/script>/)
  const locale = htmlSource.search(/<script src="\.\.\/shared\/locales\/recording\.js">/)
  const runtime = htmlSource.search(/<script src="\.\.\/shared\/i18n\.js">/)
  const route = htmlSource.search(/<script src="routes\/recording\.js">/)
  const shell = htmlSource.search(/<script src="config\.js">/)
  assert.ok(locale >= 0 && locale < runtime, 'the recording table loads before the i18n runtime')
  assert.ok(route >= 0 && route < shell, 'the route loads before the shell that dispatches it')
  assert.ok(htmlSource.indexOf('shared/recording-quality.js') < route, 'quality allow-lists load before the workbench route')
})

test('preload exposes the frozen workbench/project channels without inventing new ones', () => {
  const channels = [...preloadSource.matchAll(/ipcRenderer\.invoke\('(record:(?:workbench|project)-[a-z-]+)'/g)].map((match) => match[1])
  const core = [
    'record:project-delete',
    'record:project-list',
    'record:project-open',
    'record:project-rename',
    'record:project-reveal',
    'record:workbench-focus',
    'record:workbench-start',
    'record:workbench-state'
  ]
  // R4 adds exactly one channel (W6 owns preload.js); accept it when it has landed
  // and reject anything beyond the frozen nine so the renderer contract stays pinned.
  const allowed = new Set([...core, 'record:workbench-windows'])
  for (const channel of channels) assert.ok(allowed.has(channel), `unexpected preload channel ${channel}`)
  for (const channel of core) assert.ok(channels.includes(channel), `preload exposes ${channel}`)
  assert.ok(channels.length === core.length || channels.length === core.length + 1, `unexpected channel count ${channels.length}`)
  // The workbench half of the preload must not accept paths or a desktop source.
  const block = preloadSource.slice(preloadSource.indexOf('workbenchState:'))
  assert.doesNotMatch(block, /sourcePath|targetPath|filePath|ffmpeg|desktopSource/i)
  for (const method of ['workbenchState', 'workbenchStart', 'workbenchFocus', 'projectList', 'projectOpen', 'projectRename', 'projectDelete', 'projectReveal']) {
    assert.match(preloadSource, new RegExp(`${method}:`), `preload exposes ${method}`)
  }
})

test('the settings page keeps recording defaults + storage and writes the frozen keys', () => {
  // Defaults the workbench starts from (contract §3) plus storage/data.
  for (const id of ['frameRate', 'recordQuality', 'recordCountdown', 'recordMicDevice', 'recordDirectory', 'openRecordingData']) {
    assert.match(settingsSource, new RegExp(`id="${id}"`), `settings record tab has #${id}`)
  }
  assert.match(settingsSource, /writeRecordingDefault\(\{ quality: recordQuality\.value \}\)/)
  assert.match(settingsSource, /writeRecordingDefault\(\{ countdown: Number\(recordCountdown\.value\) \}\)/)
  assert.match(settingsSource, /writeRecordingDefault\(\{ audioMicrophoneDeviceId: recordMicDevice\.value \}\)/)
  assert.match(settingsSource, /writeRecordingDefault\(\{ saveDirectory: recordDirectory\.value\.trim\(\) \}\)/)
  // Existing rows stay untouched: the frozen switch markup and the frame-rate list.
  assert.match(settingsSource, /switchMarkup\(settings\.record\.audioSystem !== false, 'audioSystem', 'record'\)/)
  assert.match(settingsSource, /switchMarkup\(settings\.record\.audioMicrophone === true, 'audioMicrophone', 'record'\)/)
  assert.match(settingsSource, /\[5, 16, 24, 30, 60\]/)
  // Data-directory opener uses the existing app channel, never a renderer path.
  assert.match(settingsSource, /window\.electronAPI\.openDataRoot\(\)/)
  assert.doesNotMatch(settingsSource, /record:project-(?:reveal|delete)\([^)]*path/i)
})

test('the five recording commands are listed for the shortcuts tab with locale copy', () => {
  const tables = loadTables()
  const commands = ['openRecording', 'recordRegion', 'recordFullscreen', 'recordPauseResume', 'recordFinish']
  for (const command of commands) {
    const entry = new RegExp(`\\['${command}', 'config\\.function\\.[a-z-]+', '[^']+\\.svg', 'config\\.function\\.[a-z-]+-description'\\]`)
    assert.match(homeSource, entry, `${command} is a functionGroups entry`)
  }
  for (const language of LANGUAGES) {
    for (const command of commands) {
      const label = `config.function.${command.replace(/([A-Z])/g, (_, character) => `-${character.toLowerCase()}`)}`
      assert.ok(Object.hasOwn(tables[language], label), `${language} defines ${label}`)
      assert.ok(Object.hasOwn(tables[language], `${label}-description`), `${language} defines ${label}-description`)
    }
  }
})

test('every recording.* key the workbench resolves exists in all three locale tables', () => {
  const tables = loadTables()
  const used = new Set([...routeSource.matchAll(/'((?:recording|config)\.[a-z0-9.-]+)'/g)].map((match) => match[1]))
  assert.ok(used.size > 20, 'the route resolves a meaningful set of locale keys')
  const missing = []
  for (const key of used) {
    for (const language of LANGUAGES) {
      if (!Object.hasOwn(tables[language], key)) missing.push(`${language}: ${key}`)
    }
  }
  assert.deepEqual(missing, [])
})

// --- behaviour: pure helpers -------------------------------------------------

test('duration/date formatting and display resolution are deterministic', async () => {
  const harness = createHarness({ electronAPI: createApi(workbenchState()).api })
  const format = (value) => harness.run(`formatRecordingDuration(${value})`)
  assert.equal(format(0), '00:00')
  assert.equal(format(9000), '00:09')
  assert.equal(format(61000), '01:01')
  assert.equal(format(3661000), '1:01:01')
  assert.equal(format(-5), '00:00')
  assert.equal(harness.run('formatRecordingDate(0)'), '')
  assert.equal(harness.run(`formatRecordingDate(${CREATED_AT})`), CREATED_AT_LABEL)

  // Explicit target: an exact id wins; a stale id on a multi-display machine is
  // reported missing instead of falling back to another screen.
  assert.deepEqual(
    JSON.parse(harness.run('JSON.stringify(resolveRecordingDisplay(window.__testDisplays || [], ""))')),
    { displayId: '', missing: false }
  )
  harness.run(`window.__testDisplays = ${JSON.stringify(DISPLAYS)}`)
  assert.deepEqual(JSON.parse(harness.run('JSON.stringify(resolveRecordingDisplay(window.__testDisplays, "111"))')), { displayId: '111', missing: false })
  assert.deepEqual(JSON.parse(harness.run('JSON.stringify(resolveRecordingDisplay(window.__testDisplays, "gone"))')), { displayId: '', missing: true })
  assert.deepEqual(JSON.parse(harness.run('JSON.stringify(resolveRecordingDisplay([window.__testDisplays[0]], "gone"))')), { displayId: '2528732444', missing: false })

  // Frozen allow-lists with an invalid value falling back to the documented default.
  assert.equal(harness.run('normalizeRecordingQuality("ultra")'), 'ultra')
  assert.equal(harness.run('normalizeRecordingQuality("bogus")'), 'standard')
  assert.equal(harness.run('normalizeRecordingCountdown("5")'), 5)
  assert.equal(harness.run('normalizeRecordingCountdown(7)'), 3)
  assert.equal(harness.run('normalizeRecordingFrameRate(60)'), 60)
  assert.equal(harness.run('normalizeRecordingFrameRate(120)'), 30)
})

test('choices and the start payload follow the frozen §9.1 shape', async () => {
  const harness = createHarness({ electronAPI: createApi(workbenchState()).api })
  harness.run(`window.__testState = ${JSON.stringify(workbenchState({ config: workbenchConfig({ quality: 'bogus', countdown: 9, frameRate: 17 }) }))}`)
  const choices = JSON.parse(harness.run('JSON.stringify(createRecordingChoices(window.__testState))'))
  assert.equal(choices.quality, 'standard')
  assert.equal(choices.countdown, 3)
  assert.equal(choices.frameRate, 30)
  assert.equal(choices.audioSystem, true)
  assert.equal(choices.audioMicrophone, false)

  const displayPayload = JSON.parse(harness.run('JSON.stringify(buildRecordingStartPayload(createRecordingChoices(window.__testState)))'))
  assert.equal(displayPayload.mode, 'display')
  assert.equal(displayPayload.displayId, '2528732444')
  assert.deepEqual(displayPayload.config, {
    mode: 'display',
    displayId: '2528732444',
    frameRate: 30,
    quality: 'standard',
    countdown: 3,
    audioSystem: true,
    audioMicrophone: false,
    audioMicrophoneDeviceId: '',
    saveDirectory: 'D:/Videos',
    demoEnhance: false
  })

  harness.run(`window.__testState = ${JSON.stringify(workbenchState({ config: workbenchConfig({ mode: 'region' }) }))}`)
  const regionPayload = JSON.parse(harness.run('JSON.stringify(buildRecordingStartPayload(createRecordingChoices(window.__testState)))'))
  assert.equal(regionPayload.mode, 'region')
  assert.equal(regionPayload.displayId, undefined)
  assert.equal(regionPayload.config.displayId, '')
  assert.equal(regionPayload.config.mode, 'region')
})

test('audio and state labels are the localized copies, not raw keys', async () => {
  const harness = createHarness({ electronAPI: createApi(workbenchState()).api })
  assert.equal(harness.run('recordingAudioLabel({ audio: { system: true, microphone: true } })'), '\u7cfb\u7edf\u58f0\u97f3 + \u9ea6\u514b\u98ce')
  assert.equal(harness.run('recordingAudioLabel({ audio: { system: false, microphone: true } })'), '\u9ea6\u514b\u98ce')
  assert.equal(harness.run('recordingAudioLabel({ audio: { system: false, microphone: false } })'), '\u65e0\u58f0\u97f3')
  assert.equal(harness.run('recordingStateLabel("recoverable")'), '\u4e2d\u65ad\u5f85\u6062\u590d')
  assert.equal(harness.run('recordingStateLabel("something-new")'), '\u72b6\u6001\u672a\u77e5')
})

// --- behaviour: rendered workbench ------------------------------------------

test('the workbench renders modes, an explicit display target and the frozen option sets', async () => {
  const { api } = createApi(workbenchState())
  const harness = createHarness({ electronAPI: api, devices: [{ kind: 'audioinput', deviceId: 'mic-a', label: 'USB Microphone' }] })
  harness.run('renderRecording()')
  await harness.settle()
  const html = harness.dom.view.innerHTML

  assert.match(html, /data-testid="recording-workbench"/)
  assert.match(html, /data-workbench-mode="display"/)
  assert.match(html, /data-testid="mode-region"/)
  assert.match(html, /data-testid="mode-display"/)
  // R4: the third mode card exists and the region/display-only placeholder rule is
  // preserved — every card is a real, selectable mode.
  assert.match(html, /data-testid="mode-window"/)
  assert.equal((html.match(/class="rec-mode-card/g) || []).length, 3, 'exactly three mode cards')
  assert.equal((html.match(/data-testid="display-option"/g) || []).length, 2, 'every display is listed')
  assert.match(html, /data-display-id="2528732444"/)
  assert.match(html, /data-display-id="111"/)
  assert.match(html, /data-testid="display-option"[^>]*aria-pressed="true"[^>]*>\s*<span class="rec-display-name">DISPLAY2/)
  assert.match(html, /1920\u00d71080/, 'resolution is shown on the target card')
  assert.equal(harness.dom.document.querySelector('[data-testid="audio-system"]').attrs['aria-checked'], 'true')
  assert.equal(harness.dom.document.querySelector('[data-testid="audio-microphone"]').attrs['aria-checked'], 'false')
  assert.match(html, /data-testid="start-recording"[^>]*>\u5f00\u59cb\u5168\u5c4f\u5f55\u5236/)
  assert.match(html, /data-testid="frame-rate-30"/)
  assert.match(html, /data-testid="frame-rate-60"/)
  assert.match(html, /data-testid="quality-standard"/)
  assert.match(html, /data-testid="quality-high"[^>]*selected/)
  assert.match(html, /data-testid="quality-ultra"/)
  assert.match(html, /data-testid="countdown-0"/)
  assert.match(html, /data-testid="countdown-3"[^>]*selected/)
  assert.match(html, /data-testid="countdown-5"/)
  assert.match(html, /data-testid="record-card"/)
  assert.match(html, /data-project-id="project-1" data-project-state="ready"/)
  assert.match(html, new RegExp(CREATED_AT_LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  for (const testId of ['card-edit', 'card-play', 'card-rename', 'card-reveal', 'card-delete']) {
    assert.match(html, new RegExp(`data-testid="${testId}"`), `card action ${testId} is rendered`)
  }
  assert.match(html, /data-testid="records-tab-recent"/)
  assert.match(html, /data-testid="records-tab-all"/)
  assert.doesNotMatch(html, /data-testid="records-empty"/)
})

test('a stale saved display is never silently replaced on a multi-display machine', async () => {
  const { api } = createApi(workbenchState({ config: workbenchConfig({ displayId: 'gone' }) }))
  const harness = createHarness({ electronAPI: api })
  harness.run('renderRecording()')
  await harness.settle()

  assert.match(harness.dom.view.innerHTML, /data-testid="display-warning"/)
  assert.equal(harness.dom.document.getElementById('recordingStartButton').disabled, true, 'start waits for an explicit target')
  const activeBefore = queryAll(harness.dom, '[data-testid="display-option"]').filter((element) => element.attrs['aria-pressed'] === 'true')
  assert.equal(activeBefore.length, 0, 'no display is marked selected')

  click(harness.dom, '[data-testid="display-option"]')
  assert.match(harness.dom.view.innerHTML, /data-display-id="2528732444"[^>]*aria-pressed="true"/)
  assert.equal(harness.dom.document.getElementById('recordingStartButton').disabled, false)
})

test('a single display binds implicitly but is still rendered as the selected target', async () => {
  const { api } = createApi(workbenchState({ displays: [DISPLAYS[0]], config: workbenchConfig({ displayId: '' }) }))
  const harness = createHarness({ electronAPI: api })
  harness.run('renderRecording()')
  await harness.settle()
  const options = queryAll(harness.dom, '[data-testid="display-option"]')
  assert.equal(options.length, 1)
  assert.equal(options[0].attrs['aria-pressed'], 'true')
  assert.equal(harness.dom.document.getElementById('recordingStartButton').disabled, false)
})

test('start sends the frozen payload and switches to the region entry', async () => {
  const { api, calls } = createApi(workbenchState())
  const harness = createHarness({ electronAPI: api })
  harness.run('renderRecording()')
  await harness.settle()

  click(harness.dom, '[data-testid="start-recording"]')
  await harness.settle()
  assert.equal(calls.start.length, 1)
  assert.deepEqual(calls.start[0], {
    mode: 'display',
    displayId: '2528732444',
    config: {
      mode: 'display',
      displayId: '2528732444',
      frameRate: 30,
      quality: 'high',
      countdown: 3,
      audioSystem: true,
      audioMicrophone: false,
      audioMicrophoneDeviceId: '',
      saveDirectory: 'D:/Videos',
      demoEnhance: false
    }
  })

  click(harness.dom, '[data-testid="mode-region"]')
  assert.match(harness.dom.view.innerHTML, /data-workbench-mode="region"/)
  assert.match(harness.dom.view.innerHTML, /data-testid="start-recording"[^>]*>\u5f00\u59cb\u533a\u57df\u5f55\u5236/)
  click(harness.dom, '[data-testid="start-recording"]')
  await harness.settle()
  assert.equal(calls.start[1].mode, 'region')
  assert.equal(Object.hasOwn(calls.start[1], 'displayId'), false)
  assert.equal(calls.start[1].config.displayId, '')
})

test('an active capture shows the live banner, blocks start and focuses the control bar', async () => {
  const { api, calls } = createApi(workbenchState({
    active: { mode: 'display', status: 'paused', elapsedMs: 65000, microphoneMuted: true }
  }))
  const harness = createHarness({ electronAPI: api })
  harness.run('renderRecording()')
  await harness.settle()

  const html = harness.dom.view.innerHTML
  assert.match(html, /data-testid="active-banner"/)
  assert.match(html, /\u5df2\u6682\u505c/, 'the paused state is explicit copy, not colour alone')
  assert.match(html, /01:05/, 'elapsed media time is shown')
  assert.equal(harness.dom.document.getElementById('recordingStartButton').disabled, true)
  click(harness.dom, '[data-testid="active-focus"]')
  await harness.settle()
  assert.equal(calls.focus.length, 1, 'record:workbench-focus is invoked')
})

test('records list: all-records paging, rename, reveal, delete and project open', async () => {
  const second = projectSummary({ id: 'project-2', name: 'ScreenRecording_two', mode: 'region', state: 'recoverable', durationMs: 0, width: 0, height: 0, bytes: 0, audio: { system: true, microphone: true } })
  const listResult = { items: [projectSummary(), second, projectSummary({ id: 'project-3', name: 'ScreenRecording_three' })], total: 3, offset: 0, limit: 20 }
  const { api, calls } = createApi(workbenchState({ recent: [projectSummary(), second] }), { listResult })
  const harness = createHarness({ electronAPI: api, promptResult: '  Renamed capture  ' })
  harness.run('renderRecording()')
  await harness.settle()

  // Recoverable is visibly labelled and still openable; its hint explains export.
  assert.match(harness.dom.view.innerHTML, /data-project-id="project-2" data-project-state="recoverable"/)
  assert.match(harness.dom.view.innerHTML, /\u4e2d\u65ad\u5f85\u6062\u590d/)
  assert.match(harness.dom.view.innerHTML, /\u6062\u590d\u524d\u4e0d\u63d0\u4f9b\u5bfc\u51fa/)

  // All-records tab loads through record:project-list with the frozen paging shape.
  click(harness.dom, '[data-testid="records-tab-all"]')
  await harness.settle()
  assert.deepEqual(calls.list[0], { offset: 0, limit: 20 })
  assert.equal(queryAll(harness.dom, '[data-testid="record-card"]').length, 3)
  // Later updates redraw only #recordingRecordsHost, so read the host rather than
  // the stale outer page string (the fake DOM does not propagate parent HTML).
  assert.match(harness.dom.document.getElementById('recordingRecordsHost').innerHTML, /\u5171 3 \u6761/)

  // Open: both "continue editing" and "play" go through the editor channel.
  const editButton = queryAll(harness.dom, '[data-testid="card-edit"]').find((element) => element.dataset.projectId === 'project-1')
  editButton.onclick()
  await harness.settle()
  assert.deepEqual(calls.open, ['project-1'])

  // Rename trims and forwards through record:project-rename.
  const renameButton = queryAll(harness.dom, '[data-testid="card-rename"]').find((element) => element.dataset.projectId === 'project-1')
  renameButton.onclick()
  await harness.settle()
  assert.deepEqual(calls.rename, [['project-1', 'Renamed capture']])

  // Reveal never carries a path: only the project id.
  const revealButton = queryAll(harness.dom, '[data-testid="card-reveal"]').find((element) => element.dataset.projectId === 'project-1')
  revealButton.onclick()
  await harness.settle()
  assert.deepEqual(calls.reveal, ['project-1'])

  // Delete is confirmed, then forwarded by id.
  const deleteButton = queryAll(harness.dom, '[data-testid="card-delete"]').find((element) => element.dataset.projectId === 'project-1')
  deleteButton.onclick()
  await harness.settle()
  assert.deepEqual(calls.del, ['project-1'])
})

test('a busy delete and a capture-in-progress card are reported, not silently swallowed', async () => {
  const capturing = projectSummary({ id: 'project-live', state: 'capturing', mode: 'display' })
  const { api, calls } = createApi(workbenchState({ recent: [capturing] }))
  api.projectDelete = async (projectId) => { calls.del.push(projectId); return { ok: false, code: 'busy' } }
  const harness = createHarness({ electronAPI: api })
  harness.run('renderRecording()')
  await harness.settle()

  const edit = queryAll(harness.dom, '[data-testid="card-edit"]')[0]
  assert.equal(edit.disabled, true, 'a capturing project cannot be opened in the editor')
  const deleteButton = queryAll(harness.dom, '[data-testid="card-delete"]')[0]
  deleteButton.onclick()
  await harness.settle()
  assert.deepEqual(calls.del, ['project-live'])
  assert.ok(harness.toasts.some((message) => message.includes('\u7f16\u8f91\u5668\u6216\u5bfc\u51fa\u4efb\u52a1')), 'the busy delete explains itself')
})

test('a missing main-process half degrades to an inline retry and never crashes the window', async () => {
  const failing = { workbenchState: async () => { throw new Error('No handler registered') } }
  const harness = createHarness({ electronAPI: failing })
  harness.run('renderRecording()')
  await harness.settle()
  assert.match(harness.dom.view.innerHTML, /data-testid="recording-workbench"/)
  assert.match(harness.dom.view.innerHTML, /data-testid="workbench-error"/)
  assert.match(harness.dom.view.innerHTML, /data-testid="workbench-retry"/)
  assert.equal(harness.dom.document.getElementById('recordingStartButton').disabled, true)

  // Retry with a working channel: the page recovers in place.
  harness.run('window.electronAPI.workbenchState = async () => window.__recoveredState')
  harness.run(`window.__recoveredState = ${JSON.stringify(workbenchState())}`)
  click(harness.dom, '[data-testid="workbench-retry"]')
  await harness.settle()
  assert.doesNotMatch(harness.dom.view.innerHTML, /data-testid="workbench-error"/)
  assert.equal(queryAll(harness.dom, '[data-testid="record-card"]').length, 1)
})

test('a microphone that is enabled but unavailable offers re-select and continue-without', async () => {
  const { api } = createApi(workbenchState({ config: workbenchConfig({ audioMicrophone: true, audioMicrophoneDeviceId: 'mic-gone' }) }))
  const harness = createHarness({ electronAPI: api, devices: [] })
  harness.run('renderRecording()')
  await harness.settle()
  assert.match(harness.dom.view.innerHTML, /data-testid="audio-warning"/)
  assert.match(harness.dom.view.innerHTML, /data-recording-device-refresh/)
  assert.match(harness.dom.view.innerHTML, /data-recording-continue-without/)

  click(harness.dom, '[data-recording-continue-without]')
  assert.doesNotMatch(harness.dom.view.innerHTML, /data-testid="audio-warning"/)
  assert.equal(queryAll(harness.dom, '[data-testid="audio-microphone"]')[0].attrs['aria-checked'], 'false')
})

// --- behaviour: R4 window capture -------------------------------------------

test('window choices and the start payload follow the frozen §2.1 shape', async () => {
  const harness = createHarness({ electronAPI: createApi(workbenchState()).api })

  // Normalisation: duplicate/invalid tokens dropped, missing title gets locale copy,
  // negative/unknown sizes become "not measured".
  harness.run(`window.__rawWindows = ${JSON.stringify([
    { token: 'a', title: 'Editor', appName: 'Code', width: 1920, height: 1080 },
    { token: 'a', title: 'duplicate', width: 10, height: 10 },
    { token: '', title: 'no token', width: 10, height: 10 },
    { token: 'b', title: '', width: -4, height: 0 }
  ])}`)
  const windows = JSON.parse(harness.run('JSON.stringify(normalizeRecordingWindows(window.__rawWindows))'))
  assert.deepEqual(windows, [
    { token: 'a', title: 'Editor', appName: 'Code', width: 1920, height: 1080 },
    { token: 'b', title: '\u672a\u547d\u540d\u7a97\u53e3', appName: '', width: 0, height: 0 }
  ])
  assert.equal(harness.run('recordingWindowSizeText({ width: 1920, height: 1080 })'), '1920\u00d71080')
  assert.equal(harness.run('recordingWindowSizeText({ width: 0, height: 1080 })'), '')
  assert.equal(harness.run('recordingModeLabel("window")'), '\u7a97\u53e3')

  // Choices accept the window mode (persisted lastMode may be extended by W6) and
  // never remember a token: tokens are single-use and expire after 120s.
  harness.run(`window.__windowState = ${JSON.stringify(workbenchState({ config: workbenchConfig({ mode: 'window' }) }))}`)
  const choices = JSON.parse(harness.run('JSON.stringify(createRecordingChoices(window.__windowState))'))
  assert.equal(choices.mode, 'window')
  assert.equal(choices.windowToken, '')
  harness.run('window.__windowChoices = createRecordingChoices(window.__windowState)')
  assert.equal(harness.run('recordingStartBlocker(window.__windowChoices, null)'), 'window-required')

  const payload = JSON.parse(harness.run(`(() => {
    const next = createRecordingChoices(window.__windowState)
    next.windowToken = 'token-9'
    return JSON.stringify(buildRecordingStartPayload(next))
  })()`))
  assert.equal(payload.mode, 'window')
  assert.equal(payload.windowToken, 'token-9')
  assert.equal(Object.hasOwn(payload, 'displayId'), false)
  assert.deepEqual(payload.config, {
    mode: 'window',
    displayId: '',
    frameRate: 30,
    quality: 'high',
    countdown: 3,
    audioSystem: true,
    audioMicrophone: false,
    audioMicrophoneDeviceId: '',
    saveDirectory: 'D:/Videos',
    demoEnhance: false
  })
})

test('window mode lists recordable windows, selects one and sends the token payload', async () => {
  const { api, calls } = createApi(workbenchState())
  const harness = createHarness({ electronAPI: api })
  harness.run('renderRecording()')
  await harness.settle()
  assert.equal(calls.windows.length, 0, 'no window list is fetched on a display-mode entry')

  click(harness.dom, '[data-testid="mode-window"]')
  await harness.settle()
  assert.match(harness.dom.view.innerHTML, /data-workbench-mode="window"/)
  assert.match(harness.dom.view.innerHTML, /data-testid="window-refresh"/)
  assert.ok(calls.windows.length >= 1, 'entering window mode fetches record:workbench-windows')
  assert.match(harness.dom.view.innerHTML, /data-testid="start-recording"[^>]*>\u5f00\u59cb\u7a97\u53e3\u5f55\u5236/)

  const options = queryAll(harness.dom, '[data-testid="window-option"]')
  assert.equal(options.length, 2)
  assert.deepEqual(options.map((option) => option.attrs['data-window-token']), ['window-token-1', 'window-token-2'])
  assert.equal(options[0].attrs['aria-pressed'], 'false')
  assert.match(harness.dom.view.innerHTML, /Visual Studio Code/)
  assert.match(harness.dom.view.innerHTML, /1920\u00d71080/, 'measured windows show their pixel size')
  // A window with unknown size shows its title only (contract §2.3).
  const unknownSize = harness.dom.view.innerHTML.match(/<button[^>]*data-window-token="window-token-2"[^>]*>([\s\S]*?)<\/button>/)
  assert.ok(unknownSize, 'the zero-size window row is rendered')
  assert.doesNotMatch(unknownSize[1], /\u00d7/, 'a zero-size window omits the size text')

  // Without a selection the start button is blocked with the window-required copy.
  const start = harness.dom.document.getElementById('recordingStartButton')
  assert.equal(start.disabled, true)
  assert.match(harness.dom.view.innerHTML, /title="\u8bf7\u9009\u62e9\u8981\u5f55\u5236\u7684\u7a97\u53e3"/)
  start.onclick()
  await harness.settle()
  assert.equal(calls.start.length, 0, 'window-required never reaches record:workbench-start')
  assert.ok(harness.toasts.some((message) => message.includes('\u8bf7\u9009\u62e9\u8981\u5f55\u5236\u7684\u7a97\u53e3')))

  // Selecting a row is explicit and enables start; the payload carries the token.
  options[0].onclick()
  assert.match(harness.dom.view.innerHTML, /data-window-token="window-token-1"[^>]*aria-pressed="true"/)
  assert.equal(harness.dom.document.getElementById('recordingStartButton').disabled, false)
  click(harness.dom, '[data-testid="start-recording"]')
  await harness.settle()
  assert.equal(calls.start.length, 1)
  assert.deepEqual(calls.start[0], {
    mode: 'window',
    windowToken: 'window-token-1',
    config: {
      mode: 'window',
      displayId: '',
      frameRate: 30,
      quality: 'high',
      countdown: 3,
      audioSystem: true,
      audioMicrophone: false,
      audioMicrophoneDeviceId: '',
      saveDirectory: 'D:/Videos',
      demoEnhance: false
    }
  })
  assert.equal(Object.hasOwn(calls.start[0], 'displayId'), false)
  assert.ok(harness.toasts.some((message) => message.includes('\u6b63\u5728\u51c6\u5907\u7a97\u53e3\u5f55\u5236')), 'window start announces the preparing state')

  // Refresh is manual and re-fetches the list through the same IPC.
  const before = calls.windows.length
  click(harness.dom, '[data-testid="window-refresh"]')
  await harness.settle()
  assert.equal(calls.windows.length, before + 1)
})

test('window list loading, empty and error states degrade with a retry', async () => {
  // Loading: the first paint after entering window mode must show window-loading.
  const { api } = createApi(workbenchState())
  let releaseWindows = null
  api.workbenchWindows = () => new Promise((resolve) => { releaseWindows = resolve })
  const loadingHarness = createHarness({ electronAPI: api })
  loadingHarness.run('renderRecording()')
  await loadingHarness.settle()
  click(loadingHarness.dom, '[data-testid="mode-window"]')
  assert.match(loadingHarness.dom.view.innerHTML, /data-testid="window-loading"/)
  assert.doesNotMatch(loadingHarness.dom.view.innerHTML, /data-testid="window-empty"/)
  releaseWindows({ ok: true, windows: WINDOW_ENTRIES })
  await loadingHarness.settle()
  assert.doesNotMatch(loadingHarness.dom.view.innerHTML, /data-testid="window-loading"/)
  assert.equal(queryAll(loadingHarness.dom, '[data-testid="window-option"]').length, 2)

  // Empty: no recordable windows at all is an explicit empty state, not an error.
  const { api: emptyApi } = createApi(workbenchState(), { windows: [] })
  const emptyHarness = createHarness({ electronAPI: emptyApi })
  emptyHarness.run('renderRecording()')
  await emptyHarness.settle()
  click(emptyHarness.dom, '[data-testid="mode-window"]')
  await emptyHarness.settle()
  assert.match(emptyHarness.dom.view.innerHTML, /data-testid="window-empty"/)
  assert.equal(queryAll(emptyHarness.dom, '[data-testid="window-option"]').length, 0)
  assert.equal(emptyHarness.dom.document.getElementById('recordingStartButton').disabled, true)

  // Error: a missing/failing channel shows window-error + retry, and retry recovers.
  const { api: errorApi } = createApi(workbenchState())
  errorApi.workbenchWindows = async () => { throw new Error('No handler registered') }
  const errorHarness = createHarness({ electronAPI: errorApi })
  errorHarness.run('renderRecording()')
  await errorHarness.settle()
  click(errorHarness.dom, '[data-testid="mode-window"]')
  await errorHarness.settle()
  assert.match(errorHarness.dom.view.innerHTML, /data-testid="window-error"/)
  assert.match(errorHarness.dom.view.innerHTML, /data-testid="window-retry"/)
  assert.equal(errorHarness.dom.document.getElementById('recordingStartButton').disabled, true)
  delete errorApi.workbenchWindows
  click(errorHarness.dom, '[data-testid="window-retry"]')
  await errorHarness.settle()
  assert.match(errorHarness.dom.view.innerHTML, /data-testid="window-error"/, 'a missing channel still degrades, never throws')

  errorApi.workbenchWindows = async () => ({ ok: true, windows: WINDOW_ENTRIES })
  click(errorHarness.dom, '[data-testid="window-retry"]')
  await errorHarness.settle()
  assert.doesNotMatch(errorHarness.dom.view.innerHTML, /data-testid="window-error"/)
  assert.equal(queryAll(errorHarness.dom, '[data-testid="window-option"]').length, 2)
})

test('window target selection is mutually exclusive with the display target', async () => {
  const { api, calls } = createApi(workbenchState())
  const harness = createHarness({ electronAPI: api })
  harness.run('renderRecording()')
  await harness.settle()
  const selectedDisplays = () => queryAll(harness.dom, '[data-testid="display-option"]').filter((element) => element.attrs['aria-pressed'] === 'true')
  assert.equal(selectedDisplays().length, 1, 'display mode starts with its saved target selected')

  click(harness.dom, '[data-testid="mode-window"]')
  await harness.settle()
  const selectedWindows = () => queryAll(harness.dom, '[data-testid="window-option"]').filter((element) => element.attrs['aria-pressed'] === 'true')
  assert.equal(selectedWindows().length, 0, 'switching to window mode clears the display target')
  queryAll(harness.dom, '[data-testid="window-option"]')[0].onclick()
  assert.equal(selectedWindows().length, 1)
  assert.equal(harness.dom.document.getElementById('recordingStartButton').disabled, false)

  click(harness.dom, '[data-testid="mode-display"]')
  await harness.settle()
  assert.equal(selectedDisplays().length, 0, 'switching back to display clears the window token')
  assert.equal(harness.dom.document.getElementById('recordingStartButton').disabled, true, 'a stale target never starts implicitly')

  click(harness.dom, '[data-testid="mode-window"]')
  await harness.settle()
  assert.equal(selectedWindows().length, 0, 're-entering window mode starts unselected (tokens are single-use)')
  // A refresh that no longer lists the selected window also drops the selection.
  queryAll(harness.dom, '[data-testid="window-option"]')[0].onclick()
  assert.equal(selectedWindows().length, 1)
  const nextWindows = [WINDOW_ENTRIES[1]]
  api.workbenchWindows = async () => ({ ok: true, windows: nextWindows })
  click(harness.dom, '[data-testid="window-refresh"]')
  await harness.settle()
  assert.equal(selectedWindows().length, 0, 'a vanished token is cleared by refresh')
  assert.equal(harness.dom.document.getElementById('recordingStartButton').disabled, true)
  assert.ok(calls.windows.length >= 2)
})

test('window start failures map the frozen codes back to localized copy', async () => {
  const { api, calls } = createApi(workbenchState())
  const harness = createHarness({ electronAPI: api })
  harness.run('renderRecording()')
  await harness.settle()
  click(harness.dom, '[data-testid="mode-window"]')
  await harness.settle()
  queryAll(harness.dom, '[data-testid="window-option"]')[0].onclick()

  for (const [code, copy] of [
    ['window-unavailable', '\u8bf7\u5237\u65b0\u540e\u91cd\u65b0\u9009\u62e9'],
    ['window-too-small', '\u7a97\u53e3\u592a\u5c0f']
  ]) {
    api.workbenchStart = async (payload) => { calls.start.push(plain(payload)); return { ok: false, code } }
    const before = calls.windows.length
    click(harness.dom, '[data-testid="start-recording"]')
    await harness.settle()
    assert.ok(harness.toasts.some((message) => message.includes(copy)), `${code} is explained in the active language`)
    assert.ok(calls.windows.length > before, `${code} triggers a window-list refresh for re-selection`)
    // Re-select after the rejected attempt (the refresh may have cleared it).
    if (queryAll(harness.dom, '[data-testid="window-option"]').length) queryAll(harness.dom, '[data-testid="window-option"]')[0].onclick()
  }
  assert.equal(calls.start.length, 2)
  assert.equal(calls.start[0].mode, 'window')
  assert.equal(calls.start[0].windowToken, 'window-token-1')
})

// Loads the REAL preload.js in a vm sandbox so the payload sanitizer is exercised
// as behaviour: the frozen start payload must survive it with every field intact.
function loadPreloadApi() {
  const invocations = []
  const exposed = {}
  const sandbox = {
    console,
    require: (name) => {
      if (name !== 'electron') throw new Error(`unexpected require ${name}`)
      return {
        contextBridge: { exposeInMainWorld: (key, api) => { exposed[key] = api } },
        ipcRenderer: {
          invoke: (channel, payload) => { invocations.push({ channel, payload }); return Promise.resolve({ ok: true }) },
          send: () => {},
          on: () => {},
          removeListener: () => {}
        }
      }
    },
    module: { exports: {} },
    exports: {}
  }
  vm.createContext(sandbox)
  vm.runInContext(preloadSource, sandbox, { filename: 'preload.js' })
  return { api: exposed.electronAPI, invocations }
}

test('preload workbenchStart forwards the demo switch in the frozen config shape', () => {
  const { api, invocations } = loadPreloadApi()
  const baseConfig = {
    mode: 'display',
    displayId: 'display-1',
    frameRate: 30,
    quality: 'high',
    countdown: 3,
    audioSystem: true,
    audioMicrophone: false,
    audioMicrophoneDeviceId: '',
    saveDirectory: 'D:/Videos',
    demoEnhance: true
  }
  api.workbenchStart({ mode: 'display', displayId: 'display-1', config: baseConfig })
  assert.equal(invocations[0].channel, 'record:workbench-start')
  assert.equal(invocations[0].payload.config.demoEnhance, true, 'the whitelist must not drop the boolean')
  assert.equal(invocations[0].payload.displayId, 'display-1')
  assert.deepEqual(plain(invocations[0].payload.config), baseConfig, 'every frozen config field survives the sanitizer')

  // Window mode forwards the token AND the boolean (the main process gates capture).
  api.workbenchStart({ mode: 'window', windowToken: 'token-1', config: { ...baseConfig, mode: 'window', displayId: '' } })
  assert.equal(invocations[1].payload.windowToken, 'token-1')
  assert.equal(invocations[1].payload.config.demoEnhance, true)

  // A missing / non-boolean value falls back to false; unrelated input is dropped.
  api.workbenchStart({ mode: 'region', config: { demoEnhance: 'yes', unexpected: 'drop me' } })
  assert.equal(invocations[2].payload.config.demoEnhance, false)
  assert.equal(Object.hasOwn(invocations[2].payload.config, 'unexpected'), false)
  api.workbenchStart({ mode: 'region' })
  assert.equal(invocations[3].payload.config.demoEnhance, false)
})

test('demo enhance is a session-only opt-in carried by every mode payload', async () => {
  // R5 §5: default off, one-line scope hint, and the boolean travels on
  // config.demoEnhance for display, region AND window (the main process gates the
  // pointer track: display/region only, window mode never collects).
  assert.match(preloadSource, /demoEnhance: config\.demoEnhance === true/, 'the preload sanitizer forwards the boolean')
  assert.match(routeSource, /demoEnhance: choices \? choices\.demoEnhance === true : false/, 'the start payload carries the per-recording value')

  const { api, calls } = createApi(workbenchState())
  const harness = createHarness({ electronAPI: api })
  harness.run('renderRecording()')
  await harness.settle()

  const demoSwitches = () => queryAll(harness.dom, '[data-testid="demo-enhance"]')
  assert.equal(demoSwitches().length, 1, 'the recording parameters expose one demo-enhance switch')
  assert.equal(demoSwitches()[0].attrs['aria-checked'], 'false', 'the switch is off by default')
  assert.equal(harness.dom.view.innerHTML.includes('\u6f14\u793a\u589e\u5f3a'), true, 'the row has its localized label')
  assert.match(harness.dom.view.innerHTML, /\u8bb0\u5f55\u9f20\u6807\u79fb\u52a8\u4e0e\u70b9\u51fb/, 'the hint says what is recorded')
  assert.match(harness.dom.view.innerHTML, /\u4e0d\u8bb0\u5f55\u952e\u76d8\u5185\u5bb9/, 'the hint states the keyboard exclusion')
  assert.match(harness.dom.view.innerHTML, /\u4ec5\u672c\u6b21\u5f55\u5236\u751f\u6548/, 'the hint states the session-only scope')

  // Toggling is immediate and only affects the next start payload.
  demoSwitches()[0].onclick()
  assert.equal(demoSwitches()[0].attrs['aria-checked'], 'true')

  const startAndRead = async (expectedIndex) => {
    click(harness.dom, '[data-testid="start-recording"]')
    await harness.settle()
    return calls.start[expectedIndex]
  }

  const displayStart = await startAndRead(0)
  assert.equal(displayStart.mode, 'display')
  assert.equal(displayStart.config.demoEnhance, true, 'display mode forwards the opt-in')

  click(harness.dom, '[data-testid="mode-region"]')
  const regionStart = await startAndRead(1)
  assert.equal(regionStart.mode, 'region')
  assert.equal(regionStart.config.demoEnhance, true, 'region mode forwards the opt-in')

  click(harness.dom, '[data-testid="mode-window"]')
  await harness.settle()
  queryAll(harness.dom, '[data-testid="window-option"]')[0].onclick()
  const windowStart = await startAndRead(2)
  assert.equal(windowStart.mode, 'window')
  assert.equal(windowStart.config.demoEnhance, true, 'window mode still carries the boolean (the main process gates collection)')

  // "Applies to this recording only": re-entering the workbench starts opt-out.
  harness.run('renderRecording()')
  await harness.settle()
  assert.equal(demoSwitches()[0].attrs['aria-checked'], 'false', 'a new workbench visit resets the switch')
  const resetStart = await startAndRead(3)
  assert.equal(resetStart.config.demoEnhance, false)
})

test('records filter and mode labels cover window recordings', async () => {
  const windowProject = projectSummary({ id: 'project-window', name: 'WindowRecording_demo', mode: 'window', width: 1280, height: 720 })
  const { api } = createApi(workbenchState({ recent: [projectSummary(), windowProject] }))
  const harness = createHarness({ electronAPI: api })
  harness.run('renderRecording()')
  await harness.settle()

  assert.match(harness.dom.view.innerHTML, /data-testid="records-filter-window"/)
  const filterOptions = queryAll(harness.dom, '[data-testid="records-filter-window"]')
  assert.equal(filterOptions.length, 1)
  assert.equal(filterOptions[0].tagName, 'option')
  assert.equal(filterOptions[0].attrs.value, 'window')
  // A window project is labelled as a window, not as a display recording.
  assert.match(harness.dom.view.innerHTML, /\u7a97\u53e3 \u00b7 1280\u00d7720/, 'window mode label is used in the card detail')

  const filter = queryAll(harness.dom, '[data-testid="records-filter"]')[0]
  filter.value = 'window'
  filter.onchange()
  // The filter redraws only #recordingRecordsHost, so read it directly (the fake
  // DOM does not remove the previous children from the outer page string).
  const host = harness.dom.document.getElementById('recordingRecordsHost')
  assert.equal((host.innerHTML.match(/data-testid="record-card"/g) || []).length, 1)
  assert.match(host.innerHTML, /data-project-id="project-window"/)
})

test('the workbench styles stay on the shared token ladder', () => {
  for (const selector of ['.rec-mode-card', '.rec-display', '.rec-card', '.rec-live-banner', '.rec-error', '.rec-field']) {
    assert.ok(styleSource.includes(selector), `${selector} is styled`)
  }
  assert.doesNotMatch(styleSource, /\.rec-[^{]*\{[^}]*#[0-9a-fA-F]{3,8}\b/, 'the workbench does not hardcode hex colours')
  assert.match(styleSource, /\.rec-live-banner\{[^}]*var\(--danger-soft\)/)
  assert.match(styleSource, /\.rec-records-grid\{[^}]*grid-template-columns:repeat\(auto-fill/)
})
