# 2026-11-26 全量评审优化批次 · 交接记录

> 来源报告：[2026-11-26 全量代码评审与优化建议报告](../reviews/2026-11-26-code-review-and-optimization-report.md)
> 开发计划：[2026-11-26 评审后续开发计划](2026-11-26-review-optimization-development-plan.md)
> 证据登记：[2026-11-26 交付证据登记表](../evidence/2026-11-26-review-optimization-evidence.md)
> 发布后修复：[2026-11-27 历史 OCR / 标签交互修复方案](2026-11-27-history-ocr-ux-fixes.md)
> 日期：2026-11-28（Asia/Hong_Kong）
> 状态：**代码完成，已随 5.1.0 / 5.1.1 发布；自动化门禁全绿；安装包与真机矩阵未由本批次验证**（见 §6）

---

## 1. 一句话现状

分支 `feat/review-optimization-2026-11-26` 已推送并领先 `origin/master` **45 个提交**（164 个文件，+31776/−1805），HEAD `dc4dda4`（版本 **5.1.1**）。报告的 23 张工单（5 P0 / 7 性能 / 5 体验 / 6 创新）全部落地并各自带回归用例；发布候选上又发现并修复了历史 OCR 的三项交互问题（5.1.1）。`npm run check` 全绿；`npm test` **3236/3237**，唯一失败是 AGENTS.md 已记录的计时 flake（单跑通过，见 §5.7）。

| 指标 | 数值 |
|---|---|
| 提交 | 45（`git log --oneline origin/master..HEAD`） |
| 变更 | 164 文件，+31776/−1805 |
| 星标文件 | 新增 10 个源模块、29 个回归测试文件、2 个 e2e 用例文件 |
| `npm run check` | 语法 611 文件 / 架构 `main.js` 1204/1205 行、最长行 158/160 / i18n 未迁移 CJK 602/606 / 评审证据 2 登记表 50 工单 9 必需 P0 |
| `npm test` | 3237 项，3236 通过（失败项见 §5.7） |
| 原生 | clipboard cargo 30+12、everything 13、ocr 4 全过；everything 侧车 exe 已入库 |

---

## 2. 文档索引

| 文档 | 用途 |
|---|---|
| [全量评审报告](../reviews/2026-11-26-code-review-and-optimization-report.md) | 问题与建议的原始依据（含少量已被实测推翻的结论，见 §5.5） |
| [开发计划](2026-11-26-review-optimization-development-plan.md) | 23 张工单编号、批次、状态、提交对照 |
| [证据登记表](../evidence/2026-11-26-review-optimization-evidence.md) | 每个工单 → 回归测试文件 → 真机门槛；`check:review-evidence` 强制 |
| [5.1.1 交互修复方案](2026-11-27-history-ocr-ux-fixes.md) | 发布候选真机反馈的三项问题，含根因与 8 处加固 |
| 本文 | 接手所需的环境、约束、未做项与验证路径 |

---

## 3. 工单完成情况

提交号均为本分支内哈希；"回归"列是可直接运行的测试文件。

### 3.1 批次一 · P0 缺陷（报告 §二）

| 工单 | 提交 | 改动要点 | 回归 |
|---|---|---|---|
| H01 | `d76a9ba` | 删除历史同步清理 `history/documents/<id>/`；`orphanFiles`/`stats` 计入文档树；`recoverIndex()` 从死代码接入启动；迁移重写完整 `HISTORY_ENTRY_PATH_KEYS`（`data-root.js` 单一来源） | `test/h01-history-document-cleanup.test.js` |
| H02 | `c394bba` | 马赛克补丁账本改为有界 LRU（稳定 identity、覆盖精确扣减、涂抹期 draft id、提交 rename、超预算逐出） | `test/h02-mosaic-cache.test.js`（13） |
| H03 | `7257faf` | Markdown 解析迁到 `shared/simple-markdown.js`，围栏内原样输出/未闭合补齐/表格/h4–h6；流式改为稳定块一次渲染 + 尾部更新 | `test/h03-markdown.test.js`（13） |
| H04 | `d58ebfc` | 子进程 stdout 用 StringDecoder 增量解码；Everything 回执按 `COPYDATASTRUCT.dwData` 匹配（**报告 `LIST2.dwId` 偏移不存在**） | `test/h04-utf8-decode.test.js`、`test/h04-everything-dwid.test.js` |
| H05 | `7125f22`、`f181ba8`、`cdb6902` | 托盘→`main/domains/tray`、IPC 注册→`main/ipc/index.js`；`main.js` 1330→1204 行、最长行 376→158；门禁加 `.handle(` 与 160 字符行限；修复退出时 `tray` 悬空引用 | `test/h05-architecture-extraction.test.js`、`test/architecture-gate.test.js` |

