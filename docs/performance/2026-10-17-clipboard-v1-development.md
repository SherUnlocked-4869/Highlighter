# 剪贴板 V1 开发记录

2026-10-17：用户明确要求先跳过测试门槛，继续后续开发，完成开发后再实机测试。本记录覆盖这一执行调整；原开发文档 T04/G0 的未测项仍然有效，不能据此声称资源预算或第三方兼容性通过。V1.1 主动粘贴和 V2 格式扩展仍不在本次范围。

## 存储、查询和规则（T05–T07）

- SQLite schema v1，WAL、4 MiB 页缓存、关闭 mmap；启动 quick_check、拒绝过新 schema，验证 FTS5 trigram 可用。schema 不兼容或损坏时保留原数据并报错。
- 摘要/正文分离；文本保留原始空白，URL 分类独立于正文。内容指纹使用有版本的长度前缀 SHA-256；重复更新原 item，保留创建时间、置顶和使用计数。
- 图片完整解码校验后保存 PNG，缩略图最长边 240px（小于方案 320px 上限，使最坏 RGBA 缩略图也适配 256KiB 帧）。PNG 动画、V5 嵌入色彩配置当前拒绝。单线程图像工作，无载荷排队；解码上限 64MiB，原 DIB 64MiB，PNG 编码上限 16MiB。真实内存峰值待测。
- 附件 staging create_new、sync_all、原子发布再提交 DB；启动回收孤儿，删除先事务移除记录并记 GC。路径分量拒绝链接/Windows 重解析点；复制原图前验证内容指纹。
- 采用 dataset/revision/filter 绑定的 keyset 分页，每页最多 100 条，不在列表查询中读取正文；详情最多 64KiB。搜索是字面量，3 字符起用 trigram，短词用转义 LIKE；200ms 查询预算。搜索索引最多保存每条前 32768 个 Unicode 字符。
- 普通记录条数/保留期与磁盘、payload、缩略图预算；容量不足先有界清理最多 50 条普通记录，置顶不自动删除，清理失败的附件仍占容量。维护/校准低频执行；物理占用在校准间隔内采用保守增量估算。
- 删除/清空先使采集世代失效，再与入库共用串行锁，避免旧快照重新出现。写操作保留有界 receipts；历史复制写入 pending receipt 后才接触系统剪贴板，中断结果明确为未知，不自动再次复制。
- 历史复制通过原生协调屏障串行发布 Unicode 或 PNG+DIBV5，抑制自身回录；不注入按键，不恢复旧剪贴板。
- 历史图片在读取/解码原件前获取屏障，使采集和复制不会同时进行重图像工作；DIBV5 直接填充自有 HGLOBAL，避免额外保留一份原始 DIB。DIB 采集的临时 BMP 容器在编码 PNG 前释放。准备复制期间若系统序列已被用户改动，取消写入；仅实际自身改写的序列用于抑制。
- 新库在建表前启用 incremental auto-vacuum；维护按批回收空闲页，已有未启用该模式的库不被静默全库重建。清空采用一次集合删除 FTS 行，避免逐记录重复扫描。UNC 和映射网络驱动器均拒绝作为活跃数据库位置，驱动器识别依据 [GetDriveTypeW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getdrivetypew)。
- 应用排除使用 Windows 可执行文件名（统一小写，如 `keepass.exe`），同名不同目录一起排除；启用排除时来源无法识别则跳过。此身份粒度与原方案按完整应用身份选择的交互不同，设置中明确说明。

编译/静态检查属于开发自检，继续执行。自动化功能测试、系统剪贴板写入、可见窗口和资源验收按用户要求暂缓；以上是实现内容，不是测试通过声明。

