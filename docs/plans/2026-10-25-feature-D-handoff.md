# Feature D 交接记录：局部放大镜与 schema v3（含 R0.4 识别隐私遮罩）

> 对应文档：`docs/plans/2026-10-25-snow-apps-feature-development-plan.md` §7（D1–D4）、§2 R0.4、§3、§10.3、§11.2。
> 本文只记录**实际做到并实际跑过**的内容。未执行项一律标「未验证」，不以测试文件存在代替通过记录。

- 状态：R0.4 与 D1–D4 已实现并有自动化测试（含两条真实 Electron 逐像素探针）；**真实模型端到端、混合 DPI、性能样本、CI/安装包/实机三账未验证**。
- 未创建 git 提交（按 §11.1，由 Lead 统一处理）。

---

## 0. R0.4 —— 为什么它先于 D 交付

`plan §2 R0.4` 把识别遮罩登记为**独立 P0**，且是 D 开始的硬前置。核对结论（R0 基线已记录）：所有识别入口（OCR / 翻译 / 表格 / QR / 转文档）直接消费渲染层像素，**没有 blur 遮罩合成**。这不是"放大镜的附赠行为"，是一个已经存在的隐私缺口。

本批先修 R0.4，再做放大镜，理由：放大镜是**唯一会从图像其它位置读取像素的标注**，如果它建立在"识别路径没有遮罩"的基础上，就会把"新功能暴露未遮挡底图"变成必然。

---

## 1. 最终范围

| 子阶段 | 交付内容 | 状态 |
|---|---|---|
| R0.4 | 识别入口专用遮罩合成：crop 底图 + 全部现存 blur 的不透明遮罩，**在任何缩放之前**施加；fail-closed | 完成（含真机逐像素探针） |
| D1 | schema v3、`magnifier` 对象模型、嵌套坐标投影、对象预算、裁剪相交规则、`2 → 3` 迁移 | 完成 |
| D2 | 采样底图（底图 + blur 遮罩，不含放大镜/普通标注/成品外框）、32 MiB 字节预算缓存、失效规则 | 完成 |
| D3 | 工具交互：框选源区 → 放镜头、镜头/源区分别拖动、倍率 2×/3×/4×、边框宽度、引线开关、手势一步撤销、上限提示 | 完成 |
| D4 | 文档保存、复制/保存/贴图/PDF/历史结果图一致、重开可编辑、跨 DPI 编辑 | 完成（真机全链路探针见 §5） |

---

## 2. 文件与接口变化

### 2.1 新增文件

| 文件 | 责任 | 归属 |
|---|---|---|
| `shared/magnifier-geometry.js` | `FACTORS=[2,3,4]`、`MAX_PER_DOCUMENT=8`、`normalizeMagnifier`、`validateMagnifier`、`lensRect`（**推导值，永不落盘**）、`lensCenter`、`sourceCenter`、`withFactor`、`translateLens`、`translateSource`、`translateMagnifier`、`magnifierBounds`、`clipToCrop`、`clipAllToCrop`、`sampleCacheKey`、`hitTestMagnifier`、`createFromSourceRect`、`quantizeLength` | Lead |
| `shared/occlusion-mask.js` | `buildOccluders`、`occluderBounds`、`maskFingerprint`、`planOcclusion`、`buildOcclusionPlan`、`brushStrokeWidth`、`CONSERVATIVE_MARGIN_PX=2`、`MASK_COLOR`、`MASK_ALPHA=1` | Lead |
| `capture/magnifier-sampler.js` | `composeSampleBase`、`paintOcclusion`、`sampleMagnifier`、`createSampleCache`（32 MiB LRU）、`createLensSampler`、`canvasBytes` | Lead |
| `test/magnifier-geometry.test.js` | **36 例**：倍率/源区拒绝、镜头尺寸推导、裁剪相交、缓存键、视口往返精度、对象预算 | Lead |
| `test/magnifier-sampler.test.js` | **15 例**：遮罩在缩放前、缓存失效规则、字节预算、LRU、释放 | Lead |
| `test/occlusion-recognition-wiring.test.js` | **11 例**：识别路径调遮罩、普通导出不遮、三开关独立、显示态不解除保护 | dev-c-capture-ui |
| `test/occlusion-recognition-runtime.test.js` | **1 例（真实 Electron 逐像素）** | dev-c-capture-ui |
| `test/capture-magnifier-ui.test.js` | **20 例**：工具交互、三分支拖动、撤销帧、上限、回显 | dev-c-capture-ui |
| `capture/icons/magnifier.svg` | 16×16 工具图标 | dev-c-capture-ui |

