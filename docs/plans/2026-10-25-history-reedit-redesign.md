# 截图「继续编辑」改造方案：从"重拍一次截图"到"打开一份文档"

> 状态：**批次 0 与批次 1 已实施**（2026-10-25）。批次 2–5 仍为方案。
> 实施记录见 `docs/plans/2026-10-25-history-reedit-batch0-contracts.md`（契约冻结 + 落地清单）。
> 基线：`66f333c`（4.1.3 之后）。证据全部指向当前 checkout 的 `file:line`。
> 修订：2026-10-25，根据方案评审补齐坐标、身份、文件职责、提交协议与数据生命周期；以下目标约束尚未实现。
> 支撑材料（只读测绘，均带行号）：
> - `.tmp/analysis/01-current-capture-editor.md` —— 编辑器现状（标注/裁剪/撤销/擦除/保存/大图）
> - `.tmp/analysis/02-history-reedit-flow.md` —— 历史继续编辑链路现状
> - `.tmp/analysis/03-snow-shot-reference.md` —— snow-shot / snow_apps 对标
> - `.tmp/analysis/04-performance-baseline.md` —— 大图与识别性能实测
>
> 口径：**实测**=本次跑出的数字；**代码可证**=只读代码即可确定；**推断**=有依据但未真机验证。
> 凡"需真机"的结论本文一律标注，不当作已验证。
> `.tmp/analysis/` 是临时测绘材料，不作为发布验收的唯一证据。实施前将要引用的基准脚本、脱敏样本说明与结果摘要整理到 `docs/performance/`，保留采样条件；本次修订没有重跑这些基准。

---

## 0. 结论摘要

**用户感到"不顺畅"，不是因为缺功能，而是因为"编辑"这个动作在架构上被实现成了"重拍一次截图"。**

`main.js:1123-1127` 的 `editItem` 把一个历史条目读成 PNG Buffer，然后调用 `createCaptureWindow({ imageBuffer, mode:'image', source:'history' })` —— 不带历史 id、不带原始标注、不带几何。于是一次"打开记录"退化成了"另起一次区域截图"：窗口变成整屏置顶（`main/domains/capture/index.js:304-307`、`:379-383`）、抢焦点（`:273-284`）、图片被拉伸铺满还像素化（`capture/capture.js:363-370`、`:385-388`）；保存必然新增一条记录而不是更新（`main/services/history-service.js:284-313` 只有 create，没有 update）；关窗后焦点不回来（`capture/index.js:396-397` 只还原 pin），列表整页重建并退回第一页（`config/routes/history.js:18`、`:43-47`）。

真正的缺口只有一个，但它同时决定了下游所有症状：**历史里没有"可再编辑的文档"，只有一张扁平 PNG**（`history-service.js:302-311` 的条目字段里没有任何标注/文档字段）。由此派生：

| 症状 | 直接原因 | 结构性原因 |
|---|---|---|
| 编辑后原图没变、上面多一条 | 保存只能 create（无 update API） | 没有"记录身份" |
| 想改一个箭头只能重画 | 标注是烤进 PNG 的像素 | 没有可编辑文档 |
| 点编辑屏幕突然全屏变黑放大 | 未传 `windowBounds`/`imageBounds` | 入口参数走错分支 |
| 重划选区后 Ctrl+Z 标注错位 | 撤销栈只覆盖 `annotations`，不覆盖 `selection` | 文档模型缺"裁剪/视口"维度 |
| 大图越画越卡 | 每帧整帧重绘 + 撤销栈全量深拷贝 | 无脏区、无结构共享 |

**本方案的核心主张**：不引入新框架、不重写渲染栈、不换撤销模型。把"编辑器状态"从「`annotations` 一个数组」升格为「**doc = {底图 + 标注 + 裁剪/视口 + 版本身份}**」，并让撤销栈、持久化、导出、窗口形态全部围绕这个 doc 重建。这是 snow-shot 与 snow_apps 两个参考实现共同的选择，也是它们唯一真正值得移植的那一层。

**实施顺序**：先完成批次 0 的契约与失败用例设计（1–2 人日），再完成首个可发布闭环（批次 1，6–8 人日），不能把"写一份标注 JSON"单独视为改造完成：

1. `documentId` 标识列表卡片，`revisionId` 标识不可变版本；更新与另存使用不同文档身份。
2. 文档统一使用底图像素坐标；裁剪只改 `crop`，窗口、DPI、缩放和平移只改视口映射。
3. 底图、文档、结果图、缩略图各司其职；打开、复制、地址、导出统一取已提交结果图。
4. 首次截图与继续编辑共用可确认、可重试的提交协议；提交成功后再清除 dirty、刷新列表或关闭。
5. 首批同时完成删除、清理、保留策略与数据目录迁移，确保重开和迁移后仍可编辑。

**兼容边界**：现有扁平 PNG 无法还原为原来的矢量标注。存量记录保留既有像素，可在其上新增可编辑对象；只有新文档保存的对象才能恢复选中、改样式或移动。详见 §6.7。

---

## 1. 现状：一次"编辑历史"的完整时序（可引用证据链）

| # | 位置 | 行为 |
|---|---|---|
| 1 | `config/routes/history.js:165` | 卡片渲染 `<button data-history-action="edit">`；`longCapture` 项**不渲染**该按钮，且无解释 |
| 2 | `config/routes/history.js:143` | `await window.electronAPI.editHistory(id)` —— **无 try/catch、无 loading、无 disable**（对比同函数 `open`/`copy` 分支都包了 try/catch） |
| 3 | `preload.js:39` | `editHistory: (id) => ipcRenderer.invoke('history:edit', id)` |
| 4 | `main/ipc/history-ipc.js:150-153` | `getItem(id)` → `editItem(item)`，否则 `false` |
| 5 | `main.js:1123-1127` | `readFile(item.filePath)` → `createCaptureWindow({ imageBuffer, mode:'image', source:'history' })` → **无条件 `return true`** |
| 6 | `main/domains/capture/index.js:304-307` | `windowBounds` 缺失 → `captureBounds = display.bounds`（**整屏**） |
| 7 | `main/domains/capture/index.js:341` | 若已有截图窗口，先 `close()` 掉它 |
| 8 | `main/domains/capture/index.js:344-367` | 新 `BrowserWindow`：`frame:false`、`alwaysOnTop:true`、`skipTaskbar:true`、`opacity:0` |
| 9 | `main/domains/capture/index.js:379-383` | `setAlwaysOnTop(true,'screen-saver')` + `setBounds(整屏)` |
| 10 | `main/domains/capture/index.js:419-455` | `_captureInit`：`imageBuffer / mode / source / displayBounds / captureBounds / scaleFactor / saveMode:'' / settings` —— **无 historyId、无 annotations、无 imageBounds** |
| 11 | `main/domains/capture/index.js:273-284` | `showInactive()` 后 `setImmediate(() => win.focus())` —— **抢焦点** |
| 12 | `capture/capture.js:2652-2670` | `onInit` → `resetAnnotationState()`（`:2656`）→ 标注清空 → `image.src = blob(...)` |
| 13 | `capture/capture.js:275-280` | `imageDisplayBounds()` 无 `imageBounds` → 退化成 `{0,0,innerWidth,innerHeight}` |
| 14 | `capture/capture.js:398-400` | `resizeCanvas()` 把 `selection` 直接设为整个窗口 |
| 15 | `capture/capture.js:363-370` + `capture.css:26` | 背景按 `naturalWidth/Height` 建画布，再被 CSS 拉到窗口尺寸 + `image-rendering: pixelated` → **拉伸且像素化** |

**这一跳丢了什么**：历史 `id`、原始标注、原始尺寸/缩放、原始 `source` 语义（被覆写为 `'history'`）、`saveMode`（回落设置项，默认 `false` → **每次保存都弹原生对话框**，`image-file-save.js:108-159`）。

---

## 2. 现状 vs 目标体验

### 2.1 逐维度对比

| 维度 | 现状（可证） | 目标体验 | 差距性质 |
|---|---|---|---|
| **进入编辑** | 整屏置顶窗口 + 抢焦点 + 图片拉伸像素化（§1-6~15） | 紧凑编辑器，图片按原始比例居中，保留底部工具条空间；config 窗口留在后方不隐藏 | **参数走错分支**（pin 域已做对，见 §3.2） |
| **标注** | 11 个工具（`capture.html:23-33`），但无裁剪；编辑既有图片时旧标注是像素 | 打开即恢复为**可选中、可改样式、可拖动**的矢量对象 | **数据模型缺失** |
| **裁剪** | 不存在。唯一替代是"重划选区"，而它会**丢弃全部标注**并弹确认（`capture.js:2133-2136`、`:1535-1544`） | 独立裁剪模式；确认只改变底图坐标中的 `crop`，标注坐标不变，通过视口与导出变换正确显示；可再裁、可撤销 | **功能缺失 + 模型缺失** |
| **撤销/重做** | 覆盖 `annotations` 的 60 帧全量深拷贝（`capture.js:1465-1470`、`annotation-geometry.js:20`）；**选区/裁剪/图片替换/样式默认值/OCR 结果都不在栈内**（`capture.js:1479-1489` 不碰 `selection`） | 撤销覆盖"所有改变最终产物的操作"，包括裁剪；粒度符合直觉（一次手势一步）；大点集下不爆内存 | **模型缺失 + 实现缺陷** |
| **智能擦除** | `blur` 是**马赛克笔刷涂抹**，只画标注层、源图只读（`capture.js:581-655`）；无对象级橡皮擦；且**打码对识别链路不生效**（`capture.js:2489-2492` 走未遮罩原图） | ①对象级橡皮擦与可逆效果预览②识别链路对 blur 覆盖区使用不透明隐私遮罩③（可选，独立立项）内容感知擦除 | **功能缺失 + 隐私缺陷** |
| **保存** | 只能**新增**一条（`history-service.js:284-313` 无 update API），原记录原样留着 → 历史里视觉重复；默认弹对话框；编辑入口忽略真实返回值（`main.js:1126`） | 默认"**更新此记录**"（同 `documentId`、新 `revisionId`）；另存生成新文档；提交失败保留现场，外部文件导出单独报告结果 | **数据模型缺失 + 提交协议缺失** |
| **回到列表** | `history:changed` 触发整页重建（`config/config.js:114` → `history.js:18`），**分页退回第一页**、缩略图缓存（局部 Map，`:47`）丢弃、滚动位置不恢复 | 增量刷新受影响条目；保持滚动位置与已加载页数；原条目显示"N 个版本"角标 | **交互连续性缺失** |
| **大图** | 无缩放/平移（`capture/` 内 `setTransform` 仅 2 处坐标变换）；每帧全量重绘全部标注（`capture.js:727-751`）；编辑器内**无 canvas 尺寸护栏** | 视口缩放/平移；脏区重绘；打开 4K 图首帧 ≤300ms、编辑帧 p95 ≤16.7ms | **能力缺失 + 性能** |
| **识别速度** | 送侧车的是**全像素原图**（`capture.js:2492`→`:2495`→`:2526`），写临时 PNG 再读（`ocr-service.js:261-263`）；冷启动 median 207ms、每 300s 空闲重付（`settings-defaults.js:87`）；**无取消通道**（`ocr-service.js:205-223` 只有 120s 超时） | 送识别前按目标长边预缩放；侧车常驻；可取消；结果回填不阻塞 | **链路低效** |

### 2.2 "不顺畅"的量化感受

现状一次完整"继续编辑"要求用户付出 **7 个动作**，其中 3 个是纯摩擦：