### 3.2 批次二 · 性能（报告 §三）

| 工单 | 提交 | 改动要点 | 回归 |
|---|---|---|---|
| F01 | `21c4e81` | 设置快照缓存 + 凭据单次解密（一次公开读 11 次 store/9 次 DPAPI → 4/3）；app-logger 每行 1 次 fs；`list()` 只探测当前页 | `test/f01-storage-performance.test.js` |
| F02 | `90f4e54` | 工具条不可见时按键/滚轮不再跨进程转发；`hideToolbar()` 幂等；原生 `ObserveInput` 计数不变 | `test/f02-selection-ipc-storm.test.js` |
| F03 | `32d4f56` | 录制持有一个 FileHandle；波纹 30 点击 68 节点→2 节点（`framemd5` 90 帧一致）；硬件编码 listing+smoke 双门控并回退 | `test/f03-recording-performance.test.js` |
| F04 | `f012f6c` | Everything 目标 HWND 缓存、空闲只停 sidecar、`QueryFullProcessImageNameW` 替代 PowerShell WMI | `test/f04-everything-performance.test.js` |
| F05 | `8d747e9` | 剪贴板内存计数、解码移出全局 Barrier、`verify_formats` 快路径、缩略图定向淘汰 | `test/f05-clipboard-performance.test.js` |
| F06 + U02 | `4f7554c`、`241c981` | 空白探测短路（阈值按实测取 256 KiB）、matcher 由粗到精（4K 121ms→9.6ms）、贴图 LRU、长图单次 sharp 流水线；长图预览条带缩略图、固定悬浮栏剥离、贴图 move-end 合并一次 setBounds | `test/f06-capture-performance.test.js`、`test/u02-longpin-ux.test.js` |
| F07 | `27d3f4c`、`61fbb0c`、`4d8fa7b` | 会话目录内存索引；usage 不持久化 hourly、模型去重、状态 30 s 缓存；AI 连接路由缓存、索引化 OCR 翻译、代理 keep-alive、OCR CatmullRom/Level3、迁移哈希复用 | `test/f07-conversation-store-index.test.js`、`test/f07-usage-costs.test.js`、`test/f07-ai-ocr-migration.test.js` |

### 3.3 批次三 · 功能与体验（报告 §四）

| 工单 | 提交 | 改动要点 | 回归 |
|---|---|---|---|
| U01 | `715d3c8` | 多选整组拖拽（union bounds + 单帧撤销）；内联文字编辑器（IME 安全、多行）；CJK 1.0em / ASCII 0.6em 包围盒；PDF 结果条接线 | `test/u01-capture-ux.test.js`（21） |
| U02 | `241c981` | 见上表 F06 行；贴图矢量重标注与导出离屏合成**未做**（§7） | `test/u02-longpin-ux.test.js`（14） |
| U03 | `186cd39` | window 模式重录、历史项目帧率回退、首帧真实尺寸画布、软限幅混音、Direct-Track 禁用标注 | `test/u03-record-ux.test.js` |
| U04 | `6acf903`、`b1be7f6` | 表格列投影聚类 + merges、搜索路径化图标/isFolder/合并排序；终端保护下发原生层、按窗口流控制（解除全局锁）、600 ms 粘贴窗口 + 复用 Ctrl | `test/u04-table-search.test.js`、`test/u04-selection-lock.test.js` |
| U05 | `53a7b8e` | 水印设置表单；`ROUTE_DRAFT_REASONS` 补齐；历史搜索定时器/录制预检清理；语言互换；主窗口显示解除空闲回收 | `test/u05-config-lifecycle.test.js` |

