# R0-06 二进制资源通道小样（r0-resource-channel）

日期：2026-11-10（Asia/Hong_Kong）。状态：**R0 证据文档（草案，不是 gate 通过证据）**。
上位文档：[Rust 改造方案与开发计划](../2026-11-10-rust-migration-development-plan.md) §4.3（权限、事件与二进制资源）、
§7 R0-06、§8 G0；[R0 基线](r0-baseline.md) §4.4（二进制资源传输，当前"待验证"）。
本文件为 **ADR-0005（二进制资源传输）** 的实测证据；结论只作为候选建议，未冻结。

## 1. 背景与问题

计划 §4.3 要求：控制消息与大二进制分离；后端分配不可猜测资源 ID，限定生命周期/尺寸/类型/归属/释放；
图片不重复 Base64 化；视频不通过全局 JSON 事件发送；WebView 图片/视频资源须验证 CSP、seek/Range、
取消和路径遍历；**若自定义协议无法可靠识别调用窗口，不能伪造"已按窗口鉴权"**。

本小样在 Tauri 2 原型里实现并实测两条路径：

- **路径 1（command）**：`#[tauri::command]` 返回 `tauri::ipc::Response::new(Vec<u8>)`，前端 `invoke`
  直接拿 `ArrayBuffer`（Tauri 2 IPC 对 raw response 走 `arrayBuffer()`，不是 JSON/Base64 数组）；
- **路径 2（protocol）**：`register_uri_scheme_protocol("media", ...)`，Windows 上映射为
  `http://media.localhost/r/<id>`，支持 `Range` → 206 + `Content-Range`，并用
  `UriSchemeContext::webview_label()` 做请求来源窗口识别。

并回答：图片显示、video seek 的 Range 语义、未知/过期 ID、路径遍历、CSP、窗口归属鉴权是否可行，
以及同一份 20 MiB 数据两条路径的传输耗时/是否 Base64 膨胀。

## 2. 实测条件与命令

| 项 | 值 |
|---|---|
| OS / WebView2 | Windows 11 26300 / WebView2 Runtime `157.0.4341.42`（页面 UA：`Chrome/157.0.0.0 Edg/157.0.0.0`） |
| Tauri / wry / webview2-com | `2.12.5` / `0.57.2` / `0.39.1` |
| rustc / cargo | `1.97.1`（Debug 构建，耗时只作数量级参考） |
| 显示器 | 主屏 3840×2160@150%；副屏 `(3840,-170)` 1440×2560@125%。**两个可见窗口都只放副屏** |
| 窗口实际几何 | `media-a` outer `[3880,-130]` inner 1000×780@1.25；`media-b` outer `[3880,690]` inner 1000×420@1.25（`resource-report.json.windows`） |
| 测试媒体 | `ffmpeg-static`（ffmpeg 6.1.1）合成：`image.png` 800×600（61,530 B）；`video.mp4` 640×360/30fps/H.264+AAC，12.000s（1,258,778 B，`+faststart`）；20 MiB 合成二进制由 Rust xorshift64 生成（20,971,520 B，不可压缩） |
| 合成数据目录 | `.tmp-r0-resource/media/`（gitignore） |

```bash
# 生成测试媒体（仓库根目录；ffmpeg-static 已随 npm 依赖存在）
FF=node_modules/ffmpeg-static/ffmpeg.exe
$FF -y -f lavfi -i "testsrc2=size=800x600:rate=1" -frames:v 1 -update 1 .tmp-r0-resource/media/image.png
$FF -y -f lavfi -i "testsrc2=size=640x360:rate=30" \
    -f lavfi -i "sine=frequency=440:sample_rate=48000" -t 12 \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -b:a 96k \
    -movflags +faststart .tmp-r0-resource/media/video.mp4

# 构建并运行原型（独立 Cargo 工程，不改主 workspace）
CARGO_TARGET_DIR='F:/workspace/Highlighter/rust-app/target' \
  cargo build --manifest-path rust-app/prototypes/webview-pdf-resource/Cargo.toml
./rust-app/target/debug/highlighter-r0-pdf-resource.exe --resource --hold-ms 2000 \
  > .tmp-r0-resource/logs/resource-run4.log 2>&1
# 退出码 0；[r0-resource] checks 20/20；无残留本原型 msedgewebview2 进程（见 §7）
```

