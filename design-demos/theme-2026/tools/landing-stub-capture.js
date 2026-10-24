// Preload stub for the capture overlay in the landing preview.
//
// The capture window is the highest-risk surface for a re-theme: capture.css
// carries ~92 hardcoded colours plus the toolbar's own palette, because the
// overlay must stay dark over arbitrary screen content. A direction that only
// recolours the settings window will look fine there and break here — which is
// exactly what the landing gate exists to find.
//
// Under contextIsolation:true + sandbox:true we must expose a plain object via
// contextBridge (a Proxy cannot be cloned). Fixture payloads mirror
// design-demos/tools/capture-electron.js so both harnesses describe the same
// overlay.
const { contextBridge } = require('electron')

const handlers = {}
const on = (name) => (fn) => {
  ;(handlers[name] = handlers[name] || []).push(fn)
  return () => {
    const at = (handlers[name] || []).indexOf(fn)
    if (at >= 0) handlers[name].splice(at, 1)
  }
}

// A 1x1 PNG: the overlay decodes whatever it is given and sizes the canvases
// from it; the preview cares about chrome and toolbar only.
const PIXEL_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const SHOT_SETTINGS = {
  mainColor: '#e5a44c',
  theme: 'light',
  screenshot: {
    watermark: { enabled: false, text: '', opacity: 30, size: 24, color: '#ffffff' },
    annotation: {
      color: '#ff3b30',
      width: 4,
      styles: { rect: { color: '#ff3b30', width: 4, fill: 'none' } },
    },
  },
}

