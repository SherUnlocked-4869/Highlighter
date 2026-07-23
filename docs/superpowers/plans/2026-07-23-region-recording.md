# Region Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add screenshot-selection region recording with a protected recording frame, three-second countdown, pause/resume, disk-backed preview, and MP4-only export.

**Architecture:** The capture renderer submits a validated screen-space rectangle to the main process. A protected recording window crops the matching desktop stream through Canvas and writes MediaRecorder WebM chunks to a main-process recording service; the same window switches to preview after stop, and the service uses packaged FFmpeg to export H.264 MP4. Existing full-display recording reuses this pipeline by passing the display bounds as the selection.

**Tech Stack:** Electron 33, Node.js, MediaRecorder, Canvas CaptureStream, `ffmpeg-static`, Node test runner, electron-builder.

---

## File Map

- Create `record/recording-utils.js`: pure selection, crop, FPS, state, source-selection, and FFmpeg argument helpers.
- Create `main/services/recording-service.js`: session directories, ordered chunk writes, FFmpeg conversion, progress, cancellation, and cleanup.
- Create `record/frame.html`: protected color-changing selection frame.
- Create `preload-record-frame.js`: narrow frame-state IPC bridge.
- Create `record/record.css`: recording control and preview styles.
- Modify `capture/capture.html`: add the region-recording button.
- Modify `capture/capture.js`: submit live selection bounds without exporting screenshot pixels.
- Modify `preload-capture.js`: expose the region-recording request.
- Modify `record/record.html`: replace the current compact-only markup with control and preview views.
- Modify `record/record.js`: implement stream cropping, recording states, ordered chunks, and preview behavior.
- Modify `preload-record.js`: expose session, frame, save, and close IPC methods.
- Modify `main.js`: resolve desktop sources, create protected windows, validate senders, register recording IPC, and clean up sessions.
- Modify `package.json` and `package-lock.json`: install/package FFmpeg and include new files in checks.
- Modify `config/config.js`: constrain FPS values to the supported set while preserving the existing save directory.
- Create `test/recording-utils.test.js`: pure recording behavior.
- Create `test/recording-service.test.js`: disk and FFmpeg lifecycle using injected fakes.
- Create `test/region-recording-entry.test.js`: capture and preload wiring.
- Create `test/recording-ui-contract.test.js`: recording views, IPC channels, frame, and packaging contract.

## Task 1: Package FFmpeg as an Application Runtime

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `test/recording-ui-contract.test.js`

- [ ] **Step 1: Write the failing packaging contract test**

Create `test/recording-ui-contract.test.js`:

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

test('recording runtime packages ffmpeg', () => {
  assert.match(packageJson.dependencies['ffmpeg-static'], /^\^5\./)
  assert.ok(packageJson.build.asarUnpack.includes('node_modules/ffmpeg-static/**/*'))
})
```

- [ ] **Step 2: Run the test and verify RED**

Run: `rtk node --test test/recording-ui-contract.test.js`

Expected: FAIL because `ffmpeg-static` and its unpacking rule are absent.

- [ ] **Step 3: Install FFmpeg and update packaging**

Run: `rtk npm install ffmpeg-static@^5.2.0`

Add the FFmpeg binary to `build.asarUnpack` without removing the existing screenshot-desktop rule:

```json
"asarUnpack": [
  "node_modules/screenshot-desktop/lib/win32/**/*",
  "node_modules/ffmpeg-static/**/*"
]
```

Add new JavaScript files to `scripts.check` only in the task that creates each file. Do not add assertions for future files to this task.

- [ ] **Step 4: Verify the dependency is installed**

Run: `rtk npm ls ffmpeg-static --depth=0`

Expected: one installed `ffmpeg-static@5.x` dependency and exit code 0.

- [ ] **Step 5: Run the packaging contract and verify GREEN**

Run: `rtk node --test test/recording-ui-contract.test.js`

Expected: the packaging contract passes.

- [ ] **Step 6: Commit the packaging foundation**

```powershell
rtk git add package.json package-lock.json test/recording-ui-contract.test.js
rtk git commit -m "build: package ffmpeg for video export"
```

## Task 2: Define Selection, Crop, State, and FFmpeg Contracts

**Files:**
- Create: `record/recording-utils.js`
- Create: `test/recording-utils.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write the failing pure behavior tests**

