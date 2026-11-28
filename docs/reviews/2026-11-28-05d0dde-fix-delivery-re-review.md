# 05d0dde 修复交付再评审

2026-11-28 · Windows / Electron · 分支 `feat/review-optimization-2026-11-26`

**结论：暂缓候选验收。** 上一轮 10 项中，5 项在本轮复核范围内可以关闭，5 项仍有可达的失败路径。共列出 **3 个 P1、3 个 P2**。区域录制一项产生两个独立的 P1：撤销和创建存在竞态，慢速选区又会让已经关闭的音频输入恢复。建议先修复 3 个 P1，再决定候选范围。

评审基线为 `d7923ac`，产品提交为 `e4cc247`，被评 HEAD 为 `05d0ddedbc59eaf1aab59d1f88b51bfd4c737366`。区间包含 2 个提交、34 个文件。第二个提交只新增修复记录和上一轮评审。下文的“关闭”针对上一轮发现的触发条件，发布包和真机矩阵另行验收。[上一轮 10 项发现](2026-11-28-d7923ac-fix-delivery-review.md) · [本次开发交付记录](../plans/2026-11-28-d7923ac-review-fix-record.md)

## 仍需修复的 6 个问题

### P1-01　区域选框已经关闭，正在等待桌面源的任务仍能带原授权创建控制窗