// A 1x1 PNG is enough to boot but useless as a backdrop. The capture overlay draws
// the captured screen and masks the outside of the selection, so a flat source
// renders as one solid colour — the first preview was a dark red field with a hint
// bar. This synthesises a small, deterministic "desktop" (two app windows and a
// couple of content bands) straight into a PNG buffer, so the region and the
// floating toolbar have something realistic to sit on. No clock, no RNG: same
// bytes every run.
function buildDesktopPng(width, height) {
  const raw = Buffer.alloc(height * (1 + width * 4))
  const put = (x, y, r, g, b) => {
    const at = y * (1 + width * 4) + 1 + x * 4
    raw[at] = r; raw[at + 1] = g; raw[at + 2] = b; raw[at + 3] = 255
  }
  const band = (x0, y0, x1, y1, rgb) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) put(x, y, rgb[0], rgb[1], rgb[2])
    }
  }
  // Desktop gradient (dark slate → warm grey), so the overlay mask has depth.
  for (let y = 0; y < height; y++) {
    const t = y / height
    const rgb = [Math.round(38 + 46 * t), Math.round(41 + 44 * t), Math.round(48 + 40 * t)]
    band(0, y, width, y + 1, rgb)
  }
  // Window 1: an editor with a sidebar and text bands.
  band(120, 90, 760, 560, [247, 246, 243])
  band(120, 90, 760, 122, [232, 230, 226])
  for (let i = 0; i < 3; i++) band(136 + i * 26, 100, 148 + i * 26, 112, [188, 186, 182])
  band(120, 122, 268, 560, [239, 238, 235])
  band(268, 122, 270, 560, [222, 220, 216])
  for (let i = 0; i < 9; i++) band(136, 150 + i * 42, 250, 160 + i * 42, i === 1 ? [64, 120, 200] : [178, 176, 172])
  for (let i = 0; i < 7; i++) band(292, 150 + i * 46, 292 + (i % 3 === 0 ? 380 : 300), 158 + i * 46, [96, 96, 100])
  band(292, 470, 700, 528, [240, 214, 168])
  // Window 2: a photo-ish card with a warm disc.
  band(800, 150, 1180, 470, [252, 249, 242])
  band(800, 150, 1180, 176, [235, 231, 222])
  for (let y = 200; y < 400; y++) {
    for (let x = 820; x < 1160; x++) {
      const dx = x - 930; const dy = y - 300
      if (dx * dx + dy * dy < 60 * 60) put(x, y, 226, 150, 78)
      else if (y > 380) put(x, y, 214, 208, 196)
    }
  }
  // Taskbar.
  band(0, height - 48, width, height, [26, 28, 34])
  for (let i = 0; i < 5; i++) band(24 + i * 44, height - 36, 52 + i * 44, height - 12, [72, 76, 86])

  const chunks = []
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const crcTable = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })()
  const crc = (buf) => {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const cb = Buffer.alloc(4); cb.writeUInt32BE(crc(td), 0)
    return Buffer.concat([len, td, cb])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6
  // zlib is NOT available under sandbox:true (the real capture window's posture) —
  // `require('node:zlib')` failed with "module not found", which aborted the whole
  // preload and took onShown with it. PNG does not require compression, only a
  // valid DEFLATE stream, and "stored" (uncompressed) blocks are legal DEFLATE.
  // Building them by hand keeps the stub dependency-free.
  const stored = []
  const MAX = 65535
  // zlib header: CMF 0x78 (deflate, 32K window), FLG 0x01 (no dict, fastest).
  stored.push(Buffer.from([0x78, 0x01]))
  for (let off = 0; off < raw.length; off += MAX) {
    const slice = raw.subarray(off, Math.min(off + MAX, raw.length))
    const last = off + MAX >= raw.length ? 1 : 0
    const hdr = Buffer.alloc(5)
    hdr[0] = last            // BFINAL in bit 0, BTYPE 00 = stored
    hdr.writeUInt16LE(slice.length, 1)
    hdr.writeUInt16LE(slice.length ^ 0xffff, 3) // one's complement of LEN
    stored.push(hdr, slice)
  }
  // Adler-32 of the uncompressed data, big-endian, as zlib requires.
  let a1 = 1
  let a2 = 0
  for (let i = 0; i < raw.length; i++) {
    a1 = (a1 + raw[i]) % 65521
    a2 = (a2 + a1) % 65521
  }
  const adler = Buffer.alloc(4)
  adler.writeUInt32BE(((a2 << 16) | a1) >>> 0, 0)
  stored.push(adler)
  chunks.push(sig, chunk('IHDR', ihdr), chunk('IDAT', Buffer.concat(stored)), chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(chunks)
}

const INIT = {
  mode: 'region',
  settings: SHOT_SETTINGS,
  // A 1x1 image is enough to boot, but NOT enough to look at: the overlay paints
  // the screen from this buffer and masks everything outside the selection with
  // selectionMask. With a 1px source the whole window comes out as one flat colour —
  // the first capture preview was a solid dark red field with only the hint bar.
  // A real, small "desktop" is synthesised below so the region and toolbar have
  // something to sit on.
  imageBuffer: buildDesktopPng(1280, 720),
  imageWidth: 1280,
  imageHeight: 720,
  dpr: 1,
  language: 'zh-CN',
  cursor: null,
  cursorPosition: null,
  smartSelect: false,
  selection: { x: 240, y: 180, width: 640, height: 360 },
}

const api = {
  onInit: on('init'),
  onShown: on('shown'),
  onInterfaceLanguage: on('interfaceLanguage'),
  ready() {
    // The renderer sends `ready` and expects the init payload right after; fire it
    // on the next tick so its listeners (registered later in capture.js) see it.
    setTimeout(() => {
      // The REAL onInit (capture/capture.js) writes the user's accent into :root
      // before anything draws, because the region border and its eight handles
      // resolve it through selectedAccent(). Without this line the stub left
      // --primary at the stylesheet default, so every showcase capture drew
      // selection chrome in a colour the running app would never draw — and that is
      // exactly the kind of fixture lie these screenshots exist to rule out.
      document.documentElement.style.setProperty('--primary', SHOT_SETTINGS.mainColor || '#e5a44c')
      ;(handlers.init || []).forEach((fn) => { try { fn(INIT) } catch (e) { console.error(e) } })
      // In `region` mode nothing seeds a selection: it only exists after a drag, so
      // the preview sat on a uniformly masked screen with no region and no toolbar.
      // Drive a real drag over the stage (pointerdown → pointermove past the drag
      // threshold → pointerup) so the review screenshot shows the state through the
      // product's own input path instead of poking at internals.
      setTimeout(() => {
        const stage = document.getElementById('stage')
        if (!stage) return
        const fire = (type, x, y, buttons) => {
          stage.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse',
            buttons, button: 0, isPrimary: true,
          }))
        }
        fire('pointerdown', 260, 200, 1)
        fire('pointermove', 420, 300, 1)
        fire('pointermove', 720, 470, 1)
        fire('pointerup', 720, 470, 0)
      }, 260)
    }, 60)
  },
  renderReady() {},
  renderError() {},
  close() {},
  copy() {},
  save() {},
  pin() {},
  pinAndReannotate() {},
  ocr() {},
  exportPdf() {},
  convertImage() {},
  openRecognition() {},
  smartSelectAt() {},
  saveAnnotationColor() {},
  saveAnnotationWidth() {},
  saveAnnotationStyles() {},
  saveWatermarkSettings() {},
}

contextBridge.exposeInMainWorld('captureAPI', api)
