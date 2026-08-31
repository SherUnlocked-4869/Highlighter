const path = require('path')
const { pathToFileURL } = require('url')
const {
  getSecureWindowRegistration,
  isAllowedLocalUrl
} = require('./window-security')

const IPC_SURFACES = Object.freeze([
  {
    role: 'main',
    page: 'config/config.html',
    handles: [
      'shell:open-external',
      'app:execute-function',
      'app:get-info',
      'app:get-display-diagnostics',
      'diagnostics:preview',
      'diagnostics:export',
      'update:status',
      'update:check',
      'update:download',
      'update:install',
      'update:open-download-page',
      'dialog:choose-directory',
      'app:open-data-directory',
      'app:open-save-directory',
      'ai:complete',
      'ai:translate',
      'data-root:get',
      'data-root:open',
      'data-root:change',
      'history:list',
      'history:thumbnail',
      'history:sources',
      'history:stats',
      'history:delete',
      'history:delete-many',
      'history:clear',
      'history:cleanup',
      'history:export',
      'history:copy',
      'history:edit',
      'history:open',
      'history:copy-path',
      'settings:get',
      'settings:update',
      'settings:reset',
      'config:test-connection',
      'shortcuts:status',
      'ocr:status',
      'search:status'
    ],
    listeners: ['window:minimize', 'window:close']
  },
  {
    role: 'toolbar',
    page: 'toolbar/toolbar.html',
    listeners: ['toolbar:action']
  },
  {
    role: 'action',
    page: 'action/action.html',
    handles: ['shell:open-external'],
    listeners: ['stream:cancel', 'stream:finish', 'window:toggle-pin']
  },
  {
    role: 'capture',
    page: 'capture/capture.html',
    handles: [
      'capture:start-region-recording',
      'capture:start-long',
      'capture:smart-select',
      'capture:copy',
      'capture:pin',
      'capture:pin-reannotate',
      'capture:open-recognition',
      'capture:record-history',
      'capture:ocr',
      'capture:translate',
      'settings:update'
    ],
    listeners: [
      'capture:ready',
      'capture:render-ready',
      'capture:render-error',
      'capture:close',
      'capture:save'
    ]
  },
  {
    role: 'long-capture',
    page: 'long-capture/long-capture.html',
    handles: [
      'long-capture:add-strip',
      'long-capture:set-trim',
      'long-capture:set-selection-editing',
      'long-capture:finish'
    ],
    listeners: [
      'long-capture:ready',
      'long-capture:overlay-active',
      'long-capture:close'
    ]
  },
  {
    role: 'long-overlay',
    page: 'long-capture/overlay.html',
    listeners: ['long-overlay:ready', 'long-overlay:bounds-changed']
  },
  {
    role: 'pin',
    page: 'pin/pin.html',
    listeners: [
      'pin:ready',
      'pin:render-ready',
      'pin:close',
      'pin:copy',
      'pin:save',
      'pin:context-menu',
      'pin:resize',
      'pin:move-start',
      'pin:move',
      'pin:move-end',
      'pin:toggle-click-through'
    ]
  },
  {
    role: 'recognition',
    page: 'recognition/recognition.html',
    handles: ['shell:open-external', 'recognition:table', 'recognition:copy'],
    listeners: ['recognition:ready', 'recognition:close']
  },
  {
    role: 'search',
    page: 'search/search.html',
    handles: [
      'search:query',
      'search:status',
      'search:ensure-ready',
      'search:open-path',
      'search:reveal-path',
      'search:copy-path',
      'search:file-icon',
      'settings:update'
    ],
    listeners: ['search:ready', 'search:close']
  },
  {
    role: 'record',
    page: 'record/record.html',
    handles: [
      'record:set-annotation-command',
      'record:start-session',
      'record:append-chunk',
      'record:finish-session',
      'record:save-mp4',
      'record:cancel-session',
      'record:set-frame-state',
      'record:resize-preview',
      'record:restart'
    ],
    listeners: ['record:ready', 'record:performance', 'record:close']
  },
  {
    role: 'record-frame',
    page: 'record/frame.html',
    listeners: ['record-frame:ready', 'record-frame:snapshot']
  }
])