```
找到那条记录 → 点「编辑」→ [摩擦1: 屏幕全屏突变+图片拉伸] → 重画（无法改旧标注）
→ [摩擦2: 保存弹对话框] → 关窗 → [摩擦3: 焦点没回来 + 列表退回第一页，重新找那条]
```

目标状态是 **4 个动作、0 摩擦**：

```
双击那一条 → 就地编辑（文档对象可改、可裁剪、可撤销）→ 保存并返回（默认更新这条）→ 原列表位置（该条变新）
```

---

## 3. 根因分析

### 3.1 根因一：入口语义错位 —— "编辑"被实现成"重拍"

`editItem` 只传 3 个字段（`main.js:1125`），而 `createCaptureWindow` 的 `windowBounds`/`imageBounds`/`transparent`/`sourceScaleFactor` 全部缺省，于是走进"区域截图"的默认参数路径。**这不是能力问题**——见 §3.2。

### 3.2 关键对照：同一件事，pin 域已经做对过一次

| 维度 | pin 重标注（先例） | history 继续编辑（现状） |
|---|---|---|
| 调用点 | `main/domains/pin/index.js:566-590` | `main.js:1125` |
| `windowBounds` | 算好的紧凑编辑器框（`pin/index.js:513-562`，**把工具条高度算出来预留**） | 不传 → 整屏 |
| `imageBounds` | 传（`:578`），图片按 `scale` 缩放居中（`:546-568`） | 不传 → 退化成视口 |
| `transparent` | `true`（`:581`，为工具条留白） | 默认不透明黑底 |
| `sourceScaleFactor` | 传（`:569`、`:582`） | 不传 |
| 被编辑窗口 | 先 `win.hide()`（`:570`），关闭时 `bringPinToFront` 还原（`:586`、`:589`） | 不隐藏、不还原焦点 |
| 回写 | `pinFromCapture` 命中 `editingPinWindow` 时**原地 update**（`:594-607`） | 无任何回写路径 |

**结论：`history` 没有复用一条已经存在、已经验证过的路径。** 这是本方案中性价比最高的一处修改。

### 3.3 根因二：没有"记录身份"，因此没有覆盖、没有版本、没有回路

`snow-shot` 与 `snow_apps` 都是 append-only（都把"再编辑后保存"实现成新记录），说明 append-only 本身不是错。Highlighter 缺少稳定的文档身份与独立的版本身份，无法表达"同一条记录的新版本"。只加 `parentId` 仍不足以区分版本前驱与另存来源；本方案固定采用 §6.5.1 的身份模型。

- `persistImageBuffer` 每次都 `createId()` + 新 `historyImagePath()`（`history-service.js:284-285`）
- 条目字段只有 `{id, filePath, thumbnailPath, createdAt, source, action, width, height}`（`:302-311`）
- `HistoryService` 类方法全表**无 update / replace / rename / touch**（`:88-521`）
- 写入是**前插**（`storeItem`，`:262-266`），`list()` 不排序（`:344-361`）

### 3.4 根因三：标注以扁平 PNG 落盘，物理上不可再编辑

`exportSelectionCanvas`（`capture.js:2303-2330`）一次性把底图 + 全部标注合成，再 `toBlob('image/png')`（`:2332-2342`），写入历史的就是这个合成 buffer（`main/domains/capture/index.js:567`/`:590`/`:624` → `history-service.js:286` `writeFileSync`）。

主进程侧**完全没有标注模型**：`_captureInit` 的键只有图像/几何/设置；`ipc-security.js` 的 `capture` role 通道表里没有任何 annotation 通道。渲染层 `annotations` 是内存数组（`capture.js:119`），每次 `capture:init` 被 `resetAnnotationState()` 清空（`:2656`）。

**因此"再次编辑"的起点永远是"一张画好的图"**，新旧笔迹不可区分，也就没有"覆盖"的语义基础——系统里不存在"底图 + 标注"这个模型，只有一个 PNG 文件。

### 3.5 附带发现（建议一并处理）

| # | 发现 | 证据 | 处理建议 |
|---|---|---|---|
| F1 | `capture:record-history` 是**未使用通道**：注册、preload 暴露、controller 实现齐全，但 `capture/` 目录下 **0 调用点** | `main/ipc/capture-ipc.js:16`、`preload-capture.js:41`、`capture/index.js:641-644` | 不直接启用为第二个写入口。新增统一提交协议后，该通道只能转接同一服务或在确认无调用方后移除；copy/save/pin 等原自动落历史路径须一起收敛，见 §6.5.4 |
| F2 | 文字工具依赖 `window.prompt`（`capture.js:2171`），Electron 43.8.3 不实现 `window.prompt`；测试用 `prompt: () => 'text'` 桩掩盖（`test/capture-toolbar-regressions.test.js:186`） | 同上 | **需真机确认**（本文不当作已确证）；若确认失效，文字工具应改用行内输入框，属标注体验必修项 |
| F3 | 搜索维度 `item.ocrText` / `item.tags` 有读取方（`history-service.js:31-38`）**无写入方** | 全仓 grep 仅此一处读 | 死路径。属本方案 P2（把 OCR 文本随文档一起写回，即可让"按文字搜截图"生效） |
| F4 | 马赛克只作用于用户可见图，**识别链路读未遮罩原图** | `capture.js:2489-2492` | **隐私缺陷**，按 §6.4 提前独立修复（P0），核验调用边界的实际输入 |
| F5 | 历史编辑链路**零回归保护**：`test/history-management-ui.test.js` 全文无 `edit`，e2e 只测空历史页 | 该文件 + `e2e/highlighter.spec.js:18-20` | 动手前先补测试，见 §8.3 |
| F6 | `test/history-ipc.test.js:37-53` 用 `assert.deepEqual` **锁死 14 个通道的顺序** | 同上 | 新增通道要同步改这个断言，否则直接打红 |

---

## 4. 参考实现对标：只移植"模型"，不移植"栈"

### 4.1 两个参考实现的共同答案

| 问题 | snow-shot（Tauri+React） | snow_apps / snow_shot（Qt+Rust） | 共同结论 |
|---|---|---|---|
| 一条记录存什么 | `CaptureHistoryItem{id, selected_rect, file_name, capture_result_file_name?, excalidraw_elements, excalidraw_app_state, source, create_ts}`（`src/utils/appStore.ts:131-142`） | `CaptureHistoryRecord/Draft{id, createdUtc, canvasBounds, selection, displays[], result?, canvasBytes, contentKind, ...}` + `canvas_history.json` = `DocumentHistory{schemaVersion, document, history}`（`snow_shot/include/snow_shot/storage/capturehistorytypes.h:111-191`；`snow_draw_engine_qt/crates/snow-draw-engine/src/session.rs:13-33`） | **都存可再编辑的矢量文档**；snow_shot 连 undo/redo 栈一起存 |
| 位图与文档的关系 | 底图另存 `captureHistoryImages/<ts>.<webp\|png>`；结果图**可选**（`historySaveEditResult` 开关，`src/pages/draw/page.tsx:934-940`） | 每屏 `display_%1.png` + 结果图 `capture_result.png` **可选**（缺失时列表退化显示底图） | 借鉴底图与文档分离；Highlighter 的对外操作已有位图契约，因此**每个提交版本必须有完整结果图**，不照搬"缺失就显示底图" |
| 恢复时的撤销栈 | `updateScene({elements, appState, captureUpdate:"NEVER"})` → **`clearHistory()`**（`src/pages/draw/components/captureHistory/index.tsx:214-224`、`:268`） | `restoreDocumentHistoryPreservingEditorStyles` 灌入后**换会话**（`screenshothistoryservice.cpp:773-830`） | **恢复 = 换会话 + 清栈**，绝不进撤销栈 |
| 保存语义 | 已有记录再保存 → **新 timestamp id + 新文件名**，旧底图 `copyFile`（`utils/captureHistory.ts:132-201`） | `snapshotCurrent()` 每次 `QUuid::createUuid()`；仓库显式拒绝重复 id（`capturehistoryrepository.cpp:1131-1135`） | **append-only，不覆盖文件** |
| 裁剪是什么 | **不是图层**：选区即裁剪，导出按 `selectRect` 取像素后把标注层整体平移 `-min_x/-min_y`（`src/pages/draw/actions.ts:39-170`） | 截图编辑器同样无 crop 工具；crop 只在独立图片编辑模块（条带裁剪） | 借鉴选区表达裁剪；Highlighter **保留源坐标，平移只发生在显示/导出阶段**，不回写标注 |
| 撤销模型 | Excalidraw `History` = **inverse delta**（`packages/excalidraw/history.ts`） | `Transaction` 成对 undo/redo 命令 + **220ms 域内合并** + **净零折叠**（`snow-draw-engine/src/history.rs:293-450`） | 都不适合直接搬（见 §4.2） |
| 效果类工具 | `blur`（矩形）与 `blur_freedraw`（笔刷）**是两个元素类型** | `FilterData`（矩形，可旋转）与 `PenFilterData`（路径）；`filterType` 含 **SmartErase / RestoreBackground**（`document.rs:513-536`） | **同一个滤镜承认两种几何**，Highlighter 的 `blur` 也应显式支持这两种 |
| 橡皮擦对效果元素的语义 | `onHandleEraser` 对 blur/highlight **不删除，而是把 `eraserAlpha` 降到 `opacity*0.42`**（`blurTool.tsx:182-210`） | 对象级删除 + 预览；另有 `BrushEraser` = `PenFilter(filterType=RestoreBackground, strength=1.0)`（`pen_filter_workflow.rs:124-137`） | 可借鉴可逆预览；Highlighter 的遮罩保护与显示透明度分开，擦除隐私对象不能悄悄降低识别保护 |

### 4.2 明确"不移植"

| 机制 | 为什么不移植 |
|---|---|
| **完整 Command/Transaction 模式重写 undo** | 收益依赖"每条历史极小 + 整栈可持久化 + 引擎/host 分家"。Highlighter 只有 11 类标注、2696 行单文件、60 帧上限；改成命令模式要触碰**全部**变更路径（拖动/缩放/样式/层级/文本/序号/续笔/裁剪），回归面远大于收益。**只借规则（域内合并 / 净零折叠 / amend），不换模型。** |
| **GPU 瓦片合成器 + retained scene** | 前提是"有 retained 渲染器 + 有缩放/平移视口"。Highlighter 是一块视口大小、无缩放平移的 Canvas2D；瓦片化只会把简单重绘换成分块调度 + 纹理预算，复杂度上一个量级、收益接近 0。用**脏矩形 + 视口裁剪**解决即可。 |
| **引入 Excalidraw 矢量层 + PIXI(WebGL) 效果层** | 需要 React + 构建链 + 两套渲染栈，而 Highlighter 是**无构建的单文件捕获窗口**；且 snow-shot 依赖 `@mg-chao/excalidraw` 的私有扩展 API（`customOptions`/`onHistoryChange`/`blur` 元素类型），本地 fork 里**无源码可参照**。本项目只需 3 种效果，Canvas2D 的 `imageSmoothingEnabled=false` 缩放已够。 |
| **Tauri plugin-store 当历史库** | 全量 JSON 重写 + `autoSave:0`，条数一多就是 O(n) 落盘。Highlighter 应**扩展** `history-service.js` 而非替换。**借结构不借容器。** |
| **snow_image_viewer 的 512 条纹流式解码 + 16 GiB 瓦片** | 那是看图器场景（任意缩放、8K 图）。本项目需要的是"一张截图能画能存"，`createImageBitmap` + 视口裁剪 + 导出分带足够。 |

### 4.3 许可证红线

