'use strict';

// R0-05a WebView2 媒体能力原型页面。
//
// 回答计划的四个问题（见 docs/plans/rust-migration/r0-media-webview.md）：
//   1. getDisplayMedia 是否弹原生选源 UI / 无手势时的真实错误名；
//   2. ScreenCaptureStarting 能否"程序指定源"（宿主侧已注册处理器，这里只记录现象）；
//   3. getDisplayMedia({audio:true}) 能否拿到系统音频轨，video/audio 约束是否生效；
//   4. MediaRecorder(webm) → 宿主写盘 → ffmpeg 可解析的最小闭环；透明浮层窗口下的差异。
//
// 页面约定：中心区域无可交互控件；user activation 由宿主注入真实点击提供
// （OS SendInput，失败时回退 Chromium CDP `Input.dispatchMouseEvent`）。

const invoke = (command, args) => {
  const api = window.__TAURI__ && window.__TAURI__.core;
  if (!api || typeof api.invoke !== 'function') {
    throw new Error('window.__TAURI__.core.invoke 不可用（withGlobalTauri 未生效？）');
  }
  return api.invoke(command, args);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/x-matroska;codecs=avc1',
  'video/mp4;codecs=avc1',
  'video/mp4'
];

const logEl = document.getElementById('log');
const phaseEl = document.getElementById('phase');
const winLabelEl = document.getElementById('win-label');
const scsModeEl = document.getElementById('scs-mode');

let phaseValue = 'boot';

function setPhase(value) {
  phaseValue = value;
  if (phaseEl) phaseEl.textContent = value;
}

function nowIso() {
  return new Date().toISOString();
}

