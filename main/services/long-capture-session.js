const fs = require('fs')
const os = require('os')
const path = require('path')
const sharp = require('sharp')

const MAX_LONG_EDGE = 200000
const MAX_PIXELS = 200000000

class LongCaptureSession {
  constructor(options = {}) {
    const root = options.tempRoot || os.tmpdir()
    this.directory = fs.mkdtempSync(path.join(root, 'highlighter-long-'))
    this.axis = options.axis === 'horizontal' ? 'horizontal' : 'vertical'
    this.strips = []
    this.outputPath = ''
    this.serial = 0
    this.trimStart = 0
    this.trimEnd = 0
  }

  getUntrimmedSize() {
    if (!this.strips.length) return { width: 0, height: 0, strips: 0 }
    if (this.axis === 'vertical') {
      return {
        width: this.strips[0].width,
        height: this.strips.reduce((total, strip) => total + strip.height, 0),
        strips: this.strips.length
      }
    }
    return {
      width: this.strips.reduce((total, strip) => total + strip.width, 0),
      height: this.strips[0].height,
      strips: this.strips.length
    }
  }

  getSize() {
    const size = this.getUntrimmedSize()
    if (!size.strips) return { ...size, trimStart: 0, trimEnd: 0 }
    if (this.axis === 'vertical') size.height = Math.max(1, size.height - this.trimStart - this.trimEnd)
    else size.width = Math.max(1, size.width - this.trimStart - this.trimEnd)
    return { ...size, trimStart: this.trimStart, trimEnd: this.trimEnd }
  }

  setTrim(start = 0, end = 0) {
    const raw = this.getUntrimmedSize()
    if (!raw.strips) throw new Error('没有可裁剪的长截图内容')
    const length = this.axis === 'vertical' ? raw.height : raw.width
    const nextStart = Math.max(0, Math.round(Number(start) || 0))
    const nextEnd = Math.max(0, Math.round(Number(end) || 0))
    if (nextStart + nextEnd >= length) throw new Error('裁剪范围必须保留至少 1 像素')
    this.trimStart = nextStart
    this.trimEnd = nextEnd
    this.outputPath = ''
    return this.getSize()
  }

  addStrip(buffer, metadata = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('长截图条带为空')
    const width = Math.max(1, Math.round(Number(metadata.width) || 0))
    const height = Math.max(1, Math.round(Number(metadata.height) || 0))
    if (!width || !height) throw new Error('长截图条带尺寸无效')
    const current = this.getUntrimmedSize()
    if (current.strips && this.axis === 'vertical' && width !== current.width) throw new Error('长截图条带宽度不一致')
    if (current.strips && this.axis === 'horizontal' && height !== current.height) throw new Error('长截图条带高度不一致')

    const nextWidth = this.axis === 'vertical' ? width : current.width + width
    const nextHeight = this.axis === 'vertical' ? current.height + height : height
    if (Math.max(nextWidth, nextHeight) > MAX_LONG_EDGE || nextWidth * nextHeight > MAX_PIXELS) {
      throw new Error('已达到长截图尺寸上限，请先保存当前结果')
    }

    const filePath = path.join(this.directory, `strip-${String(++this.serial).padStart(6, '0')}.png`)
    fs.writeFileSync(filePath, buffer)
    const strip = { filePath, width, height }
    if (metadata.position === 'prepend') this.strips.unshift(strip)
    else this.strips.push(strip)
    this.outputPath = ''
    return this.getSize()
  }

  async render() {
    if (!this.strips.length) throw new Error('没有可导出的长截图内容')
    if (this.outputPath && fs.existsSync(this.outputPath)) return this.outputPath
    const rawSize = this.getUntrimmedSize()
    const size = this.getSize()
    let offset = 0
    const inputs = this.strips.map((strip) => {
      const input = {
        input: strip.filePath,
        left: this.axis === 'horizontal' ? offset : 0,
        top: this.axis === 'vertical' ? offset : 0
      }
      offset += this.axis === 'vertical' ? strip.height : strip.width
      return input
    })
    const compositePath = path.join(this.directory, 'composite.png')
    this.outputPath = path.join(this.directory, 'result.png')
    await sharp({
      create: { width: rawSize.width, height: rawSize.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      limitInputPixels: false
    })
      .composite(inputs)
      .png({ compressionLevel: 6 })
      .toFile(compositePath)
    if (this.trimStart || this.trimEnd) {
      const extract = this.axis === 'vertical'
        ? { left: 0, top: this.trimStart, width: size.width, height: size.height }
        : { left: this.trimStart, top: 0, width: size.width, height: size.height }
      await sharp(compositePath, { limitInputPixels: false }).extract(extract).png({ compressionLevel: 6 }).toFile(this.outputPath)
    } else {
      fs.copyFileSync(compositePath, this.outputPath)
    }
    return this.outputPath
  }

  cleanup() {
    try { fs.rmSync(this.directory, { recursive: true, force: true }) } catch {}
    this.strips = []
    this.outputPath = ''
    this.trimStart = 0
    this.trimEnd = 0
  }
}

module.exports = { LongCaptureSession, MAX_LONG_EDGE, MAX_PIXELS }
