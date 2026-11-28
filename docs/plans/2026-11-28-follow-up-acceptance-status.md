# 5.1.1 后续验收台账（计划 §2 / §3 / §5 对照）

2026-11-28 · 依据 [后续开发与缺陷验收任务](2026-11-28-review-optimization-follow-up-tasks.md) §2/§3/§5/§7、
[交接记录](2026-11-28-review-optimization-handoff.md) §6、[证据登记表](../evidence/2026-11-26-review-optimization-evidence.md)、
[历史 OCR 修复方案](2026-11-27-history-ocr-ux-fixes.md)。

**本台账只回答两件事：** ①每张 V/R 工单当前有哪些自动化证据能在开发者主机上复跑、覆盖到哪一层；
②真正关闭它还需要哪台设备、哪个人工步骤或哪个发布产物。**本台账不把任何 V/R 项登记为“真机通过”**；
所有真机结论必须回到发布候选上执行后另记。本机在本轮只执行了备份契约定向测试与评审证据门禁（见 §6）。

## 0. 状态词（严格按此使用）

| 状态 | 含义 | 不表示 |
|---|---|---|
| `automated-covered` | 仓库内存在可在开发者主机复跑的自动化用例，且**真实包含**该场景/行为的断言（单元/源码接线/探针/e2e，逐条注明层级） | 不表示真机已验证，不表示安装包已验证 |
| `needs-real-device` | 计划要求的观察项（托盘交互、真实 IME/OCR 模型、双屏 DPI、安装包、真实拖放、真实音轨）只能在真机上完成；自动化只能作为旁证 | 不表示自动化没做，也不表示已通过 |
| `blocked-missing-hardware` | 当前无该硬件/设备（GPU 编码器、慢盘、混合 DPI 多屏、RDP、双音轨），连真机步骤都无法在本机执行 | 不表示功能不可用，只表示证据无法采集 |
| `not-run` | 发布/签名/安装类工单尚未执行（计划 §5 R01–R03） | 不表示通过或失败 |

自动化证据的层级缩写：**单元**＝纯 Node 行为/契约测试；**接线**＝对渲染层/主进程源码做存在性与顺序断言；
**探针**＝真实 Electron 子进程探针；**e2e**＝Playwright 真实 Electron 窗口。按 AGENTS.md，探针与 e2e
在受限宿主需先处理 `ELECTRON_RUN_AS_NODE`、`TMP/TEMP`、`--no-sandbox`/`HIGHLIGHTER_E2E_NO_SANDBOX` 等环境陷阱。

## 1. §2 候选真机验收工单（V01–V10）

真机执行约定（计划原文）：隔离测试账户 + 可重建数据副本；从已安装候选或指定便携包进入；可见测试窗口
默认副屏（只有主屏时先询问）；每行记录包哈希、Windows 版本、DPI/显示布局、样本、步骤、预期/实际、附件与执行人。
性能项固定机器/电源模式/候选/采样点/数据规模，区分冷热与负载，记录 p50/p95/峰值/回落。

