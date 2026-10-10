# 对标分析：Snow Apps（Snow Shot）能力差与 Highlighter 的功能补位优先级

- 日期：2026-10-10
- 基线：`master` @ `b97391e`（`package.json` 版本 **2.3.1**，`main.js` 1298 行 / 上限 1300）
  - **限定**：`b97391e` 是当时的 **HEAD 提交**；工作区**并不干净**（含 `selection-hook` 升级与构建产物改动），开工前须先完成 M-1，见对照方案 §1.2
- 状态：**分析已定稿，未开始编码**
- 性质：竞品对标 / 需求来源文档
- 范围：只做**能力对照与优先级排序**。不含具体技术设计（除 P0 已单独立项）
- 影响面：**零源码改动**；附 `.gitignore` 追加 3 行（忽略 `_repo_snow_apps/`，见 §1.3 与 §7 第 3 条）
- 落地方案：`docs/plans/2026-10-10-p0-gap-closure-plan.md`
- 相关代码：本次未改动任何业务代码

---

## 0. 结论摘要

Snow Shot 在**标注编辑深度、录屏完整度、贴图管理、原生能力（打印/OCR 版式/捕获控制）** 四个方向显著领先 Highlighter；但在 Highlighter 已建立优势的方向（AI 多供应商、划词工具栏、本地文件搜索、Everything 集成）Snow Shot **并不对标**。

结论：**不要全面对标，按"Electron 实现成本 × 用户感知强度"选点。**

- **P0（下一版补齐，7 项）**：i18n、光标进图、录屏音轨、打印/导出 PDF、标注二次编辑、贴图穿透接线、体验细节包。均为"低成本高感知"，且多数是硬空白而非优化。
- **P1（差异化立项，2 项招牌）**：本地 **Auto Filter 隐私打码**、**MCP 服务端**。这两项是 Snow Shot 真正难以被替代的能力，且 Highlighter 的技术栈（`onnxruntime-node` + Node MCP SDK）实现成本反而更低。
- **P2（延后）**：智能擦除、云上传、跨平台、贴图管理页、捕获排除名单。
- **明确不跟**：插件系统（Snow Shot 自己也没有）、自有云账号/服务端模型目录、Qt 级自研图像引擎。
- **许可证（2026-10-10 已选定）**：Highlighter 采用 **`GPL-3.0-or-later`**（路线 A）。这使得 `snow_shot/`（GPL）下的实现可以合法移植，P1 两项招牌的自研成本显著下降。**该决策目前只登记在本文档，`LICENSE` 等文件尚未创建**（§5.6）。

---

## 1. 对标对象与证据来源

### 1.1 对象概况

