# 2026-11-26 全量代码评审后续开发计划
| U01 | 715d3c8 | 多选整组拖拽、内联文字编辑器（CJK/多行包围盒）、PDF 结果条接线 |
| U02 | 241c981 | 长截图预览改条带缩略图（线性映射）、剥离固定悬浮栏、贴图 move-end 合并为一次 setBounds |
| U03 | 186cd39 | window 模式重录、历史项目帧率回退、首帧真实尺寸、软限幅混音、Direct-Track 禁用标注 |
| U04 | 6acf903, 1be7f6 | 表格列投影聚类 + merges、搜索路径化图标/isFolder/合并排序；终端保护下发原生层、按窗口流控制、600ms 粘贴窗口 |
| F01–F06 | 21c4e81…4f7554c | 设置/日志/历史缓存、录屏句柄与硬件编码、Everything 目标缓存、剪贴板计数与屏障、截图/长图/贴图流水线 |
| F07 | 27d3f4c, 61fbb0c, 4d8fa7b | 会话索引、usage 三项、AI 路由缓存/索引化翻译/代理复用/OCR Level3/迁移复用 |
| N01–N06 | 1ebe2de…5099151 | 智能脱敏、历史 OCR 索引与标签、剪贴板图片动作、快捷键胶囊与静音裁剪、Quick Look 与拖拽、Ctrl+K 搜索与加密备份 |

2026-11-26 · Highlighter Windows / Electron · 评审基线 `master@8416120`（应用版本 5.0.1）· 开发分支 `feat/review-optimization-2026-11-26`

本计划把 [全量代码评审与优化建议报告](../reviews/2026-11-26-code-review-and-optimization-report.md) 的
**5 项 P0 高危缺陷、7 项性能优化、5 组功能与体验修复、6 项创新功能**拆成 23 张工单。
编号供开发、提交和回归记录共同引用；交付证据登记见
[证据登记表](../evidence/2026-11-26-review-optimization-evidence.md)。

> 报告中的行号基线为 `master@8416120`，与当前分支代码一致；但评审为静态阅读产物，
> **每张工单开发前必须先按“触发条件”在隔离样本中复现**，行号/结论与代码不符时以代码为准，
> 并在提交信息与证据表中写明实测结论。

## 工单编号

