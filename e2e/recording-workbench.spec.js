// Recording workbench end-to-end spec (R1–R3 acceptance, plan §9.1/§9.2).
//
// Why the synthetic capture source: this automation host cannot initialise DXGI desktop
// duplication, so EVERY getDisplayMedia() for a screen source fails with
// "Could not start video source" (verified with --enable-features=AllowWgcScreenCapturer
// and --disable-gpu as well). HIGHLIGHTER_E2E_FAKE_CAPTURE=1 is read by the MAIN process
// only (§13.5 of the contract) and makes the recorder build a canvas/oscillator stream
// instead; everything after that point - compositing, MediaRecorder, chunk sequencing,
// project sealing, probe, editor, trim, real FFmpeg export - is the product path.
//
// The spec is behavioural: it drives the workbench, the control bar and the editor as a
// user would, then checks the files that actually landed on disk. It also restarts the
// app over the same data root, which is the R1 headline promise.
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { test, expect } = require('./fixtures')
const { launchHighlighter } = require('./electron-app')

const FFMPEG_PATH = require('ffmpeg-static')

function dataRootBase() {
  const base = process.env.HIGHLIGHTER_E2E_DATA_ROOT_BASE
    ? path.resolve(process.env.HIGHLIGHTER_E2E_DATA_ROOT_BASE)
    : os.tmpdir()
  fs.mkdirSync(base, { recursive: true })
  return base
}

function createDataRoot() {
  return fs.mkdtempSync(path.join(dataRootBase(), 'highlighter-recording-'))
}

function probeDurationMs(filePath) {
  const result = spawnSync(FFMPEG_PATH, ['-hide_banner', '-i', filePath], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000
  })
  const text = `${result.stderr || ''}\n${result.stdout || ''}`
  const match = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!match) return null
  return Math.round((Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000)
}

// Full ffmpeg -i description of a produced file: duration, codec and pixel dimensions.
// The publish verification only proves the file is decodable; the spec additionally checks
// that the R4 export options actually reached the encoder (scale/fps/codec).
function probeVideo(filePath) {
  const result = spawnSync(FFMPEG_PATH, ['-hide_banner', '-i', filePath], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000
  })
  const text = `${result.stderr || ''}\n${result.stdout || ''}`
  const duration = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  const codec = text.match(/Video:\s*([a-z0-9_-]+)/i)
  const size = text.match(/(\d{2,5})x(\d{2,5})/)
  return {
    durationMs: duration
      ? Math.round((Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000)
      : null,
    codec: codec ? codec[1].toLowerCase() : '',
    width: size ? Number(size[1]) : 0,
    height: size ? Number(size[2]) : 0,
    hasAudio: /Audio:\s*[a-z0-9_-]+/i.test(text)
  }
}

// `#range-selection` renders the kept statistics as clocks ("kept ... source ..."). The
// editor translates the sentence, so positions are what the spec reads, not the wording.
function parseClockList(text) {
  const matches = String(text || '').match(/\d{1,2}:\d{2}(?:\.\d)?/g) || []
  return matches.map((value) => parseClockMs(value))
}

function parseClockMs(value) {
  const match = String(value || '').match(/^(\d+):(\d{2})(?:\.(\d))?$/)
  if (!match) return 0
  const tenths = match[3] ? Number(match[3]) : 0
  return (Number(match[1]) * 60 + Number(match[2])) * 1000 + tenths * 100
}

async function openWorkbench(highlighter) {
  const page = highlighter.mainWindow
  await page.locator('[data-route="recording"]').click()
  await page.locator('[data-testid="recording-workbench"]').waitFor({ state: 'visible', timeout: 20_000 })
  return page
}

// Console 'error' entries are collected by the harness. Third-party/Chromium noise is not a
// recording regression, so the spec reports them but only FAILS on pageerror/crash/main-console
// entries (a renderer uncaught exception or a crashed process is a real defect).
function hardErrors(errors) {
  return errors.filter((issue) => ['pageerror', 'page-crash', 'renderer', 'child', 'main-console'].includes(issue.type))
}