| 项 | 值 |
|---|---|
| 仓库 | [mg-chao/snow-apps](https://github.com/mg-chao/snow-apps) |
| 规模 | 5,681 star / 352 fork（2026-10-10 快照；初版记 5,663 为更早快照），C++/Qt 6.12 + Rust（静态 Qt、自研绘图引擎） |
| 平台 | Windows x64/ARM64、macOS 15+ arm64/x64；Full 与 Mini 双版本 |
| 许可 | **多许可**：`snow_shot/`、`snow_image*/` = GPL-3.0-or-later；`snow-crates/`、`ant_design_qt/`、`snow_draw_engine_qt/`、`snow_rust_ffi/` = Apache-2.0 |
| 节奏 | 2026-10-07 / 10-08 / 10-10 连发 1.2.4 / 1.2.5 / 1.2.6，周级迭代 |

### 1.2 三处"功能真相源"

Snow Shot 没有集中的功能清单，但有三处高置信度证据，本文档全部结论都从它们导出：

| 来源 | 路径（相对克隆根） | 价值 |
|---|---|---|
| 测试用例名 | `snow_shot/tests/*_tests.cpp`（**211 个**；初版"约 190"偏差约 11%） | 每个文件名即一个已交付功能；比 README 可信 |
| 功能域划分 | `snow_shot/i18n/modules.json` | 10 个域（core/settings/capture/annotation/export/recording/recognition/translation/history/updates）的模块级地图 |
| 扩展面契约 | `snow_shot/MCP.md` + `snow_shot/mcp-capabilities.json` | 101 个 MCP 工具，含输入输出 schema 与覆盖校验脚本 |

### 1.3 本地克隆说明

为完成本次对标，仓库被浅克隆到 **`_repo_snow_apps/`**（工作区根下，当前为 untracked）。它是**只读参考物，不应入库**：
- 建议 `git clean` 或加入 `.gitignore`（见 §7 待办第 3 条）；
- 所有 `snow_shot/...` 路径引用都相对该克隆根。

---

## 2. 能力差地图

图例：**空白** = Highlighter 完全没有；**弱** = 有但明显不足；**持平/领先** = 不需要动。

### 2.1 捕获

| 能力 | Snow Shot 证据 | Highlighter 现状 | 判定 |
|---|---|---|---|
| 智能选区（窗口 + 窗口内子元素两级吸附） | `snow_shot/include/snow_shot/presentation/screenshotintelligentselectionmodel.h:8` | 已有：`native/smart-select/Program.cs:64-119`（EnumWindows + UIAutomationElement）、`main/domains/capture/smart-select.js` | 持平 |
| 任意形状选区（矩形/折线/曲线/手绘，可加选减选挖洞） | `snow_shot/tests/screenshot_multi_region_tests.cpp:40-58` | 无 | 空白（P2） |
| 鼠标光标进图 | `snow_shot/include/snow_shot/presentation/screenshotcursorimagesource.h:8-41`、`snow-crates/crates/snow-capture/src/cursor_compositor.rs` | 无；**源码** grep `光标/includeCursor` 零命中 | **空白（P0-2）** |
| 捕获后端可选（Auto/DXGI/WGC/GDI） | `snow_shot/include/snow_shot/presentation/capture/screenshotcapturepolicy.h:8` | 无（固定走 `desktopCapturer` + `screenshot-desktop`，`main/domains/capture/index.js:90-138`） | 空白（P2） |
| 窗口捕获排除（`WDA_EXCLUDEFROMCAPTURE`） | `snow_shot/include/snow_shot/platform/windowcaptureexclusion.h:11` | 无（`main/services/diagnostics-service.js:371` 的 `excludes` 仅作用于诊断包） | 空白（P2） |
| 多屏混合 DPI 的物理/逻辑像素选择 | `snow_shot/include/snow_shot/presentation/screenshotstartupcontext.h:49-95` | 有 DPI 处理但无显式选择项 | 弱 |
| 颜色还原（反演系统放大镜滤镜 / HDR tone map） | `snow-crates/crates/snow-capture/src/color_effect.rs:81-124` | 无 | 空白（P2，场景窄） |

### 2.2 标注与编辑器

Snow Shot 的画布工具是全量枚举的 19 种 + 8 种滤镜，Highlighter 是 10 种且**提交后不可编辑**。

| 能力 | Snow Shot 证据 | Highlighter 现状 | 判定 |
|---|---|---|---|
| 工具总量 | `snow_draw_engine_qt/include/snow_draw_engine_qt/snow_canvas_types.h:24-46`（19 种） | `capture/capture.html:19-29`（10 种：矩形/椭圆/箭头/直线/画笔/高亮/马赛克/文字/序号/水印） | 弱 |
| **元素二次编辑**（多选/拖动/缩放/旋转/层级/对齐/分布） | `snow_canvas_types.h:152-168,719` | **无**：`capture/capture.js:669-670` 只有 `pop/push` 撤销重做，已提交标注无命中测试 | **空白（P0-5）** |
| 滤镜集 | `snow_canvas_types.h:208-217`（马赛克/高斯模糊/灰度/反色/浮雕/智能擦除/亮度/背景还原） | 仅马赛克（降采样像素化，`capture/capture.js:223-225`） | 弱（P1 局部跟） |
| 智能擦除（PatchMatch 内容感知填充） | `snow_draw_engine_qt/tests/snow_canvas_smart_erase.md` | 无 | 空白（P2） |
| **Auto Filter 一键隐私打码** | `snow_shot/src/presentation/tools/screenshotautofiltercontroller.cpp:14-15,326-330`（本地模型识别 text/text_in_box/image/avatar/icon/message_box/text_block） | 无 | **空白（P1 招牌）** |
| 标注模板（保存整套元素复用） | `snow_shot/src/storage/settingsadapters.cpp:2154-2184` | 无 | 空白（P1） |
| 取色器 + 放大镜 | `snow_shot/include/snow_shot/presentation/screenshotcanvascolorsampler.h:15-26` | 无 | 空白（P1） |
| 距离 / 角度测量 | `snow_canvas_types.h:331-399` | 无 | 空白（P1） |
| 结果样式（圆角 + 投影手柄） | `snow_shot/include/snow_shot/presentation/screenshotresultcompositor.h:18-25` | 无 | 空白（P1） |
| 文字粗斜体 / 颜色预设 / 序号数字制 | `snow_canvas_types.h:538-597` | 无 | 弱（P0-7 顺手） |
| 撤销/重做 | `snow_shot/include/snow_shot/presentation/canvashistoryshortcuts.h:26-35` | 已有 | 持平 |

### 2.3 长截图 / 滚动截图

| 能力 | Snow Shot 证据 | Highlighter 现状 | 判定 |
|---|---|---|---|
| **自动滚动**（间隔可调，默认 200ms） | `snow_shot/src/presentation/capture/screenshotscrollingcapturecontroller.cpp:147,240,797` | **无**：`long-capture/long-capture.js:261` 是 180ms 自动抓帧定时器，失败提示"请放慢滚动速度"在 **`:242`** | **空白（P1）** |
| 拼接失败归因 | `snow_shot/src/presentation/capture/screenshotscrollingpipeline.cpp:111-204` | 有拼接（`long-capture/matcher.js`）但无归因 | 弱 |
| 拼接后裁剪 | `snow_shot/src/presentation/capture/screenshotscrollingthumbnailwidget.cpp:537-542` | 已有裁前/裁后（`long-capture/long-capture.html:30-32`） | 持平 |
| 滚动诊断 | `snow_shot/SCROLLING_DIAGNOSTICS.md` | 无 | 空白（P2） |

### 2.4 OCR / 识别 / 翻译

| 能力 | Snow Shot 证据 | Highlighter 现状 | 判定 |
|---|---|---|---|
| OCR 引擎 | `snow_shot/include/snow_shot/presentation/screenshotocrassets.h:10-18`（7 档模型，RapidOCR/ONNX） | PaddleOCR v4 移动版 + Rust 边车（`native/ocr/src/main.rs:13-15,68`） | 持平（Highlighter 档位少） |
| GPU 加速（DirectML） | `snow_shot/src/presentation/settings/settingscatalog.cpp:2477-2483` | 无 | 空白（P2） |
| **OCR 结果原位叠加 + 逐行编辑** | `snow_shot/include/snow_shot/presentation/screenshotocrpresentation.h:12-25` | 有 overlay 展示（`capture/capture.js:545-554`）但只读；`recognition/recognition.html:25` `readonly` | 弱（P1） |
| 表格识别 | `snow_shot/include/snow_shot/presentation/screenshottabledocument.h:39-90`（可编辑、合并单元格、HTML 双 MIME） | 已有启发式重建（`main/domains/recognition/index.js:62-77`），只读 | 弱 |
| **公式识别 + LaTeX 渲染** | `snow_shot/include/snow_shot/presentation/screenshotlatexrenderer.h:12-32` | 无 | 空白（P1，可走 AI 视觉模型） |
| **图片转 Markdown / HTML** | `snow_shot/include/snow_shot/presentation/screenshotimageconversion.h:7-34` | 无 | 空白（P1，成本极低） |
| 二维码/条码 | `snow_shot/include/snow_shot/presentation/screenshotqrrecognitionservice.h:15-27` | 已有 jsQR 本地解码（`recognition/recognition.js:101-117`） | 持平（无条码） |
| **截图原地翻译（译文绘回原图）** | `snow_shot/tests/original_image_translation_tests.cpp` | 有 overlay 翻译（`capture/capture.js:545-554`）但无"译文像素导出" | 弱（P1） |
| 专业翻译供应商（DeepL/百度/有道） | `snow_shot/include/snow_shot/texttranslationconfiguration.h:16-20,75-81` | 仅 AI（`main/services/ai-providers.js`） | 弱（P2，非必须） |

### 2.5 录屏

| 能力 | Snow Shot 证据 | Highlighter 现状 | 判定 |
|---|---|---|---|
| **音轨（系统声 + 麦克风 + 独立增益）** | `snow_shot/tests/recording_audio_gain_popover_tests.cpp`、`snow_shot/src/storage/configurationschema.cpp:618-624` | **无**：`record/recording-utils.js:186` ffmpeg `-an`、`record/record.js:279` `audio: false` | **空白（P0-3）** |
| **剪辑 Trim** | `snow_shot/docs/recording-trimming.md` | 无（只有"重录"） | 空白（P2） |
| 编码/格式 | 格式支持见 `snow-crates/crates/snow-recording-export/src/codec.rs:22-26,37-45,89-91` 与 `animation.rs:29-146`（MP4 H.264/H.265 硬编、GIF、APNG、WebP）。**注**：初版误引 `codec.rs:340-371`，该区间实际只有硬件编码器选择 | 仅 MP4、crf 23/veryfast 硬编码（`record/recording-utils.js:183-196`） | 弱（P1 部分跟） |
| 质量/帧率可调 | `snow_shot/src/storage/configurationschema.cpp:626-694` | 帧率有（5/16/24/30/60），码率无 | 弱 |
| **光标高亮 / 点击涟漪 / 键盘叠加** | `snow_shot/src/presentation/recording/recordingeffectpreview.cpp:143-232` | 无（与 P0-2 同源） | 空白（P1） |
| 录制中标注 | `snow_shot/src/presentation/recording/screenrecordingtoolbarwindow.cpp:37-42` | 已有（`record/annotation-utils.js`） | 持平 |
| 录制排除自身控件 | `snow_shot/tests/window_capture_exclusion_tests.md:4-5` | 无 | 空白（P2） |

### 2.6 贴图

| 能力 | Snow Shot 证据 | Highlighter 现状 | 判定 |
|---|---|---|---|
| **点击穿透** | `snow_shot/tests/macos_pinned_windows.md:189-191` | **半成品**：`main/domains/pin/index.js:448-453` + `preload-pin.js:29` 已实现，但 `pin/pin.js`/`pin/pin.html` **无调用方**（死代码） | **空白（P0-6，接线即可）** |
| 缩放 / 透明度 | `snow_shot/src/presentation/pinned/screenshotpinnedwindow.cpp:499-501` | 已有：缩放 `pin/pin.js:117-121`、透明度四档 `main/domains/pin/index.js:389-397` | 持平 |
| 旋转/翻转/锁定 | `snow_shot/tests/pinned_multi_selection_manual.md:62-63` | 无 | 空白（P1） |
| **多选批量 + 对齐分布** | `snow_shot/src/presentation/pinned/pinnedwindowselectioncontroller.cpp:242-341` | 无 | 空白（P2） |
| **贴图组** | `snow_shot/src/presentation/services/pinnedwindowgroupmanager.cpp` | 无（仅全局显隐，`main/domains/pin/index.js:306-313`） | 空白（P2） |
| 贴图管理页/历史 | `snow_shot/tests/pinned_window_management_page_tests.cpp` | 无 | 空白（P2） |
| 资源管理器选中文件批量贴图 | `snow_shot/src/presentation/services/screenshotfilepinbatch.cpp` | 无 | 空白（P2，成本低） |
| 收纳到屏幕顶部 | `snow_shot/src/presentation/pinned/screenshotpinnedhidetotopcontroller.cpp` | 无 | 空白（P2，创意项） |

### 2.7 导出 / 打印

| 能力 | Snow Shot 证据 | Highlighter 现状 | 判定 |
|---|---|---|---|
| **打印（系统打印对话框）** | `snow_shot/src/presentation/services/screenshotprintservice.cpp`、`snow_shot/tests/native_print_manual.md:19-52` | **无**：**源码** grep `打印\|printToPDF\|window.print` 零命中（`docs/` 内的规划文档出现过这些词） | **空白（P0-4）** |
| **PDF 导出** | `snow_shot/src/presentation/services/screenshotpdfexport.cpp:190-426` | 无 | **空白（P0-4）** |
| 多格式保存（含 JXL/AVIF） | `snow_shot/tests/screenshot_export_dialog_workflow_tests.cpp` | **实际只写 PNG**（对话框过滤器仅 `png`，`main.js:859`；命名固定 `.png`，`capture-naming.js:15-19`）。`settings.screenshot.saveFormat`（`settings-defaults.js:34`）是**无消费者的死设置** | 弱 |
| 命名模板（手动/自动/录屏各一套） | `snow_shot/include/snow_shot/storage/settingsadapters.h:281-284,526-527` | 固定命名，`main/services/capture-naming.js` | 弱（P0-7） |
| 多格式剪贴板（PNG + DIB + 文件列表 + 自定义 MIME） | `snow_shot/src/presentation/services/screenshotclipboardplacement.cpp`（**修正**：初版漏了 `services/` 一层） | 基础剪贴板 | 弱（P2） |
| 云上传（S3 兼容） | `snow_shot/tests/cloud_upload_tests.cpp` | 无 | 空白（**不跟**，见 §4） |

### 2.8 平台与生态

| 能力 | Snow Shot 证据 | Highlighter 现状 | 判定 |
|---|---|---|---|
| **MCP 服务端（101 工具）** | `snow_shot/MCP.md`、`mcp-capabilities.json`、`tests/check_mcp_capabilities.py` | 无 | **空白（P1 招牌）** |
| **i18n（en_US / zh_CN / zh_TW）** | `snow_shot/i18n/modules.json`、`i18n/README.md` | **无**：界面硬编码中文（`capture/capture.html:2` `lang="zh-CN"`），`settings-defaults.js` 无 language 字段 | **空白（P0-1）** |
| 配置导入导出归档 | `snow_shot/src/storage/configurationarchive.cpp` | 无（`config/config.js:1651` 仅诊断包导出） | 空白（P1，成本低） |
| 自动更新 | `snow_shot/rust/snow-shot-updater/`（RSA-3072 签名信封 + 双渠道） | 已有：`main/services/update-service.js:200-204,330-349`，electron-updater 6.8.9，stable/beta 双通道 | **领先**（无需动） |
| 崩溃诊断 / 脱敏日志 | `snow_shot/src/diagnostics/crashcollector.cpp` | 已有诊断包导出与脱敏日志 | 持平 |
| 管理员启动 / 提权重启 | `snow_shot/src/platform/windows/administratorlaunch.cpp` | 无 | 空白（P2，场景窄） |
| 性能门槛进 CI | `snow_shot/tests/settings_page_performance.md`、`scripts/compare-settings-performance.py` | 有基准脚本（`scripts/benchmark-performance.js`）但**未进 CI 阈值** | 弱（P1 工程项） |
| 跨平台 macOS / ARM64 | `docs-macos-build.md`、`docs-windows-arm64-build.md` | 仅 Windows x64（`package.json:109-125`） | 空白（**不跟**） |
| 插件系统 | **Snow Shot 也没有** | 无 | 不适用 |

### 2.9 Highlighter 单项领先（无需对标）

| 能力 | 证据 |
|---|---|
| 多供应商 AI（OpenAI 兼容 + openai-responses） | `main/services/ai-providers.js`、`ai-protocol-adapters.js` |
| 划词工具栏 + 自定义 AI 动作 | `toolbar/`、`main/services/selection-*` |
| 本地文件搜索（Everything 三套实现） | `main/services/everything-service.js`、`native/everything-search/` |
| 编码计划一键预设 | `main/services/coding-plan-service.js`（v2.3.0） |
| 工程门禁密度 | 106 个单测 + 2 个 Playwright e2e + 覆盖率/架构/依赖三类门禁 |

---

## 3. 优先级排序

排序口径：**用户感知强度 ÷ Electron 实现成本**，并叠加"是否为硬空白"。

### P0 — 下一版补齐（7 项，详见 `docs/plans/2026-10-10-p0-gap-closure-plan.md`）

> **成本列口径（2026-10-10 修正）**：下表人日**一律取自对照方案的任务表加总**（`docs/plans/2026-10-10-p0-gap-closure-plan.md` §0.1），不再使用本节初稿的粗略估计 —— 初稿与本方案任务表存在 6 项冲突（合计 27–42 vs 实际 49.0），是 2026-10-10 独立审查发现的总账失真来源之一。

| # | 功能 | 类型 | 为什么是现在 | 成本（方案任务表加总） |
|---|---|---|---|---|
| P0-1 | 国际化 i18n | 硬空白 | 全量硬编码中文，是走向非中文用户的第一道墙；Snow Shot 用"按功能拆目录 + 发布时拒绝未完成翻译"证明了可行性 | **16.75 人日** |
| P0-2 | 鼠标光标进图 | 硬空白 | 教程/演示截图的高频刚需；Snow Shot 做成独立合成图层可开关。**本期仅截图链路**，录屏光标延期 | **6.0 人日** |
| P0-3 | 录屏音轨 | 硬空白 | README 自认无音轨；v2.3 路线图 §7.2 已列为候选；`ffmpeg-static` 已在依赖内 | **7.0 人日** |
| P0-4 | 打印 / 导出 PDF | 硬空白 | 源码 grep 零命中；Electron 原生 API 成本极低，Snow Shot 有完整对标 | **4.0 人日** |
| P0-5 | 标注二次编辑 | 弱→补强 | 画完不能改是最高频抱怨点；`capture/capture.js:669-670` 只有撤销重做 | **5.75 人日** |
| P0-6 | 贴图点击穿透接线 | 半成品接线 | IPC 与 preload 都已实现，只差 UI 入口，是"白捡" | **3.0 人日** |
| P0-7 | 体验细节包 | 分散弱项 | 快门音、快速保存/另存为快捷键、序号跨截图重置、Ctrl+A 选当前屏、命名模板 —— 每项都便宜且口碑好 | **6.5 人日** |
| | **批次 A（P0-4/P0-6/P0-7）** | | | **13.5** |
| | **批次 B（P0-3/P0-5/P0-2）** | | | **18.75** |
| | **批次 C（P0-1）** | | | **16.75** |
| | **七项合计** | | | **49.0** |

### P1 — 差异化立项（建议 v2.4 之后）

| # | 功能 | 理由 |
|---|---|---|
| P1-1 | **Auto Filter 隐私打码** ★ | Snow Shot 最具辨识度的能力（本地视觉模型按类别批量脱敏，`screenshotautofiltercontroller.cpp:14-15`）。Highlighter 已有 `onnxruntime-node` + Rust 边车经验，复用路径最短，且隐私场景是刚需 |
| P1-2 | **MCP 服务端** ★ | Snow Shot 用 Rust 桥暴露 101 个工具；Node 侧实现成本**低于** C++（`@modelcontextprotocol/sdk`）。战略价值：AI 客户端可直接驱动 Highlighter，与划词/AI 对话闭环 |
| P1-3 | 距离 / 角度测量 | Snow Shot 1.2.5、1.2.6 连续加码，验证了真实需求 |
| P1-4 | 截图原地翻译导出 | 已有 overlay 翻译，只差"译文绘回原图并导出像素" |
| P1-5 | 图片转 Markdown / HTML | 复用现有 AI 供应商，一个 prompt + 导出路径 |
| P1-6 | 长截图自动滚动 | v2.3 §7.2 已列候选，曾因 `native/scroll-driver` 回滚 |
| P1-7 | 贴图增强（旋转/翻转/锁定 + 管理页） | 与既有 `main/domains/pin/` 契合，可分版本消化 |
| P1-8 | 配置导入导出归档 | 换机/备份刚需，成本低 |
| P1-9 | 性能基准纳入 CI 阈值 | 把 `scripts/benchmark-performance.js` 的基线变成门禁 |

### P2 — 延后（记录，不排期）

智能擦除、任意形状选区、捕获后端可选、捕获排除名单、贴图组/多选/收纳顶部、资源管理器批量贴图、云上传、专业翻译供应商、GPU OCR、区域 OCR 编辑、跨平台、ARM64。

---

## 4. 明确不跟

| 项 | 理由（含 Snow Shot 自身证据） |
|---|---|
| 插件系统 | Snow Shot **自己也没有**：全仓无 plugin 入口，扩展面完全由 MCP 承担。Highlighter 走 MCP 一条线即可，不必背插件宿主 |
| 自有云账号 / 服务端模型目录 | Snow Shot 有 `tests/custom_server_settings_tests.cpp`、`snowshot_api_client`；但 Highlighter 的 BYO-Key 模式更轻、无隐私负担。仅在 MCP 选项里保留"本地 IPC"，不做服务端 |
| 云上传（图床） | `snow_shot/tests/cloud_upload_tests.cpp` 存在，但会引入运维与隐私面，与当前定位冲突 |
| Qt 级自研渲染引擎 | `snow_draw_engine_qt/` 是 Snow Shot 的核心资产，也是它 5 年工程量的来源。Electron 侧应走 Canvas + 原生边车，不重建引擎 |
| Snow Shot 式 Full/Mini 双版本 | 产品期过早；Highlighter 尚无安装基础 |
| 桌面全局画布（跨窗口绘制层） | `snow_shot/src/presentation/globalcanvas/globalcanvascontroller.cpp` 需要窗口级合成能力，Electron 实现代价不成比例 |

---

## 5. 许可证与法务约束（**动手前必读**）

### 5.1 对标对象的许可结构

snow-apps 是**多许可仓库**（`LICENSE.md`）：

| 目录 | 许可 | 可否复用 |
|---|---|---|
| `snow_shot/`、`snow_image/`、`snow_image_viewer/` | **GPL-3.0-or-later**（**但有例外，见下**） | 仅在 Highlighter 同为 GPL-3.x 时可移植代码；否则只能借鉴设计 |
| `snow-crates/`、`ant_design_qt/`、`snow_draw_engine_qt/`、`snow_rust_ffi/` | **Apache-2.0**（**ant_design_qt 有 MIT 图标 carve-out**） | ✅ 可作为依赖引入或参考，需保留 NOTICE；Apache-2.0 与 GPLv3 **兼容**，两者可共存于同一 GPLv3 项目 |
| `snow_memory/` | Apache-2.0（自带 LICENSE） | ✅。**注意：`LICENSE.md` 未列该目录**，属上游文档缺口，建议向上游提 issue |

**⚠️ GPL-3.0-only 例外（2026-10-10 独立审查发现，直接影响 P1）**

`LICENSE.md:7` 明示"除非文件或子目录另有声明"。实测存在三处**文件级 `GPL-3.0-only`**（非 or-later）：

| 文件 | 自述许可 |
|---|---|
| `snow_shot/rust/snow-shot-mcp/Cargo.toml` | **`GPL-3.0-only`** |
| `snow_shot/rust/snow-shot-updater/Cargo.toml` | **`GPL-3.0-only`** |
| `snow_shot/src/image/snowimageqtsrgbrowreader.h` | **`GPL-3.0-only`**（SPDX 行） |

**`snow-shot-mcp` 恰好就是 P1-2 最想移植的 MCP 服务端。** 这意味着：把 Highlighter 整体声明为 `GPL-3.0-or-later` 并纳入 `GPL-3.0-only` 代码，会让接收者无法对整体行使"或更高版本"的选择权 —— 属**越权声明**（口径细节**需法务确认**）。该项与 §5.4 的许可证字符串选择绑定，见 §5.4 的"待定项 α"。

**另注**：`ant_design_qt/THIRD_PARTY_NOTICES.md` 记录其同步的 Ant Design Icons 为 **MIT**（Copyright (c) 2018-present Ant UED），`LICENSE.md:33-35` 明确该第三方声明不被目录级许可覆盖 —— 引入时不可只按 Apache-2.0 处理。

### 5.2 本仓库的许可证现状（2026-10-10 实测）

| 事实 | 证据 |
|---|---|
| **仓库根没有任何 `LICENSE` / `COPYING` / `NOTICE` 文件** | 根目录文件枚举为空 |
| `package.json` **没有 `license` 字段** | `package.json` |
| GitHub API 报 `license: null` | <https://api.github.com/repos/SherUnlocked-4869/Highlighter> |
| **已经在分发一个 GPL-3.0 二进制**：`ffmpeg-static` 声明 `GPL-3.0-or-later`，且被 `asarUnpack` 打进安装包 | `node_modules/ffmpeg-static/package.json`、`package.json` 的 `asarUnpack` |
| **还分发一个 LGPL-3.0-or-later 组件**：`@img/sharp-win32-x64`（libvips）声明 **`Apache-2.0 AND LGPL-3.0-or-later`**，随 `sharp`（生产依赖）进入安装包 | `node_modules/@img/sharp-win32-x64/package.json` |
| 其余直接依赖多为宽松许可（`jsqr`/`openai` Apache-2.0、`dompurify` MPL-2.0 OR Apache-2.0、其余 MIT） | 同上 |

> **修正（2026-10-10 独立审查）**：本节初稿称"全量扫描 `node_modules` 后，唯一的 copyleft 依赖就是 `ffmpeg-static`"。该结论**已被证伪** —— `@img/sharp-win32-x64` 是 `Apache-2.0 AND LGPL-3.0-or-later`，`sharp` 是直接生产依赖且被 `main/services/long-capture-session.js:3` 引用。**当前 copyleft 依赖是两个**（GPL 一个、LGPL 一个），LGPL-3.0 自带告知、源码提供与"可替换重链接"义务，§5.6 已补 L15 专项。

> ⚠️ 这意味着**在决定本项目许可证之前，已经存在合规缺口**：分发 GPL-3.0 的 FFmpeg 与 LGPL-3.0 的 libvips，需要随包提供其许可证文本、源码获取方式（LGPL 还需说明可替换性），而当前 `README.md` 的"第三方资源"一节只列了 Bootstrap Icons（MIT）。**这与选哪种许可证无关**，无论最终选 MIT 还是 GPL 都要补。

### 5.3 已确认的产品口径（2026-10-10）

项目所有者确认：**Highlighter 是个人项目，可以完全开源，允许商用。**

需要澄清一个常见误解：**"允许商用"与 GPL 并不冲突** —— GPL-3.0 明确允许商业使用、允许收费。真正决定约束的是 **copyleft（是否要求衍生作品同样开源）**，不是价格。

因此 §5.1 表中"GPL 目录仅在 Highlighter 同样是 GPL-3.0-or-later 时可移植"这条限制，**不是**因为"要收钱"或"不能商用"，而是因为：**移植 `snow_shot/` 的 GPL 代码会使 Highlighter 整体必须以 GPL-3.0-or-later 分发并开放源码。** —— 这正是已选定路线 A 的直接后果，也是为什么选 A 之后 §5.5 的"不得转写"结论必须作废。

在此基础上，**2026-10-10 选定路线 A：`GPL-3.0-or-later`**（见 §5.4）。

> ⚠️ **本次决策只登记在本文档，未对仓库做任何变更。** 按所有者指示"先不变更"，以下内容**均未创建或修改**：`LICENSE`、`COPYRIGHT`、`THIRD_PARTY_NOTICES.md`、`package.json` 的 `license` 字段、`README.md` 的第三方资源一节、`scripts/check-licenses.js`。落地清单见 §5.6，待明确开工指令后执行。

### 5.4 路线选择（**已选定路线 A**）

| | **路线 A：GPL-3.0-or-later**（✅ 2026-10-10 选定） | **路线 B：MIT / Apache-2.0**（未采纳） |
|---|---|---|
| 商用 | ✅ 允许 | ✅ 允许 |
| 可移植 `snow_shot/`（GPL）代码 | ✅ 可以（整体随之 GPL） | ❌ 不可以 |
| 可复用 `snow-crates/`（Apache-2.0） | ✅ 可以 | ✅ 可以（保留 NOTICE） |
| 与已分发的 GPL FFmpeg | ✅ 天然一致 | ⚠️ 仍须单独合规（见 §5.2） |
| 衍生作品必须开源 | ✅ 是 | ❌ 否 |
| 将来改为闭源/双许可 | 需全部版权人同意（个人项目自持版权则可） | 可行 |
| 对 P1 的影响 | Auto Filter 与 MCP 可直接借鉴/移植 Snow Shot 实现 | 两项都需**自研**（协议与思路可用，代码不可抄） |

**选定路线 A（许可族为 GPL-3.x）**，理由：

1. 所有者已确认"完全开源、允许商用" → GPL 不构成任何障碍（GPL 明确允许商业使用与收费）；
2. 已经在分发 GPL-3.0 的 FFmpeg，项目本就与 GPL 世界绑定，选宽松许可反而制造"我的代码宽松、我发的二进制却更严"的割裂；
3. P1 的两项招牌能力都有 Snow Shot 的成熟实现：`visual-region-detector` 在 Apache-2.0 的 `snow-crates/`（两条路线都能用），而 **MCP 服务端在 `snow_shot/`（GPL）** —— 选 A 能显著降低自研成本；
4. Snow Shot 同为截图工具且是 GPL-3.0，许可一致可避免用户与贡献者的许可证困惑。

**⚠️ 待定项 α（2026-10-10 独立审查提出）**：许可字符串究竟写 **`GPL-3.0-or-later`** 还是 **`GPL-3.0-only`**？

- §5.1 发现 `snow_shot/rust/snow-shot-mcp/` 与 `snow-shot-updater/` 是 **`GPL-3.0-only`**。若 Highlighter 声明 `or-later` 并纳入这两个模块，接收者无法对整体行使"或更高版本"的选择权 → **越权声明**。
- **建议改为 `GPL-3.0-only`**（见对照方案 §13.2 的 F1-①）：与最想移植的 MCP 模块一致，避免混合授权口径；代价是放弃向下游提供"或更高版本"的选项。本决策**未定**，L3 的许可证字符串因此暂不写死。
- **口径需法务确认**（"or-later 项目包含 -only 文件"的合规性在实务中通常被避免，但并非绝对禁止）。

**选定路线后对 P1 的直接解锁**：`snow_shot/` 下的实现（含 `src/app/mcp/`、`screenshotautofiltercontroller`）从"只能借鉴设计"变为"可移植/可逐行参照"。**但 `rust/snow-shot-mcp/` 是 `GPL-3.0-only`**，移植它会把待定项 α 从"可选"变成"必须解决"。

> **前提修正（独立审查）**：§5.3 的"已开源、已允许商用"是**所有者意向**，而 §5.2 已证明仓库当前**未对外授予任何许可**（无 LICENSE、GitHub `license: null`）。因此在本节 L1–L3 落地**之前**，把 GPL 代码抄入本仓库**不构成合规** —— 许可文件必须先落地。

### 5.5 "借鉴"与"移植"的分界（**按已选定路线 A 修正**）

> ⚠️ **本节此前写着"无论选哪条路线都适用"，并给出"不要复制粘贴或逐行转写"的结论。该结论只在路线 B（宽松许可）下成立。** 路线 A 选定后，"移植"是允许的，只是附带 GPL 义务。此处按路线修正，以消除与 §5.4 的口径冲突（2026-10-10 旁路观察者指出）。

#### 5.5.1 通用原则（两条路线都成立）

- **不受版权保护**：功能、交互设计、算法思路、协议、界面布局，以及"Snow Shot 能做所以我也做"这件事本身 → **看懂后独立实现永远合法**。
- **受版权保护**：具体源码表达。把 C++ 逐行改写/翻译成 JS 属于**衍生作品**（derivative work）。
- 两条路线的差别只在"衍生作品**能不能做、要付什么代价**"，不在于"思路能不能用"。

#### 5.5.2 路线 A（已选定）：可以移植，但必须履行 GPL-3.0 义务

`_repo_snow_apps/snow_shot/` 下的实现（如 `src/app/mcp/`、`src/presentation/tools/screenshotautofiltercontroller.*`）**可以移植、改写、逐行参照**（`rust/snow-shot-mcp/` 另有 `GPL-3.0-only` 限制，见待定项 α）。代价是五项义务：

| # | 义务 | GPLv3 依据 | 落地动作 |
|---|---|---|---|
| **O1** | **保留原作者的版权声明、许可证声明，以及"无任何担保"声明**，不得删除或淡化 | §4、§5(b) | 移植文件头部保留 `Copyright (C) mg-chao` 与 GPL 声明；许可证副本与无担保段随包提供（对照 `snow_shot/COPYRIGHT:9-11`） |
| **O2** | **被修改的文件须加显著改动说明与日期** | §5(a) | 移植文件头加"Portions ported from Snow Shot (GPL-3.x), modified 2026-XX-XX" |
| **O3** | **整个作品（as a whole）同样以 GPL-3.x 分发** | §5(c) | 与落地清单 L3 的 `package.json` 许可证字段一致。注意 §5(c) 说的是**整个作品**，不是"衍生文件" |
| **O4** | **交互式界面须展示 Appropriate Legal Notices** | §5(d) | **Highlighter 的 About 页（`config/config.js` 的 `renderAbout`，`:1737`）目前只显示版本与更新信息，需新增许可区块** |
| **O5** | **以非源码形式分发（安装包 / portable）时须提供对应源码** | **§6**（初版完全遗漏） | 在发布页固定源码地址 + 提供 3 年书面要约（或 §6(d) 的等价网络访问），并在 About 页给出入口 |

> **O4 的条件推理已修正（独立审查）**：初版写"Snow Shot 在 About 页展示了法律声明，条件已满足"。核实后：`about_page_tests.cpp:902-906` 只断言 `aboutLicense` 的文本**包含许可证名称字符串**；版权在另一个控件（`aboutpagewidget.cpp:853-854`），且**未找到"如何查看许可证副本"的入口**。因此上游展示的是**不完整**的法律声明。
>
> **但 O4 的结论仍然成立**，理由要换成：§5(d) 的条件是"若原程序在交互界面展示 Appropriate Legal Notices，则衍生作品也必须展示"。上游**确实展示了**（哪怕不完整），因此 §5(d) 后半句的豁免**不适用** —— Highlighter 必须展示，且应比上游**更完整**（四要素：版权 / 无担保 / 可依本许可传播 / **如何查看副本**）。
>
> **对 L10 的影响**：`aboutLicense` 这个样板**不达标**，不能照抄；L10 需补齐四要素。
>
> **口径提醒**：GPLv3 §0 对 "Appropriate Legal Notices" 的定义还含"**显著且便于访问**"这一形式要件，文档简写为"四项内容"，实施时以法条原文为准。

> **O5 是初版最大的义务遗漏**：安装包与 portable 都是**非源码形式分发**，GPLv3 §6 要求同时提供 Corresponding Source。初版只为 ffmpeg 提了"源码获取方式"，**没给 Highlighter 自己设任何条目**。

#### 5.5.3 混合 Apache-2.0 代码

`snow-crates/`（Apache-2.0）可与 GPLv3 共存（Apache-2.0 与 GPLv3 **单向兼容**：Apache→GPLv3 可，反向不可），但仅"保留 NOTICE"是不够的，须同时满足 Apache-2.0 §4：

- §4(b)：**被修改的文件**加显著改动声明；
- §4(c)：保留全部版权、专利、归属与免责声明；
- §4(d)：若上游有 `NOTICE` 文件，**随附其内容**；
- 另需注意 Apache-2.0 §3 的**专利终止条款**与 GPLv3 §11 的相容性，以及 GPLv3 §10 禁止"附加限制"（further restrictions）。

> 以上相容性分析**需法务确认**。另：Apache-2.0 与 **GPLv2 不兼容** —— 若将来引入 GPLv2-only 组件会踩雷。
>
> `ant_design_qt/` 的 **Ant Design Icons 是 MIT**（见 §5.1 注），引入该目录时须一并保留其 MIT 声明。

#### 5.5.4 路线 B（**未采纳**，备查）

若将来改用宽松许可：`snow_shot/`（GPL）代码**不得**复制或逐行转写，只能借鉴思路后独立实现；`snow-crates/`（Apache-2.0）仍可引入（保留 NOTICE）。

### 5.6 待执行的落地清单（**已规划，尚未执行**）

> 状态：**未执行**。2026-10-10 所有者指示"写到文档里，先不变更"。以下为开工时的执行清单，逐条勾选。

| # | 动作 | 目标文件 | 状态 |
|---|---|---|---|
| L1 | 添加 GPL-3.x 全文（674 行逐字文本；**建议从 gnu.org 取正本并以哈希锁定**，不要依赖第三方副本；GPL 文本本身允许逐字复制分发，但**不允许修改**） | `LICENSE`（新） | ⬜ 待执行 |
| L2 | 添加版权声明。参照 `_repo_snow_apps/snow_shot/COPYRIGHT` 的**完整结构**（初版只提了两项，实际应含：程序描述行、版权年与版权人、GPL 授权段、无担保段、SPDX-License-Identifier 行、第三方声明不被覆盖句）。**版权人署名待你确认** | `COPYRIGHT`（新） | ⬜ 待执行 |
| L3 | `package.json` 补 `"license"`。**字符串待定**：`GPL-3.0-or-later` 还是 `GPL-3.0-only`（见 §5.4 待定项 α，建议 `-only`） | `package.json` | ⬜ 待执行 |
| L4 | 新建第三方许可清单。**初版范围过窄，已扩**：① 随包分发的**二进制与原生组件** = `ffmpeg-static`（GPL-3.0，附许可证文本 + 源码获取方式）、`@img/sharp-win32-x64`/libvips（**LGPL-3.0，见 L15**）、`native/smart-select/SmartSelect.exe`、`native/ocr/**`（sidecar + dll）、`native/everything-search/bin`、`native/everything/Everything.exe` + `Everything.ini`、`ocr/models/*.onnx`、Bootstrap Icons（MIT）；② 运行时依赖按**生产闭包**（实测约 131 个包）生成，而非手写。注意生产闭包内含非 MIT 项：`argparse`(Python-2.0)、`sax`(**BlueOak-1.0.0**)、`fast-uri`(BSD-3)、`json-schema-typed`/`webidl-conversions`(BSD-2)、`graceful-fs`/`inherits`/`semver`(ISC)、`type-fest`(MIT OR CC0-1.0)、`dompurify`(MPL-2.0 OR Apache-2.0，**建议注记择定 Apache-2.0**) | `THIRD_PARTY_NOTICES.md`（新） | ⬜ 待执行 |
| L5 | `README.md` 的"第三方资源"一节从"只有 Bootstrap Icons"改为指向 `THIRD_PARTY_NOTICES.md` | `README.md` | ⬜ 待执行 |
| L6 | 增加许可门禁。**初版口径过窄，已改**：以**生产依赖闭包（约 131 包）**为校验集合，而非仅 `package.json` 的 10 个直接依赖；并对 BlueOak/CC0/双许可项记录"择定哪一支" | `scripts/check-licenses.js`（新）、`package.json` scripts | ⬜ 待执行 |
| L7 | 补契约测试。**初版只锁 L1–L3 形状，不足以拦住 B1/B4 类问题**，应加：`LICENSE` 是**未被改动**的标准文本（哈希比对）；**打包产物内确实含** `LICENSE`/`COPYRIGHT`/告知文件；`THIRD_PARTY_NOTICES.md` 覆盖实际分发集合；About 页 §5(d) 四要素存在性 | `test/license-contract.test.js`（新） | ⬜ 待执行 |
| L8 | 复核 `native/everything/Everything.exe`（voidtools Everything）的**再分发条款**——它是随安装包分发的第三方免费软件，是否允许随商业安装包再分发需确认；`Everything.ini` 与 `native/everything-search/bin` 的存在形式一并覆盖 | 调研项 | ⬜ 待执行 |
| L9 | 制定**移植署名规范**并纳入代码审查：移植文件保留原作者版权与无担保声明（O1）+ 加显著改动说明与日期（O2）+ 整个作品以 GPL-3.x 分发（O3）；随附 `docs/` 规范或 PR 模板 | 新规范文档 + 受影响源文件 | ⬜ 待执行 |
| L10 | **About 页新增 Appropriate Legal Notices 区块**（版权、无担保、可依本许可传播、**如何查看副本**四要素），满足 GPLv3 §5(d)（O4）。**注意**：`snow_shot` 的 `aboutLicense` 样板**不达标**（缺"如何查看副本"，版权另在别的控件），不可照抄 | `config/config.js` 的 `renderAbout`（`:1737`） | ⬜ 待执行 |
| **L11** | **（新增）§6 源码提供义务**：为 Highlighter 自身的 object code 分发设定 Corresponding Source 路径 —— 发布页固定源码地址 + 3 年书面要约（或 §6(d) 等价网络访问），并在 About 页给出入口 | 发布流程 + `THIRD_PARTY_NOTICES.md` + About 页 | ⬜ 待执行 |
| **L12** | **（新增）许可文件必须进成品**：`build.files` 是白名单，当前**不含** `LICENSE`/`COPYRIGHT`/`THIRD_PARTY_NOTICES.md`，`extraResources` 也没有 → 根目录放 LICENSE **不会**随安装包分发，§4"随许可副本"在二进制路径上不成立。须把三者纳入 `build.files`/`extraResources`（或在 About 页内嵌渲染），并加打包后断言 | `package.json` 的 `build.files`、`scripts/verify-release.ps1` 同层脚本 | ⬜ 待执行 |
| **L13** | **（新增）追溯合规盘点**：盘点历史 release 中 ffmpeg 等 GPL/LGPL 组件的告知与源码说明状态，决定是否补发说明或公告。**明确"补 LICENSE 不溯及既往"** | 调研项 + `docs/releases/` 记录 | ⬜ 待执行 |
| **L14** | **（新增）权利链核对**：确认全部历史提交为自持版权（有无外部 PR / 共同作者），据此决定 L3 是否有权声明 `or-later`。若为 `-only` 混合，L3 与 L10 的措辞须相应收敛 | 调研项（`git log` + 贡献者清单） | ⬜ 待执行 |
| **L15** | **（新增）LGPL-3.0 专项**（`@img/sharp-win32-x64` / libvips）：落实许可文本随附、源码获取方式、以及**可替换/重新链接能力**的说明 | `THIRD_PARTY_NOTICES.md` + 说明文档 | ⬜ 待执行 |
| **L16** | **（新增）附加条款与专利复核**：核查上游是否附 GPLv3 §7 附加条款（若有须按 §7 末段在源文件中声明并保留）；复核 Apache-2.0 §3 专利终止与 GPLv3 §11、§10"不得附加限制"的相容性 | 调研项 | ⬜ 待执行 |

> **与许可证选择无关、无论如何都要做**：L4、L5、L8、L12、L13、L15（当前零 NOTICE 状态下，GPL 与 LGPL 两个组件的告知义务已经存在）。
> **路线 A 特有**：L1–L3、L6、L7、L9–L11、L14、L16。一旦开始移植 `snow_shot/` 代码，**O1–O5 必须同时成立**，任一项缺失都会让整个作品的合规性不成立。
> **前置顺序**：**L1–L3 必须早于任何移植动作** —— 在无 LICENSE 的仓库里抄入 GPL 代码不构成合规（见 §5.4 前提修正）。
> **M4 门禁**：P1 立项（Auto Filter / MCP）**须以"L1–L3 + L9 + L10 已落地"为前置门**，而非"正式发布前建议复核"。

> **免责声明（上移至本节开头，并适用于 §5 全节）**：本节为工程侧许可分析，**不构成法律意见**。文中所有确定性表述（"可以合法移植""GPL 允许商用""Apache-2.0 与 GPLv3 兼容""功能/思路不受版权保护""看懂后独立实现合法"）均为**工程侧通行理解**，个别结论涉及可专利性、外观设计与商标等维度，**需法务确认**。正式发布前必须由熟悉 GPL 的专业人士复核。

---

## 6. 与既有路线图的关系

本分析**不替代也不打断** `docs/plans/2026-09-10-v2.3-architecture-roadmap.md` 的架构减负主线（Phase A–E 已完成，`main.js` 1298/1300）。关系如下：

- v2.3 路线图 §7.2 已列出 6 项功能候选，本分析**确认其中 3 项在 Snow Shot 有成熟实现可参考**：录屏音轨（→ P0-3）、长截图自动滚动（→ P1-6）、剪贴板兼容模式（→ 见 §2.7）。其余三项（本地搜索预览面板、OCR 历史全文搜索、AI 重试退避）Snow Shot **无直接对标**。**修正**：初版称"确认其中 4 项"，与逐项列举不符。
- **硬约束**：`main.js` 仅剩 **2 行**余量（1298/1300，`scripts/check-architecture.js:18`）。P0 全部改动**不得写入 `main.js`**，一律落在 `main/domains/<域>/`、`main/services/`、渲染层模块与设置默认值中。
- Phase D2（`config/routes/*.js` 拆分）尚未完成，而 P0-1（i18n）与 P0-7（新设置项）都要动设置页——已在本期立项为独立前置工程（`config/config.js` 实测 1829 行，剩余拆分 **3.75–6.5 人日**，含 15 个测试文件的源码断言解耦），详见 `docs/plans/2026-10-10-p0-gap-closure-plan.md` §3.4 与决策 D8。

---

## 7. 后续动作

| # | 动作 | 负责方 | 状态 |
|---|---|---|---|
| 1 | P0 七项实施方案与任务拆解 | —— | ✅ 见 `docs/plans/2026-10-10-p0-gap-closure-plan.md` |
| 2 | P1 立项（Auto Filter / MCP） | 待定 | ⏳ 待技术预研；**License 族已定（路线 A）**，但**许可证字符串待定**（`or-later` vs `only`，见 §5.4 待定项 α 与方案 §13.2 F1-①）；L1–L3 + L9 + L10 落地后即可启动 |
| 3 | **清理 `_repo_snow_apps/`**：加入 `.gitignore` 或直接删除 | —— | ✅ 已加入 `.gitignore`（2026-10-10）；克隆仍在磁盘，确认不再需要后可删除 |
| 4 | 确定 Highlighter 的 License | 产品决策 | ✅ **路线 A 已选定（2026-10-10，GPL-3.x）**；口径为"个人项目、完全开源、允许商用"（§5.3）。**字符串待定**（§5.4 待定项 α）。**仅登记在文档，落地未执行**（§5.6） |
| 5 | 补齐第三方许可合规 | 工程 | ⏳ **与 License 选择无关的既有缺口**：已分发 GPL-3.0 的 `ffmpeg-static` **与 LGPL-3.0 的 `sharp`/libvips**，但仓库无任何 NOTICE/LICENSE 文件。执行清单见 §5.6 的 L4/L5/L8/L12/L13/L15 |
| 6 | 确认 `config/routes/*.js`（Phase D2）排期 | —— | ✅ 已立项为独立前置工程 **D8 / Wave 8.5**，3.75–6.5 人日（`2026-10-10-p0-gap-closure-plan.md` §3.4） |
| 7 | **提交本文档** | —— | ⏳ 两份文档当前均为 **untracked**（`??`）；`.gitignore` 中忽略 `_repo_snow_apps/` 的注释指向本文档，**不提交即形成悬空引用**。建议与方案文档、`.gitignore` 一次提交 |

---

## 8. 证据索引（本文档之外的可信来源）

- 版本与节奏：<https://github.com/mg-chao/snow-apps/releases>
- MCP 能力契约：`_repo_snow_apps/snow_shot/MCP.md`、`snow_shot/mcp-capabilities.json`
- 功能域地图：`_repo_snow_apps/snow_shot/i18n/modules.json`
- 功能证据（**211 例**）：`_repo_snow_apps/snow_shot/tests/*_tests.cpp`
- 许可证：`_repo_snow_apps/LICENSE.md`、`snow_shot/LICENSE`、`snow_shot/COPYRIGHT`
- 官网功能宣称：<https://snowshot.top>

---

## 9. 确认记录（2026-10-10）

| # | 你的答复 | 落点 |
|---|---|---|
| 1 | 旁路观察者指出"§5.4 放行移植、§5.5 仍写不得转写"自相矛盾 | §5.5 整节按路线 A 重写（拆为 5.5.1–5.5.4）；同轮修掉 §5.3 对已改表列的失效引用 |
| 2 | "如果你指的是开源协议，这个项目是我个人项目，可以完全开源，允许商用" | §5.3 产品口径；§5.4 路线 A 的前提 |
| 3 | "写到文档里，先不变更" | §5.3 未变更提示框、§5.6 状态列、§7 第 4 条 |
| 4 | "选路线 A" | §5.4 路线选择（GPL-3.x）；**但字符串 `or-later`/`only` 随后由独立审查提出待定（§5.4 待定项 α）** |
| 5 | "按 F2–F7 执行修复，给出 F1 建议" | 本文件：§5 全节按独立审查修正（GPL-3.0-only 例外、sharp/LGPL、O1–O5、L4/L6/L11–L16、免责声明上移）、§3 成本列对齐方案任务表、§6/§7/§8 事实修正；F1 建议见方案文档 §13.2 |

**状态**：分析已定稿；**F2–F7 修复已执行**；**F1 三项建议待确认**（方案 §13.2）；许可证相关文件**未创建**（按"先不变更"）。

---

## 10. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| **在无 LICENSE 的仓库中抄入 GPL 代码** | **高** | L1–L3 必须先于任何移植动作；M4 门禁以"L1–L3 + L9 + L10 已落地"为前置 |
| `GPL-3.0-only` 例外导致越权声明 | **高** | 待定项 α；建议改 `GPL-3.0-only`（方案 §13.2 F1-①），或绕开 `rust/snow-shot-mcp/` 改为自研 |
| 已在分发的 GPL FFmpeg 与 LGPL libvips 零告知 | **高** | §5.6 的 L4/L12/L15；与许可证选择无关，须独立完成 |
| 许可文件不进安装包（`build.files` 白名单） | **中** | L12：显式纳入 `build.files`/`extraResources` 并加打包后断言 |
| 移植时漏履行 O1–O5 任一项 | **中** | L9 移植署名规范 + L7 契约测试；代码审查清单 |
| 历史 release 追溯义务 | 低 | F1-③：轻量盘点 + 只补最新版 + 旧版公告 |
| 本分析与 P1 预研脱节（P1-2 的 MCP 工作量随 α 决策浮动） | 中 | F1-① 定案后再启动 P1-2 的估算 |
| 本文档与方案文档未提交，`.gitignore` 注释悬空 | 低 | §7 第 7 条 |
