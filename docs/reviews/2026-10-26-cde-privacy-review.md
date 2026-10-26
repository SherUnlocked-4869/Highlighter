# C / D / R0.4 隐私路径对抗式代码评审（2026-10-26）

- 基线：`master`，HEAD `ee08225`，工作区在评审开始时干净。
- 评审对象：R0.4 识别遮挡（`shared/occlusion-mask.js` + `applyRecognitionOcclusion`）、
  放大镜 D（`capture/magnifier-sampler.js` + `shared/magnifier-geometry.js`）、
  schema v3（`shared/capture-document.js`）。
- 评审方式：全文通读 + 纯函数探针（`node`）+ **真实 Electron 隐藏窗逐像素探针**。
  所有探针脚本在 `.tmp-priv/`（gitignored）。
- 交接文档 `docs/plans/2026-10-25-feature-CDE-handoff.md` §7.1 要求"优先审 §6 三条已修缺陷的
  修复本身是否引入新问题"——本报告的 **F1/F2/F3 正好就是这些修复引入/未覆盖的新问题**。

---

## 0. 结论（verdict）

**No —— 隐私保证在当前实现下不可成立，而且失效的正是"修复后的"那条路径。**

R0.4 的识别遮罩在**普通截图窗口**里是对的：我在真实 Electron 窗口里逐像素验证过，
无模糊单点的场景 20 000/20 000 像素被不透明黑覆盖（F-table 里"已验证"一节）。
但同一套代码在**文档编辑器**（历史记录"继续编辑"、pin 重新标注）里走的是另一条分支，
有三处独立的坐标空间错误，其中两处把隐私保证直接作废：

1. **识别遮罩画在错误位置**（F1，critical）：`annotationsForMask()` 在文档编辑器里返回
   `crop` 相对坐标，而识别画布是**整张底图**，于是遮罩整体偏移一个 crop 原点。
   实测 `crop = (100,80)` 时，用户打的马赛克区域 **只有 11.2% 被遮**，剩下 88.8% 的亮色
   "秘密"像素原样送进模型。这不是边角漏一个像素，是整块漏。
2. **镜头采样读到完全错误的区域**（F2，critical）：`magnifierInSourceSpace()` 在文档编辑器里
   直接 `return normalizeMagnifier(item)`，但 `annotations` 是**视口 CSS**。默认几何
   （零原点 crop、1600×1200 图放进 640×460 区域，zoom≈0.383）下镜头采样点偏移
   **541 px**。实测镜头画布 100% 是黑色——它采到了别处的遮罩，而不是用户想要的区域。
   这条和交接文档 §6 第 1 条（"CSS 喂给源像素空间"）是**同一个 bug 类**，只修了普通窗口那一半。
3. **打开文档即静默破坏数据**（F3，high）：`clipRestoredMagnifiers()` 用源像素 `crop`
   去判视口 CSS 对象。零原点 crop 时把合法放大镜的源区从 `340,80` 裁成 `366,54`
   （实测，见 F3），crop 原点非零时直接**删除**合法对象。这是 load 帧、**不进撤销栈**，
   用户无法恢复。

除此之外还有 F4（宽度镜像：镜头遮罩比实际马赛克窄，最大每侧 60 源像素，**已由 Lead 修复**）、
F5（视口往返破坏"打开不变脏"）、F6（缓存键不同图同尺寸碰撞）等。

值得强调：**F1/F2/F3 全部能通过当前 1790 个测试**。它们只在"文档编辑器 + 真实窗口"这个
组合下出现，而现有的真机探针只覆盖了普通截图窗口。

---

## 1. Findings

严重度定义：**critical** = 隐私保证失效或可静默丢用户数据；**high** = 功能性错误且用户可感知；
**medium** = 特定条件下错误；**low/nit** = 代码质量。**CONFIRMED** = 已用真实窗口探针或
确定的代码路径证明；**SUSPECTED** = 静态推理成立但未跑出端到端证据。