按 `docs/plans/2026-10-10-snow-apps-feature-gap-analysis.md` §5 已选定的**路线 A（GPL-3.0-or-later）**执行。但注意该文档已漂移：§5.1 把 `snow-crates/` 记为 Apache-2.0，**实测已是 GPL-3.0-or-later**（`snow-apps/LICENSE.md:11-19`，变更 commit `881132435`）。且 Highlighter 自己的 `LICENSE`/`COPYRIGHT`/`package.json license` 尚未落地（§5.6 L1–L3 未完成）——**落地前不要真的搬代码**。本方案只移植"架构决策"，不移植源码，符合 §5.5.1"思路不受版权保护"的口径。

---

## 5. 建议的目标交互流程

### 5.1 主流程（列表 → 编辑 → 再保存）

```
列表页
 ├─ 单击缩略图  → 右侧详情面板（预览 + 元数据 + [编辑] 主按钮）
 └─ 双击缩略图  → 直接进入编辑（键盘可达：Enter）
        │
        ▼
   就地编辑器（紧凑窗口，图片按比例居中，底部预留工具条空间）
     ├─ 载入: 当前 revision 的底图 + doc（源像素标注/crop/视图偏好）
     ├─ 撤销栈重置为"一次载入"（不可撤销到"上一张图"）
     ├─ 编辑: 标注 / 裁剪 / 对象擦除 / 撤销 / 重做
     ├─ 状态: 编辑器顶部信息区显示「正在编辑：<原文件名>（第 N 版）」，有未保存改动时显示 · 标记
     └─ 退出: 有未保存改动 → 三选一
              [保存并关闭] [放弃改动] [继续编辑]
        │
        ▼
   保存（默认"更新此记录"；普通保存留在编辑器，保存并返回在成功后退出）
     ├─ 主路径: 提交成功 → 同 documentId、新 revisionId，原卡片原地刷新
     ├─ 次路径: [另存为新记录] → 新 documentId、首个 revision，derivedFrom 记录来源
     └─ 失败/冲突: 留在编辑器，保留内容与 dirty；重试或显式另存，不自动覆盖新版
        │
        ▼
   回到列表：保持滚动位置与已加载页数；只增量替换受影响卡片；
            原条目显示「第 N 版」；完整版本时间线在后续批次补齐
```

### 5.2 编辑器内部的交互约定（消除现有摩擦）

| 场景 | 现状 | 目标 |
|---|---|---|
| 选中已有标注 | 只有 `select` 工具能左键选中；**换工具会清空选中**（`capture.js:1117-1120`），画图工具态下左键点已有标注**不会**选中（命中分支仅在 `currentTool==='select'`，`:2139-2166`） | 任何工具态下，**右键或长按**已有标注 → 快速选中并弹出属性；`Esc` 先取消选中再退工具，不关窗 |
| 改样式 | 必须"切回 select → 重新点中 → 再切工具" | 选中后属性面板常驻，直接改（已有 `applyStyleToSelectedAnnotation`，`capture.js:1773-1785`） |
| 裁剪 | 无 | 独立按钮 → 裁剪框（8 手柄 + 比例锁定）→ 确认更新 `crop`，标注源坐标不变；`Esc` 取消未确认的裁剪 |
| 擦除 | 只能删除整条标注 | 普通对象可删除、效果对象可预览降透明度，整个手势一步撤销；隐私遮罩只有明确删除对象后才解除，预览透明度不改变识别保护 |
| 关闭 | `Esc` 一路降级到直接关窗（`capture.js:2625`），**无二次确认** | Esc 优先退出当前面板/选中/工具，无活动子状态时进入统一关闭协商；dirty 时确认，clean 时可直接离开 |

### 5.3 窗口形态（直接复用 pin 的算式）

`pin/index.js:513-562` 已有按工作区与工具条高度计算紧凑窗口的路径：按 `ROW_MIN_CONTENT`/`STRIP_ROW_HEIGHT` 预留工具条空间，再求图像缩放和 `imageBounds`。抽成共用函数，history 以当前 `crop` 的源像素尺寸计算适配比例；新增信息区和按钮须一并计入高度并更新布局测试。窗口位置属于会话状态，跨 DPI/显示器打开时重新计算，不写进文档坐标。当前窗口为 `frame:false`，文件名与版次应有实际可见的信息区，不能只设置原生 `title`。真机测试窗口按 `AGENTS.md` 放在副屏。

---

## 6. 功能改进点

### 6.1 标注（annotation）

| # | 改进 | 现状证据 | 依据 | 优先级 |
|---|---|---|---|---|
| A1 | **标注可再编辑**：版本 doc 按源像素坐标持久化，载入时映射到视口；旧扁平图仅支持其上新增的对象 | `history-service.js:302-311` 无文档字段；`capture.js:2303-2342` 只出 PNG | 两个参考实现的共同做法，兼容边界见 §6.7 | **P0** |
| A2 | 恢复时**清空撤销栈**（换会话语义） | `capture.js:1899-1919` `resetAnnotationState` 已清栈，但载入后需重新压一帧"初始态" | snow-shot `captureUpdate:"NEVER"` + `clearHistory()` | **P0** |
| A3 | 任意工具态右键/长按选中已有标注 | 命中分支仅 `currentTool==='select'`（`:2139-2166`）；已有 `quickSelectAnnotation`（`:2089-2101`）但只在右键分支 | 现状自带的绕过手段，应升为正路 | P1 |
| A4 | 换工具**不清空**选中（或在绘制后恢复） | `setTool` → `setSelectedAnnotation(null)`（`:1117-1120`） | 直接摩擦点 | P1 |
| A5 | 文字工具改用**行内输入框** | `capture.js:2171` 的 `window.prompt`（F2，需真机确认失效） | `docs/plans/2026-10-14-capture-interaction-improvement-plan.md` 已列为待办 | P1（确认后升 P0） |
| A6 | `blur` 显式支持两种几何（矩形 + 笔刷），并在 UI 上区分 | 现在靠"有无 `points`"隐式区分（`capture.js:714-723`） | snow_shot 的 `FilterData`/`PenFilterData` 双类型 | P2 |
| A7 | 属性面板常驻（选中即显示），替代"浮动工具条 + 二级选项行"的层级叠 | 现状 z 序 5/6/7/8/10 层浮层（`capture.css:68,152,189,230,264,290,312`）+ 手工避让（`capture.js:856-873`） | 面板层级是 A3/A4 的上位解法 | P2 |

### 6.2 裁剪（crop）

**设计要点：裁剪是底图像素坐标中的一个矩形；标注始终保留同一源坐标，平移与缩放只在显示、命中和导出时应用。**

| # | 改进 | 现状 | 目标 |
|---|---|---|---|
| C1 | 新增裁剪工具（工具栏按钮 + `C` 快捷键） | 无 crop 图标、代码里 `crop` 只是注释词 | 独立模式：拖 8 手柄改裁剪框，可锁定宽高比 |
| C2 | 确认裁剪时保留标注源坐标 | 重划选区会 `clearAnnotationsForNewSelection()` 丢全部（`capture.js:2133-2136`、`:1535-1544`） | 只更新 `doc.crop`；越界对象保留，通过 clip 限制可见与导出区域。禁止先减 crop 再在导出时减第二次 |
| C3 | 裁剪**进撤销栈** | `restoreAnnotations` 不碰 `selection`（`:1479-1489`） | 撤销恢复同一份 `{annotations, crop}` 内容快照；选框从 crop 投影得到 |
| C4 | 多次裁剪可累积（允许"再裁一次"） | 只能整体重划 | 新框经视口逆变换回底图坐标，不累计减坐标；每次确认一步撤销，可在保留底图内重新扩大 crop |
| C5 | 裁剪后底图仍按原分辨率导出（不重采样） | `getSourcePixelRect` 已是源像素映射（`selection-utils.js:206-220`） | 保持——这是既有优点，不要退化 |

**唯一真相是 `doc.crop`**。渲染器原有 CSS `selection` 作为交互投影使用，不单独持久化，不与 crop 保持两份可写状态。首次区域截图的选择框与建档后的裁剪框分属两个阶段，归一化仅在首次建档时执行一次。

#### 6.2.1 坐标与像素契约（批次 0 固定，批次 1 实现）

- 底图物理像素为文档坐标单位。`crop`、所有对象的 `x/y/x2/y2/points`、笔宽、字体/圆角/序号半径、马赛克单元尺寸等有长度含义的字段都使用该单位；不能只转换端点而漏掉样式几何。马赛克网格锚定底图原点，裁剪、视口缩放不能改变网格相位。颜色、透明度等无量纲属性不缩放。
- 当前 `annotation-geometry.js:3-5` 明确使用窗口 CSS 坐标，不能把当前数组原样写盘。若捕获图尺寸为 `W×H`，在窗口内显示于 `bounds={x,y,w,h}`，输入点先换算 `sourceX=(cssX-x)*W/w`、`sourceY=(cssY-y)*H/h`。首次选区取 `getSourcePixelRect` 的实际整数像素边界作为初始底图，再统一减去该边界原点；只保留用户确认选区内的底图像素，不顺便保存整屏缓冲区。
- 编辑视口约定 `cssX=offsetX+(sourceX-crop.x)*zoom`、`cssY=offsetY+(sourceY-crop.y)*zoom`；`zoom` 是源像素到 CSS 像素的比例，含 fit 与用户缩放，`offset` 含居中与平移。输入和命中使用同一变换的逆；DPR 只用于 canvas backing store，不再乘进文档数据。
- 导出坐标只换算一次：`outX=sourceX-crop.x`、`outY=sourceY-crop.y`；导出尺寸等于 crop 的整数像素宽高，不因窗口缩小、DPI 或 view.zoom 重采样。crop 确认时统一取整并钳制在底图范围内；对象坐标保留精度，仅裁剪边界取整。
- `resizeCanvas`、跨屏 DPI 变化和恢复 view 只能更新投影，不能重置 crop、重写对象坐标或制造撤销步骤。现有 `capture.js:398-400` 的 image 模式全选逻辑必须改为只在首次初始化且无 doc 时执行。
- 原始捕获的 DPI/scaleFactor 作为 `captureMetadata` 单独保存，缺失的旧图默认 1；视口 fit/zoom 不得覆写它。OCR 低 DPI 预处理与 PDF 物理尺寸使用捕获元数据，不把"为了适配编辑窗口而缩小图片"误当作新的捕获 DPI。
- 光标快照作为文档捕获附属数据保留（位图引用、源像素位置、热点及尺寸），保持既有导出叠放顺序，不重新读取当前屏幕光标；水印和序号恢复已有对象，设置只作为新对象默认值，避免重开后重复添加。需要影响产物的捕获附属数据也属于内容快照。
- 必测：100%/150%/200% DPI、横纵屏与负坐标副屏、region 非零原点、image 居中留白、重复裁剪/撤销/重开、细笔宽与马赛克采样网格；同一文档在不同窗口导出须保持内容位置与尺寸一致。

### 6.3 撤销 / 重做

保留**快照模型**，做三件事：

