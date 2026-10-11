/**
 * Recording audio mixer (P0-3-T1).
 *
 * The region recorder captures video frames into a canvas and publishes them with
 * `canvas.captureStream()`. That stream has no audio track, so system sound (from
 * `getDisplayMedia` loopback) and the optional microphone stream are summed here and
 * appended to the canvas stream before `MediaRecorder` starts.
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

  function normalizeGain(value, fallback = DEFAULT_GAIN) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(MAX_GAIN, Math.max(0, parsed))
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
   */
  const AUDIO_NOTICES = Object.freeze({
    microphoneUnavailable: '麦克风不可用，本次录制仅包含系统声音',
    systemUnavailable: '系统声音不可用，本次录制仅包含麦克风',
    audioUnavailable: '无法采集声音，本次录制为无声视频',
    microphoneFailed: '麦克风采集失败，本次录制为无声视频',
    systemFailed: '系统声音采集失败，本次录制为无声视频'
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

  function audioTracks(stream) {
    if (!stream || typeof stream.getAudioTracks !== 'function') return []
    return stream.getAudioTracks().filter(Boolean)
  }

  function createSilentMix(warning = '') {
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
      dispose() {}
    }
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
      const warning = '音频混音组件不可用，本次录制为无声视频'
      onWarn(warning)
      return createSilentMix(warning)
    }

    let context = null
    try {
      context = new AudioContextClass()
    } catch (error) {
      const warning = `音频混音初始化失败：${error?.message || error}`
      onWarn(warning)
      return createSilentMix(warning)
    }

    let master = null
    let destination = null
    const nodes = []
    try {
      master = context.createGain()
      master.gain.value = plan.masterGain
      destination = context.createMediaStreamDestination()
      master.connect(destination)
      for (const bus of buses) {
        const node = context.createMediaStreamSource(bus.stream)
        const gainNode = context.createGain()
        gainNode.gain.value = bus.gain
        node.connect(gainNode)
        gainNode.connect(master)
        nodes.push({ role: bus.role, source: node, gainNode })
      }
      const stream = destination.stream
      const tracks = audioTracks(stream)
      if (!tracks.length) {
        const warning = '音频混音未产生音轨，本次录制为无声视频'
        onWarn(warning)
        disconnectAll(nodes, master, destination, context)
        return createSilentMix(warning)
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
              onWarn(`音频混音恢复失败：${error?.message || error}`)
            }
          }
          return context.state || 'running'
        },
        dispose() {
          disconnectAll(nodes, master, destination, context)
        }
      }
    } catch (error) {
      const warning = `音频混音失败：${error?.message || error}`
      onWarn(warning)
      disconnectAll(nodes, master, destination, context)
      return createSilentMix(warning)
    }
  }

  function disconnectAll(nodes, master, destination, context) {
    for (const node of nodes) {
      try { node.source.disconnect() } catch {}
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
    createAudioMix,
    createGainPlan,
    describeAudioOutcome,
    normalizeGain
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = audioMixer
  if (globalScope) globalScope.audioMixer = audioMixer
})(typeof window !== 'undefined' ? window : null)