### 3.4 批次四 · 创新功能（报告 §五）

| 工单 | 提交 | 改动要点 | 回归 |
|---|---|---|---|
| N01 | `1ebe2de` | 11 类敏感信息规则（Luhn/ISO 7064/RFC1918）+ OCR 文本块→可编辑模糊标注，单步撤销，纯本地 | `test/n01-auto-redact.test.js`（28） |
| N02 | `c41ab66`、`68381a4`、`5099151`、`3868ccf` | 历史后台 OCR 索引 + 标签 + 标签筛选 + OCR 状态徽标/补索引；剪贴板图片 OCR / 转 Excel / 固定贴图 | `test/n02-history-ocr.test.js`、`test/n02-history-ocr-ux.test.js`、`test/n02-clipboard-image.test.js` |
| N03 | `c6ab5cd` | 快捷键胶囊（策略纯函数、忽略普通打字/IME/输入框）与一键静音裁剪（ffmpeg silencedetect + 鼠标静止合流） | `test/n03-recording-hud.test.js`（18） |
| N04 | `0823f56` | 搜索空格 Quick Look（图片/文本/代码/JSON/Markdown，主进程读取与转义）+ 原生文件拖拽 | `test/n04-search-quicklook.test.js`（21） |
| N05 | `cdbe945`、`5c660d0` | 洋葱皮 difference/1 Hz 闪烁 + 工作区快照（10 组、原子写、替换式恢复、挂起/恢复） | `test/n05-pin-onion-snapshot.test.js`（28） |
| N06 | `df9024d` | Ctrl+K 设置搜索（122 条目覆盖 15 路由）+ 单文件 `.hlbackup.zip`（可选 scrypt+AES-256-GCM） | `test/n06-config-search-backup.test.js`（20） |

### 3.5 发布与收尾提交

| 提交 | 内容 |
|---|---|
| `ce0781a`、`062ef4c`、`5c76d38`、`d8e49ff`、`7e83e11`、`22d495a`、`8c48e96` | 计划与证据登记、批次状态、最终验证记录 |
| `d4bc36b` | 修正 `8416120` 把 npm PowerShell 步骤改为 pwsh 7 后遗留的 packaging 断言（master 上原本红） |
| `b0546a4`、`9585fa3` 及若干 `test:` 提交 | H05 注册迁移/U03/U05 行为变更引起的契约测试跟随 |
| `3868ccf` | 5.1.1 真机反馈：历史搜索 IME 安全、OCR 状态与补索引、标签下拉 |
| `8ca1a60` | 本地搜索窗口双重四角修复 |
| `9a501aa`、`dc4dda4` | 发布 5.1.0 / 5.1.1（版本号、CHANGELOG、README） |

---

## 4. 新增模块与职责

为满足 `main.js` 硬行数门禁、可测试性（UMD/纯函数）或契约解耦而拆出的模块：

| 文件 | 职责 | 备注 |
|---|---|---|
| `main/domains/tray/index.js` | 托盘单例、图标切换、菜单模板 | H05；`refresh()` 由 `main.js` 的 `createTrayIcon()` 一行委托 |
| `main/ipc/index.js` | 全部 IPC 注册聚合（`registerAllIpc`） | H05；惰性 resolver，避免构造顺序问题 |
| `main/services/everything-service-getter.js` | Everything 懒单例 getter | N02 集成时为 `main.js` 腾行 |
| `main/services/history-ocr-indexer.js` | 历史 OCR 后台串行队列（去重/上限/重试/丢弃） | N02 |
| `main/services/encrypted-backup.js` | 单文件归档 + scrypt/AES-256-GCM | N06 |
| `config/routes/settings-search.js` | 设置搜索索引 + 纯匹配函数 + 键盘接线 | N06 |
| `shared/sensitive-patterns.js` | 脱敏规则库与坐标映射（UMD 纯函数） | N01 |
| `shared/simple-markdown.js` | 收起 `action.js` 的 Markdown 解析与流式切块 | H03 |
| `capture/mosaic-patch-cache.js` | 马赛克补丁 LRU 账本（UMD） | H02 |
| `capture/annotation-inline-editor.js` | 内联文字编辑器（UMD） | U01 |

