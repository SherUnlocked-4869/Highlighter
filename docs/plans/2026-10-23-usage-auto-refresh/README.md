# 用量页自动刷新（2026-10-23 用户反馈）

## 问题

用户反馈「用量页面的数据同步时间有吗？我感觉没自动刷新过」。

排查结论（不是感觉，是代码事实）：

1. 「上次扫描」时间**有**显示：覆盖状态条右侧 meta，`config.usage.coverage.last-scan`，
   数据源 `app_meta.lastScanAt`（`main/services/usage-feature.js:184`）。
2. 但**没有任何自动刷新**。全仓生产代码里只有两处 `usage:refresh`：
   - `usageBindConsent()` 里「开启统计」那一次（`reason: 'page-open'`）；
   - 右上角刷新按钮（`reason: 'manual'`）。
   页面渲染路径 `usageRenderRoute()` 只调只读查询，从不触发扫描。
3. 方案文档 §2.2 写明「页面打开时增量扫描」（`docs/plans/2026-10-21-tokentracker-usage-page-development-plan.md:275`），
   collector 的 5 分钟 `page-open` 节流也实现并有单测（`usage-collector.js:24,124-130`）——
   但生产路径从未发送过该 reason（首次同意之后），属**死代码**。`git log -S'setInterval'` /
   `-S'visibilitychange'` 在 `config/routes/usage.js` 上查无记录，从未实现过。
4. 现场证据：本机 `lastScanAt = 2026-10-22T10:56:57.531Z`（本地 10-22 18:56），
   最新数据桶 `2026-10-22T10:30Z`，10-23 整天 `app.log` 里 usage 相关日志 0 条。
   已确认不是版本问题：安装版 4.1.1 的 asar 内 `config/routes/usage.js` 与工作树 sha256 一致。

## 修改

### `config/routes/usage.js`

- 新增 `USAGE_AUTO_REFRESH_MS = 60 * 1000`（渲染侧轮询间隔；**真实下限仍由 collector 的 5 分钟拥有**，
  渲染侧故意问得比下限勤，让节流应答告诉我们数据是否真的变过，避免「刚好早 200 ms 被节流、
  下一拍再等 5 分钟」的错拍）。
- `usageAutoRefreshTick()`：唯一扫描触发器。路由守卫 + 可见性守卫 + 单飞（`usageAutoRefreshInFlight`），
  失败也继续排下一拍；永远不带 `await` 阻塞渲染。
- `usageAutoRefreshArm()` / `usageAutoRefreshStop()`：`setTimeout` 链（不是 `setInterval`，
  慢应答不叠加）+ `window focus` + `document visibilitychange` 监听；每次进页面/原地重查询都先拆后装，
  不会累积监听器。
- `usageRenderRoute()`：`status.enabled === true` 后 `usageAutoRefreshArm()`，
  且**只有真正的路由进入**（`options.keepDashboard !== true`）才发首次 `page-open`；
  周期切换/手动刷新不再重复触发扫描。
- `usageDeactivate()`：离路由时拆定时器 + 两个监听 + IPC 订阅 + 清 payload。
  由 `config/config.js` 的 `navigate()` 调用（与 history/models 的既有前置清理同型）。
- `usageApplyProgress()`：扫描 `done` 改为 `usageRerenderKeepingDashboard()` 原地重绘，
  不再 `renderUsage()` 把页面打回加载卡；趋势详情弹窗开着时挂起（`usageAutoRefreshRenderPending`），
  关弹窗时补绘，避免后台扫描摧毁用户正在看的弹窗。
- `usageBindConsent()` 删掉自己的 `page-open` 调用（渲染路径已负责，避免同一次开启扫两遍）。
- 新增 `usageRelativeTime()`：覆盖状态条改为「上次扫描 2026/10/23 12:02（刚刚）」。
  裸时间戳读起来像「现在是新的」，相对时间才说得清是分钟还是天。

### 文案（三语言同加）

`config.usage.coverage.last-scan-relative`、`relative-now`、`relative-minutes`、
`relative-hours`、`relative-yesterday`、`relative-days`。

## 验收