| # | 改进 | 现状证据 | 预期 |
|---|---|---|---|
| U1 | **快照覆盖完整内容状态**：`{annotations, crop, captureAttachments}`；身份与视口不进内容栈 | `capture.js:1465-1470` 只 push `cloneAnnotations(annotations)`；`:1479-1489` 只写回 `annotations` | 撤销裁剪、重划选区等内容操作，不撤销到另一条记录，不把 zoom/pan 当内容改动 |
| U2 | **结构共享 + 内存预算**：未改对象/点集保持不可变共享，只复制发生变化的对象；按去重后的实际点集估算预算（初值 20 万点、96 MiB），超预算淘汰最旧完整步骤，保留当前态 | 全量深拷贝（`annotation-geometry.js:544-558`）；既有 Node 实测每点约 80 B，8 万点 × 60 帧 = 367.31 MiB；渲染进程峰值仍需真机复测 | 正常场景保持 60 帧上限；禁止"每 N 次操作记一帧"或拼接无关手势。单个当前态超限时停止新增并提示，不静默丢当前内容 |
| U3 | **220ms 域内合并 + 净零折叠**：仅同一对象集合、同一属性的连续微调/样式编辑可合并；切工具、切对象、手势结束、保存前必须收口 | 已有 `flushCoalescedEdits()`（`capture.js:1474-1477`）与微调/样式收口机制，需核对现有 500ms/300ms 规则后替换；当前未实现统一域键和净零折叠 | 独立拖拽/笔迹始终各一步；合并后回到初始值则移除空步骤，不合并跨裁剪或跨保存边界的动作 |
| U4 | 撤销一次 = 一次**用户动作**，而不是一次内部写 | `snapshotAnnotations` 注释已声明纪律（`:1462-1464`），但调用点 60+ 处需逐个核对 | 消除"一次 Ctrl+Z 退两步"的偶发 |

**明确不做**：不改成成对 undo/redo 命令模式（理由见 §4.2）。

### 6.4 智能擦除

分三层，优先级不同：

| # | 层级 | 内容 | 依据 | 优先级 |
|---|---|---|---|---|
| E1 | **识别输入隐私保护（缺陷）** | OCR/翻译/表格/二维码/转文档统一使用专用识别合成函数：取当前 crop 的底图，对仍存在的 blur 对象覆盖区域应用不透明遮罩，再预缩放；不把 highlight 视为遮密工具，不直接复用原图路径 | 当前 `capture.js:2489-2492` 绕过所有标注（F4）。仅让模型看见马赛克不能保证文字不可识别，须验证实际入参像素 | **P0 独立修复** |
| E2 | **对象级橡皮擦** | 普通对象命中即删；效果对象可降显示透明度预览，一个手势一步撤销。blur 仍存在时识别遮罩保持完整，只有显式确认删除该对象才解除；不能通过透明度到 0 自动取消隐私保护 | 参考实现只提供交互参考；显示效果与识别保护需分别定义 | P1 |
| E3 | **马赛克缓存治理** | `MOSAIC_PATCH_BUDGET=16MiB` 是"全局、先到先得、无 LRU"（`capture.js:231`、`:644-650`）：单条 4K 笔迹 bbox ≈33 MiB → **永久不缓存**；普通笔迹约 **11 条**就吃满，而设计目标场景是 30 条 → 改为 **LRU + 按可见性淘汰**，单条超预算时**降采样缓存**（1/2 分辨率 patch）而非完全不缓存 | **实测/文档实测**：30 条场景无缓存 12.2–15.4ms/帧 vs 有缓存 1.5–2.7ms/帧（`2026-10-19-brush-...-design.md` §7.6） | **P1** |
| E4 | **内容感知擦除（SmartErase）** | 框选区域 → 从周边内容重建背景 | snow_shot 有 `SmartErase`/`RestoreBackground` 滤镜类型，但那是"源 ROI 重建"型 ML 能力 | **P2 / 建议独立立项**——不要塞进本方案 |

> 注意 E3 的视觉风险：降采样会改变马赛克观感。`test/capture-brush-render.test.js` §6.3 的像素断言**在 CI 上从未绿过**（见 `AGENTS.md`），改这块必须以真机视觉验收为准，不能只依赖该测试。

识别遮罩须覆盖矩形或整条笔刷实际几何（含半线宽、端帽和边缘保守扩展），在任何缩放前施加；所有识别入口消费同一份快照，缓存键包含遮罩后的输入与选项。测试在模型/侧车调用边界截获像素，验证遮罩内没有源文字像素，并使用已知文本与二维码作补充识别测试；不能仅断言某次 OCR 恰好没认出来。旧位图里的历史马赛克已经不可分离，不能追溯保证其遮罩区域，UI 与验收须区分此边界。可编辑文档保留原始像素，属于本地可恢复编辑资料；对外分享提供结果图，不能把整份文档包当成已脱敏图片。

### 6.5 保存

| # | 改进 | 现状证据 | 目标 |
|---|---|---|---|
| S1 | 文档与版本分离 | 现条目无版本字段（`history-service.js:302-311`） | 卡片 `documentId` 稳定，提交创建新 `revisionId`，不复用一个 id 表达两种身份 |
| S2 | "更新此记录"主路径 | 当前只有 create | 追加不可变 revision，提交后移动文档 head；列表仍只有该文档一张卡片 |
| S3 | "另存为新记录"次路径 | 现状只能新增扁平条目 | 新建文档与首个 revision；`derivedFrom` 只记录来源，不参与版本分组 |
| S4 | 区分文档提交与外部导出 | 现 `saveMode` 仅决定 PNG 保存对话框/目录 | 历史编辑 `Ctrl+S` 提交文档，不依赖上次导出目录；`Ctrl+Shift+S` 另存文档。导出图片/PDF 使用独立命令，`saveMode` 只作用于该命令 |
| S5 | 成功确认与失败可恢复 | `capture:save` 使用 send；controller 在 I/O 前关窗（`preload-capture.js:30`、`capture/index.js:581-595`） | invoke 返回结构化结果；提交成功后清 dirty，失败或冲突保持编辑器可重试 |
| S6 | 文件职责固定 | 现有消费者直接读 `filePath` | `filePath` 始终是当前已提交结果图的兼容别名，底图只供编辑重建；结果图为每个版本的必需产物 |
| S7 | 列表与提交同步 | 当前 `history:changed` 触发整页重建 | 以文档 id 增量更新、以 revision id 失效缩略图缓存；首批保留滚动、已加载页数与勾选状态 |
| S8 | 长图编辑能力明确 | 当前静默隐藏按钮（`history.js:165`） | 首批补解释；满足相同画布/内存护栏后再开放同一模型，不在无护栏时直接放开 |

#### 6.5.1 身份、版本与列表契约

| 字段 | 含义与约束 |
|---|---|
| `documentId` | 稳定的用户记录身份，列表、选择、删除、分页游标使用它。兼容期 `item.id === documentId` |
| `revisionId` | 主进程创建的不可变版本身份；每次有内容变化的成功提交生成新值，版次由主进程递增 |
| `parentRevisionId` | 同一文档内的直接前驱；首版为 null，不用于推导文档分组 |
| `headRevisionId` | 文档当前版本，仅在所有文件准备完成后随索引事务切换 |
| `derivedFrom` | 仅另存文档首版记录 `{documentId, revisionId}` 来源；来源删除不影响副本打开，不合并两者卡片 |
| `expectedRevisionId` | 编辑会话打开/最近保存成功时看到的 head；主进程在最终提交前做比较，阻止旧会话覆盖新版 |

索引保留每个文档一条摘要（含 head、可用版本的小型元数据、createdAt/updatedAt、来源、尺寸、兼容 `filePath`/`thumbnailPath`/`docPath`），点集只在 doc 文件中。`history:list` 按文档分页，不把 revision 混入平铺列表；普通更新保持卡片现有位置，新增/另存才插入首部。版本时间线单独查询。缩略图缓存键为 `(documentId, headRevisionId)`，异步返回旧 revision 的请求不能覆盖新版。

首次截图生成新文档；继续编辑更新同一文档；另存创建独立文档并切换当前会话到新文档；打开旧版本后编辑仍须以当前 head 做冲突检查，显式确认后把旧内容作为新 head 提交，或另存，禁止无提示覆盖。只有 update 在内容指纹未变化时返回 `unchanged`，不增加版次；create/save-copy 即使内容与来源相同，也应建立用户明确要求的新文档，重复 requestId 重试除外。

#### 6.5.2 文件布局与所有权

```text
history/documents/<documentId>/
  base/<baseImageId>.png                # 初始确认选区的底图，不覆盖
  assets/<assetId>.png                  # 可选捕获光标等附件
  revisions/<revisionId>.doc.json       # 该版本的可编辑内容
  revisions/<revisionId>.result.png     # 该版本完整合成结果，必需
  revisions/<revisionId>.thumb.png      # 从 result 生成，可重建
```

文件路径由主进程从受控根目录、文档/版本/资源 id 推导，磁盘 manifest 使用相对路径；doc 中只存资源 id。`baseImagePath`、`resultImagePath`、`docPath`、`thumbnailPath` 是服务层解析后的职责名，不接受渲染器指定任意路径。保持可配置 `historyDirectory` 与当前默认目录中旧文件的兼容，移动数据根目录时仅迁移其实际拥有的文件，外部自定义目录保持原位置并做存在性校验。

首版与后续版本可共享同一文档内的不可变底图；另存首批采用物理复制底图和附件，消除跨文档删除依赖，暂不引入跨文档去重。结果图必须保留原始导出分辨率；缩略图从 result 生成，不从 base 生成。文件名规则/目录标识与所有权校验须扩展到新布局，不能沿用只识别旧 PNG 命名的 `isOwnedHistoryFile`（`history-service.js:49-52`）。

#### 6.5.3 文档格式与载入校验

```json
{
  "schemaVersion": 1,
  "coordinateSpace": "source-pixel",
  "documentId": "document-a",
  "revisionId": "revision-2",
  "parentRevisionId": "revision-1",
  "baseImage": { "assetId": "base-a", "width": 3840, "height": 2160 },
  "crop": { "x": 120, "y": 80, "w": 2400, "h": 1600 },
  "annotations": [
    { "id": "arrow-a", "type": "arrow", "x": 300, "y": 240, "x2": 900, "y2": 480, "width": 8, "color": "#ff0000" }
  ],
  "captureAttachments": { "cursor": null },
  "captureMetadata": { "sourceScaleFactor": 2 },
  "view": { "zoomMultiplier": 1, "centerX": 1320, "centerY": 880 },
  "source": "region",
  "createdAt": 1792886400000
}
```

- `view` 是基于 fit 的缩放偏好与源像素中心位置，不是旧窗口的 CSS 滚动量；恢复时按当前工作区重新适配。只改 view 不设置内容 dirty、不生成 revision，可随下次内容提交保存或留在会话偏好中。
- 载入先读取并校验 `schemaVersion`，按明确的版本迁移函数升级，再做完整 schema 校验；未知未来版本不得猜测补字段。迁移只写新 revision，保留旧文件。
- doc UTF-8 大小硬上限 16 MiB；磁盘文件在 JSON 解析前限制大小。提交的 `snapshot` 以 UTF-8 JSON 字节数组传递，发送端/preload 先限制载荷字节数，主进程接收后再次校验再 JSON.parse；不宣称能在 Electron 内部结构化克隆前拦截不可信进程。随后验证白名单字段、对象数、单条/总点数、有限数值、crop 边界、资源 id 与实际 PNG 尺寸。图像另设字节/像素上限；当前已有 65535 边长/8000 万像素限制只是外层上限，编辑器还须受 canvas 与内存预算约束。
- 提交字段超限时返回具体错误并保留现场，允许用户显式选择"仅导出位图"；不能悄悄把一次文档保存降级成不可编辑记录。新图首次提交若用户选择仅位图历史，必须明确标记 `bitmapOnly`，使用独立的兼容写入分支；不覆盖已有可编辑 head。
- 内容指纹包含底图/附件引用与内容哈希、crop、标注及影响产物的参数，不包含 revision id、时间戳、选中对象、视口或 OCR 面板状态。dirty 与无变化保存据此判断，不依赖撤销栈下标，避免栈淘汰后误判。