| 编号 | 来源 | 优先级 | 主题 | 主要写入范围 |
|---|---|---|---|---|
| H01 | 报告 §二.1 | P0 | 历史记录删除不清理 `history/documents/<id>/`、恢复索引死代码、迁移漏重写文档路径 | `main/services/history-service.js`, `main/services/capture-document-service.js`, `main/services/data-root-migration.js`, `main/services/data-root.js`, `main.js` |
| H02 | 报告 §二.2 | P0 | 马赛克缓存字节账本只增不减，拖拽十几帧后缓存永久失效 | `capture/capture.js` |
| H03 | 报告 §二.3 | P0 | `simpleMarkdown` 破坏代码块内容；流式渲染每帧全量重建 DOM | `action/action.js` |
| H04 | 报告 §二.4 | P0 | OCR / Everything 管道分块 UTF-8 解码截断；`WM_COPYDATA` 缺 `dwId` 校验 | `main/services/ocr-service.js`, `main/services/everything-service.js`, `native/everything-search/src/main.rs` |
| H05 | 报告 §二.5 | P0 | `main.js` 触顶行数门禁催生超长行；架构门禁漏检 `handle('record:')` | `main.js`, `scripts/check-architecture.js`, `main/domains/tray/`, `main/ipc/` |
| F01 | 报告 §三.1 | P0 | 设置/日志/历史存储的高频同步读盘、`JSON.parse` 与重复 DPAPI 解密 | `main/services/settings-service.js`, `main/services/credential-store.js`, `main/services/app-logger.js`, `main/services/history-service.js`, `main.js` |
| F02 | 报告 §三.2 | P0 | 划词全局钩子把每次按键/滚轮跨进程转发，`hideToolbar()` 不查可见性 | `vendor/selection-hook/src/windows/selection_hook.cc`, `main/services/selection-hook-host.js`, `main/domains/selection/index.js`, `main/services/selection-window-manager.js` |
| F03 | 报告 §三.3 | P0 | 录屏分片每秒 `open/write/close`；导出 30 层 ripple `overlay`；纯 CPU 软编码 | `main/services/recording-service.js`, `shared/recording-export-options.js`, `record/recording-utils.js` |
| F04 | 报告 §三.4 | P1 | Everything 每查询全桌面枚举 + `*.exe` 探测；空闲回收误杀索引进程；PowerShell WMI 冷启动 | `native/everything-search/src/main.rs`, `main/services/everything-service.js` |
| F05 | 报告 §三.5 | P1 | 剪贴板 SQLite 每次复制全表聚合 + `maintain()`；全局 Barrier 内解码 4K PNG 与两次 SHA-256；缩略图缓存整表清空 | `native/clipboard/src/storage.rs`, `native/clipboard/src/writer.rs`, `main/domains/clipboard/index.js`, `clipboard/clipboard.js` |
| F06 | 报告 §三.6 | P1 | 截图窗口冷启动；`isBlankCapture` 主线程解码；长截图 4~5 次全图编解码；matcher 伪粗搜；贴图 FIFO 驻留 | `main/domains/capture/index.js`, `main/services/long-capture-session.js`, `long-capture/long-capture.js`, `long-capture/matcher.js`, `main/services/pin-image-store.js`, `pin/pin.js` |
| F07 | 报告 §三.7 | P2 | Usage 扫描冗余、ConversationStore 同步读目录、OCR 滤镜与临时落盘、AI 客户端探测与翻译请求雪崩、迁移重复哈希 | `main/services/usage-*.js`, `main/services/conversation-store.js`, `main/services/ocr-service.js`, `native/ocr/src/main.rs`, `main/services/ai/client.js`, `main/services/translation-proxy-service.js`, `main/services/data-root-migration.js` |
| U01 | 报告 §四.1 | P1 | 截图：多选鼠标拖拽、文字内联编辑器与 CJK 包围盒、PDF 导出结果条 | `capture/capture.js`, `capture/annotation-geometry.js` |
| U02 | 报告 §四.2 | P1 | 长截图预览级联重采样、剥离固定悬浮栏、贴图矢量重标注、跨 DPI 拖拽跳动 | `long-capture/long-capture.js`, `long-capture/matcher.js`, `main/domains/pin/index.js`, `pin/pin.js` |
| U03 | 报告 §四.3 | P1 | 录屏：重录窗口模式退化、历史项目帧率丢失、高分屏降采样、混音 -6dB 与削波、Direct-Track 标注入口 | `main/domains/record/index.js`, `record/record.js`, `record/audio-mixer.js` |
| U04 | 报告 §四.4 | P1 | 划词黑名单/终端保护、全局 processing 锁、翻译回声与日文误判、剪贴板 Ctrl+Enter、OCR 表格列聚类、本地搜索图标与排序 | `main/services/selection-hook-host.js`, `vendor/selection-hook/src/windows/`, `main/domains/selection/index.js`, `main/ipc/selection-ipc.js`, `main/services/ai/client.js`, `main/services/translation-proxy-service.js`, `clipboard/clipboard.js`, `native/clipboard/src/paste.rs`, `capture/recognition-utils.js`, `main/services/table-workbook.js`, `search/*` |
| U05 | 报告 §四.5 | P1 | 截图水印设置 UI、路由切换定时器覆写、主窗口回收竞态、配置页脏状态与语言互换 | `config/routes/*.js`, `main.js` |
| N01 | 报告 §五.1 | P2 | 智能隐私脱敏助手（OCR 正则 → 可编辑模糊标注） | `capture/capture.js`, `shared/`, `main/` |
| N02 | 报告 §五.2 | P2 | 历史截图 OCR 索引检索 + 剪贴板图片 OCR/转表格/转贴图 | `main/services/history-service.js`, `clipboard/clipboard.js`, `config/routes/history.js` |
| N03 | 报告 §五.3 | P2 | 录屏快捷键胶囊 HUD + 一键剔除静音停顿 | `record/record.js`, `record/editor.*`, `main/domains/record/index.js`, `record/trim-controller.js` |
| N04 | 报告 §五.4 | P2 | 本地搜索空格预览 + 原生文件拖拽发送 | `search/search.js`, `preload-search.js`, `main/domains/search/index.js` |
| N05 | 报告 §五.5 | P2 | 贴图像素对齐洋葱皮 + 贴图工作区快照 | `pin/pin.js`, `main/domains/pin/index.js` |
| N06 | 报告 §五.6 | P2 | 配置中心全局搜索 `Ctrl+K` + 单文件加密 ZIP 备份 | `config/`, `main/services/data-root-backup.js`, `shared/` |

