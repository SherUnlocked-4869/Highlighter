# 设计文档：CI 修复、OCR 冷启动、截图热路径、长截图匹配、重复逻辑消除

- 日期：2026-09-09
- 基线：`master` @ `c864cd1`（工作区 `package.json` 未提交改为 2.2.4）
- 范围：5 项，均已用代码证据核实

---

## 0. 范围与依据

| # | 项目 | 类型 | 风险 |
|---|---|---|---|
| 1 | master CI 红 + 无分支保护 | 基础设施 | 低 |
| 2 | OCR 冷启动重复 16MB SHA-256 | 性能 | 低 |
| 3 | 截图热路径冗余解码与同步 I/O | 性能 | 中 |
| 4 | 长截图匹配算法 | 性能 | 中 |
| 5 | 重复逻辑消除 | 可维护性 | 中 |

已确认的决策：E2E 注入假服务；截图只做热路径最小改动；长截图只做安全收益 + 补语料；去重分层推进、该改测试就改。

---

## 1. CI 红 + 分支保护

### 1.1 根因（已核实）

`e2e/local-search.spec.js:24` 要求 `package.json` 关键字能返回至少一条 `.result-row`。该测试自 `b295aad` 引入后**在 CI 上从未通过**，最近两次 master 推送（`33508097826`、`33385579401`）与 v2.2.3 tag 均失败在同一行。

机制：`search.js:222` → `EverythingService.query()` → `ensureReady()`（`everything-service.js:313`）→ 侧车检测不到运行中的 Everything 实例，于是启动内置便携版（`everything-service.js:277`）。GitHub 托管 runner 无管理员权限、无 Everything 服务，内置实例无法建立 NTFS 索引，`dbLoaded` 恒为 false，`waitReady` 30s 超时抛错，渲染层显示错误态，`.result-row` 永不出现。CI 日志中 `Terminate orphan process: pid (3444) (Everything)` 证实该路径确实被走到。

次生问题：`e2e/fixtures.js:17` 的 `fs.rmSync(dataRoot)` 与未退出的 Everything 进程竞争，导致 `Tearing down "highlighter" exceeded the test timeout of 60000ms`。

连带后果：e2e 步骤失败后，`Enforce coverage thresholds`（step 10）与 `Run long capture regression tests`（step 11）被跳过，`package` job 因 `needs: quality` 也跳过 —— 覆盖率、长截图、打包、fuse 门禁在 master 上从未被验证。

`playwright.config.js:11` `retries: 0`，无重试兜底。

### 1.2 方案：复用已有 E2E 接缝注入假服务

现有接缝已就位：`e2e/electron-app.js:24` 设置 `HIGHLIGHTER_E2E=1`，`main/services/e2e-bootstrap.js:5` 据此接管 userData。`getEverythingService()`（`main.js:1951`）是**唯一构造点**，`EverythingService` 构造函数已支持注入 `spawn` / `processProbe` / `runCommand`（`everything-service.js:36-40`）。

实施：

1. **`main/services/e2e-bootstrap.js`**：扩展返回 `{ enabled, dataRoot, sessionData, fakeEverything }`，`fakeEverything` 由 `env.HIGHLIGHTER_E2E_FAKE_EVERYTHING === '1'` 决定。仅 `!app.isPackaged && HIGHLIGHTER_E2E==='1'` 时生效，生产路径零影响。
2. **`EverythingService`** 新增可选 `options.e2eQuery`（默认 `null`）：非空时 `query()` 直接返回该函数结果，跳过 `ensureReady` / 侧车 spawn / 缓存，但**保持返回结构完全一致**（`{ items, total, cached? }`），使 IPC 通道形状与渲染层代码路径不变。
3. **`main.js:1951`**：`e2eContext.fakeEverything` 为真时传入 `e2eQuery`，返回固定的 `package.json` 行集合（含 `name` / `path` / `size` / `modified` 字段，满足 spec 第 24-41 行全部断言）。
4. **`e2e/electron-app.js:22`**：env 增加 `HIGHLIGHTER_E2E_FAKE_EVERYTHING: '1'`。
5. **teardown 加固**：`e2e/fixtures.js:15-17` 在 `highlighter.close()` 与 `rmSync` 之间保留（假服务不 spawn，竞争消除）；`rmSync` 已有 `maxRetries: 5` 保持。
6. **新增单测** `test/e2e-bootstrap.test.js` 补 `fakeEverything` 分支；`test/everything-service.test.js` 补 `e2eQuery` 短路分支，确保 `everything-service.js` 在 `test:coverage:loaded` 的 85% 聚合门禁内不退化。

### 1.3 分支保护

