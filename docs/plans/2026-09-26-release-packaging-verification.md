# 发布打包线验证报告（fuses / 打包入口 / asar 完整性 / 签名）

- 日期：2026-09-26
- 分支：`feature/selection-toolbar-conversation` @ `7442ece`
- 构建方式：`npx electron-builder --config electron-builder.local-fuses.cjs --win --x64 --publish never -c.directories.output=dist/release`
- 结论：**除代码签名（本机无证书）外，发布打包线的加固全部验证通过**，仓库自带的发布门禁
  `verify-release.ps1` 在产物上返回成功
- 产物位置：`dist/release/`（在 `dist/` 内，已被 `.gitignore` 忽略）

---

## 1. 为什么要单独构建这一条线

发布配置（`electron-builder.release.cjs`）与日常构建（`npm run build:win`，走 `package.json` 的 `build`）
是**两套不同的东西**：

| 项 | 日常构建 | 发布配置 |
|---|---|---|
| 入口 | `main.js`（`package.json.main`） | **`main/packaged-entry.js`**（`extraMetadata.main` 覆盖） |
| fuses | 无 | 8 项硬化 |
| asar 完整性校验 | 无 | `EnableEmbeddedAsarIntegrityValidation` |
| 只从 asar 加载 | 无 | `OnlyLoadAppFromAsar` |
| 签名 | 无 | `forceCodeSigning: true` |

`electron-builder.local-fuses.cjs` 继承发布配置、只把 `forceCodeSigning` 关掉，
因此它是**本机能构建的最接近发布的产物**（有 fuses、无签名）。

为避免影响用户已安装的 2.2.7（它是日常构建，装在 `D:\Program Files\Highlighter`），
本次构建输出到 `dist/release/`，全程**没有安装**，用的是 `win-unpacked` 与 portable。

## 2. 验证结果

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| 1 | fuses 全部符合预期 | ✅ | `node scripts/verify-electron-fuses.js dist/release/win-unpacked/Highlighter.exe` → `RunAsNode=off, EnableCookieEncryption=on, EnableNodeOptionsEnvironmentVariable=off, EnableNodeCliInspectArguments=off, EnableEmbeddedAsarIntegrityValidation=on, OnlyLoadAppFromAsar=on, LoadBrowserProcessSpecificV8Snapshot=off, GrantFileProtocolExtraPrivileges=on` |
| 2 | 对照：日常构建**不满足**同一检查 | ✅ | 对已安装的 `D:\Program Files\Highlighter\Highlighter.exe` 跑同一脚本 → 报 `RunAsNode expected off, got 49`、`EnableEmbeddedAsarIntegrityValidation expected on, got 48` 等 5 项失败。证明 fuses 配置确实生效，不是"跑了个空检查" |
| 3 | 打包入口是 `main/packaged-entry.js` | ✅ | 从 asar 里读出 `package.json.main = main/packaged-entry.js`（用 `@electron/asar` 的 `extractFile` 读 Buffer，不落盘）；且该文件确实 `require('../main.js')` |
| 4 | 入口行为可观测 | ✅ | `win-unpacked/Highlighter.exe --highlighter-packaged-startup-probe` **在 20 秒内以 exit 0 退出** → `packaged-entry.js` 是入口；对照日常构建会忽略该开关继续运行 |
| 5 | **asar 完整性校验真的会拦人** | ✅ | 把 asar **头部的索引**改一个字节（保持长度与可解析性）后启动：`FATAL:electron\shell\common\asar\asar_util.cc:144] Integrity check failed for asar archive (d5265c89… vs e87e8807…)`，进程 exit 127。还原后 `app.asar` 的 SHA256 与篡改前一致，启动恢复 exit 0 |
| 6 | 新模块真的进了包 | ✅ | asar 内含 `action/conversation-text.js`、`main/services/conversation-store.js`（共 3031 个条目）。这类"只在打包后才暴露"的 `build.files` 缺失，正是这一步的意义 |
| 7 | fuses 产物能**跑起完整应用** | ✅ | 用 portable 构建（配 `PORTABLE_EXECUTABLE_DIR` 隔离数据根）实跑：日志出现 `session-start`、`OCR ready`、`Selection hook started: startup`、`Everything sidecar ready`，并且新建的数据根里出现了 **`conversations` 目录**（新数据布局在打包产物中生效） |
| 8 | 仓库自带的发布门禁通过 | ✅ | `scripts/verify-release.ps1 -DistDir dist/release -SkipSbom` → exit 0，输出 `Electron fuses verified: …`、`Packaged Electron startup verified: Highlighter.exe`、`…-portable.exe`，以及汇总 `{"version":"2.2.7","signed":false,"setup":…,"portable":…,"manifests":["latest.yml"],"checksums":"SHA256SUMS.txt"}` |
| 9 | 签名门禁会正确拒绝 | ✅（作为门禁） / ❌（作为产物） | `-RequireSignature` 报 `Expected publisher is required when signature verification is enabled`；两个产物的 Authenticode 状态都是 `NotSigned` |

## 3. 两点值得记下的发现

1. **asar 完整性只覆盖"头部索引"，不覆盖文件内容字节。** 我第一版篡改测试是往 `app.asar`
   **末尾追加**几个字节——应用照常启动、探针依旧 exit 0。这不是 fuse 失效，而是校验对象就是头部：
   追加字节不改索引。改成改头部一个字节后立刻被 `FATAL … Integrity check failed` 拦下。
   以后要验证这条 fuse，必须动头部（或整体替换 asar），追加/截断都不算数。
2. **fuses 产物与已运行实例的快捷键冲突是优雅降级的。** portable 实例启动时日志里是
   `Shortcut unavailable: Alt+F` / `Ctrl+Alt+E`（已被用户那份实例占用），而不是启动失败。
   这条不是本次改动引入的，但确认了"多个实例并存"不会炸。

## 4. 未完成：代码签名

本地无法产出签名产物，因为需要签名证书（`electron-builder.release.cjs` 里 `forceCodeSigning: true`
且 `win.verifyUpdateCodeSignature: true`，`verify:release` 还要求时间戳与发布者匹配）。
仓库里另有 `electron-builder.azure.json` 与 `chore(repo): … unsigned-release gates` 提交，
说明未签名发布走的是 "CI 建 draft、签名在流水线里补" 的路径。

因此这一步能给的结论是：**除签名外，发布配置的每一项加固都在真实产物上被验证通过**；
签名需要在有证书的环境（或 CI）里补最后一道 `verify:release -RequireSignature`。

## 5. 本次操作对用户环境的影响

- **没有安装任何东西**：用户机器上仍是之前那份日常构建的 2.2.7（`D:\Program Files\Highlighter`），
  验证期间它一直存活（8 个进程），未被重启或替换。
- 构建产物在 `dist/release/`（约 290 MB，含两个 144 MB 的安装包）；临时跑的 portable 实例已结束并
  清理了它的 locator 与隔离数据根。`dist/release` 可随时删除。
- 构建带了 `--publish never`，没有向 GitHub 上传任何东西。
