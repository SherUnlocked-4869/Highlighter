# R0-06 PDF 后端小样（r0-pdf-spike）

日期：2026-11-10（Asia/Hong_Kong）；**2026-11-11 增补 §8：产品真实 `capture/print.html` 双后端复验**。
状态：**R0 证据文档（草案，不是 gate 通过证据）**；ADR-0003 仍为候选、未冻结，**不构成 G0 通过证据**。
上位文档：[Rust 改造方案与开发计划](../2026-11-10-rust-migration-development-plan.md) §4.3/§5.1/§7 R0-06/§8 G0、
[R0 基线](r0-baseline.md) §4.5（PDF 后端决策，当前"待验证"）。
本文件为 **ADR-0003（PDF 后端）** 的实测证据；结论只作为候选建议，未冻结。

## 1. 背景与问题

R4-07 要求把现有"截图/贴图/识别结果 → PDF"链路从 Electron 迁到 Rust 宿主。现有实现
`main/services/pdf-export.js` 用隐藏 `BrowserWindow` 加载 `capture/print.html`，再
`webContents.printToPDF`（`pageSize` 单位实测为英寸，`margins: none`，`preferCSSPageSize: false`；
见 `pdf-export.js:22-30`）。迁移的候选后端是 WebView2 打印
（`ICoreWebView2_16::PrintToPdfStream`），本小样回答三个问题：

1. 同一份 HTML 用 WebView2 与 Electron 打印，页数/纸张/字体/文字/透明元素是否等价？
2. 纸张单位、边距、CSS `@page` 的作用顺序与失败分支是什么？
3. 中文字体是否嵌入、PDF 文字是否可搜索（决定"可复制/可检索"是否成立）？

若 WebView2 打印不满足，计划允许转原生 PDF 生成并重估 R4-07（见 r0-baseline §4.5 失败分支）。

## 2. 实测条件与命令

### 2.1 环境

| 项 | 值 |
|---|---|
| OS | Windows 11 专业版 10.0.26300（build 26300.9711） |
| WebView2 Runtime | `157.0.4341.42`（Tauri `webview_version()` 实测） |
| Electron | `43.8.3`，Chromium `150.0.7871.250`，Node `24.22.0` |
| Tauri / wry / webview2-com | `2.12.5` / `0.57.2` / `0.39.1`（webview2-com-sys 同版本） |
| rustc / cargo | `1.97.1` |
| 显示器 | 主屏 3840×2160@150%；副屏 (3840,-170) 1440×2560@125%（PDF 窗口全隐藏，不使用可见窗口） |
| PDF 文字工具 | 本机**没有** `pdftotext`/`mutool`/`qpdf`，系统 Python 也没有 pypdf；因此把 `pypdf 7.0.1` 安装到 gitignore 的 `.tmp-r0-pdf/pylibs`（`pip install --target`，不加进仓库依赖） |

### 2.2 触发命令（仓库根目录）

```bash
# WebView2 侧：隐藏窗口 + PrintToPdfStream 矩阵，产物/报告写 .tmp-r0-pdf/
CARGO_TARGET_DIR='F:/workspace/Highlighter/rust-app/target' \
  cargo build --manifest-path rust-app/prototypes/webview-pdf-resource/Cargo.toml
./rust-app/target/debug/highlighter-r0-pdf-resource.exe --pdf \
  > .tmp-r0-pdf/logs/webview2-pdf-run3.log 2>&1

# Electron 侧对照（AGENTS.md 两个陷阱：清 ELECTRON_RUN_AS_NODE；--no-sandbox 必须在脚本路径前）
env -u ELECTRON_RUN_AS_NODE \
  TMP="$PWD/.tmp-r0-pdf/tmp" TEMP="$PWD/.tmp-r0-pdf/tmp" \
  node_modules/electron/dist/electron.exe --no-sandbox scripts/rust/probe-electron-pdf.js \
  > .tmp-r0-pdf/logs/electron-probe-run3.log 2>&1

# 对比分析（pypdf；输出 .tmp-r0-pdf/analysis.json）
PYTHONPATH=.tmp-r0-pdf/pylibs PYTHONIOENCODING=utf-8 \
  python .tmp-r0-pdf/analyze_pdfs.py
```

原型是独立 Cargo 工程（`rust-app/prototypes/webview-pdf-resource/` 自带空 `[workspace]` 表），
不改主 workspace `rust-app/Cargo.toml` / `Cargo.lock`。`CARGO_TARGET_DIR` 只是复用已编译依赖，
产物目录不入库。

### 2.3 合成样例（同一份 HTML，两个后端各自加载）

`rust-app/prototypes/webview-pdf-resource/prototype-ui/`：

| 文件 | 内容 |
|---|---|
| `print-sample.html`（23,248 B） | `@page { size: A4; margin: 0 }`；中文标题/段落、30 行跨页表格、内嵌 PNG（400×220，data URI，11,103 B）、不透明/半透明/无背景三块、4 个可检索中文标记、跨页填充段落；`data-doc="print-sample-v1"` |
| `print-sample-csspage.html` | 同样内容但 `@page { size: A4; margin: 15mm }`（测 CSS 纸张/边距是否生效） |
| `print-plain.html` | 同样内容但**完全没有** `@page` 规则（隔离 CSS 与引擎打印设置） |
| `print-ready.js` | `load` + `document.fonts.ready` + `img.decode()` 后：Tauri 下 `invoke('pdf_page_ready')`，Electron 下只设 `__PDF_SAMPLE_READY__`。两个后端都在"字体与图片就绪"后才打印，避免竞态噪声 |

PDF 矩阵共 12 个 WebView2 用例 + 15 个 Electron 用例（含失败分支），命名一一对应
（`w*` ↔ `e*`；`w6` 用旧 API，与 `e1` 对照）。

## 3. 实现要点（WebView2 路径）

