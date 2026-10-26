# Feature C 交接记录：截图成品预设与文档 schema v2

> 对应文档：`docs/plans/2026-10-25-snow-apps-feature-development-plan.md` §6（C1–C3）、§3、§10.3、§11.2。
> 本文只记录**实际做到并实际跑过**的内容。未执行项一律标「未验证」，不以测试文件存在代替通过记录。

- 状态：C1–C3 已实现并有自动化测试；**真机观感、性能样本、CI/安装包三账未验证**。
- 未创建 git 提交（按 §11.1，由 Lead 统一处理）。
- schema 最终落到 **v3**（C 交付 v2，D 在同一批把 `magnifier` 加进白名单升到 v3）；v2 的所有约束仍然成立，只是版本号不是终点。

---

## 1. 最终范围

| 子阶段 | 交付内容 | 状态 |
|---|---|---|
| C1 | `outputStyle` 进入文档内容字段与内容指纹；`1 → 2` 迁移（补禁用态默认参数）；提交时结果尺寸按 `resolveOutputGeometry()` 校验；v1 打开不变脏 | 完成 |
| C2 | 共享成品合成（圆角/背景/阴影/边框/留白）、三预设、预览与导出共用同一实现、滑块手势一步撤销、恢复原图可撤销 | 完成 |
| C3 | 复制/保存/贴图/PDF/历史结果图全部复用同一冻结内容与结果；重开保留样式；不累计叠加外框 | 完成 |

编排决定（plan 未指定落点，实施时确定）：

- **共享契约拆成三个模块而不是塞进 `capture-document.js`**：`shared/capture-output-style.js`（默认值/校验/
  几何）、`capture/output-compositor.js`（浏览器合成）分别负责"能算什么"与"怎么画"，而
  `capture-document.js` 只负责"文档里存什么、指纹怎么算"。原因是主进程的提交校验需要几何但不需要 canvas，
  反过来渲染层需要 canvas 但不该重算几何。
- **渲染层面板逻辑独立成 `capture/output-style-panel.js`**（约 545 行）：`capture.js` 已经 3400+ 行，
  把"12 个控件 + 手势合并 + 撤销帧"塞进去会让它无法被单独测试，也会让 `updateFloatingUi()` 的
  既有顺序断言更脆。
- **`documentResultBuffer()` 只从底图 + 标注重建内容层**，全程不读上一版 result PNG（见 §5 第 3 条），
  这是"重开/反复保存/贴图再编辑不累计叠加外框"的实现基础。

---

## 2. 文件与接口变化

### 2.1 新增文件

| 文件 | 责任 | 归属 |
|---|---|---|
| `shared/capture-output-style.js` | `LIMITS`、`DEFAULT_OUTPUT_STYLE`、`OUTPUT_STYLE_PRESETS`（`original`/`card-light`/`card-dark`）、`normalizeOutputStyle`、`validateOutputStyle`、`isOutputStyleEnabled`、`presetStyle`、`shadowExtents`、`planOutputComposite`、`geometryFromPlan`、`resolveOutputGeometry`、`assertOutputBudget`、`rgba`、`outputStyleEquals` | Lead |
| `capture/output-compositor.js` | `composeOutputCanvas({contentCanvas, outputStyle, createCanvas?, plan?, scale?})` → canvas 或 **null**（原图模式）；`composeOutputGeometry`；`roundedRectPath` | Lead |
| `capture/output-style-panel.js` | 成品面板 UI 控制器（预设切换、滑块 coalesce、撤销帧回调、文档回显/预设反推） | dev-c-capture-ui |
| `capture/icons/output-style.svg` | 主行 toggle 图标（16×16，stroke 1px round cap） | dev-c-capture-ui |
| `test/capture-output-style.test.js` | **27 例**：三预设、原图等价、几何统一、预算、合成调用顺序、校验/归一化、指纹、迁移链 | Lead |
| `test/capture-output-style-ui.test.js` | **29 例**：面板状态机、滑块一步撤销、恢复原图可撤销、原图模式导出尺寸、识别入口不带成品效果、重开不叠加外框、设置字段校验 | dev-c-capture-ui |

### 2.2 修改文件

