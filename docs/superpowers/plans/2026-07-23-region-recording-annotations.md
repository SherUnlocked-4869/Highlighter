# Region Recording Annotations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add protected, real-time pen, rectangle, ellipse, and arrow annotations to region recording, with pointer passthrough, style controls, undo, clear, paused editing, and explicit MP4 Canvas composition.

**Architecture:** Reuse the protected `recordFrameWindow` as the interactive annotation overlay while keeping it excluded from desktop capture. Synchronize validated annotation snapshots through the main process to `record.js`, which composites them after the cropped desktop frame and before `canvas.captureStream()`. Keep geometry, validation, scaling, and drawing in a UMD-style pure utility module shared by browser renderers and Node tests.

**Tech Stack:** Electron 33 BrowserWindow/IPC, browser Canvas 2D, MediaRecorder, Node.js built-in test runner, existing FFmpeg H.264 pipeline.

---

## File Structure

- Create `record/annotation-utils.js`: annotation constants, validation, geometry, snapshot mutation, scaling, and Canvas drawing.
- Create `record/frame.js`: overlay pointer handling, live snapshot publication, resize handling, and command application.
- Create `record/frame.css`: protected border and inner annotation Canvas styling.
- Create `test/annotation-utils.test.js`: pure model, limits, geometry, scaling, and drawing tests.
- Modify `record/frame.html`: replace inline border implementation with the annotation Canvas and external scripts.
- Modify `record/record.html`: add the compact annotation controls and load the shared utility.
- Modify `record/record.css`: stable one-row/two-row controls, active tools, swatches, and style popover.
- Modify `record/record.js`: annotation UI state, snapshot subscription, lifecycle reset, and per-frame composition.
- Modify `preload-record.js`: expose bounded control-to-main commands and main-to-recorder snapshots.
- Modify `preload-record-frame.js`: expose frame commands and bounded snapshot publication.
- Modify `main.js`: validate sender ownership, route commands/snapshots, switch mouse passthrough, and restore passthrough on every exit path.
- Modify `record/recording-utils.js`: calculate responsive control-window dimensions.
- Modify `test/recording-utils.test.js`: responsive control layout tests.
- Modify `test/recording-ui-contract.test.js`: static UI, preload, IPC, composition-order, and lifecycle contracts.
- Modify `package.json`: include new scripts in `npm run check`.

### Task 1: Pure Annotation Model And Renderer