- Tauri 隐藏窗口（`visible(false)`，每窗口独立 WebView2 数据目录
  `.tmp-r0-pdf/webview2-data/<label>`）加载样例页；
- 页面就绪后后台线程调用 `WebviewWindow::with_webview`，在 UI 线程拿到
  `ICoreWebView2Controller` → `ICoreWebView2Environment6::CreatePrintSettings()`；
- `ICoreWebView2PrintSettings` 设置 `PageWidth/PageHeight`（英寸）、四边 `Margin*`、`ShouldPrintBackgrounds`、
  `ScaleFactor`、`Orientation`，并**读回**实际值写进报告（防止"设置了没生效"）；
- `ICoreWebView2_16::PrintToPdfStream(settings, handler)` 完成回调拿到 `IStream`，在回调里读成
  `Vec<u8>`，经 mpsc 交回后台线程写盘；
- bindings 里**没有** `PrintToPdfAsync`：旧 API 名为 `ICoreWebView2_7::PrintToPdf(path, settings, handler)`，
  本小样用 `w6` 实测通过。环境事实"ICoreWebView2_16 含 Print/ShowPrintUI/PrintToPdfStream"得到证实
  （`Print`/`ShowPrintUI` 未在矩阵中调用）。
- 失败分支同一进程内验证：非法 `PageWidth`/`ScaleFactor`、微米数值误当英寸、过小纸张。

## 4. 证据：等价性对比表

数据来源：`.tmp-r0-pdf/analysis.json`（pypdf 逐 PDF 解析）、`webview2-print-report.json`、
`electron-report.json`。`pageTextChars` 是每页 `extract_text()` 字符数；`fillColors` 是首页内容流
`rg` 去重颜色数；`alpha` 是首页 `ExtGState` 的 `/ca`、`/CA` 去重值。

| 用例（w↔e） | WebView2 MediaBox / pages / 字节 | Electron MediaBox / pages / 字节 | 每页文字字符数（wv2 / el） | 字体名 | 填充色数 | alpha 状态 | 判定 |
|---|---|---|---|---|---|---|---|
| 默认设置 w0/e0 | 612×792 Letter / 2 / 143,424 | 612×792 Letter / 2 / 143,295 | [1289,1033] / [1289,1033] | 相同 | 9/9 | 相同 | 等价（默认纸张是 Letter，非 A4） |
| A4 零边距+背景 w1/e1 | 594.96×841.92 / 2 / 143,679 | 595.92×842.88 / 2 / 143,525 | [1289,1033] / [1289,1033] | 相同 | 13/13 | 相同 [0.302,0.9,1.0] | 部分等价（MediaBox 差 0.96pt） |
| **英寸配平 w1b/e1b** | **595.92×842.88** / 2 / 143,654 | **595.92×842.88** / 2 / 143,525 | [1289,1033] / [1289,1033] | 相同 | 13/13 | 相同 | **等价（纸张单位=英寸被证实）** |
| 关闭背景 w4/e4 | 594.96×841.92 / 2 / 143,452 | 595.92×842.88 / 2 / 143,298 | [1289,1033] / [1289,1033] | 相同 | 9/9 | 相同 [0.9,1.0] | 等价语义（背景色全部不打印） |
| 自定义纸张 6.25×4.1667in（@page A4 存在）w3/e3 | 300×450 / 2 / 143,657 | 300.96×450 / 2 / 143,530 | [1289,1033] / [1289,1033] | 相同 | 13/13 | 相同 | 部分等价（两引擎都"交换"了宽高） |
| 同上 + landscape w3b/e3a | 300×450 / 2 / 143,657 | 300.96×450 / 2 / 143,530 | 同上 | 相同 | 13/13 | 相同 | 与 w3 完全相同：自定义纸张下 orientation 未产生差异 |
| A4 + 引擎 15mm 边距（HTML @page margin:0）w5/e5 | 594.96×841.92 / 2 / 143,679 | 595.92×842.88 / 2 / 143,525 | [1289,1033] / [1289,1033] | 相同 | 13/13 | 相同 | **等价：CSS `@page margin:0` 覆盖引擎边距** |
| 无 @page + 引擎 15mm 边距 w9/e9 | 594.96×841.92 / 2 / 143,702 | 595.92×842.88 / 2 / 143,560 | [1418,904] / [1418,904] | 相同 | 13/13 | 相同 | **等价：无 CSS @page 时引擎边距生效且两引擎一致** |
| CSS @page A4/15mm（引擎 A4 零边距）w2/e2b | 594.96×841.92 / 2 / 142,089 | 595.92×842.88 / 2 / 141,929 | [1074,1247] / [1074,1247] | 相同 | 13/13 | 相同 | 等价（CSS 边距两引擎都生效：内容盒 680×1009 CSS px） |
| 无 @page + 自定义纸张 w8/e7 | 450×300 / 4 / 144,695 | 450×300.96 / 4 / 144,509 | [463,696,930,231] / 同 | 相同 | 7/7 | 相同 | 等价（纸张按 6.25×4.1667in 横版，4 页分页完全一致） |
| 旧 API PrintToPdf w6（对照 e1） | 594.96×841.92 / 2 / 143,679 | 595.92×842.88 / 2 / 143,525 | [1289,1033] / [1289,1033] | 相同 | 13/13 | 相同 | 与 PrintToPdfStream 产出一致（同 settings） |

补充观测：

- **字体**（两个后端逐字节同名、同类型）：`/AAAAAA+MicrosoftYaHei-Bold`、`/BAAAAA+MicrosoftYaHei`、
  `/CAAAAA+Consolas`、`/DAAAAA+MicrosoftYaHei-Bold`，全部 `/Type0` + `/FontFile2`（嵌入 TrueType 子集）
  + `/ToUnicode`。
