'use strict'

// Recording audio preflight (review item B04): the pure half of "check the sound
// before you record".
//
// Two windows can touch a capture device before a take exists:
//   * the workbench (config/routes/recording.js) verifies the microphone
//     permission and level beside the Start button, because that is where the
//     device is chosen and where a Windows permission problem can be fixed;
//   * the recording bar (record/record.js) verifies BOTH lanes on the recording
//     window's own main frame, which is the only frame the
//     setDisplayMediaRequestHandler serves loopback audio to.
// Both surfaces drive this module, so they cannot disagree about what "silent"
// means, how long a sample may run, or whether a device was opened at all.
//
// Deliberately free of i18n text, DOM, timers and device calls: every function
// takes explicit inputs (and a caller-supplied clock), and the windows own the
// copy, the AnalyserNode and the getUserMedia/getDisplayMedia calls. The module
// is loaded three ways, like the other shared modules:
//   * require('../shared/audio-preflight') from node / tests;
//   * a classic <script> in a window (CSP forbids modules over the network);
//   * the renderer reads the global the UMD footer installs.

;(function initAudioPreflight(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.audioPreflight = api
})(typeof globalThis === 'object' ? globalThis : this, () => {
  const LANES = Object.freeze(['system', 'microphone'])
  // The review budget: one click samples at most five seconds. The cap lives here
  // so a caller cannot ask for a longer window than the acceptance allows.
  const SAMPLE_BUDGET_MS = 5000
  const SAMPLE_INTERVAL_MS = 100
  // Every test track and the AudioContext must be gone within one second of the
  // sample ending; markReleased() reports whether that happened.
  const RELEASE_BUDGET_MS = 1000
  // Peak amplitude thresholds (0..1 full scale). Speech peaks well above 0.08;
  // anything under 0.01 is the noise floor of an open but silent device.
  const LEVEL_THRESHOLDS = Object.freeze({ silent: 0.01, low: 0.08 })
  const PHASES = Object.freeze(['idle', 'requesting', 'sampling', 'done', 'cancelled'])

  function timeOf(value) {
    const number = Number(value)
    return Number.isFinite(number) ? number : 0
  }

  function clampLevel(value) {
    const number = Number(value)
    if (!Number.isFinite(number) || number <= 0) return 0
    return number >= 1 ? 1 : number
  }

  // Float32 time-domain samples (-1..1), as AnalyserNode.getFloatTimeDomainData()
  // returns them.
  function peakOfFloat(samples) {
    if (!samples || typeof samples.length !== 'number') return 0
    let peak = 0
    for (let index = 0; index < samples.length; index += 1) {
      const value = Math.abs(Number(samples[index]))
      if (Number.isFinite(value) && value > peak) peak = value
    }
    return clampLevel(peak)
  }

  // 8-bit time-domain samples are unsigned with 128 as the zero line.
  function peakOfBytes(bytes) {
    if (!bytes || typeof bytes.length !== 'number') return 0
    let peak = 0
    for (let index = 0; index < bytes.length; index += 1) {
      const raw = Number(bytes[index])
      if (!Number.isFinite(raw)) continue
      const value = Math.abs(raw - 128) / 128
      if (value > peak) peak = value
    }
    return clampLevel(peak)
  }

  function classifyLevel(peak) {
    const level = clampLevel(peak)
    if (level < LEVEL_THRESHOLDS.silent) return 'silent'
    if (level < LEVEL_THRESHOLDS.low) return 'low'
    return 'good'
  }

  // Meter width, not a loudness claim: a linear peak parks normal speech in the
  // bottom fifth of the bar, so the bar is drawn from the square root.
  function levelPercent(peak) {
    return Math.round(Math.sqrt(clampLevel(peak)) * 100)
  }

  // One bounded sampling window. The deadline is inclusive: at exactly five
  // seconds the window is over, so a run can never be longer than the budget.
  function createSampleWindow(options = {}) {
    const requested = Number(options.durationMs)
    const durationMs = Math.min(SAMPLE_BUDGET_MS, Math.max(1, Number.isFinite(requested) && requested > 0 ? requested : SAMPLE_BUDGET_MS))
    const startedAt = timeOf(options.startedAt)
    const deadline = startedAt + durationMs
    return {
      durationMs,
      startedAt,
      deadline,
      elapsed(now) {
        return Math.max(0, Math.min(durationMs, timeOf(now) - startedAt))
      },
      remaining(now) {
        return Math.max(0, deadline - timeOf(now))
      },
      expired(now) {
        return timeOf(now) >= deadline
      },
      // The next tick never overshoots the budget.
      nextDelay(now, intervalMs = SAMPLE_INTERVAL_MS) {
        const base = Math.max(10, Math.round(Number(intervalMs) || SAMPLE_INTERVAL_MS))
        return Math.max(0, Math.min(base, Math.max(0, deadline - timeOf(now))))
      },
      progress(now) {
        return durationMs > 0 ? Math.min(1, Math.max(0, (timeOf(now) - startedAt) / durationMs)) : 1
      }
    }
  }

  // DOMException names the two device APIs actually produce, mapped onto the four
  // reasons a user can act on. Anything else falls back to message sniffing so an
  // Electron/Chromium rename does not silently turn into "unknown".
  const ERROR_REASONS = Object.freeze({
    NotAllowedError: 'denied',
    PermissionDeniedError: 'denied',
    SecurityError: 'denied',
    NotFoundError: 'missing',
    DevicesNotFoundError: 'missing',
    OverconstrainedError: 'missing',
    ConstraintNotSatisfiedError: 'missing',
    NotReadableError: 'busy',
    TrackStartError: 'busy',
    AbortError: 'busy',
    DeviceLost: 'lost',
    InvalidStateError: 'lost'
  })

  function errorReason(name, message) {
    if (ERROR_REASONS[name]) return ERROR_REASONS[name]
    if (/denied|not allowed|permission/i.test(message)) return 'denied'
    if (/not found|no device|device not present|overconstrained/i.test(message)) return 'missing'
    if (/in use|busy|readable|could not start|could not be started/i.test(message)) return 'busy'
    if (/disconnected|unplugged|lost/i.test(message)) return 'lost'
    return 'failed'
  }

  // Prompt codes, never sentences: the window maps them onto its own copy. The
  // system lane has no "missing" case (the Windows mix is a virtual device that
  // either exists or was refused), so those reasons collapse into "unavailable".
  function deviceErrorCode(error, lane = 'microphone') {
    const target = LANES.includes(lane) ? lane : 'microphone'
    const name = typeof error === 'string' ? error : (error && typeof error.name === 'string' ? error.name : '')
    const message = error && typeof error.message === 'string' ? error.message : ''
    const reason = errorReason(name, message)
    if (target === 'system' && (reason === 'missing' || reason === 'busy')) return 'system-unavailable'
    return `${target}-${reason}`
  }

  // The executable actions offered for a prompt code, in display order. The
  // workbench can open Windows' microphone privacy page, the recording bar cannot
  // (it has no shell channel), so the caller passes its capabilities and gets the
  // subset it can actually perform.
  const MICROPHONE_ACTIONS = Object.freeze(['open-microphone-settings', 'record-system-only', 'record-silent'])
  const SYSTEM_ACTIONS = Object.freeze(['record-microphone-only', 'record-silent'])
  // Every microphone prompt (including a generic open failure) needs a way out that
  // does not require a working microphone, so "system audio only" and "no sound" are
  // always offered.
  const MICROPHONE_PROMPT = /^microphone-(?:denied|missing|busy|lost|silent|failed)$/
  const SYSTEM_PROMPT = /^system-(?:denied|unavailable|lost|silent|failed)$/

  function preflightActions(code, capabilities = {}) {
    const openSettings = capabilities.openSettings !== false
    const value = typeof code === 'string' ? code : ''
    if (MICROPHONE_PROMPT.test(value)) {
      return MICROPHONE_ACTIONS.filter((action) => openSettings || action !== 'open-microphone-settings')
    }
    if (SYSTEM_PROMPT.test(value)) return SYSTEM_ACTIONS.slice()
    return []
  }

  // The machine behind the two buttons. Its job is to make three acceptance
  // claims checkable rather than asserted:
  //   * nothing opens a device before the user clicks: begin() is the only entry,
  //     and noteOpen() refuses while idle, so `opens` stays 0;
  //   * a run samples for at most the budget (createSampleWindow) and can always be
  //     cancelled, which ends the run and lets the caller release the tracks;
  //   * a release within RELEASE_BUDGET_MS is reported, not assumed.
  function createPreflight(options = {}) {
    const clock = typeof options.now === 'function' ? options.now : () => Date.now()
    let phase = 'idle'
    let requests = 0
    let opens = 0
    let startedAt = 0
    let endedAt = 0
    let releasedAt = 0
    let sampleWindow = null
    const lanes = {
      system: blankLane(),
      microphone: blankLane()
    }

    function blankLane() {
      return { requested: false, opened: false, sampled: 0, peak: 0, level: 'silent', code: '' }
    }

    function isActive() {
      return phase === 'requesting' || phase === 'sampling'
    }

    function begin(request = {}) {
      if (isActive()) return false
      const system = request.system === true
      const microphone = request.microphone === true
      if (!system && !microphone) return false
      requests += 1
      startedAt = timeOf(clock())
      endedAt = 0
      releasedAt = 0
      lanes.system = { ...blankLane(), requested: system }
      lanes.microphone = { ...blankLane(), requested: microphone }
      sampleWindow = createSampleWindow({ durationMs: options.sampleMs, startedAt })
      phase = 'requesting'
      return true
    }

    // Legal only after begin() and only for a lane this run asked for.
    function canOpen(lane) {
      return isActive() && Boolean(lanes[lane]) && lanes[lane].requested === true
    }

    // Called once per lane, immediately before the device is opened.
    function noteOpen(lane) {
      if (!canOpen(lane) || lanes[lane].opened) return false
      lanes[lane].opened = true
      opens += 1
      return true
    }

    function startSampling() {
      if (phase !== 'requesting') return false
      phase = 'sampling'
      return true
    }

    function sample(lane, peak) {
      const entry = lanes[lane]
      if (phase !== 'sampling' || !entry || !entry.requested) return false
      entry.sampled += 1
      const value = clampLevel(peak)
      if (value > entry.peak) entry.peak = value
      entry.level = classifyLevel(entry.peak)
      return true
    }

    function failLane(lane, error) {
      const entry = lanes[lane]
      if (!entry || !entry.requested) return ''
      const code = typeof error === 'string' && error.includes('-') ? error : deviceErrorCode(error, lane)
      entry.code = code
      entry.level = 'silent'
      return code
    }

    function remaining(now) {
      return sampleWindow ? sampleWindow.remaining(timeOf(now === undefined ? clock() : now)) : 0
    }

    function expired(now) {
      return sampleWindow ? sampleWindow.expired(timeOf(now === undefined ? clock() : now)) : false
    }

    function finish(outcome = 'done', at) {
      if (!isActive()) return false
      endedAt = timeOf(at === undefined ? clock() : at)
      phase = outcome === 'cancelled' ? 'cancelled' : 'done'
      return true
    }

    function cancel(at) {
      return finish('cancelled', at)
    }

    // The caller reports when the last track and the AudioContext were released.
    // Returns whether that landed inside the one-second budget.
    function markReleased(at) {
      if (!endedAt) return false
      releasedAt = timeOf(at === undefined ? clock() : at)
      return releasedAt - endedAt <= RELEASE_BUDGET_MS
    }

    // A lane with an error wins; otherwise an opened lane that never produced a
    // sample is "silent", which is the case that sends people to a re-record.
    function promptCode() {
      for (const lane of LANES) {
        const entry = lanes[lane]
        if (entry.requested && entry.code) return entry.code
      }
      for (const lane of LANES) {
        const entry = lanes[lane]
        if (entry.requested && entry.opened && entry.sampled > 0 && entry.level === 'silent') return `${lane}-silent`
      }
      return ''
    }

    function status() {
      const code = promptCode()
      const released = releasedAt > 0 && endedAt > 0 && releasedAt - endedAt <= RELEASE_BUDGET_MS
      return {
        phase,
        active: isActive(),
        requests,
        opens,
        startedAt,
        endedAt,
        releasedAt,
        releasedWithinBudget: released,
        sample: sampleWindow
          ? { durationMs: sampleWindow.durationMs, startedAt: sampleWindow.startedAt, deadline: sampleWindow.deadline }
          : null,
        lanes: {
          system: { ...lanes.system },
          microphone: { ...lanes.microphone }
        },
        promptCode: code,
        actions: preflightActions(code, options.capabilities).slice()
      }
    }

    return {
      begin,
      isActive,
      canOpen,
      noteOpen,
      startSampling,
      sample,
      failLane,
      remaining,
      expired,
      finish,
      cancel,
      markReleased,
      promptCode,
      status
    }
  }

  // The static summary both surfaces show beside their start button: what this
  // take will capture. The system lane is the Windows system MIX in every mode,
  // so window mode is flagged as "also contains other apps" and never as
  // "window only" - the copy must not promise something the file cannot keep.
  function summarizeCapture(input = {}) {
    const mode = input.mode === 'window' ? 'window' : (input.mode === 'region' ? 'region' : 'display')
    const system = input.system !== false
    const microphone = input.microphone === true
    return {
      mode,
      source: {
        mode,
        name: typeof input.sourceName === 'string' ? input.sourceName.trim() : '',
        detail: typeof input.sourceDetail === 'string' ? input.sourceDetail.trim() : ''
      },
      system: {
        enabled: system,
        scope: 'system-mix',
        includesOtherApps: true,
        // Windows-only: the display-media handler attaches loopback audio there.
        loopback: input.loopback !== false,
        windowNote: system && mode === 'window'
      },
      microphone: {
        enabled: microphone,
        deviceLabel: typeof input.microphoneLabel === 'string' ? input.microphoneLabel.trim() : ''
      }
    }
  }

  // B04 (plan item 13): one check can hold at most one system stream, one microphone
  // stream and one AudioContext, and it must be able to give every one of them up even
  // when a permission prompt is still open. The ledger is the single place that owns
  // "which devices does the CURRENT run hold":
  //   * begin() invalidates (and releases) the previous run, so a re-check can never
  //     inherit a device from the run it replaced;
  //   * adoptStream()/adoptContext() refuse a resource that belongs to an outdated run
  //     and release it on the spot - that is how a permission granted AFTER the deadline
  //     (or after a cancel) is stopped instead of being held indefinitely;
  //   * release()/releaseAll() stop every track and close every context without caring
  //     about the order they arrived in.
  // Window/DOM free on purpose: the recording bar and the workbench both drive it.
  function createPreflightResources() {
    let generation = 0
    // `active` is what makes a released run over: the id alone would keep answering
    // "current" after the deadline ended the check, and a late permission grant would be
    // adopted by a run nobody is watching.
    let current = { id: 0, active: false, streams: new Set(), contexts: new Set() }

    function stopStream(stream) {
      for (const track of stream?.getTracks?.() || []) {
        try { track.stop() } catch {}
      }
    }

    function closeContext(context) {
      if (!context || typeof context.close !== 'function') return
      try {
        const closing = context.close()
        if (closing && typeof closing.catch === 'function') closing.catch(() => {})
      } catch {}
    }

    function releaseRun(run) {
      const streams = [...run.streams]
      const contexts = [...run.contexts]
      run.streams.clear()
      run.contexts.clear()
      for (const stream of streams) stopStream(stream)
      for (const context of contexts) closeContext(context)
      return { streams: streams.length, contexts: contexts.length }
    }

    function isCurrent(id) {
      return current.active && generation > 0 && Number(id) === current.id
    }

    return {
      // Starts a new run. Any resource the previous run still held is released first:
      // "check again" and "the window is closing" are the same cleanup.
      begin() {
        releaseRun(current)
        generation += 1
        current = { id: generation, active: true, streams: new Set(), contexts: new Set() }
        return current.id
      },
      isCurrent,
      // Registers a stream that just arrived. Returns false (and stops it) when the run
      // that asked for it is over - the late-grant path.
      adoptStream(id, stream) {
        if (!stream) return false
        if (!isCurrent(id)) {
          stopStream(stream)
          return false
        }
        current.streams.add(stream)
        return true
      },
      adoptContext(id, context) {
        if (!context) return false
        if (!isCurrent(id)) {
          closeContext(context)
          return false
        }
        current.contexts.add(context)
        return true
      },
      // Releases the named run (or the current one when `id` is omitted). A release for an
      // old run never touches the current one: the previous authorization callback can only
      // clean up its own resources.
      release(id) {
        if (id !== undefined && id !== null && !isCurrent(id)) {
          // The run that owns these resources already released them when it ended; there is
          // nothing of the CURRENT run to touch here.
          return false
        }
        releaseRun(current)
        current.active = false
        return true
      },
      releaseAll() {
        releaseRun(current)
        current.active = false
      },
      // What is actually held right now (used by the status renderers and the tests).
      snapshot() {
        return {
          id: current.id,
          streams: current.streams.size,
          contexts: current.contexts.size,
          tracks: [...current.streams].reduce((total, stream) => total + (stream?.getTracks?.()?.length || 0), 0)
        }
      }
    }
  }

  return {
    LANES,
    PHASES,
    SAMPLE_BUDGET_MS,
    SAMPLE_INTERVAL_MS,
    RELEASE_BUDGET_MS,
    LEVEL_THRESHOLDS,
    clampLevel,
    peakOfFloat,
    peakOfBytes,
    classifyLevel,
    levelPercent,
    createSampleWindow,
    createPreflightResources,
    deviceErrorCode,
    preflightActions,
    createPreflight,
    summarizeCapture
  }
})
