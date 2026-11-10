# ADR-0003：PDF 导出后端（WebView2 打印 vs 原生 PDF）

- 状态：**候选（有双后端对照证据，未冻结）**
- 决定批次：R0-06；实施批次：R4-07
- 日期：2026-11-10
- 关联计划：§2 D05/D06、§4.3、§5.1、§7 R0-06、§8 G0
- 证据文档：[r0-pdf-spike.md](../r0-pdf-spike.md)、[`rust-app/prototypes/webview-pdf-resource/`](../../../rust-app/prototypes/webview-pdf-resource/)、
  [`scripts/rust/probe-electron-pdf.js`](../../../scripts/rust/probe-electron-pdf.js)

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

- 环境：Windows 11 build 26300.9711；WebView2 Runtime 157.0.4341.42；Electron 43.8.3
  （Skia/PDF m150）vs WebView2（Skia/PDF m157）；pypdf 7.0.1（装在 gitignore 的 `.tmp-r0-pdf/pylibs`）。
- 同一份合成 HTML：中文正文、30 行跨页表格、内嵌 PNG、`@page A4`、透明元素；双后端共 27 份 PDF
  （WebView2 12 份、Electron 15 份含失败分支）。
- 复现：`rust-app/prototypes/webview-pdf-resource/ --pdf` 与
  `node scripts/rust/probe-electron-pdf.js`（Electron 需 `env -u ELECTRON_RUN_AS_NODE`，`--no-sandbox`
  在脚本路径前）。产物与 `analysis.json` 在 `.tmp-r0-pdf/`（gitignore）。

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
| 产品真实 `capture/print.html`、批量 50 页、200in 长图 | 未执行 | **未验证（R4-07 前必须补）** |

## 5. 结论（建议）

**建议候选 A：WebView2 `PrintToPdfStream` 作为 R4-07 主后端**（置信度中高）。理由：内容/分页/字体/
文字/透明语义与本机 Electron 对照等价，且可复用现有 HTML 与几何规则；二进制不等价不是产品差异
（PDF 消费方只要求内容与可打印性），纸张单位必须显式按英寸传参。

实施前提：

1. 产品必须显式传纸型（默认 Letter 与产品预期不符），单位按英寸，并对非法参数做入口校验；
2. R4-07 前用**真实 `capture/print.html`**（图片贴页、透明背景、长图 200in、批量 50 页）复验；
3. 覆盖缺失 CJK 字体机器、Fixed Version/旧 Runtime、RDP/锁屏、隐藏打印峰值内存；
4. 打印窗口不是页面角色（`capture/print.html` 复用 `preload-capture.js` 但不在 `IPC_SURFACES`），
   新宿主必须显式排除其 IPC 能力；
5. 若上述复验不通过，转 B 并重估 R4-07（中文字体嵌入/分页等价成本）。

## 6. 未解决限制

- 未用产品真实打印页/批量/长图验证；未在缺字体机器、旧 Runtime、RDP/锁屏验证。
- 隐藏打印窗口峰值内存、并发打印、取消/超时语义未测。
- 与 Electron 产物的二进制不等价；若未来有逐字节回归断言需改为语义断言。
- 中文字体嵌入依赖系统字体，字体许可与可移植性未评估。

## 7. 责任批次与退出验收

- R4-07：WebView2 打印实现 + 产品 print.html 复验 + 参数校验；失败则转 B 并更新估算。
- R8：安装包 Runtime 版本矩阵与缺字体环境验证。
- 退出验收：G2 前 PDF 输出内容/分页/字体/文字与基线一致；G4 前真机矩阵通过。

## 8. 变更记录

| 日期 | 变更 | 证据 |
|---|---|---|
| 2026-11-10 | 初稿：候选 A（WebView2 打印），附双后端 27 份 PDF 对照 | [r0-pdf-spike.md](../r0-pdf-spike.md) |