function logLine(tag, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const line = `[${nowIso()}] ${tag} ${text}`;
  if (logEl) {
    logEl.textContent += `${line}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  }
  console.log(line);
}

function errorInfo(error) {
  if (!error) return { name: 'Unknown', message: '', code: null };
  return {
    name: error.name || Object.prototype.toString.call(error),
    message: String(error.message || error),
    code: typeof error.code === 'number' ? error.code : null
  };
}

function snapshotActivation() {
  const activation = navigator.userActivation;
  return { isActive: !!(activation && activation.isActive), hasBeenActive: !!(activation && activation.hasBeenActive) };
}

function environmentSnapshot() {
  return {
    href: location.href,
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    secureContext: window.isSecureContext,
    hasFocus: document.hasFocus(),
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      colorDepth: screen.colorDepth
    },
    window: {
      screenX: window.screenX,
      screenY: window.screenY,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight
    }
  };
}

function probeCapabilities() {
  const isTypeSupported = {};
  for (const mimeType of MIME_CANDIDATES) {
    try {
      isTypeSupported[mimeType] = typeof MediaRecorder !== 'undefined' ? MediaRecorder.isTypeSupported(mimeType) : false;
    } catch (error) {
      isTypeSupported[mimeType] = `error: ${errorInfo(error).message}`;
    }
  }
  const preferredMime = MIME_CANDIDATES.find((mimeType) => isTypeSupported[mimeType] === true) || null;
  const uaData = navigator.userAgentData
    ? { platform: navigator.userAgentData.platform, brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile }
    : null;
  return {
    hasMediaDevices: !!navigator.mediaDevices,
    hasGetDisplayMedia: typeof navigator.mediaDevices?.getDisplayMedia === 'function',
    hasGetUserMedia: typeof navigator.mediaDevices?.getUserMedia === 'function',
    hasMediaRecorder: typeof MediaRecorder !== 'undefined',
    isTypeSupported,
    preferredMime,
    uaData
  };
}

async function trackReport(stream) {
  const tracks = [];
  for (const track of stream.getTracks()) {
    const entry = {
      kind: track.kind,
      label: track.label,
      enabled: track.enabled,
      muted: track.muted,
      readyState: track.readyState,
      settings: null,
      capabilities: null,
      constraints: null
    };
    try {
      entry.settings = track.getSettings ? track.getSettings() : null;
    } catch (error) {
      entry.settingsError = errorInfo(error);
    }
    try {
      entry.capabilities = track.getCapabilities ? track.getCapabilities() : null;
    } catch (error) {
      entry.capabilitiesError = errorInfo(error);
    }
    try {
      entry.constraints = track.getConstraints ? track.getConstraints() : null;
    } catch (error) {
      entry.constraintsError = errorInfo(error);
    }
    tracks.push(entry);
  }
  return {
    trackCount: tracks.length,
    videoTracks: stream.getVideoTracks().length,
    audioTracks: stream.getAudioTracks().length,
    tracks
  };
}

function stopStream(stream) {
  if (!stream) return;
  try {
    for (const track of stream.getTracks()) track.stop();
  } catch (error) {
    logLine('stop-stream-error', errorInfo(error));
  }
}

function promiseWithTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`capture attempt timeout ${timeoutMs}ms（可能停在原生选源 UI 等待人工选择）`);
      error.name = 'HarnessTimeout';
      reject(error);
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function initScs() {
  try {
    const result = await invoke('init_scs');
    logLine('init-scs', result);
    return result;
  } catch (error) {
    logLine('init-scs-failed', errorInfo(error));
    return { error: errorInfo(error), registered: false };
  }
}

async function scsSummary() {
  try {
    const state = await invoke('scs_events');
    const events = (state.events || []).map((event) => ({
      window: event.window ?? null,
      seq: event.seq ?? null,
      event: event.event ?? null,
      mode: event.mode ?? null,
      argsPresent: event.argsPresent ?? null,
      cancelBefore: event.cancelBefore ?? null,
      handledBefore: event.handledBefore ?? null,
      cancelAfter: event.cancelAfter ?? null,
      frameName: event.frameName ?? null,
      frameSource: event.frameSource ?? null
    }));
    return { mode: state.mode, registered: state.registered, count: events.length, events };
  } catch (error) {
    return { error: errorInfo(error) };
  }
}

/**
 * 提供一次 trusted user activation。
 * 先真实 OS 点击（SendInput），失败再回退 Chromium CDP 点击。
 */
async function ensureActivation(options = {}) {
  const preferCdp = options.preferCdp === true;
  const before = snapshotActivation();
  const attempts = [];
  if (!preferCdp && before.isActive) {
    return { succeeded: true, method: 'already-active', before, attempts };
  }
  if (!preferCdp) {
    let osResult;
    try {
      osResult = await invoke('activate', { via: 'os' });
    } catch (error) {
      osResult = { error: errorInfo(error) };
    }
    const activation = snapshotActivation();
    attempts.push({ method: 'os-click', result: osResult, activation });
    if (activation.isActive) {
      logLine('activation', { method: 'os-click', ok: true, activation });
      return { succeeded: true, method: 'os-click', before, attempts };
    }
  }
  const x = Math.round(window.innerWidth / 2);
  const y = Math.round(window.innerHeight / 2);
  let cdpResult;
  try {
    cdpResult = await invoke('activate', { via: 'cdp', x, y });
  } catch (error) {
    cdpResult = { error: errorInfo(error) };
  }
  await sleep(400);
  const activationAfterCdp = snapshotActivation();
  attempts.push({ method: 'cdp-click', result: cdpResult, activation: activationAfterCdp });
  const succeeded = activationAfterCdp.isActive;
  logLine('activation', { method: 'cdp-click', ok: succeeded, activation: activationAfterCdp, attempts: attempts.length });
  return {
    succeeded,
    method: succeeded ? 'cdp-click' : 'none',
    before,
    attempts
  };
}

async function readVideoMetadata(stream, timeoutMs = 5000) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  const metadata = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('loadedmetadata timeout')), timeoutMs);
    video.onloadedmetadata = () => {
      clearTimeout(timer);
      resolve();
    };
    video.onerror = () => {
      clearTimeout(timer);
      reject(new Error('video element error'));
    };
  });
  await metadata;
  const playError = await video.play().then(() => null).catch((error) => errorInfo(error));
  return {
    video,
    info: {
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      duration: video.duration,
      readyState: video.readyState,
      playError
    }
  };
}

async function grabFrame(video, tag) {
  try {
    await sleep(500);
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 360;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    const saved = await invoke('save_frame', { tag, dataUrl });
    logLine('frame-saved', saved);
    return saved;
  } catch (error) {
    return { error: errorInfo(error) };
  }
}

/** 处于"等待选源/挂起"时留证：窗口快照（含子窗口）+ 整屏截图。 */
async function snapshotEvidence(tag) {
  const windows = await invoke('list_windows', { tag }).catch((error) => ({ error: String(error) }));
  const screenshot = await invoke('screenshot', { tag }).catch((error) => ({ error: String(error) }));
  logLine('evidence', {
    tag,
    screenshotPath: screenshot.path,
    screenshotSuccess: screenshot.success,
    screenshotStderr: screenshot.stderr ? String(screenshot.stderr).slice(0, 300) : undefined,
    childWindows: windows.childrenOfPrototypeWindows ? windows.childrenOfPrototypeWindows.length : undefined
  });
  return { tag, windows, screenshot };
}

/** 尝试关闭可能出现的 WebView2 Screen Capture UI（ESC）。 */
async function dismissScreenCaptureUi() {
  await invoke('activate', { via: 'escape' }).catch(() => {});
  await sleep(800);
  return snapshotActivation();
}

/**
 * 一次 getDisplayMedia 尝试；返回 { report, stream, evidence }。
 * 在等待期间（evidenceAtMs）抓窗口/截图证据——选源 UI 是否出现只能在这个窗口期观察。
 */
async function attemptCaptureWithEvidence(label, options) {
  const {
    audio = false,
    videoConstraints = true,
    timeoutMs = 12000,
    evidenceAtMs = 3500,
    activateFirst = true,
    preferCdp = false
  } = options;
  const report = {
    label,
    requested: { audio: !!audio, video: videoConstraints },
    activationBefore: snapshotActivation(),
    epochMs: Date.now()
  };
  let stream = null;
  let evidence = null;
  const startedAt = performance.now();
  try {
    if (activateFirst) {
      report.activation = await ensureActivation({ preferCdp });
    }
    report.activationAtCall = snapshotActivation();
    if (activateFirst && !report.activation?.succeeded) {
      report.status = 'no-user-activation';
      report.error = { name: 'HarnessNoActivation', message: '宿主未能提供 trusted user activation（OS 与 CDP 均失败）' };
      report.elapsedMs = Math.round(performance.now() - startedAt);
      return { report, stream: null, evidence };
    }
    const evidenceTimer = setTimeout(() => {
      snapshotEvidence(`${label}-during`)
        .then((value) => {
          evidence = value;
        })
        .catch(() => {});
    }, evidenceAtMs);
    try {
      const request = { video: videoConstraints, audio: !!audio };
      stream = await promiseWithTimeout(navigator.mediaDevices.getDisplayMedia(request), timeoutMs);
    } finally {
      clearTimeout(evidenceTimer);
    }
    report.status = 'resolved';
    report.elapsedMs = Math.round(performance.now() - startedAt);
    report.tracks = await trackReport(stream);
    try {
      const metadata = await readVideoMetadata(stream);
      report.videoElement = metadata.info;
      report.framePng = await grabFrame(metadata.video, label);
      try {
        metadata.video.pause();
        metadata.video.srcObject = null;
      } catch (error) {
        // 忽略播放器清理失败
      }
    } catch (error) {
      report.videoElement = { error: errorInfo(error) };
    }
  } catch (error) {
    report.elapsedMs = Math.round(performance.now() - startedAt);
    report.error = errorInfo(error);
    report.status = error && error.name === 'HarnessTimeout' ? 'timeout-pending' : 'rejected';
    if (!evidence) {
      evidence = await snapshotEvidence(`${label}-after-timeout`);
    }
  } finally {
    try {
      report.scs = await scsSummary();
    } catch (error) {
      report.scs = { error: errorInfo(error) };
    }
    logLine(`capture:${label}`, {
      status: report.status,
      elapsedMs: report.elapsedMs,
      error: report.error,
      audioTracks: report.tracks?.audioTracks,
      trackCount: report.tracks?.trackCount
    });
  }
  report.evidence = evidence;
  return { report, stream, evidence };
}

/** CDP/OS 激活探测（不做采集）。 */
async function activationProbe() {
  const before = snapshotActivation();
  let os = null;
  let afterOs = null;
  if (!before.isActive) {
    os = await invoke('activate', { via: 'os' }).catch((error) => ({ error: String(error) }));
    await sleep(120);
    afterOs = snapshotActivation();
    if (afterOs.isActive) {
      return { before, os, afterOs, cdp: null, afterCdp: afterOs, method: 'os-click' };
    }
  } else {
    return { before, os, afterOs: before, cdp: null, afterCdp: before, method: 'already-active' };
  }
  const x = Math.round(window.innerWidth / 2);
  const y = Math.round(window.innerHeight / 2);
  const cdp = await invoke('activate', { via: 'cdp', x, y }).catch((error) => ({ error: String(error) }));
  await sleep(450);
  const afterCdp = snapshotActivation();
  const method = afterCdp.isActive ? 'cdp-click' : 'none';
  logLine('activation-probe', { method, os, cdp, afterOs, afterCdp });
  return { before, os, afterOs, cdp, afterCdp, method };
}


function bytesToBase64(bytes) {
  let binary = '';
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

async function uploadBlobToHost(name, blob, meta) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let seq = 0;
  let acknowledgedBytes = 0;
  const CHUNK = 160 * 1024;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const slice = bytes.subarray(offset, offset + CHUNK);
    const result = await invoke('recording_chunk', { name, seq, data: bytesToBase64(slice) });
    acknowledgedBytes = result.bytes;
    seq += 1;
  }
  const saved = await invoke('recording_finish', { name });
  return { bytes: bytes.length, chunkCount: seq, acknowledgedBytes, saved, meta };
}

/** MediaRecorder 录制一个 canvas 合成流（与产品 pipeline 相同的编码路径）。 */
async function recordDisplayStream(stream, options) {
  const {
    name,
    durationMs = 6000,
    maxWidth = 1280,
    maxHeight = 720,
    fps = 30,
    withAudio = true
  } = options;
  const report = { name, durationMs, maxWidth, maxHeight, fps, startedAt: Date.now() };
  let video = null;
  let recorder = null;
  let drawTimer = null;
  try {
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    const sourceWidth = video.videoWidth || 1280;
    const sourceHeight = video.videoHeight || 720;
    const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
    const width = Math.max(2, Math.round((sourceWidth * scale) / 2) * 2);
    const height = Math.max(2, Math.round((sourceHeight * scale) / 2) * 2);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    const draw = () => {
      try {
        context.drawImage(video, 0, 0, width, height);
      } catch (error) {
        // 忽略瞬时绘制失败
      }
    };
    draw();
    drawTimer = setInterval(draw, 1000 / fps);
    const canvasStream = canvas.captureStream(fps);
    const audioTracks = withAudio ? stream.getAudioTracks() : [];
    for (const track of audioTracks) canvasStream.addTrack(track);
    const mimeType = MIME_CANDIDATES.find((type) => {
      try {
        return MediaRecorder.isTypeSupported(type);
      } catch (error) {
        return false;
      }
    }) || '';
    const recorderOptions = { videoBitsPerSecond: 1200000 };
    if (mimeType) recorderOptions.mimeType = mimeType;
    if (audioTracks.length) recorderOptions.audioBitsPerSecond = 128000;
    recorder = new MediaRecorder(canvasStream, recorderOptions);
    const chunks = [];
    let chunkEvents = 0;
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) {
        chunks.push(event.data);
        chunkEvents += 1;
      }
    };
    const stoppedPromise = new Promise((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.start(1000);
    report.recorder = {
      requestedMimeType: mimeType || null,
      actualMimeType: recorder.mimeType,
      state: recorder.state,
      videoBitsPerSecond: recorder.videoBitsPerSecond || null,
      canvas: { width, height, fps },
      source: { width: sourceWidth, height: sourceHeight },
      audioTracksAdded: audioTracks.length
    };
    logLine('recording:start', { name, actualMimeType: recorder.mimeType, canvas: { width, height }, audioTracksAdded: audioTracks.length });
    await sleep(durationMs);
    recorder.stop();
    await stoppedPromise;
    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'video/webm' });
    const upload = await uploadBlobToHost(name, blob, { chunkEvents, chunkSizes: chunks.map((chunk) => chunk.size) });
    report.blob = upload;
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.error = errorInfo(error);
    logLine('recording:failed', { name, error: report.error });
  } finally {
    try {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    } catch (error) {
      // 忽略
    }
    if (drawTimer) clearInterval(drawTimer);
    if (video) {
      try {
        video.pause();
        video.srcObject = null;
      } catch (error) {
        // 忽略
      }
    }
  }
  logLine('recording:done', { name, ok: report.ok, bytes: report.blob?.bytes, chunkCount: report.blob?.chunkCount, saved: report.blob?.saved?.path });
  return report;
}

/** 纯 canvas.captureStream 的 MediaRecorder 闭环（不依赖桌面采集，验证 webm 编码/写盘/ffmpeg）。 */
async function recordCanvasOnly(name, durationMs = 3000, fps = 30) {
  const report = { name, durationMs, fps, startedAt: Date.now() };
  let recorder = null;
  let drawTimer = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext('2d', { alpha: false });
    let frames = 0;
    const draw = () => {
      frames += 1;
      const hue = (frames * 7) % 360;
      context.fillStyle = `hsl(${hue} 70% 40%)`;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#ffffff';
      context.font = '28px sans-serif';
      context.fillText(`R0-05a canvas-only frame ${frames}`, 24, 64);
    };
    draw();
    drawTimer = setInterval(draw, 1000 / fps);
    const stream = canvas.captureStream(fps);
    const mimeType = MIME_CANDIDATES.find((type) => {
      try {
        return MediaRecorder.isTypeSupported(type);
      } catch (error) {
        return false;
      }
    }) || '';
    const recorderOptions = { videoBitsPerSecond: 800000 };
    if (mimeType) recorderOptions.mimeType = mimeType;
    recorder = new MediaRecorder(stream, recorderOptions);
    const chunks = [];
    let chunkEvents = 0;
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) {
        chunks.push(event.data);
        chunkEvents += 1;
      }
    };
    const stoppedPromise = new Promise((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.start(1000);
    report.recorder = {
      requestedMimeType: mimeType || null,
      actualMimeType: recorder.mimeType,
      state: recorder.state,
      canvas: { width: canvas.width, height: canvas.height, fps }
    };
    await sleep(durationMs);
    recorder.stop();
    await stoppedPromise;
    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'video/webm' });
    const upload = await uploadBlobToHost(name, blob, { chunkEvents, chunks: chunks.length, frames });
    report.blob = upload;
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.error = errorInfo(error);
  } finally {
    try {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    } catch (error) {
      // 忽略
    }
    if (drawTimer) clearInterval(drawTimer);
  }
  logLine('recording:canvas-only', { name, ok: report.ok, bytes: report.blob?.bytes, saved: report.blob?.saved?.path });
  return report;
}

async function finishMain(report) {
  setPhase('finish');
  report.finishedAt = Date.now();
  try {
    const result = await invoke('finish_report', { report });
    logLine('finish', result);
  } catch (error) {
    logLine('finish-failed', errorInfo(error));
  }
}

function baseReport(info) {
  return {
    window: info.label,
    label: info.label,
    scenario: info.scenario,
    startedAt: Date.now(),
    environment: environmentSnapshot(),
    host: info,
    capabilities: probeCapabilities()
  };
}

/** 场景 probe：只测 OS / CDP 两条 trusted activation 路径，不做采集。 */
async function runProbeScenario(info) {
  setPhase('probe');
  const report = baseReport(info);
  report.cursorProbe = await invoke('cursor_probe').catch((error) => ({ error: errorInfo(error) }));
  logLine('cursor-probe', report.cursorProbe);
  report.activation = await activationProbe();
  report.activationFinal = snapshotActivation();
  await finishMain(report);
}

/** 场景 nogesture：全新页面、零 activation，直接调用 getDisplayMedia（记录真实错误/挂起）。 */
async function runNoGestureScenario(info) {
  setPhase('nogesture');
  const report = baseReport(info);
  report.cursorProbe = await invoke('cursor_probe').catch((error) => ({ error: errorInfo(error) }));
  report.activationBefore = snapshotActivation();
  logLine('nogesture-start', { activation: report.activationBefore, dpr: window.devicePixelRatio });
  const capture = await attemptCaptureWithEvidence('nogestureAudioVideo', {
    activateFirst: false,
    audio: true,
    videoConstraints: true,
    timeoutMs: 12000,
    evidenceAtMs: 3500
  });
  report.capture = capture.report;
  report.activationAfterAttempt = snapshotActivation();
  await finishMain(report);
}

/** 场景 gesture：激活 + 单次采集（webm 闭环可行时录制），最后跑 canvas-only 闭环。 */
async function runGestureScenario(info) {
  setPhase('gesture');
  const report = baseReport(info);
  report.cursorProbe = await invoke('cursor_probe').catch((error) => ({ error: errorInfo(error) }));
  logLine('cursor-probe', report.cursorProbe);
  report.activationProbe = await activationProbe();
  report.activationProbeFinal = snapshotActivation();
  logLine('activation-probe', { method: report.activationProbe.method, final: report.activationProbeFinal });

  const capture = await attemptCaptureWithEvidence('gestureAudioVideo', {
    activateFirst: true,
    audio: true,
    videoConstraints: true,
    timeoutMs: 12000,
    evidenceAtMs: 3500
  });
  report.capture = capture.report;
  report.activationAfterCapture = snapshotActivation();

  if (capture.report.status === 'resolved' && capture.stream) {
    setPhase('recording');
    report.recording = await recordDisplayStream(capture.stream, {
      name: 'display-av.webm',
      durationMs: 6000,
      withAudio: true
    });
    stopStream(capture.stream);
  } else {
    // 挂起 = WebView2 的 Screen Capture UI 在等待人工选源；关掉它以免影响后续步骤。
    setPhase('dismiss-ui');
    report.activationAfterDismiss = await dismissScreenCaptureUi();
    report.afterDismissWindows = await invoke('list_windows', { tag: 'after-dismiss' }).catch((error) => ({ error: String(error) }));
  }

  setPhase('canvas-recording');
  report.canvasRecording = await recordCanvasOnly('canvas-only.webm', 3000, 30);
  report.windowsAtFinish = await invoke('windows_report').catch((error) => ({ error: String(error) }));
  await finishMain(report);
}

/** 场景 overlay（主窗口侧）：显示浮层、等待浮层回报、留证、收尾。 */
async function runOverlayCoordinator(info) {
  setPhase('overlay-coordinator');
  const report = baseReport(info);
  // 等浮层页面 ready（最多 20s）。
  let overlayReady = null;
  const readyDeadline = performance.now() + 20000;
  while (performance.now() < readyDeadline) {
    const poll = await invoke('overlay_poll').catch(() => null);
    if (poll && poll.epochMs) break;
    await sleep(300);
  }
  const start = await invoke('overlay_start').catch((error) => ({ error: String(error) }));
  report.overlayPhaseStart = start;
  logLine('overlay-phase', start);
  const deadline = performance.now() + 120000;
  let overlay = null;
  while (performance.now() < deadline) {
    const poll = await invoke('overlay_poll').catch(() => null);
    if (poll && poll.result) {
      overlay = poll.result;
      break;
    }
    await sleep(300);
  }
  report.overlay = overlay || { status: 'overlay-timeout' };
  report.overlayWindows = await invoke('list_windows', { tag: 'overlay-phase' }).catch((error) => ({ error: String(error) }));
  await finishMain(report);
}

/** 场景 overlay（浮层窗口侧）：CDP 未聚焦激活 + OS 点击激活 + 单次采集 + 留证。 */
async function runOverlayTest(info) {
  setPhase('overlay-boot');
  const report = baseReport(info);
  document.body.classList.add('overlay');
  report.cursorProbe = await invoke('cursor_probe').catch((error) => ({ error: errorInfo(error) }));
  report.ready = await invoke('overlay_ready').catch((error) => ({ error: String(error) }));
  logLine('overlay-boot', { ready: report.ready });

  setPhase('overlay-wait-go');
  let phase = report.ready?.phase || 'waiting';
  const waitStarted = performance.now();
  while (phase !== 'go' && performance.now() - waitStarted < 90000) {
    await sleep(250);
    const poll = await invoke('overlay_poll').catch(() => null);
    phase = (poll && poll.phase) || 'waiting';
  }
  report.phaseWhenStarted = phase;
  report.hasFocusBeforeActivation = document.hasFocus();

  // (a) 窗口可见但未聚焦：CDP 注入 input 提供 activation。
  setPhase('overlay-cdp');
  let cdpClick = null;
  try {
    cdpClick = await invoke('activate', {
      via: 'cdp',
      x: Math.round(window.innerWidth / 2),
      y: Math.round(window.innerHeight / 2)
    });
  } catch (error) {
    cdpClick = { error: errorInfo(error) };
  }
  await sleep(400);
  report.cdpClick = cdpClick;
  report.activationAfterCdp = snapshotActivation();
  report.hasFocusAfterCdp = document.hasFocus();
  const cdpCapture = await attemptCaptureWithEvidence('overlayCdpAudioVideo', {
    activateFirst: false,
    audio: true,
    videoConstraints: true,
    timeoutMs: 12000,
    evidenceAtMs: 3500
  });
  report.captureAfterCdp = cdpCapture.report;
  stopStream(cdpCapture.stream);
  report.activationAfterCdpCapture = snapshotActivation();

  // (b) 真实 OS 点击激活（会夺走焦点）：确认 OS 焦点是否是必要条件。
  setPhase('overlay-os');
  report.osActivation = await activationProbe();
  const osCapture = await attemptCaptureWithEvidence('overlayOsAudioVideo', {
    activateFirst: true,
    audio: true,
    videoConstraints: true,
    timeoutMs: 12000,
    evidenceAtMs: 3500
  });
  report.captureAfterOs = osCapture.report;
  report.hasFocusAfterOs = document.hasFocus();
  if (osCapture.stream) {
    setPhase('overlay-recording');
    report.recording = await recordDisplayStream(osCapture.stream, {
      name: 'overlay-os-click.webm',
      durationMs: 3000,
      fps: 15,
      maxWidth: 960,
      maxHeight: 540,
      withAudio: true
    });
  }
  stopStream(osCapture.stream);
  report.windowsDuringTest = await invoke('windows_report').catch((error) => ({ error: String(error) }));
  report.finishedAt = Date.now();
  setPhase('overlay-report');
  await invoke('overlay_report', { report }).catch((error) => logLine('overlay-report-failed', errorInfo(error)));
}

async function boot() {
  const info = await invoke('host_info');
  if (winLabelEl) winLabelEl.textContent = info.label;
  if (scsModeEl) scsModeEl.textContent = String(info.scsMode);
  document.title = `R0-05a ${info.label} ${info.scenario || ''}`;
  logLine('boot', {
    label: info.label,
    scenario: info.scenario,
    scsMode: info.scsMode,
    tag: info.tag,
    webviewVersion: info.webviewVersion,
    monitors: info.monitors,
    windows: info.windows
  });
  const scs = await initScs();
  const scenario = info.scenario || 'full';
  const enriched = { ...info, scsInit: scs };
  if (info.label === 'media-overlay') {
    if (scenario === 'overlay') {
      await runOverlayTest(enriched);
    } else {
      await invoke('overlay_ready').catch(() => {});
    }
  } else if (scenario === 'probe') {
    await runProbeScenario(enriched);
  } else if (scenario === 'nogesture') {
    await runNoGestureScenario(enriched);
  } else if (scenario === 'overlay') {
    await runOverlayCoordinator(enriched);
  } else {
    await runGestureScenario(enriched);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  boot().catch(async (error) => {
    logLine('fatal', errorInfo(error));
    setPhase('fatal');
    try {
      await invoke('finish_report', {
        report: { status: 'page-fatal', window: 'boot', error: errorInfo(error), environment: environmentSnapshot() }
      });
    } catch (inner) {
      logLine('fatal-report-failed', errorInfo(inner));
    }
  });
});