// Recording sources come out of MediaRecorder, whose WebM carries no duration header, so
// `video.duration` is Infinity until the browser fully scans the file. The editor therefore
// takes its timeline length from the PROBED metadata (plan §5.3 rule 2); the spec waits for
// that rendered value instead of trusting the element's duration.
function parseClockToMs(value) {
  const match = String(value || '').match(/^(\d+):(\d{2})(?:\.(\d))?$/)
  if (!match) return 0
  const tenths = match[3] ? Number(match[3]) : 0
  return (Number(match[1]) * 60 + Number(match[2])) * 1000 + tenths * 100
}

async function renderedDurationMs(page) {
  const value = await page.locator('#range-end-input').inputValue()
  return parseClockToMs(value)
}

async function waitForEditorReady(page) {
  await page.locator('#editor-root').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForFunction(() => {
    const video = document.querySelector('#preview-video')
    return !!video && video.readyState >= 1
  }, null, { timeout: 60_000 })
  await expect.poll(() => renderedDurationMs(page), { timeout: 60_000 }).toBeGreaterThan(0)
}


// ---------------------------------------------------------------------------
// R5 demo-finishing helpers: seed a real project (video + draft + event track)
// and measure exported frames pixel-wise so "styled/zoomed/rippled" is proven
// on the actual FFmpeg output rather than inferred from the request payload.
// ---------------------------------------------------------------------------
const sharp = require('sharp')

async function seedDemoProject(dataRoot, { style, zooms, events = null }) {
  const { createRecordingProjectService } = require('../main/services/recording-project-service')
  const { atomicWriteJson } = require('../main/services/data-root')
  const root = path.join(dataRoot, 'recordings')
  fs.mkdirSync(root, { recursive: true })
  const service = createRecordingProjectService({ root, atomicWriteJson })
  const created = await service.createProject({
    mode: 'display',
    captureConfig: {
      target: {
        mode: 'display', displayId: 'e2e-demo', displayName: 'E2E DEMO',
        boundsDip: { x: 0, y: 0, width: 320, height: 240 },
        pixelSize: { width: 320, height: 240 }, scaleFactor: 1
      },
      frameRate: 10, quality: 'standard', countdown: 0,
      audio: { system: true, microphone: false, microphoneDeviceId: '', systemGain: 1, microphoneGain: 1 }
    }
  })
  const videoPath = path.join(created.directory, 'capture.webm')
  const fixture = spawnSync(FFMPEG_PATH, [
    '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '3', '-vf', 'drawbox=x=136:y=96:w=48:h=48:color=red:t=fill',
    '-c:v', 'libvpx', '-c:a', 'libopus', '-y', videoPath
  ], { encoding: 'utf8', timeout: 30000, windowsHide: true })
  if (fixture.status !== 0) throw new Error(`demo fixture failed: ${fixture.stderr}`)
  const sealed = await service.sealProject(created.project.id, {
    metadata: {
      durationMs: 3000, startMs: 0, durationSource: 'container', timebase: 1000,
      video: { width: 320, height: 240, frameRate: 10 },
      audio: { tracks: 1, codec: 'opus' }
    },
    captureOutcome: { video: true, audio: { system: true, microphone: false }, warnings: [] }
  })
  if (!sealed?.ok) throw new Error(`demo seal failed: ${sealed?.code}`)
  const draft = await service.updateDraft(created.project.id, {
    expectedRevision: 1,
    edit: {
      keepRanges: [], format: 'mp4', gif: { edge: 1280, fps: 15 },
      style, zoomSegments: zooms
    }
  })
  if (!draft?.ok) throw new Error(`demo draft failed: ${draft?.code}`)
  if (events) {
    if (typeof service.writeEventTrack !== 'function') throw new Error('project service has no writeEventTrack')
    await service.writeEventTrack(created.project.id, events)
  }
  await service.dispose()
  return created.project.id
}

