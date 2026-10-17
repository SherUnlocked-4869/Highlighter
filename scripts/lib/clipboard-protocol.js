'use strict'

const { TextDecoder } = require('node:util')

const MAX_FRAME = 1024 * 1024
const MAX_HEADER = 512 * 1024
const MAX_CHUNK = 256 * 1024

function invalid() { return new Error('Invalid clipboard protocol frame') }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function encodeFrame(header, payload = Buffer.alloc(0)) {
  if (!object(header) || !Buffer.isBuffer(payload) || payload.length > MAX_CHUNK) throw invalid()
  const json = Buffer.from(JSON.stringify(header))
  const size = 5 + json.length + payload.length
  if (json.length > MAX_HEADER || size > MAX_FRAME) throw invalid()
  const frame = Buffer.allocUnsafe(4 + size)
  frame.writeUInt32LE(size, 0)
  frame[4] = payload.length ? 2 : 1
  frame.writeUInt32LE(json.length, 5)
  json.copy(frame, 9)
  payload.copy(frame, 9 + json.length)
  return frame
}

class FrameDecoder {
  constructor() {
    this.fixed = Buffer.alloc(9)
    this.fixedBytes = 0
    this.body = null
    this.bodyBytes = 0
    this.failed = false
  }

  feed(chunk) {
    if (this.failed || !Buffer.isBuffer(chunk)) throw invalid()
    const frames = []
    try {
      let offset = 0
      while (offset < chunk.length) {
        if (!this.body) {
          const count = Math.min(9 - this.fixedBytes, chunk.length - offset)
          chunk.copy(this.fixed, this.fixedBytes, offset, offset + count)
          this.fixedBytes += count
          offset += count
          if (this.fixedBytes >= 4) {
            const size = this.fixed.readUInt32LE(0)
            if (size < 5 || size > MAX_FRAME) throw invalid()
          }
          if (this.fixedBytes < 9) continue
          const size = this.fixed.readUInt32LE(0)
          const kind = this.fixed[4]
          this.headerBytes = this.fixed.readUInt32LE(5)
          const payloadBytes = size - 5 - this.headerBytes
          if (![1, 2].includes(kind) || this.headerBytes > MAX_HEADER || payloadBytes < 0 || payloadBytes > MAX_CHUNK || (kind === 1 && payloadBytes !== 0)) throw invalid()
          this.body = Buffer.allocUnsafe(size - 5)
        }
        const count = Math.min(this.body.length - this.bodyBytes, chunk.length - offset)
        chunk.copy(this.body, this.bodyBytes, offset, offset + count)
        this.bodyBytes += count
        offset += count
        if (this.bodyBytes === this.body.length) {
          const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.body.subarray(0, this.headerBytes)))
          if (!object(header)) throw invalid()
          frames.push({ header, payload: this.body.subarray(this.headerBytes) })
          this.body = null
          this.bodyBytes = 0
          this.fixedBytes = 0
        }
      }
      return frames
    } catch {
      this.failed = true
      this.body = null
      throw invalid()
    }
  }

  finish() {
    if (this.failed || this.fixedBytes || this.body) throw invalid()
  }
}

module.exports = { encodeFrame, FrameDecoder, MAX_FRAME, MAX_HEADER, MAX_CHUNK }
