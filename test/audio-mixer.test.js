const test = require('node:test')
const assert = require('node:assert/strict')
const {
  AUDIO_BITS_PER_SECOND,
  AUDIO_CHANNEL_COUNT,
  AUDIO_NOTICES,
  AUDIO_SAMPLE_RATE,
  MAX_GAIN,
  createAudioMix,
  createGainPlan,
  describeAudioOutcome,
  normalizeGain
} = require('../record/audio-mixer')
const { buildFfmpegArgs } = require('../record/recording-utils')

function createAudioTrack(id = 'audio-1') {
  return { id, kind: 'audio', label: '', readyState: 'live', stop() { this.readyState = 'ended' } }
}

function createStream(tracks = [createAudioTrack()]) {
  return {
    getAudioTracks: () => tracks,
    getTracks: () => tracks
  }
}

function createFakeAudioContext(options = {}) {
  const created = { destinations: [], gains: [], sources: [] }
  const context = {
    state: options.state || 'running',
    resumed: 0,
    closed: 0,
    createGain() {
      const node = {
        gain: { value: 1 },
        connected: [],
        disconnected: false,
        connect(target) { node.connected.push(target) },
        disconnect() { node.disconnected = true }
      }
      created.gains.push(node)
      return node
    },
    createMediaStreamSource(stream) {
      if (options.sourceThrows) throw new Error('source failed')
      const node = {
        stream,
        connected: [],
        disconnected: false,
        connect(target) { node.connected.push(target) },
        disconnect() { node.disconnected = true }
      }
      created.sources.push(node)
      return node
    },
    createMediaStreamDestination() {
      const destination = {
        disconnected: false,
        stream: options.emptyDestination ? { getAudioTracks: () => [] } : createStream(),
        disconnect() { destination.disconnected = true }
      }
      created.destinations.push(destination)
      return destination
    },
    async resume() {
      context.resumed += 1
      context.state = 'running'
    },
    async close() {
      context.closed += 1
      context.state = 'closed'
    }
  }
  return {
    created,
    context,
    AudioContextClass: function FakeAudioContext() { return context }
  }
}

test('plans unity gains for both buses by default', () => {
  const plan = createGainPlan()
  assert.deepEqual(plan, {
    systemGain: 1,
    micGain: 1,
    systemAudible: true,
    micAudible: true,
    masterGain: 0.5
  })
})

test('normalizes gain inputs instead of trusting stored settings', () => {
  assert.equal(normalizeGain(undefined), 1)
  assert.equal(normalizeGain(Number.NaN), 1)
  assert.equal(normalizeGain('0.5'), 0.5)
  assert.equal(normalizeGain(-3), 0)
  assert.equal(normalizeGain(99), MAX_GAIN)
  const plan = createGainPlan({ systemGain: 0.5, micGain: 2 })
  assert.equal(plan.systemGain, 0.5)
  assert.equal(plan.micGain, 2)
  assert.equal(plan.masterGain, Math.round((1 / 2.5) * 10000) / 10000)
})

test('only attenuates the master gain when two audible buses would clip', () => {
  assert.deepEqual(createGainPlan({ systemGain: 2, micGain: 0 }), {
    systemGain: 2,
    micGain: 0,
    systemAudible: true,
    micAudible: false,
    masterGain: 1
  })
  assert.equal(createGainPlan({ systemGain: 0, micGain: 0 }).masterGain, 1)
  assert.equal(createGainPlan({ systemGain: 0.25, micGain: 0.25 }).masterGain, 1)
})

test('describes every audio degradation path', () => {
  const both = describeAudioOutcome({
    systemRequested: true,
    microphoneRequested: true,
    systemCaptured: true,
    microphoneCaptured: true
  })
  assert.deepEqual(both, { system: true, microphone: true, notice: '', silent: false })

  const microphoneLost = describeAudioOutcome({
    systemRequested: true,
    microphoneRequested: true,
    systemCaptured: true,
    microphoneCaptured: false
  })
  assert.equal(microphoneLost.notice, AUDIO_NOTICES.microphoneUnavailable)
  assert.equal(microphoneLost.silent, false)

  const systemLost = describeAudioOutcome({
    systemRequested: true,
    microphoneRequested: true,
    systemCaptured: false,
    microphoneCaptured: true
  })
  assert.equal(systemLost.notice, AUDIO_NOTICES.systemUnavailable)
  assert.equal(systemLost.microphone, true)

  const allLost = describeAudioOutcome({
    systemRequested: true,
    microphoneRequested: true,
    systemCaptured: false,
    microphoneCaptured: false
  })
  assert.equal(allLost.notice, AUDIO_NOTICES.audioUnavailable)
  assert.equal(allLost.silent, true)

  assert.equal(describeAudioOutcome({
    systemRequested: true,
    microphoneRequested: false,
    systemCaptured: false,
    microphoneCaptured: false
  }).notice, AUDIO_NOTICES.systemFailed)

  assert.equal(describeAudioOutcome({
    systemRequested: false,
    microphoneRequested: true,
    systemCaptured: false,
    microphoneCaptured: false
  }).notice, AUDIO_NOTICES.microphoneFailed)

  const disabled = describeAudioOutcome({ systemRequested: false, microphoneRequested: false })
  assert.deepEqual(disabled, { system: false, microphone: false, notice: '', silent: true })
})

