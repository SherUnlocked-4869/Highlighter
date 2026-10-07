# 依赖升级调研与计划（2026-10-07 审计红灯）

- 状态：**调研完成，未执行任何升级**
- 触发：master 的 Windows CI 在 `Audit production and build dependencies` 步骤失败（`审计失败：26 个未豁免漏洞`）
- 相关：[scripts/audit-dependencies.js](../../scripts/audit-dependencies.js)、[package.json](../../package.json)、[main/services/window-security.js](../../main/services/window-security.js)、[.github/workflows/windows-ci.yml](../../.github/workflows/windows-ci.yml)

## 0. 结论摘要

`npm audit` 报 32 条（按 npm 分组是 15 个"vulnerable package"），其中**达到门禁阈值（moderate+）的是 26 条、18 个不同 advisory**；另外 6 条是 low（dompurify ×2、undici ×4），本来就不进门禁。这 18 条已先按"显式豁免"写进 `scripts/audit-dependencies.js`（每条带暴露面理由 + `reviewBy: 2026-11-30`），CI 审计步骤恢复通过。

调研后的关键判断：

1. **真正需要升级的只有 2 个包**：`electron`（4 条 high，运行时外壳）和 `sharp`（1 条 high，缩略图）。
2. **9 条落在"构建/安装链"上**（brace-expansion ×3、undici ×8、http-cache-semantics ×1、sprintf-js ×1）：它们来自 electron-builder / @electron/rebuild / node-gyp / @electron/get，**devDependencies 不进安装包**，只在构建机上执行。
3. **2 条没有可用补丁**：`sprintf-js`（上游无修复版本）与 `http-cache-semantics`（advisory 未列 first_patched_version），只能靠依赖链变化或继续豁免。
4. **3 条有现成规避手段**（`sharp` 的 SVG 禁用、electron 的三条高危本仓库已有硬性缓解），可作为升级前的临时保护。
5. 建议分四期推进：**M1 锁文件刷新 → M2 直接依赖补丁 → M3 Electron 43.2.0 → 43.7.9 → M4 收尾删豁免**；只有 M3 需要真机复验（透明窗口/截图/贴图/录屏/OCR/快捷键）。

## 1. 现状与暴露面总览

| 包 | 当前版本 | 谁引入它 | 是否进安装包 | advisory | 严重度 | 已修补版本 |
|---|---|---|---|---|---|---|
| electron | 43.2.0（devDep，精确 pin） | 直接依赖（运行时外壳） | **是**（外壳本身） | 4 条（见 §2.1） | high ×4 | 43.4.1 / 43.5.0 |
| sharp | 0.35.4 | 直接依赖（history 缩略图） | **是** | GHSA-wq5f-xc86-pv6w | high | 0.35.5 |
| fast-uri | 3.1.7 | ajv → ajv-formats → conf → electron-store（生产链）；ajv → app-builder-lib（构建链） | **是**（electron-store 在校验设置时会加载） | GHSA-hrr3-gc8f-f4qj | moderate | 3.1.8 / 4.1.5 |
| brace-expansion | 1.1.18 | electron-builder → app-builder-lib → @electron/asar / glob / temp / test-exclude / dir-compare | 否（dev） | GHSA-6j4f-fj2g-mc7p、GHSA-qhr7-859c-m2p7、GHSA-q2hr-2g5m-vwhr | high/high/moderate | 1.1.21 / 2.1.7 / 5.0.12 |
| undici | 7.29.0（optional）、6.28.0 | node_modules/electron → @electron/get；node-gyp ← @electron/rebuild | 否（dev/optional） | 8 条（§2.5） | high ×3、moderate ×5 | 7.29.1 / 6.29.0 |
| http-cache-semantics | 4.2.0 | electron-builder → @electron/get → got → cacheable-request | 否（dev） | GHSA-ch52-4w7c-c8xp | high | advisory 未提供 |
| sprintf-js | 1.1.3 | @electron/get → global-agent → roarr（optional） | 否（dev/optional） | GHSA-hp3w-g68c-fv3c | moderate | **无** |
| dompurify | 3.4.13 | 直接依赖 | 是 | 2 条 low（未进门禁） | low | 3.4.16 |

## 2. 逐条调研（advisory → 真实暴露 → 补丁）

### 2.1 electron（4 条 high，唯一真正影响运行时的高危）