| 文件 | 变化 |
|---|---|
| `shared/capture-document.js` | `SCHEMA_VERSION` 1→**3**；`outputStyle` 进 `DOCUMENT_FIELDS` **与** `CONTENT_FIELDS`；`MIGRATIONS[1]`（v1→v2 补禁用样式）、`MIGRATIONS[2]`（v2→v3 只改版本号）；`validateDocument` 要求 v2+ 必须带 `outputStyle`；新增 `resolveOutputGeometry`/`resolveOutputPlan`/`STORAGE_FORMAT_EDITABLE`；`migrateDocument` 区分"无迁移路径"与"已知版本但内容非法" |
| `main/services/capture-document-service.js` | 提交校验从"结果尺寸 == crop"改为"结果尺寸 == `resolveOutputGeometry(document)`"（原图模式下等价于 crop，所以 v1 语义逐像素不变）；失败回执新增 `crop` 与 `outputStyleEnabled` 诊断字段 |
| `main/services/settings-defaults.js` | `screenshot.outputStylePreset: 'original'`（**只存预设 id，不存整套参数**） |
| `main/services/settings-normalize.js` | `normalizeOutputStylePreset()`：读路径非法值回落 `'original'` |
| `preload-capture.js` | `saveOutputStylePreset(presetId)`（复用 `settings:update`，无新通道） |
| `capture/capture.html` | 成品面板 + 主行 toggle；4 个新 `<script>`（见 §3） |
| `capture/capture.css` | `.output-style-*` 面板样式与预览棋盘格底 |
| `capture/capture.js` | 成品状态、`composeFinishedOutput`、预览渲染、撤销帧与标注栈同 index、`buildDocumentSnapshot` 带 `outputStyle`、`documentResultBuffer`/`exportSelectionCanvasForAction` 接线 |
| `shared/locales/capture.js` | +20 键 × 三语（`capture.output.*`） |
| `test/capture-i18n.test.js` | 接入 `output-style-panel.js` 的 `LOCALE_KEYS` + 20 条 GOLDEN |
| `test/capture-toolbar-icons.test.js` | 有序图标表加 `output-style` |
| `test/capture-annotation-geometry.test.js` | 脚本顺序的魔数窗口换成顺序断言（见 §6） |
| `test/capture-tool-options.test.js` | 同上（`updateFloatingUi` 的 `{0,1400}` 窗口） |
| `test/settings-normalize.test.js` | +1 例 preset 回落 |

### 2.3 契约（plan §6.2 落地形态）

```ts
// 文档内容字段（进 CONTENT_FIELDS，参与内容指纹）
outputStyle: {
  enabled: boolean,
  paddingPx: number,                 // 0..512，整数
  background: { color: '#rrggbb', alpha: 0..1 },
  cornerRadiusPx: number,            // 0..512，整数
  border: { widthPx: 0..64, color: '#rrggbb' },
  shadow: { enabled: boolean, blurPx: 0..256, offsetXPx: -256..256,
            offsetYPx: -256..256, color: '#rrggbb', alpha: 0..1 }
}
// 所有长度都是源像素；presetId 不在文档里（§6.2 "presetId 只是 UI 偏好"）。
```

```ts
// 唯一几何入口（渲染层预览、渲染层导出、主进程提交校验三处共用）
planOutputComposite({ crop | contentWidth/contentHeight, outputStyle }) → {
  enabled, width, height, contentWidth, contentHeight,
  contentOffsetX, contentOffsetY,
  card:   { x, y, width, height, radius },
  content:{ x, y, width, height, radius },
  shadow: { blurPx, offsetXPx, offsetYPx, color, alpha } | null,
  background: { color, alpha },
  border: { widthPx, color } | null
}
resolveOutputGeometry(sameInput) → { width, height, contentOffsetX, contentOffsetY }
```

**几何规则（§6.2）**：

- `outputX = sourceX - crop.x + contentOffsetX`，Y 同理。
- 外框留白**不**反写进 crop；底图尺寸**不**改成成品尺寸。
- 阴影外扩 = `ceil(blurPx × 1.5)`（`SHADOW_BLEED_FACTOR`，覆盖 3σ，不用无限外扩假设），
  每边再叠加该方向的偏移量。