- **文字可搜索**：8 个标记（`高亮器合成样例中文标记甲`、`可搜索文字验证乙`、`表格单元格-中文-7/-12`、
  `PDF-SAMPLE-LINE-1/-4`、`Cell row 12`、`PDF-SAMPLE-END`）在 **2 个后端全部 PDF** 中都
  `extract_text()` 命中；两后端逐页字符数完全相同（上表）。
- **透明元素**：半透明块 `rgba(0,128,255,0.3)` 在两个后端都生成 `/ca≈0.302` 的 ExtGState，
  且 `printBackground=true` 时填充色 13 种、`false` 时 9 种，两后端颜色列表逐项相同。
- **Producer**：WebView2 `Skia/PDF m157`；Electron `Chromium` + `Skia/PDF m150`。字节数差
  127~206 B（<0.2%），来自 Skia 版本与对象/字符串编码差异，不是内容差异。
- **耗时**（Debug 构建，仅作数量级参考，不是性能基线）：WebView2 单份 111~141 ms；
  Electron 452~510 ms（含窗口/打印管线开销）。

## 5. 失败分支与限制（实测）

| 分支 | 操作 | 结果 |
|---|---|---|
| 纸张单位为微米（基线旧口径） | Electron `pageSize:{width:158750,height:105833}` | **失败**：`Failed to generate PDF: Printing failed`（与 `pdf-export.js:22-30` 记录一致）；WebView2 把同数值当英寸传入时完成回调 `HRESULT=0x80070006`（无效句柄），无 PDF 产出 |
| 非法纸张/缩放 | WebView2 `SetPageWidth(0)` / `(-1)` / `SetScaleFactor(5)` | 均在 setter 处返回 `0x80070057`（E_INVALIDARG），命令侧记录为失败分支，不产生 PDF |
| 纸张过小 | WebView2 `PageWidth=0.25in` | 完成回调 `HRESULT=0x80070006`，无 PDF；Electron 注释记录 0.1/0.25/0.5in 会 "content area is empty"（本轮未重跑 Electron 小纸张用例，标未复测） |
| A4 定义差 | WebView2 传 `210/25.4 × 297/25.4` 英寸 → 594.96×841.92pt；Electron `'A4'` → 595.92×842.88pt | 差异 0.96pt（≈0.34mm）；传 Electron 实测英寸后 WebView2 **精确复现** 595.92×842.88 → 单位与换算可控，差异来自"标称 A4"的取整口径 |
| CSS `@page` 与引擎参数优先级 | 有 `@page{size:A4;margin:0}` 时引擎 margins/自定义纸张被 CSS 覆盖（w5≈w1；w3 宽高被交换） | 两引擎行为一致；产品 `capture/print.html` 恰好是 `@page{margin:0}` + 引擎 pageSize，现有口径可平移 |
| 自定义纸张方向 | `PageWidth>PageHeight` + portrait（w3/e3）与 landscape（w3b/e3a） | 两引擎都输出 300×450（宽<高），方向参数未改变结果；无 @page 时（w8/e7）正常输出 450×300 横版。需 R4-07 用产品参数再确认 |
| 中文字体缺失/未嵌入 | — | **未验证/本机不可复现**：Windows 自带 CJK 系统字体，无安全办法移除；本轮只能证明"系统字体存在时中文字体被嵌入且可搜索"。若目标机缺字体，回退字体与版面差异需在 R4-07/R8 真机矩阵补 |
| 长图/200 英寸大纸张 | — | 首轮未验证；**2026-11-11 §8.5-B 已实测**：产品真实页场景下 WebView2 `PrintToPdfStream` 接受 200in 夹取纸张、内容不丢（单机） |
| 批量多页（最多 50 页） | — | 首轮未验证；**2026-11-11 §8.5-C 已实测**：产品真实 print.html 5/50 页双后端等价、无空白尾页（单机） |

## 6. 结论（建议，供 ADR-0003）

**判定：内容等价、二进制不等价、纸张定义需显式配平（可视为"部分等价→可配平等价"）。**

- 页数、逐页文字字符数、字体名/子集/嵌入/ToUnicode、透明元素 alpha、`printBackground`
  语义（填充色集合）、图片与表格排版、CSS `@page` 与引擎 margins 的优先级：两后端**逐项一致**；
- 唯一实质差异是标称 A4 的 MediaBox 口径（0.96pt）与 PDF 字节级差异（Skia m150 vs m157）；
  传显式英寸即可精确对齐（w1b/e1b 实测同 MediaBox）；
- 中文可搜索、字体嵌入成立。

**建议（置信度：中高，R0 单机单样例）**：ADR-0003 选择 **候选 A：WebView2
`ICoreWebView2_16::PrintToPdfStream` 作为 R4-07 主后端**；保留 Electron `printToPDF` 作为对照与
回退，不把"PDF/A、批量 50 页、200 英寸长图、缺字体机器"当作已解决。**G0 前不写"已冻结"**：
本小样是文档型合成样例，不是产品 `capture/print.html` 的图片贴页路径。
（2026-11-11 增补：产品真实页的批量 50 页/200in 长图已由 **§8** 在单机 + 合成 PNG 上复验，
PDF/A 与缺字体机器仍未解决；§6 的保留措辞代表首轮当时状态。）

## 7. 未解决限制 / R4-07 前必须补

> 2026-11-11 增补：第 1～2 条已由 **§8** 用产品真实 `capture/print.html` + 产品 `computePaperOptions`/
> 注入脚本复验（单机 + 合成 PNG + 隐藏窗口）；第 3～7 条仍未关闭。§8 也不是 R4-07 已验证的证据。

1. 用产品真实 `capture/print.html`（图片贴页、`intrinsicCssPx` 缩放、`pageSize:'A4'|original`、
   DPI 修正）复验单图/多图 PDF，而不是文档型样例；