## 开发顺序与批次

| 批次 | 工单 | 交付边界 |
|---|---|---|
| 一　数据保全与渲染正确性（P0） | H01 → H02 → H03 → H04 → H05 | 随意删除历史不再泄漏磁盘；马赛克/代码块/中文文本不再损坏；`main.js` 回到可读的多行格式且门禁补漏 |
| 二　主线程与跨进程性能（P0/P1） | F01, F02, F03, F04, F05, F06, F07 | 高频路径不再同步读盘/解密；日常打字与滚轮不再产生 IPC 唤醒风暴；录制与导出不再被 I/O 与滤镜拖住 |
| 三　功能缺陷与体验（P1） | U01, U02, U03, U04, U05 | 报告 §四 逐条修复，含 CJK 包围盒、窗口模式重录、图标与排序等可直接感知的问题 |
| 四　创新功能（P2） | N01, N02, N03, N04, N05, N06 | 每项可单独开关/回退，不改变既有默认行为的前提下新增能力 |

每张工单的流程固定为：**复现 → 用例 → 实现 → 定向回归 → `npm run check` → 证据登记**。
原生改动（Rust/C++）额外要求 `cargo build --release` / `node-gyp rebuild` 通过，并说明二进制是否随仓库发布。

## 门禁与证据

- 每张工单至少一个新/改的回归用例，文件名或用例名包含工单编号，登记到
  [证据登记表](../evidence/2026-11-26-review-optimization-evidence.md)；`npm run check:review-evidence` 强制。
- 新增 UI 文案必须进 `shared/locales/*.js` 三语表，`npm run check:i18n --max 606` 不允许抬高上限。
- `npm run check:architecture` 中 `main.js` 行数上限只允许在 H05 完成后下调，不允许上调。
- 本机为受限宿主：Electron GUI 探针按 `AGENTS.md` 的四条环境陷阱处理；真机项在证据表“真机门槛”列注明，
  不以模拟通过冒充真机结论。

## 状态

| 批次 | 状态 |
|---|---|
| 一 | 已完成（H01–H05 全部提交，校准后实现/回归/证据齐备） |
| 二 | 已实现（F01–F07 全部提交；F07 原生/迁移收尾在最后一轮） |
| 三 | 已完成（U01–U05 已提交，个别子项按报告降级并已在证据表注明） |
| 四 | 已完成（N01–N06 全部提交，降级子项已在证据表注明） |

### 已完成工单的提交

| 工单 | 提交 | 关键结论 |
|---|---|---|
| H01 | `d76a9ba` | 删除历史同步清理 `documents/<id>/`；`orphanFiles`/`stats` 计入文档树；启动恢复索引接线 |
| H05 | `7125f22` | 托盘→`main/domains/tray`、IPC 注册→`main/ipc/index.js`；`main.js` 1330→1202 行、最长行 376→158；门禁加 `.handle(` 与 160 字符行限 |
| H03 | `7257faf` | Markdown 解析器迁到 `shared/simple-markdown.js`，围栏内原样输出；流式只重绘尾部块 |
| H04 | `d58ebfc` | 子进程 stdout 用 StringDecoder 增量解码；Everything 回执按 `COPYDATASTRUCT.dwData` 匹配（报告所述 `LIST2.dwId` 偏移不存在） |
| H02 | `c394bba` | 马赛克补丁账本改为有界 LRU（稳定 identity + 精确扣减 + 涂抹期 draft id） |
| F02 | `90f4e54` | 工具条不可见时不再跨进程转发按键/滚轮；`hideToolbar()` 幂等；原生输入计数不变 |
| F07（部分） | `27d3f4c`, `61fbb0c` | 会话目录内存索引；usage 扫描不再持久化 hourly、模型去重、状态探测 30s 缓存 |
| U05 | `53a7b8e` | 水印设置表单；路由脏状态/搜索定时器/录制预检/语言互换；主窗口显示时解除空闲回收 |