function buildIpcPolicies(rootDirectory) {
  if (typeof rootDirectory !== 'string' || !path.isAbsolute(rootDirectory)) {
    throw new TypeError('IPC security requires an absolute application root')
  }

  const policies = new Map()
  for (const surface of IPC_SURFACES) {
    const pagePath = path.resolve(rootDirectory, surface.page)
    for (const [kind, channels] of [
      ['handle', surface.handles || []],
      ['on', surface.listeners || []]
    ]) {
      for (const channel of channels) {
        const existing = policies.get(channel)
        if (existing && existing.kind !== kind) throw new Error(`IPC channel kind conflict: ${channel}`)
        const policy = existing || { channel, kind, pages: [] }
        policy.pages.push({ role: surface.role, pagePath })
        policies.set(channel, policy)
      }
    }
  }
  return policies
}

function sameLocalPath(left, right) {
  return isAllowedLocalUrl(pathToFileURL(left).href, [right])
}

function createSecureIpcMain({
  ipcMain,
  BrowserWindow,
  rootDirectory,
  authorizeRole = () => true,
  onBlocked = () => {}
}) {
  if (!ipcMain?.handle || !ipcMain?.on) throw new TypeError('IPC security requires ipcMain')
  if (typeof BrowserWindow?.fromWebContents !== 'function') {
    throw new TypeError('IPC security requires BrowserWindow.fromWebContents')
  }

  const policies = buildIpcPolicies(rootDirectory)
  const registrations = new Map()

  function deny(channel, reason, details = {}) {
    try { onBlocked({ channel, reason, ...details }) } catch {}
    return { allowed: false }
  }

  function authorize(channel, event) {
    const policy = policies.get(channel)
    const sender = event?.sender
    if (!sender || (typeof sender.isDestroyed === 'function' && sender.isDestroyed())) {
      return deny(channel, 'missing-or-destroyed-sender')
    }

    const senderFrame = event.senderFrame
    if (!senderFrame || senderFrame !== sender.mainFrame) return deny(channel, 'non-top-level-frame')

    const registration = getSecureWindowRegistration(sender)
    if (!registration) return deny(channel, 'unregistered-window')

    const win = BrowserWindow.fromWebContents(sender)
    if (!win || win !== registration.window || (typeof win.isDestroyed === 'function' && win.isDestroyed())) {
      return deny(channel, 'invalid-window-owner')
    }

    if (!isAllowedLocalUrl(senderFrame.url, [registration.pagePath])) {
      return deny(channel, 'sender-url-mismatch')
    }

    const allowedPage = policy.pages.find(({ pagePath }) => sameLocalPath(registration.pagePath, pagePath))
    if (!allowedPage) return deny(channel, 'page-not-allowed')

    let ownerAllowed = false
    try { ownerAllowed = authorizeRole(allowedPage.role, win, event) === true } catch {}
    if (!ownerAllowed) return deny(channel, 'window-owner-mismatch', { role: allowedPage.role, win })

    return { allowed: true, role: allowedPage.role, win }
  }

  function register(kind, channel, listener) {
    if (typeof channel !== 'string' || typeof listener !== 'function') {
      throw new TypeError('IPC registration requires a channel and listener')
    }
    const policy = policies.get(channel)
    if (!policy) throw new Error(`IPC channel has no sender policy: ${channel}`)
    if (policy.kind !== kind) throw new Error(`IPC channel uses the wrong registration kind: ${channel}`)
    if (registrations.has(channel)) throw new Error(`IPC channel registered more than once: ${channel}`)
    registrations.set(channel, kind)

    if (kind === 'handle') {
      ipcMain.handle(channel, (event, ...args) => {
        if (!authorize(channel, event).allowed) throw new Error('IPC sender not authorized')
        return listener(event, ...args)
      })
      return
    }

    ipcMain.on(channel, (event, ...args) => {
      if (!authorize(channel, event).allowed) return
      return listener(event, ...args)
    })
  }

  return {
    handle: (channel, listener) => register('handle', channel, listener),
    on: (channel, listener) => register('on', channel, listener),
    assertComplete() {
      const missing = [...policies.keys()].filter((channel) => !registrations.has(channel))
      if (missing.length) throw new Error(`IPC channels missing registrations: ${missing.join(', ')}`)
      return true
    }
  }
}

module.exports = {
  IPC_SURFACES,
  buildIpcPolicies,
  createSecureIpcMain
}
