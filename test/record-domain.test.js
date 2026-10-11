const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
const recordDomainSource = fs.readFileSync(path.join(root, 'main/domains/record/index.js'), 'utf8')

test('main.js delegates record domain instead of inlining recording windows and IPC', () => {
  assert.match(main, /require\('\.\/main\/domains\/record'\)/)
  assert.match(main, /createRecordDomain\(\{/)
  assert.match(main, /recordDomain\s*=\s*createRecordDomain/)
  assert.doesNotMatch(main, /function createRecordWindow\(/)
  assert.doesNotMatch(main, /function closeRecordFlow\(/)
  assert.doesNotMatch(main, /function requireRecordSender\(/)
  assert.doesNotMatch(main, /const recordingIpcController/)
  assert.doesNotMatch(main, /let recordWindow = null/)
})

test('main.js routes record ownership through the domain', () => {
  assert.match(main, /recordDomain\?\.ownsControlWindow\(win\)/)
  assert.match(main, /recordDomain\?\.ownsFrameWindow\(win\)/)
  assert.match(main, /recordDomain\?\.isTaskActive\(\)/)
  assert.match(main, /recordDomain\.createRecordWindow\(/)
  assert.match(main, /recordDomain\.createRecordingController\(\)/)
  assert.match(main, /recordDomain\.shutdown\(\)/)
})

test('record domain owns window lifecycle, annotation routing, and MP4 save', () => {
  assert.match(recordDomainSource, /function createRecordWindow/)
  assert.match(recordDomainSource, /function createRecordingController/)
  assert.match(recordDomainSource, /function requireRecordSender/)
  assert.match(recordDomainSource, /function requireRecordFrameSender/)
  assert.match(recordDomainSource, /function sendRecordAnnotationCommand/)
  assert.match(recordDomainSource, /saveMp4/)
  assert.match(recordDomainSource, /setContentProtection\(true\)/)
})

// Shared harness: the record domain needs a window whose session can register the
// display-media handler (P0-3-T2) and a settings object carrying the frozen audio keys.
function createRecordHarness() {
  const { createRecordDomain } = require('../main/domains/record')
  const created = []
  const domain = createRecordDomain({
    app: { getPath: () => path.join(root, 'tmp-videos') },
    desktopCapturer: {
      getSources: async () => [{ id: 'screen:1', display_id: '1', thumbnail: { isEmpty: () => false } }]
    },
    path,
    screen: {
      getDisplayMatching: () => ({ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }),
      getDisplayNearestPoint: () => ({ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } })
    },
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
    BrowserWindow: { fromWebContents: () => null },
    rootDirectory: root,
    createLocalWindow: (pagePath) => {
      const win = {
        pagePath,
        isDestroyed: () => false,
        setAlwaysOnTop: () => {},
        setContentProtection: () => {},
        setIgnoreMouseEvents: () => {},
        setBounds: () => {},
        show: () => {},
        showInactive: () => {},
        hide: () => {},
        close: () => {},
        loadFile: () => Promise.resolve(),
        on: () => {},
        webContents: {
          send: () => {},
          session: {
            setDisplayMediaRequestHandler: (handler) => { win.displayMediaHandler = handler }
          }
        }
      }
      created.push(win)
      return win
    },
    getSettings: () => ({
      record: {
        frameRate: 24,
        saveDirectory: '',
        audioSystem: true,
        audioMicrophone: false,
        audioSystemGain: 1,
        audioMicrophoneGain: 1
      }
    }),
    log: () => {},
    assertGameModeDisabled: () => {},
    assertManagedDataWritable: () => {},
    getRecordingService: () => ({
      transcode: () => Promise.resolve('out.mp4'),
      cleanupSession: async () => true
    }),
    managedRecordingWriters: {
      track: async (fn) => (typeof fn === 'function' ? fn() : fn),
      assertOpen: () => {}
    },
    makeCaptureName: (prefix) => `${prefix}-test.png`,
    VIDEO_CAPTURE_PREFIX: 'video',
    performanceMonitor: { record: () => {}, snapshot: () => {} }
  })
  return { created, domain }
}

test('record domain factory tracks control and frame window ownership', async () => {
  const { created, domain } = createRecordHarness()

  assert.equal(domain.ownsControlWindow(null), false)
  assert.equal(domain.ownsFrameWindow(null), false)
  assert.equal(domain.isTaskActive(), false)

  const control = await domain.createRecordWindow({
    selectionBounds: { x: 10, y: 10, width: 200, height: 150 }
  })
  assert.ok(control)
  assert.equal(domain.ownsControlWindow(control), true)
  assert.equal(domain.isTaskActive(), true)
  assert.equal(created.length, 2, 'the frame and control windows are both created')
})

test('the record window registers the display-media handler and carries the frozen audio keys (P0-3-T2)', async () => {
  const { created, domain } = createRecordHarness()
  const control = await domain.createRecordWindow({
    selectionBounds: { x: 10, y: 10, width: 200, height: 150 }
  })

  // The handler is registered on the record window's own session, and it must honour the
  // renderer's audioRequested flag: a "system sound off" recording has to stay track-free.
  assert.equal(typeof control.displayMediaHandler, 'function', 'the display-media handler is registered')

  const withAudio = await new Promise((resolve) => {
    control.displayMediaHandler({ videoRequested: true, audioRequested: true }, resolve)
  })
  assert.equal(withAudio.video.id, 'screen:1', 'the display is picked by display id')
  assert.equal(withAudio.audio, process.platform === 'win32' ? 'loopback' : undefined)

  const withoutAudio = await new Promise((resolve) => {
    control.displayMediaHandler({ videoRequested: true, audioRequested: false }, resolve)
  })
  assert.equal(withoutAudio.video.id, 'screen:1')
  assert.equal('audio' in withoutAudio, false, 'no audio track is offered when the renderer did not ask')

  const noVideo = await new Promise((resolve) => {
    control.displayMediaHandler({ videoRequested: false, audioRequested: true }, resolve)
  })
  assert.deepEqual(noVideo, {})

  // The four frozen keys reach the renderer so it stops relying on its own fallbacks.
  assert.deepEqual(
    {
      audioSystem: control._recordInit.audioSystem,
      audioMicrophone: control._recordInit.audioMicrophone,
      audioSystemGain: control._recordInit.audioSystemGain,
      audioMicrophoneGain: control._recordInit.audioMicrophoneGain
    },
    { audioSystem: true, audioMicrophone: false, audioSystemGain: 1, audioMicrophoneGain: 1 }
  )
  assert.equal(created.length, 2)
})

test('saving an MP4 forwards the audio option derived from the frozen record keys (P0-3-T3/T4)', () => {
  // The transcode call itself is exercised end-to-end by test/recording-service.test.js; what
  // this asserts is that the domain derives the option from the frozen keys rather than
  // hard-coding `-an`, which is what would silently export a silent MP4.
  assert.match(
    recordDomainSource,
    /service\.transcode\(sessionId, result\.filePath, \(elapsedMicroseconds\) => \{[\s\S]{0,220}?\}, \{ audio: !!\(settings\.record\.audioSystem \|\| settings\.record\.audioMicrophone\) \}\)/,
    'the save path must forward { audio } built from the frozen record keys'
  )
})