**Files:**
- Create: `test/annotation-utils.test.js`
- Create: `record/annotation-utils.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing model and drawing tests**

Create tests that import the not-yet-existing module and lock the public API:

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  ANNOTATION_COLORS,
  ANNOTATION_WIDTHS,
  createAnnotation,
  updateAnnotation,
  sanitizeAnnotationSnapshot,
  undoAnnotationSnapshot,
  clearAnnotationSnapshot,
  drawAnnotationSnapshot
} = require('../record/annotation-utils')

test('creates and updates the four supported annotation tools', () => {
  const style = { color: '#ff3b30', width: 4 }
  const pen = updateAnnotation(createAnnotation('pen', { x: 2, y: 3 }, style, 1), { x: 8, y: 9 })
  assert.deepEqual(pen.points, [{ x: 2, y: 3 }, { x: 8, y: 9 }])
  for (const type of ['rect', 'ellipse', 'arrow']) {
    const item = updateAnnotation(createAnnotation(type, { x: 20, y: 30 }, style, 2), { x: 5, y: 7 })
    assert.equal(item.type, type)
    assert.deepEqual([item.x, item.y, item.x2, item.y2], [20, 30, 5, 7])
  }
})

test('sanitizes tools, styles, bounds, annotation counts, and pen points', () => {
  assert.deepEqual(ANNOTATION_WIDTHS, [2, 4, 7])
  assert.ok(ANNOTATION_COLORS.includes('#ff3b30'))
  const result = sanitizeAnnotationSnapshot({
    annotations: [{ id: 1, type: 'rect', color: '#ff3b30', width: 4, x: -20, y: 5, x2: 500, y2: 300 }],
    active: null
  }, { width: 200, height: 100 })
  assert.deepEqual([result.annotations[0].x, result.annotations[0].y, result.annotations[0].x2, result.annotations[0].y2], [0, 5, 200, 100])
})

test('undoes and clears committed annotations without retaining active work', () => {
  const snapshot = { annotations: [{ id: 1 }, { id: 2 }], active: { id: 3 } }
  assert.deepEqual(undoAnnotationSnapshot(snapshot), { annotations: [{ id: 1 }], active: null })
  assert.deepEqual(clearAnnotationSnapshot(snapshot), { annotations: [], active: null })
})

test('draws desktop-relative annotations at output scale', () => {
  const calls = []
  const context = new Proxy({}, {
    get: (_target, key) => key === 'canvas' ? { width: 400, height: 200 } : (...args) => calls.push([key, ...args]),
    set: () => true
  })
  drawAnnotationSnapshot(context, {
    annotations: [{ id: 1, type: 'rect', color: '#ff3b30', width: 4, x: 10, y: 10, x2: 50, y2: 40 }],
    active: null
  }, { width: 200, height: 100 })
  assert.ok(calls.some(([name]) => name === 'strokeRect'))
  assert.ok(calls.some(([name]) => name === 'save'))
  assert.ok(calls.some(([name]) => name === 'restore'))
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `rtk node --test test/annotation-utils.test.js`

Expected: FAIL with `Cannot find module '../record/annotation-utils'`.

- [ ] **Step 3: Implement the minimal shared annotation utility**

Create a UMD module with these exact exports and limits:

```js
(function initAnnotationUtils(globalScope) {
  const ANNOTATION_TOOLS = Object.freeze(['pointer', 'pen', 'rect', 'ellipse', 'arrow'])
  const ANNOTATION_COLORS = Object.freeze(['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#1687ff', '#111111', '#ffffff'])
  const ANNOTATION_WIDTHS = Object.freeze([2, 4, 7])
  const MAX_ANNOTATIONS = 500
  const MAX_PEN_POINTS = 10000

  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback
  const clamp = (value, maximum) => Math.max(0, Math.min(finite(maximum), finite(value)))
  const cleanPoint = (point, bounds = { width: Infinity, height: Infinity }) => ({
    x: clamp(point?.x, bounds.width),
    y: clamp(point?.y, bounds.height)
  })

  function cleanStyle(style = {}) {
    return {
      color: ANNOTATION_COLORS.includes(style.color) ? style.color : ANNOTATION_COLORS[0],
      width: ANNOTATION_WIDTHS.includes(Number(style.width)) ? Number(style.width) : 4
    }
  }

  function createAnnotation(type, point, style, id) {
    if (!ANNOTATION_TOOLS.includes(type) || type === 'pointer') return null
    const start = cleanPoint(point)
    const item = { id: Math.max(1, Math.round(finite(id, 1))), type, ...cleanStyle(style), x: start.x, y: start.y, x2: start.x, y2: start.y }
    if (type === 'pen') item.points = [start]
    return item
  }

  function updateAnnotation(item, point) {
    if (!item) return null
    const next = cleanPoint(point)
    if (item.type !== 'pen') return { ...item, x2: next.x, y2: next.y }
    const points = item.points.slice(0, MAX_PEN_POINTS)
    const last = points[points.length - 1]
    if (points.length < MAX_PEN_POINTS && (!last || Math.hypot(next.x - last.x, next.y - last.y) >= 0.5)) points.push(next)
    return { ...item, x2: next.x, y2: next.y, points }
  }

  function sanitizeItem(item, bounds) {
    if (!item || !ANNOTATION_TOOLS.includes(item.type) || item.type === 'pointer') return null
    const start = cleanPoint(item, bounds)
    const end = cleanPoint({ x: item.x2, y: item.y2 }, bounds)
    const clean = { id: Math.max(1, Math.round(finite(item.id, 1))), type: item.type, ...cleanStyle(item), x: start.x, y: start.y, x2: end.x, y2: end.y }
    if (clean.type === 'pen') clean.points = (Array.isArray(item.points) ? item.points : []).slice(0, MAX_PEN_POINTS).map((point) => cleanPoint(point, bounds))
    return clean
  }

  function sanitizeAnnotationSnapshot(snapshot, bounds) {
    const annotations = (Array.isArray(snapshot?.annotations) ? snapshot.annotations : [])
      .slice(0, MAX_ANNOTATIONS).map((item) => sanitizeItem(item, bounds)).filter(Boolean)
    return { annotations, active: sanitizeItem(snapshot?.active, bounds) }
  }

  function undoAnnotationSnapshot(snapshot) {
    return { annotations: (snapshot?.annotations || []).slice(0, -1), active: null }
  }
  function clearAnnotationSnapshot() { return { annotations: [], active: null } }

  function drawAnnotationSnapshot(context, snapshot, sourceSize) {
    const scaleX = context.canvas.width / Math.max(1, finite(sourceSize?.width, context.canvas.width))
    const scaleY = context.canvas.height / Math.max(1, finite(sourceSize?.height, context.canvas.height))
    const draw = (item) => {
      const x = item.x * scaleX, y = item.y * scaleY, x2 = item.x2 * scaleX, y2 = item.y2 * scaleY
      const width = item.width * Math.sqrt(scaleX * scaleY)
      context.save(); context.strokeStyle = item.color; context.fillStyle = item.color; context.lineWidth = width; context.lineCap = 'round'; context.lineJoin = 'round'
      if (item.type === 'pen') { context.beginPath(); item.points.forEach((point, index) => { const px = point.x * scaleX, py = point.y * scaleY; index ? context.lineTo(px, py) : context.moveTo(px, py) }); context.stroke() }
      if (item.type === 'rect') context.strokeRect(Math.min(x, x2), Math.min(y, y2), Math.abs(x2 - x), Math.abs(y2 - y))
      if (item.type === 'ellipse') { context.beginPath(); context.ellipse((x + x2) / 2, (y + y2) / 2, Math.abs(x2 - x) / 2, Math.abs(y2 - y) / 2, 0, 0, Math.PI * 2); context.stroke() }
      if (item.type === 'arrow') { const angle = Math.atan2(y2 - y, x2 - x), head = Math.max(10, width * 3); context.beginPath(); context.moveTo(x, y); context.lineTo(x2, y2); context.stroke(); context.beginPath(); context.moveTo(x2, y2); context.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6)); context.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6)); context.closePath(); context.fill() }
      context.restore()
    }
    snapshot.annotations.forEach(draw)
    if (snapshot.active) draw(snapshot.active)
  }

  const api = { ANNOTATION_TOOLS, ANNOTATION_COLORS, ANNOTATION_WIDTHS, MAX_ANNOTATIONS, MAX_PEN_POINTS,
    createAnnotation, updateAnnotation, sanitizeAnnotationSnapshot, undoAnnotationSnapshot,
    clearAnnotationSnapshot, drawAnnotationSnapshot }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (globalScope) globalScope.annotationUtils = api
})(typeof window !== 'undefined' ? window : null)
```

Use round caps/joins. Normalize rectangles and ellipses only while drawing, retain original endpoints in data, and compute the arrow head as `Math.max(10, scaledWidth * 3)`.

- [ ] **Step 4: Add syntax checking and verify GREEN**

Add `node --check record/annotation-utils.js` and `node --check test/annotation-utils.test.js` to the existing `check` script.

Run: `rtk node --test test/annotation-utils.test.js`

Expected: all annotation utility tests PASS.

- [ ] **Step 5: Commit the pure model**

```bash
rtk git add record/annotation-utils.js test/annotation-utils.test.js package.json
rtk git commit -m "feat: add recording annotation model"
```

### Task 2: Protected Interactive Frame Overlay

**Files:**
- Modify: `record/frame.html`
- Create: `record/frame.css`
- Create: `record/frame.js`
- Modify: `preload-record-frame.js`
- Modify: `test/recording-ui-contract.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing frame-overlay contract tests**

