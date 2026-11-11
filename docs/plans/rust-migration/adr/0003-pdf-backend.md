# ADR-0003：PDF 导出后端（WebView2 打印 vs 原生 PDF）

- 状态：**候选（有双后端对照证据 + 2026-11-11 产品真实 print.html 复验，未冻结）**
- 决定批次：R0-06；实施批次：R4-07
- 日期：2026-11-10（初稿）；2026-11-11（增补产品真实页复验）
- 关联计划：§2 D05/D06、§4.3、§5.1、§7 R0-06、§8 G0
- 证据文档：[r0-pdf-spike.md](../r0-pdf-spike.md)（初稿 §4 + 增补 §8）、[`rust-app/prototypes/webview-pdf-resource/`](../../../../rust-app/prototypes/webview-pdf-resource/)、
  [`scripts/rust/probe-electron-pdf.js`](../../../../scripts/rust/probe-electron-pdf.js)、
  [`scripts/rust/probe-electron-product-pdf.js`](../../../../scripts/rust/probe-electron-product-pdf.js)、
  [`scripts/rust/pdf-product-cases.js`](../../../../scripts/rust/pdf-product-cases.js)

## 1. 背景与问题

现有 PDF 导出（`main/services/pdf-export.js`）用隐藏 `BrowserWindow` 加载 `capture/print.html`，
再 `webContents.printToPDF`（pageSize 单位实测为英寸、margins none、preferCSSPageSize false）。
迁移后需要回答：**WebView2 打印能否产出与 Electron 等价的内容/分页/字体/文字/透明语义**，
以及纸张单位、边距、`@page` 作用顺序与失败分支；不满足时计划允许转原生 PDF 并重估 R4-07。

## 2. 备选方案

| 方案 | 描述 | 优点 | 代价/风险 |
|---|---|---|---|
| A WebView2 打印 | 复用 `capture/print.html`，宿主调 `ICoreWebView2_16::PrintToPdfStream` | 复用现有 HTML/几何规则；不新增字体嵌入/分页引擎 | 依赖 WebView2 Runtime 版本；纸张单位/二进制与 Electron 不完全相同 |
| B 原生 PDF 生成 | Rust 侧分页/字体嵌入/表格绘制 | 不依赖 WebView2 | 中文字体嵌入与许可、分页/纸型/透明度逐像素等价成本高 |
| C Chromium sidecar | 保留 Electron/Chromium 打印 | 等价性最好 | 违反 D08 终态，只能登记退出批次 |

## 3. 实测条件与命令

- 环境：首轮（2026-11-10，原机）Windows 11 build 26300.9711、WebView2 Runtime 157.0.4341.42、
  pypdf 7.0.1；增补（2026-11-11，当前机器）Windows 11 build 26300.9974、WebView2 Runtime
  **157.0.4341.46**、pypdf 6.7.0。两机 Electron 均为 43.8.3（Skia/PDF m150），WebView2 均为
  Skia/PDF m157。原机与当前机数据不混用：首轮表格保留原值，增补结论只基于当前机器。
- 首轮（2026-11-10）：同一份合成 HTML（中文正文、30 行跨页表格、内嵌 PNG、`@page A4`、透明元素）；
  双后端共 27 份 PDF（WebView2 12 份、Electron 15 份含失败分支）。
  复现：`rust-app/prototypes/webview-pdf-resource/ --pdf` 与 `node scripts/rust/probe-electron-pdf.js`。
- **增补（2026-11-11）：产品真实 `capture/print.html` 图片贴页路径**。
  `scripts/rust/pdf-product-cases.js` 只读调用产品 `main/services/pdf-export.js` 生成共享 manifest
  （纸张参数 + 产品注入脚本原文 + 合成 PNG data URL）；Electron 探针用产品真实窗口参数/`preload-capture.js`
  加载真实 print.html 并 `printToPDF(产品 options)`；WebView2 原型新增 `--pdf-product`
  （只读 HTTP 服务加载仓库真实 `capture/print.html` + `../shared/tokens.css`，`ExecuteScript` 执行
  同一段产品脚本，DOM 轮询后 `PrintToPdfStream`）。7 个用例 + 2 个产品函数对照，分析脚本
  `scripts/rust/analyze-product-pdfs.py`。详见 [r0-pdf-spike.md](../r0-pdf-spike.md) §8.3。
- 产物与 `analysis.json` 在 `.tmp-r0-pdf/`（gitignore）。

## 4. 证据

