# R0-06 PDF 后端小样（r0-pdf-spike）

日期：2026-11-10（Asia/Hong_Kong）。状态：**R0 证据文档（草案，不是 gate 通过证据）**。
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
| 纸张单位为微米（基线旧口径） | Electron `pageSize:{width:158750,height:105833}` | **失败**：`Failed to generate PDF: Printing failed`（与 `pdf-export.js:22-30` 记录一致）；WebView2 把同数值当英寸传入 | 完成回调 `HRESULT=0x80070006`（无效句柄），无 PDF 产出 |
| 非法纸张/缩放 | WebView2 `SetPageWidth(0)` / `(-1)` / `SetScaleFactor(5)` | 均在 setter 处返回 `0x80070057`（E_INVALIDARG），命令侧记录为失败分支，不产生 PDF |
| 纸张过小 | WebView2 `PageWidth=0.25in` | 完成回调 `HRESULT=0x80070006`，无 PDF；Electron 注释记录 0.1/0.25/0.5in 会 "content area is empty"（本轮未重跑 Electron 小纸张用例，标未复测） |
| A4 定义差 | WebView2 传 `210/25.4 × 297/25.4` 英寸 → 594.96×841.92pt；Electron `'A4'` → 595.92×842.88pt | 差异 0.96pt（≈0.34mm）；传 Electron 实测英寸后 WebView2 **精确复现** 595.92×842.88 → 单位与换算可控，差异来自"标称 A4"的取整口径 |
| CSS `@page` 与引擎参数优先级 | 有 `@page{size:A4;margin:0}` 时引擎 margins/自定义纸张被 CSS 覆盖（w5≈w1；w3 宽高被交换） | 两引擎行为一致；产品 `capture/print.html` 恰好是 `@page{margin:0}` + 引擎 pageSize，现有口径可平移 |
| 自定义纸张方向 | `PageWidth>PageHeight` + portrait（w3/e3）与 landscape（w3b/e3a） | 两引擎都输出 300×450（宽<高），方向参数未改变结果；无 @page 时（w8/e7）正常输出 450×300 横版。需 R4-07 用产品参数再确认 |
| 中文字体缺失/未嵌入 | — | **未验证/本机不可复现**：Windows 自带 CJK 系统字体，无安全办法移除；本轮只能证明"系统字体存在时中文字体被嵌入且可搜索"。若目标机缺字体，回退字体与版面差异需在 R4-07/R8 真机矩阵补 |
| 长图/200 英寸大纸张 | — | 未验证（本样例只用 A4/自定义小纸张；产品长截图可达 20000px=208in，触及 `MAX_PAGE_INCHES=200` 夹取逻辑） |
| 批量多页（最多 50 页） | — | 未验证（本样例是单文档 2~4 页；产品多图拼页走 `print.html` 的 `.print-page` 结构，需 R4-07 单独用例） |

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

## 7. 未解决限制 / R4-07 前必须补

1. 用产品真实 `capture/print.html`（图片贴页、`intrinsicCssPx` 缩放、`pageSize:'A4'|original`、
   DPI 修正）复验单图/多图 PDF，而不是文档型样例；
2. 批量 50 页、20000px 长截图（200 英寸夹取）、A4 横版；
3. 中文字体缺失机器 / 非 Windows 系统字体口径；字体子集许可与体积；
4. 隐藏窗口打印的 UI/内存峰值、打印超时（产品 `timeoutMs=30000`）与取消；RDP/锁屏/多用户会话；
5. WebView2 Fixed Version / 旧 Runtime 的 `ICoreWebView2_16` 可用性（本轮只有 Evergreen 157）；
6. 失败分支错误码（HRESULT）需映射为 `OperationError`，并确认打印失败时窗口回收不泄漏；
7. Electron 侧小纸张（0.1/0.25/0.5in）失败分支本轮未复测，只有基线注释证据。

## 8. 复现与证据路径

| 证据 | 路径（均 gitignore） |
|---|---|
| WebView2 PDF 报告/产物 | `.tmp-r0-pdf/webview2-print-report.json`、`.tmp-r0-pdf/webview2-*.pdf`（12 个） |
| Electron PDF 报告/产物 | `.tmp-r0-pdf/electron-report.json`、`.tmp-r0-pdf/electron-*.pdf`（14 个成功 + 1 失败） |
| 对比分析（pypdf） | `.tmp-r0-pdf/analysis.json`（含 `pairs` 差异表）、`.tmp-r0-pdf/analyze_pdfs.py` |
| 运行日志 | `.tmp-r0-pdf/logs/webview2-pdf-run3.log`、`.tmp-r0-pdf/logs/electron-probe-run3.log` |
| 原型/样例源码 | `rust-app/prototypes/webview-pdf-resource/`（`--pdf` 模式、`prototype-ui/print-*.html`） |
| Electron 探针 | `scripts/rust/probe-electron-pdf.js` |

原型单元测试：`cargo test --manifest-path rust-app/prototypes/webview-pdf-resource/Cargo.toml`
→ 15 passed（Range/路径/CLI/哈希工具；不启动 GUI）。

**门禁声明：本文件不构成 G0 通过证据，也不代表 R4-07 已验证。** 未执行：产品真实 PDF 用例、
批量/长图、缺字体机器、性能与内存峰值、真机安装包。

## 9. 变更记录

| 日期 | 变更 | 证据 |
|---|---|---|
| 2026-11-10 | R0-06 PDF 小样首轮实测（12 个 WebView2 用例 + 15 个 Electron 用例），产出本文件与 ADR-0003 证据表 | 上表各路径 |