| ID | 严重度 | 位置 | 问题 | 具体失效场景 | 最小修复 | 状态 |
|---|---|---|---|---|---|---|
| **F1** | **critical** | `capture/capture.js:2787-2798`（`annotationsForMask`） | 文档编辑器分支返回 `crop: documentCrop()`（源像素 crop），但 `exportSelectionCanvas()` 产出的画布是**整张底图**（`capture.js:2925-2926`：`getSourcePixelRect` 在文档编辑器里 = 全图，因为 `selection = imageDisplayBounds()` 且 `image.naturalWidth` 是底图宽）。`planOcclusion` 减掉一次 crop 原点，画布原点却是 0 | 用户打开一条历史记录（base 900×700，crop=100,80,640,420），在马赛克区域打码后点 OCR。实测：秘密区域 20 000 px 中**只有 2 244 px（11.2%）被遮**；遮罩实际落在 (218,198)，正确位置是 (320,280)——**偏移 (−102,−82)**。`brightFraction` 0.888，即 88.8% 的原始亮色像素进入模型 | 文档编辑器分支也用 `crop: { x:0, y:0, w: image.naturalWidth, h: image.naturalHeight }`，或者让识别画布真正按 crop 裁切。二选一，但不能两边各说一套 | **CONFIRMED**（Electron 逐像素，`result4.json`） |
| **F2** | **critical** | `capture/capture.js:3175-3179`（`magnifierInSourceSpace`：`if (documentEditor) return magnifier`） | 注释写"文档编辑器已经是源像素"，但 `restoreDocumentEditor()`（`capture.js:3579`）执行的是 `annotations = api.annotationsFromDocument(...)`，即**视口 CSS**。于是把视口 CSS 当作源像素交给采样器 | 零原点 crop（唯一出厂形态）、1600×1200 图放在 640×460 区域（zoom 0.383）：文档里源区是 `(900,700,120,80)`，实际采样 `(358.33,294.33,46,30.67)`——**偏移 541 px**。真实窗口实测镜头画布 **blackFraction = 1.0**：镜头显示的是别处的遮罩，不是用户框选的区域 | 删掉 `documentEditor` 短路，统一走 `annotationsFromViewport(item, documentViewport())`。文档编辑器里这个投影是恒等变换（zoom 由 fitViewport 决定），删掉短路不会改变正确路径的结果 | **CONFIRMED**（Electron 真实窗口，`result9.json` / `result10.json`） |
| **F3** | **high** | `capture/capture.js:3657-3666`（`clipRestoredMagnifiers`，`api.clipToCrop(item, crop)`） | 同 F2 的空间混用，后果是**在打开时静默改写/删除合法数据**，且发生在 load 帧、**不进撤销栈**（`annotationHistory = [cloneAnnotations(annotations)]`，`capture.js:3678`） | crop = `(100,80,640,420)`、zoom = 1：文档里 `sourceRect = (110,90,120,80)` 完全合法，打开后变成 `(200,134,30,36)`——被**裁小**。更靠角落的合法对象（`(40,30,120,80)`，在 crop 外但在 `(0,0,640,420)` 内）实测被**直接删除**（`liveCount: 0`）。零原点 crop + 底边对象 `(200,340,120,80)`（`y+h = 420` = crop 下边界，合法）实测被裁成 `(200,366,120,54)` | 与 F2 同一处修复：先 `annotationsFromViewport`，再 `clipToCrop`，最后 `annotationsToViewport` 放回 | **CONFIRMED**（Electron，`result3/8/11/12/13.json`） |
| **F4** | **high** | `capture/capture.js:3084-3110`（`annotationsForSampling` 的 `width`） | 先把 CSS 预设宽度乘 `widthScale`，再交给 `brushStrokeWidth()` 量化；而显示路径 `capture.js:639` 是 `blurBrushWidth(item.width) * deviceScale`——**先量化后缩放**。顺序相反导致遮罩比实际画的马赛克窄 | 21 组（预设 × 缩放）中 **16 组遮罩更窄**。最坏：预设 8 @ 3× → 实际画 144 px，遮罩只有 24 px，**每侧短 60 源像素**，足以漏出整个字形。识别路径（`transformOccluder`）顺序正确，21 组全是 0 | 量化在前、缩放在后（与 painter 一致） | **CONFIRMED + 已由 Lead 修复**（见 §1.1）。修复后 0/21 更窄，且 Lead 在 `test/capture-magnifier-ui.test.js` 补了行为回归测试（"the lens mask width is never narrower than the mosaic the user actually sees"，含反向对照证明它能抓到修复前公式）；全量 1813/1813 绿。**本条不再计为待办发现** |
| **F5** | **medium** | `shared/magnifier-geometry.js:75-84`（`normalizeRect` 的 `Math.max(MIN_SOURCE_EDGE_PX, ...)`） | `MIN_SOURCE_EDGE_PX = 4` 的地板在**两个坐标空间**都生效。视口空间里 `w*zoom < 4` 完全合法，被抬成 4 再除回去就放大。这正是交接文档 §6 第 2 条为 `stroke.widthPx` 修掉的 bug 类（"clamp 在 normalize 里做了两次"），但**嵌套矩形没修** | 直接调用：`normalizeRect({w:0.8}).w === 4`（应为 0.8）。文档级往返 2 856 组中 **2 099 组（73.5%）内容指纹改变** → 违反"打开不增版、不变脏"。具体：w=4 @ zoom 0.25 → 回来变 16；w=16 @ zoom 0.2 → 变 20（且 `validateMagnifier` 仍返回 ok，**损坏能通过校验**） | 与 `stroke.widthPx` 同样的处理：`normalizeRect` 不做范围夹取，只保留正数地板 + 量化；范围归 `validateMagnifier` | **CONFIRMED**（纯函数，`probe-vp3/vp4/vp5/rootcause.js`） |
| **F6** | **medium** | `capture/capture.js:3042` + `:3159` | 采样底图缓存键与镜头缓存键都用 `${naturalWidth}x${naturalHeight}` 当底图身份：**不同图片、同尺寸 → 键完全碰撞**。`baseImageId` 同理 | 实测两把键逐字节相同（`1920x1080\|0,0,1920,1080\|751e0a2c9022fbdb`）。同一窗口内切换底图（pin 重新标注复用窗口、`reload`、A→B 两张同尺寸截图）会命中旧缓存，镜头显示上一张图的像素 | 键里用真正的底图身份（assetId / 内容 sha256 / 对象标识）。`initData` 里已有 `baseImage.sha256` 可用 | **CONFIRMED**（键碰撞，`probe-cache.js`）；端到端触发为 SUSPECTED |
| **F7** | **medium** | `capture/capture.js:2877-2905`（`applyRecognitionOcclusion`）+ `:3982` | 文档编辑器 + **crop 外有 blur** 时，`planOcclusion` 因裁剪把 op 全丢掉 → `masked=false` → fail-closed 兜底"全画布涂黑"（900×700） | 模拟：blur 在 crop 外（`(700,500)` vs crop `(0,0,480,360)`）→ `masked=false` → 整张 900×700 全黑。隐私安全（过遮不泄漏），但这是**可用性 bug**：用户只是画了半屏马赛克，识别直接返回"全黑"或 `mask-unavailable` 提示 | 这是 F1 的次生症状；修 F1 后自然消失。另建议把"blur 完全在 crop 外"当作"无需遮"，而不是"计划失败" | **CONFIRMED**（`probe-overmask.js`） |
| **F8** | **low** | `capture/magnifier-sampler.js:161-189`（`sampleMagnifier`） | `drawImage` 的源矩形**不做任何 clamp**。源区被裁到 crop 边缘时读越界区域 | `sourceRect=(750,550,100,100)` vs 800×600 采样底图 → 读 `sx+sw=850 > 800`。平台相关地产生透明/拉伸边缘。**非隐私问题**（遮罩已画在底图上） | `drawImage` 前把源矩形收进 `[0, base.width]×[0, base.height]`，并相应调整目标矩形 | **CONFIRMED**（`probe-sampler-clip.js`） |
| **F9** | **low** | `capture/capture.js:3054-3060`（`ensureSampleBase` 的 `catch`） | `composeSampleBase` 抛错时直接 `return null`，**既不清 `sampleBaseKey` 也不 `reset()`**。虽然下一次调用会因为键不同而重算，但失败瞬间 `lensSampler` 里仍是旧底图，若同一帧内有另一个镜头请求就会用旧底图采样 | 失败→同一帧第二个 `magnifierLensCanvas()` → `sample()` 用旧 `sampleBase`。概率低（compose 抛错本身罕见），但属于"失败后残留状态"一类 | `catch` 里 `lensSampler.reset()` 或 `sampleBaseKey = ''` | SUSPECTED |
| **F10** | **nit** | `capture/annotation-geometry.js:158` / `capture.js:3179` | `magnifierApi.normalizeMagnifier()` 在**每个渲染帧**对每个镜头调用多次（`annotationBounds` / `hitTestMagnifier` / `lensRect` / `drawMagnifier` / `magnifierInSourceSpace`），每次都重建对象 | 8 个镜头 × 60fps 的可测量开销；不是正确性问题 | 缓存规范化结果，或在调用链上传递已规范化的对象 | 静态观察 |
| **F11** | **nit** | `shared/magnifier-geometry.js:794-829`（`magnifierToViewport` / `magnifierFromViewport`） | 两个方向的 `stroke.widthPx` 都做了 `* zoom` / `/ zoom`，但 `normalizeMagnifier` 的量化在两端各跑一次；`sourceRect` 却完全没有量化 | 这是 F5 的一种表述；列在这里是因为**同一文件的注释已经明确讨论过量化**（`quantizeLength`），说明作者知道该机制，只是没用到矩形上 | 见 F5 | CONFIRMED（合并到 F5） |