Create `test/recording-utils.test.js` with tests for the desired public API:

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildFfmpegArgs,
  calculateCropRect,
  normalizeFrameRate,
  normalizeSelectionBounds,
  pickDesktopSource,
  transitionRecordingState
} = require('../record/recording-utils')

test('normalizes FPS to the supported PixPin-compatible set', () => {
  for (const fps of [5, 16, 24, 30, 60]) assert.equal(normalizeFrameRate(fps), fps)
  assert.equal(normalizeFrameRate(25), 24)
  assert.equal(normalizeFrameRate('60'), 60)
})

test('clips a negative-coordinate selection to one display', () => {
  assert.deepEqual(
    normalizeSelectionBounds(
      { x: -1900, y: 20, width: 640, height: 361 },
      { x: -1920, y: 0, width: 1920, height: 1080 }
    ),
    { x: -1900, y: 20, width: 640, height: 361 }
  )
  assert.throws(() => normalizeSelectionBounds(
    { x: 0, y: 0, width: 15, height: 100 },
    { x: 0, y: 0, width: 1920, height: 1080 }
  ), /至少 16/)
})

test('maps DIP selection to even video pixels', () => {
  assert.deepEqual(calculateCropRect(
    { width: 3840, height: 2160 },
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 100, y: 50, width: 641, height: 361 }
  ), { sx: 200, sy: 100, sw: 1282, sh: 722, width: 1282, height: 722 })
})

test('selects the desktop source matching the display id', () => {
  const sources = [{ display_id: '1', id: 'screen:1' }, { display_id: '2', id: 'screen:2' }]
  assert.equal(pickDesktopSource(sources, 2).id, 'screen:2')
  assert.equal(pickDesktopSource([{ display_id: '', id: 'fallback' }], 9).id, 'fallback')
})

test('accepts only declared recording state transitions', () => {
  assert.equal(transitionRecordingState('idle', 'start'), 'countdown')
  assert.equal(transitionRecordingState('countdown', 'countdown-finished'), 'recording')
  assert.equal(transitionRecordingState('recording', 'pause'), 'paused')
  assert.equal(transitionRecordingState('paused', 'resume'), 'recording')
  assert.equal(transitionRecordingState('recording', 'stop'), 'preview')
  assert.equal(transitionRecordingState('preview', 'save'), 'saving')
  assert.equal(transitionRecordingState('saving', 'save-failed'), 'preview')
  assert.throws(() => transitionRecordingState('idle', 'pause'), /非法录制状态转换/)
})

test('builds silent H.264 fast-start MP4 arguments', () => {
  const args = buildFfmpegArgs('input.webm', 'output.mp4')
  assert.deepEqual(args.slice(0, 2), ['-i', 'input.webm'])
  for (const token of ['-an', 'libx264', 'yuv420p', '+faststart', 'output.mp4']) {
    assert.ok(args.includes(token), token)
  }
})
```

- [ ] **Step 2: Run the test and verify RED**

Run: `rtk node --test test/recording-utils.test.js`

Expected: FAIL with `Cannot find module '../record/recording-utils'`.

- [ ] **Step 3: Implement the pure helper module**

Create `record/recording-utils.js` with these exports and no Electron imports:

```js
const SUPPORTED_FRAME_RATES = new Set([5, 16, 24, 30, 60])

function normalizeFrameRate(value) {
  const parsed = Number(value)
  return SUPPORTED_FRAME_RATES.has(parsed) ? parsed : 24
}

function normalizeSelectionBounds(selection, display) {
  const left = Math.max(Number(display.x), Number(selection.x))
  const top = Math.max(Number(display.y), Number(selection.y))
  const right = Math.min(Number(display.x) + Number(display.width), Number(selection.x) + Number(selection.width))
  const bottom = Math.min(Number(display.y) + Number(display.height), Number(selection.y) + Number(selection.height))
  const result = {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top)
  }
  if (result.width < 16 || result.height < 16) throw new Error('录制区域宽高至少为 16 像素')
  return result
}

function even(value) {
  return Math.max(16, Math.floor(Number(value) / 2) * 2)
}

