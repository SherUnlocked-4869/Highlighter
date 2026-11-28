# DEV-09 · API Key 迁移边界决策记录

2026-11-28 · 决策项：是否支持 API Key 跨机迁移 · 依据计划
[2026-11-28 后续开发与缺陷验收任务](2026-11-28-review-optimization-follow-up-tasks.md) §4 DEV-09、
[交接记录](2026-11-28-review-optimization-handoff.md) §5.5 第 4 条与 §7 的 N06 行。

**决策结论：维持现行策略（对应计划允许的验收结果 a）。** 备份包与单文件加密归档都是**数据包**，
不是凭据运输通道；换机恢复后用户需要重新填写 API Key。本记录不改变任何备份内容，只把既有契约
写成可验收的决策，并补上缺失的回归用例与用户指引的落点。

决策归属为**产品与凭据存储负责人**。本文由 docs-owner 依据当前产品代码契约整理；在负责人未
另行改判前，DEV-09 以“维持现行策略”关闭，凭据迁移若要做必须另开实现单（见 §6）。

---

## 1. 现行契约（代码即承诺）

### 1.1 目录模块备份 `main/services/data-root-backup.js`

模块头注释（第 14–37 行）把契约写死，其中第 23–24 行：

> Credentials, diagnostics/crash dumps, caches and runtime state are never copied. The settings
> module is a redacted `config.json` snapshot.

执行层共四道剥离，全部在**打包阶段**完成，与归档是否加密无关：

| 机制 | 位置 | 作用 |
|---|---|---|
| 目录名排除 | `EXCLUDED_DIRECTORY_NAMES`（135–149 行，含 `credentials`/`secrets`/`keys`） | 任何深度的凭据目录都不进包 |
| 文件名排除 | `EXCLUDED_FILE_PATTERN`（150 行：`credentials?`/`secrets?`/`.env`/`.key`/`.pem`/`.pfx`） | 凭据文件即使放在模块目录内也不进包 |
| JSON 键剥离 | `SECRET_KEY_PATTERN`（151 行）+ `redactSecrets()`（392–407 行） | `apiKey`/`apiKey(s)`/`providerApiKeys`/`credentials`/`password`/`token` 等键整体删除，最多记录 64 条键路径 |
| 设置模块快照 | `sanitizeSettingsConfig()`（409–417 行），由 `createBackup()` 的 settings 分支（1047–1064 行）写出 | 设置模块只写一份脱敏 `config.json`，且剥离 `captureHistory`（历史列表归 history 模块） |

恢复路径 `restoreBackup()`（1367–1652 行）只复制包内模块并发布包内 `config.json`（1510–1528 行），
从不读取当前机器上的凭据存储；恢复回执（1617–1642 行）只描述模块、尺寸、校验和与告警。

### 1.2 单文件加密归档 `main/services/encrypted-backup.js`

模块头（第 5–10 行）明确“既有 D04 备份是唯一事实来源，本模块从不自行遍历数据根”：

- 导出 `exportArchive()`（443–526 行）先调用既有 `createBackup()` 到临时目录（470–478 行），
  再把该目录整体压成 ZIP；只有提供密码时才把**这个已经脱敏的 ZIP** 加密封装（487–494 行）。
  加密增加的是机密性，不增加任何凭据内容。
- 导入 `inspectArchive()`（531–629 行）解密/解压后交给既有 `inspectBackup(..., { verifyChecksums: true })`
  （601–604 行），复用同一套清单与 sha256 校验，不另写一套凭据处理。
- 安全性质（32–40 行）：明文 ZIP 与派生密钥不落盘、不写日志、不在结果消息中回显密码；
  临时包在 `finally` 中删除（522–525 行）。

结论：**明文模块包与 `.hlbackup.zip`（加密或未加密）都剔除凭据**；“加密归档换机后仍需重配 Key”
是两条路径共同的行为，不是加密层的缺陷。

### 1.3 凭据本身的存储形态

`main/services/credential-store.js` 第 24–31 行：API Key 只以 **DPAPI（Electron `safeStorage`）**
密文写入设置存储（275/344/400 行 `safeStorage.encryptString`），加密不可用时仅保留进程内存，
**从不写明文**（278 行注释“Never fall back to plaintext”）。DPAPI 密文绑定当前 Windows 用户与机器，
复制到另一台机器本来也无法解密——这是维持现行策略的技术依据，也意味着“支持迁移”必须新增
“源机导出明文 → 目标机重加密”的显式凭据通道，而不是把 `credentials.*` 加进备份包。

### 1.4 调用方与 UI 落点