渲染层的新脚本都以 classic script 引入（`capture.html`/`action.html`），同时保留 `module.exports` 供 node 测试直接 require——新增同类模块请沿用这一 UMD 约定。

---

## 5. 设计约束与交接必读

### 5.1 `main.js` 行数/行宽门禁（最容易踩）

- `scripts/check-architecture.js`：`MAIN_LINE_CEILING = 1205`、`MAX_MAIN_LINE_LENGTH = 160`、`FORBIDDEN_IN_MAIN` 同时匹配 `.on(` 与 `.handle(`，并覆盖已聚合的通道前缀。
- 当前 `main.js` **1204 行 / 最长 158 字符**：只剩 1 行余量。**任何新增接线都必须先把一段逻辑抽成模块**（现成先例：`main/services/everything-service-getter.js`、`main/ipc/index.js`），或把工厂行为放进模块内部（先例：`createCaptureDocumentService` 里做 attach + `recoverIndex()`）。
- 行宽限制同样会咬人：长对象字面量要提前换行，而不是压到一行。
- 上限只允许下调，不允许上调；`test/architecture-gate.test.js` 会校验门禁输出与导出的常量。

### 5.2 IPC 冻结面与三种合法扩展方式

`main/services/ipc-security.js` 的 `IPC_SURFACES` 是通道白名单，`secureIpcMain.assertComplete()` 会在启动时校验；`test/ipc-module-contracts.test.js` 还用 `deepEqual` 钉死每个 registrar 的通道清单。因此**新增通道必须三处同改**（surface 表 + registrar + 对应 deepEqual 测试），且会波及 `test/ipc-security.test.js`。

本批次在不能改冻结面时采用的三种合法扩展（后续遇到同类约束可复用）：

1. **命令信封**：复用 `history:list` 的 `{ op: 'update-tags' | 'list-tags', ... }`（N02）——无 `op` 的旧载荷行为逐字节不变。
2. **动作标签**：复用 `search:file-icon`，用 `payload.action = 'preview' | 'drag'` 区分（N04）。
3. **既有通道第二参数白名单**：复用 `pin:context-menu` 传递工作区命令（N05）。

选择前先确认目标 registrar 是否已有可承载的通道；若确实需要专用通道，改动面是 `ipc-security.js` + registrar + 三处测试，不要只改 registrar。

### 5.3 i18n 预算

- `npm run check:i18n`（`--max 606`）统计**扫描区内的未迁移中文行**，当前 **602**，余量仅 4 行。
- 新增 UI 文案必须进 `shared/locales/*.js`（三语同文件，`<domain>.<module>.<semantic>` 键形）；**注释也不要写中文**——`§二`、`§三` 中的汉字同样计入预算（本批次踩过，已全部改 ASCII）。
- `capture.*`、`record.*` 等 key 集被部分契约测试按 GOLDEN 表钉死：新增键可以，改名/删除要先看 `test/capture-i18n.test.js`、`test/i18n.test.js`。

### 5.4 原生构建与 build-id

| 组件 | 源码 | 产物 | 提交策略 |
|---|---|---|---|
| selection-hook（C++） | `vendor/selection-hook/**` | `vendor/selection-hook/build/**`（gitignore） | 改源码必须 `node node_modules/node-gyp/bin/node-gyp.js rebuild --directory vendor/selection-hook`；`test/selection-native-build.test.js` 校验 build-id |
| clipboard sidecar（Rust） | `native/clipboard/src/**` | `native/clipboard/bin/HighlighterClipboard.exe`（gitignore） | `node scripts/build-clipboard-native.js`；`clipboard-coordination` 等用例会校验 build-id，未重建会出现整批失败 |
| everything sidecar（Rust） | `native/everything-search/src/**` | `native/everything-search/bin/HighlighterEverything.exe`（**已入库**） | `pwsh -NoProfile -File native/everything-search/build.ps1` 后**连同 exe 一起提交** |
| OCR sidecar（Rust） | `native/ocr/src/**` | `native/ocr/HighlighterOcrSidecar.exe`（gitignore） | `npm run build:ocr`；本机冒烟用真实模型 |

