# ADR-0005：图片/视频二进制资源传输

- 状态：**候选（有 Tauri 2 原型实测，未冻结）**
- 决定批次：R0-06；实施批次：R1/R4/R5
- 日期：2026-11-10
- 关联计划：§4.3（权限、事件与二进制资源）、§7 R0-06、§8 G0
- 证据文档：[r0-resource-channel.md](../r0-resource-channel.md)、
  [`rust-app/prototypes/webview-pdf-resource/`](../../../../rust-app/prototypes/webview-pdf-resource/)（`--resource` 模式）

## 1. 背景与问题

计划 §4.3 要求：控制消息与大二进制分离；后端分配不可猜测资源 ID 并限定生命周期/尺寸/类型/归属/释放；
图片不重复 Base64；视频不走全局 JSON 事件；WebView 资源须验证 CSP、seek/Range、取消与路径遍历；
**若自定义协议无法可靠识别调用窗口，不能伪造"已按窗口鉴权"**。本 ADR 决定图片/视频/大对象的传输方式。

## 2. 备选方案

| 方案 | 描述 | 优点 | 代价/风险 |
|---|---|---|---|
| A command JSON/base64 | `invoke` 返回 base64 | 实现简单 | 大对象膨胀内存、重复过 JSON（计划明确避免） |
| B command 二进制响应 | `tauri::ipc::Response::new(Vec<u8>)` → 前端 `ArrayBuffer` | 无 Base64 膨胀；可做窗口归属校验 | 无 Range/seek 语义；视频需 `media-src blob:` CSP |
| C 自定义 URI scheme protocol + 不可猜测 ID | `register_uri_scheme_protocol("media", …)`，支持 `Range`/206、TTL/撤销、owner 校验 | 视频 seek/流式；CSP 可白名单；图片可直接 `<img>` | 需 OPTIONS/CORS 头；窗口识别为 label 级、非角色权限 |
| D 混合（C 流式 + B 敏感内容） | 普通媒体走协议，敏感/需强鉴权内容走 command 二进制 | 兼顾性能与安全边界 | 两套路径需统一资源注册表与释放语义 |

## 3. 实测条件与命令

- 环境：Windows 11、WebView2 Runtime 157.0.4341.42、Tauri 2.12.5 / wry 0.57.2；
  原型独立 Cargo 工程（空 `[workspace]`）。
- 复现：`rust-app/prototypes/webview-pdf-resource/ --resource`；页面自检 20/20 PASS；
  证据在 `.tmp-r0-resource/`（gitignore）。

## 4. 证据

| 验证项 | 结果 | 判定 |
|---|---|---|
| 图片（协议 200 / command ArrayBuffer） | 800×600，协议 transferSize 61,830 B，command 61,530 B，均正常显示 | 通过 |
| 视频协议 + Range/seek | `<video>` 实发 `Range: bytes=0-` → `206 Content-Range: bytes 0-1258777/1258778`；seek 8.5s → `bytes=1245184-` → 206；seek/play 正常（currentTime 8.5→9.160），取帧 PNG 证据 | **通过** |
| 手工 Range | `bytes 1000-1999` → 206；后缀 `-500` → 206；越界 → 416 `bytes */1258778`；OPTIONS 预检 → 204 | 通过 |
| 拒绝路径 | 未知 ID 404、TTL 过期 410、撤销 410、`..%2F..%2FWindows%2Fwin.ini` 与归一化路径均 400、query 注入不参与解析 | 通过 |
| 窗口归属鉴权 | command 面跨窗口 → `window-owner-mismatch`；协议面跨窗口合法 ID → **403**（`UriSchemeContext::webview_label()` 实测可用） | **通过（label 级）** |
| CSP | 显式放行 `http://media.localhost` 后图片/视频可用；未列 origin 触发 securitypolicyviolation；**command 视频需 `media-src 'blob:'`** | 已记录（坑） |
| 20 MiB 传输对照 | command avg 94.2ms vs protocol 88.5ms；双方 byteLength 精确 20,971,520（无 Base64 膨胀）；protocol transferSize +300B 头；服务端各一次全量拷贝 ~1.9~2.2ms | 通过（数量级） |
| 退出清理 | 原型相关 `msedgewebview2.exe` 残留 0 | 通过 |
| 取消/abort、窗口销毁自动释放 | 未测（TTL/显式撤销已测） | 未验证 |
| 长视频/多段 Range/大文件/并发背压/ETag/非 Windows | 未测 | 未验证 |

## 5. 结论（建议）

**建议候选 D（混合）：不可猜测资源 ID 注册表 + owner 校验；图片/视频走自定义协议（Range 流式），
敏感或需强鉴权内容走 command 二进制响应**（置信度中高）。约束：

1. 资源 ID 必须不可猜测（随机），服务端维护 TTL/尺寸/类型/owner/释放；过期 410、未知 404；
2. 协议路径必须实现 Range/206/416、OPTIONS/CORS、路径归一化与遍历拒绝；CSP 显式白名单；
3. `UriSchemeContext::webview_label()` 可做 label 级窗口归属，但**不是角色权限**——R1-04 仍必须把
   13 角色映射为命令/资源能力并在入口二次校验（计划 §4.3 明确不能只加 capability 就宣称隔离）；
4. 敏感内容（截图正文/剪贴板内容/凭据相关）不得走无鉴权的全局协议；走 command 二进制或带
   owner 校验的受限通道；
5. 图片不重复 Base64、视频不走全局 JSON 事件；取消/abort 与窗口销毁自动释放需在 R1/R4 补齐。

## 6. 未解决限制

- 取消/abort、窗口销毁自动释放、长视频/多段 Range、大文件、并发背压、ETag/缓存、非 Windows 平台未验证。
- label 级 owner 校验对多窗口/重建窗口/旧订阅失效的边界未验证（R1-02 generation 语义需结合）。
- 20 MiB 对照只是数量级，非 Release 性能基线。

## 7. 责任批次与退出验收

- R1-04：资源注册表 + 命令/资源权限映射 + 入口二次校验。
- R4/R5：图片/视频/导出资源接入；窗口销毁/任务取消释放；视频 seek 与 Range 回归。
- 退出验收：G1 前完成越权/伪造/旧 generation 拒绝测试；G2 前完成大文件/长视频/取消场景。

## 8. 变更记录

| 日期 | 变更 | 证据 |
|---|---|---|
| 2026-11-10 | 初稿：候选 D（协议流式 + command 敏感内容），附 20/20 自检与 Range/鉴权证据 | [r0-resource-channel.md](../r0-resource-channel.md) |