2. 批量 50 页、20000px 长截图（200 英寸夹取）、A4 横版；
3. 中文字体缺失机器 / 非 Windows 系统字体口径；字体子集许可与体积；
4. 隐藏窗口打印的 UI/内存峰值、打印超时（产品 `timeoutMs=30000`）与取消；RDP/锁屏/多用户会话；
5. WebView2 Fixed Version / 旧 Runtime 的 `ICoreWebView2_16` 可用性（本轮只有 Evergreen 157）；
6. 失败分支错误码（HRESULT）需映射为 `OperationError`，并确认打印失败时窗口回收不泄漏；
7. Electron 侧小纸张（0.1/0.25/0.5in）失败分支本轮未复测，只有基线注释证据。

## 8. 产品真实 `capture/print.html` 双后端复验（2026-11-11 增补）

> 本节关闭 §7 第 1～2 条（产品真实 print.html 的单图 A4/横版、original 长图 200in 夹取、批量 50 页）。
> 证据仍是**单机（Win11 / WebView2 Evergreen 157 / Electron 43.8.3）+ 合成 PNG + 隐藏窗口**；
> 不覆盖性能/内存/并发/取消/超时、缺字体机器、旧 Runtime，也不等于 R4-07 已验证，
> **不构成 G0 通过证据**。

### 8.1 目标与用例

首轮（§4）用文档型合成样例（`print-sample*.html`）证明内容/字体/分页等价，但没有覆盖产品真正的
图片贴页路径：`computePaperOptions()` 的 A4/original 纸张、`intrinsicCssPx` 的 DPR 修正、
`MAX_PAGE_INCHES=200` 夹取、`MAX_PDF_PAGES=50` 批量上限。本轮用**产品真实页** + 产品参数/注入脚本：

合成 PNG 由脚本内置的确定性 indexed-PNG 编码器生成（白底 + 上红下蓝左右黄绿边 + 每 500px 黑线，
1.6 KB～116.8 KB），不读取任何用户数据。

| 用例 | 合成图（px） | 模式 / dpi / 注入 | 产品 `computePaperOptions` 输出 | 预期 |
|---|---|---|---|---|
| p1-a4-portrait-intrinsic | 1440×2560 | a4 / 144 / `intrinsicCssPx` | A4 竖，scale=0.6577，注入 960×1707 CSS px | 1 页 |
| p2-a4-landscape-intrinsic | 2560×1440 | a4 / 144 / `intrinsicCssPx` | A4 横（宽高交换），scale=0.6577 | 1 页 |
| p3-a4-portrait-natural-px | 1440×2560 | a4 / 144 / **自然像素**（负对照，不做 DPR 修正） | 同 p1 纸张/scale，注入 1440×2560 | 2 页（故意溢出） |
| p4-original-1920x20000-dpi96 | 1920×20000 | original / 96 / `intrinsicCssPx` | 请求 20×208.33in → **夹取 20×200in**，scale=0.96，`clamped=true` | 1 页 |
| p5-original-1920x30000-dpi144 | 1920×30000 | original / 144 / `intrinsicCssPx` | 请求 13.33×208.33in → **夹取 13.33×200in**，scale=0.96 | 1 页 |
| p6-batch-5-mixed-a4-first | 首页 1440×2560 + 4 张混合 | a4 / 144 / batch（首页定纸） | A4 竖；sheet 792×1121 CSS px；逐页 fit | 5 页 |
| p7-batch-50-mixed-a4-first | 首页 1440×2560 + 49 张混合 | a4 / 144 / batch | 同 p6（产品页数上限 50） | 50 页 |

Electron 侧另有 2 个**产品函数对照**，用来证明"手工注入流程 == 产品实现"：
`x1-product-exportPdfBuffer-single-a4-portrait`（直接调用 `exportPdfBuffer()`）与
`x2-product-exportPagesToPdfBuffer-batch-5`（直接调用 `exportPagesToPdfBuffer()`）。

### 8.2 实现要点（两后端如何拿到"同一组参数 + 同一段脚本"）

- **共享 manifest**：`scripts/rust/pdf-product-cases.js`（新增，git 跟踪）只读 `require` 产品
  `main/services/pdf-export.js`，调用 `computePaperOptions()` / `buildPrintOptions()` /
  `buildPagesSetupScript()` / `buildPageAppendScript()` 生成
  `.tmp-r0-pdf/product/product-cases.json`（gitignore）。`buildImageInjectionScript()` 是产品模块
  私有函数（未 export），按 `pdf-export.js:270-282` **逐字复刻**，并由 `assertProductReplica()`
  校验产品源码仍含该实现（产品一改这里就失败，不会悄悄漂移）。批量 sheet/fit 公式同为模块私有，
  按同公式复刻，再用 x2 产品函数导出的 PDF 反证没有漂移（见 §8.4）。
- **真实页哈希**：`capture/print.html` sha256 `86674eb211158826d7c4c922bbd4d8e282b9a84b2da7efeff357bbc7ee0f0fba`，
  `shared/tokens.css` sha256 `074bb2c49ddab998164359cbcf27c8af7d0ae0b5df8c0e39a022d98a397eb11f`
  （manifest 记录，两后端加载同一份文件）。
- **Electron 探针** `scripts/rust/probe-electron-product-pdf.js`（新增）：隐藏 `BrowserWindow`
  逐项复刻产品 `openPrintWindow()` 的参数（`createSecureWindow` + `preload-capture.js` + `show:false`
  + `backgroundThrottling:false` + `paintWhenInitiallyHidden:true` + 产品 `clampWindowSize`），
  `loadFile` 真实 `capture/print.html`，用 `executeJavaScript` 执行 manifest 里的产品脚本原文
  （与 WebView2 同一段文本），DOM 轮询就绪后 `printToPDF(产品 buildPrintOptions 输出)`。