| 单号 | 计划真机步骤与环境（摘要） | 现可跑的自动化证据（精确文件；覆盖层） | 状态 | 关闭条件 / 仍需什么 |
|---|---|---|---|---|
| V01 托盘、启动与退出 · H05、N05 | 候选启动→托盘切换记录/代理状态；建两张贴图做定位/恢复/挂起；重启 Explorer、睡眠/唤醒后再从托盘退出；截图菜单与实际生效状态；恢复后一个有效图标、贴图定位正确、退出无孤立侧车 | `test/h05-architecture-extraction.test.js`（托盘创建/菜单/提示/游戏模式/双击路由/关闭时 destroy，单元）；`test/tray-only-launch.test.js`（登录项标记与托盘启动接线，接线）；`test/diagnostics-runtime.test.js`（真实主进程完整启动并以 `exitType: quit` 干净退出，探针——before-quit 抛错会以 40 s 超时暴露；**该探针以 `enableTray:false` 启动，覆盖 before-quit 退出路径但不创建真实托盘**）；`test/electron-runtime.test.js`、`test/window-security-runtime.test.js`（原生件加载与所有渲染层启动标记，探针） | `needs-real-device` | 在签名/便携候选上按计划做托盘点击、Explorer 重启、睡眠/唤醒、带贴图退出，并截菜单与实际生效状态；附退出码/耗时/侧车残留。自动化只证明控制器与退出路径未坏 |
| V02 历史文档与存储 · H01、F01、F07 | 单删/清空/从副本迁移再重编辑；真实加密配置连续两次取设置再改一项重复读取；日志轮转、翻历史页、20 条会话重建托盘；同一 24 个月 usage 副本比较 DB 体积与同范围查询 | `test/h01-history-document-cleanup.test.js`（单删/批量/清空/保留期裁剪/孤儿树/统计/`recoverIndex` 启动恢复/迁移重写，单元）；`test/f01-storage-performance.test.js`（二次 getSettings 不读 store、每凭据只解密一次、日志一行一次 append、分页只探测本页，单元）；`test/f07-conversation-store-index.test.js`、`test/f07-usage-costs.test.js`（会话索引、usage 不持久化 hourly、状态缓存，单元）；`test/history-service.test.js`（占用统计/缺失记录/清理，单元）；`test/data-root-backup.test.js`（迁移重写 `HISTORY_ENTRY_PATH_KEYS`，单元） | `needs-real-device` | 真实 DPAPI 配置下实测二读 0 次 store/解密、真实日志轮转、20 条会话托盘重建延迟、24 个月 usage.db 体积/查询对比；附目录清单、计数、DB/WAL 大小与迁移后底图/矢量可编辑证据 |
| V03 截图编辑与脱敏 · H02、U01、N01 | 同一图连续拖动/微调/缩放马赛克 ≥30 帧；拖动标注组并撤销；微软雅黑 + 真实 IME 多行中英文；导出 PDF 并点结果条；真实本地 OCR 模型输入敏感/普通文本图，删一个框再撤销 | `test/h02-mosaic-cache.test.js`（稳定 identity、覆盖精确扣减、提交 rename、LRU 逐出、每次编辑仍只占一条账本，单元）；`test/u01-capture-ux.test.js`（CJK 包围盒、多行行高、组移动一次撤销、内联编辑器 Enter/Esc 契约、PDF 结果条收据，单元+vm）；`test/n01-auto-redact.test.js`（11 类规则/Luhn/ISO 7064/框映射、一次撤销、删除单框、OCR 遮盖通道，单元+DOM 行为）；`test/pdf-export.test.js`（A4/1:1 打印与真实 Electron 打印用例，单元+探针） | `needs-real-device` | 真实 IME（微软拼音/搜狗）组字与多行编辑、微软雅黑实际字形命中框、连续 30 帧真实拖拽后的缓存命中与离屏 Canvas 分配、真实 OCR 模型逐类命中/误报/漏报与坐标偏移、导出 PDF 与基准逐像素一致 |
| V04 长图、贴图与工作区 · F06、U02、N05 | 固定悬浮栏/重复纹理/普通滚动语料含 5 万 px 长图；贴图在 100%/150% 双屏间拖动松手、旋转缩放、保存工作区/挂起/重启恢复；difference 与 1 Hz 闪烁目视 | `test/f06-capture-performance.test.js`（空白探测 256 KiB 边界与 4K 纯黑/纯白、matcher 由粗到精与穷举一致、贴图 LRU 逐出，单元）；`test/u02-longpin-ux.test.js`（预览条带/裁切映射/悬浮栏剥离/横向拼接、跨 DPI move-end 一次 setBounds，单元）；`test/n05-pin-onion-snapshot.test.js`（快照保存/恢复/缺失图跳过/挂起恢复/10 组上限/托盘定位，单元+接线）；`test/pin-domain.test.js`、`test/capture-pin-copy.test.js`（贴图窗口与双输出契约，单元） | `needs-real-device` | 真实 5 万 px 拼图无重栏/断行与 matcher 位移记录；真实 100%/150% 双屏松手锚点对齐；重启后工作区位置/缩放/层次；difference 与闪烁的实际屏幕效果（桌面像素差分是 DEV-08，需另立） |
| V05 划词、粘贴与流式 · H03、F02、U04 | 工具条隐藏时连续打字/滚轮再划词；独立终端跑前台任务并选字；两个结果窗并行长回答、流式中复制/搜索/选字；不同松 Ctrl 时机做剪贴板面板粘贴 | `test/f02-selection-ipc-storm.test.js`（隐藏时输入事件不转发、仍持续观察、原生 `ObserveInput` 计数，单元+原生契约）；`test/h03-markdown.test.js`（围栏/表格/未闭合补齐、稳定块流式提交，单元）；`test/u04-selection-lock.test.js`（终端/自身保护先于合成 Ctrl+C、600 ms 窗口复用 Ctrl、双窗口独立流式与按窗取消，单元）；`test/clipboard-paste.test.js`（隐藏面板会话、提交前取消、并发请求互斥，单元）；`test/pointer-track-service.test.js`（指针轨采集与上限，单元） | `needs-real-device` | 真实隐藏工具条下主进程 IPC 唤醒计数为 0 且划词仍可唤起；真实终端前台任务不被中断（自动 Ctrl+C 注入计数 0）；双结果窗并发与流式 Markdown 选区稳定；600 ms 粘贴手感与目标应用实际收到内容；内嵌终端（VS Code/Cursor）按 DEV-10 单列 |
| V06 历史 OCR 与剪贴板 · N02、F05、U04 | 按 §3 复验三项交互；复制含中文/稀疏表格/合并单元格/无文字图片，分别识别、转 Excel、固定贴图；连续复制粘贴 4K PNG 并穿插另一条复制 | `test/n02-history-ocr.test.js`（后台索引、队列去重/上限/串行、重试一次、删除丢弃结果、标签命令，单元）；`test/n02-history-ocr-ux.test.js`（IME/状态机/标签下拉，单元）；`test/n02-clipboard-image.test.js`（主进程 OCR/表格→SpreadsheetML/贴图/取消/互斥，单元）；`test/u04-table-search.test.js`（列投影聚类/合并单元格/结果合并排序/isFolder，单元）；`test/f05-clipboard-performance.test.js`（缩略图缓存定向淘汰，单元）；`test/clipboard-coordination.test.js`（原生租约 100 轮/过期/进程退出，原生集成）；`native/clipboard` cargo 测试（Barrier 与 decode 语义） | `needs-real-device` | 真实 OCR 模型下 pending→done/empty/failed 与「识别未索引项」进度、真实中文/表格/合并单元格/无文字图片的识别与 Excel 列、真实 4K PNG 连续复制粘贴的屏障持锁/租约超时/解码时长与目标应用收到的图；失败提示对应源记录 |
| V07 本地搜索与拖出 · H04、F04、U04、N04 | Everything 1.4/1.5 搜中文路径 600 条结果；一次迟到回执 + 紧随新查询；逐字输入、空闲 120 s 后再搜；目录标记/图标/混合排序；空格预览后切焦点；分别拖到微信/钉钉/VS Code/浏览器本地接收区 | `test/h04-utf8-decode.test.js`（增量 UTF-8 解码，单元）；`test/h04-everything-dwid.test.js`（`COPYDATASTRUCT.dwData` 回执 id、迟到回执按 id 丢弃、超时不误配，单元+Rust 断言）；`test/f04-everything-performance.test.js`（目标 HWND 缓存/失效、空闲只停 sidecar、销毁前校验镜像路径，单元）；`test/n04-search-quicklook.test.js`（Quick Look 分类/上限/转义、原生拖拽启动与拒绝、逐类降级，单元）；`e2e/local-search.spec.js`（真实 Electron 搜索窗查询本机 Everything、分类/排序/Esc 隐藏，e2e——需本机已装 Everything 且按 AGENTS.md 处理环境） | `needs-real-device` | 真实 Everything 1.4/1.5 的 600 条中文路径大包、迟到+新查询不串结果、逐字输入无逐键全桌面枚举、120 s 空闲后索引进程存活、预览 blur 清理；四个目标应用的真实拖放接受/拒收与落点行为 |
| V08 录制、编辑与音轨 · U03、F03、N03 | 4K 窗口录制后重录、重启后重开旧工程；1080p30 连录 30 分钟并交叉开关系统声/麦克风四种组合；Direct-Track 下标注入口；控制条快捷键 + 已知静音/鼠标活动；预览、裁剪、撤销、导出 | `test/u03-record-ux.test.js`（窗口/区域/显示重录、重启保帧率、同标题外部窗可录、软限幅混音、Direct-Track 禁用标注，单元）；`test/f03-recording-performance.test.js`（单 FileHandle、波纹 30 点击→2 节点、编码器 listing+smoke 双门控与 libx264 回退，单元）；`test/n03-recording-hud.test.js`（快捷键策略/媒体时钟/静音+鼠标静止裁剪/HUD/撤销，单元）；`test/recording-export.test.js`（ffmpeg 导出/裁剪/取消/队列；真实 ffmpeg 用例带 `ffmpeg-static` 依赖，单元+真实编码）；`test/pointer-track-service.test.js`；`e2e/recording-workbench.spec.js` | `needs-real-device` | 真实 4K 窗口重录与重启重开；1080p30 连录 30 分钟、双路可分辨无爆音；Direct-Track 标注禁用且录制继续；真实静音/鼠标活动的一键裁剪可撤销；同素材 `framemd5` 波纹对帧（本机仅做过 90 帧样本）与真实 AV 写盘停顿 |
| V09 设置与备份 · U05、N06 | 设水印导出截图；搜索防抖期间切路由、录制预检中离页、切翻译语言、显示主窗后等回收期；Ctrl+K 搜索跳转；隔离模块数据做加密归档→新根恢复→错误密码/篡改；核对归档与恢复后配置无源 API Key、重配提示符合策略 | `test/u05-config-lifecycle.test.js`（离页清搜索定时器/录制预检、语言互换、水印表单，单元+接线）；`test/n06-config-search-backup.test.js`（15 路由搜索索引/匹配/排序、Ctrl+K DOM 行为、归档加密往返、错误密码、篡改、明文/加密**均无 API Key**、错误密码/篡改在写目标前失败、三语提示，单元+IPC）；`test/data-root-backup.test.js`（包/恢复无凭据、恢复回执、三语重配指引，单元）；`test/data-root-backup-ui.test.js`（预览→确认→恢复、locator/重启、写暂停、错误码映射，单元）；`test/main-window-reclaimer.test.js`（显示主窗解除空闲回收，单元）；`test/search-domain.test.js`（搜索窗 blur/释放语义，单元） | `needs-real-device`（DEV-09 凭据契约已 `automated-covered`） | 安装候选上：水印在导出截图可见；防抖/预检离页不覆写新页；语言互换与主窗回收肉眼确认；Ctrl+K 真实跳转；加密归档在新根恢复往返、错误密码/篡改无目标写入、重配提示可见。DEV-09 决策见 [决策记录](2026-11-28-dev09-credential-migration-decision.md) |
| V10a 硬件编码器 · F03 | 在 NVENC/QSV/AMF 可用设备上做一帧探测与完整导出，模拟所选编码器不可用；分设备列显卡/驱动/FFmpeg/实际 encoder/耗时/体积/画质/回退原因 | `test/f03-recording-performance.test.js`（编码器 listing 解析优先级、编译进但运行期加载失败时的 smoke 回退、失败重试 libx264，单元）；硬件编码器的**真实可用性/质量没有自动化替代品**，本机只能验证回退逻辑 | `blocked-missing-hardware` | 需要分别具备 NVENC/QSV/AMF 的真实设备与驱动；本机无法采集三家的真实 encoder/质量/耗时证据。缺卡按计划标“缺设备” |
| V10b 慢盘与 I/O · F03、F05、F06 | SSD 与慢盘分别跑 4K 剪贴板、长图拼接、大图贴图逐出再读；录制写盘受阻时停止/等待保护；记录进程树 Private Bytes/工作集/GPU/CPU/IO 峰值与回落后 | `test/f05-clipboard-performance.test.js`（缩略图缓存/淘汰，单元）；`test/f06-capture-performance.test.js`（空白探测、matcher、贴图 LRU，单元）；`test/chunk-backpressure.test.js`（32 MiB 高水位暂停录制、5 s 卡写判定，单元）；`test/memory-snapshot.test.js`；`native/clipboard` cargo 测试 | `blocked-missing-hardware` | 需要真实慢盘/受控 I/O 与可观察进程树；本机无法制造并稳定复现 4K 屏障阻塞、写盘停顿与内存峰值曲线 |
| V10c 混合 DPI 多屏与负坐标 · V04/R03 | 100/125/150/200% DPI、混合 DPI 负坐标双屏、锁屏/睡眠/唤醒、RDP 下的贴图/截图/搜索行为 | `test/u02-longpin-ux.test.js`（跨 DPI move-end 数学，单元）；`test/f06-capture-performance.test.js`；`e2e/main-window-ui.spec.js`（真实 Electron 不同 zoom/theme/language 的控件适配，e2e）；`test/window-backdrop.test.js`（主题背景接线，单元） | `blocked-missing-hardware` | 需要第二块显示器与可切换 DPI 的真实桌面；本机无混合 DPI 负坐标布局，无法截图/观察定位偏差。锁屏/睡眠/RDP 同样缺环境 |