`npm run build:native` 会串起全部四个（外加 SmartSelect、电量助手、快门音、焦点窗口）。CI/打包必须重建，否则 build-id 门禁会红。

### 5.5 报告不是圣经：开发中修正的结论

接手后若继续按报告改代码，先看这几条已被实测推翻/修正的点：

1. **H04**：`EVERYTHING_IPC_LIST2.dwId` 在偏移 8..12 **不存在**（8 是 `offset`）。正确关联是 QUERY2 的 `reply_copydata_message`，Everything 回显在 `COPYDATASTRUCT.dwData`。
2. **F06**："空白 4K PNG 压缩后 <15 KB" 不成立（实测纯黑 ~166 KiB、纯白 ~37 KiB）。按 32 KiB 短路会漏判空白帧，最终阈值 256 KiB 并补了"4K 纯黑仍探测"用例。
3. **F03**：只查 `-encoders` 会把"编译进去但运行期加载失败"的编码器当可用（本机 NVENC/AMF 即如此）；实现是 listing + 1 帧 smoke 双门控，失败自动回退 `libx264`。
4. **N06**：报告承诺"API Key 迁移"，但既有备份契约（`data-root-backup.js` 模块头）明确不复制凭据；加密只保护所选模块，换机后 API Key 仍需重配。
5. **U02/F07/U04** 多条行号已随 H05 抽离漂移；`EWMA`/阈值类结论以当前代码与实测为准。

### 5.6 真实 Electron 探针：两类新教训

本机跑探针按 AGENTS.md 处理（`ELECTRON_RUN_AS_NODE`、`TMP/TEMP` 指到仓内 `.tmp*`、`--no-sandbox` 注入）。本批次新增两条经验：

- `test/diagnostics-runtime.test.js` 的探针 `require('../main')`，**会走完整启动 + 退出路径**：任何 `before-quit` 里的异常都会让 `app.quit()` 永不完成，表现为 40 s 超时。H05 的 `tray` 悬空引用就是这样被抓住的（`cdb6902`）。改动退出路径后**务必单独跑这个探针**。
- `test/window-security-runtime.test.js` 按"每个渲染层的启动标记全局名"启动窗口（`scripts/probe-window-security.js` 的 `marker` 列表）。把渲染层代码包进 IIFE/`startXxx()` 时，被检查的全局函数必须仍然可达（N05 的 `applyPinData` 就是这样修的，`5c660d0`）。

### 5.7 已知 flake（不要误判为回归）

| 测试 | 现象 | 判断方法 |
|---|---|---|
| `test/usage-query.test.js` → “query p95 … 100 ms budget” | 全量并发下 p95 110–180 ms；单独跑 ~67 ms 通过 | `npx node --test test/usage-query.test.js` 单独复跑 |
| `test/clipboard-coordination.test.js` → lease 100 轮 | 满负载下偶发 `Lease round N` 断言失败 | 单独连跑两次，均过即 flake |
| `test/capture-first-paint.test.js` | 满负载下 first paint 超预算（如 618 ms），单跑 ~1.5 s 通过 | 单独复跑 |
| `nativeBuildId` 整批失败 | clipboard/selection 相关用例集体红 | 源码改过但没重建二进制，跑 §5.4 的构建命令 |

---

## 6. 未验证的真机 / 发布门槛

以下项目**没有**在本批次验证，证据表"真机/发布门槛"列有逐条登记。按可执行性分组：

### 6.1 需要真实桌面会话（GUI/托盘/输入法）

