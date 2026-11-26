'use strict'

// U04 (docs/reviews/2026-11-26-code-review-and-optimization-report.md §4.4):
//   §4.4-1  application blacklist reaches the C++ clipboard fallback and terminals
//           are protected from the synthesized Ctrl+C; BackupClipboard skips
//           synthesized formats before its raised format cap.
//   §4.4-2  the single global `processing` lock is replaced by per-window stream
//           controllers: two result windows can stream at once, a hidden unpinned
//           window finishes its round in the background, and a pinned long round
//           no longer blocks a new selection / local action / new result window.
//   §4.4-5  Ctrl+Enter paste waits 600 ms for the modifier release and reuses a
//           still-held Ctrl when the target window already owns focus.
//
// Behaviour-first: the host runs the real utility-process source in a VM with a
// fake native hook, and the domain runs with fake windows/IPC. C++ and Rust cannot
// run from node:test, so their contracts are pinned by source assertions; the paste
// batch shape is additionally covered by `cargo test --manifest-path
// native/clipboard/Cargo.toml` (paste::paste_batch_tests, 3 tests) whose run is
// recorded in the delivery report, not by this file.

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const {
  DEFAULT_SELECTION_TOOLBAR,
  DEFAULT_TOOLBAR_THINKING,
  TOOLBAR_ACTION_ORDER
} = require('../toolbar/toolbar-utils')
const { createDefaultAssignments, createDefaultProviders } = require('../main/services/ai-providers')
const {
  createSelectionDomain,
  TERMINAL_CLIPBOARD_COPY_PROTECTION,
  SELF_CLIPBOARD_COPY_PROTECTION,
  DEFAULT_CLIPBOARD_COPY_PROTECTION,
  resolveClipboardCopyProtection
} = require('../main/domains/selection')
const { registerSelectionIpc } = require('../main/ipc/selection-ipc')

const ROOT = path.resolve(__dirname, '..')
const HOST_PATH = path.join(ROOT, 'main/services/selection-hook-host.js')
const ENGINE_PATH = path.join(ROOT, 'vendor/selection-hook/src/windows/core/engine.cc')
const CLIPBOARD_CC_PATH = path.join(ROOT, 'vendor/selection-hook/src/windows/lib/clipboard.cc')
const PASTE_RS_PATH = path.join(ROOT, 'native/clipboard/src/paste.rs')
const TMP_CONVERSATIONS = path.join(ROOT, '.tmp', `u04-selection-lock-${process.pid}`)

const tick = () => new Promise((resolve) => setImmediate(resolve))
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
// Objects created inside the host VM realm have that realm's prototypes; compare
// plain data, never reference identity.
const plain = (value) => JSON.parse(JSON.stringify(value))

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  assert.ok(start >= 0, `missing source marker: ${startMarker}`)
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : -1
  return source.slice(start, end > start ? end : undefined)
}

// ---------------------------------------------------------------------------
// 1) utility-process host: serialize the application blacklist into the native
//    clipboard filter over the existing start/update-options channel.
// ---------------------------------------------------------------------------

function createHostFixture() {
  const port = new EventEmitter()
  port.posted = []
  port.postMessage = (message) => port.posted.push(message)
  const instances = []
  class FakeHook extends EventEmitter {
    constructor() {
      super()
      this.startConfigs = []
      this.clipboardModes = []
      this.enableCalls = []
      instances.push(this)
    }
    start(config) { this.startConfigs.push(config); return true }
    stop() {}
    cleanup() {}
    isRunning() { return true }
    setClipboardCoordinator() {}
    checkClipboardCoordinator() { return Promise.resolve(true) }
    enableClipboard() { this.enableCalls.push(true) }
    disableClipboard() { this.enableCalls.push(false) }
    setClipboardMode(mode, list) { this.clipboardModes.push({ mode, list }) }
  }
  const proc = new EventEmitter()
  proc.pid = 4242
  proc.parentPort = port
  vm.runInNewContext(fs.readFileSync(HOST_PATH, 'utf8'), {
    process: proc,
    require: (name) => {
      assert.equal(name, 'selection-hook', 'the host may only load the native hook module')
      return FakeHook
    },
    setTimeout
  })
  return {
    port,
    instances,
    hook: () => instances.at(-1),
    send: (message) => port.emit('message', message),
    outgoing: () => JSON.parse(JSON.stringify(port.posted.filter((message) => message && message.type !== 'ready')))
  }
}