**实测。** 工作台开启本次全局快捷键采集，确认区域 A。在正式录制域进入 `getDesktopSource()` 后暂停枚举，触发 A 选框的 `closed`，工作台收到 `{ok:true, created:false}`。恢复枚举后，A 依然建成活动控制窗，`_recordCaptureConfig.demoKeystrokes === true`，画质也保留了 A 的 `ultra`。本轮核实到控制窗及其采集配置。后续开始录制时，事件轨按此字段开启快捷键采集。[录制域夹具](../../test/record-domain.test.js#L725) · [采集开关](../../main/domains/record/index.js#L1813)

**原因与验收。** 选框入口在调用录制域前检查窗口身份。录制域在等待桌面源前把授权复制到局部变量，关闭回调只能清除登记表。桌面源返回后，创建窗口的分支直接使用局部配置。新增截图选框也会关闭旧窗，因此替换可触发同一时序。应在创建首个窗口前重新核对该请求的有效性与当前录制归属。分别在枚举期间取消 A、用 B 替换 A，断言 A 的帧窗和控制窗创建数均为 0，A 的回执为取消，B 只使用自己的配置。[选框替换](../../main/domains/capture/index.js#L1128) · [选框确认](../../main/domains/capture/index.js#L1414) · [异步边界](../../main/domains/record/index.js#L2215) · [取消回执](../../main/domains/record/index.js#L669)

### P1-02　选框停留超过五分钟后，会按旧设置重新打开本次明确关闭的音频

**实测。** 设上次录制的系统音频和麦克风均开。本次工作台选择区域录制、关闭两路音频、选择 `ultra`，并打开本次快捷键。在同一选框、同一请求 ID 下推进测试时钟 301 秒后确认，回执为 `created:true`。控制窗的 `record:init.audio` 却是 `{system:true, microphone:true}`，质量变回 `standard`，模式记作 `display`，快捷键变为关。选区矩形仍在。本轮验证了送入录制器的参数，未打开音频设备。[工作台音频选择](../../config/routes/recording.js#L1254) · [超时分支](../../main/domains/record/index.js#L2174) · [渲染器请求麦克风](../../record/record.js#L1285)

**原因与验收。** 五分钟期限只使配置失效，请求本身仍可成功创建录制。主进程随后用持久化偏好补全音频和模式。旧基线也有该期限，本批在加入请求身份与创建回执时保留了这种行为。应把活跃选框与其完整配置绑定至确认或撤销。如果产品需要超时，就结束请求并提示重新开始。用相反的“上次值／本次值”覆盖两路音频，验证到期前后都不会以旧音频配置成功开录。[配置回退](../../main/domains/record/index.js#L1517) · [成功回执](../../main/domains/record/index.js#L2404)

### P1-03　UI Automation 获取模式接口失败时，原生策略仍可能允许快捷键

**证据。** 现实现能拒绝“已取得 ValuePattern，但无法读取只读属性”，也能拒绝 HWND 容器回退。本轮复跑的副屏探针中，可写富文本判为 `text`、密码框判为 `password`。遗漏发生得更早：两次 `GetCurrentPatternAs` 取得接口失败时，两个 `*PatternPresent` 都保持为假，证据中没有字段表示查询出错。若焦点、控件类型与密码属性已读成功，控件又属于 Custom 等非 Edit/Document/Text 类型，这组字段可以进入 `safe_focus`。给重建的原生件输入这组证据，组合键自测返回 `{accepted:true, combo:"Ctrl+V", context:"safe"}`。这是生产源码分支和原生策略自测，未注入真实 UIA provider 故障或采集硬件按键。[ValuePattern 获取](../../vendor/selection-hook/src/windows/core/keyboard_focus.cc#L167) · [TextPattern 获取](../../vendor/selection-hook/src/windows/core/keyboard_focus.cc#L204) · [默认允许分支](../../vendor/selection-hook/src/windows/core/keyboard_focus.h#L255)

**修复与验收。** 为模式查询保留“支持、已确认不支持、读取失败”三种结果，读取失败时返回 `unknown`。同样区分读取焦点窗口句柄失败与成功返回空句柄，当前代码在前一种情况下也默认 `sameWindow=true`。用替代 provider 分别从模式查询和句柄读取处返回错误，验证最终 IPC 与事件轨增量为 0，并保留已证实的只读文档和普通按钮正例。[窗口归属检查](../../vendor/selection-hook/src/windows/core/keyboard_focus.cc#L286) · [现有原生回归](../../test/n03-focus-context-contract.test.js#L237)

### P2-01　显示器数量、ID 都没变，布局互换时差分仍会交付旧屏像素

**实测。** 两块 1920×1080 屏的 ID 为 1、2，分别返回像素标记 11、22。固定贴图在左屏，在 `getSources()` 期间交换两屏的系统坐标，ID 和数量完全保留。正式 `captureScreenUnderPin()` 第一帧返回 `ok:true`、像素 11，下一帧在相同布局、相同贴图坐标返回 22。第一次已采到当前贴图下方以外的屏幕。此处使用有标记的测试像素及注入的显示器快照。[域测试夹具](../../test/n05-pin-screen-diff.test.js#L358) · [拓扑判定](../../pin/pin-screen-diff.js#L310) · [裁剪交付](../../main/domains/pin/index.js#L1240)

**修复与验收。** 采集前后的检查只比较屏幕数量和旧目标 ID 是否存在，裁剪仍使用第一次计算的 `physicalRect`。枚举后应确认同一贴图区域仍映射到同一目标及物理裁剪矩形，连同影响裁剪的缩放和旋转变化一起处理。两屏等数量换位、目标屏缩放改变时，断言过渡帧可重试且没有像素，下一帧标记和裁剪尺寸均正确。[坐标规划](../../pin/pin-screen-diff.js#L114) · [第二次读取显示器](../../main/domains/pin/index.js#L1216)

### P2-02　竖排译文中的拉丁字母在 PNG 里转错了方向

**实测。** 用仓库隐藏 Electron 夹具加载正式 `pin.html`，向 40×180 的竖排译文框送入单个拉丁大写 `I`。在 125% 缩放下，分别取窗口实际渲染和“导出当前视图”的 PNG，以相同阈值测译文框内的深色墨迹。两幅图各有 81 个深色像素，屏幕上墨迹为 **21.6×2.4 CSS 像素**，PNG 为 **2.4×21.6**。只检查“有墨迹”或字符完整，都会错过这个 90° 差异。[正式竖排样式](../../pin/pin.css#L38) · [导出绘字](../../pin/pin-view-export.js#L488) · [渲染器测试夹具](../../test/u02-pin-renderer-runtime.test.js#L689)

**修复与验收。** 浏览器按 `vertical-rl` 处理竖排块中的侧向西文。导出器保留字素中心和列序，却仍逐个直立绘制字素。应让绘制过程保留竖排字形方向和侧排文字段的塑形。将单独的 `I`、中英混排及原有中文、emoji 一同纳入屏幕与导出图墨迹比较，验收字形方向、位置和列序。

### P2-03　Everything 的 Rust 等待接口已修复，JavaScript 正式入口仍可跳过查询应答检查

**实测。** Rust 在查询超时后可保留 `running:true, dbLoaded:true, ipcAvailable:true, probeTotal:0` 的展示快照。普通 `status` 响应只返回快照，丢弃本轮 `answered`。把该快照送入正式 `EverythingService`，让 `wait-ready`（如被调用）返回假。独立调用 `ensureReady()` 和 `refreshStatus()` 都得到 `phase:"ready"`，两条调用链均只发出 `["status"]`，前者还写入两秒就绪缓存。后续未命中结果缓存的搜索会直接发出查询。[Rust 状态协议](../../native/everything-search/src/main.rs#L1069) · [状态页判定](../../main/services/everything-service.js#L129) · [搜索就绪捷径](../../main/services/everything-service.js#L406) · [查询入口](../../main/services/everything-service.js#L448)

**修复与验收。** 把本轮查询是否应答带入侧车状态协议，让两个 JS 入口共享同一就绪条件；空索引的有效回复可以使实例就绪。用“静默且已加载 → 新实例应答且 0 条”驱动 JS 服务，断言旧实例保持等待、不写就绪缓存，切换后才允许查询；保留 Rust 已通过的候选排名测试。[Rust 等待判据](../../native/everything-search/src/main.rs#L1095)

## 上轮 10 项逐项裁定

| 上轮项 | 裁定 | 本轮能确认的行为 |
|---|---|---|
| 1 区域录制授权与回执 | 重开 | 先取消 A 再开快捷 B、仅聚焦、已完成创建后再关闭均通过。枚举期间撤销及活跃请求超期见 P1-01、P1-02。 |
| 2 OCR 写管道导致父进程异常 | 关闭 | 用上一轮真实 Windows 父子进程脚本重跑，8 MiB 帧写入期间子进程退出，识别返回 `OCR_SIDECAR_RECYCLED`，父进程退出码 0。 |
| 3 焦点证据不足仍允许快捷键 | 重开 | 已取得模式后读属性失败、仅容器、无只读证据的 Document/Text 已拒绝。更早的模式获取失败见 P1-03。 |
| 4 OCR 超时排队帧 / 停滞写 | 关闭 | 已过期的排队帧在落笔前跳过，停滞在途写到期回收，已写完且推理慢保留同一代。三个时序的用例均通过。[OCR 时序测试](../../test/ocr-service.test.js#L1035) |
| 5 单屏来源与拓扑变化 | 重开 | 冲突 ID、多匿名来源、数量改变和目标 ID 消失均已拒绝。相同 ID 的布局变化见 P2-01。 |
| 6 译文字素与排版 | 重开 | 水平按行塑形，ZWJ 表情、组合音标、阿拉伯文的现有回归通过。竖排西文字形见 P2-02。 |
| 7 OCR 布局读取预算 | 关闭 | 每块最多 512 次、全局最多 4096 次 Range 读取；预算截断的长窄框有 `complete:false`，可见前缀的回归通过。[预算用例](../../test/u02-pin-view-export.test.js#L829) |
| 8 录屏快捷键先选区、后限额 | 关闭 | 600 个事件全片保留 500，准确披露丢弃 100 个及源时间 500500–599500 ms；截取最后 100 秒，保留 100 个。[选区与披露断言](../../test/shared-recording-export-options.test.js#L366) |
| 9 同一快捷键双源配对 | 关闭 | 全局 1000/1090 ms、控制条 1110/1200 ms 合并为两条。单源连击、单侧漏报、120 ms 边界的回归通过。[保序匹配](../../main/domains/record/index.js#L315) |
| 10 Everything 就绪与候选排序 | 重开 | Rust 等待谓词及应答空索引的排名通过。展示快照流入 JS 后的行为见 P2-03。 |

工作台回执还有一处交付措辞需要校正。区域模式对正常成功返回 `created:true`；显示器和窗口模式仍沿用 `{ok:true}`。页面助手遇到 `ok:false`、`focused:true` 或 `created:false` 才保留本次选择，其他返回值（包括空值）都会消费选择。现有“只聚焦”用例通过；“页面只在显式收到 `created:true` 时消费”的说法超出了代码实际保证的范围。[页面判定](../../config/routes/recording.js#L295) · [主进程工作台入口](../../main/domains/record/index.js#L3343)

## 验证范围与证据归属

| 本轮独立执行 | 结果 |
|---|---|
| 区间内全部 14 个变更的 Node 测试文件，`node --test --test-concurrency=2` | **334/334**，0 失败、0 跳过。另跑选择钩子源与二进制一致性用例 **1/1**，build-id 同为 `hl_ed63a2cc7abaa935d45e58ba1f8481df264b4e33e6754d037a2a2c76a44dec63`。 |
| `cargo test --locked --manifest-path native/everything-search/Cargo.toml` | **23/23**，0 失败。 |
| `npm run check`、`npm run test:long-capture` | 两者退出码均为 0。静态检查覆盖 634 个 JS 文件；长图命令输出 `long capture tests passed`，未逐例报告计数。 |
| 副屏和编码探针 | 屏幕差分用 `--frames 3`，六个 verdict 均为 true，包含 `productionEntryProven`；焦点探针退出码 0；真实 FFmpeg 探针 **19/19**，第 300 个胶囊的 29.9 秒尾帧亮度为 69.48。 |
| 本轮补测 | 录制与屏幕拓扑使用生产域和仓库夹具；Everything 使用真实 JS 服务、可控侧车响应；焦点失败分支采用源码和重建原生件的策略自测；竖排字形与 OCR 断管分别使用真实 Electron 渲染、真实 Windows 管道。各结论的输入和观察值见上文。 |
| Git 和 CI | 评审开始时工作树干净。直接查询远端分支为 `b84eeba05f66b51f68a4894f0b7aecc92efb6fad`，按完整 HEAD 查询 GitHub Actions 返回空列表。 |

全量 `npm test` 3430/3430、E2E 21/21，以及 loaded 93.51%、OCR 服务 96%、critical 93.76% 来自开发交付记录，本轮未重复执行这些门禁。V01–V10、R01–R03、硬件键盘、真实模型断管、物理拔插、Everything 1.4/1.5 双实例及签名安装升级仍待同一候选包验证。提交中的 Everything 侧车已更新，选择钩子 build-id 对照针对本机加载的构建件。[开发门禁](../plans/2026-11-28-d7923ac-review-fix-record.md#L181) · [候选验收清单](../plans/2026-11-28-d7923ac-review-fix-record.md#L239)
