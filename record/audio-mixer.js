/**
 * Recording audio mixer (P0-3-T1).
 *
 * The region recorder captures video frames into a canvas and publishes them with
 * `canvas.captureStream()`. That stream has no audio track, so system sound (from
 * `getDisplayMedia` loopback) and the optional microphone stream are summed here and
 * appended to the canvas stream before `MediaRecorder` starts.
 *
 * R2 (contract §12) extends it with the in-recording controls the compact bar needs:
 * a per-bus gain setter, an independent microphone mute that never touches the system
 * bus, and a cheap RMS level readback for the microphone indicator. Every method is a
 * no-op on the degraded (silent) mix, so the renderer never has to branch on `active`.
 *
 * Everything in this module is pure or injectable: `AudioContext` is supplied by the
 * caller so the gain graph can be asserted in `test/audio-mixer.test.js` with a fake
 * context, and the module also runs as a plain `<script>` in `record/record.html`
 * (it publishes `window.audioMixer`, mirroring `record/recording-utils.js`).
 */
;(function initAudioMixer(globalScope) {
  // Kept in sync with the AAC settings accepted by `buildFfmpegArgs` in
  // record/recording-utils.js (`-b:a 160k -ar 48000 -ac 2`).
  const AUDIO_BITS_PER_SECOND = 160_000
  const AUDIO_SAMPLE_RATE = 48_000
  const AUDIO_CHANNEL_COUNT = 2
  const DEFAULT_GAIN = 1
  // Settings validation only checks that a gain is a number, so the mixer clamps
  // defensively instead of trusting the stored value.
  const MAX_GAIN = 4
  // The <input type="range"> in the control bar exposes 0..MAX_GAIN of travel; the
  // default value keeps unity gain for a normal take.
  const MIN_GAIN = 0
  const LEVEL_ANALYSER_FFT_SIZE = 1024

  function normalizeGain(value, fallback = DEFAULT_GAIN) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(MAX_GAIN, Math.max(MIN_GAIN, parsed))
  }

  /**
   * Microphone acquisition constraints. The workbench stores the chosen input device
   * (`record.audioMicrophoneDeviceId`, '' = system default); an explicit device is
   * requested with `exact` so Chromium cannot silently substitute another input.
   * The caller falls back to the default device (and tells the user) when `exact`
   * cannot be satisfied.
   */
  function microphoneConstraints(options = {}) {
    const source = options && typeof options === 'object' ? options : {}
    const constraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false
    }
    const deviceId = typeof source.deviceId === 'string' ? source.deviceId.trim() : ''
    if (deviceId) constraints.deviceId = { exact: deviceId }
    return constraints
  }

  /**
   * Pure gain plan for the two optional buses.
   * `masterGain` only attenuates when two audible buses would otherwise clip by summing.
   */
  function createGainPlan(options = {}) {
    const source = options && typeof options === 'object' ? options : {}
    const systemGain = normalizeGain(source.systemGain)
    const micGain = normalizeGain(source.micGain)
    const audibleBuses = [systemGain, micGain].filter((gain) => gain > 0).length
    const total = systemGain + micGain
    const masterGain = audibleBuses > 1 && total > 1 ? Math.round((1 / total) * 10000) / 10000 : 1
    return {
      systemGain,
      micGain,
      systemAudible: systemGain > 0,
      micAudible: micGain > 0,
      masterGain
    }
  }

  /**
   * Pure degradation policy: which buses ended up in the recording and what the user
   * must be told. Keeps the "microphone failed -> system only" ladder out of the DOM code.
   *
   * P0-1-T5 (S12): the values are i18n keys, not sentences. This module also runs
   * under Node (test/audio-mixer.test.js) where no locale table is loaded, so it
   * must stay language-free and let the renderer resolve the key with `t()`.
   */
  const AUDIO_NOTICES = Object.freeze({
    microphoneUnavailable: 'record.audio.notice.microphone-unavailable',
    systemUnavailable: 'record.audio.notice.system-unavailable',
    audioUnavailable: 'record.audio.notice.audio-unavailable',
    microphoneFailed: 'record.audio.notice.microphone-failed',
    systemFailed: 'record.audio.notice.system-failed'
  })

  function describeAudioOutcome(options = {}) {
    const source = options && typeof options === 'object' ? options : {}
    const systemRequested = source.systemRequested === true
    const microphoneRequested = source.microphoneRequested === true
    const system = systemRequested && source.systemCaptured === true
    const microphone = microphoneRequested && source.microphoneCaptured === true
    let notice = ''
    if (systemRequested && microphoneRequested) {
      if (!system && !microphone) notice = AUDIO_NOTICES.audioUnavailable
      else if (!microphone) notice = AUDIO_NOTICES.microphoneUnavailable
      else if (!system) notice = AUDIO_NOTICES.systemUnavailable
    } else if (systemRequested && !system) {
      notice = AUDIO_NOTICES.systemFailed
    } else if (microphoneRequested && !microphone) {
      notice = AUDIO_NOTICES.microphoneFailed
    }
    return { system, microphone, notice, silent: !system && !microphone }
  }

  /**
   * P0-1-T5 (S12): a degradation report is a key plus an optional detail, not a
   * sentence — this module also runs under Node where no locale table is loaded.
   * `code` is a `record.audio.warning.*` key; `detail` is a raw error message that
   * the renderer interpolates, never translated.
   */
  function audioWarning(code, detail = '') {
    return Object.freeze({ code, detail: String(detail ?? '') })
  }

  function audioTracks(stream) {
    if (!stream || typeof stream.getAudioTracks !== 'function') return []
    return stream.getAudioTracks().filter(Boolean)
  }

  function createSilentMix(warning = null) {
    return {
      active: false,
      context: null,
      masterGain: 1,
      nodes: [],
      roles: [],
      stream: null,
      tracks: [],
      warning,
      async resume() { return 'closed' },
      setBusGain() { return 0 },
      getBusGain() { return 0 },
      setMicrophoneMuted() { return false },
      isMicrophoneMuted() { return false },
      getLevel() { return 0 },
      dispose() {}
    }
  }

  // RMS over the analyser window, clamped to 0..1. A mixer without an analyser
  // (old Chromium or the fake test context) reports 0 rather than fabricating a level.
  function readAnalyserLevel(analyser, scratch) {
    if (!analyser) return 0
    const length = Number(analyser.fftSize) > 0 ? Number(analyser.fftSize) : LEVEL_ANALYSER_FFT_SIZE
    try {
      if (typeof analyser.getFloatTimeDomainData === 'function') {
        if (!scratch.float || scratch.float.length !== length) scratch.float = new Float32Array(length)
        analyser.getFloatTimeDomainData(scratch.float)
        let sum = 0
        for (let index = 0; index < scratch.float.length; index++) sum += scratch.float[index] * scratch.float[index]
        return Math.min(1, Math.round(Math.sqrt(sum / Math.max(1, scratch.float.length)) * 1000) / 1000)
      }
      if (typeof analyser.getByteTimeDomainData === 'function') {
        if (!scratch.bytes || scratch.bytes.length !== length) scratch.bytes = new Uint8Array(length)
        analyser.getByteTimeDomainData(scratch.bytes)
        let sum = 0
        for (let index = 0; index < scratch.bytes.length; index++) {
          const value = (scratch.bytes[index] - 128) / 128
          sum += value * value
        }
        return Math.min(1, Math.round(Math.sqrt(sum / Math.max(1, scratch.bytes.length)) * 1000) / 1000)
      }
    } catch {
      return 0
    }
    return 0
  }

  /**
   * Sums the supplied buses into one audio track.
   *
   * @param {object} options
   * @param {Function} [options.AudioContextClass] injectable AudioContext constructor
   * @param {MediaStream|null} [options.systemStream] loopback system audio
   * @param {MediaStream|null} [options.micStream] microphone audio
   * @param {object} [options.plan] result of createGainPlan
   * @param {Function} [options.onWarn] degradation reporter
   */
  function createAudioMix(options = {}) {
    const source = options && typeof options === 'object' ? options : {}
    const requested = source.plan || createGainPlan(source)
    const onWarn = typeof source.onWarn === 'function' ? source.onWarn : () => {}
    const AudioContextClass = source.AudioContextClass
      || globalScope?.AudioContext
      || globalScope?.webkitAudioContext
    const buses = []
    if (audioTracks(source.systemStream).length) {
      buses.push({ role: 'system', stream: source.systemStream, gain: requested.systemGain })
    }
    if (audioTracks(source.micStream).length) {
      buses.push({ role: 'microphone', stream: source.micStream, gain: requested.micGain })
    }
    if (!buses.length) return createSilentMix()
    // Master attenuation only accounts for buses that actually carry a track: a microphone
    // that failed to capture must not halve the system sound.
    const plan = createGainPlan({
      systemGain: buses.some((bus) => bus.role === 'system') ? requested.systemGain : 0,
      micGain: buses.some((bus) => bus.role === 'microphone') ? requested.micGain : 0
    })
    if (typeof AudioContextClass !== 'function') {
      const warning = audioWarning('record.audio.warning.mixer-unavailable')
      onWarn(warning)
      return createSilentMix(warning)
    }

    let context = null
    try {
      context = new AudioContextClass()
    } catch (error) {
      const warning = audioWarning('record.audio.warning.mixer-init-failed', error?.message || error)
      onWarn(warning)
      return createSilentMix(warning)
    }

    let master = null
    let destination = null
    const nodes = []
    let microphoneMuted = false
    try {
      master = context.createGain()
      master.gain.value = plan.masterGain
      destination = context.createMediaStreamDestination()
      master.connect(destination)
      for (const bus of buses) {
        const node = context.createMediaStreamSource(bus.stream)
        const gainNode = context.createGain()
        gainNode.gain.value = bus.gain
        // The analyser only feeds the level readback; it sits before the gain node so
        // muting the bus does not hide the fact that the microphone is still live.
        let analyser = null
        if (typeof context.createAnalyser === 'function') {
          try {
            analyser = context.createAnalyser()
            analyser.fftSize = LEVEL_ANALYSER_FFT_SIZE
            node.connect(analyser)
            analyser.connect(gainNode)
          } catch {
            analyser = null
          }
        }
        if (!analyser) node.connect(gainNode)
        gainNode.connect(master)
        nodes.push({ role: bus.role, source: node, gainNode, analyser, gain: bus.gain })
      }
      const stream = destination.stream
      const tracks = audioTracks(stream)
      if (!tracks.length) {
        const warning = audioWarning('record.audio.warning.mixer-no-track')
        onWarn(warning)
        disconnectAll(nodes, master, destination, context)
        return createSilentMix(warning)
      }
      const scratch = {}
      const busEntry = (role) => nodes.find((entry) => entry.role === role) || null

      function setBusGain(role, value) {
        const entry = busEntry(role)
        if (!entry) return 0
        const gain = normalizeGain(value)
        entry.gain = gain
        // A muted microphone keeps its target gain for the unmute, but the live node
        // stays at 0 so the recording really is silent.
        if (!(role === 'microphone' && microphoneMuted)) entry.gainNode.gain.value = gain
        return gain
      }

      function setMicrophoneMuted(muted) {
        const entry = busEntry('microphone')
        if (!entry) {
          microphoneMuted = false
          return false
        }
        microphoneMuted = muted === true
        entry.gainNode.gain.value = microphoneMuted ? 0 : entry.gain
        return microphoneMuted
      }

      return {
        active: true,
        context,
        masterGain: plan.masterGain,
        nodes,
        roles: nodes.map((node) => node.role),
        stream,
        tracks,
        warning: '',
        async resume() {
          if (context.state === 'suspended' && typeof context.resume === 'function') {
            try {
              await context.resume()
            } catch (error) {
              onWarn(audioWarning('record.audio.warning.mixer-resume-failed', error?.message || error))
            }
          }
          return context.state || 'running'
        },
        setBusGain,
        getBusGain(role) {
          const entry = busEntry(role)
          return entry ? entry.gain : 0
        },
        setMicrophoneMuted,
        isMicrophoneMuted() {
          return microphoneMuted
        },
        getLevel(role) {
          const entry = busEntry(role)
          return entry ? readAnalyserLevel(entry.analyser, scratch) : 0
        },
        dispose() {
          disconnectAll(nodes, master, destination, context)
        }
      }
    } catch (error) {
      const warning = audioWarning('record.audio.warning.mixer-failed', error?.message || error)
      onWarn(warning)
      disconnectAll(nodes, master, destination, context)
      return createSilentMix(warning)
    }
  }

  function disconnectAll(nodes, master, destination, context) {
    for (const node of nodes) {
      try { node.source.disconnect() } catch {}
      try { node.analyser?.disconnect?.() } catch {}
      try { node.gainNode.disconnect() } catch {}
    }
    try { master?.disconnect?.() } catch {}
    try { destination?.disconnect?.() } catch {}
    try { context?.close?.() } catch {}
  }

  const audioMixer = {
    AUDIO_BITS_PER_SECOND,
    AUDIO_CHANNEL_COUNT,
    AUDIO_NOTICES,
    AUDIO_SAMPLE_RATE,
    MAX_GAIN,
    MIN_GAIN,
    createAudioMix,
    createGainPlan,
    describeAudioOutcome,
    microphoneConstraints,
    normalizeGain
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = audioMixer
  if (globalScope) globalScope.audioMixer = audioMixer
})(typeof window !== 'undefined' ? window : null)