#### 6.5.4 统一提交入口与动作路由

新增 `capture:commit-document` 的 invoke/handle 协议；同步修改 `preload-capture.js`、`main/ipc/capture-ipc.js`、capture role 的 allowlist 与窗口安全探针。新增通道需要更新契约测试，不能为了绕开通道顺序断言复用不匹配的接口。

主进程在创建编辑器时生成 `sessionId`，绑定发送窗口、编辑来源、文档/head 与允许的资源；渲染器提交 `{sessionId, requestId, intent, expectedRevisionId, snapshot, resultBuffer, newBaseBuffer?, attachmentBuffers?}`。`intent` 限定 `create/update/save-copy`。文档/资源 id 与路径的最终归属由主进程校验和生成，渲染器不能通过传另一条 history id 改写其它文档。首次建档才提供选区底图；再编辑使用会话已绑定的 base 引用。渲染器提供的 result 必须来自与 snapshot 相同的冻结内容态，尺寸等于 crop；服务验证尺寸、大小和文件哈希，渲染一致性由共享导出逻辑与回归用例保证。

| 用户动作 | 历史/文档行为 | 外部副作用与关闭规则 |
|---|---|---|
| 历史编辑 `Ctrl+S` / 保存 | 提交 update，成功后原卡片更新 | 无 PNG 目录对话框；普通保存留在编辑器，"保存并关闭"在确认成功后关闭 |
| `Ctrl+Shift+S` / 另存为新记录 | 提交 save-copy，新文档独立首版 | 不等同于选择外部导出目录；成功后会话切到副本 |
| 新截图保存 | 历史启用时提交 create，建立首个可编辑版本 | 保留原有 fast/dialog 的外部 PNG 导出意图；分别返回历史提交与外部导出结果，部分成功不得伪装成全部失败 |
| 复制 / 贴图 | 新图按当前历史策略 create 一次；历史会话有未提交内容则 update 一次，无变化不新增 | 与文档共用同一冻结结果；副作用完成且要求的提交成功后关闭。历史失败时保留现场，可重试或明确选择"仅完成复制/贴图并离开" |
| OCR / 翻译 / 表格 / QR / 转文档 | 识别输入走 §6.4 的遮罩合成，不能把遮罩版输入当成编辑底图或保存结果 | 识别不自动保存历史会话的改动；新截图若沿用原有自动历史策略，只能通过统一服务保存一次正常文档结果。需要切窗/转贴图时先走 dirty 保护 |
| 导出 PNG / PDF | 只导出当前快照，不因导出自动创建另一个文档 | 外部取消或失败保留窗口与 dirty，明确显示"导出"结果，不把导出成功当成文档已保存 |

`copy/save/pin/pinReannotate/openRecognition` 当前各自调用 `persistHistory`（`capture/index.js:556-643`），必须收敛到上述路由；不能再在动作末尾追加 `recordHistory` 形成第二次落盘。保留兼容通道时只转接统一服务，不绕过会话、幂等或原子发布校验。

历史关闭时：新截图的复制/贴图/外部导出仍可完成，返回 `historyStatus:'disabled'`，不得显示"已保存历史"；已有历史文档更新在入口明确提示写入受设置禁用，可继续编辑和仅导出，不能默默新增记录。只读/数据目录迁移中同样返回明确状态，不能绕过 `assertWritable`。

提交返回值至少区分：`committed`（含 documentId/revisionId/version、规范化资源映射和内容指纹）、`unchanged`、`conflict`（含当前 head）、`failed`（错误码与可重试性）。成功后渲染器先接受主进程分配的资源/版本身份，再建立 clean 基线，避免临时资源 id 变化导致假 dirty。保存按钮在请求期间防重复，`requestId` 与冻结快照绑定；超时重试同一 requestId 只确认同一个提交，修改快照须生成新 requestId。幂等信息写入 revision 元数据/索引并能在重启后查询；重复请求不能多出版本。外部复制、贴图和文件导出各有独立完成状态，重试提交不重复执行已成功的副作用。

状态查询按主进程授权的文档/请求范围开放，重启后重新建立会话再取回已有回执。回执保留覆盖活跃会话与约定重试窗口，且有容量/期限上限；淘汰 revision 不能使尚未确认的 requestId 被当作新的 create。已过期请求明确返回 `expired`，不得悄悄再次执行；具体窗口由 B0 固定并加入边界测试。

#### 6.5.5 多文件发布与失败恢复

**索引切换是版本可见性的唯一提交点**，单个文件 rename 不代表整次保存已经完成：

1. 收口编辑并冻结内容态、编码 result，保存期间禁止内容变更；文档验证失败时不开始写入。
2. 服务为同一文档的提交、删除、保留裁剪串行化，另存同时固定来源快照；在受控历史根目录创建同卷 staging，写事务 manifest（requestId、预期 head、资源列表/大小/哈希）。
3. 写入并关闭新底图/附件（如有）、doc、result、thumb 文件；校验大小/哈希和可解码尺寸。可用平台能力执行必要 flush；不把普通 rename 描述成断电持久性保证。
4. 将新资源发布到唯一不可变的正式路径；重新检查 `expectedRevisionId`、文档是否已删除及写权限。冲突则不更新 head、不自动复活已删除文档。
5. 用可恢复的原子索引替换一次性发布新 revision、head、兼容路径与幂等记录；索引失败恢复旧索引，旧 head 的文件在此之前不能删除。具体 electron-store 写入/备份能力在批次 0 用故障注入验证，能力不足则由历史服务增加备份与恢复层。
6. 成功后返回确认并广播 `{documentId, revisionId, changeType}`。通知失败或确认丢失不回滚已提交版本；客户端按 requestId 查询/重试取得同一个结果。保留清理在提交后运行，失败单独记录，不推翻保存成功。

启动恢复根据索引与 manifest 判断提交状态：索引已引用且文件完整则确认已提交；未引用的 staging/正式文件在无活跃事务时回收；索引引用不完整则从可用备份恢复上一完整 head，或将该版本标记损坏并提示。绝不以未标注 base 顶替缺失 result。对每一步的磁盘满、拒绝写、rename 失败、索引写失败与进程退出做注入测试。发布、GC、迁移共用写入协调机制，清理不能删除仍在写入/打开会话引用的资源。

#### 6.5.6 dirty、关闭与会话切换

首次新截图确认选区并建好内容初态后可离开而不因临时截图本身反复提示；用户修改标注/裁剪后进入 dirty。历史文档以最近一次成功提交的内容指纹作为 clean 基线。撤销回基线后 clean，撤销到旧内容则 dirty；视口、选中对象与识别面板不改变该状态。

所有退出路径统一进入 `requestClose(reason)`：关闭按钮、Esc 最终退出、原生关闭、快捷键创建下一张截图、从另一条历史替换当前编辑器、OCR 自动关闭和识别转贴图等。当前 `createCaptureWindow` 直接 close 旧窗口（`:341`）必须先完成该协商；用户选"继续编辑"时取消新会话创建，不能创建新窗口后把旧的销毁。主进程的 close 事件也要执行同样保护，防止只拦截渲染器按钮。

dirty 时给出[保存并关闭][放弃改动][继续编辑]；saving 时等待可确认结果，失败返回 dirty，conflict 提供重载/另存且不能未经同意丢掉当前内容。无 dirty 直接关闭。程序正常退出与会话切换适用同一规则；强制结束进程不承诺恢复未提交内容，草稿作为后续可选能力，不能拿可选草稿代替提交正确性。焦点只在用户完成该编辑会话后还给发起窗口，程序退出或下一会话接管时不强制抢回。

#### 6.5.7 对外图片消费者与损坏降级

| 消费者 | 数据来源 |
|---|---|
| 历史列表缩略图 | 当前 head 的 thumb；缺失时只从同版 result 重建 |
| 历史打开、复制、地址、图片导出、PDF 导出 | 当前已提交 revision 的 result；`filePath` 兼容别名始终指向它，width/height 为该结果尺寸 |
| 打开编辑器 | 版本 doc + 其引用的底图/附件；view 在当前窗口重算 |
| 编辑器识别 | 当前内容态的 crop + 专用不透明遮罩合成，见 §6.4 |

主进程统一提供 `resolveCommittedResult(documentId, revisionId?)`，所有图片消费者与 `selectExportItems` 复用；禁止各处在缺失文件时自行回退到 base。`地址` 继续表示**复制结果图片路径**，不变更为定位文件、不复制文档或底图路径；渲染器仍只传 id。

doc 缺失、损坏或版本不支持时，若当前 result 完整，可标记为"仅位图恢复"并明确提示无法修改旧对象；用户确认后以该 result 作新的扁平底图创建下一 revision，旧 revision 与资源保留供恢复。result 缺失时优先用通过验证的 doc+base 重建同版内容；没有该能力或校验失败则显示损坏/不可用，不显示或导出 base。底图丢失但 result 完整时适用仅位图恢复。任何恢复都不能静默清空标注、扩张 crop 或把新文档误判成原生旧位图。

### 6.6 数据生命周期与目录迁移（首批发布条件）

| 场景 | 必须实现的规则 |
|---|---|
| 删除文档/批量删除/清空 | 先通过可恢复索引事务去掉文档可见引用，再回收该文档全部 revisions、base、附件、thumb、草稿；失败进入可重试 GC 清单并返回真实失败项，不能从索引消失就宣称磁盘清理完成 |
| 删除某一旧版本 | 不删除其它版本仍引用的底图/附件；禁止直接删除 head，显式恢复旧版须生成一个新 revision。已保留版本的父版本可已被淘汰，时间线须能显示截断 |
| 保留策略 | `screenshot.historyLimit` 继续按文档数计数，不因多次编辑挤掉其它截图；新增 `screenshot.historyRevisionLimit` 初值 20、每文档至少保留 head。淘汰最旧非 head 版本，按实际引用释放资源，不自动淘汰活跃编辑会话所依赖的版本 |
| 空间统计/缺失检测 | 去重统计所有被引用的 base/doc/result/thumb/附件/草稿与待回收文件，分别报告文档数、版本数、不可编辑/不可导出状态；不能只统计 `filePath` 和 thumb |
| 孤儿清理 | 从当前索引、有效恢复备份、事务和活跃会话构建引用集合；备份代数与保留期有界，删除事务同步使已删除记录的恢复引用失效，避免清空后仍保留全部数据。同时识别旧命名与新受控布局，未引用且确认为本应用拥有的文件才可删，不能清理自定义目录中的其它图片 |
| 数据根目录迁移 | 停止新的历史写入/GC，先处理 dirty 会话；复制并校验完整资源与索引，切换成功后才允许清旧目录。扩展 `data-root-migration.js:80-96`，迁移所有兼容路径和新增字段；doc 中资源 id/相对引用不含旧盘符。迁移校验须解析每个保留 revision 的资源可达性，不能仅比较文件数 |
| 外部自定义历史目录 | 根目录迁移不擅自搬走它；保留受控解析关系并检查可达性。用户单独变更 historyDirectory 时，旧记录仍按各自持久路径解析，新记录使用新目录 |

删除/迁移不能在保存中途与索引切换竞争；编辑期间记录被删除或 head 改变时，下次提交必须返回 deleted/conflict，由用户选择另存，不静默复活。数据根目录迁移现有代码只重写 `filePath`、`thumbnailPath`，文件虽复制成功，新增绝对 `docPath` 仍可能指向旧目录；此项必须有独立迁移测试，不能等同于普通 schema 迁移。