- **WebView2 模式** `--pdf-product`（`rust-app/prototypes/webview-pdf-resource/src/pdf_product.rs`，
  新增）：进程内只读 HTTP 服务从仓库根原样提供 `capture/print.html` 与 `shared/tokens.css`
  （真实文件、真实 CSP，不复制），一个隐藏 Tauri 窗口按用例导航（URL 带唯一 `?case=<name>`，
  每次都是全新文档；窗口尺寸 = 产品 `clampWindowSize`），用 `ICoreWebView2::ExecuteScript`
  执行**同一段产品脚本原文**，轮询 DOM（图片 decode/追加完成）后按 manifest 的 `rustOptions`
  调 `PrintToPdfStream`；设置读回（纸张英寸/边距/背景/scale）写进报告。
- **A4 口径映射**：WebView2 没有 `'A4'` 别名，必须显式传英寸；采用 Electron `pageSize:'A4'` 的实测
  MediaBox（595.92×842.88pt）反推 `595.92/72`×`842.88/72`，否则用 210/25.4×297/25.4 会得到
  594.96×841.92（首轮 w1/e1 的 0.96pt 差）。`original` 分支产品本身就输出英寸，直接透传。
- **对照分析** `scripts/rust/analyze-product-pdfs.py`：用 pypdf 6.7.0 解析页数、逐页 MediaBox、
  XObject 图片尺寸、内容流 `cm`/`Do` 还原的图片绘制 bbox、逐页文字字符数、空白页、字节数，
  再判定两端语义等价（容差：MediaBox/图片绘制框 ≤1pt）。

### 8.3 命令（仓库根目录，PowerShell；本机实测）

```powershell
# 1) 生成合成图片 + 两后端共享 manifest（约 5 s）
node scripts/rust/pdf-product-cases.js

# 2) Electron 对照。AGENTS.md 陷阱：清 ELECTRON_RUN_AS_NODE、--no-sandbox 必须在脚本路径之前、
#    TMP/TEMP 指向 .tmp*。注意 electron.exe 是 GUI 子系统程序，用管道（Tee-Object）才会等它退出。
$env:ELECTRON_RUN_AS_NODE = $null
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:TMP = "D:\workspace\Highlighter\.tmp-r0-pdf\tmp"; $env:TEMP = $env:TMP
& node_modules\electron\dist\electron.exe --no-sandbox scripts/rust/probe-electron-product-pdf.js 2>&1 |
  Tee-Object -FilePath .tmp-r0-pdf/product/logs/electron-product.log

# 3) WebView2 对照（隐藏窗口，不需要副屏；复用主 workspace 已编译依赖）
$env:CARGO_TARGET_DIR = 'rust-app/target'
cargo build --manifest-path rust-app/prototypes/webview-pdf-resource/Cargo.toml --locked
& .\rust-app\target\debug\highlighter-r0-pdf-resource.exe --pdf-product 2>&1 |
  Tee-Object -FilePath .tmp-r0-pdf/product/logs/webview2-product.log

# 4) 双后端分析（本机 pypdf 6.7.0；PYTHONPATH 指向 gitignore 的 pylibs，不存在则用系统 Python 的 pypdf）
$env:PYTHONPATH = '.tmp-r0-pdf/pylibs'; $env:PYTHONIOENCODING = 'utf-8'
python scripts/rust/analyze-product-pdfs.py
```

两后端均 0 失败退出：Electron `[PASS] electron product pdf probe: 7 case(s) + 2 control(s)`；
WebView2 `[PASS] webview2 product pdf: 7 cases`。旧合成矩阵 `--pdf` 回归复跑 12/12 通过
（`.tmp-r0-pdf/legacy-rerun4.log`）。

### 8.4 对照数字（由 `.tmp-r0-pdf/product/analysis.md` 自动生成）

「WebView2 ms / Electron ms」两列是整用例耗时（load+注入+print，Debug 构建、隐藏窗口，
仅数量级参考，不是性能基线）。