说明：V10 在计划里是一条工单，本台账按“缺什么设备”拆成三行，避免把三类不同阻塞混成一个状态。
计划 §2 末段“NVENC/AMF 加载失败 vs HVENC/QSV 通过”的表述冲突，在拿到 V10a 原始日志前仍维持
“待硬件确认”，不以本机 smoke 结果替代。

## 2. §3 已修缺陷的六项专项复验

方法（计划原文）：先用旧版本或原夹具确认触发步骤，再在同一数据副本和设备上测候选；复发时保存最小样本、
补失败的行为测试，修复后从同一用户入口重测。

| # | 复验项 / 修复提交 | 自动化回归（已核实的用例/位置；层级） | 自动化判定 | 剩余人工复验（精确步骤） | 关闭条件 |
|---|---|---|---|---|---|
| 1 | 历史搜索中断中文组字 · N02，`3868ccf` | `test/n02-history-ocr-ux.test.js`：`the search box ignores IME composition events and never full-renders per keystroke`（compositionstart 清防抖、组字中 input 忽略、Enter 229 保护、失配 compositionend 自愈、只更新结果区）、`the search debounce is shared by the free-text box and the committed IME value`（单元+接线）；`e2e/highlighter.spec.js`：`history search survives an IME composition and exposes the tag dropdown`（真实 Electron 中组字期间输入节点不被替换，500 ms 后同节点且值保留；空历史 OCR 条隐藏，e2e） | `automated-covered` | 微软拼音/搜狗实际输入：慢速逐字、翻候选页、回车/空格上屏、Esc 取消、组字中切走再回来；焦点/光标/输入框节点稳定；只按已提交文本筛选；搜索后加载第二页、在途缩略图可见 | e2e 场景在候选上复跑 + 真机两种输入法通过；复发则按 `config/routes/history.js` 的 composition/代际/分页落点补行为测试后重测 |
| 2 | 历史 OCR 无状态/无法补索引 · N02，`3868ccf` | `test/n02-history-ocr-ux.test.js`：`OCR status values are normalized…`、`the indexer writes pending, done, empty and failed…`、`a pending record from a previous run reads as unindexed…`、`records indexed by the first N02 release read as done…`、`markOcrStatus refuses unknown statuses…`、`the facade index action backfills only captures that still need an index`、`failure can be retried explicitly…`、`a job dropped because OCR was switched off is reported as skipped`、`the queue snapshot exposes the record being recognized`、`the page-level OCR bar logic is priority-ordered…`、`a background OCR write changes the card signature`（单元+接线）；`test/n02-history-ocr.test.js`（索引器队列/重试/删除丢弃，单元）；`e2e/highlighter.spec.js`（空历史状态条隐藏，e2e） | `automated-covered` | 真实 OCR 模型：有字/空白/故障模型/缺图/关闭索引/只有旧 `ocrText` 的记录；核对 pending→done/empty/failed/skipped；模型恢复后单卡重试、批量补索引、运行中退出再开；记录徽标、进度、终态与「入队不增加整表落盘」；旧正文能搜到 | 自动化绿 + 真实模型终态与批量进度证据；复发落点 `history-ocr-indexer.js`/`history-service.js`/历史页 |
| 3 | 标签筛选不能选取 · N02，`3868ccf` | `test/n02-history-ocr-ux.test.js`：`the tag filter is an exact case-insensitive match, not a substring`、`listTags reports the tags that exist, with counts, most used first`、`the frozen history channel routes the new tag/OCR commands and rejects unknown ops`、`the history page renders the tag dropdown instead of typed tag search`、`a filter change keeps load more, thumbnails and the tag filter usable`（单元+接线）；`test/history-service.test.js`：`normalizes and applies history search filters`（单元）；`e2e/highlighter.spec.js`（下拉存在，e2e） | `automated-covered` | 新建近似名标签（大小写、精确、条数）；删掉当前标签最后一条；模拟标签读取失败；刷新期间离页；浅/深色与窄窗重复；下拉与结果一致 | 自动化绿 + 真机布局/失败回退通过；复发落点 `history:list` 的 `list-tags` 信封与 `config/routes/history.js` |
| 4 | 托盘退出卡死 · H05，`cdb6902` | `test/h05-architecture-extraction.test.js`：`tray refresh creates the icon once, refreshes the menu and stops when disabled`（关闭托盘时 destroy 计数）、托盘点击/提示/双击路由、`main.js no longer registers domain channels or builds the tray itself`（单元+接线）；`test/diagnostics-runtime.test.js`（真实 Electron 主进程完整启动→干净退出 `exitType: quit`；before-quit 抛错会超时，探针。注意该探针 `enableTray:false`，只覆盖退出委托路径，不销毁真实托盘）；`test/electron-runtime.test.js`、`test/window-security-runtime.test.js`（探针） | `automated-covered`（退出路径）；托盘交互与真实托盘销毁仍需真机 | 从完整主程序点托盘退出，记录退出码/耗时/渲染进程错误；退出完成且无孤立侧车；重启 Explorer、睡眠/唤醒后再退出；对照计划 §3 “退出卡住按 tray 控制器回查” | 真实候选托盘退出证据；复发落点 `main/domains/tray/index.js` + `main.js` 退出委托，先跑三支 runtime 探针 |
| 5 | 贴图启动标记丢失 · N05，`5c660d0` | `test/window-security-runtime.test.js`：`every remaining renderer loads under the locked Electron sandbox`——`pin` 渲染层在 locked sandbox 下 `markerType === 'function'`（即启动标记 `applyPinData` 可达，探针）；`test/n05-pin-onion-snapshot.test.js`（工作区快照保存/恢复/挂起/恢复/缺失图，单元+接线）；`test/pin-domain.test.js`（贴图窗口/图像生命周期，单元） | `automated-covered`（启动标记）；独立启动时序仍需真机 | 独立打开贴图，在 locked-sandbox 下等启动标记再载入数据，记录渲染进程错误；结合 V04 的 100%/150% 双屏定位与恢复 | 探针在候选源码上复跑 + 真实独立贴图启动正常；复发落点 `pin/pin.js` 的 `applyPinData` 可达性与启动标记 |
| 6 | 本地搜索窗双重圆角 · `8ca1a60` | `test/window-backdrop.test.js`：`the window shells fill the frame without drawing a second one`（search shell `inset: 0`、无 border/box-shadow/backdrop-filter、body 主题背景）、`the search window keeps native rounding and the OS shadow`（不 `transparent`、不 `roundedCorners:false`、不 `hasShadow:false`、不硬编码背景色）、`the config page paints an opaque theme background`（单元+接线） | `automated-covered`（代码/接线）；像素外观仍需真机 | Win10/11 浅深背景、不同 DPI 下打开搜索、预览、切焦点，留四角 1:1 截图；同一角只有一道轮廓，命中区正常；回归 V07 | 真机四角截图证据；复发落点 `main/domains/search/index.js`、`main/services/window-backdrop.js`、`search/search.css` |