| 维度 | 结果 | 判定 |
|---|---|---|
| 页数、逐页文字字符数 | 逐项相同 | 等价 |
| 字体名/子集/嵌入（4 个 Type0 + FontFile2 + ToUnicode） | 逐项相同；中文 8 个标记双方全部可检索 | 等价 |
| 透明元素（ExtGState alpha）、printBackground 填充色集合 | 逐项相同 | 等价 |
| MediaBox | WebView2 A4 594.96×841.92 vs Electron 595.92×842.88（差 0.96pt≈0.34mm）；**传 Electron 实测英寸后 WebView2 精确复现 595.92×842.88** | 纸张单位=英寸被证实；可显式配平 |
| 字节数 | 差 127~206 B（<0.2%，Skia/PDF m157 vs m150） | 二进制不等价（预期） |
| 默认纸张 | 双方都是 Letter 612×792（非 A4） | 一致（产品必须显式传纸型） |
| `@page{margin:0}` vs 引擎 15mm 边距 | 两后端行为一致（逐页字符数 [1418,904] 相同） | 一致 |
| 自定义纸张 + `@page` | 双方都把 6.25×4.1667in 输出成 300×450 | 一致 |
| 失败分支 | Electron 微米当英寸 → `Printing failed`；WebView2 `SetPageWidth(0/-1)`/`SetScaleFactor(5)` → `E_INVALIDARG`；微米当英寸/0.25in → 完成回调 HRESULT `0x80070006` 无产物 | 已记录；需产品侧参数校验 |
| 单份耗时（Debug，仅数量级） | WebView2 111~141ms；Electron 452~510ms | 参考值，非性能基线 |
| 缺中文字体机器 | 本机 Windows 自带 CJK 字体，无法复现 | **未验证** |
| **增补：产品真实 `capture/print.html` 单图 A4 竖/横**（2026-11-11） | 两端均 1 页、MediaBox 595.92×842.88pt（竖）/ 842.88×595.92pt（横）、图片绘制框 473.54×842.02pt / 842.02×473.54pt，逐项相同；字节差 121 B | 等价 |
| **增补：DPR 修正负对照**（dpi=144 但按 PNG 自然像素注入） | 两端都变成 2 页且图片同样越界裁切（绘制框 648.37×1152.67pt、x0=-26.12pt/top=-154.44pt） | 等价（且证明 `intrinsicCssPx` 注入必要） |
| **增补：original 长图 20000/30000px → `MAX_PAGE_INCHES=200` 夹取** | 请求 208.33in → 夹取 200in；两端均 1 页、MediaBox 1440×14400pt（p4）/ Wv2 960.00 vs El 960.96×14400pt（p5），图片绘制框逐项相同、无裁切、无空白页 | WebView2 **支持 200in 纸张**；内容不丢；MediaBox 量化差 ≤0.96pt |
| **增补：批量 5/50 页（首页 A4、混合尺寸）** | 两端页数 5/5、50/50；每页恰好 1 图；无空白页/空白尾页；DOM `.print-page`=5/50、最后一页 `print-page-last`、容器 792×1121px 一致 | 等价 |
| **增补：产品函数对照** | Electron 直接调用 `exportPdfBuffer()` / `exportPagesToPdfBuffer()` 的 PDF 与手工注入流程**字节数完全相同**、语义逐项相同 | 手工流程未偏离产品实现 |
| **增补：WebView2 实现要点** | `ExecuteScript` 不等待产品脚本返回的 Promise（返回 `{}`），宿主必须轮询 DOM；真实页 CSP 不阻止 ExecuteScript、`img-src data:` 允许注入 PNG；旧 `PrintToPdf` 只接受绝对路径（相对路径 `0x80070057`） | R4-07 实现约束（见下 §5 前提 6～8） |
| **增补：Electron 自定义 pageSize 量化** | 小数英寸的 MediaBox 落在 0.24pt（300dpi）网格，最多 +0.96pt（诊断 11 组，如 13.333346in→13.346667in） | 若做逐点回归断言需给 ≤1pt 容差；非内容差异 |

## 5. 结论（建议）

**建议候选 A：WebView2 `PrintToPdfStream` 作为 R4-07 主后端**（置信度中高）。理由：内容/分页/字体/
文字/透明语义与本机 Electron 对照等价，且可复用现有 HTML 与几何规则；二进制不等价不是产品差异
（PDF 消费方只要求内容与可打印性），纸张单位必须显式按英寸传参。

实施前提：

1. 产品必须显式传纸型（默认 Letter 与产品预期不符），单位按英寸，并对非法参数做入口校验；
2. ~~R4-07 前用真实 `capture/print.html`（图片贴页、透明背景、长图 200in、批量 50 页）复验~~
   **2026-11-11 已用产品真实页复验（单机/合成 PNG，见 §4 增补；仍不等于 R4-07 完成）**；
