// 紧凑编辑器窗口几何：pin「重新标注」与 history「继续编辑」共用同一份算式。
//
// 消费者有两个进程，所以按 shared/ 的既有约定用 UMD 暴露（写法抄
// shared/cursor-geometry.js）：
//   * 主进程：main/domains/pin/index.js `require('../../../shared/editor-layout')`
//     （history 的 capture 接线同样 require 本文件；本文件**不 require Electron**，
//     纯函数 + 纯算术，可直接在 node --test 里跑）
//   * 渲染层：需要 `<script src="../shared/editor-layout.js">` 时才通过
//     `root.editorLayout` 取用（当前主进程是唯一消费者，渲染层还没有引用方）
//
// ---------------------------------------------------------------------------
// 为什么这些常数不能猜整数（原文从 main/domains/pin/index.js 搬来，勿删）
// ---------------------------------------------------------------------------
// 编辑器**永远**在图像下方预留一条工具条（以及 OCR 结果条）的空间，任何模式都一样。
// 区域截图把工具条放在选区下方，所以"刚好等于钉图图像大小"的重标注编辑器没有地方
// 放工具条：渲染层退化成夹取，结果工具条被推进图像内侧顶部且被裁掉（真机缺陷）。
//
// 这条带子的高度是**推导**出来的，不是猜的：窗口比主行窄时工具条会折行
// （capture/capture.css 给每个图标按钮 30px 最小宽度加 7px 内边距，一行需要
// ROW_MIN_CONTENT px），折行后行更高。早期这里拍了个 100px，矩形工具把选项行加进
// 已折行的一行之后，工具条立刻盖住图像。
// test/capture-floating-placement.test.js 从 capture.html/capture.css 现算这些数字，
// UI 一变大会直接打红 —— 所以常数是**契约**，不是调参旋钮。
//
// ---------------------------------------------------------------------------
// 尺寸口径（改之前先读这一段）
// ---------------------------------------------------------------------------
// 入参 imageWidth / imageHeight 是"被编辑图片的**基准尺寸**"，不是窗口尺寸：
//   * pin 重标注：钉图窗口里图像盒的 DIP 尺寸（win.getBounds() 叠加 imageBounds 偏移）；
//   * history 继续编辑：当前 crop 的源像素尺寸（设计文档 §5.3）。
// 返回值里的同名字段是**适配工作区之后**的显示尺寸（<= 基准尺寸，取整且至少 1）。
// 同名是刻意的：调用方把返回值直接喂 imageBounds，源像素换算走 scaleFactorFor()。
//
// 典型接线（跨进程边界要传的四个字段都在这里）：
//     const layout = resolveEditorLayout({ imageWidth: cropW, imageHeight: cropH, workArea })
//     createCaptureWindow({
//       windowBounds: layout.editorBounds,
//       imageBounds: layout.imageBounds,
//       transparent: true,   // 预留条带在图像之外，不透明窗口会把条带涂成底色
//       sourceScaleFactor: scaleFactorFor({ imageWidth: layout.imageWidth, sourceWidth: cropW })
//     })
//
// anchor 是"这张图在屏幕上的图像盒原点（左上角）"，语义**照抄 pin 的历史行为**：
// 编辑器水平居中于图像盒（`anchor.x + (基准宽度 - 编辑器宽度) / 2`），垂直**顶端对齐**
// `anchor.y`，再整体钳制进 workArea。垂直不取居中、水平用基准宽度而非适配后的宽度
// 参与居中，都是 pin 既有行为（测试按此逐像素锁死）。**不要顺手优化**，否则 pin 的
// 窗口会挪位。
//
// 缺省 anchor（或 anchor 的 x/y 不是有限数）时按"图像盒居中于工作区"处理，效果是
// 编辑器窗口本身在工作区正中打开 —— history 没有既有窗口可参照，居中才是用户能预期
// 的那一版。缺一个轴视为整个 anchor 缺失，不做半截拼接。
//
// extraRows / extraRowHeight 只加在**动作区高度**上，供 history 的顶部信息区
// （「正在编辑：文件名（第 N 版）」）使用；默认 0,0 时产出与 pin 改造前逐像素相同。
// 它不改窗口宽度的推导，也不改 imageBounds 的水平居中语义；预留得多，图像就少占
// 一点高度（scale 收紧），这正是想要的行为，不是副作用。
//
// 输入健壮性：非有限/非正数一律降级，**绝不返回负尺寸、绝不抛错**。降级只发生在
// "调用方拿不到真实几何"（屏幕 API 失败、渲染层传了脏数据）时，生产路径传进来的
// 都是 Electron 的真实 workArea。

