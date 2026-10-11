// P0-2-T3 光标合成的纯几何 + helper 行协议解析。
//
// 消费者有两个进程，所以按 shared/ 的既有约定用 UMD 暴露：
//   * 主进程：main/services/cursor-provider.js `require('../../shared/cursor-geometry')`
//   * 渲染层：capture/capture.html 加一行 `<script src="../shared/cursor-geometry.js">`
//     （与 shared/shortcut-keys.js 同款；该行由 S9b 在 capture/** 内落地）
//
// ---------------------------------------------------------------------------
// 坐标系（方案 §9.3 风险条 + §9.2，这里是本特性最容易出错的地方）
// ---------------------------------------------------------------------------
//   cursorScreenPoint  DIP。Electron `screen.getCursorScreenPoint()` 的返回值，
//                      副屏（显示器的虚拟桌面左/上边界）可以为负。
//   captureBounds      DIP。`display.bounds`，同样可为负。
//   imageSize          物理像素。截屏产物（PNG）的尺寸，等于
//                      `dipToScreenRect(display.bounds)` 的物理尺寸。
//   hotspot            物理像素。C# helper 从 `GetIconInfo` 取到的热点，
//                      量纲是**光标位图自身**的像素（左上角为原点）。
//   selectionRect      可选，物理像素，且是**截图图内坐标**（原点 = 截图像素左上角）。
//                      S9b 直接传 `getSourcePixelRect()` 的结果即可。
//   cursorSize         可选，物理像素，光标位图自身尺寸（provider 的 snapshot.width/height）。
//                      只用于把位图尺寸回带进结果，不参与落点计算。
//   drawScale          可选，位图在导出画布上的缩放（**默认 1 = 自然尺寸贴**，见 ④）。
//
// DIP → 物理（方案给的公式，原样落地，勿与 `convertSmartSelectRects` 的
// 物理→逻辑换算混线）：
//     physical = captureBounds.x * scale + (dipPoint.x - captureBounds.x) * scale
//              = dipPoint.x * scale
// 截图像内偏移 = physical - captureBounds.x * scale = (dipPoint.x - captureBounds.x) * scale
//
// 返回值里的 x / y 是**光标位图左上角在截图像内物理像素坐标**，且已经**1:1**减去
// 热点（不修正热点必然偏移；为什么不是"热点 × scaleFactor"见下面 ④ 的实测证据）。
// S9b 的贴图位置是：
//     out.drawImage(cursorImage, placement.x - source.x, placement.y - source.y)
// output canvas 的尺寸就是 source.width × source.height（物理像素），所以位图按
// 自然尺寸贴、不缩放；超出选区的部分由 canvas 自身裁剪 —— 这正是方案 §9.2
// "画在裁剪后的 output 上，天然被选区内裁剪，避免第二套换算"。
//
// `visible === false` 的两种情形：
//   * 输入不合法（缺 bounds / imageSize / 非正缩放）；
//   * 光标**点**落在选区（或未给选区时的整张截图）之外 —— 此时不该画光标。
//     点在选区内但位图跨过选区边缘是允许的：visible 仍为 true，越界部分被裁剪。
//
// 另外：`CURSOR_SHOWING=0`（游戏/全屏独占/未聚焦）由 C# helper 判定并返回
// `showing:false`，provider 会把整次查询降级成 null，几何函数不需要知道这件事。

