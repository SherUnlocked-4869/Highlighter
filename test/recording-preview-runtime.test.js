const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const electronPath = require('electron')
const ffmpegPath = require('ffmpeg-static')
const resultPrefix = 'HIGHLIGHTER_RECORDING_LAYOUT_PROBE='

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

test('recording preview keeps actions above every video aspect ratio', { timeout: 45000 }, (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-recording-layout-'))
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))
  const videos = [
    path.join(fixtureRoot, 'landscape.webm'),
    path.join(fixtureRoot, 'square.webm')
  ]
  createVideoFixture(videos[0], '640x480')
  createVideoFixture(videos[1], '480x480')
  const result = spawnSync(electronPath, [path.join(root, 'scripts', 'probe-recording-preview-layout.js')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: '0',
      HIGHLIGHTER_RECORDING_LAYOUT_VIDEOS: JSON.stringify(videos)
    }
  })

  assert.equal(
    result.status,
    0,
    `Recording preview layout probe failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  )
  const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith(resultPrefix))
  assert.ok(line, `Recording preview layout probe returned no JSON.\nstdout:\n${result.stdout}`)
  const probe = JSON.parse(line.slice(resultPrefix.length))

  for (const layout of [probe.landscape, probe.square]) {
    assert.equal(layout.viewport.devicePixelRatio, 1.5)
    assert.ok(layout.video.top >= layout.stage.top)
    assert.ok(layout.video.bottom <= layout.stage.bottom)
    assert.ok(layout.footer.bottom <= layout.viewport.height)
    assert.ok(layout.save.bottom <= layout.viewport.height)
    assert.ok(layout.bodyScrollHeight <= layout.viewport.height)
    assert.equal(layout.saveHitTarget, 'saveMp4')
  }
})