| 门禁 | 结果 |
|---|---|
| `npm run check` | ✅ 396 JS 文件、architecture ok（main.js 1327/1330）、i18n 1338 键三表对称、未迁移 CJK 585（上限 606，未增加） |
| 新增 `test/usage-auto-refresh.test.js` | ✅ 7/7（VM 内真实执行 `config/routes/usage.js`，不是源码正则） |
| `test/usage-page-controls.test.js` | ✅ 8/8（新增 2 条：自动刷新接线、相对时间文案三语言） |
| `npm test`（注入 AGENTS.md 的 spawn hook） | ✅ 1348/1349；唯一失败 `capture-first-paint` 经 `git stash` 干净树复现（6 次 1 次红），与本改无关 |
| `npx playwright test`（真实 Electron） | ✅ 8/8，含新增「启用后页面自带后台刷新 + 相对时间标签」 |
| headless 预览 | ✅ 4 张截图、0 pageerror、0 console error、可见窗口 0 |

失败过的 e2e 断言（保留在注释里）：最初断言「重进页面 → `lastScanAt` 变化」，
但 collector 的 5 分钟节流会正确地把紧接着 consent 扫描的重进应答为 `throttled`，
所以**断言触发而不是时间戳**才对；`contextBridge` 暴露的 API 是冻结的（实测
`Object.isFrozen === true`），渲染进程无法 spy 包装，e2e 因此改为断言页面契约。

## 截图

- `01-908-light-relative-scan.png`：908px 单栏，覆盖状态条显示「（3 小时前）」
- `02-1180-light-relative-scan.png`：1180px 双栏
- `03-908-dark-relative-scan.png`：908px 暗色

## 发布构建（2026-10-23）

版本 **4.1.2**（4.1.1 → 4.1.2，`npm version --no-git-tag-version`；`check:version` 通过）。

构建命令与产物：

```bash
npx electron-builder --config electron-builder.local-fuses.cjs --win nsis portable --x64 --publish never
npm sbom --sbom-format cyclonedx > dist/sbom.cdx.json
pwsh -File scripts/verify-release.ps1 -DistDir dist
```

| 产物 | 大小 | SHA256 |
|---|---|---|
| `dist/Highlighter-Setup-4.1.2.exe` | 149,606,787 B | `4D0853FE34163691C101EC5218924089D8C4B08FD1EA7A393518938055053D32` |
| `dist/Highlighter-4.1.2-portable.exe` | 149,352,750 B | `AB5EA5E1CE802A1EF8B00BE684570DC4A90CB6AC11CFFA214843A35EAD222AF3` |

**关键：必须用 `electron-builder.local-fuses.cjs`，不能用 `npm run build:win`。**
后者走 `package.json` 的 `build` 字段，不含 `electronFuses` 与 `extraMetadata.main`，
产出的 exe 有 6 项 fuse 不符合发布要求（`RunAsNode` 等），也不走 `main/packaged-entry.js`。
`scripts/verify-electron-fuses.js dist/win-unpacked/Highlighter.exe` 会直接报错。

### 顺带修掉的一个真实缺陷

`node_modules` 是 2026-08-10 安装的，而 `d08554b`（`fix(deps): bump dompurify to 3.4.17`）
在那之后才提交。于是 **package.json/lockfile 要求 3.4.17，实际装的是 3.4.13**，
第一次打包把已知有问题的 3.4.13 打进了 asar（`npm sbom` 报 `ESBOMPROBLEMS` 才暴露）。
`npm ci` 重装后 asar 内为 **3.4.17**，SBOM 可正常生成（378 components）。

### 校验记录

| 检查 | 结果 |
|---|---|
| fuses（8 项） | ✅ 全部符合（`verify-electron-fuses.js`） |
| 打包入口 | ✅ asar 内 `main = main/packaged-entry.js`；`--highlighter-packaged-startup-probe` 对 win-unpacked 与 portable 均 **exit 0** |
| asar 内容一致 | ✅ 改动的 3 个文件与工作树 sha256 逐字节相同 |
| 原生 sidecar | ✅ clipboard/ocr/smart-select/everything ×2 + selection-hook.node + ffmpeg.exe 全在 |
| 包内 dompurify | ✅ 3.4.17 |
| `verify-release.ps1` | ✅ `{"version":"4.1.2","signed":false,...,"checksums":"SHA256SUMS.txt"}` |
| 单测 / e2e | ✅ 1349/1349、8/8 |

**受限宿主说明**：`verify-release.ps1` 内的 `verify-packaged-startup.ps1` 用
`Start-Process` 启动 exe，注入不了 `--no-sandbox`，在本机返回
`0x80000003`（Chromium 沙箱起不来，非产物缺陷）。因此该步用
`-SkipFuseVerification` 跳过，改为手动执行等价探针（上述 exit 0 即其证据）；
fuses 校验被跳过是因为它早已单独通过。正常桌面/CI 不需要这个 workaround。