依赖依据：[rusqlite](https://docs.rs/rusqlite/0.40.2/rusqlite/)、[image 限额读取](https://docs.rs/image/0.25.10/image/struct.ImageReader.html)、[SQLite trigram](https://www.sqlite.org/fts5.html#the_trigram_tokenizer)。具体版本锁定在 Cargo.lock。

## 后台服务与配置（T08–T09）

- `ClipboardService` 串行应用设置世代，默认无进程、无相关周期任务。只在明确启用后初始化 SQLite，并验证 sidecar / build-info 的来源指纹一致；查询状态不会启动后台。
- 本地 stdio 协议有分帧限额、16 个请求上限、写缓冲上限、会话校验和超时；退出时所有 pending 请求结束，复制超时明确为未知结果。stderr 只排空，不记录正文、管道 nonce 或来源完整路径。
- 取词宿主在历史启用时以 required 协调模式启动；替换宿主先等待退出证据，再以新 PID 注册。通道配置需 native health ACK，之后才开采集。没有宿主时暂停采集但可管理已有历史。关闭历史后恢复独立取词模式。
- 用户暂停、锁屏、休眠、游戏模式和迁移分别管理；迁移屏障禁止宿主生命周期回调再次启动采集。连续失败按 1/5/30 秒最多三次恢复，之后保持错误状态；显式设置操作可重试。
- 开启期间每两秒请求一次有界健康/状态，十分钟触发维护；关闭后取消。采集系统调用超过三秒由父进程回收整个自有 sidecar，不强杀线程。该健康轮询及重启后的内存行为仍待资源测试。
- 设置加入严格类型、范围、容量关系、排除项校验；快捷键默认空，托盘、主页和设置页均有入口，不默认占用 Win+V。

## 安全边界和面板（T10–T12）

- 新 `clipboard` 角色、专用 sandbox preload，逐通道授权和当前窗口归属验证。详情、复制、置顶、删除仅接收 UUID；清空由主进程对话框确认，再发绑定 sender/dataset/revision/scope 的一次性 30 秒 token。
- 独立非持久 Electron session 注册 `highlighter-clipboard` 协议，只按随机 60 秒 token 读取缩略图。没有路径参数；固定 image/png、nosniff、no-store、解码尺寸约束。隐藏、删除、历史变化和销毁撤销 token；异步回复后再次检查窗口/世代。
- 原生 DOM 面板 480×640 DIP，按显示器 workArea 裁剪；沿用主题色、字体和现有图标。文本/链接/图片筛选、搜索、置顶、删除、复制和普通记录清空；复制不自动粘贴、不注入键盘。
- 列表每页 50，页面内最多保留 150 条摘要，只渲染可见行。过期 cursor 保留当前列表并提示刷新；更新通知不抢滚动位置。详情 64KiB，完整原件始终由后端写回。
- IME 组合期间不触发搜索/Enter/Esc 操作；列表方向键、Home/End、Enter、Delete 和关闭操作保留键盘路径。
- 冷创建去重，隐藏即清空页面中的摘要、正文、图片与查询状态；异步旧结果按世代丢弃。默认隐藏 60 秒销毁，可选立即/5 分钟；关闭、迁移、renderer 崩溃立即释放。
- 三种界面语言已经接入。可见自动化/实机窗口仍须按 AGENTS.md 放到副屏；本轮未打开窗口。

## 数据迁移与构建（T13–T15）

- 迁移 marker/pending 升级到 v2，显式增加 conversations 和 clipboard 持久清单。每个文件有相对路径、长度、SHA-256；staging 校验后才发布；重启和隔离清理重试都先核对目标持久内容。
- 剪贴板迁移前停止新命令/新采集，等待事务、checkpoint、关闭 sidecar；没有停写确认则迁移失败。会话保存增加在途写入集合与 quiesce/resume，防止已存在的异步写入绕过屏障。
- 缩略图和 clipboard staging 可重建内容不迁移。SQLite 内部附件引用为内容 ID，迁移不用改绝对路径。
- 接受旧 v1 marker/layout；旧格式没有证明 conversations/clipboard 完整性而源目录仍有这些内容时，拒绝继续源清理，保留现场供恢复。旧版 rollback/quarantine 路径仍沿用现有身份校验流程。
- 正常 native build 纳入本地 selection-hook 与 clipboard；打包加入 sidecar/build-info、面板、preload、共享协议和语言表。严格原生文件检查、窗口/IPC/i18n 清单已补齐。
- 为保持 main.js 既有行数门禁，将现有文件图标缓存提取为独立 helper；没有提高 1330 行阈值。

## 当前交付与后续验收

本轮完成的是 **V1 开发候选代码**，不是已验证或可发布版本。未启动安装包、测试窗口或用户剪贴板操作；未运行功能测试套件。仅执行 Rust check/clippy、原生 release 编译及 JS/架构/i18n 静态检查。测试清单和 probe 的入口更新属于开发接线，不代表已执行。

后续集中验证：

1. 先运行后端临时数据目录 fixture：schema、去重/置顶、短词和中文搜索、cursor/revision、附件/GC 故障、磁盘预算、receipts、迁移 v1/v2 和各阶段恢复；补齐新增模块的回归用例和覆盖率，不能沿用本轮前的覆盖率数值。
2. 运行隔离 Electron 的角色/预览/清空 token 和快速开关、暂停原因、旧宿主/旧请求、崩溃恢复、关闭后无进程验证。实机启用前先验证迁移失败保留数据。
3. 在副屏进行用户授权的真实复制/取词/图片/锁屏/游戏模式测试；先建立隔离数据根和可恢复的系统剪贴板测试方案。私有 Window Station 权限问题和同应用异步发布的归属限制仍未解决。
4. 同 checkout 的整进程树关闭/启用 A/B、4K 峰值、监听锁时长、面板 100 次释放与重建、24 小时增长、PowerToys/微信/QQNT 等共存。现有 2.48 MiB 仅是旧 G0 协调器的单进程结果，不能用于 V1 资源结论。
5. 最后验证 unpacked/安装包的原生组件、来源指纹、签名与启动；本轮没有构建安装包、推送或发布。

此 V1 记录完成时，V1.1 主动粘贴尚未开放；随后根据明确要求实现，见 [主动粘贴开发记录](2026-10-17-clipboard-active-paste.md)。文件/富文本/标签等 V2 内容仍未开放。

### 开发自检记录

- `npm run check`：328 个 JS 文件语法通过；main.js 1328/1330 行，10 个 domain；三种语言各 1118 个键、无缺失；CJK 605/606。没有放宽阈值。
- `cargo clippy --locked --manifest-path native/clipboard/Cargo.toml --all-targets -- -D warnings`：通过（编译所有目标，未执行测试）。
- `npm run build:clipboard`：release 编译通过，`native/clipboard/bin/HighlighterClipboard.exe` 与 build-info 已生成。
- 最终原生来源 ID：`hl_5b3e6856ec55bdd5793231c0a9431f2ecd851d7f4157f14653a58f2825b225d6`。
- exe SHA-256：`b7bbed314905071f51f3fb6dc19fedfb753d26f01e75a6d4d3744c473a4e6530`。
- 本轮未执行 `npm test`、coverage、Electron runtime/UI 或系统剪贴板测试，未生成安装包。开发前已有的测试通过记录不能用来证明新增 V1 代码。

主要实现提交：`09c2ffe`（仓储）、`c0f1c11`（自身复制序列与缓存）、`2f987e2`（服务生命周期）、`994829f`（迁移）、`9f1180b`（规则与维护）、`e7c7752`（IPC/面板）、`4be7c84`（构建）、`d0c5a72`（退出排空）。图像内存优化另有独立提交。