test('U04 host forwards the application blacklist to the native clipboard filter', () => {
  const host = createHostFixture()
  host.send({
    type: 'start',
    options: {
      debug: false,
      enableClipboard: true,
      clipboardExcludedApps: ['KeePass.exe', ' windowsterminal.exe ', 'x', 'x', 42, '']
    }
  })
  const hook = host.hook()
  assert.deepEqual(plain(hook.startConfigs), [{
    debug: false,
    enableClipboard: true,
    // selection-hook FilterMode.EXCLUDE_LIST. The list is normalized in the host
    // exactly like the native ProcessStringArrayToList path: lowercase, trimmed,
    // deduplicated, non-strings dropped.
    clipboardMode: 2,
    clipboardFilterList: ['keepass.exe', 'windowsterminal.exe', 'x']
  }], 'the blacklist rides the existing host start channel as a serialized array')
  // No new message type is introduced: the parent still only sends start/update-options.
  assert.deepEqual([...new Set(host.outgoing().map((message) => message.type))].sort(), ['status'])

  hook.clipboardModes.length = 0
  host.send({
    type: 'update-options',
    options: { enableClipboard: false, clipboardExcludedApps: ['CONHOST.EXE', 'cmd.exe'] }
  })
  assert.deepEqual(plain(hook.clipboardModes), [{ mode: 2, list: ['conhost.exe', 'cmd.exe'] }])
  assert.deepEqual(hook.enableCalls, [false])
})

test('U04 host keeps the native filter untouched when no blacklist is configured', () => {
  const host = createHostFixture()
  host.send({ type: 'start', options: { debug: false, enableClipboard: true } })
  assert.deepEqual(plain(host.hook().startConfigs), [{ debug: false, enableClipboard: true }],
    'an old parent that sends no list keeps the previous native behavior (ABI/initialization compatible)')
  // Malformed update input must not throw or install a filter.
  const hook = host.hook()
  hook.clipboardModes.length = 0
  host.send({ type: 'update-options', options: { clipboardExcludedApps: 'cmd.exe' } })
  host.send({ type: 'update-options', options: { clipboardExcludedApps: null } })
  assert.deepEqual(hook.clipboardModes, [])
})