### 2.2 修改文件

| 文件 | 变化 |
|---|---|
| `shared/capture-document.js` | `SCHEMA_VERSION` 2→**3**；`ANNOTATION_TYPES` 加 `magnifier`；`MAX_MAGNIFIERS=8`；`normalizeAnnotation` 对 magnifier 走独立嵌套归一化（不吃扁平 `x/y/x2/y2`）；`validateDocument` 独立校验分支 + `source-outside-crop` + `too-many-magnifiers`；`MIGRATIONS[2]`（v2→v3 只改版本号）；`annotationsToViewport`/`annotationsFromViewport` 增加嵌套矩形投影（严格互逆）；新增 `resolveOcclusionPlan`、`resolveMagnifiers`、`clipMagnifiersToCrop` |
| `capture/annotation-geometry.js` | `annotationBounds` / `hitTestAnnotation` / `translateAnnotation` / `resizeAnnotationToBox` 全部委托 magnifier；导出 `annotationGeometry.magnifier` |
| `capture/capture.js` | R0.4 遮罩（`applyRecognitionOcclusion` / `annotationsForMask` / `transformOccluder` / `paintOcclusionPlan`）+ 三开关；D3 手势/绘制/采样缓存/上限/载入裁剪；`annotationWasMoved` 支持嵌套几何 |
| `capture/capture.html` / `capture.css` | `data-tool="magnifier"`；`#magnifierPanel`（倍率/边框/引线）；加载 5 个新脚本（顺序见 §3） |
| `shared/locales/capture.js` | +8 键 × 三语 |
| `shared/editor-layout.js` | `ROW_MIN_CONTENT` 1040 → **1064**（见 §6） |
| `test/editor-layout.test.js` | 同步 1064，并新增"标准窗口必须预留单行"的推导守卫 |
| 5 个既有 capture 契约测试 | 魔数窗口换顺序断言（见 §6） |

### 2.3 对象模型（plan §7.1 落地形态）

```ts
// 持久化形态：只有这些字段，镜头尺寸永远是推导值
{
  id, type: 'magnifier',
  sourceRect: { x, y, w, h },     // 底图源像素坐标，必须在当前 crop 内
  lensOrigin: { x, y },           // 同一坐标系
  factor: 2 | 3 | 4,
  stroke: { color: '#rrggbb', widthPx: number },
  connector: 'none' | 'line'
}
// lensRect = { x: lensOrigin.x, y: lensOrigin.y,
//              w: sourceRect.w * factor, h: sourceRect.h * factor }   ← 永不落盘
```

**硬规则**：
- 倍率是**离散值**，`typeof factor !== 'number'` 或不在 `[2,3,4]` 一律 `bad-factor`（`'3'` 也拒绝）。
- **禁止持久化镜头尺寸**：`lensWidth`/`lensHeight` 是未知字段 → `unknown-field`。这条防的是"镜头尺寸与源区×倍率互相矛盾"。
- 改倍率**以镜头中心为锚点**（`withFactor`）；源区与镜头可**分别**拖动。
- 源区必须落在当前 crop 内 → `source-outside-crop`。
- 每文档最多 **8** 个 → `too-many-magnifiers`。

---

## 3. 采样与遮挡（§7.2 / §8）

### 3.1 采样底图

```
sample base = 底图 crop 区域（源像素 1:1）
            + 全部现存 blur 的不透明遮罩
            （不含放大镜、不含普通标注、不含成品外框）
```

- **不含放大镜自身**：否则镜头会递归采样自己。
- **不含普通标注**：箭头/文字/高亮不是源内容，放大它们没有意义。
- **必须先遮再缩放**：遮罩在源像素画布上施加，之后才按 `factor` 放大。反过来做会让马赛克边缘的插值过渡留在遮罩外 —— 那正是 §7.2 要防的泄漏。

### 3.2 遮罩几何

- 矩形 blur：整块矩形 + `CONSERVATIVE_MARGIN_PX = 2` 向外扩张。
- 笔刷 blur：**全宽**描边（覆盖半线宽两侧）+ `lineCap: 'round'`（端帽）+ 保守扩张。宽度公式与 `capture/annotation-style.js` 的 `blurBrushWidth` **同源**，测试直接互相比对（两处给出不同的数就会出现"屏幕上的马赛克比遮罩窄"的泄漏缝）。
- **highlight 不是遮密工具**（§8 明文），不产生遮罩。
- **显示层的透明度/橡皮擦预览不解除保护**：判据是"文档 `annotations` 里还有没有这个 `type === 'blur'` 对象"，与它现在看起来是否可见无关。