- 必填检查名是 job 的 `name:`，即 **`Check and test`**（`windows-ci.yml:17`）。
- **不要**把 `Build hardened unsigned candidate` 设为必填：它带 `if: github.event_name != 'pull_request'`（`windows-ci.yml:56`），PR 上恒为 skipped，设为必填会永久阻塞所有 PR。
- 顺序强制：**必须先让 master 转绿再开启保护**，否则阻塞所有合并。过渡期建议 `enforce_admins: false`（当前是 ADMIN，可自行绕过）。
- 落地方式：`gh api -X PUT repos/SherUnlocked-4869/Highlighter/branches/master/protection --input <json>`，字段 `required_status_checks.contexts=["Check and test"]`、`strict=true`。

### 1.4 附带清理

工作区 `package.json`/`package-lock.json` 未提交的 2.2.4 变更与 HEAD 的 2.2.3 不一致；`check:version` 只比对 lock 与 tag 参数，**不查 git tag**，无法发现分支上的漂移。本次一并提交或回退该版本号。

### 1.5 验收

`gh run watch` 上 master 的 `Check and test` 全绿，且 coverage / long-capture 两步真正执行；`gh api .../branches/master/protection` 返回 200 且含 `Check and test`。

---

## 2. OCR 冷启动 SHA-256 缓存

### 2.1 问题（已核实）

`ocr-service.js:85` 在 `start()` 的**第一条语句**同步调用 `validateFiles()`，其中 `:66` 对 3 个 ONNX 模型（合计 16,189,007 B ≈ 15.4 MiB）执行 `fs.readFileSync` + SHA-256，**在 Electron 主线程同步执行**，且发生在 `spawn` 之前。由于 `idleTimeoutMs` 硬编码 30s（`:28`，`main.js:310` 构造时未传），隔 30 秒再 OCR 就要重付一次。

`getStatus()`（`:32`）只做 `existsSync`，不哈希。

### 2.2 方案

**实例级校验缓存**，键为 `绝对路径 + stat.size + stat.mtimeMs`：

- `validateFiles()` 保留**同步签名**（`test/ocr-service.test.js:135` 的 `assert.doesNotThrow(() => service.validateFiles())` 与 `:138` 的二次调用抛错断言都依赖它）。
- `:63` 已有的 `statSync` 顺手取 `size` / `mtimeMs` 组成键；命中则跳过 `readFileSync` 与哈希。
- 存在性检查、清单解析、大小检查（`:46-64`）**始终执行**，不缓存，保证 `test/ocr-service.test.js:143-160` 的缺失/畸形清单断言不退化。
- 篡改场景验证：测试把 `MODEL_FILES[0]` 从 `model-0`(7B) 改为 `tampered`(8B)，size 变化 → 键变化 → 重新校验 → 在 `:64` 大小检查处抛错。断言仍成立。
- 键额外纳入 `ino` 以规避 mtime 粗粒度风险。

**空闲超时可配置**：`DEFAULT_SETTINGS.ocr`（`main.js:157-164`）新增 `idleTimeoutMs`，默认 `300000`（5 分钟）；`getOcrService()`（`main.js:310`）透传给构造函数。`settings-validation.js` 按 defaults 模板逐键校验，新增键安全。注意 `config/config.js:1377` 的 `updateSettings` 只发送部分 ocr 键，新键保持纯 defaults。

### 2.3 可选（本次不做，记录）

把校验改为 `fs.promises` / 流式哈希（可复用 `diagnostics-service.js:127-136` 的 `hashFile` 写法）以彻底移出主线程；缓存命中后首次代价已消失，优先级下降。

### 2.4 验收

日志新增 `OCR model validation` 耗时事件；连续两次 OCR（间隔 < TTL）第二次不出现模型读取；`npm run test:coverage:native` 的 `ocr-service.js` 60% 门禁仍通过。

---

## 3. 截图热路径

### 3.1 问题清单（已核实）

| # | 位置 | 问题 | 用户可见 |
|---|---|---|---|
| 1 | `main.js:2699` | copy handler 在 IPC 返回前同步执行 `persistHistory`：全量写盘 + 二次 PNG 解码 + 缩略图 resize/encode/写盘 + electron-store 同步 JSON 写 | 是，点击到关窗 |
| 2 | `main.js:2721` | pin handler 同上，且 `pinFromCapture` 还多一次 base64 编码 | 是 |
| 3 | `main.js:2698` vs `history-service.js:278` | 同一 buffer 被解码两次（剪贴板一次、历史一次） | 是 |
| 4 | `main.js:1666` | `fs.writeFileSync` 全量 PNG 在主线程 | 是（pin 保存） |
| 5 | `main.js:1613` | `fs.copyFileSync` 长截图大文件 | 是 |
| 6 | `main.js:1220` | `nativeImage.createFromBuffer` 解码全屏 PNG 仅用于尺寸+空白检查 | 是 |