(function exposeEditorLayout(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.editorLayout = api
})(typeof globalThis === 'object' ? globalThis : window, () => {
  // ---------------------------------------------------------------------------
  // 契约常数（与 test/capture-floating-placement.test.js 反推的 UI 尺寸绑定）
  // 这 6 行保持 `const NAME = <纯数字>` 的字面形状：那个测试按名从本文件正则读取，
  // 值一变就要红了。（改名/改成表达式都会让测试读不到，等于静默松掉契约。）
  // ---------------------------------------------------------------------------
  // Main-row single-line minimum content width.
  //
  // 1040 was measured against the 11-tool strip ("实测 1019，留余量"). Feature C added the
  // finished-look toggle and feature D added the magnifier tool, so the recomputed value is 1044.
  //
  // Bumping it is the correct fix (NOT relaxing the test): this number decides how many strip rows
  // the main process reserves, and a strip that folds into two rows while only one row was reserved
  // pushes the toolbar back inside the image - the real-device defect the header describes.
  //
  // It cannot simply be raised arbitrarily, though. `stripRows = ceil(ROW_MIN_CONTENT / (width -
  // STRIP_CHROME))`, and the narrowest standard window is TOOLBAR_SPACE (1088), i.e. 1074 content
  // px. A value above 1074 makes every narrow window reserve TWO rows while it still renders one -
  // wasting STRIP_ROW_HEIGHT. So the invariant is:
  //
  //     measured <= ROW_MIN_CONTENT <= TOOLBAR_SPACE - STRIP_CHROME
  //     (1044 <= 1064 <= 1074)
  //
  // 20px of headroom is what remains. The next tool that needs more must raise TOOLBAR_SPACE too,
  // and that is a deliberate size decision rather than a silent one: at 1044 + 33 = 1077 the row
  // would already fold.
  const ROW_MIN_CONTENT = 1064 // 主行单行的最小内容宽度（实测 1044，留 20px 余量）
  const STRIP_ROW_HEIGHT = 34 // 30px 按钮 + 3px 行间距，向上取整
  const OPTIONS_ROW_HEIGHT = 30
  const STRIP_CHROME = 14 // 6px 工具条内边距 ×2 + 1px 边框 ×2
  const STRIP_SLACK = 22 // 图像下方 10px 间隙 + 6px 视口内边距 + 6px 外边距
  // 窗口宽度足够让主行**单行**放下（与区域截图一致），这样条带只需要两行的高度。
  // 变量名在 pin 里是驼峰 toolbarSpace；这里改成全大写与其余常数对齐，测试按名读取。
  const TOOLBAR_SPACE = 1088

  // 窗口宽度下限：pin 一直用 420，别改（否则重标注窗口的条带会多折一行）。
  const MINIMUM_EDITOR_WIDTH = 420
  // 源像素到显示像素换算的下限：pin 一直用 0.25。
  const MINIMUM_SOURCE_SCALE_FACTOR = 0.25
  // 拿不到工作区时的降级框。只为"绝不抛错、绝不返回负尺寸"存在，生产路径用不到：
  // Electron 的 screen.getDisplayMatching(...).workArea 永远是真实值。
  const FALLBACK_WORK_AREA = Object.freeze({ x: 0, y: 0, width: 1024, height: 768 })

  const EDITOR_LAYOUT_CONSTANTS = Object.freeze({
    ROW_MIN_CONTENT,
    STRIP_ROW_HEIGHT,
    OPTIONS_ROW_HEIGHT,
    STRIP_CHROME,
    STRIP_SLACK,
    TOOLBAR_SPACE,
    MINIMUM_EDITOR_WIDTH,
    MINIMUM_SOURCE_SCALE_FACTOR,
    FALLBACK_WORK_AREA
  })

  function finiteNumber(value, fallback = 0) {
    const number = Number(value)
    return Number.isFinite(number) ? number : fallback
  }

  function positiveOr(value, fallback) {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? number : fallback
  }

  function nonNegativeOr(value, fallback = 0) {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? number : fallback
  }

  function clamp(value, minimum, maximum) {
    // maximum < minimum 只在退化的 workArea 上出现；此时贴住 minimum 才不会产生负数。
    if (maximum < minimum) return minimum
    return Math.min(Math.max(value, minimum), maximum)
  }

  function normalizeWorkArea(value) {
    const raw = value !== null && typeof value === 'object' ? value : {}
    return {
      x: finiteNumber(raw.x, FALLBACK_WORK_AREA.x),
      y: finiteNumber(raw.y, FALLBACK_WORK_AREA.y),
      width: positiveOr(raw.width, FALLBACK_WORK_AREA.width),
      height: positiveOr(raw.height, FALLBACK_WORK_AREA.height)
    }
  }

  // 源像素 → 显示像素的比例：pin 原式是 max(0.25, imageSize.width / imageWidth)。
  // 保持同一个下限、**不加上限**（钉图由大图缩出来时 pin 本来就会算出 >1 的值）。
  //
  // 参数名要注意：`imageWidth` 是**图片被显示出来的宽度**（pin 里的局部变量 imageWidth，
  // 也就是 resolveEditorLayout 返回值里的 imageWidth），不是入参那个基准宽度。为了让接线
  // 一眼可读，`displayWidth` 是同一含义的别名（两者都给时 displayWidth 优先），推荐写成
  //     scaleFactorFor({ displayWidth: layout.imageWidth, sourceWidth: crop.width })
  // 显示宽度无效才降级为 1（"源 = 显示"的中性值，与 capture/index.js 的缺省一致）。
  function scaleFactorFor(input = {}) {
    const source = input !== null && typeof input === 'object' ? input : {}
    const displayWidth = positiveOr(source.displayWidth, positiveOr(source.imageWidth, 0))
    if (!(displayWidth > 0)) return 1
    const sourceWidth = finiteNumber(source.sourceWidth, 0)
    return Math.max(MINIMUM_SOURCE_SCALE_FACTOR, sourceWidth / displayWidth)
  }

  function resolveEditorLayout(options = {}) {
    const source = options !== null && typeof options === 'object' ? options : {}
    const workArea = normalizeWorkArea(source.workArea)
    // 基准尺寸：非有限/<=0 降级到 1（与 pin 的 Math.max(1, ...) 同义）。
    const baseWidth = positiveOr(source.imageWidth, 1)
    const baseHeight = positiveOr(source.imageHeight, 1)
    const minimumWidth = positiveOr(source.minimumWidth, MINIMUM_EDITOR_WIDTH)
    const extraRows = nonNegativeOr(source.extraRows, 0)
    const extraRowHeight = nonNegativeOr(source.extraRowHeight, 0)

    // width 必须先于 scale 算出，且用的是**基准宽度**（不是缩放后的 imageWidth）——
    // 这条顺序是 pin 原有的非循环依赖，行为断言在
    // test/capture-floating-placement.test.js：imageBounds.width <= editorBounds.width。
    const width = Math.min(workArea.width, Math.max(TOOLBAR_SPACE, Math.max(minimumWidth, baseWidth)))
    const stripRows = Math.max(1, Math.ceil(ROW_MIN_CONTENT / Math.max(1, width - STRIP_CHROME)))
    const actionSpace = stripRows * STRIP_ROW_HEIGHT + OPTIONS_ROW_HEIGHT + STRIP_CHROME + STRIP_SLACK
    // history 的顶部信息区只加高度：extraRows * extraRowHeight，默认 0 时逐值等于 pin。
    const extraSpace = extraRows * extraRowHeight
    const reservedActionSpace = actionSpace + extraSpace
    const scale = Math.min(
      1,
      workArea.width / baseWidth,
      Math.max(1, workArea.height - reservedActionSpace) / baseHeight
    )
    const imageWidth = Math.max(1, Math.round(baseWidth * scale))
    const imageHeight = Math.max(1, Math.round(baseHeight * scale))
    const height = Math.min(workArea.height, imageHeight + reservedActionSpace)

    // 缺省锚点：图像盒水平居中于工作区、纵向让**整块编辑器**居中。代入下面的 x 式
    // 之后等价于"编辑器窗口居工作区正中"（与 scale 无关，因为两项里 baseWidth 抵消）。
    const rawAnchor = source.anchor
    const hasAnchor = rawAnchor !== null && typeof rawAnchor === 'object'
    const anchorX = hasAnchor ? Number(rawAnchor.x) : Number.NaN
    const anchorY = hasAnchor ? Number(rawAnchor.y) : Number.NaN
    const anchor = Number.isFinite(anchorX) && Number.isFinite(anchorY)
      ? { x: anchorX, y: anchorY }
      : {
          x: workArea.x + (workArea.width - baseWidth) / 2,
          y: workArea.y + (workArea.height - height) / 2
        }

    const x = Math.round(clamp(
      anchor.x + (baseWidth - width) / 2,
      workArea.x,
      workArea.x + workArea.width - width
    ))
    const y = Math.round(clamp(anchor.y, workArea.y, workArea.y + workArea.height - height))

    const editorBounds = { x, y, width, height }
    // 图像在窗口内水平居中、贴顶（下方整段留给动作区）。
    const imageBounds = {
      x: Math.round((width - imageWidth) / 2),
      y: 0,
      width: imageWidth,
      height: imageHeight
    }

    return {
      // 归一化后的输入，方便调用方与测试断言"到底按哪个框算的"。
      workArea,
      anchor,
      // pin 改造前的本地变量逐个对应（extraRows=0 时与 pin 逐像素相同）。
      width,
      stripRows,
      actionSpace: reservedActionSpace,
      baseActionSpace: actionSpace,
      extraSpace,
      scale,
      imageWidth,
      imageHeight,
      height,
      x,
      y,
      editorBounds,
      imageBounds
    }
  }

  return {
    EDITOR_LAYOUT_CONSTANTS,
    MINIMUM_EDITOR_WIDTH,
    MINIMUM_SOURCE_SCALE_FACTOR,
    FALLBACK_WORK_AREA,
    resolveEditorLayout,
    scaleFactorFor
  }
})