### 1.1 F4（宽度镜像）—— 已修复，保留证据供后人查

修复前（Lead 的修法：`annotationsForSampling()` 传**原始预设宽度**，新增
`buildOccludersForSampling()` 先让 `brushStrokeWidth()` 量化、再乘 `widthScale`）：

| 预设 | 缩放 | painter 实际画（源像素） | 修复前镜头遮罩 | 修复前每侧偏短 | 识别路径遮罩 |
|---|---|---|---|---|---|
| 2 | 1.5 | 27 | 24 | 1.5 | 27 |
| 4 | 1.5 | 36 | 24 | 6 | 36 |
| 8 | 1.5 | 72 | 24 | 24 | 72 |
| 4 | 3 | 72 | 24 | 24 | 72 |
| 8 | 2 | 96 | 24 | 36 | 96 |
| **8** | **3** | **144** | **24** | **60** | **144** |

（完整 21 行见 `.tmp-priv/probe-width2.js`；汇总：修复前 16/21 更窄，识别路径 0/21。）

根因精确表述：`brushStrokeWidth()`（`shared/occlusion-mask.js:49-53`）把输入**量化到
`{2,4,8}` 预设表**并取 `max(18, preset*6)`。把 `cssWidth * widthScale` 喂进去，
任何 `scale != 1` 都会落在预设之间、`Math.round` 后**向下掉到最近预设**（通常是 4 → 18 的地板）；
而 painter 是 `blurBrushWidth(item.width) * deviceScale`（`capture.js:639`，先量化后缩放）。
这解释了为什么只有 `scale` 恰好是整数（1、2）时两边才相等。