原型：`rust-app/prototypes/webview-pdf-resource/`（`--resource` 模式：
`src/resource.rs` + `prototype-ui/resource-a.{html,js}` / `resource-b.{html,js}`），
自带空 `[workspace]` 表，不改 `rust-app/Cargo.toml`/`Cargo.lock`。

## 3. 实现要点

- **资源注册表**：128-bit 随机 ID（`getrandom 0.3` → 32 hex）、`owner` = 窗口 label、MIME、字节、
  可选 TTL、撤销墓碑。ID 不可猜测；页面通过 `resource_meta` 命令拿到 URL/ID，不硬编码路径。
- **协议 URL**：`media://localhost/r/<id>` → Windows `http://media.localhost/r/<id>`；处理
  `GET/HEAD/OPTIONS`，单段 `Range`（`bytes=a-b`、`bytes=a-`、`bytes=-n`）→ 206 + `Content-Range`；
  多段 Range 退回整段 200（不假装支持）；越界 → 416 + `bytes */<len>`。
- **CORS/CSP**：响应带 `Access-Control-Allow-Origin/Expose-Headers/Allow-Methods/Allow-Headers/Max-Age`、
  `Timing-Allow-Origin: *`、`Cache-Control: no-store`；页面 CSP 在 `tauri.conf.json` 里显式放行
  `http://media.localhost`（`img-src/media-src/connect-src`）与 `ipc:`/`http://ipc.localhost`。
- **窗口归属**：命令面拿 `WebviewWindow::label()`（宿主侧、页面不可伪造）；协议面拿
  `UriSchemeContext::webview_label()`（宿主提供的"哪个 webview 发起的请求"）。两处都做 owner 校验。
- **日志**：协议请求逐条写 `webviewLabel/method/path/origin/range/status/contentRange/servedBytes/elapsedMicros`，
  落 `.tmp-r0-resource/protocol-requests.log`，作为 Range/206/403 的原始证据。

## 4. 验证结果表

`.tmp-r0-resource/resource-report.json` 的 `checks` 20/20 全部 PASS（`summary` 字段），
`protocolRequests` 21 条（GET 19 + OPTIONS 2）；HTTP 状态分布：
`200×7, 206×4, 204×2, 404×2, 400×2, 410×2, 416×1, 403×1`。