- 托盘：H05（菜单/记录/代理状态实际点击）、托盘"定位/恢复"与贴图布局联动。
- 截图：U01（多选拖拽手感、中文输入法内联编辑、微软雅黑 CJK 包围盒、PDF 结果条）、H02（连续拖拽/缩放 30 帧后缓存命中与像素一致）、N01（真实 OCR 模型下的脱敏命中/漏报、手动删除单框）。
- 贴图：U02（100%/150% 双屏松手不跳动、5 万 px 长图预览与悬浮栏剥离）、N05（多显示器快照恢复/挂起、difference/闪烁可视比对）。
- 录屏：U03（window 模式重录、高分屏 4K 窗口、双路混音爆音、Direct-Track 标注入口）、F03（1080p30 连录 30 分钟、真实音轨 framemd5）、N03（快捷键胶囊需控制条焦点、真实音轨静音裁剪）。
- 划词：F02（日常打字/滚轮无 IPC 唤醒）、U04（终端内 Ctrl+C 注入防护、双窗口并发长考、600 ms 粘贴时序）。
- 历史/OCR：N02（真实 OCR 模型的 pending→done/empty/failed 与补索引；中文输入法实际组字与候选翻页）。
- 剪贴板：N02（图片 OCR/Excel/贴图真实链路）、F05（4K PNG 屏障持锁与租约）。
- 搜索：N04（拖到微信/钉钉/VS Code/浏览器；可见窗口 blur 清预览）。
- 设置：N06（Ctrl+K 搜索跳转、单文件加密备份/恢复往返，含错误密码与篡改）。

### 6.2 需要安装包 / 隔离环境

- `verify:package`（完整 electron-builder 产物 + 静默安装）与 `verify:release`（签名）。
- H05/H01 的"打包候选上托盘行为""磁盘占用下降"。
- 隔离 NSIS 的更新域名请求（D01 类，非本批次）。
- 多显示器/DPI 组合、便携版与登录项。

### 6.3 需要真实硬件

- F03 硬件编码：NVENC/QSV/AMF 的真实可用性与质量（本机 smoke 通过 HVENC/QSV，不代表真机可用）。
- F05/F06 的慢盘、SSD、超大图内存曲线；N05 的桌面像素差分若要做需屏采通道。

---

## 7. 明确未做 / 降级项（含落点与建议）

| 项 | 原因 | 落点 | 建议 |
|---|---|---|---|
| U02 贴图非破坏性矢量重标注 | `capture` 侧 pin meta 只带拍平 PNG，没有 `baseImageBuffer`/`annotations`，pin 侧无法只改自己 | `capture/capture.js` 的 pin meta + `main/domains/pin/index.js` 的 `_pinData` + `startPinReannotation` 载荷 | 需要 capture 与 pin 两个 owner 协同；契约：pin meta 增 `baseImageBuffer` 与 `annotations` 快照（随窗口关闭释放） |
| U02 `exportPinView` 离屏合成 | 需 `preload-pin.js`/`pin.html`/`pin.css` 配合，改动面超出单工单 | `pin` 渲染层 + 主进程导出 | 在渲染层离屏 Canvas 合成图片与 OCR 叠层，避免隐藏样式 + `capturePage` 的边框闪烁 |
| F06 截图窗口预热 / SmartSelect 常驻 | 需真机验证窗口生命周期与内存；风险高 | `main/domains/capture/index.js` | 单独排期，先做"隐藏窗口 + 内存基线"测量再改 |
| F07 OCR stdin 二进制帧 | 协议两端同改，且两条既有测试锁定"临时 PNG 落盘+删除"与"每行 JSON"协议 | `main/services/ocr-service.js` + `native/ocr/src/main.rs` | 先改测试契约再改协议；或新增能力探测字段做双协议兼容 |
| F04 `status`/`wait-ready` 仍全量 resolve | 本工单只缓存 `query` | `native/everything-search/src/main.rs` | 复用同一 `cached_target` 即可，收益较小 |
| N03 导出合成为播放覆盖层 | 时间轴/导出合成链路复杂 | `record/editor.js` 导出路径 | 先做编辑器播放（已可用），导出合成另行排期 |
| N03 全局键盘钩子 | 录制控制窗需焦点才能采集快捷键，切到演示 App 后 HUD 为空 | `pointer-hook-host.js`（vendor 已有 WH_KEYBOARD_LL） | 建议扩展既有 pointer hook 的键盘通道；注意"忽略普通打字"的隐私策略必须保留 |
| N05 桌面像素差分 | 需屏采通道（且要避免截到贴图自身） | `pin` + 屏采 | difference 模式受透明窗口 backdrop 限制，闪烁模式可用；真实像素差分为独立任务 |
| N06 API Key 迁移 | 与既有备份"不复制凭据"契约冲突 | `main/services/data-root-backup.js` + `encrypted-backup.js` | 需要产品/安全决策后改备份内容策略，不能只改加密层 |
| U04 内嵌终端（VS Code/Cursor）保护 | 编辑器与终端同进程，保护会牺牲整个编辑器回退 | `vendor/selection-hook/src/windows/core/engine.cc` | 可考虑"仅当目标窗口标题/子控件表明终端"的启发式，风险自负 |