- 圆角是**同心**的：`card.radius = cornerRadiusPx + paddingPx`，两端都夹到短边一半。
- **原图模式（`enabled === false`）几何与 v1 逐像素相同**：宽高 = crop 整数宽高、offset 恒 0，
  其它参数完全不参与。这是 v1 提交校验继续成立的前提。

**预算（§3.3）**：`MAX_OUTPUT_EDGE_PX = 16384`、`MAX_OUTPUT_PIXELS = 80_000_000`，
在**分配画布之前**检查；超限抛 `code: 'output-too-large'`，不静默缩小。

---

## 3. 渲染层加载顺序（C + D 合并后的最终形态）

`capture/capture.html` 的顺序（`test/capture-script-loading.test.js` 逐条钉住）：

```
../shared/capture-output-style.js
../shared/magnifier-geometry.js          ← D
../shared/occlusion-mask.js              ← D / R0.4
../shared/capture-document.js            ← 加载期 consumes 上三者
output-compositor.js                     ← C
magnifier-sampler.js                     ← D2
../shared/cursor-geometry.js
export-result-bar.js
output-style-panel.js                    ← C
capture.js
```

**为什么顺序是硬约束**：`shared/capture-document.js` 在**加载期**就 require/读取三个 shared 模块，
缺一个会直接抛 `capture-document requires shared/capture-output-style.js`，随后 `capture.js` 因为
顶层缓存了 `window.captureDocument` 而抛 `Cannot read properties of undefined (reading 'fitViewport')`
—— 整个截图窗口起不来。这个失败模式在 2026-10-25 的真实 Electron 探针里实际发生过一次。

---

## 4. 测试命令与结果

### 4.1 全量门禁（本机实测，2026-10-25）

```
env -u ELECTRON_RUN_AS_NODE npm test
  ℹ tests 1774   ℹ pass 1772   ℹ fail 2
    ✖ test/capture-script-loading.test.js  ← D3 接线未完成（预期红→绿），归 task-3
    ✖ test/clipboard-coordination.test.js  ← 已知 lease flake
       单独复跑 2 次均 4/4 pass（按根 AGENTS 判定为 flake，非本轮 diff 引入）

npm run check  →  exit 0
  Syntax check passed for 440 JavaScript files
  architecture-check: ok (main.js 1323 lines, ceiling 1330, domains 10)
  i18n: symmetric diff ok / key shape ok / capture 222 = 基线 / TOTAL 592 ≤ 606
```

### 4.2 C 专项

```
env -u ELECTRON_RUN_AS_NODE node --test test/capture-output-style.test.js        → 27/27 pass
env -u ELECTRON_RUN_AS_NODE node --test test/capture-output-style-ui.test.js     → 29/29 pass
env -u ELECTRON_RUN_AS_NODE node --test test/capture-document.test.js \
                                        test/capture-document-service.test.js    → 40/40 pass
env -u ELECTRON_RUN_AS_NODE node --test test/capture-document-editor-runtime.test.js → pass（真 Electron 探针）
env -u ELECTRON_RUN_AS_NODE node --test test/capture-renderer-runtime.test.js        → pass（真 Electron 探针）
```

新增 C 相关用例合计 **56 例**（27 契约 + 29 UI），另加 1 例 settings normalize。

---

## 5. 实现期发现并修复的真实缺陷

1. **`<label data-i18n>` 包住子元素会被 `applyTranslations()` 的 `textContent` 抹掉**。
   面板最初把 checkbox + span 塞进带 `data-i18n` 的 `<label>`，翻译执行后 `<input>` 与 `<span>` 直接消失，
   `data-i18n` 标记数从 57 掉到 56。**只有真实 Electron 探针能发现**，纯静态测试看不见。
   已拆成并列的 `<label for>` + `<label class="…checkbox">`。
2. **`updateFloatingUi()` 的 4 个 early return 没有关闭成品面板**。
   OCR 覆盖层 / 自动选区 / 拖动中，面板会继续浮在屏幕上。已把 `syncOutputStyleUi()` 提到第一个
   early return 之前。