### 3.3 缓存（§7.2 / §3.3）

- 预算 **32 MiB**，**按字节**计费（`width × height × 4`），不是按条目 —— 4× 镜头在小图与大图上差三个数量级，条目数看不见这个差别。
- 键 = 底图标识 + crop + **遮罩指纹** + 源区 + 倍率。
- **刻意不含 `lensOrigin`**：移动镜头**不**重新采样底图（§7.2 明文）。
- 改源区 / 改倍率 / 改 blur / 改 crop / 换底图都必须失效。
- 单条超过总预算的项**不缓存**（它会挤掉所有其它项还放不下），但仍返回给调用方。
- 关闭编辑器 / 新一次 init / 底图变化 → `reset()` 释放。

### 3.4 识别路径的 fail-closed

`applyRecognitionOcclusion` 在 plan 计算抛错时**把整个输入涂黑**，而不是返回未遮罩图 —— 返回未遮罩会直接推翻这次修复。

---

## 4. 三个独立的像素维度（R0.4 落地形态）

`exportSelectionCanvasForAction(includeAnnotations, rect, { compose, mask })`：

| 出口 | `includeAnnotations` | `compose` | `mask` |
|---|:---:|:---:|:---:|
| OCR / 翻译 / 表格 / QR / 转文档 | `false` | `false` | **`true`** |
| 复制 / 保存 / 贴图 / PDF / 历史结果图 | `true` | `true` | `false` |

三者**互不推导**，全部默认 `false`（fail-safe）。合并成一个参数或互相推导，会让"某天有人调整识别输入"静默地同时关掉隐私保护。

---

## 5. 验证证据

### 5.1 R0.4 真机逐像素（`test/occlusion-recognition-runtime.test.js`）

真实 Electron 隐藏窗，构造渐变底 + 18 条深色横线 + 马赛克矩形内一整块纯黑"机密文字块"：

1. 识别帧马赛克区 **≥98% opaque black**；
2. **反空洞检查**：未遮罩帧里同一块确实是暗色内容 —— 否则第 1 条可能因为原图本来就黑而恒真；
3. **遮罩不外溢**：马赛克区以上整条区域，识别帧 vs 未遮罩帧**逐像素完全相同**（`outsideDiffs === 0`）；
4. **普通标注不进识别输入**：用户标注的实心矩形在 user-facing 帧有 >4000 红色像素，识别帧 **0**；
5. **成品预设不污染识别**：选中 `card-light` 后识别帧宽度仍 == 图像宽（800），user-facing 帧变 992（有留白），且遮罩**仍然** ≥98% 黑。

第 2 条和第 3 条是"断言对了但证明不了什么"与"遮对了但遮多了"的分界线，缺它们前三条都可能恒真。

### 5.2 视口往返精度（`test/magnifier-geometry.test.js`）

一个**真实缺陷**的回归：`normalizeMagnifier` 曾把 `stroke.widthPx` 四舍五入成整数**并**夹到 `MIN_STROKE_PX`。两个独立来源都会让 `annotationsToViewport → annotationsFromViewport` 丢值：

- `Math.round`：`3 × 0.5 = 1.5 → 2`，除回去 `4`（每次重开/缩放累加 1px）；
- `clamp` 到 `MIN_STROKE_PX`：`1px` 描边在 zoom 0.5 时是 `0.5` **视口**像素，被抬到 1、除回去变 `2`。

修法：`widthPx` 量化到 **1/1000**（防浮点噪声让内容指纹每次重开都判"有编辑"），**不做范围夹取** —— 范围是 `validateMagnifier` 的职责，因为 normalize 同时服务文档空间与视口空间。

验证：9 个 zoom × 7 个宽度 = **63 组合零漂移**，并额外断言视口中间值确实是 `widthPx × zoom`（防"修好往返但把中间值夹掉了"的假修复）。

### 5.3 其它纯函数证据

- `test/magnifier-geometry.test.js` 36 例：倍率离散拒绝、镜头尺寸推导、裁剪相交（**空交集是移除不是夹紧**，否则等于继续采样 crop 外内容）、缓存键失效矩阵、对象预算。
- `test/magnifier-sampler.test.js` 15 例：遮罩在 drawImage **之后**、缩放**之前**；单点笔刷仍遮一个点；LRU 顺序；超预算项不缓存；`clear()` 全释放。
- `test/occlusion-recognition-wiring.test.js` 11 例：三开关独立、显示态键（`previewOpacity: 0, erased: true`）**不改变** plan、遮罩输入不出现 `image =` 赋值。