function extractFrame(filePath, atMs, outPath) {
  const result = spawnSync(FFMPEG_PATH, [
    '-loglevel', 'error', '-ss', (atMs / 1000).toFixed(3), '-i', filePath,
    '-frames:v', '1', '-y', outPath
  ], { encoding: 'utf8', timeout: 30000, windowsHide: true })
  if (result.status !== 0 || !fs.existsSync(outPath)) throw new Error(`frame extract failed at ${atMs}ms: ${result.stderr}`)
}

async function frameStats(pngPath) {
  const { data, info } = await sharp(pngPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height } = info
  let red = 0
  let white = 0
  let bright = 0
  let background = 0
  let redMinX = width
  let redMaxX = -1
  let redMinY = height
  let redMaxY = -1
  const isRed = (r, g, b) => r > 140 && g < 90 && b < 90
  const isWhite = (r, g, b) => r > 225 && g > 225 && b > 225
  const isBg = (r, g, b) => Math.abs(r - 10) <= 10 && Math.abs(g - 37) <= 10 && Math.abs(b - 64) <= 10
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      const r = data[offset]
      const g = data[offset + 1]
      const b = data[offset + 2]
      if (isRed(r, g, b)) {
        red += 1
        if (x < redMinX) redMinX = x
        if (x > redMaxX) redMaxX = x
        if (y < redMinY) redMinY = y
        if (y > redMaxY) redMaxY = y
      }
      if (isWhite(r, g, b)) white += 1
      if (r > 120 && Math.abs(r - g) < 30 && Math.abs(g - b) < 30) bright += 1
      if (isBg(r, g, b)) background += 1
    }
  }
  const cornerOffset = (2 * width + 2) * 4
  const corner = [data[cornerOffset], data[cornerOffset + 1], data[cornerOffset + 2]]
  return {
    width, height, red, white, bright, background, corner,
    redBox: redMaxX >= redMinX ? { width: redMaxX - redMinX + 1, height: redMaxY - redMinY + 1 } : null
  }
}