### F1 的关键证据（逐像素）

真实 Electron 隐藏窗，文档编辑器模式，`crop = (100,80,640,420)`，900×700 底图，
马赛克矩形 `(320,280)-(520,380)`（底下是亮黄/青条纹"秘密"）：

```
识别画布                : 900×700（整张底图，不是 crop 的 640×420）
0 78>>  maskCrop             : {100,80,640,420}     ← 被减掉的 crop 原点
planRect（源像素）      : {320,280,200,100}
遮罩实际落点            : {218,198,204,104}     ← 减了 crop 原点
秘密区域命中不透明黑    : 2244 / 20000  = 11.2%
秘密区域仍为亮色        : 17756 / 20000 = 88.8%
```

同一份代码在**普通截图窗口**中：`secret.blackFraction = 1.0`（20 000/20 000），
`maskCrop = {0,0,900,700}`。所以这不是"遮罩算法坏了"，而是**文档编辑器分支的坐标空间错了**。

---

## 2. 已验证正确的部分（不要再查一遍）

这些我用真实窗口或纯函数探针确认过是对的：

| 项 | 位置 | 证据 |
|---|---|---|
| 普通截图窗口的识别遮罩**完全覆盖**马赛克区域且不外溢 | `capture.js:2877-2905` | Electron：secret 区 20 000/20 000 黑，整幅只有 3.37% 被遮（正是两个马赛克矩形的面积） |
| 三个开关互相独立，且识别 = `false/false/true`、用户出口 = `true/true/false` | `capture.js:3972-3977` | 源码 + `occlusion-recognition-wiring.test.js:33-54`；实测 `mask:true` 不牵动 `compose` |
| `includeAnnotations` 在识别路径恒为 `false`，模型看不到箭头/文字/高亮/光标 | `capture.js:3977`、`:2928-2947` | `exportSelectionCanvasForAction(!pixelOnlyActions, ...)`；光标贴图也在 `if(includeAnnotations)` 内 |
| highlight **不**参与遮挡（不是保密工具） | `shared/occlusion-mask.js:69-71` | `occluderFor` 只认 `type === 'blur'`；`magnifier-geometry.test.js:324-334` |
| 显示态预览/橡皮擦**不**解除保护（只有删对象才解除） | `occlusion-mask.js:102-116` | `buildOccluders` 只读文档快照；`wiring.test.js:102-119` 用 `previewOpacity:0, erased:true` 断言 plan 不变 |
| 遮罩在任何缩放**之前**施加（源分辨率） | `magnifier-sampler.js:79-109` 的顺序、`capture.js:2836-2864` 不缩放 | `paintOcclusion` 在 `drawImage` 之后、`sampleMagnifier` 之前；`sampler.test.js:64-90` 断言调用顺序 |
| 遮罩不透明（alpha=1）且不沿用任何显示透明度 | `occlusion-mask.js:33-34`、`magnifier-sampler.js:115-152` | `MASK_ALPHA` 恒 1；`sampler.test.js:92-111` |
| 矩形 blur 的遮罩比显示区域**大** 2px（保守扩张，不是小） | `occlusion-mask.js:30`、`:87-99` | `occluderBounds` 四边各加 `CONSERVATIVE_MARGIN_PX`；`wiring.test.js:121-137` |
| 笔刷 blur 用**全宽 + 圆端帽/圆角**，单点也画点 | `magnifier-sampler.js:133-148`、`capture.js:2850-2860` | `lineCap/lineJoin = 'round'`，宽度是全宽；单点补 `lineTo(x+0.01)` |
| 识别路径的笔刷宽度**正确**（先量化后缩放） | `transformOccluder` `capture.js:2804-2832` | 21/21 组与 painter 一致（0 偏差） |
| 遮罩失败时 fail-closed（涂满）而不是 fail-open | `capture.js:2894-2903`、`:2772` | catch → 全覆盖；`!plan.masked` → 全覆盖；`mask && !masked` → 返回 null；`:3982` 报警而非重试 |
| 遮罩画布不会回流成编辑底图/保存结果 | `capture.js:2922-2949`（每次新建）、`documentResultBuffer` 不含遮罩 | `wiring.test.js:154-167` 断言 `apply` 中无 `image =`，且 commit 路径不调遮罩 |
| `hasOccludableBlur` 在**枚举失败时偏向保护**（返回 true） | `capture.js:2911-2920` | `catch → true`、非数组 → `true` |
| 字节预算按 4 bytes/px 计费、超预算条目不入缓存、LRU 正确、`clear()` 归零 | `magnifier-sampler.js:44-48`、`:212-262` | `sampler.test.js:260-317`；我复核了 `set()` 里 `bytes` 先减后加不会漏账 |
| 移动镜头**不**重新采样（缓存键不含 `lensOrigin`） | `magnifier-geometry.js:394-403` | 键里无 lensOrigin；`sampler.test.js:183-203` 断言第二次是同一 canvas |
| 改源区/倍率/遮罩/crop/底图**会**失效 | `magnifier-geometry.js:394-403` | 五个字段都在键里；`sampler.test.js:205-231` |
| 普通标注、blur 颜色**不**触发采样底图失效（正确，因为不改遮住的像素） | `occlusion-mask.js:165-192` | `maskFingerprint` 只算几何/宽度/扩张量，不算 id/颜色；实测颜色变化键不变 |
| 迁 v1→v3、v2→v3 后内容指纹**等于**直接归一化（"打开 v1 不变脏"） | `capture-document.js:681-724` | 实测 v1 迁移后指纹 `a2e5d3132c7a4bd3`，与等价 v2 逐字节相同，且是归一化不动点 |
| 未知未来版本 → `unsupported-schema` → 仅位图降级 | `capture-document.js:661-668` | 实测 `schemaVersion:4` → `{ok:false, code:'unsupported-schema'}` |
| v3 序列化往返是内容指纹不动点 | `capture-document.js:629-633`、`:775-777` | 实测 `serialize → parse → fingerprint` 与原始相同 |
| 每个文档最多 8 个放大镜，且校验与工具双端强制 | `capture-document.js:565-567`、`capture.js:2552` | `magnifier-geometry.test.js:217-233` |
| 倍率只接受 2/3/4，字符串 `'3'` 也拒绝 | `magnifier-geometry.js:206-212` | `validateMagnifier` 先查 `typeof === 'number'` |
| 源区必须落在 crop 内（**校验**这一层是对的，只是运行时用了错的坐标系，见 F3） | `capture-document.js:528-537` | 无效文档进不了 `commit` |
| 采样底图尺寸 = crop 尺寸，且 1:1 不重采样 | `magnifier-sampler.js:82-102` | `sampler.test.js:64-90` 断言 `drawImage` 参数 |
| 没有旋转/翻转需要处理（放大镜不支持旋转；地图层也没有 EXIF 方向变换） | `magnifier-geometry.js:22`、全仓无相关代码 | 全仓 grep `flip|rotate` 无放大镜/遮罩相关分支 |