function calculateCropRect(video, display, selection) {
  const scaleX = Number(video.width) / Number(display.width)
  const scaleY = Number(video.height) / Number(display.height)
  const sx = Math.round((selection.x - display.x) * scaleX)
  const sy = Math.round((selection.y - display.y) * scaleY)
  const sw = even(selection.width * scaleX)
  const sh = even(selection.height * scaleY)
  return { sx, sy, sw, sh, width: sw, height: sh }
}

function pickDesktopSource(sources, displayId) {
  return sources.find((source) => String(source.display_id) === String(displayId)) || sources[0] || null
}

const TRANSITIONS = {
  idle: { start: 'countdown', cancel: 'cancelled' },
  countdown: { 'countdown-finished': 'recording', cancel: 'idle' },
  recording: { pause: 'paused', stop: 'preview', cancel: 'cancelled' },
  paused: { resume: 'recording', stop: 'preview', cancel: 'cancelled' },
  preview: { save: 'saving', rerecord: 'countdown', cancel: 'cancelled' },
  saving: { saved: 'saved', 'save-failed': 'preview' }
}

function transitionRecordingState(state, event) {
  const next = TRANSITIONS[state]?.[event]
  if (!next) throw new Error(`非法录制状态转换：${state} -> ${event}`)
  return next
}

function buildFfmpegArgs(inputPath, outputPath) {
  return ['-i', inputPath, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', outputPath]
}

const recordingUtils = {
  buildFfmpegArgs,
  calculateCropRect,
  normalizeFrameRate,
  normalizeSelectionBounds,
  pickDesktopSource,
  transitionRecordingState
}

if (typeof module !== 'undefined' && module.exports) module.exports = recordingUtils
if (typeof window !== 'undefined') window.recordingUtils = recordingUtils
```

- [ ] **Step 4: Run tests and verify GREEN**

Run: `rtk node --test test/recording-utils.test.js`

Expected: all recording utility tests pass.

- [ ] **Step 5: Add the helper and test to syntax checks**

Append `node --check record/recording-utils.js` and `node --check test/recording-utils.test.js` to `scripts.check`.

Run: `rtk npm run check`

Expected: exit code 0.

- [ ] **Step 6: Commit the recording contract**

```powershell
rtk git add record/recording-utils.js test/recording-utils.test.js package.json
rtk git commit -m "test: define region recording contracts"
```

## Task 3: Implement Disk-Backed Recording Sessions

**Files:**
- Create: `main/services/recording-service.js`
- Create: `test/recording-service.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing service lifecycle tests**

Define the desired service API using a temporary directory and injected fake process runner:

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { RecordingService } = require('../main/services/recording-service')

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'highlighter-recording-test-'))
}

test('writes chunks in call order and finalizes a preview file', async () => {
  const root = await tempRoot()
  const service = new RecordingService({ tempRoot: root, ffmpegPath: 'ffmpeg' })
  const session = await service.startSession()
  await Promise.all([
    service.appendChunk(session.id, Buffer.from('one')),
    service.appendChunk(session.id, Buffer.from('two'))
  ])
  const preview = await service.finishSession(session.id)
  assert.equal((await fs.readFile(preview.inputPath)).toString(), 'onetwo')
  await service.dispose()
})

