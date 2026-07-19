const fs = require('fs')
const zlib = require('zlib')

const S = 256
const pixels = Buffer.alloc(S * S * 4)

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4
    const cx = S / 2, cy = S / 2
    const dx = (x - cx) / (S * 0.42), dy = (y - cy) / (S * 0.42)
    const dist = Math.sqrt(dx * dx + dy * dy)
    const angle = Math.atan2(dy, dx)

    // Solid blue circle
    if (dist < 1.0) {
      // Light blue fill (#448AFF)
      pixels[i] = 68; pixels[i + 1] = 138; pixels[i + 2] = 255; pixels[i + 3] = 255

      // White orbital rings (3 rings)
      const ringW = 0.04
      const r1 = dist > 0.22 - ringW && dist < 0.22 + ringW
      const r2 = dist > 0.42 - ringW && dist < 0.42 + ringW
      const r3 = dist > 0.60 - ringW && dist < 0.60 + ringW

      // Center dot
      const dot = dist < 0.06

      // Electron particles on each ring
      const ea1 = angle > 0.2 && angle < 0.6
      const ea2 = angle > 2.0 && angle < 2.4
      const ea3 = angle > 3.8 && angle < 4.2

      const e1 = r1 && ea1
      const e2 = r2 && ea2
      const e3 = r3 && ea3

      if (r1 || r2 || r3 || dot || e1 || e2 || e3) {
        pixels[i] = 255; pixels[i + 1] = 255; pixels[i + 2] = 255; pixels[i + 3] = 255
      }

      // Subtle gradient edge
      if (dist > 0.85) {
        const fade = (dist - 0.85) / 0.15
        const r = Math.round(68 + (25 - 68) * fade)
        const g = Math.round(138 + (80 - 138) * fade)
        const b = Math.round(255 + (180 - 255) * fade)
        pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = 255
      }
    } else if (dist < 1.15) {
      // Anti-aliased outer edge
      const alpha = Math.round(Math.max(0, (1.15 - dist) / 0.15) * 255)
      pixels[i] = 25; pixels[i + 1] = 80; pixels[i + 2] = 180; pixels[i + 3] = alpha
    }
  }
}

// Write PNG
function writePNG(w, h, rgba, fp) {
  const raw = Buffer.alloc(h * (1 + w * 4))
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4)
  }
  const comp = zlib.deflateSync(raw)
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

  function chk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = crc32(td)
    const cb = Buffer.alloc(4); cb.writeUInt32BE(crc, 0)
    return Buffer.concat([len, td, cb])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0

  fs.writeFileSync(fp, Buffer.concat([sig, chk('IHDR', ihdr), chk('IDAT', comp), chk('IEND', Buffer.alloc(0))]))
}

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0) }
  return (c ^ 0xffffffff) >>> 0
}

writePNG(S, S, pixels, 'assets/icon.png')
console.log('Icon generated: assets/icon.png', '256x256')