---

## 3. 测试缺口：哪些发现现有测试抓不到，哪些断言比看起来弱

当前全量门禁 **1790/1791 通过**（唯一失败 `translation-proxy-service.test.js` 单独复跑 23/23
通过，与本区域无关，判断为环境 flake）。**F1–F8 全部在这 1790 个绿色测试下通过。**

### 3.1 现有测试抓不到我的哪些发现

| 发现 | 为什么现有测试抓不到 |
|---|---|
| **F1** 文档编辑器识别遮罩错位 | `occlusion-recognition-runtime.test.js:150` 的探针只开**普通截图窗口**（`mode:'region'`，无 `documentEditor`），它断言的是 `crop` 相对坐标那一支。**没有任何测试**在 `documentEditor` 模式下调用 `exportSelectionCanvasForAction(..., {mask:true})` |
| **F2** 文档编辑器镜头采样错区 | `magnifier-runtime.test.js` 同样是 `mode:'region'`（`test/magnifier-runtime.test.js:158`）。`magnifier-reedit-runtime.test.js` **是**文档编辑器，但它只断言"镜头是对象、几何在文档空间不变、面板回显"——**从不检查镜头画布的像素** |
| **F3** 打开即裁小/删除合法镜头 | `magnifier-reedit-runtime.test.js:146` 用的源区是 `(220,180,160,100)`，而 crop 是 `(100,80,640,420)`：视口坐标 `(120,100)` 恰好仍落在 crop 内，所以 `clipToCrop` 返回 `adjusted:false`。**这是"测试值碰巧安全"**。把源区改成 `(110,90,...)` 立刻暴露（我已实测） |
| **F4** 宽度镜像（已修） | `capture-magnifier-ui.test.js:118-125` 只对源码做正则断言（`assert.match(sampling, /x: source\.x \+ .../)`），**不检查宽度**。`occlusion-mask.test.js`（交接文档 §5 声称覆盖"两边给出同一个数"）**在仓库里根本不存在**——`ls test/*occlusion-mask*` 无此文件。`annotation-style.test.js:274-294` 只钉了 `blurBrushWidth` 自己 |
| **F5** 视口往返破坏指纹 | `magnifier-geometry.test.js:483-532` 的往返测试用 `sourceRect={100,100,80,60}`，在 `zoom ∈ {0.25..3}` 全部精确（80×0.25=20 > 4，撞不到地板）。**只在 `w*zoom >= 4` 时才成立**，而测试值恰好满足。它也没有做"往返 → 重新归一化 → 比较内容指纹"这一步 |
| **F6** 缓存键碰撞 | `sampler.test.js:205-231` 只测 `baseImageId: 'base-a' → 'base-b'` 这种**字符串不同**的情况，从不测"两张图同尺寸"。`ensureSampleBase` 的键拼接完全没有测试（`capture-magnifier-ui.test.js:138-141` 只正则匹配 `sampleBaseKey = ''`） |
| **F7** 过遮 | 无测试覆盖"crop 外有 blur"；`wiring.test.js:121-137` 只测"crop 外 occluder 被丢弃 → `masked:false`"，并断言这是**正确行为**——在识别路径它会触发全画布涂黑 |

