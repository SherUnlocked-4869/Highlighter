const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const electronPath = require('electron')
const ffmpegPath = require('ffmpeg-static')
const resultPrefix = 'HIGHLIGHTER_RECORDING_EDITOR_LAYOUT_PROBE='

// The preview section moved out of record.html into the standalone editor window (R3 plan
// §4.3). This test keeps the old layout intent - "the actions stay above every video aspect
// ratio, at the window's minimum width too" - but measures record/editor.html now: the
// <video> must stay inside its stage, the timeline and the single Export button must stay
// on screen with no body scroll, and the export button must be the topmost hit target at
// 1.5 device scale factor (high-DPI safe).
function createVideoFixture(filePath, size) {
  const result = spawnSync(ffmpegPath, [
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', `color=c=black:s=${size}:r=1`,
    '-t', '1',
    '-c:v', 'libvpx-vp9',
    '-an',
    '-y', filePath
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true
  })
  assert.equal(result.status, 0, `Unable to create ${size} preview fixture.\n${result.stderr}`)
}

function ratioOf(value) {
  // The R4 output line is "<W> × <H> · <kept duration>"; the ratio only needs the first two.
  const match = /^(\d+) \u00d7 (\d+)/.exec(String(value || ''))
  if (!match) return null
  return Number(match[1]) / Number(match[2])
}

