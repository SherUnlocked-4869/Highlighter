# webview-pdf-resource（R0-06 原型）

独立 Tauri 2 原型，只做 R0-06 两类风险验证，**不是生产宿主**：

- `--pdf`：WebView2 `ICoreWebView2_16::PrintToPdfStream` / `ICoreWebView2_7::PrintToPdf`
  隐藏窗口打印矩阵（纸张/边距/背景/单位/失败分支），产物 `.tmp-r0-pdf/`；
- `--resource`：command 二进制响应 vs 自定义 URI scheme (`media://` → `http://media.localhost`)
  资源通道（图片、视频 Range/seek、不可猜测 ID/TTL/撤销、路径遍历、CSP、窗口归属、20 MiB 传输对照），
  产物 `.tmp-r0-resource/`。

本目录自带空 `[workspace]` 表，**不并入** `rust-app/` 主 workspace，也不改其 Cargo.toml/Cargo.lock。
证据与判定见：

- [`docs/plans/rust-migration/r0-pdf-spike.md`](../../../docs/plans/rust-migration/r0-pdf-spike.md)
- [`docs/plans/rust-migration/r0-resource-channel.md`](../../../docs/plans/rust-migration/r0-resource-channel.md)

## 构建 / 运行（仓库根目录）

```bash
export CARGO_TARGET_DIR='F:/workspace/Highlighter/rust-app/target'   # 复用主 workspace 已编译依赖
cargo build --manifest-path rust-app/prototypes/webview-pdf-resource/Cargo.toml

# A. PDF（隐藏窗口；不需要副屏）
./rust-app/target/debug/highlighter-r0-pdf-resource.exe --pdf

# B. 资源通道（可见窗口只放副屏；无副屏时退出码 2，不创建窗口）
./rust-app/target/debug/highlighter-r0-pdf-resource.exe --resource --hold-ms 2000
```

资源模式需要先准备合成媒体（`.tmp-r0-resource/media/`，见 `r0-resource-channel.md` §2）：

```bash
FF=node_modules/ffmpeg-static/ffmpeg.exe
FF=$FF ; mkdir -p .tmp-r0-resource/media
$FF -y -f lavfi -i "testsrc2=size=800x600:rate=1" -frames:v 1 -update 1 .tmp-r0-resource/media/image.png
$FF -y -f lavfi -i "testsrc2=size=640x360:rate=30" -f lavfi -i "sine=frequency=440:sample_rate=48000" -t 12 \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart .tmp-r0-resource/media/video.mp4
```

20 MiB 对照数据由原型内 xorshift64 生成，无需外部文件。

## 前端样例

| 文件 | 用途 |
|---|---|
| `prototype-ui/print-sample.html` | 合成打印样例：中文/表格/内嵌 PNG/`@page A4`/跨页/透明元素；两个后端加载同一文件 |
| `prototype-ui/print-sample-csspage.html` | 同上但 `@page { size: A4; margin: 15mm }` |
| `prototype-ui/print-plain.html` | 无 `@page` 的对照页 |
| `prototype-ui/print-ready.js` | 字体/图片就绪信号（Tauri → `pdf_page_ready`；Electron → `__PDF_SAMPLE_READY__`） |
| `prototype-ui/resource-a.{html,js}` | 资源所有者窗口自检（协议/command/Range/CSP/20 MiB） |
| `prototype-ui/resource-b.{html,js}` | 非所有者窗口的跨窗口拒绝测试 |

## 数据目录（均 gitignore）

- WebView2 数据目录：`.tmp-r0-pdf/webview2-data/<label>`、`.tmp-r0-resource/webview2-data/<label>`
- 报告/日志：`.tmp-r0-pdf/webview2-print-report.json`、`.tmp-r0-resource/resource-report.json`、
  `.tmp-r0-resource/protocol-requests.log`
- Electron 对照探针：`scripts/rust/probe-electron-pdf.js`（见 `r0-pdf-spike.md` §2.2 的运行命令）

退出后不应残留本原型的 `msedgewebview2.exe`；如异常残留，按 command line 中的
`.tmp-r0-pdf` / `.tmp-r0-resource` 数据目录过滤清理，不要误杀其他 Wry 应用。

## 已知限制

- Windows-only（WebView2 COM）；应用命令默认不受 capability ACL 约束（R1-04 范围）；
- 打印/资源通道都是最小闭环，取消、窗口销毁释放、长视频/多页批量等未验证（见两份证据文档）。
