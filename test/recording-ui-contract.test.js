const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const { DEFAULT_SETTINGS } = require('../main/services/settings-defaults')
const { readConfigSource } = require('./helpers/config-source')

test('recording runtime packages ffmpeg', () => {
  assert.match(packageJson.dependencies['ffmpeg-static'], /^\^5\./)
  assert.ok(packageJson.build.asarUnpack.includes('node_modules/ffmpeg-static/**/*'))
})

test('main process wires protected region recording windows', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const recordDomain = fs.readFileSync(path.join(root, 'main/domains/record/index.js'), 'utf8')
  const captureIpc = fs.readFileSync(path.join(root, 'main', 'ipc', 'capture-ipc.js'), 'utf8')
  const recordingIpc = fs.readFileSync(path.join(root, 'main', 'ipc', 'recording-ipc.js'), 'utf8')
  const recordPreload = fs.readFileSync(path.join(root, 'preload-record.js'), 'utf8')
  const framePreload = fs.readFileSync(path.join(root, 'preload-record-frame.js'), 'utf8')
  const frame = fs.readFileSync(path.join(root, 'record', 'frame.html'), 'utf8')

  assert.match(captureIpc, /capture:start-region-recording/)
  assert.match(recordDomain, /setContentProtection\(true\)/)
  assert.match(recordingIpc, /record:start-session/)
  assert.match(recordingIpc, /record:append-chunk/)
  assert.match(recordingIpc, /record:finish-session/)
  assert.match(recordingIpc, /record:save-mp4/)
  assert.match(main, /registerCaptureIpc\(\{[\s\S]*captureDomain\.createCaptureController\(\)/)
  assert.match(main, /registerRecordingIpc\(\{[\s\S]*recordDomain\.createRecordingController\(\)/)
  assert.match(recordPreload, /startSession:/)
  assert.match(recordPreload, /appendChunk:/)
  assert.match(framePreload, /record-frame:state/)
  assert.match(frame, /data-state="idle"/)
})

test('recording frame exposes a protected annotation canvas contract', () => {
  const html = fs.readFileSync(path.join(root, 'record', 'frame.html'), 'utf8')
  const frameScriptPath = path.join(root, 'record', 'frame.js')
  const frameStylePath = path.join(root, 'record', 'frame.css')
  const preload = fs.readFileSync(path.join(root, 'preload-record-frame.js'), 'utf8')

  assert.equal(fs.existsSync(frameScriptPath), true)
  assert.equal(fs.existsSync(frameStylePath), true)
  const frameScript = fs.readFileSync(frameScriptPath, 'utf8')
  assert.match(html, /id="annotationStage"/)
  assert.match(html, /frame\.css/)
  assert.match(html, /annotation-utils\.js/)
  assert.match(html, /frame\.js/)
  assert.match(frameScript, /pointerdown/)
  assert.match(frameScript, /pointermove/)
  assert.match(frameScript, /pointerup/)
  assert.match(frameScript, /requestAnimationFrame/)
  assert.match(frameScript, /submitSnapshot/)
  assert.match(preload, /record-frame:command/)
  assert.match(preload, /record-frame:snapshot/)
  assert.match(preload, /record-frame:ready/)
})

test('main process securely routes annotation commands and snapshots', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const recordDomain = fs.readFileSync(path.join(root, 'main/domains/record/index.js'), 'utf8')
  const recordingIpc = fs.readFileSync(path.join(root, 'main', 'ipc', 'recording-ipc.js'), 'utf8')
  const recordPreload = fs.readFileSync(path.join(root, 'preload-record.js'), 'utf8')
  assert.match(recordDomain, /requireRecordFrameSender/)
  assert.match(recordingIpc, /record:set-annotation-command/)
  assert.match(recordingIpc, /record-frame:snapshot/)
  assert.match(recordDomain, /sanitizeAnnotationSnapshot/)
  assert.match(recordDomain, /record:annotation-snapshot/)
  assert.match(recordDomain, /setIgnoreMouseEvents\([^)]*tool === 'pointer'/)
  assert.match(recordingIpc, /record-frame:ready/)
  assert.match(recordDomain, /restoreRecordFramePassthrough/)
  assert.match(recordPreload, /setAnnotationCommand:/)
  assert.match(recordPreload, /record:set-annotation-command/)
  assert.match(recordPreload, /onAnnotationSnapshot:/)
  assert.match(recordPreload, /record:annotation-snapshot/)
  assert.match(recordPreload, /reportPerformance:/)
  assert.match(recordingIpc, /record:performance/)
})

test('recording UI contains control and preview states', () => {
  const html = fs.readFileSync(path.join(root, 'record', 'record.html'), 'utf8')
  const style = fs.readFileSync(path.join(root, 'record', 'record.css'), 'utf8')
  const script = fs.readFileSync(path.join(root, 'record', 'record.js'), 'utf8')
  for (const id of ['controlView', 'countdown', 'start', 'pause', 'stop', 'previewView', 'preview', 'saveMp4', 'rerecord']) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
  assert.match(script, /canvas\.captureStream\(frameRate\)/)
  assert.match(script, /requestVideoFrameCallback/)
  assert.match(script, /createFramePacer\(frameRate\)/)
  assert.match(script, /video\/webm/)
  assert.match(script, /appendChunk/)
  assert.match(script, /transitionRecordingState/)
  assert.match(script, /primeSeekablePreview\(preview\)/)
  assert.match(style, /\.video-stage\{[^}]*position:relative[^}]*overflow:hidden/)
  assert.match(style, /\.video-stage video\{[^}]*position:absolute[^}]*inset:14px/)
})