### 3.2 方案（最小改动，不动 HistoryService 同步 API）

1. **`persistHistory` 移出 IPC 返回路径**（收益最大）：`copy`（`:2695`）与 `pin`（`:2718`）handler 先完成剪贴板写入 / 贴图创建并立即返回，`persistHistory` 放入 `setImmediate` 并 `catch` 记录日志 —— 与 `save` handler（`:2703`，已用 `setImmediate`）保持同一既有惯例。copy 当前返回 `item`，改为返回 `null`，需同步确认 `preload-capture.js` 与 `capture.js:584` 的消费方不依赖返回值（仅用于关窗）。
2. **消除重复解码**：给 `HistoryService.persistImageBuffer` 增加可选 `meta.image`（已解码的 NativeImage）；`copy` 路径把 `nativeImage.createFromBuffer(buffer)` 的结果透传，跳过 `history-service.js:278` 的二次解码。不改变 `persistDataUrl` 方法形状（`test/data-root-ui-contract.test.js:158-159` 断言其首语句为 `assertWritable()`）。
3. **`saveImageBuffer` 改异步写**：`main.js:1666` `fs.writeFileSync` → `fs.promises.writeFile`（`main.js` 已用 `fs.promises`，见 `:2600`）。长截图 `:1613` 同理改 `fs.promises.copyFile`。
4. **快速失败**：`main.js:1223` 的尺寸校验改为解析 PNG IHDR 头（偏移 16/20 处的宽高），尺寸不符立即抛错，避免为尺寸检查先解码整张图；尺寸正确时才解码做空白判定。
5. **补埋点**：在 `capture.interactive` 事件（`main.js:1244-1251`）中新增 `blankCheckMs`、`historyPersistMs`、`saveMs` 分段，写入 `performance-monitor.js`。

### 3.3 测试影响

- `test/capture-performance-contract.test.js:12-20` 用源码文本断言 `nativeImage.createFromBuffer(buffer)` 等模式；改动 3.2.2 会触及，需同步更新该测试。
- `test/history-service.test.js:115-128` 同步契约不变（`persistImageBuffer` 仍同步返回）。
- `test/data-root-ui-contract.test.js:158-159` 保持 `persistDataUrl`/`persistFile` 首语句不变。

### 3.4 验收

`capture.interactive` 日志显示 copy/pin 的 IPC 返回耗时下降到仅含剪贴板/贴图创建；`npm test` 与覆盖率门禁全绿。

---

## 4. 长截图匹配算法

### 4.1 现状（已核实）

`matcher.js:72-139` 是沿单轴的一维归一化 SAD 暴力搜索：候选数 ≈ `2 × 0.82 × axisLength`，每个候选采样 ≤ `180 × 48`，整体 O(轴长 × 8640)。`matcher.js:84-86` 明确注释**禁止沿滚动轴降采样**（会导致文字边缘错一行）。

实测（`docs/performance/2026-08-16-optimization-round.md:11-12`）：垂直 56.83ms（门槛 50ms 边缘）、水平 86.00ms（超标）。团队已决策：**优化需真实语料先行，避免对合成数据过拟合**（该文档第 36 行）。

### 4.2 方案（只做安全收益 + 补语料）

1. **`appendPreview` 经实测后不改动。** 原假设是「超过 1200px 后每帧全量重缩放导致 O(n²)」，实测推翻了该判断：预览被 1200px 上限约束，峰值像素恒为约 192k，单次追加耗时随预览缩小而下降（1000×60 条带：100 段 0.107ms/帧，3000 段 0.058ms/帧，Chrome canvas 实测）。按团队既有规则「收益不足 10% 且增加复杂度的实现不保留」（`docs/performance/2026-08-12-baseline.md` 第 5 节第 5 条），不做无依据的重写。
2. **真实语料采集工具**：`scripts/benchmark-performance.js` 新增 `--corpus <dir>`，读取真实滚动截图序列。当前 `:44-58` 的 `createShiftedFrame` 用两个独立 LCG 合成，与真实滚动内容的行间相关性不符。语料格式与采集方法见 `docs/performance/2026-09-09-long-capture-corpus.md`。
3. **不引入金字塔/粗到精**：留待语料到位后单独评估。
4. **算法核心契约冻结**：`matcher.js:141` 的 UMD 导出面、`matcher-worker.js` 的消息形状与 `previous` 仅在 `matched` 时推进的语义、`tests/long-capture.test.js:55-90` 的等价性与歧义拒绝断言，均不得改动。
5. **清理**：`native/scroll-driver/` 是 `f9e7fdf` 回滚后遗留的空目录，git 未跟踪任何文件，建议删除。