(function exposeCursorGeometry(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.cursorGeometry = api
})(typeof globalThis === 'object' ? globalThis : window, () => {
  function finiteNumber(value, fallback = 0) {
    const number = Number(value)
    return Number.isFinite(number) ? number : fallback
  }

  function toInteger(value, fallback = 0) {
    const number = Number(value)
    return Number.isFinite(number) ? Math.round(number) : fallback
  }

  function positiveOr(value, fallback) {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? number : fallback
  }

  function resolveCursorPlacement(input = {}) {
    const cursorScreenPoint = input.cursorScreenPoint
    const captureBounds = input.captureBounds
    const imageSize = input.imageSize

    const bounds = {
      x: finiteNumber(captureBounds && captureBounds.x),
      y: finiteNumber(captureBounds && captureBounds.y),
      width: finiteNumber(captureBounds && captureBounds.width),
      height: finiteNumber(captureBounds && captureBounds.height)
    }
    const image = {
      width: finiteNumber(imageSize && imageSize.width),
      height: finiteNumber(imageSize && imageSize.height)
    }
    const point = {
      x: finiteNumber(cursorScreenPoint && cursorScreenPoint.x),
      y: finiteNumber(cursorScreenPoint && cursorScreenPoint.y)
    }

    if (!(bounds.width > 0) || !(bounds.height > 0) || !(image.width > 0) || !(image.height > 0)) {
      return { visible: false, x: 0, y: 0, width: 0, height: 0, pointX: 0, pointY: 0, scaleFactor: 0, reason: 'invalid-input' }
    }

    // scaleFactor 是本特性的主口径（display.scaleFactor）。缺失时回落到
    // imageSize / captureBounds —— 两者在正常输入下相等，回落只为不静默算出垃圾。
    const rawScale = finiteNumber(input.scaleFactor)
    const scaleX = rawScale > 0 ? rawScale : image.width / bounds.width
    const scaleY = rawScale > 0 ? rawScale : image.height / bounds.height
    if (!(scaleX > 0) || !(scaleY > 0)) {
      return { visible: false, x: 0, y: 0, width: 0, height: 0, pointX: 0, pointY: 0, scaleFactor: 0, reason: 'invalid-input' }
    }

    // ① DIP 光标点 → 物理屏幕坐标（显式写成方案给的两段式，负坐标副屏一眼可查）。
    const physicalScreenX = bounds.x * scaleX + (point.x - bounds.x) * scaleX
    const physicalScreenY = bounds.y * scaleY + (point.y - bounds.y) * scaleY
    // ② 物理屏幕坐标 → 截图像内物理偏移。
    const pointX = physicalScreenX - bounds.x * scaleX
    const pointY = physicalScreenY - bounds.y * scaleY

    // ③ 可见性：光标点必须落在选区（未给选区时 = 整张截图）内。右/下边界取开区间，
    //    与 getSourcePixelRect 的裁剪语义一致。
    const selection = input.selectionRect
    const within = selection && finiteNumber(selection.width) > 0 && finiteNumber(selection.height) > 0
      ? {
          x: finiteNumber(selection.x),
          y: finiteNumber(selection.y),
          width: finiteNumber(selection.width),
          height: finiteNumber(selection.height)
        }
      : { x: 0, y: 0, width: image.width, height: image.height }
    const visible = pointX >= within.x && pointX < within.x + within.width &&
      pointY >= within.y && pointY < within.y + within.height

    // ④ 热点修正：**1:1** 减去热点，不再乘 scaleFactor。
    //
    // 实测证据（本机 150% DPI，IDC_ARROW / IDC_IBEAM / IDC_HAND 三组，2026-10-11）：
    //     DPI-unaware 进程  位图 32x32 → 热点 (3,9) / (15,15) / (11,7)
    //     PMv2 进程         位图 48x48 → 热点 (5,14) / (23,23) / (17,11)
    //   后者恰好是前者 ×1.5 后四舍五入 —— 说明 GetIconInfo 的热点与它返回的位图处在
    //   **同一个像素空间**，而该位图已经按系统 DPI 缩放过了（本机 32→48）。
    //   本管线把这个位图按自然尺寸贴到"物理像素"的导出画布上，因此热点修正就是 1:1。
    //   若在这里再乘 scaleFactor，125% 下会多偏 25%，正是方案 §9.3 风险条警告的那类偏移。
    //   `drawScale` 只为"位图确实被缩放贴出"的通用情形保留，默认 1（S9b 不传）。
    const hotspotX = toInteger(input.hotspot && input.hotspot.x)
    const hotspotY = toInteger(input.hotspot && input.hotspot.y)
    const drawScaleX = positiveOr(input.drawScale, 1)
    const drawScaleY = positiveOr(input.drawScale, 1)

    return {
      visible,
      // 取整到整物理像素：1:1 贴图，避免 drawImage 的分数坐标触发重采样把光标糊掉。
      x: Math.round(pointX - hotspotX * drawScaleX),
      y: Math.round(pointY - hotspotY * drawScaleY),
      width: toInteger(input.cursorSize && input.cursorSize.width),
      height: toInteger(input.cursorSize && input.cursorSize.height),
      pointX,
      pointY,
      hotspotX,
      hotspotY,
      scaleFactor: scaleX,
      reason: visible ? '' : 'outside-selection'
    }
  }

  // helper 的单行 JSON 协议解析（纯函数，无 IO）。既有 `ready` / `id x y` 两种
  // 响应语义原样保留，cursor 是新增的第三种。
  //   { kind: 'ready',   windows }                    启动横幅
  //   { kind: 'rects',   id, rects }                  既有命中测试响应
  //   { kind: 'cursor',  id, showing, png, ... }      cursor 命令响应
  //   { kind: 'invalid', reason }                     空行 / 坏 JSON / 未知形状
  function parseHelperMessage(line) {
    const text = typeof line === 'string' ? line.trim() : ''
    if (!text) return { kind: 'invalid', reason: 'empty' }

    let message
    try {
      message = JSON.parse(text)
    } catch (error) {
      return { kind: 'invalid', reason: 'json' }
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return { kind: 'invalid', reason: 'shape' }
    }

    if (message.ready === true) {
      return { kind: 'ready', windows: Array.isArray(message.windows) ? message.windows : [] }
    }

    if (message.cursor === true) {
      const id = Number.isInteger(message.id) ? message.id : null
      if (message.showing !== true) return { kind: 'cursor', id, showing: false }
      const png = typeof message.png === 'string' ? message.png : ''
      if (!png) return { kind: 'invalid', reason: 'cursor-png' }
      return {
        kind: 'cursor',
        id,
        showing: true,
        png,
        width: toInteger(message.width),
        height: toInteger(message.height),
        hotspot: { x: toInteger(message.hotspotX), y: toInteger(message.hotspotY) },
        physicalPoint: { x: toInteger(message.x), y: toInteger(message.y) }
      }
    }

    if (Number.isInteger(message.id) && Array.isArray(message.rects)) {
      return { kind: 'rects', id: message.id, rects: message.rects }
    }

    return { kind: 'invalid', reason: 'unknown' }
  }

  // 渲染层 <img src> / canvas 贴图用的 data URL（base64 已是 PNG 字节）。
  function toCursorDataUrl(png) {
    const text = typeof png === 'string' ? png : ''
    return text ? `data:image/png;base64,${text}` : ''
  }

  return { parseHelperMessage, resolveCursorPlacement, toCursorDataUrl }
})