| advisory | CVE | CVSS | 影响前提 | 本仓库现状 | 修补版本 |
|---|---|---|---|---|---|
| [GHSA-qmv3-fv6v-rmhq](https://github.com/advisories/GHSA-qmv3-fv6v-rmhq) | CVE-2026-102677 | 7.8 | 加载不可信内容；**无应用侧规避手段** | 所有窗口只加载 `file://` 应用页面，AI 文本走 IPC 不走 HTML | **43.5.0** |
| [GHSA-9qh4-3jw8-366w](https://github.com/advisories/GHSA-9qh4-3jw8-366w) | CVE-2026-102676 | 8.3 | 启用 `<webview>` 且嵌入方未沙箱 | [window-security.js](../../main/services/window-security.js#L4) 锁定 `webviewTag: false` + `sandbox: true` | 43.4.1 |
| [GHSA-gr2m-v5gq-v685](https://github.com/advisories/GHSA-gr2m-v5gq-v685) | CVE-2026-102674 | 8.2 | 沙箱文档允许弹窗 | [window-security.js](../../main/services/window-security.js#L95) 对每个窗口 `setWindowOpenHandler(...) => {action:'deny'}` | 43.4.1 |
| [GHSA-j84w-jfhq-vhvj](https://github.com/advisories/GHSA-j84w-jfhq-vhvj) | CVE-2026-102675 | 7.4 | 注册了 `supportFetchAPI` 但没 `corsEnabled` 的自定义协议 | 全仓库没有 `registerFileProtocol` / `registerHttpProtocol` / `registerSchemesAsPrivileged` | 43.4.1 |

结论：本仓库的三条缓解是**代码里写死的**（不是"暂时没触发"），所以当前实际风险低于 CVSS 表面值；但 `GHSA-qmv3-fv6v-rmhq` 没有应用侧规避手段，**必须靠升级解决**。43.x 线的最新版是 **43.7.9**（`latest` 是 44.6.0）。

### 2.2 sharp（1 条 high）

- [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)（CVSS 4.0 = 8.9）：上游 librsvg 的 use-after-free，**在 glibc 的 Linux 上、且解码 SVG 时**才可能走到 RCE。
- 本仓库：应用是 **Windows-only**（README 系统要求），且 [history-service.js](../../main/services/history-service.js) 只调用 `sharp(filePath).metadata()` / `.resize().png()`，**从不解码 SVG**。
- 补丁：`sharp@0.35.5`（自带 librsvg 2.63.2）。另外可直接加一行硬性规避：`sharp.block({ operation: ['VipsForeignLoadSvg'] })`。

### 2.3 fast-uri（1 条 moderate，生产链但无可达路径）

- [GHSA-hrr3-gc8f-f4qj](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj)：scheme-relative 引用的 host 大小写规范化不一致，**只有当应用基于 `fast-uri` 的输出做"大小写敏感的主机白/黑名单判断"时才能被绕过**。
- 本仓库：fast-uri 唯一的生产可达路径是 `electron-store` → `conf` → `ajv`/`ajv-formats`（JSON Schema 校验），没有任何主机名单判断。
- 补丁：`fast-uri@3.1.8`（或 4.1.5）。属于锁文件级修复，正常 `npm audit fix` 或刷新 ajv 传递依赖即可。

### 2.4 brace-expansion（3 条，全部在构建/测试链）

- [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) / [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7) / [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr)：解析不受信 glob 模式导致栈耗尽 / CPU DoS（availability-only，无代码执行）。
- 链：`electron-builder → app-builder-lib → @electron/asar / minimatch / glob / temp / test-exclude / dir-compare`，devDependencies 不进安装包；被展开的模式全部来自本仓库自己的构建配置。
- 补丁：`1.1.21+ / 2.1.7+ / 5.0.12+`（当前装的是 1.1.18）。

### 2.5 undici（8 条 advisory / 10 条 finding）

- 其中两条 high 值得单独点名：[GHSA-w293-vg96-wgc3](https://github.com/advisories/GHSA-w293-vg96-wgc3)（BalancedPool 丢弃 connect 选项导致**TLS 证书校验被绕过**）与 [GHSA-rfgv-xxqx-mfg5](https://github.com/advisories/GHSA-rfgv-xxqx-mfg5)（WebSocket 子协议 DoS）。
- 链：`node_modules/electron → @electron/get`（安装期下载 Electron）与 `node-gyp ← @electron/rebuild`（构建期），两者都是 dev/optional，**不进安装包**；应用自身的网络请求走 Electron 的 net/Chromium 栈与 `openai` SDK，不经 undici。
- 补丁：`7.29.1+`（当前 7.29.0）或 `6.29.0+`（当前 6.28.0）。

### 2.6 http-cache-semantics（1 条 high，但无补丁版本）

- [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)：共享缓存在 `max-stale` 处理下可能把别的用户的 `Set-Cookie` 交出去。
- 链：`electron-builder → @electron/get → got → cacheable-request`（构建期下载 Electron 二进制）；应用本身没有共享 HTTP 缓存，跨用户披露无落点。
- 补丁：advisory 未列 `first_patched_version`（npm 上最新是 4.3.0）。要么跟随父链刷新到 4.3.0，要么继续豁免。

### 2.7 sprintf-js（1 条 moderate，上游无补丁）

- [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)：无界精度说明符让 `toFixed/toExponential/toPrecision` 抛 `RangeError`；`vulnerable_version_range: "<= 1.1.3"`、**`first_patched_version: null`**（上游 issue #237 仍未修）。
- 链：`@electron/get → global-agent → roarr → sprintf-js`（optional，构建期日志）；格式串由工具自身提供。
- 只能靠父链更新自然消失，**这是明确"无可修版本"的豁免**。

### 2.8 dompurify（2 条 low，未进门禁）

- GHSA-6688-9rhm-gjv2、GHSA-p98j-92pf-mc4p，`<= 3.4.15`，补丁 3.4.16（当前 3.4.13）。虽然低于门禁阈值，但这是一次 patch 升级，建议顺手带上。

## 3. 升级方案（四期，逐期可独立验证）

### M1 · 锁文件刷新（不改 package.json 的依赖声明）

```powershell
npm audit fix --dry-run        # 先看它准备动什么
npm audit fix                  # 只做 semver 范围内的传递依赖更新
npm run audit:dependencies     # 记录哪些 finding 消失
npm test; npm run check        # 653 用例 + 语法/架构门禁
```
预期：`brace-expansion`、`undici`、`fast-uri`、`http-cache-semantics` 这类"有 in-range 修复"的条目消失；`electron` / `sharp`（精确 pin 与直接依赖）与 `sprintf-js`（无补丁）会留下，作为 M2/M3 的输入。**以实测结果为准**：门禁的"失效豁免项"检查会强制把已消失的条目从 allowlist 删掉。

### M2 · 直接依赖的补丁/次版本

| 包 | 现在 | 目标 | 说明 |
|---|---|---|---|
| sharp | 0.35.4 | **0.35.5** | patch；含 librsvg 2.63.2；N-API 预编译产物，无需按 Electron ABI 重编 |
| dompurify | 3.4.13 | **3.4.16** | patch；low 但顺手修 |

可选硬性规避（可独立于升级先做）：在 sharp 初始化处 `sharp.block({ operation: ['VipsForeignLoadSvg'] })`。

### M3 · Electron 43.2.0 → 43.7.9（推荐）；44.6.0 作为备选

- **推荐 43.7.9**：同 major，一次覆盖全部 4 条 advisory（3 条需 ≥43.4.1，1 条需 ≥43.5.0），Electron 官方支持"最近三个 major"，43 线仍在支持期内。改动面：`devDependencies.electron` 精确 pin + `npm install` 重取 `node_modules/electron/dist`（构建走 `--config.electronDist=node_modules/electron/dist`）。
- **备选 44.6.0**：跨 major，需额外评估 Chromium/Node 跳版对本项目几个敏感面的影响（透明窗口/DComp、`screen` 与 DPI、`globalShortcut`、`nativeTheme`、capture 相关 API），**不建议与 M1/M2 同批**。
- 必须复验的门禁与真机项见 §4；特别注意本仓库自带的 fuses 配置（[electron-builder.release.cjs](../../electron-builder.release.cjs#L14)）要让 `npm run verify:fuses` 重新通过，以及签名/打包链路（[release.yml](../../.github/workflows/release.yml) 仅在 `v*` tag 上跑）。

### M4 · 收尾

- 删除 allowlist 中已不再报告的条目（门禁会报"失效豁免项"，这是强制的）；
- 复核 `reviewBy: 2026-11-30` 前是否仍有残留（预期只剩 `sprintf-js`，若其父链仍未更新）；
- 在 `docs/plans/` 补一份验证报告（照 `2026-10-06-toolbar-icon-replacement-verification.md` 的写法）。

## 4. 每期的验证清单

自动化（每期都跑）：

| 命令 | 关注点 |
|---|---|
| `npm run audit:dependencies` | 阻断条目应逐期减少；失效豁免项必须删 |
| `npm test` | 当前 653 用例全绿 |
| `npm run check` | 语法 233 文件 + `main.js ≤ 1300` 架构门禁 |
| `npm run test:runtime` | Electron 运行时探针（M3 必跑） |
| `npm run test:e2e` | Playwright 渲染进程 E2E（M3 必跑） |
| `npm run verify:fuses` | fuses 加固（M3 必跑） |
| `npm run test:coverage` | 覆盖率阈值（M3 必跑） |

真机（**仅 M3 强制**，因为换的是运行时外壳）：按 README 的功能面逐项过一遍——划词工具栏弹出与动作、区域截图/标注/复制/保存/贴图、OCR（文本/表格/二维码）、长截图、录屏导出、翻译与 AI 对话、托盘与全局快捷键、多显示器与 150% DPI 下的工具栏锚点（2026-10-07 那次事故就是透明窗口合成路径，DComp 行为必须重看）。构建产物要重做一次 setup 并静默安装，再确认 `Highlighter.exe`/`app.asar` 指纹变化与运行时日志版本号。

## 5. 风险与回滚

| 风险 | 影响 | 缓解 / 回滚 |
|---|---|---|
| `npm audit fix` 顺带更新了别的传递依赖 | 行为漂移 | 先 `--dry-run` 看清单；只提交 `package-lock.json` 的 diff；`git checkout -- package-lock.json` 即可回滚 |
| Electron 次版本跳版引入 Chromium 行为变化 | 透明窗口/截图/DPI 回归 | M3 单独一批 + §4 的真机清单；回滚只需把 pin 改回 43.2.0 并重装 |
| sharp patch 升级换 prebuild | 缩略图异常 | sharp 只有 `.metadata/.resize/.png` 三个调用点，回归面小；回滚 pin 到 0.35.4 |
| 跨 major（44.x） | API 弃用/签名链路变化 | 不放进本次范围，单独设计 |
| 豁免被当成"已修复"遗忘 | 风险长期滞留 | allowlist 每条带 `reviewBy`，且失效条目会让门禁变红，强制复核 |

## 6. 待确认

1. **M3 是否只到 43.7.9，还是今年内直接规划 44.x？**（43.7.9 可立刻消掉 4 条 high；44.x 是跨 major，需要单独一期。）
2. `sharp` 的 SVG 硬性禁用（`VipsForeignLoadSvg`）要不要作为**独立小改动**先落地？
3. `npm audit fix` 允许动到什么程度：只允许锁文件，还是也允许 `package.json` 里 `^`/`~` 范围内的直接依赖被动更新？
4. 是否把"审计红灯"设为**发布门禁的一部分**（tag 之前必须绿），避免以后又靠豁免兜底？

## 7. 附录：豁免清单（2026-10-07 写入 `scripts/audit-dependencies.js`）

18 条（26 个 finding，其中 brace-expansion 与 undici 因 npm 的 `via` 重复计数）：

| # | 包 | advisory | 严重度 | 归类 |
|---|---|---|---|---|
| 1-3 | brace-expansion | GHSA-6j4f-fj2g-mc7p / GHSA-qhr7-859c-m2p7 / GHSA-q2hr-2g5m-vwhr | high×2, moderate | 构建/测试链 |
| 4-7 | electron | GHSA-qmv3-fv6v-rmhq / GHSA-9qh4-3jw8-366w / GHSA-gr2m-v5gq-v685 / GHSA-j84w-fjhq-vhvj | high×4 | **运行时**（M3 升级） |
| 8 | fast-uri | GHSA-hrr3-gc8f-f4qj | moderate | 生产链但无可达路径 |
| 9 | http-cache-semantics | GHSA-ch52-4w7c-c8xp | high | 构建链，无补丁版本 |
| 10 | sharp | GHSA-wq5f-xc86-pv6w | high | **运行时**（M2 升级） |
| 11 | sprintf-js | GHSA-hp3w-g68c-fv3c | moderate | 上游无补丁 |
| 12-18 | undici | GHSA-w293-vg96-wgc3 / GHSA-rfgv-xxqx-mfg5 / GHSA-rx4f-c7p8-82vq / GHSA-pmjh-fq2x-6v4x / GHSA-3xpg-4rpp-hhhm / GHSA-3wwx-pv8p-q78v / GHSA-2jfj-6hjv-fm6j | high×3, moderate×4 | 安装/构建链 |

未进门禁的 6 条 low：dompurify GHSA-6688-9rhm-gjv2、GHSA-p98j-92pf-mc4p；undici GHSA-2gqq-gqf2-x968、GHSA-8436-99hf-9mmv、GHSA-r53p-7pc4-xj5r。其中 dompurify 建议在 M2 顺手升到 3.4.16。