test.describe('recording workbench', () => {
  test('records, trims, exports, keeps the draft, and survives an app restart', { timeout: 240_000 }, async ({}, testInfo) => {
    const dataRoot = createDataRoot()
    const exportDir = path.join(dataRoot, 'exports')
    fs.mkdirSync(exportDir, { recursive: true })
    const firstExport = path.join(exportDir, 'recording-1.mp4')
    const artifactsDir = testInfo.outputPath('electron-artifacts')
    fs.mkdirSync(artifactsDir, { recursive: true })
    const consoleErrors = []

    let highlighter = await launchHighlighter({
      dataRoot,
      artifactsDir,
      extraEnv: { HIGHLIGHTER_E2E_FAKE_CAPTURE: '1' },
      savePaths: [firstExport]
    })

    try {
      // ---------- workbench: explicit display target, fastest options ----------
      const workbench = await openWorkbench(highlighter)
      await expect(workbench.locator('[data-testid="records-empty"]')).toBeVisible()
      await testInfo.attach('workbench.png', { body: await workbench.screenshot(), contentType: 'image/png' })
      await workbench.locator('[data-testid="mode-display"]').click()
      const displays = workbench.locator('[data-testid="display-option"]')
      expect(await displays.count()).toBeGreaterThan(0)
      await displays.first().click()
      await workbench.locator('[data-testid="countdown-select"]').selectOption('0')
      await workbench.locator('[data-testid="start-recording"]').click()

      // ---------- control bar: record -> pause -> resume -> finish ----------
      const control = await highlighter.waitForWindow('/record/record.html')
      await control.locator('[data-testid="control-bar"]').waitFor({ state: 'visible', timeout: 20_000 })
      await control.locator('[data-testid="start-record"]').click()
      await control.waitForFunction(() => document.body.dataset.state === 'recording', { timeout: 40_000 })
      await control.waitForTimeout(2600)
      const runningTimer = await control.locator('[data-testid="timer"]').textContent()
      expect(String(runningTimer).length).toBeGreaterThan(0)
      await testInfo.attach('control-bar.png', { body: await control.screenshot(), contentType: 'image/png' })

      await control.locator('[data-testid="pause-resume"]').click()
      await control.waitForFunction(() => document.body.dataset.state === 'paused', { timeout: 15_000 })
      const pausedTimer = await control.locator('[data-testid="timer"]').textContent()
      await control.waitForTimeout(900)
      expect(await control.locator('[data-testid="timer"]').textContent()).toBe(pausedTimer)
      await control.locator('[data-testid="pause-resume"]').click()
      await control.waitForFunction(() => document.body.dataset.state === 'recording', { timeout: 15_000 })
      await control.waitForTimeout(1300)

      await control.locator('[data-testid="finish-record"]').click()

      // ---------- editor: project window with the real media ----------
      const editor = await highlighter.waitForWindow('/record/editor.html', 60_000)
      await waitForEditorReady(editor)
      const durationMs = await renderedDurationMs(editor)
      expect(durationMs).toBeGreaterThan(2000)
      await expect.poll(() => highlighter.pagesMatching('/record/record.html').length, { timeout: 20_000 }).toBe(0)

      // Drag the end handle: one timeline, two handles, playhead untouched by trimming.
      const trackBox = await editor.locator('#timeline-track').boundingBox()
      const handleBox = await editor.locator('#handle-end').boundingBox()
      expect(trackBox).toBeTruthy()
      expect(handleBox).toBeTruthy()
      await editor.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
      await editor.mouse.down()
      await editor.mouse.move(trackBox.x + trackBox.width * 0.55, handleBox.y + handleBox.height / 2, { steps: 10 })
      await editor.mouse.up()
      // Let the debounced draft autosave land before comparing across a close/reopen.
      await editor.waitForTimeout(1200)
      const trimmedEnd = await editor.locator('#range-end-input').inputValue()
      expect(trimmedEnd.length).toBeGreaterThan(0)
      await expect(editor.locator('#save-state')).toContainText(/./, { timeout: 15_000 })
      await testInfo.attach('editor.png', { body: await editor.screenshot(), contentType: 'image/png' })

      // ---------- the single export entry point ----------
      await editor.locator('#export-button').click()
      await editor.locator('#result-bar').waitFor({ state: 'visible', timeout: 150_000 })
      expect(fs.existsSync(firstExport)).toBe(true)
      expect(fs.statSync(firstExport).size).toBeGreaterThan(2000)
      const exportedDuration = probeDurationMs(firstExport)
      expect(exportedDuration).not.toBeNull()
      expect(exportedDuration).toBeGreaterThan(400)
      expect(exportedDuration).toBeLessThan(durationMs + 1200)

      // ---------- closing the editor keeps the project and its draft ----------
      await editor.locator('#window-close').click()
      await expect.poll(() => highlighter.pagesMatching('/record/editor.html').length, { timeout: 20_000 }).toBe(0)
      const card = workbench.locator('[data-testid="record-card"]').first()
      await card.waitFor({ state: 'visible', timeout: 30_000 })
      await expect(card).toHaveAttribute('data-project-state', 'ready')
      await card.locator('[data-testid="card-edit"]').click()
      const reopened = await highlighter.waitForWindow('/record/editor.html', 30_000)
      await waitForEditorReady(reopened)
      expect(await reopened.locator('#range-end-input').inputValue()).toBe(trimmedEnd)

      // ---------- restart: same data root, project + draft still reachable ----------
      await reopened.locator('#window-close').click()
      await expect.poll(() => highlighter.pagesMatching('/record/editor.html').length, { timeout: 20_000 }).toBe(0)
      consoleErrors.push(...(await highlighter.getUnexpectedErrors()))
      await highlighter.close()

      highlighter = await launchHighlighter({
        dataRoot,
        artifactsDir,
        extraEnv: { HIGHLIGHTER_E2E_FAKE_CAPTURE: '1' }
      })
      const restarted = await openWorkbench(highlighter)
      const restartedCard = restarted.locator('[data-testid="record-card"]').first()
      await restartedCard.waitFor({ state: 'visible', timeout: 30_000 })
      await expect(restartedCard).toHaveAttribute('data-project-state', 'ready')
      await restartedCard.locator('[data-testid="card-edit"]').click()
      const afterRestart = await highlighter.waitForWindow('/record/editor.html', 30_000)
      await waitForEditorReady(afterRestart)
      expect(await renderedDurationMs(afterRestart)).toBeGreaterThan(2000)
      expect(await afterRestart.locator('#range-end-input').inputValue()).toBe(trimmedEnd)

      consoleErrors.push(...(await highlighter.getUnexpectedErrors()))
      // The export directory is owned by the user: deleting/keeping the project must not touch it.
      expect(fs.existsSync(firstExport)).toBe(true)
      expect(hardErrors(consoleErrors)).toEqual([])
      const softErrors = consoleErrors.filter((issue) => issue.type === 'renderer-console')
      if (softErrors.length) testInfo.attach('renderer-console-errors.json', {
        body: Buffer.from(JSON.stringify(softErrors, null, 2)),
        contentType: 'application/json'
      })
    } finally {
      await highlighter.close()
      fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  // ---------------------------------------------------------------------------
  // R4: window recording (workbench picker -> window-bound capture -> editor)
  // ---------------------------------------------------------------------------
  test('window mode records the selected window target', { timeout: 180_000 }, async ({}, testInfo) => {
    const dataRoot = createDataRoot()
    const artifactsDir = testInfo.outputPath('electron-artifacts')
    fs.mkdirSync(artifactsDir, { recursive: true })
    const highlighter = await launchHighlighter({
      dataRoot,
      artifactsDir,
      extraEnv: { HIGHLIGHTER_E2E_FAKE_CAPTURE: '1' }
    })
    try {
      // The host cannot capture the screen, and the window picker reads the real desktop. Stub the
      // main process enumeration with one deterministic WINDOW source so the picker and the
      // window-bound recording path can be exercised without touching the user's desktop.
      await highlighter.electronApp.evaluate(({ desktopCapturer }) => {
        const windowSource = {
          id: 'window:4242:0',
          name: 'E2E Target Window',
          display_id: '',
          thumbnail: { isEmpty: () => false, getSize: () => ({ width: 1280, height: 720 }) }
        }
        const screenSource = {
          id: 'screen:0:0',
          name: 'DISPLAY1',
          display_id: '999',
          thumbnail: { isEmpty: () => false, getSize: () => ({ width: 2240, height: 1400 }) }
        }
        desktopCapturer.getSources = async (options = {}) => {
          const types = Array.isArray(options.types) ? options.types : ['screen']
          if (types.includes('window')) return [windowSource]
          return [screenSource]
        }
      })

      const workbench = await openWorkbench(highlighter)
      await workbench.locator('[data-testid="mode-window"]').click()
      const option = workbench.locator('[data-testid="window-option"]').first()
      await option.waitFor({ state: 'visible', timeout: 20_000 })
      await expect(option).toHaveAttribute('data-window-token', /.+/)
      await option.click()
      await expect(workbench.locator('[data-testid="start-recording"]')).toBeEnabled()
      await workbench.locator('[data-testid="countdown-select"]').selectOption('0')
      await workbench.locator('[data-testid="start-recording"]').click()

      const control = await highlighter.waitForWindow('/record/record.html')
      await control.locator('[data-testid="control-bar"]').waitFor({ state: 'visible', timeout: 20_000 })
      // Window mode: no on-screen annotation overlay, and the target title is visible.
      await expect(control.locator('body')).toHaveAttribute('data-annotation', 'off')
      await expect(control.locator('[data-testid="annotation-tools"]')).toBeHidden()
      await expect(control.locator('#windowTitle')).toContainText('E2E Target Window')
      await control.locator('[data-testid="start-record"]').click()
      await control.waitForFunction(() => document.body.dataset.state === 'recording', { timeout: 40_000 })
      await control.waitForTimeout(1600)
      await testInfo.attach('window-control-bar.png', { body: await control.screenshot(), contentType: 'image/png' })
      await control.locator('[data-testid="finish-record"]').click()

      const editor = await highlighter.waitForWindow('/record/editor.html', 60_000)
      await waitForEditorReady(editor)
      expect(await renderedDurationMs(editor)).toBeGreaterThan(1000)
      await editor.locator('#window-close').click()
      await expect.poll(() => highlighter.pagesMatching('/record/editor.html').length, { timeout: 20_000 }).toBe(0)

      // The project mode must persist as 'window': the workbench filter only keeps window takes.
      const card = workbench.locator('[data-testid="record-card"]').first()
      await card.waitFor({ state: 'visible', timeout: 30_000 })
      await workbench.locator('[data-testid="records-filter"]').selectOption('window')
      await expect(workbench.locator('[data-testid="record-card"]')).toHaveCount(1)
      await workbench.locator('[data-testid="records-filter"]').selectOption('display')
      await expect(workbench.locator('[data-testid="record-card"]')).toHaveCount(0)

      expect(hardErrors(await highlighter.getUnexpectedErrors())).toEqual([])
    } finally {
      await highlighter.close()
      fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  // ---------------------------------------------------------------------------
  // R4: multi-segment editing + WebM / downscaled MP4 export
  // ---------------------------------------------------------------------------
  test('multi-segment trim, undo/redo, and WebM + downscaled MP4 export', { timeout: 240_000 }, async ({}, testInfo) => {
    const dataRoot = createDataRoot()
    const exportDir = path.join(dataRoot, 'exports')
    fs.mkdirSync(exportDir, { recursive: true })
    const editedWebm = path.join(exportDir, 'edited.webm')
    const scaledMp4 = path.join(exportDir, 'scaled.mp4')
    const artifactsDir = testInfo.outputPath('electron-artifacts')
    fs.mkdirSync(artifactsDir, { recursive: true })
    const highlighter = await launchHighlighter({
      dataRoot,
      artifactsDir,
      extraEnv: { HIGHLIGHTER_E2E_FAKE_CAPTURE: '1' },
      savePaths: [editedWebm, scaledMp4]
    })
    try {
      const workbench = await openWorkbench(highlighter)
      await workbench.locator('[data-testid="mode-display"]').click()
      await workbench.locator('[data-testid="display-option"]').first().click()
      await workbench.locator('[data-testid="countdown-select"]').selectOption('0')
      await workbench.locator('[data-testid="start-recording"]').click()

      const control = await highlighter.waitForWindow('/record/record.html')
      await control.locator('[data-testid="control-bar"]').waitFor({ state: 'visible', timeout: 20_000 })
      await control.locator('[data-testid="start-record"]').click()
      await control.waitForFunction(() => document.body.dataset.state === 'recording', { timeout: 40_000 })
      await control.waitForTimeout(3400)
      await control.locator('[data-testid="finish-record"]').click()

      const editor = await highlighter.waitForWindow('/record/editor.html', 60_000)
      await waitForEditorReady(editor)
      const sourceDurationMs = await renderedDurationMs(editor)
      expect(sourceDurationMs).toBeGreaterThan(2500)

      // Scrub to ~40%, split there, delete the segment containing the playhead.
      const trackBox = await editor.locator('#timeline-track').boundingBox()
      expect(trackBox).toBeTruthy()
      await editor.mouse.click(trackBox.x + trackBox.width * 0.4, trackBox.y + trackBox.height / 2)
      await editor.locator('#split-at-playhead').click()
      const afterSplit = parseClockList(await editor.locator('#range-selection').textContent())
      expect(afterSplit[0]).toBeGreaterThan(0)
      await editor.locator('#delete-segment').click()
      const afterDelete = parseClockList(await editor.locator('#range-selection').textContent())
      const keptMs = afterDelete[0]
      expect(keptMs).toBeGreaterThan(400)
      expect(keptMs).toBeLessThan(sourceDurationMs * 0.75)

      // Undo restores the removed segment; redo removes it again.
      await editor.locator('#undo-edit').click()
      const afterUndo = parseClockList(await editor.locator('#range-selection').textContent())
      expect(afterUndo[0]).toBeGreaterThan(keptMs + 200)
      await editor.locator('#redo-edit').click()
      const afterRedo = parseClockList(await editor.locator('#range-selection').textContent())
      expect(afterRedo[0]).toBe(keptMs)
      await expect(editor.locator('#export-output-size')).toContainText(/\d+\s*[×x]\s*\d+/)

      // ---- WebM export of the edited (non-full-range) take ----
      await editor.locator('#export-format').selectOption('webm')
      await editor.locator('#export-button').click()
      await editor.locator('#result-bar').waitFor({ state: 'visible', timeout: 150_000 })
      expect(fs.existsSync(editedWebm)).toBe(true)
      const webm = probeVideo(editedWebm)
      expect(webm.codec).toBe('vp9')
      expect(webm.width).toBeGreaterThan(0)
      expect(Math.abs(webm.durationMs - keptMs)).toBeLessThan(800)
      await editor.locator('#result-dismiss').click()

      // ---- Full-range MP4 downscaled to the 720p long-edge preset ----
      await editor.locator('#reset-edits').click()
      await editor.locator('#export-format').selectOption('mp4')
      await editor.locator('#export-resolution').selectOption('720p')
      await editor.locator('#export-quality').selectOption('high')
      await editor.locator('#export-button').click()
      await editor.locator('#result-bar').waitFor({ state: 'visible', timeout: 150_000 })
      expect(fs.existsSync(scaledMp4)).toBe(true)
      const mp4 = probeVideo(scaledMp4)
      // 2240x1400 source, 720p long-edge cap 1280 -> 1280x800 (even dimensions, never upscaled).
      expect(mp4.width).toBe(1280)
      expect(mp4.height).toBe(800)
      expect(Math.abs(mp4.durationMs - sourceDurationMs)).toBeLessThan(1200)
      await testInfo.attach('multi-segment-editor.png', { body: await editor.screenshot(), contentType: 'image/png' })

      expect(hardErrors(await highlighter.getUnexpectedErrors())).toEqual([])
    } finally {
      await highlighter.close()
      fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
  // ---------------------------------------------------------------------------
  // R5: demo finishing (style + zoom + click ripple) proven on exported frames
  // ---------------------------------------------------------------------------
  test('demo finishing: style, zoom and click ripple reach the exported frames', { timeout: 240_000 }, async ({}, testInfo) => {
    const dataRoot = createDataRoot()
    const artifactsDir = testInfo.outputPath('electron-artifacts')
    fs.mkdirSync(artifactsDir, { recursive: true })
    const exported = path.join(dataRoot, 'exports', 'demo.mp4')
    fs.mkdirSync(path.dirname(exported), { recursive: true })
    const style = { enabled: true, background: '#0a2540', padding: 0.1, radius: 16, shadow: false, ripples: true }
    const zooms = [{ id: 'zoom-1', startMs: 800, endMs: 2200, scale: 2, focusX: 0.5, focusY: 0.5, easing: 'linear' }]
    const events = { durationMs: 3000, pointer: [], clicks: [{ tMs: 1500, x: 0.5, y: 0.5, button: 0 }] }
    const projectId = await seedDemoProject(dataRoot, { style, zooms, events })
    const highlighter = await launchHighlighter({
      dataRoot,
      artifactsDir,
      extraEnv: { HIGHLIGHTER_E2E_FAKE_CAPTURE: '1' },
      savePaths: [exported]
    })
    try {
      const workbench = await openWorkbench(highlighter)
      const card = workbench.locator('[data-testid="record-card"]').first()
      await card.waitFor({ state: 'visible', timeout: 30_000 })
      await card.locator('[data-testid="card-edit"]').click()
      const editor = await highlighter.waitForWindow('/record/editor.html', 30_000)
      await waitForEditorReady(editor)

      // The seeded draft is restored and the event track reached the editor.
      await expect(editor.locator('#demo-enabled')).toBeChecked()
      await expect(editor.locator('#demo-ripples')).toBeChecked()
      await expect(editor.locator('#demo-preview-frame')).toBeVisible()
      await expect.poll(async () => editor.locator('#zoom-list [data-testid="zoom-item"], #zoom-list .zoom-item, #zoom-list li').count(), { timeout: 20_000 }).toBeGreaterThan(0)
      await editor.waitForFunction(() => {
        const status = document.querySelector('#events-status')
        return !!status && /\d/.test(status.textContent || '')
      }, null, { timeout: 20_000 })

      await editor.locator('#export-button').click()
      await editor.locator('#result-bar').waitFor({ state: 'visible', timeout: 150_000 })
      expect(fs.existsSync(exported)).toBe(true)
      const meta = probeVideo(exported)
      // 320x240 content + 10% padding -> 400x300 canvas (even dimensions).
      expect(meta.width).toBe(400)
      expect(meta.height).toBe(300)

      const frameDir = testInfo.outputPath('frames')
      fs.mkdirSync(frameDir, { recursive: true })
      const zoomedPng = path.join(frameDir, 'zoom.png')
      const ripplePng = path.join(frameDir, 'ripple.png')
      const plainPng = path.join(frameDir, 'plain.png')
      extractFrame(exported, 1000, zoomedPng)
      extractFrame(exported, 1700, ripplePng)
      extractFrame(exported, 2750, plainPng)
      const zoomed = await frameStats(zoomedPng)
      const rippled = await frameStats(ripplePng)
      const plain = await frameStats(plainPng)

      // Style: padding leaves the configured background colour at the outer corner,
      // and a meaningful share of the canvas is background (padding + shadow-free border).
      // YUV 4:2:0 rounding shifts the RGB background by a couple of levels.
      const near = (actual, expected, tolerance = 8) => actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance)
      expect(near(zoomed.corner, [10, 37, 64])).toBe(true)
      expect(zoomed.background).toBeGreaterThan(zoomed.width * zoomed.height * 0.05)

      // Zoom: the 48x48 red square grows while the zoom segment is active...
      expect(zoomed.redBox).toBeTruthy()
      expect(plain.redBox).toBeTruthy()
      expect(zoomed.redBox.width).toBeGreaterThan(plain.redBox.width + 10)
      expect(zoomed.red).toBeGreaterThan(plain.red * 1.8)

      // Ripple: click at 1500ms paints a bright ring at the centre, gone by 2750ms.
      expect(rippled.bright).toBeGreaterThan(plain.bright + 40)
      expect(plain.bright).toBeLessThan(40)

      await testInfo.attach('demo-exported-frame.png', { path: zoomedPng })
      expect(projectId.length).toBeGreaterThan(0)

      // Closing and reopening keeps the demo draft (style + source-time zooms) main-side.
      await editor.locator('#window-close').click()
      await expect.poll(() => highlighter.pagesMatching('/record/editor.html').length, { timeout: 20_000 }).toBe(0)
      const reopenedCard = workbench.locator('[data-testid="record-card"]').first()
      await reopenedCard.waitFor({ state: 'visible', timeout: 30_000 })
      await reopenedCard.locator('[data-testid="card-edit"]').click()
      const reopened = await highlighter.waitForWindow('/record/editor.html', 30_000)
      await waitForEditorReady(reopened)
      await expect(reopened.locator('#demo-enabled')).toBeChecked()
      await expect(reopened.locator('#demo-ripples')).toBeChecked()
      await expect.poll(async () => reopened.locator('#zoom-list [data-testid="zoom-item"], #zoom-list .zoom-item, #zoom-list li').count(), { timeout: 20_000 }).toBeGreaterThan(0)

      expect(hardErrors(await highlighter.getUnexpectedErrors())).toEqual([])
    } finally {
      await highlighter.close()
      fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

})