Extend `recording-ui-contract.test.js` with assertions for `annotationStage`, external frame scripts, and the narrow preload surface:

```js
test('recording frame exposes a protected annotation canvas contract', () => {
  const html = fs.readFileSync(path.join(root, 'record', 'frame.html'), 'utf8')
  const frameScript = fs.readFileSync(path.join(root, 'record', 'frame.js'), 'utf8')
  const preload = fs.readFileSync(path.join(root, 'preload-record-frame.js'), 'utf8')
  assert.match(html, /id="annotationStage"/)
  assert.match(html, /annotation-utils\.js/)
  assert.match(html, /frame\.js/)
  assert.match(frameScript, /pointerdown/)
  assert.match(frameScript, /requestAnimationFrame/)
  assert.match(frameScript, /submitSnapshot/)
  assert.match(preload, /record-frame:snapshot/)
  assert.match(preload, /record-frame:command/)
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `rtk node --test test/recording-ui-contract.test.js`

Expected: FAIL because `record/frame.js` and `annotationStage` do not exist.

- [ ] **Step 3: Implement frame markup, styling, and preload bridge**

Use this document structure:

```html
<body data-state="idle">
  <canvas id="annotationStage" aria-label="录制标注区域"></canvas>
  <script src="annotation-utils.js"></script>
  <script src="frame.js"></script>