test('keeps input but deletes partial MP4 when conversion fails', async () => {
  const root = await tempRoot()
  const fakeSpawn = () => {
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    queueMicrotask(() => child.emit('close', 1))
    return child
  }
  const service = new RecordingService({ tempRoot: root, ffmpegPath: 'ffmpeg', spawnProcess: fakeSpawn })
  const session = await service.startSession()
  await service.appendChunk(session.id, Buffer.from('webm'))
  await service.finishSession(session.id)
  const output = path.join(root, 'failed.mp4')
  await assert.rejects(() => service.transcode(session.id, output), /MP4 转码失败/)
  assert.equal(await fs.readFile(session.inputPath, 'utf8'), 'webm')
  await assert.rejects(() => fs.access(output))
  await service.dispose()
})
```

Also add tests that `cleanupSession()` removes its directory and `dispose()` terminates an active child process.

- [ ] **Step 2: Run the tests and verify RED**

Run: `rtk node --test test/recording-service.test.js`

Expected: FAIL because the service module does not exist.

- [ ] **Step 3: Implement `RecordingService`**

Implement a class with this public contract:

```js
class RecordingService {
  constructor({ tempRoot, ffmpegPath, spawnProcess, log })
  async startSession()
  async appendChunk(sessionId, buffer)
  async finishSession(sessionId)
  async transcode(sessionId, outputPath, onProgress)
  async cleanupSession(sessionId)
  async dispose()
}
```

Implementation requirements:

- Use `crypto.randomUUID()` for session directory names.
- Store sessions in a `Map` with `{ id, directory, inputPath, writeQueue, process }`.
- Implement ordered append as `session.writeQueue = session.writeQueue.then(() => fs.appendFile(...))`.
- `finishSession()` awaits `writeQueue`, verifies a non-empty `capture.webm`, and returns `{ id, inputPath, previewUrl: pathToFileURL(inputPath).href }`.
- `transcode()` uses `buildFfmpegArgs()`, captures stderr, emits bounded progress values when `time=` is available, and rejects on non-zero exit.
- On failure, remove only the incomplete output; keep the input session for preview/retry.
- `cleanupSession()` kills an active process and recursively removes only that exact session directory.
- `dispose()` cleans every known session and never removes `tempRoot` itself.

- [ ] **Step 4: Run service tests and verify GREEN**

Run: `rtk node --test test/recording-service.test.js`

Expected: all lifecycle, ordering, failure, and cleanup tests pass.

- [ ] **Step 5: Add service files to syntax checks and run the suite**

Add both files to `scripts.check`.

Run: `rtk npm test`

Expected: all existing and new tests pass.

- [ ] **Step 6: Commit the service**

```powershell
rtk git add main/services/recording-service.js test/recording-service.test.js package.json
rtk git commit -m "feat: add disk-backed recording sessions"
```

## Task 4: Add the Screenshot Toolbar Entry

**Files:**
- Modify: `capture/capture.html`
- Modify: `capture/capture.js`
- Modify: `preload-capture.js`
- Create: `test/region-recording-entry.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write a failing renderer wiring test**

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')
const script = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const preload = fs.readFileSync(path.join(root, 'preload-capture.js'), 'utf8')

test('capture toolbar exposes region recording for a selected rectangle', () => {
  assert.match(html, /id="record"[^>]+title="区域录制"/)
  assert.match(script, /performAction\('record'\)/)
  assert.match(script, /captureAPI\.startRegionRecording\(selectionBounds\)/)
  assert.match(preload, /startRegionRecording:[\s\S]*capture:start-region-recording/)
})
```

- [ ] **Step 2: Run the test and verify RED**

Run: `rtk node --test test/region-recording-entry.test.js`

Expected: all four assertions fail because the entry is absent.

- [ ] **Step 3: Add the toolbar button and IPC bridge**

Insert this button between translate and pin:

```html
<button id="record" title="区域录制">●</button>
```

Add to `preload-capture.js`:

```js
startRegionRecording: (selectionBounds) => ipcRenderer.invoke(
  'capture:start-region-recording',
  { selectionBounds }
),
```

Refactor `performAction()` so it builds the screen-space rectangle before exporting screenshot pixels, then handles recording as a special live-screen action:

```js
const captureBounds = initData.captureBounds || initData.displayBounds || { x: 0, y: 0 }
const selectionBounds = {
  x: Math.round(captureBounds.x + selection.x),
  y: Math.round(captureBounds.y + selection.y),
  width: Math.max(1, Math.round(selection.w)),
  height: Math.max(1, Math.round(selection.h))
}
if (action === 'record') {
  await window.captureAPI.startRegionRecording(selectionBounds)
  return
}
const output = exportSelectionCanvas(!recognitionActions.includes(action))
if (!output) return
const dataUrl = output.toDataURL('image/png')
const meta = {
  source: initData.source,
  width: output.width,
  height: output.height,
  scaleFactor: initData.scaleFactor,
  selectionBounds
}
```

Bind `document.getElementById('record').onclick = () => performAction('record')`. Disable the button from `updateFloatingUi()` whenever `selection.w < 16 || selection.h < 16`.

- [ ] **Step 4: Run entry and regression tests**

Run: `rtk node --test test/region-recording-entry.test.js test/selection-toolbar-settings.test.js`

Expected: both suites pass.

- [ ] **Step 5: Add the new test to syntax checks and commit**

```powershell
rtk git add capture/capture.html capture/capture.js preload-capture.js test/region-recording-entry.test.js package.json
rtk git commit -m "feat: add region recording capture action"
```

## Task 5: Orchestrate Protected Recording Windows and IPC

**Files:**
- Modify: `main.js`
- Create: `record/frame.html`
- Create: `preload-record-frame.js`
- Modify: `preload-record.js`
- Modify: `test/recording-ui-contract.test.js`
- Modify: `package.json`

- [ ] **Step 1: Extend the failing UI contract test**

Read `main.js`, both preloads, and `record/frame.html`; assert the exact IPC and protection contracts:

```js
test('main process wires protected region recording windows', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const recordPreload = fs.readFileSync(path.join(root, 'preload-record.js'), 'utf8')
  const framePreload = fs.readFileSync(path.join(root, 'preload-record-frame.js'), 'utf8')
  const frame = fs.readFileSync(path.join(root, 'record', 'frame.html'), 'utf8')

  assert.match(main, /capture:start-region-recording/)
  assert.match(main, /setContentProtection\(true\)/)
  assert.match(main, /record:start-session/)
  assert.match(main, /record:append-chunk/)
  assert.match(main, /record:finish-session/)
  assert.match(main, /record:save-mp4/)
  assert.match(recordPreload, /startSession:/)
  assert.match(recordPreload, /appendChunk:/)
  assert.match(framePreload, /record-frame:state/)
  assert.match(frame, /data-state="idle"/)
})
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `rtk node --test test/recording-ui-contract.test.js`