| 验证项 | 操作 | 实测结果 | 判定 |
|---|---|---|---|
| 图片-协议 | `<img src="http://media.localhost/r/<id>">` | 200，PNG 61,530 B，`naturalWidth/Height=800×600`；Resource Timing `transferSize=61,830`（payload+头，无 Base64） | 通过 |
| 图片-command | `invoke('resource_command',{id})` → `Uint8Array` → `Blob` → 图片 | `byteLength=61,530`，解码 800×600 | 通过 |
| 视频-协议加载 | `<video src="http://media.localhost/r/<id>">` | `duration=12`、640×360、`readyState=4`、`seekable=[[0,12]]` | 通过 |
| video seek（Range 证据） | `video.currentTime=8.5` | `seeked currentTime=8.5`；协议日志：先 `Range: bytes=0-` → **206 `Content-Range: bytes 0-1258777/1258778`**，seek 时 `Range: bytes=1245184-` → **206 `bytes 1245184-1258777/1258778`**（1,258,778 B 视频按需分段读取） | 通过 |
| 视频播放/取帧 | muted `play()` 700ms 后 pause；`canvas.drawImage(video)` | `currentTime 8.5→9.160`；取帧成功，落 `.tmp-r0-resource/video-frame-protocol.png`（60,811 B，未 taint） | 通过 |
| 显式单段 Range | `fetch(url,{headers:{Range:'bytes=1000-1999'}})` | **206**，`Content-Range: bytes 1000-1999/1258778`、`Content-Length: 1000`、`Accept-Ranges: bytes`、body 1,000 B | 通过 |
| 后缀 Range | `Range: bytes=-500` | **206**，`bytes 1258278-1258777/1258778`，body 500 B | 通过 |
| 越界 Range | `Range: bytes=<len+999999>-` | **416** + `Content-Range: bytes */1258778`，空 body | 通过 |
| CORS 预检 | 自定义头 `X-R0-Probe: 1`（触发 OPTIONS） | `OPTIONS` 204（日志 2 条），随后 GET 200 全量；`Access-Control-Allow-Headers`/`Max-Age` 生效 | 通过 |
| 视频-command（全量） | `invoke` 取 1,258,778 B → Blob URL → `<video>` | 加载/seek 到 6s 成功；**要求 CSP `media-src` 放行 `blob:`**（首轮未放行时被 CSP 拦截，见 §5） | 通过（有前提） |
| 未知 ID | 全 0 32-hex ID 请求 | **404** `resource-not-found` | 通过 |
| 过期 ID（TTL） | `resource_make_expiring(ttlMs=1200)`，2.4s 后请求 | **410** `resource-expired`（注册表删除+墓碑） | 通过 |
| 撤销 ID | `resource_revoke(id)` 后请求 | **410** `resource-revoked` | 通过 |
| 路径遍历-编码 | `/r/..%2F..%2FWindows%2Fwin.ini` | **400** `resource-id-invalid`（ID 只允许 32 hex，日志保留原始 path） | 通过 |
| 路径遍历-浏览器归一化 | `/../../Windows/win.ini`（浏览器归一为 `/Windows/win.ini`） | **400** `resource-id-invalid`（不是 `/r/<id>` 形状） | 通过 |
| 查询参数注入 | `.../r/<合法id>?path=../../Windows/win.ini` | **200** 同一资源本体（query 不参与解析，符合预期）；页面不据此读文件 | 通过 |
| 窗口归属-命令面 | `media-b` 调 `resource_command` 请求 A 的合法 ID | 拒绝：`code=window-owner-mismatch`（400/403 语义在 IPC 里是错误对象） | 通过 |
| 窗口归属-命令面正例 | `media-b` 调自己拥有的 `b-owned`（16 B） | 成功返回 16 B | 通过 |
| **窗口归属-协议面** | `media-b` 用 A 的合法 ID URL 发起 fetch（`resource_foreign_probe` 故意发放） | **403** `window-owner-mismatch`；协议日志 `webviewLabel` 值为 `media-a`/`media-b`，归属判定来自宿主而非页面 | **通过（协议可识别调用窗口）** |
| CSP 拦截 | fetch/`<img>` 指向 `http://csp-blocked.invalid/...` | fetch 抛 TypeError、图片解码失败；`securitypolicyviolation` 记录 2 条（`connect-src`、`img-src`；`blob:` 放行前的首轮另有 `media-src` 拦截记录，见 §5） | 通过 |
| CSP 放行 | `http://media.localhost` 图片/视频/fetch | 全部可用（CSP 显式列白） | 通过 |
| 路径遍历拒绝（注册表层） | 请求不存在的合法形状 ID | 404；不存在"按路径读文件"的代码路径 | 通过 |

### 4.1 20 MiB 传输对照（同一份数据，交替 3 轮）

数据：xorshift64 合成 20,971,520 B（不可压缩）；每轮 command 与 protocol 交替，`fetch(..., {cache:'no-store'})`。

| 轮次 | command `invoke` ArrayBuffer | protocol `fetch` arrayBuffer |
|---|---|---|
| 0 | 97.8 ms / 20,971,520 B | 94.0 ms / 20,971,520 B，`Content-Length: 20971520`，200 |
| 1 | 95.7 ms / 20,971,520 B | 89.4 ms / 20,971,520 B |
| 2 | 89.1 ms / 20,971,520 B | 82.2 ms / 20,971,520 B |
| 平均 | **94.2 ms** | **88.5 ms** |

