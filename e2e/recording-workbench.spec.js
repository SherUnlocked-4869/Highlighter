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
})