## 3. 历史页八处加固（随 §3 三项复验关闭）

来源：[修复方案](2026-11-27-history-ocr-ux-fixes.md) §4。八处均由 `test/n02-history-ocr-ux.test.js`
覆盖，其中第 1 项另有真实 Electron e2e；其余多为“源码接线断言”而非完整行为回放，故标注为接线级。
自动化判定为 `automated-covered`，但验收仍随 §3 第 1–3 项的真机复验一起关闭，不单独算真机通过。

| # | 加固项 | 自动化回归（已核实用例；层级） | 自动化判定 | 剩余人工复验 | 关闭条件 |
|---|---|---|---|---|---|
| 1 | 筛选后“加载更多”失效 | `n02-history-ocr-ux`：`a filter change keeps load more, thumbnails and the tag filter usable`（`state.version` 代际比较、`finally` 恢复按钮）；`e2e/main-window-ui.spec.js`：`history pagination, selection and anchored actions keep their state`（搜索后第二页仍追加，e2e） | `automated-covered`（单元+接线+e2e） | 真机上筛选/搜索后点“加载更多”，确认追加而非回退/禁用 | e2e 与真机均通过（随 §3 第 1/3 项） |
| 2 | 在途缩略图被误判不可用 | 同 1（版本失配但节点仍连接时照常写 `src`，只有真取不到才标不可用，接线） | `automated-covered`（接线级） | 边输入边滚动，缩略图不出现永久“不可用”；二次等待后仍能补齐 | 随 §3 第 1 项真机复验 |
| 3 | 组字标志丢失 `compositionend` 卡死 | `n02-history-ocr-ux`：`the search box ignores IME composition events and never full-renders per keystroke`（`isComposing=false` 自愈、blur/新输入框复位，接线） | `automated-covered`（接线级） | 组字中切走/失焦后立刻普通输入，不被吞；Enter 仍受 IME 保护 | 随 §3 第 1 项真机复验 |
| 4 | 标签读取失败清空筛选 | 同 1（`list-tags` 失败返回 `null`，仅“确认列表存在且不含所选标签”才回落，接线） | `automated-covered`（接线级） | 模拟读取失败（真机可临时改目录/断点），下拉保留所选标签且结果不静默清空 | 随 §3 第 3 项真机复验 |
| 5 | 二次等待后的路由守卫 | 同 1（标签重置的第二次 `await` 后重查 `currentRoute`/渲染代际，接线） | `automated-covered`（接线级） | 刷新/离页与新渲染竞态下无旧 DOM 写入（快速切换标签+离页） | 随 §3 第 3 项真机复验 |
| 6 | `index-ocr` 缺目标默认全量 | `n02-history-ocr-ux`：`the frozen history channel routes the new tag/OCR commands and rejects unknown ops`（缺 `ids`/`all` 抛错，不默认全量；单卡/批量走显式载荷，单元+接线） | `automated-covered` | UI 上单卡/批量补索引只处理目标记录（看进度与状态条） | 随 §3 第 2 项真机复验 |
| 7 | 空结果/缺图反复补索引 | `n02-history-ocr-ux`：`the facade index action backfills only captures that still need an index`（`empty`/`done` 终态、文件丢失跳过）、`the indexer writes pending, done, empty and failed…`（单元）；`n02-history-ocr.test.js`（失败重试一次后放弃，单元） | `automated-covered` | 状态条的「识别未索引项」重复点击不重复处理 empty/缺图，进度最终归零 | 随 §3 第 2 项真机复验 |
| 8 | 入队多一次整表写入 | `n02-history-ocr-ux`：`the indexer writes pending, done, empty and failed…`（接受任务前 `store.writes` 不变、批量只一次通知，单元）；`n02-history-ocr.test.js`（索引写回路径，单元） | `automated-covered` | 保存截图/批量补索引时观察历史文件写入次数或 app.log，无整表重写 | 随 §3 第 2 项真机复验 |