（前一轮 debug 运行：command 84.4 ms vs protocol 81.7 ms；两轮结论一致：两者同数量级，protocol 略快。）

- **无 Base64 膨胀**：两路径拿到的字节数都精确等于 20,971,520；protocol 的
  Resource Timing `transferSize=20,971,820`（+300 B 头），`encodedBodySize=decodedBodySize=20,971,520`。
  command 的 IPC 请求（`http://ipc.localhost/resource_command`）在 Resource Timing 里
  `transferSize=0`（响应未带 `Timing-Allow-Origin`，无法读传输量），但 `ArrayBuffer.byteLength`
  精确 20 MiB —— 若走 Base64 应为约 27.96 MB，未出现。
- **服务端拷贝**：20 MiB 在协议处理器里 `Arc<Vec<u8>>` → `Vec` 拷贝（响应体要求
  `Cow<'static,[u8]>`），实测 1,872~2,187 µs；command 侧同样 1,864~1,982 µs 拷贝。两者各一次
  全量内存拷贝是可观测代价。
- **JS 堆**：`performance.memory.usedJSHeapSize` 采样 25.5 → 46.5 → 66.7 → 85.0 → 106.3 → 85.0 MB
  （每轮 20 MiB 响应各留 1 份 buffer，未强制 GC；仅数量级参考，不是泄漏结论）。

## 5. 失败分支与限制（实测/未验证）

| 分支 | 情况 | 记录 |
|---|---|---|
| `blob:` 被 CSP 拦截 | 首轮 `media-src` 只放行 `'self' http://media.localhost` | command 路径视频报 `MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check`，`securitypolicyviolation` 记 `media-src` blockedURI=`blob`；把 `blob:` 加入 `media-src` 后通过 — **command 视频必须放行 blob:** |
| Range 预检 | 首轮未返回 `Access-Control-Allow-Headers` | 后缀 Range 请求被 CORS 预检拦掉（fetch `Failed to fetch`，日志无该请求）；补齐预检响应头后 206 正常 — **协议通道必须实现 OPTIONS/CORS 头** |
| 视频 command 无 Range | 全量 1.26 MB 通过 IPC + Blob URL | 可播放/seek（内存中整体 seek），但**没有流式 Range**；长视频/大视频不可取 |
| 协议处理器窗口归属 | 依赖 `UriSchemeContext::webview_label()` | 本轮 Tauri 2.12.5 实测**可用**；但它是宿主 label（`media-a`/`media-b`），不是角色/权限；且只在 `register_uri_scheme_protocol` 路径成立。R1-04 仍必须做角色→命令/资源映射，不能把 label 当权限 |
| Tauri 命令 ACL | 原型未注册应用命令 ACL | `invoke_handler` 命令默认对所有窗口可用（计划 §4.3 已知缺口）；本原型只在命令入口做 owner 校验，**不等于** R1-04 的权限隔离 |
| 取消/abort | 未实现 | fetch `AbortController`、视频 seek 取消、窗口销毁时中止传输未验证 |
| 窗口生命周期释放 | 未实现 | TTL/显式撤销已测；"窗口销毁/重建后资源自动释放"未做，`revoke_owner` API 未接入窗口事件 |
| 长视频/大文件 | 未测 | 只测 12s/1.26 MB 与 20 MiB；100 MB+、4K、多段 Range、seek 抖动未测 |
| 缓存/ETag | 未实现 | 全部 `Cache-Control: no-store`；304/ETag/条件请求未验证（视频重复 seek 会重复传输） |
| 协议处理器线程/背压 | 未测 | 20 MiB 拷贝在处理器线程同步执行；并发请求、慢盘、背压未测 |
| 非 Windows 平台 | 未测 | `register_uri_scheme_protocol` 在 macOS/Linux 的 origin/行为不同（Tauri 文档），本原型 Windows-only |
| 多窗口/外部来源 | 未测 | 只验证 2 个 app 窗口；未来若加载远程内容/iframe，其请求同样带 webview label，需在 R1 明确策略 |

## 6. 结论（建议，供 ADR-0005）