### 6.7 存量记录与格式兼容

1. 没有文档字段的旧条目仍按现有结果 PNG 打开/复制/导出，列表 id 保持稳定。首次编辑建立临时 `documentId=旧 id`、完整图 crop、空矢量列表；已有箭头/文字/马赛克保留为底图像素，界面说明旧标注不可单独修改。
2. 首次成功提交再进行惰性升级：把原 PNG 作为独立不可变底图保存，保留旧版 result，产生含新增矢量对象的新 revision；不在仅打开或取消编辑时重写所有旧记录。升级失败旧索引、原 PNG 仍可用。
3. 新格式 doc 丢失适用 §6.5.7 的损坏恢复提示，不能仅凭 `docPath` 不存在就当作旧记录。通过明确的存储格式标记区分 `legacy-bitmap`、`editable-v1` 和用户显式选择的 `bitmap-only`。
4. 文档 schema 升级保留来源版本，未知 schema 只能使用完整 result 的兼容能力。应用降级不承诺旧程序可编辑新格式，至少在允许的回滚路径中保留当前 `filePath` 结果图；旧程序的清理/迁移不保证理解新资源，回滚前须保留完整数据备份。

---

## 7. 性能改进点

### 7.1 大图编辑

| # | 改进 | 现状证据 | 预期收益 | 需真机 |
|---|---|---|---|---|
| P1 | **渲染层埋点先落地**（首帧 / pointer-frame / mosaic 命中 / undo / export） | `capture/capture.js` **2696 行零埋点**；现有 `capture.interactive` 的 `captureMs` 是主进程时钟，`mode:'image'` 下量到 0.05ms，与用户感知首帧**不是一回事**（`capture/index.js:491-499`） | 让后面所有改进可验收 | 是 |
| P2 | **撤销栈结构共享 + 点数上限**（同 U2） | 实测 367 MiB 峰值 | 内存降一个量级 | 是 |
| P3 | **mosaic 缓存 LRU + 降采样兜底**（同 E3） | 16 MiB 预算与 30 条目标错配 | 30 条场景 12–15ms/帧 → 1.5–2.7ms/帧（文档实测口径） | 是 |
| P4 | **视口缩放 / 平移**（新增能力） | `capture/` 内无任何 zoom/pan；`wheel` 只调线宽/切智能候选（`capture.js:2249-2269`）；大图无法精修 | 裁剪与精修的前提；也可让 4K 图在小屏可用 | 是 |
| P5 | **脏矩形重绘** | `renderOverlay` 每帧 `clearRect` 全屏 + `annotations.forEach` 全量重绘（`:727-751`）。rAF 合帧**已有**（`:753-759`）——缺的是**单帧成本上限**，不是节流 | 标注多时帧成本从 O(全部) 降到 O(变化) | 是 |
| P6 | **浮动 UI 降频** | 渲染会写 `toolbar.style.left/top`（`:1092`）、`elementBar`（`:874-875`），并读取 `getComputedStyle`（`:775-780`）；是否形成强制同步布局需 trace，不能仅凭写样式下结论 | 位置不变不写，主题色按主题/设置变更失效缓存；收益通过渲染 trace 验证 | 是 |
| P7 | **编辑器内 canvas 尺寸护栏** | 外层已有 `65535`/`80000000` 检查（`main.js:1119`、`long-capture/index.js:244`），编辑器尚无统一 canvas/内存预算；CSS 4K 视口在 DPR=2 时单张 backing canvas 可达约 33 Mpx/132 MB，实际尺寸须按 native/background/overlay 分别计数 | 基础护栏提前到批次 1；超限只缩小预览，不能悄悄缩小已提交结果。尚不支持完整导出的尺寸给出明确限制 | 是 |
| P8 | **导出分带 / Worker 编码** | `exportSelectionCanvas` 同步全尺寸 `drawImage` + N 次 `drawAnnotation`（`:2303-2330`），`toBlob` 占渲染主线程（`:2332-2342`） | 4K 导出期间不冻结 UI；8K 长图不一次开大 canvas | 是 |

> 重要边界：**背景层已经是对的**——`drawBackground` 只在 `resizeCanvas` 调用（`:401`），`renderOverlay` 不清它，`#backgroundStage` 是独立 canvas（`capture.html:12-13`）。**不要重复优化它。** 另：`render()` 已经是 rAF 单飞合帧，`data URL` 中转也已经消除（`test/capture-performance-contract.test.js:19-20` 明确断言用 Blob 且禁 `toDataURL`）——这两条都不是问题。

### 7.2 识别速度

| # | 改进 | 现状证据 | 预期 | 优先级 |
|---|---|---|---|---|
| R1 | **送识别前按目标长边预缩放** | `capture.js:2492` 导出全像素裁剪 → `:2495` 编码 → `:2526` 送侧车；JS 侧无任何缩放点 | 遮罩后预缩放以降低传输/解码数据量；编码体积、耗时与识别准确率做真实图 A/B。检测尺寸接近不等于总推理耗时不变，预缩放也会影响文本框和 CRNN 裁切；保留返回框到原 crop 的映射 | **P1** |
| R2 | **`maxSide` 做成可配置（明确不改默认值）** | `ocr-service.js:229` 默认 2048；**全仓无任何调用方传它**（`ocr-ipc.js:31-40` 不构造该字段，`main.js:234` 透传） | 增加范围校验与配置传递测试。既有 5 张真实 UI 截图 A/B 显示 2048 比 4096 快 1.45–1.61x，默认暂保留 2048；准确率和更广样本仍需验证，不称为零风险 | P1 |
| R3 | **侧车常驻** | 冷启动 median 207ms / p95 551.7ms；空闲 300s 就重付（`settings-defaults.js:87`、`ocr-service.js:195-203`） | 每次省 ~200ms。代价：常驻约 55 MiB（`docs/performance/2026-08-12-baseline.md:81`），与 P2 的内存方向相反，需权衡 | P1 |
| R4 | **可取消** | `ocr-service.js:205-223` 的 `request` 只有 120s 超时，**无 abort**；侧车单线程顺序处理，用户点第二次只能排队；`inFlight`（`:243`）只做同图去重 | 连续识别不排队；用户能反悔 | P1 |
| R5 | **去掉临时 PNG 文件** | 每次识别 `mkdir` + `writeFile` + `unlink`（`ocr-service.js:261-271`），侧车再 `image::open` 解码 | 省一次写盘 + 一次读盘 + 一次解码；需改侧车协议（`native/ocr/src/main.rs:114-125` path → bytes） | P2 |
| R6 | 结果回填优化 | `renderOcrOverlayBlocks`（`capture.js:2387-2421`）逐块 `createElement` + `appendChild`；真实截图实测返回 **111 块** | 文档片段一次性插入 | P2 |

> **一处需要更正的反常**（避免朝错误方向调参）：早期合成条纹图基准显示 `maxSide=2048` 比 4096 **慢 3–4.5 倍**。追查后确认这是**合成周期纹理的摩尔纹伪影**：14px 周期条纹在 0.838/0.715 非整数下采样下粘连成 aspect≈104 的框（`db_net` 下采样在 `paddle-ocr-rs` `ocr_lite.rs:119-150` + `scale_param.rs:30-52`，对齐 32），裁切取自原图（`ocr_utils.rs:64-107`）后 CRNN 入宽暴涨（`crnn_net.rs:8`，高归一 48、宽 = w·48/h）。**真实截图方向相反**。结论：不要基于合成图改默认值。

---

## 8. 涉及的模块与改动面

### 8.1 模块清单

| 层 | 文件 | 改动性质 | 说明 |
|---|---|---|---|
| 共享 · 文档 | 建议新增 `shared/capture-document.js`（无构建脚本） | **中** | 源坐标 schema、规范化/校验、内容指纹、视口正逆变换的共享纯函数；主进程独立重验不可信载荷 |
| 主进程 · 历史 | `main/services/history-service.js`；提交/恢复逻辑按职责抽到服务模块 | **大** | 文档索引与 revision、会话/幂等、原子发布、故障恢复、消费者结果解析、删除/保留/GC/空间统计 |
| 主进程 · 入口 | `main.js:1123-1137`（edit/open/copy/path） | **小** | 用服务解析已提交结果或编辑文档；只接线，真实返回值透传，不堆入事务逻辑 |
| 主进程 · 捕获域 | `main/domains/capture/index.js` | **中-大** | `_captureInit` 下发文档/会话与提交意图；统一动作持久化；关闭/替换协商与发起窗口焦点管理 |
| 主进程 · IPC / preload | `main/ipc/capture-ipc.js`、`main/ipc/history-ipc.js`、`main/services/ipc-security.js`、`preload-capture.js`、`preload.js` | **中** | commit/status/revision 查询协议与 DTO；升级 save 确认机制；同步 allowlist、契约断言与安全探针 |
| 主进程 · 迁移 | `main/services/data-root-migration.js` 及恢复/清理配套 | **中** | 新资源、docPath/result/base/附件路径、迁移后资源可达性与旧目录清理测试 |
| 主进程 · pin | `main/domains/pin/index.js:513-562` | **小** | 把编辑器几何算式抽成共用函数供 history 复用 |
| 渲染 · 编辑器 | `capture/capture.js` | **大** | doc 内容快照、源像素与视口适配、冻结提交、dirty/关闭保护、恢复与识别遮罩；后续裁剪/橡皮擦/性能 |
| 渲染 · 结构 | `capture/capture.html`、`capture/capture.css` | **中** | 文件名/版次/dirty 信息区、保存与独立导出入口、裁剪/橡皮擦/属性面板 |
| 渲染 · 几何 | `capture/annotation-geometry.js`、`capture/selection-utils.js` | **中-大** | 明确源坐标与投影的边界，适配命中/宽度/马赛克网格，结构共享与点数预算 |
| 配置页 | `config/routes/history.js`、`config/config.js`、`config/config.css` | **中** | 文档分页、首批原地刷新/缓存失效/滚动勾选保持，后续双击/详情/时间线 |
| 识别 | `main/services/ocr-service.js`、`main/ipc/ocr-ipc.js` | **小-中** | 预缩放、可配置 `maxSide`、取消、常驻开关 |
| 侧车（可选） | `native/ocr/src/main.rs` | **小** | stdin 传字节（R5 才需要） |
| 设置 | `main/services/settings-defaults.js` 及设置校验/界面 | **小-中** | 新键：`screenshot.historyRevisionLimit`、`ocr.maxSide`、`ocr.keepWarm`；文档保存意图来自会话，不再增加混淆导出模式的 `historySaveMode` |
| 测试 | 见 §8.3 | **中** | 新增回归保护 |

### 8.2 关键约束（改动时必须遵守）

- `main.js` 行数上限 **1330**（`scripts/check-architecture.js:31`），且 `FORBIDDEN_IN_MAIN` 禁止把 `createCaptureWindow` 之类的函数搬回去（`:46-77`）。本方案的 `editItem` 改动**必须保持在该上限内**。
- `npm run check` 包含 `check:js`（全部 JS `node --check`）+ `check:architecture` + `check:i18n --max 606`。新增文案必须同步三种语言（`shared/locales/capture.js` / `config.js`），否则 i18n 门禁失败。
- `capture/` 目录是**无构建**的原生脚本加载（`capture.html` 末尾按顺序 `<script>`），不能引入打包步骤或 ESM import。
- `main/services/settings-defaults.js` 的 `annotationStyles` **块本身就是校验白名单**（`:54-71` 注释）：新增任何 tool 样式字段必须同时改这里和 `capture/annotation-style.js` 的 `TOOL_STYLE_TOOLS`，否则被拒。
- 新增 commit/status/revision 通道必须同步 preload、角色授权、窗口归属校验、测试与安全探针；`record-history` 的现有权限不代表它天然支持文档写入，不能以绕过测试断言为接口设计依据。
- 新资源按受控 id 与目录解析并校验实际归属，限制 IPC 与解码前字节量；持久化只使用主进程路径。只读锁、迁移锁、活跃提交与 GC 使用同一协调口径。

