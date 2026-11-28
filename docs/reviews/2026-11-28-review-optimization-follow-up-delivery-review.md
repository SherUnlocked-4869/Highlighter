# 5.1.x 评审优化后续开发交付复核

**评审结论 · 建议重开 7 张工单，先修复 4 个 P1，再让新候选进入真机验收。** 本次共发现 11 个问题。用户按 Enter 确认重标注会丢失矢量，正式贴图入口无法取得桌面差分首帧，录屏无法兑现密码框排除承诺，OCR 管道超时后还会继续写入失效进程。现有定向测试可以全部通过，同时遗漏这四条路径。

评审日期为 2026-11-28。审阅范围为 Windows Electron 分支 `feat/review-optimization-2026-11-26` 的 `bae6264..b84eeba`，共 19 个提交、77 个变更文件。远端 HEAD 为 `b84eeba05f66b51f68a4894f0b7aecc92efb6fad`。本文记录该提交上的发现与修复验收条件。原始口径见[开发任务](../plans/2026-11-28-review-optimization-follow-up-tasks.md)、[开发执行记录](../plans/2026-11-28-follow-up-execution-status.md)和[真机与发布验收台账](../plans/2026-11-28-follow-up-acceptance-status.md)。

| 建议重开的工单 | 需要关闭的问题 |
|---|---|
| DEV-01 贴图矢量重标注 | P1-03 确认入口丢失编辑快照 |
| DEV-02 离屏导出当前视图 | P2-02 长图滚动偏移、P2-04 OCR 竖排与译文换行 |
| DEV-04 跨应用快捷键采集 | P1-02 敏感焦点、P2-01 单次录制开关、P2-06 连续按键误去重 |
| DEV-05 导出快捷键覆盖层 | P2-05 成片缺少预览中可见的事件 |
| DEV-06 OCR 二进制帧 | P1-04 超时后的管道回收 |
| DEV-07 Everything 目标缓存 | P2-07 无响应实例无法被替换 |
| DEV-08 真实像素差分 | P1-01 生产采集入口、P2-03 显示器身份匹配；差分视图也受 P2-02 影响 |

## P1 · 候选验收前修复

### P1-01 · DEV-08 正式入口无法取得第一帧