### 3.2 比看起来更弱的现有断言

1. **`test/occlusion-recognition-wiring.test.js` 本质是"源码形状测试"。**
   `sliceBetween()` + `assert.match()` 只能证明"源码里有这行字"，证明不了行为。
   例如 `:62-64` 断言 `mask.buildOccluders(input.annotations)` 存在——但**正是这一行**在
   文档编辑器里拿到了错误坐标（F1）。`:179` 断言 `if (!mask || !context || !image) {` +
   `return null` 存在，但没测"blur 存在且计划为空"时会不会涂满。
   **建议**：至少把 `applyRecognitionOcclusion` 抽成可注入依赖的纯函数，用真 canvas 测像素。

2. **`test/capture-magnifier-ui.test.js:110-160` 通篇是正则匹配。**
   `assert.match(base, /const occluders = mask\.buildOccluders\(annotationsForSampling\(\)\)/)`
   在 F2 存在时**依然通过**，因为 `annotationsForSampling` 在文档编辑器里也确实被调用了
   （只是它拿到的是视口数组）。这是"接线对了、语义错了"的典型。

3. **`magnifier-runtime.test.js:177-179` 的 `window.__mag` 探针直接**改写**
   `annotations` 数组并放置一个 `sourceRect` 字面量**，绕过了 `annotationsToViewport`。
   所以它测的是"采样器本身正确"，测不到"渲染层喂给采样器的坐标是否对"。
   交接文档 §6 第 1 条说这个探针抓到了 CSS/源像素混用——它抓到的是**普通窗口**那一半。