test('the recording editor keeps video, timeline and the export action on screen at every aspect ratio', { timeout: 45000 }, (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-recording-editor-layout-'))
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))
  const videos = [
    path.join(fixtureRoot, 'landscape.webm'),
    path.join(fixtureRoot, 'square.webm')
  ]
  createVideoFixture(videos[0], '640x480')
  createVideoFixture(videos[1], '480x480')
  const result = spawnSync(electronPath, [path.join(root, 'scripts', 'probe-recording-editor-layout.js')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: '0',
      HIGHLIGHTER_RECORDING_EDITOR_LAYOUT_VIDEOS: JSON.stringify(videos)
    }
  })

  assert.equal(
    result.status,
    0,
    `Recording editor layout probe failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  )
  const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith(resultPrefix))
  assert.ok(line, `Recording editor layout probe returned no JSON.\nstdout:\n${result.stdout}`)
  const probe = JSON.parse(line.slice(resultPrefix.length))

  const evenPx = (value) => Math.max(2, Math.round(value / 2) * 2)
  const canvasAspectOf = (output) => {
    const match = /^(\d+) \u00d7 (\d+)/.exec(String(output || ''))
    if (!match) return ""
    return evenPx(Number(match[1]) / 0.8) + " / " + evenPx(Number(match[2]) / 0.8)
  }
  for (const layout of [probe.wideLandscape, probe.wideSquare, probe.narrowLandscape]) {
    const label = `layout ${JSON.stringify(layout.viewport)}`
    const viewport = layout.viewport
    assert.equal(viewport.dpr, 1.5, `${label}: high-DPI probe runs at 1.5`)
    // The video is inside the stage: no overflow past the reserved preview area.
    assert.ok(layout.stage && layout.video, `${label}: stage and video are laid out`)
    assert.ok(layout.stage.height > 0 && layout.stage.width > 0, `${label}: stage has a box`)
    assert.ok(layout.video.top >= layout.stage.top, `${label}: video top inside stage`)
    assert.ok(layout.video.bottom <= layout.stage.bottom, `${label}: video bottom inside stage`)
    assert.ok(layout.video.left >= layout.stage.left, `${label}: video left inside stage`)
    assert.ok(layout.video.right <= layout.stage.right, `${label}: video right inside stage`)
    // Timeline, panel and the single export action stay inside the window.
    assert.ok(layout.panel.bottom <= viewport.height, `${label}: timeline panel above the window edge`)
    assert.ok(layout.timeline.bottom <= viewport.height, `${label}: timeline above the window edge`)
    assert.ok(layout.exportPanel.bottom <= viewport.height, `${label}: export panel above the window edge`)
    assert.ok(layout.exportButton.top >= 0, `${label}: export action above the window top edge`)
    assert.ok(layout.exportButton.bottom <= viewport.height, `${label}: export action above the window edge`)
    assert.equal(layout.exportHitTarget, 'export-button', `${label}: export button is the topmost hit target`)
    // The whole document fits: the editor is a window, not a scrolling page.
    assert.ok(layout.bodyScrollHeight <= viewport.height, `${label}: no vertical scroll`)
    assert.ok(layout.documentScrollWidth <= viewport.width, `${label}: no horizontal scroll`)
    // The dual-handle lane is real: both handles sit on the same track, in start/end order,
    // and the default selection spans the whole track.
    assert.ok(layout.track.width > 0, `${label}: the timeline track has width`)
    const trackLeft = layout.track.left
    const trackRight = layout.track.right
    for (const handle of [layout.handleStart, layout.handleEnd]) {
      assert.ok(handle, `${label}: both handles render`)
      const center = handle.left + handle.width / 2
      assert.ok(center >= trackLeft - 1 && center <= trackRight + 1, `${label}: handle centered on the track`)
    }
    assert.ok(
      layout.handleStart.left + layout.handleStart.width / 2 < layout.handleEnd.left + layout.handleEnd.width / 2,
      `${label}: start handle is left of the end handle`
    )
    // R4 multi-segment timeline: the default edit is one kept block spanning the track, with
    // the two outer handles; no boundary grips exist until the user splits the recording.
    assert.ok(Array.isArray(layout.segmentBlocks) && layout.segmentBlocks.length === 1, `${label}: one kept segment by default`)
    assert.equal(layout.boundaryCount, 0, `${label}: no inner boundary before a split`)
    assert.ok(layout.segmentBlocks[0].width >= layout.track.width - 2, `${label}: the default kept block is the full range`)
    // A ready project must not show the recovery banner, an error, or the empty-selection hint.
    assert.equal(layout.recoveryHidden, true, `${label}: ready project has no recovery banner`)
    assert.equal(layout.recoveryVisible, false, `${label}: recovery banner is hidden`)
    assert.equal(layout.emptyHintHidden, true, `${label}: no empty-selection hint for a valid edit`)
    assert.equal(layout.errors, '', `${label}: no error text for a ready project`)
    assert.equal(layout.bodyFormat, 'mp4', `${label}: MP4 export settings are active by default`)
    assert.match(layout.saveState, /\S/, `${label}: autosave status is rendered`)
    // Static markup was translated through the shared runtime: no element still shows the
    // English HTML fallback next to Chinese dynamic labels (mixed-language first paint bug).
    assert.ok(layout.i18nChecked > 15, `${label}: the editor has translatable static markup`)
    assert.deepEqual(layout.i18nMismatches, [], `${label}: every static data-i18n node is translated`)
    assert.equal(layout.language, 'zh-CN', `${label}: the probe window uses the default language`)
    // The export panel shows the real final dimensions (plus kept duration), not a placeholder.
    assert.ok(ratioOf(layout.exportOutputSize) !== null, `${label}: output size is rendered as W x H`)
    // R4 §5 hide-above-source rule: 640x480 footage cannot offer 1080p/720p/480p caps above
    // its own long edge (854/1280/1920 > 640), so only "source" is selectable; the 30 fps
    // source offers exactly source/30 (never 60).
    assert.deepEqual(layout.exportResolutionOptions, ['source'], `${label}: no upscale presets are offered`)
    assert.deepEqual(layout.exportFpsOptions, ['source', '30'], `${label}: fps above the source is hidden`)
    // The R4 edit controls are real buttons (disabled is fine for the default full-range
    // edit, but they must exist and report a boolean disabled state).
    for (const control of layout.editControls) {
      assert.equal(typeof control.disabled, 'boolean', `${label}: #${control.id} is a real control`)
    }
    // R5 presentation preview: the shared demo module is loaded, the frame uses the
    // resolved canvas aspect/margins and the demo controls render their persisted values.
    assert.equal(layout.demoLoaded, true, `${label}: shared/recording-demo.js is loaded`)
    assert.equal(layout.demoFrameState.demo, 'on', `${label}: enabled style paints the demo frame`)
    assert.equal(layout.demoFrameState.aspectRatio, canvasAspectOf(layout.exportOutputSize), `${label}: canvas aspect comes from resolveDemoCanvas`)
    assert.equal(Math.round(parseFloat(layout.demoFrameState.padding)), 10, `${label}: padding follows the style`)
    assert.ok(layout.demoFrameState.background, `${label}: background colour is applied`)
    assert.ok(parseFloat(layout.demoFrameState.canvasRadius) > 0, `${label}: corner radius is applied`)
    assert.ok(layout.demoFrame.width > 0 && layout.demoFrame.height > 0, `${label}: the demo frame has a box`)
    assert.equal(layout.demoControls.enabled, true, `${label}: style toggle reflects the draft`)
    assert.equal(layout.demoControls.padding, '10', `${label}: padding slider matches the style`)
    assert.equal(layout.demoControls.radius, '10', `${label}: radius slider matches the style`)
    assert.equal(layout.demoControls.shadow, true, `${label}: shadow checkbox matches the style`)
    assert.ok(layout.demoControls.background, `${label}: background select has a value`)
    assert.ok(layout.demoControls.eventsStatus, `${label}: event-track status is shown`)
    assert.equal(layout.demoControls.ripplesDisabled, true, `${label}: ripples need an event track`)
    assert.equal(layout.demoControls.zoomItems, 1, `${label}: the persisted zoom segment is listed`)
    assert.equal(layout.demoControls.zoomAddDisabled, false, `${label}: more zooms can be added`)
  }
  // Aspect ratios drive the output-size line: 4:3 source for both wide/at-minimum window,
  // 1:1 after the square fixture is loaded.
  assert.ok(Math.abs(ratioOf(probe.wideLandscape.exportOutputSize) - 640 / 480) < 0.01)
  assert.ok(Math.abs(ratioOf(probe.wideSquare.exportOutputSize) - 480 / 480) < 0.01)
  // The minimum supported width is a real state the window can be resized to (minWidth is
  // 820 in the terminal contract) and then still shows the export action.
  assert.ok(probe.narrowLandscape.viewport.width >= 800 && probe.narrowLandscape.viewport.width <= 900)
  assert.ok(probe.narrowLandscape.video.height > 0, 'the video keeps a visible box at the minimum width')
})