### 4.3 验收

`npm run test:long-capture` 全绿；`npm run bench:performance` 垂直/水平 detectedShift 与 status 不变；预览在长会话下不再出现卡顿与画质累积损失。

---

## 5. 重复逻辑消除（分层）

关键约束：18 个测试文件、**147 处 `assert.match(main.js, ...)`** 把 `main.js` 当源码文本断言，任何移动都需同步改测试。

### 5.1 A 层 —— 零测试影响，先做

| 重复项 | 现状 | 归口 |
|---|---|---|
| `ensureDirectory` | `main.js:757` 与 `history-service.js:82` 逐字重复 | 抽到 `main/services/fs-utils.js`，两处引用（无测试断言） |
| 搜索分类 | `main.js:181-192`、`config/config.js:85-95`、`search/search-utils.js:6-17` 三份，十项**逐字节相同** | 归口 `search/search-utils.js`（已是 UMD 且被 `test/search-utils.test.js:112-115` 覆盖）；先确认 `config/config.html` 已加载该文件 |
| deepseek 常量 | `deepseek.js:15-17` 与 `ai-providers.js:7-9` 值相同、类型不同（Set vs frozen Array） | 归口 `ai-providers.js`；`deepseek.js` 改为 import。仅行为断言，无源码文本断言 |
| 图片 buffer 助手 | `main.js:762-778` 与 `history-service.js:267,152` 的 dataURL 正则/前缀重复 | 抽到 `main/services/image-buffer.js`；`main.js` 保留薄转发（17 个调用点不动）；`history-service.js` 方法体形状保持不变 |

### 5.2 B 层 —— 需同步改测试

| 重复项 | 现状 | 需更新的断言 |
|---|---|---|
| `makeCaptureName` | `main.js:780` 正向生成 vs `history-service.js:8` 正则反解 vs `:103` 前缀推导 | `test/history-management-ui.test.js:59-60`（改为对新模块断言） |
| 工具栏元数据 | `toolbar/toolbar-utils.js:4-14`（含 kind/id）vs `config/config.js:26-31`（含 description/optional），label/icon 相同 | `test/selection-toolbar-settings.test.js:28-30`、`test/selection-toolbar-thinking.test.js:102` |
| URL 校验 | `main.js:2399` 手写、`window-security.js:52` 的 `isSafeExternalUrl`（全库零生产调用）、`preload-action.js:40-48`、`action/action.js:79-87` 四份 | `main.js` 改为委托 `isSafeExternalUrl`；渲染层两份保留；`test/window-security.test.js:50-53` 行为断言不变 |
| 目录选择器 | `main.js:2425` 与 `:2614` 函数体几乎相同（后者多 title） | 合并为 `pickDirectory({title})`，**保留在 `main.js` 内**，维持 `test/history-management-ui.test.js:79-80` 的源码断言 |

### 5.3 明确不做

`main.js` 拆分、26 个可变全局收敛为 registry、147 处源码文本断言整体迁移 —— 属 main.js 模块化工程，需单独立项，本次不混入。

### 5.4 验收

`npm test` 全绿；`npm run check` 通过；重复定义数降到 0（用 `grep` 复核每项仅剩一处定义）。

---

## 6. 执行顺序

1. **第 1 项**：修 e2e → master 转绿 → 开分支保护 → 提交/回退版本号。这是其余各项能被 CI 验证的前提。
2. **第 2 项**（OCR 缓存）+ **第 5 项 A 层**：改动小、风险低、无测试形态变更。
3. **第 3 项**（截图热路径）：需同步改 `capture-performance-contract` 测试。
4. **第 4 项**（长截图预览 + 语料工具）。
5. **第 5 项 B 层**：最后做，因为要动 4 处源码文本断言。

每项独立提交，附带 before/after 数据；收益不足 10% 且增加复杂度的实现按团队既有规则不保留（`docs/performance/2026-08-12-baseline.md` 第 5 节第 5 条）。

---

## 7. 不在本次范围

媒体权限 handler、API Key 未脱敏下发截图窗口、依赖审计漏洞修复（`sharp` 等 6 项）、显示器变更监听、`createRecordWindow` 失败清理、AI 重试退避、长截图自动滚动、录屏音轨、代码签名 —— 均已在上一轮分析中记录，留待后续排期。

---

## 8. 交付物

1. 本设计文档 `docs/plans/2026-09-09-ci-ocr-capture-dedup-design.md`
2. 代码改动按第 6 节顺序分提交
3. 新增 `docs/performance/2026-09-09-long-capture-corpus.md`（第 4 项）
4. 各测试文件的同步更新