test('U04 the rebuilt native addon accepts the serialized exclude-list mode', { skip: process.platform !== 'win32' }, () => {
  const SelectionHook = require('selection-hook')
  const hook = new SelectionHook()
  try {
    assert.equal(
      hook.setClipboardMode(SelectionHook.FilterMode.EXCLUDE_LIST, DEFAULT_CLIPBOARD_COPY_PROTECTION),
      true,
      'the mode/list pair the host serializes is valid for the shipped native API'
    )
  } finally {
    hook.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 2) main-process protection list and C++/Rust source contracts.
// ---------------------------------------------------------------------------

function nativeSourceProtectionNames() {
  const cpp = fs.readFileSync(ENGINE_PATH, 'utf8')
  const block = sliceBetween(cpp, 'const std::vector<std::string> &ClipboardCopyProtection()', 'return programs;')
  return [...block.matchAll(/"([a-z0-9][a-z0-9_.-]*)"/g)].map((match) => match[1]).sort()
}

test('U04 terminal/self protection is always present and merged with the user blacklist', () => {
  const withUserList = resolveClipboardCopyProtection({ clipboard: { excludedApps: ['KeePass.exe', 'keepass.exe'] } })
  assert.deepEqual(
    [...withUserList].sort(),
    [...new Set([...DEFAULT_CLIPBOARD_COPY_PROTECTION, 'keepass.exe'])].sort()
  )
  assert.ok(withUserList.includes('keepass.exe'), 'the user blacklist is merged in')
  for (const terminal of ['windowsterminal.exe', 'openconsole.exe', 'conhost.exe', 'powershell.exe', 'pwsh.exe', 'cmd.exe', 'mintty.exe']) {
    assert.ok(withUserList.includes(terminal), `${terminal} is protected by default`)
  }
  for (const selfName of SELF_CLIPBOARD_COPY_PROTECTION) {
    assert.ok(withUserList.includes(selfName), `${selfName} (shouldFilterApp target) is protected by default`)
  }
  // A fresh install without any clipboard settings still protects the defaults.
  const defaults = resolveClipboardCopyProtection(undefined)
  assert.deepEqual([...defaults].sort(), [...DEFAULT_CLIPBOARD_COPY_PROTECTION].sort())
  assert.equal(new Set(defaults).size, defaults.length, 'the protection list is deduplicated')

  // And the domain actually serializes it into the hook start options.
  const { domain, hook, state } = createHarness()
  domain.initSelectionHook()
  assert.deepEqual(
    [...hook.options.startOptions.clipboardExcludedApps].sort(),
    resolveClipboardCopyProtection(state.settings).sort()
  )
})

test('U04 JS protection list and the compiled engine.cc list stay in sync', () => {
  assert.deepEqual(nativeSourceProtectionNames(), [...DEFAULT_CLIPBOARD_COPY_PROTECTION].sort(),
    'main/domains/selection/index.js and engine.cc must protect the same programs')
})

test('U04 C++ refuses clipboard copy injection for a protected terminal before any transaction', () => {
  const engine = fs.readFileSync(ENGINE_PATH, 'utf8')
  assert.match(engine, /bool MatchesProgramList\(const std::wstring &programName, const std::vector<std::string> &programList\)/)

  const shouldProcess = sliceBetween(
    engine,
    'bool SelectionEngine::ShouldProcessViaClipboard(const std::wstring &programName) const',
    'bool result = false;'
  )
  assert.match(shouldProcess, /MatchesProgramList\(programName, ClipboardCopyProtection\(\)\)/,
    'the fallback gate rejects protected terminals before the configured filter list')
  assert.match(shouldProcess, /return false;/)

  // "Check the target process immediately before injecting the copy": the second
  // guard must precede the clipboard transaction and both synthesized shortcuts.
  const clipboardFn = sliceBetween(
    engine,
    'bool SelectionEngine::GetTextViaClipboard(HWND hwnd, TextSelectionInfo &selectionInfo)',
    'bool SelectionEngine::SendCopyKey'
  )
  const guardAt = clipboardFn.indexOf('ClipboardCopyProtection()')
  const transactionAt = clipboardFn.indexOf('ClipboardTransaction transaction')
  const ctrlInsertAt = clipboardFn.indexOf('SendCopyKey(CopyKeyType::CtrlInsert)')
  const ctrlCAt = clipboardFn.indexOf('SendCopyKey(CopyKeyType::CtrlC)')
  assert.ok(guardAt >= 0, 'the injection path re-checks the protected program list')
  assert.ok(guardAt < transactionAt, 'the guard runs before the clipboard transaction')
  assert.ok(guardAt < ctrlInsertAt, 'the guard runs before Ctrl+Insert injection')
  assert.ok(guardAt < ctrlCAt, 'the guard runs before Ctrl+C injection')
  // The existing degradation is unchanged: no copy is injected and no clipboard
  // fallback result is reported - the function simply returns false.
  assert.match(clipboardFn, /if \(MatchesProgramList\([\s\S]{0,200}?\)\)\s*\n\s*return false;/)
})

test('U04 BackupClipboard skips synthesized formats before its raised 256-format cap', () => {
  const source = fs.readFileSync(CLIPBOARD_CC_PATH, 'utf8')
  const backupBody = sliceBetween(source, 'bool BackupClipboard(ClipboardBackup &backup, bool isClipboardOpened)', 'return GetLastError()')
  const hardAbortAt = backupBody.indexOf('format >= CF_PRIVATEFIRST')
  const skipAt = backupBody.indexOf('if (IsSkippedFormat(format))')
  const capAt = backupBody.indexOf('if (++formats > 256) return false;')
  assert.ok(hardAbortAt >= 0 && skipAt > hardAbortAt,
    'lossless-abort formats are still rejected before anything is cleared')
  assert.ok(skipAt >= 0 && capAt > skipAt,
    'synthesized/non-backupable formats are skipped before the format budget is charged')
  assert.doesNotMatch(backupBody, /formats > 64\)/, 'the old 64-format cap is gone')
})

test('U04 paste.rs reuses a held Ctrl and only reports FOCUS_OR_KEYS_BUSY after 600ms', () => {
  const source = fs.readFileSync(PASTE_RS_PATH, 'utf8')
  assert.match(source, /const MODIFIER_RELEASE_WAIT: Duration = Duration::from_millis\(600\)/)
  assert.match(source, /let deadline = Instant::now\(\) \+ MODIFIER_RELEASE_WAIT;/,
    'the modifier-release scan uses the widened window')
  assert.match(source, /fn released_except_control\(\) -> bool/)
  assert.match(source, /if ctrl_held\(\) && released_except_control\(\) \{\s*\n\s*reuse_held_ctrl = true;/, 
    'a still-held Ctrl is reused once focus is ready and other keys are up')
  assert.match(source, /let batch = paste_batch\(reuse_held_ctrl\)/)
  assert.match(source, /if reuse_held_ctrl \{\s*\n\s*if !ctrl_held\(\) \|\| !released_except_control\(\) \{\s*\n\s*return Ok\(copied_only\("FOCUS_CHANGED"\)\);/,
    'a Ctrl released between the scan and SendInput still fails closed instead of typing a bare V')
  assert.match(source, /return Ok\(copied_only\("FOCUS_OR_KEYS_BUSY"\)\);/,
    'the original failure code still means "focus or keys busy after the wait window"')
  // `cargo test --manifest-path native/clipboard/Cargo.toml` compiles the batch
  // builder: 33 library tests pass, including the three paste_batch_tests.
  assert.match(source, /mod paste_batch_tests/)
})

// ---------------------------------------------------------------------------
// 3) fake-window harness for the selection domain / IPC.
// ---------------------------------------------------------------------------

function createFakeWindow(pagePath, options = {}) {
  const listeners = new Map()
  const win = {
    pagePath,
    options,
    destroyed: false,
    visible: false,
    focused: false,
    bounds: { x: options.x || 0, y: options.y || 0, width: options.width || 0, height: options.height || 0 },
    webContents: {
      sent: [],
      once() {},
      send(channel, payload) { this.sent.push([channel, payload]) },
      isDestroyed: () => false,
      isCrashed: () => false
    },
    isDestroyed: () => win.destroyed,
    isVisible: () => win.visible,
    isFocused: () => win.focused,
    loadFile: () => Promise.resolve(),
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
      return win
    },
    emit(event, ...args) {
      for (const listener of [...(listeners.get(event) || [])]) listener(...args)
    },
    setVisibleOnAllWorkspaces() {},
    setAlwaysOnTop() {},
    setResizable() {},
    setSize(width, height) { win.bounds.width = width; win.bounds.height = height },
    getSize: () => [win.bounds.width, win.bounds.height],
    setPosition(x, y) { win.bounds.x = x; win.bounds.y = y },
    setBounds(bounds) { win.bounds = { ...bounds } },
    getBounds: () => ({ ...win.bounds }),
    getContentBounds: () => ({ ...win.bounds }),
    show() { win.visible = true },
    showInactive() { win.visible = true },
    hide() { win.visible = false; win.focused = false },
    focus() { win.focused = true },
    close() { win.emit('close'); win.destroyed = true; win.emit('closed') },
    destroy() { if (!win.destroyed) { win.destroyed = true; win.emit('closed') } }
  }
  return win
}

function enableToolbarAi(state) {
  state.settings.providers = [{
    id: 'deepseek',
    name: 'DeepSeek',
    enabled: true,
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-u04',
    protocol: 'openai-chat',
    models: [{ id: 'deepseek-v4-flash', name: 'Flash' }]
  }]
  state.settings.apiKey = ''
  state.settings.ai = {
    targetLanguage: '中文',
    assignments: [
      { feature: 'toolbar:explain', providerId: 'deepseek', model: 'deepseek-v4-flash' },
      { feature: 'chat', providerId: 'deepseek', model: 'deepseek-v4-flash' }
    ]
  }
}

function createHarness(overrides = {}) {
  const providers = createDefaultProviders()
  const state = {
    settings: {
      apiKey: '',
      providers,
      selectionToolbar: {
        ...DEFAULT_SELECTION_TOOLBAR,
        order: [...TOOLBAR_ACTION_ORDER, 'open'],
        conversation: { enabled: true, persist: false }
      },
      toolbarThinking: { ...DEFAULT_TOOLBAR_THINKING },
      system: { gameMode: false },
      ai: { assignments: createDefaultAssignments(providers), targetLanguage: '中文' },
      clipboard: { enabled: false, excludedApps: ['keepass.exe'] }
    },
    windows: [],
    trayRefreshes: 0,
    routes: [],
    logs: [],
    clipboardWrites: [],
    openedUrls: [],
    powerListeners: new Map()
  }
  const hook = { options: null, started: [], suspended: [], disposed: 0, startOptionsPatches: [] }
  const domain = createSelectionDomain({
    BrowserWindow: { fromWebContents: () => null },
    clipboard: { writeText: (value) => { state.clipboardWrites.push(value) } },
    shell: { openExternal: (url) => { state.openedUrls.push(url); return Promise.resolve() } },
    nativeTheme: { shouldUseDarkColors: false },
    screen: {
      getCursorScreenPoint: () => ({ x: 400, y: 300 }),
      getDisplayNearestPoint: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      screenToDipPoint: (point) => point,
      dipToScreenRect: (_source, rect) => rect
    },
    powerMonitor: {
      on(event, listener) { state.powerListeners.set(event, listener) },
      removeListener(event) { state.powerListeners.delete(event) }
    },
    utilityProcess: {},
    createLocalWindow: (pagePath, options) => {
      const win = createFakeWindow(pagePath, options)
      state.windows.push(win)
      return win
    },
    rootDirectory: ROOT,
    isWin: false,
    getSettings: () => state.settings,
    updateSettings: () => {},
    createTrayIcon: () => { state.trayRefreshes += 1 },
    createMainWindow: (route) => { state.routes.push(route) },
    getPinDomain: () => ({ releasePinnedSlot: () => {}, MAX_PINNED: 3, canPinMore: () => true }),
    isGameModeEnabled: () => state.settings.system.gameMode === true,
    shouldFilterApp: (name) => String(name || '').toLowerCase().includes('highlighter'),
    conversationsDirectory: TMP_CONVERSATIONS,
    actionWindowReleaseMs: overrides.actionWindowReleaseMs,
    log: (...args) => state.logs.push(args),
    createHookService: (options) => {
      hook.options = options
      return {
        host: null,
        start: (reason) => { hook.started.push(reason) },
        suspend: (reason) => { hook.suspended.push(reason) },
        updateStartOptions: (patch) => { hook.startOptionsPatches.push(patch) },
        notePowerEvent: () => {},
        onLifecycle: () => () => {},
        dispose: () => { hook.disposed += 1 }
      }
    }
  })
  // Production assembly creates the store at startup; the harness mirrors that so
  // the background-completion save path is exercised.
  domain.ensureConversationStore()
  return { domain, state, hook }
}

function stubToolbarStream(factory) {
  const routerPath = require.resolve('../main/services/ai-feature-router')
  const previous = require.cache[routerPath]
  require.cache[routerPath] = {
    id: routerPath,
    filename: routerPath,
    loaded: true,
    exports: { createToolbarActionStream: factory }
  }
  return () => {
    if (previous) require.cache[routerPath] = previous
    else delete require.cache[routerPath]
  }
}

function createFakeIpcMain() {
  const listeners = new Map()
  return {
    listeners,
    on(name, listener) { listeners.set(name, listener) },
    handle() {}
  }
}

async function waitFor(predicate, { attempts = 100, delay = 10 } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return true
    await sleep(delay)
  }
  return predicate()
}

// ---------------------------------------------------------------------------
// 4) per-window stream controllers: no global single `processing` slot.
// ---------------------------------------------------------------------------

test('U04 two result windows stream independently and cancel per window', () => {
  const { domain } = createHarness()
  const streams = domain.createIpcController().streams
  const winA = domain.getOrCreateActionWindow()
  winA._isPinned = true
  const winB = domain.getOrCreateActionWindow() // pinned A forces a second window
  assert.notEqual(winB, winA)

  const controllerA = streams.create(winA, 11)
  const controllerB = streams.create(winB, 12)
  assert.equal(domain.isProcessing(), true)
  assert.equal(streams.getCurrent(), controllerB)
  assert.equal(streams.isWindowStreaming(winA), true)
  assert.equal(streams.isWindowStreaming(winB), true)

  // Sender routing is per window now: B's stream id is stale for A, A's own is not.
  assert.equal(streams.isCurrentSender({ sender: winA.webContents }), true)
  assert.equal(streams.isCurrentSender({ sender: winB.webContents }), true)
  assert.equal(streams.isStaleSignal({ sender: winA.webContents }, 12), true)
  assert.equal(streams.isStaleSignal({ sender: winA.webContents }, 11), false)

  // cancelStreamForWindow keeps its meaning: it cancels exactly that window's round.
  assert.equal(domain.cancelStreamForWindow(winA, 'user-cancelled'), true)
  assert.equal(controllerA.cancelled, true)
  assert.equal(controllerA.cancelReason, 'user-cancelled')
  assert.equal(controllerB.cancelled, false, 'the other window keeps streaming')
  assert.equal(streams.isWindowStreaming(winB), true)
  assert.equal(domain.isProcessing(), true)

  assert.equal(domain.cancelStreamForWindow(winB, 'user-cancelled'), true)
  assert.equal(controllerB.cancelled, true)
  assert.equal(domain.isProcessing(), false, 'each finished round leaves the map')
})

test('U04 one window keeps a single live round, so a replacement cancels the old one', () => {
  const { domain } = createHarness()
  const streams = domain.createIpcController().streams
  const win = domain.getOrCreateActionWindow()
  const first = streams.create(win, 1)
  const second = streams.create(win, 2)
  assert.equal(first.cancelled, true, 'the per-window serialization cancels the replaced round')
  assert.equal(first.cancelReason, 'replaced')
  assert.equal(second.cancelled, false)
  assert.equal(streams.getCurrent(), second)
  assert.equal(domain.isProcessing(), true)
  second.finish()
  assert.equal(domain.isProcessing(), false)
})

test('U04 renderer stream signals are routed to the sending window only', () => {
  const { domain } = createHarness()
  const streams = domain.createIpcController().streams
  const ipcMain = createFakeIpcMain()
  registerSelectionIpc({ ipcMain, controller: domain.createIpcController() })
  const winA = domain.getOrCreateActionWindow()
  winA._isPinned = true
  const winB = domain.getOrCreateActionWindow()
  const controllerA = streams.create(winA, 21)
  const controllerB = streams.create(winB, 22)

  // A stale id from B (21 belongs to A) is ignored.
  ipcMain.listeners.get('stream:cancel')({ sender: winB.webContents }, 21)
  assert.equal(controllerB.cancelled, false)
  assert.equal(controllerA.cancelled, false)

  // A valid cancel targets the sender's own round, not "the current" one.
  ipcMain.listeners.get('stream:cancel')({ sender: winA.webContents }, 21)
  assert.equal(controllerA.cancelled, true)
  assert.equal(controllerB.cancelled, false)
  ipcMain.listeners.get('stream:finish')({ sender: winB.webContents }, 22)
  assert.equal(controllerB.cancelled, true)
  assert.equal(domain.isProcessing(), false)
})

test('U04 a pinned long round does not block a new selection or a new result window', async (t) => {
  const { domain, state } = createHarness()
  enableToolbarAi(state)
  const streams = domain.createIpcController().streams
  const winA = domain.getOrCreateActionWindow()
  winA._isPinned = true
  winA.show()
  const controllerA = streams.create(winA, 31) // simulates the long-running pinned round

  // A new selection is no longer suppressed by the global "busy" flag.
  domain.handleTextSelection({ text: 'new selection', programName: 'chrome.exe' })
  const toolbar = state.windows.at(-1)
  assert.equal(toolbar.visible, true, 'the toolbar shows while another window is generating')

  const restore = stubToolbarStream(async function* emptyStream() {})
  t.after(restore)
  const windowsBefore = state.windows.length
  assert.equal(await domain.openToolbarAiAction('explain', 'new selection'), true)
  assert.equal(state.windows.length, windowsBefore + 1, 'a new Q&A opens a new result window')
  const newWin = state.windows.at(-1)
  assert.notEqual(newWin, winA)
  const start = newWin._pendingActionMessages.find(([channel]) => channel === 'action:start')
  assert.ok(start, 'the new window receives its action:start')
  assert.equal(start[1].text, 'new selection')
  assert.equal(controllerA.cancelled, false, 'the pinned round keeps running')
  assert.equal(streams.isWindowStreaming(winA), true)
  controllerA.cancel('test-cleanup')
})

test('U04 an unpinned streaming window is not reused for a new round', async (t) => {
  const { domain, state } = createHarness()
  enableToolbarAi(state)
  const streams = domain.createIpcController().streams
  const win = domain.getOrCreateActionWindow()
  win.show()
  const busy = streams.create(win, 41)
  const restore = stubToolbarStream(async function* emptyStream() {})
  t.after(restore)
  const windowsBefore = state.windows.length
  assert.equal(await domain.openToolbarAiAction('explain', 'text'), true)
  assert.equal(state.windows.length, windowsBefore + 1, 'the busy window is not commandeered')
  assert.notEqual(state.windows.at(-1), win)
  assert.equal(busy.cancelled, false)
  busy.cancel('test-cleanup')
})

// ---------------------------------------------------------------------------
// 5) local actions + background completion.
// ---------------------------------------------------------------------------

test('U04 local toolbar actions are no longer gated by another window\'s round', () => {
  const { domain, state } = createHarness()
  const streams = domain.createIpcController().streams
  const ipcMain = createFakeIpcMain()
  registerSelectionIpc({ ipcMain, controller: domain.createIpcController() })
  const win = domain.getOrCreateActionWindow()
  const controller = streams.create(win, 51) // another window is generating

  ipcMain.listeners.get('toolbar:action')({}, { action: 'copy', text: 'copy me' })
  assert.deepEqual(state.clipboardWrites, ['copy me'], 'copy works while a round is running')
  ipcMain.listeners.get('toolbar:action')({}, { action: 'search', text: 'query' })
  assert.equal(state.openedUrls.length, 1, 'search works while a round is running')
  assert.equal(controller.cancelled, false)
  controller.cancel('test-cleanup')
})

test('U04 blur hides the unpinned window but the round finishes in the background and is saved', async (t) => {
  fs.rmSync(TMP_CONVERSATIONS, { recursive: true, force: true })
  t.after(() => fs.rmSync(TMP_CONVERSATIONS, { recursive: true, force: true }))
  const { domain, state } = createHarness()
  enableToolbarAi(state)
  state.settings.selectionToolbar.conversation = { enabled: true, persist: true }
  const streams = domain.createIpcController().streams
  let releaseStream
  const gate = new Promise((resolve) => { releaseStream = resolve })
  const restore = stubToolbarStream(async () => {
    await gate
    return (async function* oneChunk() {
      yield { choices: [{ delta: { content: '后台完成' } }] }
    })()
  })
  t.after(restore)

  const opening = domain.openToolbarAiAction('explain', '原始文本')
  await tick()
  const win = domain.getActionWindow()
  const controller = streams.getCurrent()
  assert.ok(win && controller)
  win.show()
  assert.equal(win.visible, true)

  // Unpinned blur hides the window; it must NOT abort the round any more.
  win.emit('blur')
  assert.equal(win.visible, false, 'the unpinned window still hides on blur')
  assert.equal(controller.cancelled, false, 'blur no longer cancels the round')
  assert.equal(domain.isProcessing(), true)

  releaseStream()
  assert.equal(await opening, true)
  assert.equal(await waitFor(() => !domain.isProcessing()), true, 'the round completed while hidden')
  assert.equal(controller.cancelled, false)
  assert.equal(controller.finished, true)

  // The finished background round was written to the ConversationStore.
  const saved = domain.createIpcController().conversations.get(win)
  assert.ok(saved, 'the live conversation map keeps the background window')
  const filePath = path.join(TMP_CONVERSATIONS, `${saved.conversationId}.json`)
  assert.equal(await waitFor(() => fs.existsSync(filePath)), true,
    'a round that finished while the window was hidden is persisted')
  const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  assert.equal(stored.firstResult, '后台完成', 'the hidden round persisted its answer')
  assert.equal(win.destroyed, false, 'a hidden window is only destroyed by its idle reclaimer')
})

test('U04 a hidden window whose round outlived its reclaimer is reclaimed once the round finishes', async (t) => {
  const { domain } = createHarness({ actionWindowReleaseMs: 30 })
  const streams = domain.createIpcController().streams
  const win = domain.getOrCreateActionWindow()
  win.show()
  const controller = streams.create(win, 61)
  win.emit('blur')
  assert.equal(win.visible, false)
  await sleep(80) // the 30ms idle timer fired while the round was still live: skipped
  assert.equal(win.destroyed, false, 'an in-flight round owns the hidden window')
  controller.finish()
  assert.equal(await waitFor(() => win.destroyed, { attempts: 60, delay: 10 }), true,
    'finishing the round re-arms the idle reclaim for the hidden window')
})

// ---------------------------------------------------------------------------
// 6) domain start options code path (hook receives the serialized protection).
// ---------------------------------------------------------------------------

test('U04 the domain start options carry terminals plus the user blacklist', () => {
  const { domain, hook, state } = createHarness()
  state.settings.clipboard = { enabled: false, excludedApps: ['keepass.exe'] }
  domain.initSelectionHook()
  const apps = hook.options.startOptions.clipboardExcludedApps
  assert.ok(Array.isArray(apps))
  for (const terminal of TERMINAL_CLIPBOARD_COPY_PROTECTION) assert.ok(apps.includes(terminal))
  assert.ok(apps.includes('keepass.exe'))
  assert.equal(new Set(apps).size, apps.length)
  assert.ok(apps.every((name) => name === name.toLowerCase()))

  // And the serialized array is exactly what the host turns into the native filter.
  const host = createHostFixture()
  host.send({ type: 'start', options: hook.options.startOptions })
  assert.deepEqual(plain(host.hook().startConfigs[0].clipboardFilterList), apps)
  assert.equal(host.hook().startConfigs[0].clipboardMode, 2)
})

test('U04 a runtime blacklist change is re-sent to the host on the next selection', () => {
  const { domain, hook, state } = createHarness()
  domain.initSelectionHook()
  const initial = hook.options.startOptions.clipboardExcludedApps
  assert.ok(initial.includes('keepass.exe'), 'the harness ships one excluded app')

  // The user edits the clipboard exclusion list while the hook is running; the
  // settings-effects layer does not know about this list, so the next selection
  // refreshes it instead of leaving the native filter stale until a restart.
  state.settings.clipboard.excludedApps = ['onedrive.exe']
  domain.handleTextSelection({ text: 'hello', programName: 'chrome.exe' })
  assert.equal(hook.startOptionsPatches.length, 1)
  const sent = hook.startOptionsPatches[0].clipboardExcludedApps
  assert.ok(sent.includes('onedrive.exe'))
  assert.equal(sent.includes('keepass.exe'), false, 'removed apps stop being excluded')
  assert.deepEqual(sent, resolveClipboardCopyProtection(state.settings))

  // Unchanged lists are not re-sent on every selection.
  domain.handleTextSelection({ text: 'again', programName: 'chrome.exe' })
  assert.equal(hook.startOptionsPatches.length, 1)
})