### 8.3 测试与门禁

| 现状 | 风险 | 必须补的测试 |
|---|---|---|
| `test/history-management-ui.test.js` **全文无 `edit`**；e2e 只测空历史页（`e2e/highlighter.spec.js:18-20`） | 编辑链路缺少闭环保护（F5） | 新图→首版→重开→改对象→提交→重开，验证位置/样式/版次、初始撤销一步、列表卡片数与滚动/分页/勾选不变 |
| `test/history-ipc.test.js:37-53` 锁死 14 通道顺序 | 通道变更与角色授权脱节（F6） | 同步更新历史/capture 通道断言；伪造 session、跨文档 id、路径穿越、超限字节/点数/像素均被拒，合法调用可达 |
| `test/capture-annotation-geometry.test.js` 钉死 `MAX_ANNOTATION_HISTORY` 等常量 | 改撤销栈模型会打红 | 先读该文件再改 |
| `test/capture-brush-render.test.js` §6.3 像素断言**在 CI 从未绿过** | 改 mosaic 缓存会被误判为回归 | 按 `AGENTS.md`：先 `gh run view` 确认它本来就没绿 |
| `test/capture-performance-contract.test.js:18` 断言用 `toBlob` 而非 `toDataURL` | 改导出编码方式会打红 | 改 P8 时同步更新 |

首批与后续新增测试按行为列出，文件名可随合理拆分调整：

| 保护面 | 必测情形 | 所属批次 |
|---|---|---|
| 坐标/文档 | 非零选区原点、不同 DPI/窗口留白、样式长度、resize、连续裁剪/撤销/重开；重复保存不累计缩放或偏移 | 0 设计，1 基础，2 裁剪 |
| 版本/分组 | 同文档更新只增 revision；另存新文档不折叠；无变化保存不增版；旧 head 提交冲突；记录被删后不复活 | 1 |
| 提交/幂等 | 同 requestId 重试、并发点击、确认丢失后重启查询、copy/save/pin 的旧落盘路径不产生第二次写入 | 1 |
| 故障恢复 | 每个文件写/rename、索引提交前后失败或退出；上一完整 head 可用，无假成功，无自动清 dirty | 1 |
| 消费者/损坏 | 打码结果的打开/复制/地址/图片与 PDF 导出均取 result；缺 doc/base/result、未知 schema 分别走明确降级，不曝光 base | 1 |
| 关闭/动作状态 | Esc/关闭/创建下一张/编辑另一条/识别转贴图/正常退出；继续编辑取消切换；外部导出取消、失败、部分成功可区分 | 1 |
| 生命周期 | 文档/版本删除、20 版保留截断、活跃引用、共享底图、GC 失败重试、孤儿白名单；清空后统计与真实文件一致 | 1 |
| 迁移/存量 | 含多版本与附件的数据根迁移→清旧目录→继续编辑；外部历史目录不误搬；旧 PNG 惰性升级成功/失败/取消 | 1 |
| 隐私 | 所有识别入口截获实际图片：遮罩先于缩放，边缘/端帽覆盖完整，降透明度不解除保护，不将识别输入写回正常结果图 | 独立修复 + 1 |
| 撤销预算 | 结构共享不被后续对象原地改写污染；超限淘汰整步，dirty 基线不依赖栈下标；40 条各 1000 点仍逐手势撤销 | 2 |

每批执行与改动相关的纯函数/服务/IPC/渲染测试，再执行 `npm run check` 与必要集成门禁；首批发布前需真实 Electron 的编辑保存重开与迁移验收。环境准备按 `AGENTS.md` 排除四类宿主陷阱；只有实际执行并通过的门禁才能记录为通过，CI 结论必须有对应运行证据。本次仅修订方案，不代表这些新增测试已存在或已通过。

---

## 9. 实施优先级

### 9.1 分批建议

> 人日为容量估算，按熟悉本项目的实施者计算；含自动化测试与一次真机验收，不含返工及批次 5。新增事务/迁移/存量兼容后，不能沿用首批 3–4 人日的估算；批次 0 完成后再次估算。

#### 批次 0 —— 「契约与故障用例」（P0，**1–2 人日，不独立发布**）

| 项 | 内容 | 交付物 |
|---|---|---|
| B0.1 | 固定 §6.2.1、§6.5.1–6.5.3 的坐标/schema/身份/文件职责 | 合法与非法文档夹具、坐标正逆变换示例 |
| B0.2 | 固定动作路由、提交返回状态、幂等/冲突和 close 协商，验证现有索引写入的原子性与恢复能力 | IPC 契约、状态机、故障注入清单 |
| B0.3 | 明确 owned 资源、版本保留、旧图升级与目录迁移 | 生命周期矩阵、数据迁移夹具、首批范围与重新估算 |

**出口条件**：接口与数据格式只有一套含义，评审中的五项 P1 都有实现任务和失败用例。契约设计完成不能作为运行能力发布。

#### 批次 1 —— 「创建、编辑、提交、重开的闭环」（P0，**6–8 人日**）

| 项 | 内容 | 关键改动 |
|---|---|---|
| B1.1 | 紧凑窗口/信息区/基础 canvas 护栏，源像素文档与视口适配，恢复清栈 | capture/pin 共用几何，capture 交互与导出使用同一变换 |
| B1.2 | 首次捕获归一化建档，区分底图/doc/result/thumb，保留光标/水印/序号行为 | 共享文档纯函数、历史资源与旧图惰性升级 |
| B1.3 | 统一提交与状态查询，收敛各动作自动写历史；幂等/冲突/索引提交/启动恢复 | 历史服务、capture controller、IPC/preload/授权 |
| B1.4 | 默认更新与另存；结果消费者改造，基础版次、列表原地刷新和滚动/分页/勾选保持 | 文档分组/分页、结果解析服务、history UI |
| B1.5 | 内容快照含 crop；dirty 与所有 close/会话替换保护；保存/导出失败可见 | 渲染状态机、主进程 close 协商，草稿暂不要求 |
| B1.6 | 删除/清理/统计/保留/GC、数据根目录迁移与旧目录清理 | §6.6，资源引用与迁移校验 |
| B1.7 | §8.3 首批测试与 Electron 真机闭环 | 回归/故障注入/迁移与副屏验收记录 |

**验收**：新截图画箭头→保存首版→关窗/重开→选中旧箭头改色→保存→仍为一张卡片、第 2 版→再次重开一致；另存生成独立卡片；复制/地址/导出拿到已提交结果。注入保存失败后可继续编辑和重试；迁移并清除旧目录后同一文档仍可编辑。首批包含基础更新/分组/关闭保护，不能以"先新增重复条目"或"只写 JSON"替代；完整时间线可留到批次 3。

#### 批次 2 —— 「裁剪与撤销正确」（P0-P1，**4–5 人日**）

| 项 | 内容 |
|---|---|
| B2.1 | 基于首批内容快照完善裁剪/重划选区的撤销行为 —— U1 |
| B2.2 | 不可变结构共享、去重计量的点数/字节预算、按最旧完整步骤淘汰 —— U2 |
| B2.3 | 裁剪工具/手柄/比例锁定，多次修改 crop，标注源坐标始终不变 —— C1/C2/C3 |
| B2.4 | 220ms 域内合并 + 净零折叠 —— U3 |
| B2.5 | 渲染层埋点（首帧/pointer-frame/mosaic/undo/export）—— P1 |
| B2.6 | 完善 dirty 与撤销基线交互；可选草稿须接入同一资源/迁移/清理规则，单独估算 |

**验收**：反复裁剪→撤销/重做→保存重开，crop 与标注位置正确；8 万点场景撤销栈估算 ≤96 MiB，每个独立手势可单独撤销；4K 首帧按 §11.2 采样，不能只依赖 Node 快照基准。

#### 批次 3 —— 「版本浏览与编辑便捷性」（P1，**2–3 人日**）

| 项 | 内容 |
|---|---|
| B3.1 | 完整版本时间线、预览旧版本、显式恢复为新版本；展示保留策略导致的截断 |
| B3.2 | 列表双击/键盘进入、详情面板；基础编辑按钮保留可达 |
| B3.3 | 右键/长按快速选中、换工具选择行为；属性面板整体重构仍单独评估 |
| B3.4 | 对象级橡皮擦，效果预览与识别保护分离 —— E2 |

#### 批次 4 —— 「大图与识别」（P1-P2，**5–7 人日**）

| 项 | 内容 |
|---|---|
| B4.1 | mosaic 缓存 LRU + 降采样兜底 —— E3/P3 |
| B4.2 | 视口缩放/平移 —— P4 |
| B4.3 | 脏矩形重绘 —— P5 |
| B4.4 | 在首批护栏上完善超大图预览降级；分带导出未完成前不开放超过可完整导出上限的编辑 |
| B4.5 | 识别预缩放 + `maxSide` 可配置 + 取消 + 侧车常驻 —— R1/R2/R3/R4 |
| B4.6 | 导出分带 / Worker 编码 —— P8 |

#### 批次 5 ——（P2，独立评估）

内容感知擦除（E4）、属性面板重构（A7）、`blur` 双几何显式化（A6）、导出格式选项（JPG/WebP）、OCR 文本回写让搜索生效（F3）、识别走 stdin（R5）。

### 9.2 优先级判定依据

| 排序理由 | 说明 |
|---|---|
| 为什么先 B0 再 B1 | pin 几何可以复用，但事务、坐标和存储生命周期是新增工作；先固定契约，才能避免先存错格式再做第二次迁移 |
| 为什么默认更新/分组与关闭保护进入 B1 | 它们决定保存能否可信；没有成功确认、现场保护和单卡片语义，"可再编辑"尚未形成闭环 |
| 为什么 B2 早于 B3 | 基础版次与列表连续性已在 B1；随后先完善裁剪/撤销，再增加时间线和便捷编辑 |
| 为什么 E1（隐私）独立提前 | 当前识别绕过遮罩，应独立修复并检查实际入参像素，不依赖文档改造完成；后续接入同一源坐标合成逻辑 |
| 为什么 E4 独立立项 | 内容感知擦除是 ML 能力（源 ROI 重建），与"历史可再编辑"正交，塞进来会让本方案失控 |
| 为什么 P4/P5 排后面 | 二者服务"4K 精修"这一低频高价值场景；先有埋点（B2.5）才能证明它们值得做 |

### 9.3 本次修订固定的设计选择

| 决策 | 本方案口径 |
|---|---|
| 保存身份 | 稳定 documentId + 不可变 revisionId；更新移动 head，另存创建独立文档，来源关系不参与分组 |
| 图片真相 | 文档 + 底图 + 捕获附件决定可编辑内容；每版完整 result 是对外图片契约，不能只视为可丢弃的列表缓存 |
| 坐标与裁剪 | 源像素坐标；crop 改变导出范围，标注坐标不减原点；正逆映射与 DPR 分离 |
| 保存/导出 | 文档提交与外部文件导出分开确认；已有历史编辑默认不弹外部保存对话框 |
| 保留策略 | historyLimit 按文档计数，historyRevisionLimit 默认 20；共享底图按引用回收 |
| 兼容与失败 | 旧 PNG 不承诺还原矢量；新 doc 损坏只能显式退回完整 result，保存失败保留现场 |

