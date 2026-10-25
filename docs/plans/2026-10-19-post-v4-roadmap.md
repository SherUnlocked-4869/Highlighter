# Highlighter 4.0.0 之后：剩余开发任务梳理（承接 Snow Shot v1.3.2 迁移）

- 日期：2026-10-19（Asia/Hong_Kong）
- 性质：**只做梳理，不含开发**。本文是 `docs/plans/2026-10-18-snow-apps-update-migration-analysis.md` §19 实施记录之后的排期底稿
- 基线：`master @ a0cdbc2`（"feat: migrate Snow Shot v1.3.2 capabilities and release 4.0.0"），`package.json` **4.0.0**
- 上游参照：`F:\workspace\snow-apps` @ `881132435`（`v1.3.2` 后 1 个纯许可提交）
- 读数口径：2026-10-19 实测，命令见 §8

> **给读者的第一句话**：§19 的 7 项 P0 确实全部落地，`npm test` 1156/1156 全绿，但仓库**还没打 `v4.0.0` tag**、README 停在 2.5.0 前的口径、合规地基仍是零。本文按"收口 → 功能 → 探路"三段排序，并单列一个**已实测确认的 P0 缺陷**（§2）。

---

## 0. 一页摘要

| 组 | 内容 | 人日 | 状态 |
|---|---|---:|---|
| **A 收口 + 技术债** | 真机验收、音轨失败可见化、tag/验收记录、README、补测、Electron 升级、文档回填 | **6.8–9.3** | 未开始 |
| **B 已规划功能** | 合规地基、选区成品感、录屏体验/格式、选区与快捷键、外壳集成、导出续作 | **48–59** | 未开始 |
| **C 探路与战略** | Collage MVP、长截图切分、BMP 探针、标注工具、MCP、贴纸续作 | **85.5–106.5** | 未开始 |
| **D 明确不做** | 8 类，见 §6 | — | — |
| **合计（A+B+C）** | | **约 140–175** | — |
| **其中已确认缺陷** | 录屏系统音轨在本机恒定失败且**用户无可见提示** | 见 §2 | **P0** |

> 与迁移分析 §14.1 的口径差异：那份说"剩余 ≈113–143 人日"，本文算出 140–175。差值来自五处修正：① 新增 A0 真机验收 + A6 音轨失败可见化（2.5–3d，原分析没有）；② 选区历史 +1d（history schema 不存 bounds）；③ `main.js` 行数不再是批 8 硬阻塞，但 A 组新增 4 项；④ B7"导出续作"是原批次表漏列的 6d；⑤ C5 标注小件 + C8 贴纸续作此前未单列（合计 30.5d）。

---

## 1. 三处必须先纠正的文档/代码不一致

这三条会误导后续接手人，建议随本文件一并修正。

| # | 文档说法 | 实测 | 影响 |
|---|---|---|---|
| 1 | §3.2 称"历史库**已存** `meta.selectionBounds`" | **不存**。`capture/capture.js:2480` 确实把 `selectionBounds` 塞进 meta，但 `main/services/history-service.js:302-311` 落库只留 `{id,filePath,thumbnailPath,createdAt,source,action,width,height}`，该字段被静默丢弃 | "选区历史浏览"成本 4–6d → **5–7d**（需 history schema v2 + 旧记录兼容） |
| 2 | §19.10 记"单测 1128 项 / 18 失败 / **新增测试文件 0**" | 实测 **1156 项 / 1156 通过 / 0 失败**；`d9ad364..a0cdbc2` 新增 **3 个**测试文件（`capture-toolbar-regressions` / `pdf-export-multipage` / `table-workbook`） | 该表是开发中途快照，**不能当验收基线引用** |
| 3 | §19.6 称批 8 前置是"`main.js` 腾挪（6 行仍不够装 `shell-integration`）" | 6 行**够**。`tray-icon.js` 已经证明"一个 require + 一句调用"（2–3 行）可行；`second-instance` 读 argv 是改既有行，不新增 | 批 8 从"硬阻塞"降为"**可直接排期**"，只需再挤 2–3 行保险 |