**判定：两条路径都可行，且自定义协议在 Tauri 2.12.5 下可以识别调用窗口（不是"无法鉴权"）。**

- 图片：协议与 command 均可；协议无 Base64、可缓存/流式，静态图片建议**协议**；
- 视频：协议支持 `Range`/206/`Content-Range`，`<video>` 会按需发 Range（0-、后续 seek 段），
  seek 可用 —— **视频必须走协议**；command 路径只能全量进内存（小视频可接受，长视频不可）；
- 归属与安全：命令面与协议面都能按窗口 label 拒绝跨窗口访问（403 / IPC 错误）；协议面用
  `UriSchemeContext::webview_label()`，这是 R0 前登记为"待验证"的关键点，本轮实测**可行**；
  但它是 label 级隔离，不是角色权限，且依赖宿主代码（页面无法伪造）；
- 代价：协议响应要求 `Cow<'static,[u8]>`，每次响应一次全量拷贝（20 MiB 约 2 ms）；协议需要
  正确的 CORS/OPTIONS 与 CSP 白名单；command 路径无 Range。

**建议（置信度：中高，R0 单机原型）**：ADR-0005 选择 **候选 C** ——
"后端分配不可猜测 ID + 二进制通道"：**图片/视频等只读媒体走自定义协议（Range/流式）**，
**敏感或需窗口鉴权的内容走已校验 command 的二进制响应**；两者共用资源注册表与 owner 校验。
R1-04 需要把 label 校验升级为角色→资源映射，并补取消/生命周期/并发背压。**G0 前不写"已冻结"**。

## 7. 进程/窗口清理

- 两个可见窗口只在副屏 `(3840,-170)` 区域；PDF 用例窗口全隐藏；
- WebView2 数据目录固定在 gitignore 目录：`.tmp-r0-pdf/webview2-data/<label>`、
  `.tmp-r0-resource/webview2-data/<label>`；
- 应用 `app.exit()` 退出后实测**本原型相关 `msedgewebview2.exe` 进程数为 0**
  （`Get-CimInstance Win32_Process` 按 command line 含 `.tmp-r0-pdf`/`.tmp-r0-resource` 过滤）；
  宿主环境里其他原型残留的 WebView2 进程不属于本小样，未误杀；
- 原型单元测试：`cargo test --manifest-path rust-app/prototypes/webview-pdf-resource/Cargo.toml`
  → 15 passed（Range 解析、ID/路径校验、base64 解码、CLI、合成数据确定性；不启动 GUI）。

## 8. 复现与证据路径

| 证据 | 路径（均 gitignore） |
|---|---|
| 资源通道报告（checks 20/20 + 页面报告 + 命令日志） | `.tmp-r0-resource/resource-report.json` |
| 协议请求逐条日志（Range/206/403 原始证据） | `.tmp-r0-resource/protocol-requests.log`（21 条） |
| 视频取帧证据 | `.tmp-r0-resource/video-frame-protocol.png`（60,811 B，画布未 taint） |
| 测试媒体（可重建） | `.tmp-r0-resource/media/image.png`、`video.mp4` |
| 运行日志 | `.tmp-r0-resource/logs/resource-run4.log`（首轮失败分支在 `resource-run1.log`） |
| 原型源码 | `rust-app/prototypes/webview-pdf-resource/src/resource.rs`、`prototype-ui/resource-*.{html,js}`、`tauri.conf.json`（CSP） |

**门禁声明：本文件不构成 G0 通过证据，也不代表 R1-04 的资源权限/取消/生命周期已实现。**
未执行：取消/abort、窗口销毁释放、长视频/多段 Range、并发背压、非 Windows 平台、真实 4K 视频、
ETag/缓存策略。

## 9. 变更记录

| 日期 | 变更 | 证据 |
|---|---|---|
| 2026-11-10 | R0-06 资源通道小样首轮实测（command vs 自定义协议、Range/seek、窗口归属、CSP、20 MiB 对照），产出本文件与 ADR-0005 证据表 | 上表各路径 |
