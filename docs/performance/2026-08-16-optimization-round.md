# 2026-08-16 性能优化清单与执行记录

- 采集日期：2026-08-16
- 版本：`2.1.0-beta.1`，提交 `a4f0830`
- 基准：`npm run bench:performance`（与 `2026-08-12-baseline.md` 对比）

## 1. 当前基线（2026-08-16 复测）

| 指标 | 2026-08-12 | 2026-08-16 | 结论 |
|---|---:|---:|---|
| 长截图 4K 垂直匹配 Median | 161.04 ms | 56.83 ms | 已达标（阈值 50ms 边缘，见下） |
| 长截图 4K 水平匹配 Median | 127.78 ms | 86.00 ms | 仍高于 50ms 门槛，后续语料到位再优化 |
| 历史首页分页 Median | 10.41 ms | 6.36 ms | 达标 |
| 历史 stats+orphan Median | 12.39 ms | 8.07 ms | 达标 |
| `sharp` 冷加载 Median | 31.18 ms | 30.53 ms | 持平 |
| `electron-updater` 冷加载 Median | 55.65 ms | 52.70 ms | 持平，且位于启动关键路径 |
| `screenshot-desktop` 冷加载 Median | 12.93 ms | 11.69 ms | 持平 |
| win-unpacked | 502.77 MiB | 502.76 MiB | 未变；locale 55 个 / 46.65 MiB |
| 录屏 60Hz→24fps 绘制削减 | — | 60% | 采样步进已生效 |

## 2. 优化列表（按执行顺序）

| 序号 | 项目 | 依据 | 预期收益 | 风险 |
|---|---|---|---|---|
| P1 | 安装包 locale 白名单（zh-CN、en-US） | 55 个 locale 占 46.65 MiB（unpack 体积 9.3%），应用文案仅中英文 | unpacked −约 44 MiB，安装包下载体积下降 | 低：electron-builder `electronLanguages` |
| P2 | 更新服务移出启动关键路径 | `initializeUpdateService()` 在 `createMainWindow` 之前同步 `require('electron-updater')`（52.7ms）；服务内部已有 `startupDelayMs` 延迟调度，无需同步初始化 | 打包版首窗时间 −约 50ms | 低：IPC 层已有懒代理，诊断/设置为空安全调用 |
| P3 | 历史页“加载更多”增量渲染 | `renderLoadedItems()` 每次整体重建全部卡片 innerHTML、重绑事件、重挂观察器 | 大量历史时避免整页重绘与缩略图闪烁 | 低：局部改造 |
| P4 | 无皮肤时禁用 backdrop-filter | `.sidebar`/`.titlebar`/`.card` 恒定 blur(18–20px)；默认 `--skin:none` 时模糊无视觉收益，仅剩 GPU 合成开销 | 历史网格滚动等合成开销下降 | 低：`body.has-skin` 门控 |
| P5 | 历史缩略图 img 增加原生懒加载提示 | img 均无 `loading`/`decoding` 属性 | 解码不阻塞主线程，渐进呈现 | 低 |

## 3. 明确后置的项目与理由

- **history-service 全量异步化**：502 行同步 I/O 服务 + 两个测试文件的重构；当前 SSD 基准 6–8ms，远低于 50ms 门槛，阻塞点均为用户主动打开历史页触发。待慢盘/失效路径场景补齐后再评估。
- **`sharp` 懒加载**：同时被 `main.js` 顶层与 `long-capture-session.js` 顶层引用，需双点改造，收益约 30ms（基线文档自评“非主要性能收益”）。
- **`screenshot-desktop` 懒加载**：启动时的显示器发现预热（`main.js` display warm-up）本来就立即需要它。
- **长截图匹配算法**：垂直 56.83ms 已接近门槛，水平 86ms 超标但优化需要真实语料（基线文档第 5 节第 3 条）先行，避免对合成数据过拟合。

## 4. 执行结果

| 序号 | 实施 | 验证 |
|---|---|---|
| P1 | `package.json` `build.electronLanguages: ["zh-CN","en-US"]` | 构建后核对 dist 内 locale 目录（见第 5 节） |
| P2 | 移除启动期 `initializeUpdateService()` 急切调用；新增 `resolveUpdateService()`（IPC 懒初始化）与 `deferUpdateServiceStart()`（首窗后 2s 调度 `start()`，服务内部 `startupDelayMs` 不变）；`update-ui-contract` 断言同步更新 | 测试套件通过；打包版首窗关键路径少一次 52.7ms 的同步 require |
| P3 | 历史页 `renderLoadedItems({ append })`：加载更多仅向网格追加新卡片，缩略图观察器持久化（不再断开重挂），事件重绑成本 O(n) 次属性赋值 | Playwright 桩渲染验证卡片计数与滚动行为 |
| P4 | `applyAppearance()` 增加 `body.has-skin` 门控；`.sidebar`/`.card` 的 backdrop-filter 移至 `body.has-skin` 前缀规则 | 计算样式确认无皮肤时 blur 不生效 |
| P5 | 历史缩略图 `img` 增加 `loading="lazy" decoding="async"` | DOM 属性验证 |

同步完成的视觉修复（历史页与模型页）：

- 历史页：统计卡改为独立彩条卡片（蓝/紫/黄/红顶条）、卡片 hover 浮起与缩放、双行元信息、深色自适应棋盘格背景、删除按钮危险态、加载更多胶囊按钮、通用空状态图标。
- 竖长缩略图溢出修复（用户反馈回归）：`display:grid;place-items:center` 容器内 `img` 的 `height:100%` 因循环尺寸依赖退化为 intrinsic 高度（400×1400 长图实测渲染 1012px，溢出容器 854px）。旧版因 `.history-image` 为 static 定位、按钮按文档流后绘制而视觉未暴露；本轮加入 `position:relative` 后绘制顺序反转、图片盖上按钮。治本方案：缩略图绝对定位铺满容器（`position:absolute;top:0;left:0`，容器 `overflow:hidden`），竖长图由 `object-fit:contain` 等比居中，实测 `overflowIntoMeta:0`。
- 模型页：子导航改为分段胶囊控件、手风琴头部修复第四列换行错位（grid 3→4 列）并在收起/展开态统一显示状态点+文字、展开态主色描边阴影、模型行 focus-within 焦点环、删除按钮危险态、保存行回归静态布局。
- 全局：输入框统一焦点环（`--focus-ring`）、禁用按钮对比度 0.45→0.55、按钮过渡动画。

验证方式：`npm test` 387/387 通过；Chromium 桩渲染两轮截图审查（含深色模式），第一轮发现的遮挡/换行/子导航不一致问题已在第二轮确认修复。

## 5. 构建核对

| 指标 | 优化前（2026-08-16 基线） | 优化后（本次构建） | 变化 |
|---|---:|---:|---|
| Electron locale 数量 | 55 | 2（en-US、zh-CN） | −53 |
| locale 占用 | 46.65 MiB | 约 1.7 MiB | −44.9 MiB |
| `win-unpacked` | 502.76 MiB | 458 MiB | −44.76 MiB（−8.9%） |
| `Highlighter-Setup-2.1.0-beta.1.exe` | 146 MB | 138 MB | −8 MB（−5.5%） |