另：§19.12 建议补的 3 处单测只完成 2 处——**mixed-selection 写回默认值仍无测试**（`test/capture-toolbar-regressions.test.js` 唯一的选择态测试只选 1 个元素）。

---

## 2. 【P0 缺陷】录屏系统音轨恒定失败，且用户看不到任何提示

> 这条不在迁移分析的待办里——它是**已发布功能在真实设备上的失效**，独立于 Snow 迁移。2026-10-19 实测确认。

### 2.1 现象

用户在 4.0.0 上录制屏幕，**系统声音没有被录进去，保存的 MP4 没有音轨**，录制过程中也没有任何警告。

### 2.2 根因（实测，非推测）

隐藏窗口探针（`show:false`，不占前台）逐项复现了 `record/record.js` 的采集链，结果如下：

| 尝试 | 结果 |
|---|---|
| `enumerateDevices()` | 正常，枚举到 3 个 `audioinput` + 7 个 `audiooutput` |
| `getUserMedia({audio:true})`（麦克风） | ✅ **成功**，48 kHz 单声道，`readyState=live` |
| `getDisplayMedia({video,audio:true})` + handler 回 `audio:'loopback'` | ❌ `Could not start audio source` |
| 同上，`audio:'loopbackWithMute'` | ❌ `Could not start audio source` |
| 同上，`video:false`（纯音频） | ❌ `Could not start audio source` |
| 同上，裸 `video:true` constraint | ❌ `Could not start audio source` |
| 遗留 `getUserMedia({mandatory:{chromeMediaSource:'desktop'}}, audio)` | ❌ `Could not start audio source` |
| handler 回 `audio: undefined`（对照组） | ✅ 视频 1 轨 / 音频 0 轨（证明 handler 本身工作正常） |
| 加 `--disable-audio-service-sandbox`、`--disable-features=AudioServiceOutOfProcess`、两者同时 | ❌ 四种组合无一改变错误 |

**结论**：麦克风链路健康，所以音频子系统没坏；**Chromium 的 WASAPI loopback 采集在这台机器上初始化失败**，且与音频服务沙箱无关。这不是"音轨没混进去"的下游问题，是**上游拿不到设备**。