---

## 8. 接手第一小时 checklist

```bash
# 0. 工作区与分支
git status                      # 应为干净
git log --oneline -5            # HEAD 应为 dc4dda4（或之后）
git rev-list --left-right --count origin/master...HEAD   # 45 0（已推送）

# 1. 环境（本机实测基线：Node v24.15.0、Electron 43.8.3、pwsh 7、cargo 1.97.1、VS2026）
node -v && cargo --version
npm ci                          # 或 npm install

# 2. 构建全部原生件（首次或改过 native/vendor 后必做）
npm run build:native

# 3. 门禁（~10 s，全绿是基线）
npm run check                   # 语法/架构/i18n/评审证据

# 4. 全量测试（~2 min；注意 AGENTS.md 的四个环境陷阱）
env -u ELECTRON_RUN_AS_NODE \
  TMP=D:/workspace/Highlighter/.tmp-test TEMP=D:/workspace/Highlighter/.tmp-test \
  HIGHLIGHTER_E2E_DATA_ROOT_BASE=D:/workspace/Highlighter/.tmp-test \
  npm test
# 预期 3237 项 / 3236 通过；唯一失败为 usage-query p95（见 §5.7）

# 5. 真实 Electron 探针（确认启动/退出与窗口安全未被破坏）
npx node --test test/diagnostics-runtime.test.js test/electron-runtime.test.js test/window-security-runtime.test.js

# 6. 原始证据与约束
#    读：docs/plans/2026-11-26-review-optimization-development-plan.md
#        docs/evidence/2026-11-26-review-optimization-evidence.md
#        docs/plans/2026-11-27-history-ocr-ux-fixes.md
#        AGENTS.md（环境陷阱、已知 flake、CI 判定纪律）
```

发布候选验证时优先按 §6.1 的顺序做（先托盘/截图/贴图这类高频路径，再录屏/划词/搜索），并把结果补进证据表的"真机门槛"列；新增 P0 时同一次提交必须补实现 + 回归 + 证据表一行。

---

## 9. 后续建议优先级

1. **发布候选真机回归**（§6.1、§6.2）：这是当前唯一没有证据链的部分，也是 5.1.x 能否进入正式发布的门槛。
2. **U02 矢量重标注**：用户可感知（"重新标注"现在只能基于拍平像素），需要 capture/pin 协同，建议作为一个独立小批次。
3. **F06 截图窗口预热**：性能收益明确但风险高，需先有内存与生命周期测量。
4. **N03 全局键盘钩子 + 导出合成**：把快捷键胶囊从"控制条焦点下可用"变成完整功能。
5. **技术债**：`main.js` 只剩 1 行余量（下一次接线必须先抽模块）；`usage-query` 的 p95 断言需要低负载隔离（否则每次全量跑都会红）；i18n 只剩 4 行余量（新增中文注释会直接顶红）。

---

## 附录：本分支提交一览（`git log --oneline origin/master..HEAD`）

