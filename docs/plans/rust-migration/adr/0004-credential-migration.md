# ADR-0004：凭据迁移格式（Electron safeStorage → Rust）

- 状态：**候选（有本机实测证据，未冻结）**
- 决定批次：R0-06；实施批次：R2（存储/设置）、R8（数据迁移）
- 日期：2026-11-10
- 关联计划：§2 D06/D07、§5.1、§5.3、§7 R0-06、§8 G0
- 证据文档：[r0-credential-migration.md](../r0-credential-migration.md)、
  [`rust-app/prototypes/credential-probe/`](../../../../rust-app/prototypes/credential-probe/)、
  [`scripts/rust/probe-safestorage.js`](../../../../scripts/rust/probe-safestorage.js)

## 1. 背景与问题

`main/services/credential-store.js` 把 API key 以 `safeStorage` 密文的 base64 存在 settings
（`credentials.apiKey`、`credentials.providerApiKeys[providerId]`）；加密不可用时写返回 false、
读回退 legacy 明文。迁移到 Rust 宿主必须回答：**旧密文能否在新宿主解密、以什么格式转存、
失败时如何保留数据且不静默清空**（计划 §5.3 第 5 条）。

## 2. 备选方案

| 方案 | 描述 | 优点 | 代价/风险 |
|---|---|---|---|
| A | 旧版 Electron 一次性受控转存到新格式 | 不依赖逆向格式 | 需要旧程序在场；违反 D08 终态，需登记退出批次 |
| B | Rust 读取 `userData/Local State` 的 DPAPI 保护密钥 + AES-256-GCM 解密/加密 | 实测双向兼容；无 Node 依赖 | 依赖 OSCrypt 格式与 Local State 布局；密钥材料安全要求；版本变化风险 |
| C | 保留原密文，要求用户重新填写 | 无解密依赖；不丢数据 | 用户摩擦；必须明确提示，不得静默清空 |

## 3. 实测条件与命令

- 机器/系统：Windows 11 build 26300.9711；Electron **43.8.3**（Chromium 150.0.7871.250）；
  rustc/cargo 1.97.1；同一用户安全上下文。
- 只使用合成明文（`synthetic-r0-credential-do-not-use-...`）；未读取真实设置/凭据。
- 复现命令见 [r0-credential-migration.md §6](../r0-credential-migration.md) 与探针 README。

## 4. 证据

| 验证项 | 结果 | 判定 |
|---|---|---|
| Electron safeStorage 可用性/元数据 | `available=true, backend=dpapi, roundtripOk=true`，45 B 明文 → 76 B 容器 | 通过 |
| 存储值格式解析 | `v10` + 12 B nonce + AES-256-GCM（45+16=61 B），76 = 3+12+61 | 通过 |
| 密钥来源 | `Local State` → `os_crypt.encrypted_key` = `base64("DPAPI"+blob)`，DPAPI 解出 32 B key（无 entropy） | 通过 |
| A: Electron 密文 → Rust 解密 | `unprotect_ok=true, plaintext_matches=true` | **通过** |
| B: Rust 加密 → Electron 解密 | `decryptOk=true`，Electron 解出明文与合成明文一致 | **通过** |
| 负样本: 裸 DPAPI 解存储值 | `数据无效 (0x8007000D)` | 按预期失败（旧假设被证伪） |
| 负样本: 截断/无前缀 | AES-GCM error / `does not start with v10` | 按预期失败 |
| 真实 key / 真实数据 | 未执行（禁止） | 未验证 |

## 5. 结论（建议）

1. **B 作为主路径（候选）**：迁移程序读取同一用户上下文下旧数据根的 `Local State`
   `os_crypt.encrypted_key` → DPAPI 解出 32 B AES key → 对 settings 中 base64 存储值做
   `v10` + AES-256-GCM 解密，转存为新宿主凭据格式（新格式本身另做 ADR/设计，不在本 ADR 冻结）。
2. **C 作为强制兜底**：任何解密失败/格式未知/Local State 缺失/安全策略禁用时不静默清空，
   保留原密文并在迁移报告中列出需要用户重填的 provider。
3. **A 仅作最后手段**：只在 B/C 都不可行时作为临时 sidecar，登记责任批次与退出验收（D08）。
4. 反向兼容（新宿主写、旧 Electron 读）仅在回退场景有意义；实测 Rust 加密可被 Electron
   `decryptString` 解开，但正式回退流程仍需独立验证，不能凭本 spike 声称"可双向互操作"。

## 6. 未解决限制

- 只验证 Electron 43.8.3 的 OSCrypt 格式；更早版本（裸 DPAPI）与未来版本（如 App-Bound v20）
  未验证。读取方必须做前缀/布局探测，失败回退 C。
- 真实产品 userData（`%APPDATA%\Highlighter`）、便携模式、自定义数据根下的 Local State 位置未接入验证。
- 多用户/漫游、DPAPI 跨机器、密钥轮换、迁移中断恢复、内存清零（zeroize）与审计脱敏未验证。
- Local State 属于敏感文件，迁移必须声明访问范围并禁止记录密钥/密文原文。

## 7. 责任批次与退出验收

- R2：凭据读取/写入接口与失败回退（C）实现。
- R8-01：真实数据副本迁移演练（合成 key 先验，真实 key 受控转存），迁移报告列出成功/重填/失败。
- 退出验收：G3 前证明正式运行环境无 Node/Electron 依赖；G4 前完成升级/回退演练与安全评审。

## 8. 变更记录

| 日期 | 变更 | 证据 |
|---|---|---|
| 2026-11-10 | 初稿：B 主路径 / C 兜底 / A 最后手段；本机双向实测通过 | [r0-credential-migration.md](../r0-credential-migration.md) |