3. **原图模式下把滑块设成 `disabled` 导致用户无法从"原图"微调**。
   已改为"第一次动滑块自动 `enabled: true`"，且与参数变更在**同一个 patch** 里 —— 一次输入 = 一帧，
   undo 一步回到原图。

另外两条**几何级**的缺陷在 Lead 侧发现并修复：

4. **`clampRound(value, min, max)` 用 `minimum` 当缺失值回落**。阴影偏移的范围是 `[-256, 256]`，
   于是"未提供 offset"被静默变成 **-256px** 的硬偏移。已把 `fallback` 拆成独立参数并默认 0
   （`test/capture-output-style.test.js` 的归一化用例钉住）。
5. **`planOutputComposite` 只认 `contentWidth/contentHeight`**，传 `{width, height}` 时静默退化成 1×1。
   已接受三种等价入参（`crop` / `contentWidth+contentHeight` / `width+height`）。

---

## 6. 对既有测试的两处改动（不是放宽断言）

两处都是**把魔数窗口换成它本意想表达的顺序契约**：

| 文件 | 原写法 | 现写法 | 理由 |
|---|---|---|---|
| `test/capture-annotation-geometry.test.js` | `annotation-geometry.js[\s\S]{0,600}?capture.js` | helpers → 每个 shared 依赖 → 控制器 的逐项顺序断言 | 插入 4 个 shared `<script>` + 2 个本地 `<script>` 后实际距离变成 1837 字符，`{0,600}` 必然假红 |
| `test/capture-tool-options.test.js` | `updateFloatingUi(){[\s\S]{0,1400}?toolbarPlacement()` | slice 函数体到 `positionOcrResultBar()` 之间再找锚点 | 新代码插了约 1800 字符，1400 窗口只剩 7 字符余量 |

**两处的语义都比原来更强**：原来只要求"两个字符串相距不超过 N 字符"（任何插入都会破坏，任何删除都可能悄悄放宽），现在要求"X 出现在 Y 的函数体里"。

---

## 7. 已知限制与未验证项（**真实缺口，不得在发布说明里表述为已验证**）

1. **真机观感未验证**：阴影/圆角/半透明背景在真实光栅下的效果、预览与导出在 4K 图/极小图上的
   视觉一致性、DPI 切换表现。自动化只证明了几何与调用序列。
2. **性能未采样**：4K 图 + 深色卡片（阴影 bleed 48px）时预览重绘耗时、导出耗时，**无 p50/p95 样本**。
3. **`capture-renderer-runtime` 探针未覆盖新面板的 canvas 预览绘制**：面板的 DOM 半部由假 document
   驱动（29 例里的 2 例），真实 Chromium 下 `composeOutputCanvas` → 预览 canvas 的路径未验证。
4. **手调参数不跨截图记忆**（有意取舍）：只有预设选择持久化到 `screenshot.outputStylePreset`；
   留白/背景/圆角/边框/阴影参数属于当前文档（写进文档 `outputStyle`，随历史保留）。
   理由：plan §6.2 明确 presetId 只是 UI 偏好、产物由完整解析参数决定；把整套参数放进设置会
   让"上次调好的卡片"污染每一张新截图。
5. **CI / 安装包 / 实机三账未验证**（按 §10.3 分别记账）。本地通过 ≠ CI 通过 ≠ 安装包通过 ≠ 实机通过。
6. **旧客户端打开 v3 文档**：按 §6.3/§7.3 应"显式降为结果图访问，不能静默抹掉效果"。
   当前 `parseDocument` 对未知版本返回 `unsupported-schema` → 服务层走"仅位图恢复"，
   路径存在；但**没有用真实旧版本客户端验证过**这条降级链路的用户可见提示。

---

## 8. 下一步

- D 的 R0.4（识别遮挡）与 D3/D4（放大镜）在同批次交付，见 `docs/plans/2026-10-25-feature-D-handoff.md`。
- 真机矩阵（副屏 / 混合 DPI / 硬件与软件光栅）需要真实桌面会话，本批未执行。
- 性能样本需按 §10.2 的口径（固定机器、屏幕、样本数、p50/p95）单独采集，本批未采集。