旁证：`Audiosrv` / `AudioEndpointBuilder` 均为 Running；本机有 5 个声卡设备、多个活动 render endpoint，默认输出是蓝牙耳机（MCHOSE K20 GT）。上游同类报错见 [electron#42765](https://github.com/electron/electron/issues/42765) 与 [electron#42605](https://github.com/electron/electron/issues/42605)——两者都停在同一个 `Could not start audio source`，且后者明确记录 Chromium 的 `MacLoopbackAudioForScreenShare` 思路在 Windows 侧不适用。

### 2.3 代码侧真实缺陷（**与环境无关，必须修**）

环境是原因之一，但**应用把失败吞掉了**，这才是 P0 的实质：

1. `record/record.js:365-377` — `getDisplayMedia({audio:true})` 失败后**静默重试** `audio:false`，两次都失败才抛错。用户只看到"录制正常开始"。
2. `record/record.js:456-500` `attachAudioTracks()` 在 `audioMix.active === false` 时把 `captured` 置为 `{system:false,microphone:false}`，走 `applyAudioOutcome(...)` → 应设置 `record.audio.notice.*` 提示。
3. **但提示实际不可见**：`record/record.js:174-192` 的 `renderStatus()` 只在 `STATUS_LABELS[state]` 存在时才渲染，而 `countdown` 状态在 `STATUS_LABELS` 里**没有音频提示的落点**——倒计时 3 秒是用户唯一能看到状态的窗口，此时提示被静默丢弃。
4. `record/record.js:320-345`（主进程 `main/domains/record/index.js:345`）转码时用 `{ audio: !!(settings.record.audioSystem || settings.record.audioMicrophone) }` 判断是否 `-map 0:a?`——**这是"设置意图"而非"实际捕获结果"**。渲染层知道真相却从未上报，主进程只能猜。`preload-record.js:19` 的 `saveMp4(sessionId, durationMs)` 签名里没有任何音频状态。

### 2.4 建议修法（分两层，可独立交付）

**第一层：让失败可见（约 1.0 人日，必须做）**

- `preload-record.js` / `record:save-mp4` 增加 `audioCaptured: {system, microphone}` 入参，渲染层把 `audioOutcome` 传下去；
- 主进程据此决定 `transcode(..., {audio})`，而不是看设置；
- 预览页在"保存 MP4"旁显示一行"本次录制无音轨"，**不要**只在 `statusLabel` 里。
- 补一条契约测试钉死"设置开但采集失败 → 不 `-map 0:a`"。

**第二层：真正拿到系统声（按所选方案 0.5–5 人日，需先定方向）**

| 方案 | 做法 | 成本 | 风险 |
|---|---|---:|---|
| **A. 升级 Electron 并复核** | 当前 43.2.0；上游 43.4.0/44 修过 `restrictOwnAudio` 相关 loopback 行为。先升到最新 43.x 再跑同一探针 | 1–2d | 可能**不解决**（本机失败点在设备初始化，不在 `restrictOwnAudio`） |
| **B. 探测 + 引导** | 录制前用 Web Audio 探测默认 render endpoint 是否可打开；失败时引导用户切默认输出设备 / 关独占模式 / 检查蓝牙耳机 | 1.5d | 治不了根，但把"静默失败"变成"可自救" |
| **C. ffmpeg WASAPI loopback** | `ffmpeg-static` 已带 `dshow` 与 WASAPI；改用 `-f dshow -i audio="virtual-audio-capturer"` 或 `-f wasapi` 旁路采集，再与 canvas 流二次封装 | 3–5d | 需虚拟声卡驱动（不可随包分发，安装器复杂度上升）；且与"画布→MediaRecorder"链路的 A/V 同步要重做 |
| **D. 明确降级** | 把"录制系统声音"标为环境相关能力，设置页给出一句说明 + 一键自检 | 0.5d | 最诚实，但用户诉求未满足 |

**建议顺序**：先做第一层（无论如何都要做）→ 再做 A（顺手，与 A 组 Electron 升级合并）→ 若 A 无效，用 B 兜底并单独立项 C。

> ⚠️ **不要**把本项当成"迁移分析的批 5（trim/GIF）+ 音轨图标"的一部分——那是**新增功能**，本条是**已发布功能失效**。

### 2.5 顺带暴露的验收漏洞

`docs/releases/2026-10-12-v2.5.0-build-acceptance.md:91` 白纸黑字写着：

> **仍未执行**：……**实机功能验收**（批次 A 8 项 · 批次 B **音轨四组合**/光标 100%·125%/标注编辑 · 批次 C 三语言切换）

即音轨从 2.5.0 交付至今**从未做过真机验收**，本缺陷被"单测绿 + 构建绿"掩盖了 7 天。→ 见 §3 A0：**真机验收清单必须进 A 组**，不能继续挂在"待用户主持"上。

---

## 3. A 组：4.0.0 收口 + 技术债（建议立刻做）

| # | 任务 | 人日 | 说明 | 依据 |
|---|---|---:|---|---|
| **A0** | **真机功能验收（P0，先做）** | 1.5–2 | 按 §2 的教训，把"音轨四组合 / 光标 100%·125% / 标注编辑 / 三语言 / 多屏拔插"逐项跑一遍并留证据；本次音轨缺陷就是漏了这一步 | v2.5.0 验收记录 §4 |
| **A1** | 打 `v4.0.0` tag + 写 `docs/releases/2026-10-19-v4.0.0-build-acceptance.md` | 0.5 | 产物已在 `dist/`，`verify-release` 通过但 `signed:false`；照 v2.5.0 那份结构写 | 实测 |
| **A2** | README 全面过期修正 | 0.5 | 现写"**录制不包含音轨**"（2.5.0 已发音频）；表格识别只提 TSV/CSV/Markdown 未提 `.xlsx`；4.0.0 的多页 PDF / 贴纸旋转 / 托盘主题图标 / 图片转文档 / Ctrl+A 二级**全部未进 README** | `README.md:24,33` |
| **A3** | 补 4.0.0 测试债 | 2–3 | ① `clampPinBoundsToWorkArea`/`boundsIntersectWorkArea` 零测试；② `tray-icon.js` 零测试；③ `ai-image-conversion.js`/`ai-document.js` 零测试；④ mixed-selection 写回默认值无测试；⑤ `exportSelectionRect()` 并集投影路径无测试 | 实测 grep |
| **A4** | Electron 升级 | 1–2 | 43.2.0 → 43.5+ / 44.x。**同时是 §2.4 方案 A**：豁免清单里有一条"无 workaround、需 43.5.0+"的 advisory，且与音轨可能是同一批修复 | `scripts/audit-dependencies.js:41` |
| **A5** | 修正本文 §1 三处过期读数 | 0.3 | 回填迁移分析 §3.2 / §19.10 / §19.6 | §1 |
| **A6** | **音轨失败可见化（P0，见 §2.4 第一层）** | 1.0 | 渲染层上报 `audioOutcome` → 主进程按**实际捕获结果**决定 `-map 0:a?`；预览页显示"本次录制无音轨"；补"设置开但采集失败 → 不加音轨"的契约测试 | §2.3 |

**A 组合计 6.8–9.3 人日。** 其中 **A0 + A6 是 P0，合计约 2.5–3d，必须先做**——它们修的是"已发布功能静默失效 + 从未真机验收"。

---

## 4. B 组：已规划但未做的功能批次

> 成本已按本次实测修正，括号内为迁移分析的原始估算。

### B1 合规地基（原批 0）— **3–5 人日 · 需先拍板 B5**

| 项 | 状态 |
|---|---|
| `LICENSE` / `COPYRIGHT` / `package.json` license / `THIRD_PARTY_NOTICES.md` | ❌ 全部不存在（实测） |
| 打包白名单 | ❌ `build.files` 30 项里无任何 `LICEN*`/`THIRD*`/`NOTICE*`；`dist/win-unpacked` 只有 Electron 自带的两个许可文件 |
| 已分发 copyleft 依赖 | `ffmpeg-static` = **GPL-3.0-or-later**；`@img/sharp-win32-x64` = **Apache-2.0 AND LGPL-3.0-or-later** |
| About 页 Appropriate Legal Notices（GPLv3 §5(d)） | ❌ |
| 源码提供义务（§6） | ❌ |

**这是当前唯一"已侵权分发而不自知"的缺口**，且与要不要移植 Snow 无关——它从 2026-10-10 起就存在。`docs/third-party/` 目前只有 Index-Translate 一份（Apache-2.0），**不含** ffmpeg / sharp。

> **B5 是硬分叉**：`GPL-3.0-only` vs `-or-later`。命中 Snow 那 79 个 `-only` 文件就必须 `-only`；只借鉴设计则可 `or-later`。它同时决定 C6（MCP）能不能启动。

### B2 选区成品感（原批 3 剩余）— **10–14 人日**

圆角 / 阴影 / 背景不透明度。迁移分析 §3.3 已把契约点列清，改造面收敛在 `capture/capture.js:2290 exportSelectionCanvas()` 一个函数。

**三个必须同步的契约点**：`selectionBounds` meta、PDF 导出的 `pxW/pxH`、剪贴板图片尺寸。

> 迁移分析 §16 P3"PNG 导出链路是否保留 alpha"**仍未验证**——这是本项的前置探针（0.5d）。

### B3 录屏体验（原批 5）— **7–8 人日**

trim 剪辑 + 9 档变速 + 音轨图标 + 增益滑杆。

- `record/recording-utils.js:232-246` 硬编码 `libx264 -crf 23`，无 trim/变速参数；
- `record/record.html:80` 只有 "Save MP4"，无格式/速度入口；
- `record/audio-mixer.js` 的 gain **设置键存在但无 UI**（`audioSystemGain`/`audioMicrophoneGain` 在 `settings.js:297-298` 只渲染开关，不渲染滑杆）。

比原估算低 1d：`record.captureCursor` 已按删除处理，不用接线。

### B4 录屏格式（原批 6）— **6 人日 · 依赖 B3**

GIF / APNG / WebP + 稀疏帧瘦身。V1 已实测 `ffmpeg-static` 编码器与滤镜齐备。

### B5 选区与快捷键（原批 7）— **9.5–13.5 人日**

| 子项 | 人日 | 备注 |
|---|---:|---|
| 选区历史浏览 | **5–7**（原 4–6） | **依赖先扩 history schema**（见 §1 第 1 条） |
| 窗口内快捷键 | 3–5 | 要动 `capture/capture.js:2611` 的硬编码 `if` 链，且必须保住"方向键不被 Ctrl 组合吞掉"的既有契约 |
| 居中滚轮缩放选区 | 1.5 | 独立 |

### B6 外壳集成（原批 8）— **6.5 人日 · 行数阻塞已解除**

资源管理器右键菜单（3.0）+ `--edit-with-highlighter`（1.0）+ 菜单开关/卸载清理（1.0）+ 安装器关 sidecar（1.5）。

三个必须照抄的设计：`ProductId` 认领归属、写前 snapshot/失败回滚、卸载清理进 NSIS `un.onUninstall`。

> `main.js` 现 1324/1330（余 6 行），够装；建议仍先腾 2–3 行保险。

### B7 导出续作 — **6.0 人日 · 原批次表漏列**

| 子项 | 人日 | 现状 |
|---|---:|---|
| 原地翻译导出（译文绘回原图） | 1.5 | 无 |
| PDF 纸张/方向/边距 | 2.0 | `PAGE_MODES` 只有 `a4`/`original`（`pdf-export.js:69`）且**无 UI 入口**；调用点硬编码 `mode:'a4'`（`capture.js:2494`、`history-ipc.js:92`） |
| 时间变量自定义日期格式 | 1.5 | `TEMPLATE_VARIABLES` 只有 `app/date/time/datetime` 四个固定 token（`capture-naming.js:28`） |
| 目录路径也支持变量 | 1.0 | 无 |

**B 组合计 48–59 人日。**

---

## 5. C 组：探路与战略项

| 组 | 内容 | 人日 | 依赖 / 判据 |
|---|---|---:|---|
| **C1** Collage MVP（原批 10） | 历史多选 → 拼接 → 导出 PNG | 3.0 | **带 3% 点击率判据**：上线一版后看历史多选使用率与拼接点击率，>3% 再投 +9d |
| **C2** 长截图切分导出 | 按张数/按高度 `sharp().extract()` 分段 | 1.5 | 替代 Image Split，覆盖其 80% 用途 |
| **C3** BMP 探针 | `nativeImage.createFromPath('*.bmp')` 是否可用 | 0.5 | 定论即可 |
| **C4** 标注工具（逐个立项） | 放大镜 8–10（优先）/ 压感画笔 10–12（优先）/ 角度 8–12 / 聚光灯 8–12 / 气泡最小版 8–10 | **40–56** | 无 |
| **C5** 标注小件 | 元素旋转 8–10 / Alt+拖复制 1.5–2 / 对齐分布 3–4 / 多选整体拖动 2–3 / 序号样式扩展 2–3 | **17–22** | 多选整体拖动被 `capture-annotation-geometry.test.js:709` 的 pendingMove 契约钉死，扩形态风险 > 收益 |
| **C6** MCP 服务端（原批 11） | 自研 Node 版 12 工具闭环 | **10** | **B1 必须先完成**；首版用配置文件开关、不做设置页 UI |
| **C7** 长截图自动滚动 | 间隔可配 128–1000ms | 待评估（**高危**） | `native/scroll-driver` 有回滚史；建议先只做"应用内可滚区域"验证 |
| **C8** 贴纸续作 | 关闭行为配置 2.0 / 双击-中键行为可配 1.5 / 动画贴纸 5.0 / 文本贴纸 5.0 | **13.5** | 动画与文本贴纸**都卡在"贴纸无持久化"**（`pinWindows` 是内存 Set，`main/domains/pin/index.js:43`） |

**C 组合计 85.5–106.5 人日。**

---

## 6. D 组：明确不做（不再讨论，避免反复消耗）

| 项 | 理由 |
|---|---|
| Collage 完整编辑器 | 11.7k 行产品线，触达要用户走 4 步；先做 C1 探路 |
| Image Split 完整编辑器 | ≥10 人日换极低频场景；C2 覆盖 80% 用途 |
| 任意形状选区 | 15–20d，与截图效率工具定位偏离 |
| 跨显示器统一画布 | 12–18d，底座改造 |
| 工具行布局可拖动定制 | 会废掉 42 项图标序列契约测试；改做"···更多"溢出面板（方案 3b） |
| OCR 运行时重写 | 架构同型，用户不可感知 |
| Qt/Rust 级性能工程 | 量级差两个数量级 |
| macOS / ARM64 / vcpkg / 双版本 | 平台不覆盖 |
| MCP 101 工具全量对齐 | 只需 12 工具闭环 |

---

## 7. 建议排期（三个版本候选）

| 波次 | 内容 | 人日 | 理由 |
|---|---|---:|---|
| **第 1 波：止血** | **A0 真机验收** + **A6 音轨失败可见化** + A1 tag/验收记录 + A2 README + A5 文档回填 | **3.8–4.3** | 先把"已发布但静默失效"的功能交代清楚；这波不产出新功能，但它是后面所有发布的前提 |
| **第 2 波：把账算清** | A3 补测 + A4 Electron 升级（含 §2.4 方案 A） + **B1 合规地基** | **6–10** | 合规是法律前置；A4 可能顺带修好音轨根因 |
| **第 3 波：用户可感知** | **二选一**：B2 选区成品感（10–14） **或** B3+B4 录屏（13–14） | 10–14 | 受众不同：B2 打"出图质量"，B3/B4 打"演示录制"。**需要你拍板** |
| **第 4 波：体验补全** | B6 外壳 + B7 导出续作 + B5 快捷键部分 | 15.5–17.5 | 都是"每天撞上一次"的补全，互相独立、可并行分给不同人 |
| **待定** | C1/C2/C3 探路（5d）看 3% 判据；C4/C5 逐个立项；C6 MCP（需 B1 先行） | — | 探路项建议**随时插空**做 |

> 前四波合计 **35.3–45.8 人日**，是"值得排到 v4.2 之前"的范围；C 组 85.5–106.5d 属"有预算再逐个立项"。
> 注：第 2 波的 A4（Electron 升级）与 §2.4 方案 A 是**同一件事**，只计一次。

---

## 8. 需要拍板的 5 个点

1. **§2 录屏音轨走哪条路？** 第一层（失败可见）必须先做；第二层 A/B/C/D 四选一。
2. **要不要现在打 `v4.0.0` tag 并补验收记录？** 产物已在 `dist/` 且 unsigned 通过 verify；tag 一打会触发 CI。
3. **B1 的 B5：`GPL-3.0-only` 还是 `-or-later`？** 它同时决定 C6（MCP）能不能启动。
4. **第 3 波做"选区成品感"还是"录屏体验"？** 成本接近、受众不同。
5. **Collage MVP 要不要探路？** 3 人日 + 明确 3% 判据。

---

## 9. 本次实测命令（可复现）

```bash
cd F:/workspace/Highlighter

# ── 基线 ────────────────────────────────────────
node scripts/check-architecture.js      # ok (main.js 1324 / ceiling 1330, domains 10)
node scripts/check-i18n.js --max 606    # TOTAL 585（余 21）；locale 1169 × 3，对称差 0
node scripts/check-js.js                # 343 文件通过
node scripts/check-version.js           # 4.0.0
env -u ELECTRON_RUN_AS_NODE node --test test/*.test.js   # 1156 / 1156 pass / 0 fail
env -u ELECTRON_RUN_AS_NODE npx c8 --check-coverage --lines 85 ...   # loaded 90.73%
node scripts/audit-dependencies.js      # 26 豁免 / 0 未豁免；复核日 2026-11-30
pwsh -NoProfile -File scripts/verify-release.ps1        # 通过，signed:false

# ── 合规 ────────────────────────────────────────
ls LICENSE* COPYRIGHT* THIRD_PARTY_NOTICES.md 2>/dev/null   # 全不存在
node -e "console.log('license' in require('./package.json'))"   # false

# ── 4.0.0 功能有无 ──────────────────────────────
grep -rniE "cornerRadius|shadowWidth|backgroundOpacity" capture/ main/    # 选区成品感：零命中
grep -rniE "collage|imagesplit" main/ config/ capture/ record/            # 零命中
grep -rni "modelcontextprotocol\|mcp" --include=*.js main/ package.json   # 零命中
grep -rn "HKCU\|SystemFileAssociations" --include=*.js .                  # 零命中
grep -rn "atempo\|palettegen\|apng" --include=*.js record/ main/          # 录屏 trim/GIF：零命中
grep -rn "selectionHistory\|localShortcuts" --include=*.js capture/ main/ # 零命中
grep -rn "PAGE_MODES" --include=*.js .                                    # 只有定义+导出，无 UI 消费
grep -n "TEMPLATE_VARIABLES" main/services/capture-naming.js              # 仅 app/date/time/datetime
grep -c "selectionBounds" main/services/history-service.js                # 0（§1 第 1 条的证据）

# ── §2 音轨缺陷（隐藏窗口探针，不占前台）────────
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe .tmp/audio-probe/main.js
#   getUserMedia(mic)                  -> tracks=1, 48kHz, live
#   getDisplayMedia audio:true         -> "Could not start audio source"
#   loopback / loopbackWithMute / none -> 前两者失败，none 正常出视频轨
#   --disable-audio-service-sandbox 等四种组合 -> 无一改变错误
```

> 探针源码在 `.tmp/audio-probe/`（已被 `.gitignore` 忽略，未入库）。复现方式：重建 `main.js`/`probe.html` 后按上述命令跑，全程 `show:false` 不抢前台。

---

## 10. 与迁移分析的关系

| 本文 | 迁移分析对应 |
|---|---|
| §1 三处纠正 | 覆盖 §3.2 前置假设、§19.10 读数、§19.6 结论 |
| §2 P0 音轨缺陷 | **迁移分析未覆盖**——这是已发布功能失效，不是迁移项 |
| §3 A 组 | 新增（§19.12 只列了 4 条"下一步建议"，未含 tag/README/真机验收） |
| §4 B 组 | 承接 §14.1 的批 0/3/5/6/7/8，并补 B7 导出续作 |
| §5 C 组 | 承接 §14.1 的批 9/10/11，并单列 C5 小件与 C8 贴纸续作 |
| §6 D 组 | 与 §14.2"不做"一致 |

> 迁移分析 §19.12 的 4 条建议状态：① 补 3 处单测 → 完成 2/3，mixed-selection 仍缺（见 A3）；② 批 3 剩余 → 本文 B2；③ 批 8 → 本文 B6（阻塞已解除）；④ MCP → 本文 C6（仍待 B1）。
