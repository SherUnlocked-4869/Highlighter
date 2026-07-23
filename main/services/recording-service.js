const { randomUUID } = require('node:crypto')
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { buildFfmpegArgs } = require('../../record/recording-utils')

class RecordingService {
  constructor({ tempRoot, ffmpegPath, spawnProcess = spawn, log = () => {} }) {
    if (!tempRoot) throw new Error('录制临时目录不能为空')
    if (!ffmpegPath) throw new Error('FFmpeg 路径不能为空')
    this.tempRoot = path.resolve(tempRoot)
    this.ffmpegPath = ffmpegPath
    this.spawnProcess = spawnProcess
    this.log = log
    this.sessions = new Map()
  }

  getSession(sessionId) {
    const session = this.sessions.get(String(sessionId || ''))
    if (!session) throw new Error('录制会话不存在')
    return session
  }

  async startSession() {
    await fs.mkdir(this.tempRoot, { recursive: true })
    const id = randomUUID()
    const directory = path.join(this.tempRoot, id)
    const inputPath = path.join(directory, 'capture.webm')
    await fs.mkdir(directory, { recursive: false })
    await fs.writeFile(inputPath, Buffer.alloc(0))
    const session = {
      id,
      directory,
      inputPath,
      writeQueue: Promise.resolve(),
      finalized: false,
      process: null
    }
    this.sessions.set(id, session)
    return { id, directory, inputPath }
  }

  async appendChunk(sessionId, value) {
    const session = this.getSession(sessionId)
    if (session.finalized) throw new Error('录制会话已经结束')
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
    if (!buffer.length) return session.writeQueue
    session.writeQueue = session.writeQueue.then(() => fs.appendFile(session.inputPath, buffer))
    return session.writeQueue
  }

  async finishSession(sessionId) {
    const session = this.getSession(sessionId)
    await session.writeQueue
    const stat = await fs.stat(session.inputPath)
    if (!stat.size) throw new Error('录制内容为空')
    session.finalized = true
    return {
      id: session.id,
      inputPath: session.inputPath,
      previewUrl: pathToFileURL(session.inputPath).href
    }
  }

  async transcode(sessionId, outputPath, onProgress = () => {}) {
    const session = this.getSession(sessionId)
    if (!session.finalized) throw new Error('录制会话尚未完成')
    if (session.process) throw new Error('MP4 正在转码')
    const target = path.resolve(String(outputPath || ''))
    if (!target.toLowerCase().endsWith('.mp4')) throw new Error('输出文件必须为 MP4')
    await fs.mkdir(path.dirname(target), { recursive: true })
    const args = buildFfmpegArgs(session.inputPath, target)

    return new Promise((resolve, reject) => {
      let stderr = ''
      let settled = false
      const child = this.spawnProcess(this.ffmpegPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      })
      session.process = child

      const fail = async (error) => {
        if (settled) return
        settled = true
        session.process = null
        await fs.rm(target, { force: true }).catch(() => {})
        reject(error)
      }

      child.stderr?.on('data', (chunk) => {
        const text = String(chunk)
        stderr = `${stderr}${text}`.slice(-4000)
        for (const match of text.matchAll(/out_time_ms=(\d+)/g)) onProgress(Number(match[1]))
      })
      child.on('error', (error) => fail(new Error(`无法启动 MP4 编码组件：${error.message}`)))
      child.on('close', (code) => {
        if (settled) return
        if (code !== 0) {
          fail(new Error(`MP4 转码失败${stderr.trim() ? `：${stderr.trim()}` : ''}`))
          return
        }
        settled = true
        session.process = null
        resolve(target)
      })
    })
  }

  async cleanupSession(sessionId) {
    const session = this.sessions.get(String(sessionId || ''))
    if (!session) return false
    this.sessions.delete(session.id)
    if (session.process && typeof session.process.kill === 'function') {
      try { session.process.kill() } catch {}
      session.process = null
    }
    await session.writeQueue.catch((error) => this.log('Recording write failed:', error.message))
    await fs.rm(session.directory, { recursive: true, force: true })
    return true
  }

  async dispose() {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.cleanupSession(sessionId)))
  }
}

module.exports = { RecordingService }