`main.js` 创建贴图域时没有注入 `screenDiffDesktopCapturer`。默认分支返回一个函数，下一行却把它当作采集器对象调用。评审按生产默认依赖调用 `captureScreenUnderPin`，返回 `CAPTURE_THREW`，错误为 `capturer.getSources is not a function`。用户开启模式后连续三次失败就会退出。交付报告的 30 帧测量直接调用了 Electron 的采集器，单元测试也注入了采集器，两者均绕开了出错的接线。[生产入口](../../main/domains/pin/index.js#L1166) · [独立探针](../../scripts/probe-pin-screen-diff.js#L116)

**修复验收。** 默认分支应解析出实际采集器。增加不注入测试采集器的接线回归，再从候选包贴图菜单开启模式，确认收到第一帧、连续更新并能手动关闭。

### P1-02 · DEV-04 密码框和未知焦点中的组合键仍可被记录

原生 `key-combo` 载荷只有时间、键码、扫描码、修饰键和组合标签。JS 只对部分裸键检查安全焦点，无法据此区分演示页面与密码框。评审传入与原生契约一致、没有焦点字段的 `Ctrl+V`，过滤器返回 `ok: true`。现有密码框测试手工补入 `context: 'password'`。风险是敏感输入场景的**快捷键标签**进入事件轨；本次验证没有采集密码内容。[原生事件包装](../../vendor/selection-hook/index.js#L198) · [隐私过滤器](../../main/domains/record/keystroke-capture.js#L157) · [现有测试](../../test/n03-global-keystrokes.test.js#L94)

**修复验收。** 在采集边界取得可信的焦点分类，敏感或无法判断时丢弃事件。用实际生产载荷验证允许的演示场景一次按键只生成一条记录；在输入框、密码框、IME 组字和未知焦点下，IPC 与 `events.json` 中新增快捷键均为 0。真实硬件键盘矩阵仍须单独执行。

### P1-03 · DEV-01 按 Enter 确认重标注会拍平矢量

Enter、复制按钮以及启用后的双击走 `copy`。编辑已有贴图时，该动作会把图像提交回原窗口，但只有 `pin` 和 `pin-copy` 构造新编辑快照。主进程替换显示图时随即释放旧快照。在无头 Chromium 的实际编辑器中，用含一个矩形的同一份输入对照，Enter 提交的 `editable` 为 `false`，贴图按钮提交的快照仍有 1 个标注。首次确认的 PNG 外观可以完全相同，到下一次重标注才发现旧矩形无法选取。[截图侧提交](../../capture/capture.js#L5203) · [主进程替换快照](../../main/domains/pin/index.js#L2862)

**修复验收。** 让所有更新原贴图的确认入口共用快照构造逻辑，保留既有隐私、容量和位图降级条件。分别用 Enter、复制按钮、双击及贴图按钮完成“编辑→确认→再次打开”，断言旧矩形仍可选择、移动和删除。

### P1-04 · DEV-06 帧写入超时后仍向失效管道发送请求

请求超时后会从 `pending` 删除。若对应帧稍后才报告写入错误，错误回调因找不到该 ID 提前返回，跳过 `discardProcess`。在模拟侧车停止读取的用例中，两个请求均已超时；第一帧随后报告写入失败，第二帧仍被写出，旧进程保持 `ready`，`kill` 次数为 0。此时下一张图可能继续进入一条帧边界已不可信的管道。[帧写入队列](../../main/services/ocr-service.js#L391) · [迟到的写错误](../../main/services/ocr-service.js#L439)

**修复验收。** 区分等待识别结果超时和帧写入未完成。写入失败应按子进程代际回收管道、取消该代排队帧，并防止旧回调影响新进程。复跑上述时序，断言第二帧没有写入旧管道，下一次识别在新握手成功后完成。

## P2 · 用户可见行为与异常恢复

| 编号 / 工单 | 触发、影响与依据 | 修复验收 |
|---|---|---|
| P2-01 · DEV-04 | **“仅本次录制”会延续到下一次。** 启动成功后工作台只轮询状态，保留 `demoKeystrokes`。停留在同一工作台再次开录时，下一次请求仍开启全局快捷键采集；现有测试明确断言了这个行为。[启动成功分支](../../config/routes/recording.js#L1393) · [连续启动测试](../../test/recording-workbench-ui.test.js#L1140) | 实际新建录制成功后复位一次性开关。录制 A 开启、结束、在同页启动 B，B 应默认关闭；启动失败时保留用户刚才的选择。 |
| P2-02 · DEV-02 / DEV-08 | **长贴图滚动后仍导出顶部。** 无头 Chromium 加载仓库的 `pin.html` 和 CSS 后，实际滚动元素 `body.scrollTop` 为 600 px，而导出读取的 `document.scrollingElement` 是 HTML，偏移为 0。差分视图同样读错元素。[视图导出](../../pin/pin.js#L274) · [差分视图](../../pin/pin.js#L579) | 两处共用实际可见图像矩形。以颜色分段的长图分别导出顶部、中段和底部，核对输出首行像素与视口一致。 |
| P2-03 · DEV-08 | **副屏来源缺失时可能取到主屏像素。** `pickScreenSource` 在目标 ID 缺失时返回第一个有像素的来源，调用方继续使用目标屏坐标裁剪。副屏暂时不可用、主屏仍在线即可选错来源，现有测试还接受该回退。[来源选择](../../pin/pin-screen-diff.js#L271) · [既有回退断言](../../test/n05-pin-screen-diff.test.js#L519) | 多屏场景只有在显示器身份可确认时才交付帧。模拟副屏消失或 ID 缺失，断言主屏像素没有传给该贴图；目标屏恢复后再续采。 |
| P2-04 · DEV-02 | **竖排 OCR 和多行译文导出后变成单行。** 可见叠层支持 `vertical-rl` 与自动换行，离屏画布却把整块文本缩小后一次 `fillText`。相同文本的方向、行数和字号会改变。[可见叠层样式](../../pin/pin.css#L38) · [离屏文字绘制](../../pin/pin-view-export.js#L328) | 让可见层与导出层共享排版结果。用竖排中文、窄框长译文逐块比对阅读方向、换行与文字边界。 |
| P2-05 · DEV-05 | **成片少于预览中的快捷键。** 编辑器接受 500 个事件，导出另限 240 个显示区间、64 种标签。评审输入 300 次同一快捷键，导出计划只保留 240 次；截断状态没有呈现给用户。[预览上限](../../record/trim-controller.js#L104) · [导出截断](../../shared/recording-export-options.js#L544) | 预览和导出使用同一可见序列；若保留导出限制，在确认前显示实际截断范围。用 300 个重复标签事件及超过 64 种标签的素材检查成片尾段。 |
| P2-06 · DEV-04 | **连续按同一快捷键被误去重。** 合并时丢掉来源，再按标签和 120 ms 窗口去重。只给控制条来源传两次间隔 90 ms 的 `Ctrl+Z`，结果只剩一次，演示轨少了一次撤销。[事件合并](../../main/domains/record/index.js#L299) | 保留来源信息，只配对控制条与全局钩子对同一次按键的上报。回归分别断言“同来源两次→两条”和“双来源同一次→一条”。 |
| P2-07 · DEV-07 | **状态轮询可一直黏在无响应实例上。** `refresh_status` 把 `send-failed` 作为正常状态返回，并把其他探测错误的结果数置 0。旧 HWND 仍存在时，缓存收不到通信失败信号；即使另一个 Everything 实例已就绪，`wait-ready` 也可能等到超时。此项依据状态与缓存调用链判定。[状态探测](../../native/everything-search/src/main.rs#L831) | 保留对仍在运行实例的状态展示，同时让通信失败触发有界的重新选择。用“旧 HWND 存活但不响应、新实例可用”复验切换，并保持正常热轮询只解析一次。 |

## 交付证据核查

| 项目 | 核查结果与应采用的交付口径 |
|---|---|
| 远端与 Windows CI | 远端分支确有 19 个提交。run `46104498694` 对应 `b40c96a`，run `46106195872` 对应 `25ee84c`；两次的 `Check and test` 和 `Build hardened unsigned candidate` 均成功。按 `b84eeba` 查询无对应 Windows CI run。`25ee84c..b84eeba` 仅修改执行记录，可表述为“相同产品代码已通过 CI”。[第一次成功运行](https://github.com/SherUnlocked-4869/Highlighter/actions/runs/46104498694) · [第二次成功运行](https://github.com/SherUnlocked-4869/Highlighter/actions/runs/46106195872) |
| 全量、coverage 与 E01 | 开发执行记录登记本机 `npm test` 为 3353/3353、E2E 为 21/21。默认并发 coverage 的 loaded 步骤三次因 clipboard lease 失败，轮次为 1、42、2；独跑两次通过，串行 loaded 为 93.47%，CI 默认流程通过。独立 perf 步骤在 CI 也通过，summary、daily、breakdown p95 分别为 57.26、100.76、161.22 ms。现有 `npm test` 仍会并发执行这些计时断言，因此 E01 已提供独立测量，前一步仍可能因负载变红。[本机验证记录](../plans/2026-11-28-follow-up-execution-status.md#L113) · [Windows 工作流](../../.github/workflows/windows-ci.yml#L52) |
| E02 IPC 范围 | 渲染层到主进程复用了原有通道。另增加四个主进程到贴图渲染层的事件：`pin:view-export-request`、`pin:onion-command`、`pin:onion-mode`、`pin:screen-diff-frame`。交付说明应写清通信方向。[贴图 preload](../../preload-pin.js#L215) |
| 候选与正式发布 | CI 校验了 5.1.1 的 NSIS 和 portable，`verify:package` 输出 `signed:false`。V01–V10 的完整候选真机步骤、R01 签名与 `verify:release`、R02 隔离安装/升级/卸载、R03 正式硬件矩阵仍待执行。DEV-03、DEV-08 的局部测量保留其样本与适用范围。[候选构建](https://github.com/SherUnlocked-4869/Highlighter/actions/runs/46104498694) · [R01 候选证据](../plans/2026-11-28-follow-up-acceptance-status.md#L92) |

## 复核方法与下一候选的验收顺序

评审复跑以下三个定向测试文件，共 **43/43 通过，0 跳过**。另使用实际截图编辑器和贴图样式做无头 Chromium 对照，调用生产模块核验默认依赖、快捷键过滤与事件数量，并以可控的侧车写入故障核验 OCR 超时顺序。本文引用的全量、签名与硬件状态分别以执行记录和候选台账为准。

```powershell
node --test test/n03-global-keystrokes.test.js test/n05-pin-screen-diff.test.js test/u02-pin-view-export.test.js
```

1. **先关闭四个 P1。** 在修复提交上保留各自曾经失败的入口级回归，重点复查桌面差分首帧、敏感焦点零事件、Enter 保存后第二次重编，以及 OCR 故障后的新进程握手。
2. **按功能复验 P2。** 贴图用同一组长图、竖排文字和双屏语料；录屏用同一份原始按键轨对照采集、预览和成片；Everything 用可切换的双实例。逐项回填修复 SHA、输入样本、结果和剩余设备条件。
3. **用修复后的实际候选执行 V/R。** 将目标提交、包哈希、CI run 和签名状态绑定到同一份验收记录，再开展隔离安装与硬件矩阵。未具备的设备继续列为待验。
