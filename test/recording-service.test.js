const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { RecordingService } = require('../main/services/recording-service')

async function createRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'highlighter-recording-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

test('writes chunks in call order and finalizes a preview file', async (t) => {
  const root = await createRoot(t)
  const service = new RecordingService({ tempRoot: root, ffmpegPath: 'ffmpeg' })
  t.after(() => service.dispose())
  const session = await service.startSession()
  await Promise.all([
    service.appendChunk(session.id, Buffer.from('one')),
    service.appendChunk(session.id, Buffer.from('two'))
  ])
  const preview = await service.finishSession(session.id)
  assert.equal((await fs.readFile(preview.inputPath)).toString(), 'onetwo')
  assert.match(preview.previewUrl, /^file:/)
})

test('keeps input but deletes partial MP4 when conversion fails', async (t) => {
  const root = await createRoot(t)
  const fakeSpawn = () => {
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    queueMicrotask(async () => {
      await fs.writeFile(path.join(root, 'failed.mp4'), 'partial')
      child.stderr.emit('data', Buffer.from('conversion failed'))
      child.emit('close', 1)
    })
    return child
  }
  const service = new RecordingService({ tempRoot: root, ffmpegPath: 'ffmpeg', spawnProcess: fakeSpawn })
  t.after(() => service.dispose())
  const session = await service.startSession()
  await service.appendChunk(session.id, Buffer.from('webm'))
  await service.finishSession(session.id)
  const output = path.join(root, 'failed.mp4')
  await assert.rejects(() => service.transcode(session.id, output), /MP4 转码失败/)
  assert.equal(await fs.readFile(session.inputPath, 'utf8'), 'webm')
  await assert.rejects(() => fs.access(output))
})

test('reports ffmpeg progress and returns the completed MP4', async (t) => {
  const root = await createRoot(t)
  const progress = []
  const fakeSpawn = (_executable, args) => {
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    queueMicrotask(async () => {
      child.stderr.emit('data', Buffer.from('out_time_ms=500000\nprogress=continue\n'))
      await fs.writeFile(args.at(-1), 'mp4')
      child.emit('close', 0)
    })
    return child
  }
  const service = new RecordingService({ tempRoot: root, ffmpegPath: 'ffmpeg', spawnProcess: fakeSpawn })
  t.after(() => service.dispose())
  const session = await service.startSession()
  await service.appendChunk(session.id, Buffer.from('webm'))
  await service.finishSession(session.id)
  const output = path.join(root, 'saved.mp4')
  assert.equal(await service.transcode(session.id, output, (value) => progress.push(value)), output)
  assert.deepEqual(progress, [500000])
  assert.equal(await fs.readFile(output, 'utf8'), 'mp4')
})

test('cleanup removes only the selected session directory', async (t) => {
  const root = await createRoot(t)
  const service = new RecordingService({ tempRoot: root, ffmpegPath: 'ffmpeg' })
  const first = await service.startSession()
  const second = await service.startSession()
  await service.cleanupSession(first.id)
  await assert.rejects(() => fs.access(first.directory))
  await fs.access(second.directory)
  await service.dispose()
})