```
dc4dda4 chore(release): bump version to 5.1.1 [skip ci]
3868ccf fix(history): make OCR search IME-safe and expose OCR/tag state [skip ci]
9a501aa chore(release): bump version to 5.1.0
8ca1a60 fix(ui): stop the search window drawing a second set of corners
8c48e96 docs(evidence): record the final verification run and the two integration regressions it caught
cdb6902 fix(main): destroy the tray through its controller on quit (H05 follow-up)
5c660d0 fix(pin): keep applyPinData reachable as the window boot marker (N05 follow-up)
22d495a docs(plan): mark all four batches complete with their commits and evidence
5099151 feat(clipboard): image OCR, table export and pin-from-clipboard actions (N02 part 2)
68381a4 refactor(main): lift the lazy Everything getter into a module and wire the clipboard resolvers (N02 integration)
cdbe945 feat(pin): add the onion-skin pixel-diff modes and pin workspace snapshots (N05)
1ebe2de feat(capture): add one-click local auto-redaction for sensitive text (N01)
0823f56 feat(search): add Space quick look and native file dragging to the local search window (N04)
c41ab66 feat(history): index captured screenshots with background OCR and add searchable tags (N02 part 1)
7e83e11 docs(evidence): register the U batch and the completed N tickets
c6ab5cd feat(record): add a keystroke capsule HUD and one-click pause trimming (N03)
df9024d feat(config): add Ctrl+K settings search and a single-file encrypted backup archive (N06)
b1be7f6 fix(selection): keep terminals out of the clipboard fallback, scope streams per window and widen the paste modifier window (U04 part 2)
715d3c8 fix(capture): drag a whole selection, edit text inline with CJK-correct boxes, show the PDF result bar (U01)
241c981 fix(long-capture,pin): rebuild the preview from per-strip thumbnails, cut sticky bands and merge the pin move-end bounds (U02)
4d8fa7b perf(ai,ocr): cache the working connection route, index OCR translations, harden proxy reuse and OCR acceleration (F07 part 3)
6acf903 fix(ocr,search): cluster table columns by projection and keep per-path icons, folder marks and merged sort (U04 part 1)
9585fa3 test: follow the H05 move for the AI/updater facades and the tray menu build
d8e49ff docs(evidence): register the completed F batch and U03
b0546a4 test: follow the H05 registration move and the U03/U05 behaviour changes
186cd39 fix(record): restore window re-recording, keep the frame rate across restarts and stop the mix clipping (U03)
4f7554c perf(capture): skip impossible blank probes, cache pin residency by LRU and render long captures in one sharp pass (F06)
8d747e9 perf(clipboard): keep SQLite counters in memory and decode outside the global barrier (F05)
f012f6c perf(search): cache the Everything target window and keep the managed index process alive (F04)
32d4f56 perf(record): hold one file handle per recording, merge ripple layers and prefer a probed hardware encoder (F03)
21c4e81 perf(storage): cache the settings snapshot, decrypt each credential once and stop per-line fs calls (F01)
5c76d38 docs(plan): record the completed H batch and the F/U progress
90f4e54 perf(selection): gate key/wheel IPC on toolbar visibility and make hideToolbar idempotent (F02)
61fbb0c perf(usage): stop persisting the rebuilt hourly state, dedupe models, cache the status probes (F07 part 2)
53a7b8e fix(config): close the settings-window lifecycle leaks and expose the watermark form (U05)
27d3f4c perf(selection): answer hasConversation from a conversation index, not a directory parse (F07 part 1)
c394bba fix(capture): account mosaic patch bytes in a bounded LRU ledger (H02)
062ef4c docs(evidence): enforce and register the 2026-11-26 review tickets (H batch)
d58ebfc fix(native): decode subprocess pipes incrementally and match Everything replies by query id (H04)
7257faf fix(action): make the answer Markdown renderer fence-aware and stream in stable blocks (H03)
f181ba8 test(selection): follow the settings-channel registration into main/ipc (H05)
7125f22 refactor(main): lift tray and IPC registration out of main.js, tighten the architecture gate (H05)
d76a9ba fix(history): reclaim editable document trees when a history entry is deleted (H01)
d4bc36b fix(test): pin the battery build step to pwsh 7
ce0781a docs(plan): add 2026-11-26 review optimization plan and evidence registry
```