Expected: FAIL on missing frame file and IPC channels.

- [ ] **Step 3: Add lazy recording service initialization**

In `main.js`, import `RecordingService`, recording helpers, and `ffmpeg-static`. Resolve packaged FFmpeg with:

```js
function resolveFfmpegPath() {
  const candidate = require('ffmpeg-static')
  return app.isPackaged ? candidate.replace('app.asar', 'app.asar.unpacked') : candidate
}
```

Create the service lazily after Electron is ready using `path.join(app.getPath('userData'), 'temp', 'recordings')`.

- [ ] **Step 4: Resolve the correct desktop source**

Add `getDesktopSource(display)` using `desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })` and `pickDesktopSource()`. Do not reuse `getDisplayCapture()` because its Windows screenshot fallback returns a non-Electron `native:*` identifier.

- [ ] **Step 5: Create and position the protected windows**

Refactor `createRecordWindow({ display, selectionBounds })` to:

- Close an existing recording flow before creating a new one.
- Normalize the selection against the display.
- Create a transparent frame window at the selection bounds using `record/frame.html` and `preload-record-frame.js`.
- Set frame and control windows to always-on-top, skip-taskbar, and `setContentProtection(true)`.
- Set the frame window to `setIgnoreMouseEvents(true)`.
- Place the 440x86 control below or above the selection, clamped to `display.workArea`.
- Store `{ sourceId, displayBounds, selectionBounds, frameRate }` in `_recordInit`.
- For the existing `videoRecord` action, call the same function with `selectionBounds: display.bounds`.

- [ ] **Step 6: Add sender-validated IPC handlers**

Add handlers for:

```text
capture:start-region-recording
record:start-session
record:append-chunk
record:finish-session
record:save-mp4
record:cancel-session
record:set-frame-state
record:resize-preview
record:restart
record:close
```

Every `record:*` handler must verify `BrowserWindow.fromWebContents(event.sender) === recordWindow`. The capture handler must verify the sender is `currentCaptureWindow`, resolve the display from the submitted rectangle, close the capture window only after recording windows are ready, and return `true`.

`record:save-mp4` shows a `.mp4` save dialog, keeps preview on cancellation, forwards conversion progress to `record:save-progress`, removes a partial output on failure, and cleans the session after success.

- [ ] **Step 7: Implement frame state rendering**

`preload-record-frame.js` listens for `record-frame:state`. `record/frame.html` sets `document.body.dataset.state` and styles idle blue, recording red, and paused yellow borders.

- [ ] **Step 8: Add shutdown cleanup**

In the existing app shutdown path, await or trigger `recordingService.dispose()`, close both windows, stop active conversion, and clear references. The recording window `closed` handler must clean its current session.

- [ ] **Step 9: Run contract and syntax checks**

Run: `rtk node --test test/recording-ui-contract.test.js`