## 4. §5 安装、签名与硬件证据（R01–R03）

三项均**未执行**，状态 `not-run`。原因一致：本机是开发者/编辑器宿主，不是发布通道；
仓库约定 `verify:package` 需要完整 electron-builder 产物 + 静默安装，`verify:release` 需要签名证书与
资产清单，硬件矩阵需要真实设备。证据登记表也早已把这三项登记为“未执行”，本台账不改变该事实。

| 工单 | 前置与执行顺序 | 状态 | 本机为何不能出结论 | 关闭条件 |
|---|---|---|---|---|
| R01 候选产物和签名 · 发布工程 | 从目标 tag 确认完整 SHA/版本/渠道与 CI run；取得同一构建的 NSIS/portable/`win-unpacked`/blockmap/更新 manifest/CycloneDX SBOM；执行 `npm run check:version`、`npm run verify:package`，按渠道配置发布者并执行 `npm run verify:release` | `not-run` | 本机无签名证书/发布凭据，也没有目标 tag 的完整候选资产与 CI run；`check:version` 即使能跑也只证明版本一致性，不能替代签名与资产校验。`verify:package` 需完整安装产物与静默安装（AGENTS.md 明确其不能由受限宿主冒充） | 在某台发布机上按顺序取得目标 tag 候选资产，记录 SHA-256/fuses/启动结果、Authenticode 发布者/时间戳，附 `check:version`/`verify:package`/`verify:release` 输出；缺签名或资产时逐文件记录 |
| R02 实际安装、更新与数据保全 · Windows QA | 干净 Win10 22H2 x64 / Win11 隔离会话用 R01 资产静默安装；旧版种入测试数据再覆盖升级；核对版本/托盘/删历史后磁盘占用/配置根/登录项；卸载检查用户数据保留；便携版独立目录启动；采集默认 NSIS 前 2 分钟与跨 24 h 的更新域名流量，再手动检查一次 | `not-run` | 本机不是干净隔离安装环境，也没有可安装的签名候选；更新域名流量需要受控网络与 24 h 时钟推进，安装/升级/卸载需真实 NSIS 与用户配置目录。这些都无法由单元测试或本机模拟替代 | 在隔离 Win10/11 会话执行完整安装/升级/卸载矩阵，附退出码、实际运行文件版本、目录差异、登录项与网络计数（默认自动检查关闭时两点为 0、手动一次仅一次请求且不启动定时器、portable 不调用 NSIS 更新器） |
| R03 硬件矩阵和逐单结论 · 发布负责人 | 汇合 V01–V10 与 R02，在真实设备补 100/125/150/200% DPI、混合 DPI 负坐标双屏、锁屏/睡眠/唤醒、RDP、双音轨、慢盘；F03 三家硬编引用 V10 原始样本；`npm run collect:hardware` 与 runtime probe，证据存 `docs/releases/evidence/<version>/`，再用 `npm run verify:hardware -- --version … --source-commit …` 汇总 | `not-run` | 缺硬件（GPU 编码器/慢盘/第二屏/RDP/双音轨设备）且缺签名候选；`collect:hardware` 只能采到本机开发机环境，不能代表矩阵，也不能作为晋级证据 | 用签名候选跑完整矩阵，按 claim 登记包型与环境，P0/P1 失败停止晋级、P2 附问题链接与规避；缺实物或缺必需 claim 记为“待补证据”，不能用本机数据冒充 |