---

## 6. 实现期发现并修复的真实缺陷

1. **`ROW_MIN_CONTENT` 1040 装不下第 12 个工具**（magnifier）。实测主行最小宽度 1044 > 1040 → 窄窗口主行折两行，而条带只预留一行 → **工具栏被推回图像内侧**（模块头注释描述的真机缺陷本身）。
   修法不是简单调大：`stripRows = ceil(ROW_MIN_CONTENT / (width - STRIP_CHROME))`，最窄标准窗口 `TOOLBAR_SPACE = 1088` 给 1074 内容像素，所以不变式是
   **`measured ≤ ROW_MIN_CONTENT ≤ TOOLBAR_SPACE - STRIP_CHROME`**（`1044 ≤ 1064 ≤ 1074`）。
   取 **1064**（20px 余量），并把 `ceil(...) === 1` 作为推导守卫写进测试 —— 只断言"等于 1064"防不了"值合法但语义坏了"。
2. **`stroke.widthPx` 的视口往返丢值**（§5.2）。
3. **`annotationWasMoved` 对嵌套对象永远判"没动"**：它比 `item.x !== origin.x`，而 magnifier 没有扁平 `x/y` → **镜头拖动永远不压撤销帧**（静默丢撤销步骤）。改为对 magnifier 比 `sourceRect.x/y` + `lensOrigin.x/y`。
4. **`clampRound` 用 `minimum` 当缺失值回落**（C 侧）：阴影偏移范围 `[-256, 256]`，"未提供 offset"被静默变成 **-256px** 硬偏移。

---

## 7. 对既有测试的改动

5 个钉 `capture.js` 源码形状的契约测试，全部是**把魔数窗口换成顺序/切片断言**（与 feature C 同一模式，修改前已与 Lead 确认）：

| 文件 | 原因 |
|---|---|
| `test/capture-annotation-geometry.test.js` | 脚本顺序 `{0,600}` 窗口必然破 |
| `test/capture-tool-options.test.js` | `updateFloatingUi` / `setTool` 的字符窗口 |
| `test/capture-floating-placement.test.js` | 1400 字符窗口被 `syncMagnifierPanel()` 顶到 1459 |
| `test/capture-interaction.test.js` | `beginPendingMove` 调用点 4→5 |
| `test/capture-toolbar-icons.test.js` / `test/capture-i18n.test.js` | 有序图标表 / GOLDEN / key 扫描同步 |

**语义都比原来更强**：原来只要求"两个字符串相距不超过 N 字符"，现在要求"X 出现在 Y 的函数体里"。

---

## 8. 已知限制与未验证项（**真实缺口，不得在发布说明里表述为已验证**）

1. **真实识别模型端到端未验证**：只验证了"送给模型的像素"（plan §8 指定的口径），没有跑真实 OCR/翻译/表格/QR 服务。
2. **混合 DPI 下的遮罩投影未验证**：探针用 `scaleFactor = 1`；视口缩放（zoom）路径已被 63 组合覆盖，但真实 DPI 矩阵（100%/150%/200%、主副屏、负坐标）未跑。
3. **D3 镜头内容的视觉正确性**：见 §5 —— 由 `test/magnifier-runtime.test.js` 覆盖（若最终未落地，此项保持"未验证"）。
4. **D4 重开全链路**：见 §5 —— 由 `test/magnifier-reedit-runtime.test.js` 覆盖（若最终未落地，此项保持"未验证"）。
5. **性能未采样**：4K 图 + 多镜头的采样/预览/导出耗时，**无 p50/p95 样本**；缓存峰值内存未实测。
6. **不新增"重新裁剪"手势**（有意）：现有编辑器没有改 crop 的入口，crop 在载入时固定。`clipMagnifiersToCrop` 只在**载入时**做一次防御（旧数据/异常文档），被移除对象落在**载入帧**、不可撤销 —— 撤销不能把越界对象变回来。新增重新裁剪是独立交互（涉及选区工具、crop 与标注坐标系、revision 语义），不在 D 范围。
7. **CI / 安装包 / 实机三账未验证**（按 §10.3 分别记账）。

---

## 9. 下一步

- F–J 批次的入口见 plan §9；G（贴图工作组）与 H（识别纠错）都受本次 schema v3 与 `resolveOcclusionPlan` 影响，需先读本文件的 §2/§3。
- 真机矩阵与性能样本需真实桌面会话，本批未执行。
- 若要新增"重新裁剪"手势，必须先定义它如何影响 `crop`、标注坐标系与历史 revision（见 §8.6）。