Run: `rtk npm run check`

Expected: both pass.

- [ ] **Step 10: Commit orchestration**

```powershell
rtk git add main.js record/frame.html preload-record-frame.js preload-record.js test/recording-ui-contract.test.js package.json
rtk git commit -m "feat: orchestrate protected recording sessions"
```

## Task 6: Build the Recorder, Countdown, and Preview UI

**Files:**
- Modify: `record/record.html`
- Modify: `record/record.js`
- Create: `record/record.css`
- Modify: `preload-record.js`
- Modify: `test/recording-ui-contract.test.js`
- Modify: `package.json`

- [ ] **Step 1: Add failing recorder UI assertions**

Extend `test/recording-ui-contract.test.js`:

```js
test('recording UI contains control and preview states', () => {
  const html = fs.readFileSync(path.join(root, 'record', 'record.html'), 'utf8')
  const script = fs.readFileSync(path.join(root, 'record', 'record.js'), 'utf8')
  for (const id of ['controlView', 'countdown', 'start', 'pause', 'stop', 'previewView', 'preview', 'saveMp4', 'rerecord']) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
  assert.match(script, /canvas\.captureStream\(frameRate\)/)
  assert.match(script, /video\/webm/)
  assert.match(script, /appendChunk/)
  assert.match(script, /transitionRecordingState/)
})
```

- [ ] **Step 2: Run the test and verify RED**

Run: `rtk node --test test/recording-ui-contract.test.js`

Expected: FAIL because preview and new controls do not exist.

- [ ] **Step 3: Replace the recording markup and styles**

Build two sibling views:

- `#controlView`: status dot, `#time`, `#fps`, `#countdown`, and start/pause/stop/cancel/close buttons.
- `#previewView`: `<video id="preview" controls>`, duration, save MP4, rerecord, and close buttons.

Load `recording-utils.js` before `record.js`, then move inline styles into `record/record.css`. Keep compact controls at stable dimensions, use an 8px maximum radius, and ensure the preview window works down to 720x480. `record.js` reads helpers from `window.recordingUtils`; it does not use `require()`.

- [ ] **Step 4: Implement stream crop and recording lifecycle**

In `record/record.js`:

1. Receive `{ sourceId, displayBounds, selectionBounds, frameRate }`.
2. Acquire desktop video with `audio: false` and the configured min/max frame rate.
3. Wait for video metadata and call `calculateCropRect()`.
4. Size the hidden Canvas to the even output dimensions.
5. Draw the selected source rectangle on every animation frame.
6. Call `canvas.captureStream(frameRate)` and create a video-only MediaRecorder using VP9, VP8, then WebM fallback.
7. Call `recordAPI.startSession()` immediately before `recorder.start(1000)`.
8. Chain every `dataavailable` call through `recordAPI.appendChunk(sessionId, arrayBuffer)`.
9. On stop, await the append chain, call `finishSession()`, stop all tracks, hide the frame, resize to preview, and set the returned `previewUrl` on the video.

- [ ] **Step 5: Implement the state-driven controls**

- Start moves `idle -> countdown`, shows 3/2/1, then starts the recorder and moves to recording.
- Cancel during countdown returns to idle without creating a session.
- Pause/resume calls MediaRecorder and updates frame state.
- Stop from recording or paused finalizes preview.
- Cancel while recording stops tracks, cancels the session, and closes.
- Rerecord clears the video source, cleans the previous session, returns to the compact control size, reacquires the desktop stream, and starts another three-second countdown using the same selection.
- Save invokes `saveMp4(sessionId, durationMs)`, displays `record:save-progress`, and closes only after a non-empty output path is returned.
- A failed save returns to preview with an inline error and leaves the session retryable.

- [ ] **Step 6: Run UI contract and full tests**

Run: `rtk node --test test/recording-ui-contract.test.js test/recording-utils.test.js test/recording-service.test.js`

Expected: all pass.

Run: `rtk npm test`

Expected: the complete suite passes.

- [ ] **Step 7: Commit the recorder UI**

```powershell
rtk git add record/record.html record/record.js record/record.css preload-record.js test/recording-ui-contract.test.js package.json
rtk git commit -m "feat: record and preview selected screen regions"
```

## Task 7: Constrain Recording Settings and Harden Errors