4. **`magnifier-geometry.test.js:209-213` 的 `clipMagnifiersToCrop` 测试**用
   `sourceRect:{320,320,40,40}` 判在 crop `(300,300,200,200)` 内，**同样是视图无关的值**；
   它测的是 `shared` 模块的纯函数，不是 `capture.js:3657` 那个错误调用点。

5. **`occlusion-recognition-runtime.test.js:299` 把 `CONSERVATIVE_MARGIN_PX` 硬编码成 2**
   并加了 `<= 1` 容差。若常量改成 3，测试会**静默偏移**而不会失败在"常量变了"这个原因上。

6. **`sampler.test.js:321-344` 的"键一致性"测试**是把同一个输入喂给两层再比较——
   它证明了"两层拼接方式一致"，但两层都用了 `baseImageId` 这个可碰撞的标识（F6），
   所以它是**同义反复**。

---

## 4. 建议的修复顺序

1. **F1**（识别遮罩错位）——隐私 P0，最高优先。改动最小：`annotationsForMask` 的
   文档编辑器分支改成全图 crop。
2. **F2 + F3**（同一根因：`documentEditor` 短路 + 视口/源像素混用）——一起修，
   删掉 `magnifierInSourceSpace` 的短路，`clipRestoredMagnifiers` 走
   `annotationsFromViewport → clipToCrop → annotationsToViewport`。
3. **F5**（`normalizeRect` 的地板）——按 `stroke.widthPx` 的既有修法处理。
4. **F6**（缓存键身份）——换成 assetId / sha256。
5. **F4 已由 Lead 修复**；建议补一条行为回归测试（断言"镜头遮罩宽度 == painter 宽度"，
   对 3 个预设 × 多个缩放的组合），而不是正则断言。
6. **F7/F8/F9/F10/F11** 随上面的修复一起清理。

## 5. 复现脚本

全部在 `D:/workspace/Highlighter/.tmp-priv/`（gitignored，未提交）：

| 脚本 | 证明 |
|---|---|
| `probe-width2.js` | F4 的 21 组宽度对照表 |
| `probe-vp3.js` / `probe-vp4.js` / `probe-vp5.js` / `probe-rootcause.js` | F5 的指纹漂移率与根因 |
| `probe-cache.js` | F6 的键碰撞 + F9 的失败路径 |
| `probe-overmask.js` | F7 的过遮 |
| `probe-sampler-clip.js` | F8 的越界读 |
| `docprobe/probe1.js` | F2 的坐标偏移（541 px） |
| `docprobe/probe2.js` / `probe4.js` / `probe7.js` | F1 的 11.2% 覆盖率 |
| `docprobe/probe3.js` / `probe6.js` / `probe8.js` / `probe11.js` / `probe12.js` / `probe13.js` | F3 的裁小/删除 |
| `docprobe/probe9.js` / `probe10.js` | F2 的镜头黑屏（零原点 crop、zoom<1） |
| `docprobe/probe5.js` | 普通截图窗口的对照组（遮罩 100% 正确） |

运行方式（AGENTS.md 的四个陷阱都已规避）：

```bash
env -u ELECTRON_RUN_AS_NODE \
  DOC_PROBE_ROOT="D:/workspace/Highlighter" \
  DOC_PROBE_RESULT="D:/workspace/Highlighter/.tmp-priv/docprobe/out.json" \
  TMP="D:/workspace/Highlighter/.tmp-priv" TEMP="D:/workspace/Highlighter/.tmp-priv" \
  node_modules/electron/dist/electron.exe --no-sandbox .tmp-priv/docprobe/probe4.js
```

---

## 6. 未检查 / 时间用尽的清单（接手者优先补这些）

按重要性排序。这些我**没有**形成结论，不要当成"已审过没问题"。