这些是实施基线，不再把互斥模型并列为任选项。具体故障恢复实现与预算阈值由 B0 的验证调整，修改时同步 schema、动作表、测试与估算。

---

## 10. 风险与回退

| 风险 | 影响 | 缓解 |
|---|---|---|
| doc 损坏或未知 schema | 标注无法恢复、可能误用未打码底图 | 保存 schemaVersion 与格式标记；只用完整 result 显式进入仅位图恢复，无法恢复则报告损坏，不以 base 顶替 |
| 坐标归一化不完整 | DPI/窗口变化后偏移、线宽变化、重复裁剪累积误差 | 统一源像素坐标，覆盖所有长度字段；正逆变换与 crop 导出只做一次平移；跨 DPI 与重开测试 |
| 多文件发布中断/确认丢失 | 半写版本、假成功或重复 revision | 索引提交点、事务 manifest/备份恢复、requestId 持久幂等；逐步注入失败/退出 |
| base/result 混用 | 打开、复制、地址、导出未遮罩图片 | 统一结果解析函数，消费者全部回归；base 仅供编辑 |
| 生命周期或迁移漏资源 | 删除残留、底图被提前回收、迁移后无法编辑 | 资源引用集合、受控 GC、目录迁移后清旧目录再重开；版本保留与写入协调 |
| 文档体积失控（长笔迹点数） | 索引/磁盘膨胀 | doc ≤16 MiB、单条与总点数/字节预算、版本数上限；超限明确拒绝并保留现场，用户可选仅导出 |
| 撤销模型改动打红既有契约测试 | 阻断发布 | 逐文件先读测试再改；`capture-annotation-geometry.test.js` / `capture-multi-select.test.js` 是主要约束 |
| mosaic 降采样改变视觉 | 用户投诉 | 降采样只在超预算时启用；提供开关；真机视觉验收（不可只依赖 CI 的 §6.3 断言） |
| 侧车常驻与内存优化方向冲突 | 内存占用上升 | 默认关闭，作为"识别常开"设置项；与 B4.1 的内存收益对冲评估 |
| IPC 通道/权限/测试不一致 | 请求不可达或错误授权 | 同步注册、preload、allowlist、窗口会话校验、通道契约与安全探针，不用旧通道绕过断言 |

**回退策略**：B0 只交付契约与用例，不独立发布；B1 达成完整闭环后才可发布，B2–B4 各批独立验收。未开始新格式写入时可关闭入口并沿用旧行为；已经写入新格式后，只能停用新增编辑能力并继续用已提交 result 提供图片操作，不能把新数据交给不理解其生命周期的旧清理/迁移逻辑。应用版本回滚需保留完整数据备份并验证兼容路径；不作"docPath 缺失即完全等价于现状"的承诺。

---

## 11. 验收标准

### 11.1 交互验收（真机，副屏执行）

| 场景 | 通过标准 |
|---|---|
| 列表进入编辑 | 首批使用编辑按钮，批次 3 增加双击/Enter；窗口按工作区适配，图片比例正确；显式进入时获得一次输入焦点，不反复抢焦点，结束后恢复发起窗口 |
| 恢复文档标注 | 新格式文档重开后可点中上一版箭头并改色；刚打开时 Ctrl+Z 无变化，完成一次修改后 Ctrl+Z 回到打开状态，不跨到其它文档 |
| 存量 PNG | 原有像素完整保留，旧箭头不可单选的边界有说明；新画对象保存重开后可选中；取消编辑不改写旧记录 |
| 坐标/DPI | 同一文档跨 100%/150%/200% DPI 与不同尺寸窗口重开，crop、对象位置、笔宽和导出像素尺寸不漂移 |
| 裁剪 | 连续裁剪后底图与标注相对位置一致；Ctrl+Z/重做恢复 crop；标注源坐标始终不变，保存重开后一致 |
| 大点集 | 画 40 条长笔迹（各 1000 点）后连续撤销 30 次，不出现掉帧 >100ms 或内存 >300 MiB |
| 保存 | 默认不弹对话框；保存后列表该条**原地更新**、滚动位置不变、显示「第 2 版」 |
| 另存/无变化 | 另存生成独立卡片与首版，原文档不变；仅缩放/平移后保存不新增 revision |
| 关闭保护 | dirty 时所有关闭/替换入口都能协商；选"继续编辑"取消新会话，内容不丢；保存失败仍保持 dirty 和当前窗口 |
| 保存失败/重试 | 模拟磁盘满、rename/索引失败后旧 head 可读、现场可编辑；确认丢失重试只得到一个新版本 |
| 冲突/删除 | 会话 head 已旧或文档被删除时返回明确冲突/删除状态，可另存，不静默覆盖或复活 |
| 导出与图片消费者 | 已打码记录的打开/复制/地址/图片和 PDF 导出使用同版 result，地址仍复制路径；外部导出取消/失败不冒充文档提交失败或成功 |
| 目录迁移与清理 | 含版本/附件的历史迁移成功并清除旧目录后仍能编辑；删除、版本淘汰和清空后引用资源与空间统计一致 |
| 损坏恢复 | 删除/破坏 doc 或 base 后只在明确提示下使用完整 result 恢复；result 不完整且不能重建时不可用，不显示 base 冒充截图 |
| 失败可见 | 游戏模式下点编辑 → 明确 toast，不静默 |
| 识别隐私 | 新画 blur 覆盖区域在 OCR/翻译/表格/QR/转文档实际入参中为不透明遮罩，先遮罩再缩放，显示透明度预览不解除保护；用已知文字与二维码补充验证，不以单次识别结果代替像素校验 |

### 11.2 性能验收（`docs/performance/` 新基线）

| 指标 | 阈值 | 说明 |
|---|---|---|
| `capture.first-paint` | 1080p p95 ≤150ms；4K p95 ≤300ms | 现有测试只断言 <600ms（`test/capture-first-paint.test.js:113`），过松，不能当验收 |
| `capture.pointer-frame` | p95 ≤16.7ms、p99 ≤33ms | 60fps 预算 |
| `capture.mosaic-cache` | 30 条笔迹场景满足 pointer-frame 门槛，缓存实际字节不超配置预算 | 分别记录 hit/miss/eviction/downsample/重建耗时；LRU 可正常淘汰，不能只把 skipped 计数改成 0 就算通过 |
| `capture.undo-stack.estimateMiB` | ≤96 MiB | 去重计量共享对象/点集，另记实际进程峰值；不能按每帧重复累计共享数据，也不能只靠点数证明真实内存 |
| `capture.undo.cloneMs` | p95 ≤50ms | 实测 0.05–0.92ms，50ms 是含 GC 的宽松上界 |
| `capture.export.encodeMs` | 4K p95 ≤300ms | 待真机标定后收紧 |
| `ocr.startup` | median ≤250ms、p95 ≤600ms | 实测 median 207ms / p95 551.7ms，取 1.1x 用于抓回归 |
| `ocr.recognize` | 1080p p95 ≤1200ms | 实测 1920×1080 中位 773ms；≈1.5x 余量 |

> 阈值均为目标，尚非本次修订验证结果。在 `docs/performance/` 固化 OS/硬件/DPI/图尺寸/对象数/冷暖启动条件、原始样本、median/p95/max 与异常处理口径。至少 5 次仅作为冒烟采样；正式 p95 建议至少 30 次独立样本，pointer-frame 的 p99 至少收集 1000 帧。沿用 `summarizeSamples` 时记录分位数计算方法。首帧从用户动作计到渲染器可见可交互，不能用 mode:image 的主进程 captureMs 代替；渲染测试与 CI 基线分别记录。

---

## 12. 未验证项（不得当作已验证）

| 项 | 原因 | 需要什么 |
|---|---|---|
| 真实窗口首帧时间 / pointermove 帧间隔 / 掉帧 | 需 GUI 渲染进程 | 真机（副屏，按 `AGENTS.md` 约定） |
| PNG 编解码耗时、4K 导出主线程阻塞时长 | Node 无 Canvas | 真机或 Electron 探针 |
| IPC 结构化克隆大 buffer 的实际耗时 | 需真实跨进程 | 真机 |
| `window.prompt` 在 Electron 43.8.3 下是否可用（F2） | 无真机验证；测试用桩掩盖 | 真机确认（**可能是"文字工具完全不可用"的 P0 缺陷**） |
| `maxSide` 在真实截图上更快的**机制**（CRNN 入宽假说已闭合但不能排除其它因素） | 样本仅 5 张真实图 | 扩大真实样本；或在侧车加分段计时 |
| 60 帧 × 大点集快照的真实内存峰值 | 已用 Node `--expose-gc` 实测（367 MiB），但非真实渲染进程 | 真机 `app.getAppMetrics` |
| 新提交协议、原子索引与启动恢复 | 尚未实施；普通 rename 不等于多文件事务或断电持久化 | B0 验证存储能力，B1 故障注入与重启恢复 |
| 新资源的目录迁移、GC 与存量惰性升级 | 现有代码仅处理旧路径字段，修订仅补设计 | B1 迁移/删除用例与迁移后清旧目录的真机重开 |
| 识别输入遮罩的完整覆盖 | 原链路仍使用未标注图，本次未修改 | 独立修复后在各调用边界截获图片并验像素 |
| 内容感知擦除的可行性与成本（E4） | 完全未调研 | 独立立项前先做技术验证 |

---

## 13. 一页行动计划

| 顺序 | 做什么 | 人日 | 交付物 |
|---|---|---|---|
| 前置 | **单独 hotfix**：识别入口统一应用不透明隐私遮罩，核验实际输入（E1） | 1–2 | 修复 + 调用边界像素测试，不等待文档改造 |
| 前置 | 真机确认 `window.prompt`（F2）；若失效则文字工具修复升 P0 | 0.5 | 结论记录；修复工时确认后另估 |
| 0 | 批次 0：坐标/schema/身份/文件/提交/生命周期契约与故障用例 | 1–2 | 单一设计基线、夹具、失败矩阵与重新估算，不独立发布 |
| 1 | 批次 1：创建→编辑→确认提交→重开；基础更新/另存/列表连续性、关闭保护、迁移/清理 | 6–8 | 首个可发布闭环，保存失败现场可恢复，对外图片一致 |
| 2 | 批次 2：裁剪、完整步骤撤销、结构共享/预算、埋点 | 4–5 | 裁剪重开一致，撤销按用户动作，内存/帧耗时有测量 |
| 3 | 批次 3：版本时间线、旧版显式恢复、列表便捷入口、对象橡皮擦 | 2–3 | 可浏览版本与便捷编辑，基础保存能力无需等本批 |
| 4 | 批次 4：「大图与识别」（mosaic LRU + 缩放平移 + 脏区 + 识别链路） | 5–7 | 4K 可精修、识别可取消 |
| 5 | 批次 5 评估（内容感知擦除等） | — | 是否立项 |

**容量估算合计约 20–28 人日**（逐项相加 19.5–27.5，包含前置修复/确认与 B0–B4，不含 F2 确认后的修复、可选草稿、返工及批次 5）。保留原生脚本 + Canvas2D + 快照撤销路线；新增工作集中在源坐标、可信提交和数据生命周期。该估算不是排期承诺，B0 对存储恢复能力与几何改造范围验证后应更新。

交付按可审计目标拆分提交，每个提交附对应测试证据；某批内部可分多个提交，但 B1 的未闭合中间态不得单独发布。本文件本次只更新设计，未实现功能、未运行新增验收，也未把既有临时性能结果升级为真机结论。