| 位置 | 行为 |
|---|---|
| `main/ipc/data-root-ipc.js`（3–23 行注释、95–192 行、214–222 行） | 两个归档通道复用 `controller.backupCreate` / `backupInspect` / `backupRestore`，不绕过 D04 契约；密码只在主进程内存中传递并在 finally 清空 |
| `main/domains/data-root/index.js`（318 行 `createDataRootBackup`、381 行 `restoreDataRootBackup`、418–421 行 locator 写入） | 创建前校验、写入暂停、恢复后写 locator 并重启；不含凭据逻辑 |
| `preload.js`（28–31、36、44 行） | 只暴露模块列表/密码/目录选择结果，不接收渲染层路径 |
| `config/routes/settings.js` 第 790 行 `backupSettings` 模板 | “本地备份”卡片先渲染 `config.settings-system.backup-key-hint`，然后才是创建/预览/恢复按钮；单文件归档卡片（`data-section="backup-archive"`）位于同一 section 内 |
| `shared/locales/config.js` | 三语指引：zh-CN 第 775 行、en-US 第 1970 行、zh-TW 第 3159 行 |

**用户可见的重新配置指引原文：**

- zh-CN：「密钥不包含在备份中，恢复后需要重新填写。」
- en-US：「Keys are not included in a backup; re-enter them after a restore.」
- zh-TW：「金鑰不包含在備份中，還原後需要重新填寫。」

该指引在设置页“系统与数据 → 本地备份”区块内、两种导出入口之上各出现一次；单文件归档卡片自身的
`backup-archive-hint` 只说“换机导入时输入同一密码”，不承诺凭据迁移。恢复/导入回执
（`backup-restored`、`backup-archive-restored`）只报告成功与重启，不承诺 Key 已迁移。

---

## 2. 决策

**维持现行策略：备份与归档不含 API Key；跨机恢复后由用户在设置页重新填写。** 不实现跨机凭据迁移。

理由（按优先级）：

1. **契约已存在且被强制执行**：D04 模块头、目录/文件排除、JSON 键剥离与设置模块脱敏共同保证
   任意模块备份都不含凭据；N06 归档只是复用该包。支持迁移等于改变已发布备份内容语义，必须显式
   重开格式与安全评审。
2. **技术边界**：凭据是 DPAPI 用户/机器绑定密文，跨机不可解密；真正的迁移需要源机明文导出接口
   与目标机重加密，属于新的凭据传输能力，不应藏在“备份”里默认发生。
3. **安全与最小意外**：备份包可能被复制到网盘/U 盘；把可用的 API Key 放进备份会把“数据泄露”
   升级为“账号泄露”。现行策略让“含敏感历史（截图/剪贴板/会话）”与“可直接使用的凭据”保持分离。
4. **用户成本可控**：API Key 数量少（主密钥 + 各 provider），重新填写是设置页可见、可引导的操作；
   历史、截图、录屏、设置等真正的数据负担仍可完整迁移。

**不做的事：** 不修改 `data-root-backup.js` / `encrypted-backup.js` 的备份内容，不新增凭据键，
不改变加密格式；`shared/locales/config.js` 的旧键全部保留（本次未改文案）。

---

## 3. 验收证据（本次补齐）

此前通用用例已覆盖一部分，但缺“两种归档类型都无 Key + 错误密码/篡改在写入前失败 + 指引文案”
的显式 DEV-09 断言。本次新增 6 个用例（共 70 项，全部通过）：

`test/data-root-backup.test.js`

- `DEV-09: a plaintext package never carries an API key and a restore keeps it out of the new root`
  —— 整包逐文件扫描（含清单与二进制）无 `sk-secret|sk-provider|sk-file-secret`；凭据文件名不外泄；
  清单记录 `redactedCount >= 1`；恢复到新根后 `credentials` 键不存在、其余设置保留、回执不回显凭据。
- `DEV-09: the reconfiguration guidance ships in all three languages with the backup controls`
  —— 三语 `backup-key-hint` 存在且语义为“不包含 + 重新填写”；设置页恰好渲染一次、位于单文件归档
  卡片之前；归档提示与恢复回执不宣称凭据迁移。

`test/n06-config-search-backup.test.js`

- `DEV-09: the unencrypted .hlbackup.zip carries no API key in any entry` —— 逐 ZIP 条目扫描（含
  descriptor/marker/modules.json/各模块文件）无 Key；`modules/settings/config.json` 无
  `credentials`/`providerApiKeys`；归档清单 `redactedCount >= 1`。