3. 覆盖缺失 CJK 字体机器、Fixed Version/旧 Runtime、RDP/锁屏、隐藏打印峰值内存；
4. 打印窗口不是页面角色（`capture/print.html` 复用 `preload-capture.js` 但不在 `IPC_SURFACES`），
   新宿主必须显式排除其 IPC 能力；
5. 若上述复验不通过，转 B 并重估 R4-07（中文字体嵌入/分页等价成本）。
6. **A4 纸张必须映射成 Electron 实测英寸**（`595.92/72`×`842.88/72`，横版交换宽高）；
   WebView2 用 210/25.4×297/25.4 会得到 594.96×841.92（0.96pt 差）。`original` 分支产品已输出英寸，直接透传；
7. **就绪协议**：产品注入脚本返回 `decode()` Promise，WebView2 `ExecuteScript` 不会等待它（返回 `{}`）；
   宿主必须用 DOM 轮询（或 `ExecuteScriptWithResult`/脚本内显式状态）确认图片解码/批量追加完成后再打印。
   Electron `executeJavaScript` 直接返回解析值，两者不可共用同一"等待返回值"实现；
8. **打印设置与失败处理**：本机 WebView2 157 的 `PrintToPdfStream` 接受 200in 自定义纸张；设置读回
   （页面英寸/边距/背景/scale）作为防御性断言；旧 `ICoreWebView2_7::PrintToPdf` 需绝对路径；
   自定义 pageSize 的 MediaBox 与 Electron 允许 ≤1pt 量化差（语义断言，不做逐字节断言）。

## 6. 未解决限制

- 产品真实页复验只覆盖**单机 + 合成 PNG + 隐藏窗口**（当前机器 WebView2 Evergreen 157.0.4341.46 /
  Electron 43.8.3），未覆盖真实截图内容、缺字体机器、旧/Fixed Runtime、RDP/锁屏、真机 DPI 矩阵。
- WebView2 侧用一个隐藏窗口按用例导航（每用例唯一 URL、全新文档），未测窗口复用/销毁泄漏、
  并发打印、取消/超时（产品 30000ms）与失败恢复。
- 隐藏打印窗口峰值内存、大纸张（200in）打印耗时未测；Debug 构建耗时仅数量级参考。
- 与 Electron 产物的二进制不等价；Electron 自定义 pageSize 的 MediaBox 量化 ≤0.96pt，
  未来回归断言需按语义/≤1pt 容差。
- 中文字体嵌入依赖系统字体，字体许可与可移植性未评估。
- `capture/print.html` 经本地 HTTP 服务加载（真实文件/真实 CSP，但 origin 与产品 `file://`/Tauri
  asset 协议不同）；R4-07 接线后需在真实宿主协议下复验 CSP/`img-src data:` 行为。

## 7. 责任批次与退出验收

- R4-07：WebView2 打印实现 + 产品 print.html 复验 + 参数校验；失败则转 B 并更新估算。
- R8：安装包 Runtime 版本矩阵与缺字体环境验证。
- 退出验收：G2 前 PDF 输出内容/分页/字体/文字与基线一致；G4 前真机矩阵通过。

## 8. 变更记录

| 日期 | 变更 | 证据 |
|---|---|---|
| 2026-11-10 | 初稿：候选 A（WebView2 打印），附双后端 27 份 PDF 对照 | [r0-pdf-spike.md](../r0-pdf-spike.md) |
| 2026-11-11 | 增补产品真实 `capture/print.html` 双后端复验（7 用例 + 2 产品函数对照）：单图 A4 竖/横 + DPR 负对照、20000/30000px→200in 夹取、批量 5/50 页。新增 R4-07 实施前提 6～8（A4 英寸映射、ExecuteScript 轮询、绝对路径/量化容差）；状态仍为候选、未冻结 | [r0-pdf-spike.md](../r0-pdf-spike.md) §8；`.tmp-r0-pdf/product/analysis.json`、`analysis.md` |
| 2026-11-11 19:47 | ACL/完整性标签修复（Low→Medium）后 Medium IL 确认复跑：7 用例 + 2 产品函数对照结果与修复前**逐项一致（0 差异）**，`allContentEquivalent=true`、MediaBox 差 0.96pt、200in 夹取 1 页、批量 50 页=50 页无空白尾页；16 份 PDF 字节长度相同（sha256 差异仅 `CreationDate`/`ModDate` 运行时间戳）。无差异，结论不变、仍候选未冻结 | `.tmp-r0-pdf/product/acl-rerun-comparison.json`、`acl-rerun-baseline/`、`acl-rerun-integrity.log` |