</body>
```

Keep the 2px state border on `body`; absolutely place the Canvas at `left:2px; top:2px; width:calc(100% - 4px); height:calc(100% - 4px)`. Extend the preload with `onCommand(callback)`, `submitSnapshot(snapshot)`, and `ready()` using only fixed channel names.

- [ ] **Step 4: Implement frame pointer interaction**

In `frame.js`, keep state as:

```js
let command = { enabled: false, tool: 'pointer', color: '#ff3b30', width: 4, resetVersion: 0 }
let snapshot = { annotations: [], active: null }
let nextId = 1
let publishRequest = 0
```

Map events into the inner Canvas coordinate system, build drafts with `createAnnotation`, publish active snapshots at most once per animation frame, commit on `pointerup`, cancel active work when switching to pointer, and reset annotations whenever `resetVersion` changes. Render both committed and active annotations locally after every mutation.

- [ ] **Step 5: Verify frame tests and syntax**

Add `node --check record/frame.js` to `npm run check`.

Run: `rtk node --test test/recording-ui-contract.test.js`

Expected: all recording UI contract tests PASS.

- [ ] **Step 6: Commit the protected overlay**

```bash
rtk git add record/frame.html record/frame.css record/frame.js preload-record-frame.js test/recording-ui-contract.test.js package.json
rtk git commit -m "feat: add protected recording annotation overlay"
```

### Task 3: Secure Main-Process Routing And Mouse Passthrough

**Files:**
- Modify: `main.js`
- Modify: `preload-record.js`
- Modify: `record/recording-utils.js`
- Modify: `test/recording-utils.test.js`
- Modify: `test/recording-ui-contract.test.js`

- [ ] **Step 1: Write failing layout and IPC contract tests**

Add a pure layout test:

```js
test('sizes annotation controls responsively inside the display work area', () => {
  assert.deepEqual(calculateRecordControlSize({ width: 1920 }), { width: 760, height: 86 })
  assert.deepEqual(calculateRecordControlSize({ width: 640 }), { width: 640, height: 126 })
})
```

Add static contracts that require `record:set-annotation-command`, `record-frame:snapshot`, sender validation, `setIgnoreMouseEvents`, and forwarding to `record:annotation-snapshot`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `rtk node --test test/recording-utils.test.js test/recording-ui-contract.test.js`

Expected: FAIL because responsive sizing and annotation IPC are absent.

- [ ] **Step 3: Implement responsive control sizing**

Export this pure helper from `recording-utils.js` and use it in `getRecordControlBounds`:

```js
function calculateRecordControlSize(workArea = {}) {
  const available = Math.max(320, Math.round(finite(workArea.width, 760)))
  const width = Math.min(760, available)
  return { width, height: width < 700 ? 126 : 86 }
}
```

- [ ] **Step 4: Implement bounded command and snapshot routing**

Track `_recordFrameState`, `_annotationCommand`, and `_annotationResetVersion` on the control window. Accept commands only from `requireRecordSender(event)`. Accept snapshots only when `BrowserWindow.fromWebContents(event.sender) === recordFrameWindow`, the frame owner is the active control window, and the sanitized snapshot passes `sanitizeAnnotationSnapshot` using `selectionBounds.width/height`.

For command application:

```js
const enabled = ['recording', 'paused'].includes(control._recordFrameState)
const tool = enabled && ANNOTATION_TOOLS.includes(payload.tool) ? payload.tool : 'pointer'
frame.setIgnoreMouseEvents(tool === 'pointer', { forward: true })
frame.webContents.send('record-frame:command', { enabled, tool, color, width, resetVersion })
```

When frame state becomes idle/hidden, on restart, and in `closeRecordFlow`, force pointer passthrough before hiding or closing the frame. Extend `preload-record.js` with `setAnnotationCommand(payload)` and `onAnnotationSnapshot(callback)`.

- [ ] **Step 5: Verify IPC, layout, and syntax**

Run: `rtk node --test test/recording-utils.test.js test/recording-ui-contract.test.js`

Expected: all focused tests PASS.

Run: `rtk npm run check`

Expected: exit code 0.

- [ ] **Step 6: Commit secure routing**

```bash
rtk git add main.js preload-record.js record/recording-utils.js test/recording-utils.test.js test/recording-ui-contract.test.js
rtk git commit -m "feat: route recording annotation input"
```

### Task 4: Recording Toolbar And Live Canvas Composition

**Files:**
- Modify: `record/record.html`
- Modify: `record/record.css`
- Modify: `record/record.js`
- Modify: `test/recording-ui-contract.test.js`

- [ ] **Step 1: Write failing toolbar and composition contracts**

Require the five tool buttons, style popover, undo/clear, active-state rendering, snapshot subscription, and draw order:

```js
test('recording controls expose basic live annotation tools', () => {
  const html = fs.readFileSync(path.join(root, 'record', 'record.html'), 'utf8')
  const script = fs.readFileSync(path.join(root, 'record', 'record.js'), 'utf8')
  for (const tool of ['pointer', 'pen', 'rect', 'ellipse', 'arrow']) {
    assert.match(html, new RegExp(`data-annotation-tool="${tool}"`))
  }
  for (const id of ['annotationStyle', 'annotationPalette', 'annotationUndo', 'annotationClear']) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
  assert.match(script, /onAnnotationSnapshot/)
  assert.match(script, /drawImage\(sourceVideo[\s\S]*drawAnnotationSnapshot/)
  assert.match(script, /resetVersion/)
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `rtk node --test test/recording-ui-contract.test.js`

Expected: FAIL because the controls and composition hook are absent.

- [ ] **Step 3: Add stable toolbar markup and responsive CSS**

Add an `annotation-tools` group between FPS/countdown and recording actions. Use icon-only buttons with Chinese tooltips, a color swatch style button, a hidden palette with seven color buttons and three width buttons, and disabled undo/clear states. At widths below 700px, make `.control-view` a two-row grid while preserving fixed 34px controls and preventing horizontal overflow.

- [ ] **Step 4: Wire toolbar state and annotation commands**

Maintain:

```js
let annotationTool = 'pointer'
let annotationColor = '#ff3b30'
let annotationWidth = 4
let annotationSnapshot = { annotations: [], active: null }
let annotationResetVersion = 0
```

Only enable tools in `recording` and `paused`. Tool/style changes call `recordAPI.setAnnotationCommand`. Undo and clear send fixed actions through the same bridge. Close the palette on outside click, state transitions, and preview entry. Update undo disabled state from the latest sanitized snapshot.

- [ ] **Step 5: Composite live snapshots and reset lifecycle**

After the existing desktop draw call, add:

```js
context.drawImage(sourceVideo, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.width, crop.height)
drawAnnotationSnapshot(context, annotationSnapshot, {
  width: initData.selectionBounds.width,
  height: initData.selectionBounds.height
})
```

Reset the snapshot and increment `resetVersion` before each new countdown/re-record. Hide the frame before stopping/canceling so no late pointer input changes the frozen final snapshot. Preserve snapshot updates while paused so the resumed first frame uses the current state.

- [ ] **Step 6: Verify focused tests and syntax**

Run: `rtk node --test test/recording-ui-contract.test.js test/annotation-utils.test.js`

Expected: all focused tests PASS.

Run: `rtk npm run check`

Expected: exit code 0.

- [ ] **Step 7: Commit toolbar and composition**

```bash
rtk git add record/record.html record/record.css record/record.js test/recording-ui-contract.test.js
rtk git commit -m "feat: composite live annotations into recordings"
```

### Task 5: Regression Verification And Portable Build

**Files:**
- Modify only if verification exposes a scoped defect in files already listed above.

- [ ] **Step 1: Run the complete automated suite**

Run: `rtk npm test`

Expected: all tests PASS, including annotation model and recording contracts.

- [ ] **Step 2: Run syntax and whitespace checks**

Run: `rtk npm run check`

Expected: exit code 0.

Run: `rtk git diff --check`

Expected: no output.

- [ ] **Step 3: Build the Windows portable executable**

Run: `rtk npm run build:win:portable`

Expected: `dist/Highlighter-2.0.0-portable.exe` is produced successfully.

- [ ] **Step 4: Perform the manual recording acceptance pass**

Launch the portable build and verify: pointer passthrough; live pen/rectangle/ellipse/arrow; seven colors; 2/4/7px widths; undo; clear; pause-time annotation; resume first frame; stop/preview/save; re-record reset; no trapped transparent input layer; no border/control UI in the MP4.

- [ ] **Step 5: Inspect an exported MP4**

Save the manual acceptance export as `D:\workspace\Highlighter\dist\annotation-acceptance.mp4`.

Run: `rtk ffprobe -v error -show_entries stream=codec_name,codec_type,pix_fmt,width,height -of default=noprint_wrappers=1 "D:\workspace\Highlighter\dist\annotation-acceptance.mp4"`

Expected: one `codec_type=video` stream with `codec_name=h264` and no audio stream.

- [ ] **Step 6: Commit any verification-only fix**

If Step 1-5 required a scoped correction, stage only those files and commit:

```bash
rtk git add main.js preload-record.js preload-record-frame.js package.json record/annotation-utils.js record/frame.html record/frame.css record/frame.js record/record.html record/record.css record/record.js record/recording-utils.js test/annotation-utils.test.js test/recording-utils.test.js test/recording-ui-contract.test.js
rtk git commit -m "fix: harden recording annotations"
```

If no correction was required, do not create an empty commit.