- `DEV-09: the encrypted archive payload decodes to a package with no API key` —— 密文本身无明文 Key
  与 ZIP 结构；用导出的 KDF 参数按 `inspectArchive` 的方式解密后，内层明文 ZIP 逐条目无 Key，
  设置快照无凭据键。
- `DEV-09: a wrong password or a tampered archive fails before the import writes anything` ——
  通过真实归档模块 + 导入 IPC：错误密码 / 篡改 authTag 均返回 `decrypt-failed`；不创建目标目录、
  不调用 `backupRestore`、无残留临时包、回执不回显密码。
- `DEV-09: the archive card sits under the shared API-key re-entry guidance` —— 归档卡片位于同一
  指引之下，归档提示/导入回执在三种语言中均不宣称 API Key 迁移。

既有相关用例（仍保留）：`excludes caches, staging, diagnostics and credentials`、
`restores a complete package into a new root and keeps the old root untouched`（`data-root-backup.test.js`）；
`an encrypted archive round-trips through scrypt + AES-256-GCM`、`a wrong password...`、
`tampering with the auth tag or ciphertext is detected`（`n06-config-search-backup.test.js`）。

**验证命令与结果：**

```powershell
node --test test/data-root-backup.test.js test/n06-config-search-backup.test.js
# → tests 70 / pass 70 / fail 0（2026-11-28，本机）

npm run check:review-evidence
# → ok（2 张登记表 / 50 工单 / 9 个必需 P0）

node scripts/check-js.js
# → Syntax check passed for 612 JavaScript files.
```

未执行（超出本决策项范围）：`npm test`、`npm run check` 全量、`verify:package` 与真机矩阵；
V09 的安装包真机往返仍待发布候选执行（见验收台账）。

---

## 4. 关闭判定

DEV-09 决策项可在以下条件全部满足时关闭；本次均已满足：

1. 决策记录存在并明确维持现行策略（本文）。
2. 明文模块包与 `.hlbackup.zip`（加密/未加密）都有“无 API Key”回归用例，且错误密码/篡改在写入前失败。
3. 用户可见的重新配置指引存在、三语齐全，并记录其位置（设置页“本地备份”区块，locale 第 775/1970/3159 行）。
4. 定向回归命令全绿；证据登记表 N06 行按事实更新。

**剩余（不阻塞本决策项，但阻塞“真机验收”结论）：** V09 需在安装的候选包上用真实数据根做
“加密归档 → 新根恢复 → 错误密码/篡改 → Ctrl+K 跳转 → 水印输出”的人工往返；本机只能给出自动化
结论，不能声称真机已通过。

---

## 5. 若产品日后决定“支持迁移”：开单实现范围（本次不实现）

届时不得只改加密层，必须整单评审，范围至少包含：

1. **新格式**：归档格式版本递增；标记 `credentialMigration: true` 与凭据种类清单，旧版本读取器
   必须能明确拒绝或忽略。读取路径保持“无标记 = 不迁移”。
2. **显式选择**：默认关闭；导出与导入都需要用户在凭据迁移选项上单独确认（不可复用“记住密码”类
   状态），并在确认文案中说明风险。
3. **仅加密归档**：只在用户设置了归档密码时允许携带凭据；明文归档永远不含凭据。
4. **目标机重加密**：源机导出的是短生命周期的明文凭据材料；导入成功后立即用目标机
   `safeStorage` 重新加密并校验回读，明文缓冲与临时文件在 `finally` 中清零/删除。
5. **旧包兼容**：旧归档（无凭据）继续按现行策略导入，缺 Key 时给出“重新填写”指引而非失败。
6. **失败保持原值**：错误密码、篡改、写入失败、迁移校验失败时目标机现有凭据保持不变，
   并回滚到导入前状态（沿用 `restoreBackup` 的回滚语义）。
7. **一次性测试 Key 验证**：用一次性 Key 跑完整导出-导入链，断言临时文件、应用日志、诊断包、
   普通（非加密）归档与错误回执中均无明文凭据；完成后作废该 Key。
8. **真机证据**：V09 需在安装候选上补“支持迁移”专项步骤与附件，晋级证据绑定签名资产。

在此之前，任何代码改动都应视为破坏“备份不含凭据”的既有契约，需要产品与凭据存储负责人重新决策。

---

## 6. 参考

- [后续开发与缺陷验收任务](2026-11-28-review-optimization-follow-up-tasks.md) §4 DEV-09、§2 V09
- [交接记录](2026-11-28-review-optimization-handoff.md) §5.5、§7
- [评审证据登记表](../evidence/2026-11-26-review-optimization-evidence.md) N06 行
- [5.1.1 后续验收台账](2026-11-28-follow-up-acceptance-status.md)