**Files:**
- Modify: `config/config.js`
- Modify: `main.js`
- Modify: `record/record.js`
- Modify: `test/recording-ui-contract.test.js`

- [ ] **Step 1: Write failing settings and error contract assertions**

Assert that the function settings expose exactly the supported FPS values, no audio control is introduced, and recorder UI contains inline error/progress elements:

```js
test('region recording uses supported silent MP4 settings', () => {
  const config = fs.readFileSync(path.join(root, 'config', 'config.js'), 'utf8')
  const recordHtml = fs.readFileSync(path.join(root, 'record', 'record.html'), 'utf8')
  assert.match(config, /5.*16.*24.*30.*60/)
  assert.doesNotMatch(recordHtml, /microphone|麦克风|系统声音/i)
  assert.match(recordHtml, /id="recordError"/)
  assert.match(recordHtml, /id="saveProgress"/)
})
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `rtk node --test test/recording-ui-contract.test.js`

Expected: FAIL on missing supported values and feedback elements.

- [ ] **Step 3: Normalize settings and user-facing errors**

- Render FPS options for 5, 16, 24, 30, and 60; continue to store the selected numeric value in `record.frameRate`.
- Normalize invalid stored FPS through `normalizeFrameRate()` before passing init data.
- Add clear errors for desktop source, getUserMedia, MediaRecorder, chunk write, missing FFmpeg, and conversion failures.
- Keep preview and retry enabled after conversion failure.
- Disable duplicate actions during countdown transition, finalization, and saving.

- [ ] **Step 4: Run full automated verification**

Run: `rtk npm test`

Expected: all tests pass with zero failures.

Run: `rtk npm run check`

Expected: exit code 0 with no syntax errors.

- [ ] **Step 5: Commit settings and hardening**

```powershell
rtk git add config/config.js main.js record/record.js record/record.html test/recording-ui-contract.test.js
rtk git commit -m "fix: harden silent MP4 recording flow"
```

## Task 8: Desktop Smoke Test and Portable Verification

**Files:**
- Modify only if verification reveals a defect in files already listed above.

- [ ] **Step 1: Run the application**

Run: `rtk npm start`

Expected: Highlighter starts without console errors and the tray remains available.

- [ ] **Step 2: Verify the primary region flow**

On the main display:

1. Start screenshot capture and choose a region larger than 16x16.
2. Confirm “区域录制” appears between translate and pin.
3. Click it and confirm the screenshot overlay disappears.
4. Confirm blue border/control placement and a 3-second countdown.
5. Record motion, pause, wait, resume, and stop.
6. Confirm preview duration excludes paused time and controls play/seek.
7. Save MP4 and confirm progress completes.

- [ ] **Step 3: Verify dimensions and codec**

Run:

```powershell
rtk ffprobe -v error -show_entries stream=codec_name,codec_type,width,height,pix_fmt -of json <saved-file.mp4>
```

Expected: one video stream with `codec_name: h264`, even width/height, compatible pixel format, and no audio stream.

- [ ] **Step 4: Verify edge flows**

- Cancel during countdown.
- Cancel active recording.
- Stop and choose rerecord.
- Cancel the save dialog and then save successfully.
- Test a negative-coordinate secondary display and a display with non-100% scaling.
- Confirm border/control/countdown never appear in output.
- Confirm closing preview removes the session directory.

- [ ] **Step 5: Build the portable application**

Run: `rtk npm run build:win:portable`

Expected: exit code 0 and `dist/Highlighter-2.0.0-portable.exe` exists.

- [ ] **Step 6: Verify packaged FFmpeg**

Launch the portable executable, record a short region, preview it, and save MP4 on the packaged build.

Expected: export succeeds without relying on the system `ffmpeg` command.

- [ ] **Step 7: Run final repository verification**

Run: `rtk npm test`

Run: `rtk npm run check`

Run: `rtk git diff --check`

Run: `rtk git status --short --branch`

Expected: tests and checks pass, diff check is empty, and only intentional changes remain before the final commit.

- [ ] **Step 8: Handle any verification defect through TDD**

If smoke testing reveals a defect, return to the relevant task, add a failing regression test, verify RED, apply the smallest fix, run the full suite, and commit the exact affected files with `rtk git commit -m "fix: stabilize packaged region recording"`. If no files changed, do not create an empty commit.