test('mixes system and microphone buses through the injected AudioContext', async () => {
  const fake = createFakeAudioContext()
  const warnings = []
  const mix = createAudioMix({
    AudioContextClass: fake.AudioContextClass,
    systemStream: createStream(),
    micStream: createStream([createAudioTrack('mic-1')]),
    plan: createGainPlan({ systemGain: 1, micGain: 0.5 }),
    onWarn: (message) => warnings.push(message)
  })

  assert.equal(mix.active, true)
  assert.deepEqual(mix.roles, ['system', 'microphone'])
  assert.equal(mix.nodes.length, 2)
  assert.equal(mix.tracks.length, 1)
  assert.equal(mix.stream, fake.created.destinations[0].stream)
  assert.deepEqual(warnings, [])

  const [master, systemGain, micGain] = fake.created.gains
  assert.equal(master.gain.value, createGainPlan({ systemGain: 1, micGain: 0.5 }).masterGain)
  assert.equal(systemGain.gain.value, 1)
  assert.equal(micGain.gain.value, 0.5)
  assert.equal(master.connected[0], fake.created.destinations[0])
  assert.equal(systemGain.connected[0], master)
  assert.equal(micGain.connected[0], master)
  assert.equal(fake.created.sources[0].stream.getAudioTracks()[0].id, 'audio-1')
  assert.equal(fake.created.sources[1].stream.getAudioTracks()[0].id, 'mic-1')

  await mix.resume()
  assert.equal(fake.context.resumed, 0)

  mix.dispose()
  assert.equal(systemGain.disconnected, true)
  assert.equal(micGain.disconnected, true)
  assert.equal(master.disconnected, true)
  assert.equal(fake.created.destinations[0].disconnected, true)
  assert.equal(fake.context.closed, 1)
})

test('resumes a suspended AudioContext before recording starts', async () => {
  const fake = createFakeAudioContext({ state: 'suspended' })
  const mix = createAudioMix({
    AudioContextClass: fake.AudioContextClass,
    systemStream: createStream()
  })
  assert.equal(mix.active, true)
  assert.deepEqual(mix.roles, ['system'])
  assert.equal(fake.created.gains.length, 2)
  assert.equal(fake.created.gains[0].gain.value, 1)
  // A microphone that never captured must not attenuate the single live bus.
  assert.equal(mix.masterGain, 1)
  assert.equal(await mix.resume(), 'running')
  assert.equal(fake.context.resumed, 1)
})

test('returns an inactive mix when no bus carries an audio track', () => {
  const fake = createFakeAudioContext()
  const mix = createAudioMix({
    AudioContextClass: fake.AudioContextClass,
    systemStream: createStream([]),
    micStream: null
  })
  assert.deepEqual(mix.roles, [])
  assert.equal(mix.active, false)
  assert.equal(mix.stream, null)
  assert.deepEqual(mix.tracks, [])
  assert.equal(fake.created.gains.length, 0)
  assert.equal(fake.context.closed, 0)
  mix.dispose()
})

test('degrades to a silent mix when no AudioContext is available', () => {
  const warnings = []
  const mix = createAudioMix({
    AudioContextClass: null,
    systemStream: createStream(),
    onWarn: (message) => warnings.push(message)
  })
  assert.equal(mix.active, false)
  assert.equal(mix.stream, null)
  // P0-1-T5 (S12): the mixer reports an i18n key (plus a raw detail) instead of a
  // sentence, so the renderer can resolve it in the active language.
  assert.equal(mix.warning.code, 'record.audio.warning.mixer-unavailable')
  assert.deepEqual(warnings, [mix.warning])
})

test('degrades to a silent mix when the AudioContext cannot be constructed', () => {
  const warnings = []
  const mix = createAudioMix({
    AudioContextClass: function Broken() { throw new Error('no audio device') },
    micStream: createStream(),
    onWarn: (message) => warnings.push(message)
  })
  assert.equal(mix.active, false)
  assert.equal(mix.warning.code, 'record.audio.warning.mixer-init-failed')
  assert.equal(mix.warning.detail, 'no audio device')
  assert.deepEqual(warnings, [mix.warning])
})

test('degrades and closes the context when the mix produces no track', () => {
  const fake = createFakeAudioContext({ emptyDestination: true })
  const warnings = []
  const mix = createAudioMix({
    AudioContextClass: fake.AudioContextClass,
    systemStream: createStream(),
    onWarn: (message) => warnings.push(message)
  })
  assert.equal(mix.active, false)
  assert.equal(mix.stream, null)
  assert.equal(mix.warning.code, 'record.audio.warning.mixer-no-track')
  assert.equal(fake.context.closed, 1)
  assert.equal(fake.created.gains[0].disconnected, true)
  assert.equal(fake.created.destinations[0].disconnected, true)
})

test('degrades and closes the context when graph assembly throws', () => {
  const fake = createFakeAudioContext({ sourceThrows: true })
  const warnings = []
  const mix = createAudioMix({
    AudioContextClass: fake.AudioContextClass,
    systemStream: createStream(),
    onWarn: (message) => warnings.push(message)
  })
  assert.equal(mix.active, false)
  assert.equal(mix.warning.code, 'record.audio.warning.mixer-failed')
  assert.equal(mix.warning.detail, 'source failed')
  assert.deepEqual(warnings, [mix.warning])
  assert.equal(fake.context.closed, 1)
})

test('keeps the MediaRecorder audio bitrate in sync with the ffmpeg audio arguments', () => {
  assert.equal(AUDIO_BITS_PER_SECOND, 160_000)
  assert.equal(AUDIO_SAMPLE_RATE, 48_000)
  assert.equal(AUDIO_CHANNEL_COUNT, 2)
  const args = buildFfmpegArgs('input.webm', 'output.mp4', { audio: true })
  assert.equal(args[args.indexOf('-b:a') + 1], `${AUDIO_BITS_PER_SECOND / 1000}k`)
  assert.equal(args[args.indexOf('-ar') + 1], String(AUDIO_SAMPLE_RATE))
  assert.equal(args[args.indexOf('-ac') + 1], String(AUDIO_CHANNEL_COUNT))
})