test('recording controls expose and composite basic live annotation tools', () => {
  const html = fs.readFileSync(path.join(root, 'record', 'record.html'), 'utf8')
  const style = fs.readFileSync(path.join(root, 'record', 'record.css'), 'utf8')
  const script = fs.readFileSync(path.join(root, 'record', 'record.js'), 'utf8')
  for (const tool of ['pointer', 'pen', 'rect', 'ellipse', 'arrow']) {
    assert.match(html, new RegExp(`data-annotation-tool="${tool}"`))
  }
  for (const id of ['annotationStyle', 'annotationPalette', 'annotationUndo', 'annotationClear']) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
  for (const color of ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#1687ff', '#111111', '#ffffff']) {
    assert.match(html, new RegExp(`data-annotation-color="${color}"`))
  }
  for (const width of [2, 4, 7]) assert.match(html, new RegExp(`data-annotation-width="${width}"`))
  assert.match(html, /annotation-utils\.js[\s\S]*recording-utils\.js[\s\S]*record\.js/)
  assert.match(style, /@media\s*\(max-width:699px\)/)
  assert.match(style, /annotation-tool\.active/)
  assert.match(script, /onAnnotationSnapshot/)
  assert.match(script, /setAnnotationCommand/)
  assert.match(script, /drawImage\(sourceVideo[\s\S]*drawAnnotationSnapshot\(context/)
  assert.match(script, /annotationResetVersion/)
  assert.match(script, /async function finishRecording\(\)[\s\S]*setFrameState\('hidden'\)[\s\S]*stopMediaRecorder/)
})

test('region recording settings expose the frozen frame rates and audio sources', () => {
  const config = readConfigSource()
  const recordHtml = fs.readFileSync(path.join(root, 'record', 'record.html'), 'utf8')
  const recordScript = fs.readFileSync(path.join(root, 'record', 'record.js'), 'utf8')
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const ffmpegResolver = fs.readFileSync(path.join(root, 'main', 'services', 'ffmpeg-path.js'), 'utf8')
  assert.match(config, /5.*16.*24.*30.*60/)
  // This contract was updated when the feature landed (S10b, Wave 7.5): the old
  // assertion pinned the settings page to a silent-only recorder, which is no
  // longer true now that P0-3 exposes the two frozen audio sources. Both rows
  // must stay visible, and the defaults must stay the frozen ones (system sound
  // on, microphone off for privacy).
  assert.match(config, /switchMarkup\(settings\.record\.audioSystem !== false, 'audioSystem', 'record'\)/)
  assert.match(config, /switchMarkup\(settings\.record\.audioMicrophone === true, 'audioMicrophone', 'record'\)/)
  // switchMarkup turns the key into the DOM hook the shared binder reads, so the
  // two rows above really render data-switch="audioSystem" / "audioMicrophone".
  assert.match(config, /data-switch="\$\{key\}" data-group="\$\{group \|\| ''\}"/)
  assert.equal(DEFAULT_SETTINGS.record.audioSystem, true)
  assert.equal(DEFAULT_SETTINGS.record.audioMicrophone, false)
  // Acceptance §7.3-⑥: the settings copy must no longer claim the MP4 is silent.
  assert.doesNotMatch(config, /仅包含画面/)
  assert.match(config, /录制包含画面与所选音轨，保存为 MP4/)
  assert.doesNotMatch(recordHtml, /microphone|麦克风|系统声音/i)
  assert.match(recordHtml, /id="recordError"/)
  assert.match(recordHtml, /id="saveProgress"/)
  // P0-1-T5 (S12): the copy moved into shared/locales/record.js. Each assertion
  // below keeps the original intent — the four acquisition failures must still be
  // reported to the user — by matching the key the renderer now looks up.
  assert.match(recordScript, /record\.error\.desktop-capture-failed/)
  assert.match(recordScript, /record\.error\.recorder-create-failed/)
  assert.match(recordScript, /record\.error\.desktop-video-unreadable/)
  assert.match(recordScript, /record\.error\.record-failed/)
  assert.match(recordScript, /cancelButton\.disabled/)
  assert.match(recordScript, /async function rerecord\(\)[\s\S]*catch \(error\) \{[\s\S]*cancelSession\(sessionId\)/)
  assert.match(main, /createFfmpegPathResolver/)
  assert.match(ffmpegResolver, /未找到 MP4 编码组件/)
})

test('MP4 save dialog is owned and not covered by the topmost preview', () => {
  const recordDomain = fs.readFileSync(path.join(root, 'main/domains/record/index.js'), 'utf8')
  assert.match(recordDomain, /saveMp4: async[\s\S]*setAlwaysOnTop\(false\)[\s\S]*showSaveDialog\(win,/)
  assert.match(recordDomain, /showSaveDialog\(win,[\s\S]*finally[\s\S]*setAlwaysOnTop\(true, 'screen-saver'\)/)
})

// OCR 评审修复：麦克风断连提示原先写死"仅保留系统声音"，但"系统声关 + 麦克风开"时
// 实际已无任何音轨 —— 文案必须与文件实际内容一致。
// P0-1-T5 (S12)：文案移入 shared/locales/record.js，断言改为追踪两个不同的键，
// 语义不变：系统声还开着才说"仅保留系统声音"，否则必须说"不再包含声音"。
// 热切换修复：两个键现在以"键 + 参数"的形式存进 setAudioNotice()，句子由
// renderStatus() 在渲染时构造，所以断言跟踪的是这两个键字面量。
test('the microphone-disconnect notice matches the audio the file actually keeps', () => {
  const recordScript = fs.readFileSync(path.join(root, 'record', 'record.js'), 'utf8')
  const locales = fs.readFileSync(path.join(root, 'shared', 'locales', 'record.js'), 'utf8')
  assert.match(
    recordScript,
    /setAudioNotice\(audioRequest\.system\s*\n?\s*\? 'record\.audio\.notice\.microphone-disconnected-system'\s*\n?\s*: 'record\.audio\.notice\.microphone-disconnected-none'\)/
  )
  assert.doesNotMatch(
    recordScript,
    /setAudioNotice\(t\('record\.audio\.notice\.microphone-disconnected-system'\)\)/,
    'the unconditional wording must be gone'
  )
  assert.match(locales, /'record\.audio\.notice\.microphone-disconnected-system': '麦克风已断开，本次录制仅保留系统声音'/)
  assert.match(locales, /'record\.audio\.notice\.microphone-disconnected-none': '麦克风已断开，本次录制不再包含声音'/)
})

// 热切换修复（批次 C 遗留）：提示原先以"已经翻译好的句子"存储，切语言后仍停在
// 捕获时的语言。现在存的是键 + 参数，renderStatus() 每次都用当前语言重建整句。
test('the audio notice is stored as a key and rendered in the active language', () => {
  const recordScript = fs.readFileSync(path.join(root, 'record', 'record.js'), 'utf8')
  // 状态是键 + 参数，不是句子；键相同时仍然提前返回。
  assert.match(recordScript, /let audioNoticeKey = ''/)
  assert.match(recordScript, /let audioNoticeParams = null/)
  assert.match(
    recordScript,
    /function setAudioNotice\(key, params = null\) \{[\s\S]*?if \(nextKey === audioNoticeKey && sameAudioNoticeParams\(audioNoticeParams, nextParams\)\) return[\s\S]*?renderStatus\(\)/
  )
  // 句子只在渲染期构造，形状与改动前一致（`${label} · ${notice}` / title = notice）。
  assert.match(recordScript, /const notice = audioNoticeKey \? t\(audioNoticeKey, audioNoticeParams\) : ''/)
  assert.match(recordScript, /statusLabel\.textContent = notice \? `\$\{label\} · \$\{notice\}` : label/)
  assert.match(recordScript, /if \(notice\) statusLabel\.title = notice/)
  // 降级告警转成 {key, params} 描述符，原始 detail 只作为插值参数出入。
  assert.match(recordScript, /function audioWarningKey\(warning\) \{[\s\S]*?return \{ key, params: detail \? \{ detail \} : null \}/)
  assert.match(recordScript, /audioWarningKey\(audioWarnings\[0\]\)/)
  // 调用点全部传键：没有任何一处把成品句子塞进 setAudioNotice()。
  assert.match(recordScript, /setAudioNotice\(inputs\.length \? '' : 'record\.error\.microphone-not-detected'\)/)
  assert.match(recordScript, /setAudioNotice\('record\.audio\.notice\.system-interrupted'\)/)
  assert.doesNotMatch(recordScript, /setAudioNotice\(t\(/, 'no call site may freeze a sentence')
  // 语言广播 -> applyTranslations() -> setState() -> renderStatus() 用新语言重建整句。
  const broadcast = recordScript.match(/window\.recordAPI\.onInterfaceLanguage\(\(language\) => \{[\s\S]*?\n\}\)/)
  assert.ok(broadcast, 'the language broadcast handler must exist')
  assert.match(broadcast[0], /setLanguage\(language\)\s*\n\s*applyTranslations\(\)\s*\n\s*setState\(state\)/)
  assert.match(recordScript, /function setState\(nextState\) \{[\s\S]*?renderStatus\(\)/)
})