> **2026-11-28 补充（R01 部分证据，不改变状态）**：为验证本批代码，分支 `feat/review-optimization-2026-11-26`
> 以 `workflow_dispatch` 跑通 `Windows CI`（run [`46104498694`](https://github.com/SherUnlocked-4869/Highlighter/actions/runs/46104498694)，
> sha `b40c96ac6e34dfa997eb3472becf8b8c9d3cd831`）：quality 与 package 两个 job 全绿，package job 产出并校验了
> **unsigned** 候选（`verify:package` 输出 `{"version":"5.1.1","signed":false,"setup":"Highlighter-Setup-5.1.1.exe",
> "portable":"Highlighter-5.1.1-portable.exe","manifests":["latest.yml"],"checksums":"SHA256SUMS.txt"}`，Electron fuses
> 全部按预期：RunAsNode=off / CookieEncryption=on / NodeOptions=off / InspectArgs=off / AsarIntegrity=on / OnlyLoadAppFromAsar=on；
> 候选 artifact `Highlighter-Windows-b40c96ac…`，bundle sha256 `ca7e89830b8afee32d49cb8334f84d2ba33b55eb840d7fd0b818b7e4906515d1`）。
> 这属于 R01 的**功能诊断级**证据；签名渠道、Authenticode 发布者/时间戳、`verify:release`、隔离安装与 R02/R03 仍未执行。

## 5. 状态汇总（本台账行数）

| 类别 | 行数 | 状态分布 |
|---|---|---|
| §2 V 工单（V01–V09 各 1 行 + V10 按阻塞拆 3 行） | 12 | `needs-real-device` 9；`blocked-missing-hardware` 3（V10a/b/c） |
| §3 六项专项复验 | 6 | 自动化部分 `automated-covered` 6；整体验收仍 `needs-real-device` 6 |
| 历史页八处加固 | 8 | `automated-covered` 8（其中 1 项含 e2e，其余为接线级）；真机随 §3 复验，不单独判定 |
| §5 R 工单 | 3 | `not-run` 3 |

**没有任何一项被本台账判定为“真机通过”或“发布通过”。** 要变成通过，必须按上表“关闭条件”在安装候选/
真实设备上执行并回填证据；自动化为绿的项只说明代码契约仍成立，不说明真机体验与打包产物合格。

## 6. 本机执行记录（2026-11-28，docs-owner 本轮）

```powershell
# 备份契约定向回归（D04 + N06，含本次新增 6 个 DEV-09 用例）
node --test test/data-root-backup.test.js test/n06-config-search-backup.test.js
# → tests 70 / pass 70 / fail 0（耗时随宿主负载波动，不作为验收指标）

# 评审证据登记表格式门禁（脚本校验 2 张表 / 50 工单 / 9 个必需 P0）
npm run check:review-evidence
# → ok

# 静态语法门禁（本轮改动含两个测试文件）
node scripts/check-js.js
# → Syntax check passed for 612 JavaScript files.
```

未执行且不得冒充：`npm test`、`npm run check` 全量、`npm run test:e2e`、`npm run test:long-capture`、
`verify:package`、`verify:release`、`collect:hardware`、`verify:hardware`，以及本台账所有真机步骤。
真实 Electron 探针/e2e 需按 AGENTS.md 处理环境后由发布/QA 在候选上执行。

## 7. 关联产物

- [DEV-09 凭据迁移边界决策记录](2026-11-28-dev09-credential-migration-decision.md)（维持现行策略；
  两种归档均无 API Key 的回归与三语重配指引落点）
- [评审证据登记表](../evidence/2026-11-26-review-optimization-evidence.md)（N06 行按本次事实更新）
- [历史 OCR / 标签交互修复方案](2026-11-27-history-ocr-ux-fixes.md)（§3 与八处加固的根因与修复）
- [硬件验收与晋级](../releases/HARDWARE_ACCEPTANCE.md)、[矩阵定义](../../config/release-hardware-matrix.json)

## 8. 复核结论新增/变化的真机复核点（2026-11-28 复核跟进）

第三方复核在 `b84eeba` 上重开 7 张工单、提出 4 个 P1 与 7 个 P2；修复提交为 `26cbfc8..289b195`
（逐项内容与本机证据见[复核结论修复交付记录](2026-11-28-review-follow-up-fix-record.md)）。
**V01–V10 / R01–R03 的步骤与状态不变**，但下一候选必须包含这些修复提交，并按复核要求补跑下列复核点；
在候选上执行前，本台账不新增任何“真机通过”。

| 复核项 | 候选上必须观察 |
|---|---|
| P1-01 | 贴图菜单开启真实像素比对：首帧、连续更新、手动关闭；贴图不出现在屏采/录屏中 |
| P1-02 | 真实硬件键盘：控制条/演示页/文本框/密码框/拼音组字/未知焦点；允许组合恰 1 条、排除类 0 条、暂停段 0 条 |
| P1-03 | 真实窗口 Enter/复制按钮/双击/贴图四条入口“编辑→确认→再次打开”后旧矩形仍可选择、移动、删除（100%/150% DPI） |
| P1-04 | 真实 OCR 模型侧车上制造破管/半帧后，下一次识别在新握手后成功；临时文件/通道无残留 |
| P2-01 | 工作台同页连续开录 A/B：B 默认关闭“仅本次录制”的快捷键采集；启动失败保留选择 |
| P2-02 / P2-04 | 真实 DPI/多屏、旋转贴图与滚动条外观：长图顶部/中段/底部导出与视口一致；竖排中文与窄框长译文的阅读方向、换行、边界与可见叠层一致 |
| P2-03 | 运行中物理拔插副屏：目标屏缺失时不交付主屏像素，恢复后自动续采 |
| P2-05 | 300 重复标签与超过 64 种标签素材：成片尾段含保留胶囊；确认前显示实际截断范围 |
| P2-06 | 真实键盘同源连击与控制条+全局双报同一次按键：分别 2 条 / 1 条 |
| P2-07 | Everything 1.4/1.5 重启、迟到回执与双实例切换：状态不黏在无响应实例，`wait-ready` 在超时前恢复 |

复核点与自动化证据的对应关系见修复记录 §1/§5；仍未执行的发布门槛（签名、`verify:release`、隔离安装/升级、
硬件矩阵）不变，见 §4。
