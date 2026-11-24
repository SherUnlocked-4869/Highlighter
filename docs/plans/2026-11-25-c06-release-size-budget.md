# C06 · 安装包增量与更新传输预算

来源：docs/reviews/2026-11-24-windows-product-architecture-review.md §C06。单个安装包大小不能说明用户实际下载了多少，也不能说明增长来自必需组件还是重复字节。

## 本机基线（2026-11-25，`dist/` 中已有的 5.0.1 构建）

| 度量 | 数值 |
|---|---|
| NSIS 安装包 Highlighter-Setup-5.0.1.exe | 184,503,823 字节（约 176.0 MiB） |
| blockmap | 192,954 字节 |
| win-unpacked 全树 | 569.3 MiB / 374 文件 |
| resources（含 app.asar 与 OCR/FFmpeg） | 254.1 MiB |
| Highlighter.exe | 228.5 MiB |
| 重复内容 | 见 `report:release-size` 输出的 duplicate 分组 |

重新生成（对任意已打包目录）：

```powershell
npm run report:release-size -- --dir dist/win-unpacked --out .tmp-perf/size-5.0.1.json
# 与基线比较：总增长 >5% 或任一组件增长 >5% / 新组件都要归因
npm run report:release-size -- --dir dist/win-unpacked --baseline .tmp-perf/size-baseline.json
```

报告包含：按顶层组件（`resources/app.asar.unpacked` 单独一组）、按扩展名、按 sha256 的重复内容（含可回收字节）、以及 app.asar 的 packed/unpacked 拆分。判定逻辑在 `scripts/lib/release-size.js`，阈值 5%。

## 更新传输演练（需要两个相邻候选包）

1. 构建相邻两个 NSIS 候选（例如 N 与 N+1），保留各自的 `.exe`、`.blockmap`、`latest.yml`。
2. 用本地更新源（`--config.publish.url` 指向本地目录或 `file://`）让 N 检查 N+1，记录：实际传输字节、是否发生全量回退（blockmap 不匹配时 updater 会整包下载）、安装耗时。
3. 便携版单独计量：便携包不会自更新，记录用户替换成本（下载体积 = 完整包）。
4. 断网安装检查仍保持：安装后不联网也能 OCR、录屏并导出 GIF（离线承诺由 D01 的默认关闭更新共同保证）。

## 门槛

- 同功能包压缩体积增长 >5% 必须在 PR/发布说明里归因到具体组件（报告会直接点名）。
- 每次发布记录传输字节与回退原因；缺两个相邻候选包时该项列待验，不以单包体积代替。
- `report:release-size` 只读本地文件，不上传、不联网。

## 本机可验证与不可验证

- 可验证：分组、重复内容、asar 拆分与 5% 判定（test/release-size.test.js）；对已有 5.0.1 构建的真实报告。
- 不可验证：两个相邻候选之间的真实差分传输与安装耗时——需要完整 electron-builder 产物与更新源演练。