| 用例 | 模式/dpi/注入 | 纸张（产品输出） | scale | WebView2 MediaBox(pt)/页数 | Electron MediaBox(pt)/页数 | WebView2 首页图片 bbox(pt) | Electron 首页图片 bbox(pt) | WebView2 字节 | Electron 字节 | WebView2 ms | Electron ms | 判定 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| p1-a4-portrait-intrinsic | a4/144/intrinsic | A4-竖 8.27×11.69in | 0.6577 | 595.92×842.88 / 1 | 595.92×842.88 / 1 | 473.54×842.02 | 473.54×842.02 | 18,437 | 18,316 | 204 | 291 | 等价 |
| p2-a4-landscape-intrinsic | a4/144/intrinsic | A4-横 11.69×8.27in | 0.6577 | 842.88×595.92 / 1 | 842.88×595.92 / 1 | 842.02×473.54 | 842.02×473.54 | 15,995 | 15,874 | 211 | 201 | 等价 |
| p3-a4-portrait-natural-px | a4/144/**natural** | A4-竖 8.27×11.69in | 0.6577 | 595.92×842.88 / **2** | 595.92×842.88 / **2** | 648.37×1152.67（越界） | 648.37×1152.67（越界） | 18,932 | 18,811 | 197 | 215 | 等价（DPR 负对照：两端同样溢出裁切） |
| p4-original-1920x20000-dpi96 | original/96/intrinsic | custom 20.00×200.00in（请求 208.33in→夹取） | 0.96 | 1440.00×14400.00 / 1 | 1440.00×14400.00 / 1 | 1382.40×14400.00 | 1382.40×14400.00 | 157,651 | 157,530 | 616 | 703 | 等价 |
| p5-original-1920x30000-dpi144 | original/144/intrinsic | custom 13.33×200.00in（请求 208.33in→夹取） | 0.96 | 960.00×14400.00 / 1 | 960.96×14400.00 / 1 | 921.60×14400.00 | 921.60×14400.00 | 235,591 | 235,475 | 991 | 919 | 等价（MediaBox 差 0.96pt） |
| p6-batch-5-mixed-a4-first | a4/144/batch | A4-竖；sheet 792×1121 CSS px | 1 | 595.92×842.88 / 5 | 595.92×842.88 / 5 | 473.25×840.75 | 473.25×840.75 | 57,069 | 56,948 | 332 | 325 | 等价 |
| p7-batch-50-mixed-a4-first | a4/144/batch | A4-竖；sheet 792×1121 CSS px | 1 | 595.92×842.88 / 50 | 595.92×842.88 / 50 | 473.25×840.75 | 473.25×840.75 | 80,004 | 79,883 | 363 | 344 | 等价 |

汇总（`analysis.json` `summary`，7/7 用例两后端均成功）：

- `allPageCountsEqual=true`、`allExpectedPageCounts=true`、`allBlankPagesAbsent=true`、
  `allContentEquivalent=true`；
- MediaBox 最大差 **0.96pt**（p5，Electron 自定义 pageSize 量化，见下）；图片绘制框最大差 **0.72pt**；
- 除 DPR 负对照 p3（故意溢出）外，`allContentNotCroppedExceptNaturalPxControl=true`。

DOM / CSP / HTTP 证据（两端逐项一致，`.tmp-r0-pdf/product/webview2-product-report.json`、
`electron-product-report.json` 的 `domAfterSteps`）：

| 项 | WebView2 | Electron |
|---|---|---|
| 真实页 CSP 存在 | 是（`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: file:`） | 是（同文） |
| 注入脚本执行 | 成功（ExecuteScript 返回 `{}`，见 §8.5-D④） | 成功（executeJavaScript 返回 `{width,height}`） |
| 注入后 `#print-image` style | p1 `960px×1707px`；p3 负对照 `1440px×2560px`；p5 `1280px×20000px` | 同左，逐项相同 |
| `img-src data:` PNG 加载 | 是（`naturalWidth×naturalHeight` = 图源像素） | 是 |
| `../shared/tokens.css` | 同源加载（HTTP 200，19,660 B） | `file://` 加载 |
| 批量 DOM | `.print-page`=5/50、最后一页 `print-page-last`、`html/body.print-multi`、容器 `--print-page-width/height=792/1121px` | 同左，逐项相同 |
| WebView2 只读 HTTP 请求 | 每用例 `GET /capture/print.html` 200 3,726 B + `GET /shared/tokens.css` 200 19,660 B；`favicon.ico` 404 | — |

产品函数对照（Electron）：x1 与 p1、x2 与 p6 的 PDF **字节数完全相同**（18,316 / 56,948 B），
页数/MediaBox/图片绘制框/文字逐项相同；sha256 不同仅因 `/CreationDate` 等元数据时间戳。
→ 证明本轮"手工注入 + 产品参数"流程与产品 `exportPdfBuffer()` / `exportPagesToPdfBuffer()` 一致。

### 8.5 结论

**A. 单图 A4 竖/横 + DPR 修正语义：等价。**
- p1 竖版：两端 1 页、MediaBox 595.92×842.88pt、图片绘制框 473.54×842.02pt，逐项相同；
- p2 横版：两端 1 页、MediaBox 842.88×595.92pt、图片绘制框 842.02×473.54pt，逐项相同；
- p3 负对照（不做 DPR 修正、按 PNG 自然像素注入）：两端都变成 **2 页**，图片绘制框同为
  648.37×1152.67pt 且越界（x0=-26.12pt、top=-154.44pt，被纸张裁切）——**两端连"错误形态"都一致**，
  反证产品 `intrinsicCssPx` 注入（p1/p2）是必要的，且两端都正确执行了产品注入脚本。
- WebView2 侧 A4 必须按 Electron 实测英寸传参（`595.92/72`×`842.88/72`）；这是 R4-07 的参数映射
  要求，不是内容差异。

**B. original 长图 20000px → `MAX_PAGE_INCHES=200` 夹取：WebView2 可打印、内容不丢。**
- p4（1920×20000 @96dpi）：请求 20×208.33in → 夹取 20×200in（`clamped=true`、scale=0.96）；
  两端均 **1 页**、MediaBox 1440×14400pt（= 20×200in）、图片绘制框 1382.40×14400.00pt
  （高度恰好铺满 200in，未裁切、未被缩成多页）；字节 157,651 / 157,530。
- p5（1920×30000 @144dpi，同一 208.33in 请求口径）：两端均 1 页、200in 高；图片绘制框
  921.60×14400.00pt 相同；MediaBox WebView2 960.00×14400 vs Electron 960.96×14400（差 0.96pt），
  内容未裁切。
- **首轮 §5"长图/200 英寸大纸张未验证"已实测关闭**：WebView2 Runtime 157.0.4341.46 的
  `PrintToPdfStream` 接受 200in 自定义纸张并正确出纸，没有 HRESULT 失败/空流。
- 0.96pt 差来自 **Electron 43.8.3 对自定义 `pageSize`（小数英寸）的 MediaBox 量化**：实测输出落在
  0.24pt（300dpi）网格上，非 1/300 英寸整数倍的输入最多被抬 +0.96pt（诊断 11 组尺寸见
  `.tmp-r0-pdf/product/diag2/`；例如输入 13.333346in → 输出 13.346667in）。A4 用例因传入 Electron
  实测英寸而两端同值。判为语义等价，不是分页/内容差异；若未来做 PDF 逐字节/逐点回归断言需给
  ≤1pt 容差。

**C. 批量 50 页：等价、无空白尾页。**
- p6（5 页混合，首页 A4 竖）+ p7（产品上限 50 页，首页 A4 竖 + 49 页混合尺寸）：两端页数分别
  5/5、50/50；每页恰好 1 个图片 XObject；空白页 0；最后一页有图片（无空白尾页）；
- DOM：两端 `.print-page` = 5/50、最后一页 `print-page-last`、`print-multi` 类与容器
  `--print-page-width/height=792/1121px` 全部一致；PDF 字节 56,948/57,069（p6）、79,883/80,004（p7）；
- 纸张/方向取首页（A4 竖），其余页按产品 `exportPagesToPdfBuffer` 的 per-page fit 进入同一可打印盒，
  两端分页与图片绘制框逐页相同。

**D. 与首轮合成样例结论的一致点与新增差异（R4-07 实现要点）：**
- 一致：内容/分页等价；A4 MediaBox 口径差（名义 A4 vs 显式英寸）可配平；二进制不等价
  （本轮 116～121 B，首轮 127～206 B，均来自 Skia m157 vs m150）。
- 新增（首轮未覆盖）：
  ① 产品真实图片贴页路径（含负对照）两端逐项等价；② 200in 夹取可打印、内容不丢；
  ③ 批量 50 页每页一张、无空白尾页；④ **WebView2 `ICoreWebView2::ExecuteScript` 不等待脚本返回的
  Promise**——产品注入脚本 `return decoded.then(...)`，ExecuteScript 实测返回 `{}`（1 ms 级），
  宿主必须轮询 DOM 才能确认图片 decode/页面就绪；Electron `executeJavaScript` 则直接返回 Promise
  解析值 `{width,height}`。这一点直接影响 R4-07 就绪协议设计（不能只看 ExecuteScript 返回值）。
  ⑤ 真实页 CSP 不阻止宿主 ExecuteScript，且 `img-src data:` 允许注入的 PNG（`naturalWidth>0`）；
  ⑥ WebView2 旧 API `ICoreWebView2_7::PrintToPdf` 只接受**绝对路径**（传相对 `--out-dir` 时实测
  `0x80070057`、无产物）；新 API `PrintToPdfStream` 不受影响，但 R4-07 若保留旧 API 必须传绝对路径。
  原型已把 `--pdf` 的产物目录规范成绝对路径并回归 12/12 通过。
- 观察到但非失败：WebView2 进程退出时 stderr 打印
  `Failed to unregister class Chrome_WidgetWin_0. Error = 1412`（窗口销毁竞态），退出码 0，
  与打印结果无关；R4-07 不应把它当成打印失败（若做退出断言需按退出码/报告判定）。

**结论边界**：以上证明**后端语义等价**与 WebView2 对产品纸张范围（A4/横版/200in/50 页）的支持，
不证明性能/内存/并发/取消/超时/失败恢复，也没有代码接入产品；ADR-0003 仍为**候选、未冻结**，
R4-07 前必须补 §8.6 的限制。

### 8.6 未解决限制（本轮新增证据的边界）

1. 合成 PNG 不是真实截图（无照片/渐变等复杂内容）；未覆盖真实长截图链路（长截图拼接、transparent/动画）；
2. 单机单 Runtime（WebView2 Evergreen 157.0.4341.46、Electron 43.8.3 / Chromium 150）；未覆盖
   Fixed Version/旧 Runtime 的 `ICoreWebView2_16` 可用性（首轮仅证明本机）、100/125/150/200% DPI 矩阵；
3. WebView2 侧用**一个隐藏窗口按用例导航**（每用例唯一 URL、全新文档）而非每次新建窗口；
   页面无脚本状态，PDF 语义等价，但**窗口复用/销毁、泄漏、并发打印、取消/超时（产品 30000ms）未测**；
4. 页面 origin：Electron `file://`，WebView2 用本地 HTTP 服务（真实文件、真实 CSP，但 origin 不同；
   Tauri asset 协议/Fixed Runtime 下的 CSP 行为待 R4-07 复验）；
5. 200in 用例只测"能出纸/页数与内容"，未测内存峰值、打印耗时随尺寸的变化（Debug 构建数量级参考，
   不构成性能结论）；未测 `MAX_PDF_PAGES` 之外（>50）的拒绝路径；
6. 产品侧错误/超时/窗口回收路径未在本轮接线（R4-07 范围）；
7. 中文字体缺失机器仍未验证（真实页路径本身无文字，文字证据仍来自首轮补偿样例）。

### 8.7 证据路径（全部 gitignore，`.tmp-r0-pdf/product/`）

| 证据 | 路径 |
|---|---|
| 合成 PNG（7 张）+ 共享 manifest | `.tmp-r0-pdf/product/fixtures/*.png`、`.tmp-r0-pdf/product/product-cases.json` |
| WebView2 PDF（7 份）/报告/日志 | `.tmp-r0-pdf/product/webview2-*.pdf`、`webview2-product-report.json`、`logs/webview2-product.log` |
| Electron PDF（7 case + 2 control）/报告/日志 | `.tmp-r0-pdf/product/electron-*.pdf`、`electron-product-report.json`、`logs/electron-product.log` |
| 双后端对照分析 | `.tmp-r0-pdf/product/analysis.json`、`analysis.md` |
| Electron 自定义纸张量化诊断 | `.tmp-r0-pdf/product/diag/diag-report.json`、`.tmp-r0-pdf/product/diag2/diag2-report.json` |
| 旧合成矩阵回归 | `.tmp-r0-pdf/legacy-rerun4/webview2-print-report.json`、`.tmp-r0-pdf/legacy-rerun4.log` |
| ACL/完整性标签修复后 Medium IL 确认复跑 | `.tmp-r0-pdf/product/acl-rerun-comparison.json`、`.tmp-r0-pdf/product/acl-rerun-baseline/`（修复前 analysis/report/日志/PDF 哈希副本 + 对比脚本）、`.tmp-r0-pdf/product/acl-rerun-integrity.log` |
| 生成/探针/分析脚本（git 跟踪） | `scripts/rust/pdf-product-cases.js`、`scripts/rust/probe-electron-product-pdf.js`、`scripts/rust/analyze-product-pdfs.py` |
| WebView2 产品页模式源码（git 跟踪） | `rust-app/prototypes/webview-pdf-resource/src/pdf_product.rs`（`--pdf-product`） |

### 8.8 门禁（本轮实测）

```powershell
cargo fmt    --manifest-path rust-app/prototypes/webview-pdf-resource/Cargo.toml -- --check   # exit 0
cargo clippy --manifest-path rust-app/prototypes/webview-pdf-resource/Cargo.toml --all-targets --locked -- -D warnings  # exit 0
cargo test   --manifest-path rust-app/prototypes/webview-pdf-resource/Cargo.toml --locked     # 21 passed（原 15 + 新增 6）
```

**2026-11-11 19:47 ACL/完整性标签修复后 Medium IL 确认复跑**（非新用例，命令同 §8.3；
工作区全树完整性标签已由 Low 修复为 Medium，进程级 `whoami /groups` 在工作区内实测
`Mandatory Label\Medium Mandatory Level` S-1-16-8192）：

- Electron `[PASS] electron product pdf probe: 7 case(s) + 2 control(s)`、WebView2
  `[PASS] webview2 product pdf: 7 cases`、分析脚本 exit 0；
- **结果性字段与修复前基线逐项相同（0 差异）**：7/7 用例的页数/MediaBox/图片绘制框/空白页/文字/
  字节数、2 个产品函数对照、summary 全部一致（`allContentEquivalent=true`、MediaBox 最大差 0.96pt、
  图片绘制框最大差 0.72pt；200in 夹取两后端均 1 页、批量 50 页 = 50 页且无空白尾页）；
- 16 份 PDF 字节长度 **16/16 相同**；sha256 不同仅因 PDF `/CreationDate`、`/ModDate` 记录本次运行
  时刻（同长度元数据，非内容差异）；
- 证据：`.tmp-r0-pdf/product/acl-rerun-comparison.json`（逐字段对比）、`acl-rerun-baseline/`
  （修复前 analysis/report/日志/PDF 哈希副本 + 对比脚本）、`acl-rerun-integrity.log`（完整性级别与
  各步 exit code）。**结论不变、无差异。**

## 9. 复现与证据路径

| 证据 | 路径（均 gitignore） |
|---|---|
| WebView2 PDF 报告/产物 | `.tmp-r0-pdf/webview2-print-report.json`、`.tmp-r0-pdf/webview2-*.pdf`（12 个） |
| Electron PDF 报告/产物 | `.tmp-r0-pdf/electron-report.json`、`.tmp-r0-pdf/electron-*.pdf`（14 个成功 + 1 失败） |
| 对比分析（pypdf） | `.tmp-r0-pdf/analysis.json`（含 `pairs` 差异表）、`.tmp-r0-pdf/analyze_pdfs.py` |
| 运行日志 | `.tmp-r0-pdf/logs/webview2-pdf-run3.log`、`.tmp-r0-pdf/logs/electron-probe-run3.log` |
| 原型/样例源码 | `rust-app/prototypes/webview-pdf-resource/`（`--pdf` 模式、`prototype-ui/print-*.html`） |
| Electron 探针 | `scripts/rust/probe-electron-pdf.js` |

原型单元测试：`cargo test --manifest-path rust-app/prototypes/webview-pdf-resource/Cargo.toml`
→ **21 passed**（原 15 + 本轮新增 CLI/manifest/HTTP 工具 6 个；不启动 GUI）。

> 机器更换说明：§4 首轮的部分证据文件（`electron-report.json`、`analysis.json`、`analyze_pdfs.py` 等）
> 已随 2026-11-11 换机清理；当前机器仍留有 12 份 `webview2-*.pdf` 与 `webview2-print-report.json`
> （2026-11-11 重跑）。§8 的证据是独立目录 `.tmp-r0-pdf/product/`，不依赖上表旧文件。

**门禁声明：本文件不构成 G0 通过证据，也不代表 R4-07 已验证。** §8 已补产品真实 print.html 的
单图/横版/200in 长图/批量 50 页双后端复验（单机 + 合成 PNG + 隐藏窗口），但仍未执行：缺字体机器、
旧/Fixed Runtime、真机 DPI 矩阵、性能与内存峰值、并发/取消/超时、真机安装包。

## 10. 变更记录

| 日期 | 变更 | 证据 |
|---|---|---|
| 2026-11-10 | R0-06 PDF 小样首轮实测（12 个 WebView2 用例 + 15 个 Electron 用例），产出本文件与 ADR-0003 证据表 | 上表各路径 |
| 2026-11-11 | 增补 §8：产品真实 `capture/print.html` 双后端复验（7 用例 + 2 产品函数对照）。覆盖单图 A4 竖/横 + DPR 修正负对照、original 20000/30000px → 200in 夹取、批量 5/50 页；新增 `--pdf-product` WebView2 模式、Electron 产品页探针与共享 manifest/分析脚本 | `.tmp-r0-pdf/product/analysis.json`、`analysis.md`；`scripts/rust/pdf-product-cases.js`、`probe-electron-product-pdf.js`、`analyze-product-pdfs.py`；`rust-app/prototypes/webview-pdf-resource/src/pdf_product.rs` |
| 2026-11-11 | 登记 R4-07 实现要点：WebView2 A4 需显式传 Electron 实测英寸；`ExecuteScript` 不等待 Promise 需轮询 DOM；旧 `PrintToPdf` 只接受绝对路径；Electron 自定义 pageSize 的 MediaBox 量化 ≤0.96pt | 本文件 §8.5-D、`.tmp-r0-pdf/product/diag2/diag2-report.json` |
| 2026-11-11 19:47 | ACL/完整性标签修复（Low→Medium）后 Medium IL 确认复跑：7 用例 + 2 产品函数对照结果与修复前逐项一致（0 差异），无差异；见 §8.8 | `.tmp-r0-pdf/product/acl-rerun-comparison.json`、`acl-rerun-baseline/`、`acl-rerun-integrity.log` |