| # | 未完成项 | 为什么它值得看 |
|---|---|---|
| U1 | **`clipMagnifiersToCrop` 的"load 帧不可撤销"是否有第二个受害者** | 我证明了 F3 会让它删掉合法对象，但只测了 `capture.js:3657` 这一条调用链。`shared/capture-document.js:990-1004` 导出的那个入口在生产代码里**没有任何调用者**（只有 `test/magnifier-geometry.test.js:209` 用），意味着 plan §7.1 要求的"裁剪手势里同上一个撤销帧移除对象"**根本没有接线**——裁剪手势本身也未实现。如果裁剪功能后续落地，必须连同撤销帧一起做，否则就是 F3 的升级版 |
| U2 | **F2/F3 在 `zoom == 1` 且 crop 原点为 0 时是否真的无害** | 我用 `probe6/probe8/probe11` 观察到 `zoom=1` 时仍有 `offsetY=26` 的平移，导致 F3 触发（`340→366`）。理论上 `offset=(0,0)` 时视口与源像素仅差 `-crop.origin`，两者都为零时应当恒等。我**没有**构造出"完全恒等"的窗口来确认边界，所以 F2/F3 的"最小触发条件"只到"zoom<1 或 offset≠0 或 crop 原点≠0"这一级表述 |
| U3 | **混合 DPI / 非整数 `devicePixelRatio` 的端到端** | 全部真机探针都在 DPR=1（`win.webContents` 默认）。`blurBrushWidth(width, scale)` 的 `scale` 参数在显示路径是隐式 DPR，导出路径是 `getSourcePixelRect` 的比例；我只在纯函数层验证了公式，没在 DPR=1.5/2 的真实窗口里逐像素验证 |
| U4 | **F6 的端到端触发** | 键碰撞已证明（纯函数）。"同一窗口内换底图"在 pin 重新标注路径上看起来可能，但我没有跑出真实序列（需要 pin → 重新标注 → 换图）。**SUSPECTED** |
| U5 | **F9 的同帧二次采样** | 需要 `composeSampleBase` 在特定时机抛错（例如 canvas 分配失败）。我没有注入该失败，只有代码路径推理。**SUSPECTED** |
| U6 | **`resolveOcclusionPlan`（`capture-document.js:977-980`）在生产里没有任何调用者** | 它和 `capture.js` 的两条路径（`annotationsForMask` / `annotationsForSampling`）**各自独立**构建 plan，三处没有共享代码。这正是 F1/F2 能存在的结构原因：主进程有一份"权威" plan，但渲染层两条隐私路径都不调它。建议后续强制渲染层走这一个入口 |
| U7 | **`compose` 与 `mask` 同时为 true 的路径** | `exportSelectionCanvasForAction` 允许 `{compose:true, mask:true}`（`capture.js:2773`），但**没有任何生产调用点**这样用。我先遮罩再套外框，理论上安全（外框画在遮罩之外），但没有测试钉住这个顺序 |
| U8 | **`hasOccludableBlur` 的 `annotationsForMask(rect)` 会抛错时** | `catch → return true`（fail-closed，正确）。但 `applyRecognitionOcclusion` 里同一调用**再次**执行，第二次可能抛到外层 `try` 之外——`exportSelectionCanvasForAction` 没有包 `try`。若它抛错，`performAction` 的 `catch(error){alert(...)}` 会捕获，不会发出未遮罩像素。**推理上安全，未实测** |
| U9 | **E（录屏裁剪/导出）的取消仲裁与发布协议** | 完全未看。不在本次隐私评审范围内，但交接文档 §7.1 把它列为第 3 优先 |
| U10 | **`.tmp-priv/` 清理** | 按要求保留供 Lead 复核（已 gitignore，`git status` 不受影响） |

---

## 7. 附：本报告发现的边界

- **未做**：混合 DPI 实机矩阵、屏幕拔插、真实模型端到端。
- F2 的端到端像素证据在 `zoom < 1` 时取得（`probe9`/`probe10`）；`zoom == 1 && crop origin == 0
  && offset == (0,0)` 这一"完全恒等"的组合我未能单独构造，见 U2。
- F6/F9 只有纯函数层证据，分别标为 CONFIRMED(key collision) / SUSPECTED(trigger)，见 U4/U5。
- 全量门禁：1790/1791，唯一失败 `translation-proxy-service.test.js` 单独复跑 23/23 通过，
  判定为环境 flake，与本次评审区域无关。`test/clipboard-coordination.test.js` 的 lease flake
  本轮未出现。
- Lead 修复 F4 后的全量是 1813/1813（修复新增了回归测试），我未复跑该版本。
