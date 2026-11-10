# R0-06 合成凭据迁移测试报告（safeStorage ↔ Rust）

日期：2026-11-10。状态：**R0 证据，ADR-0004 输入；G0 未通过前不冻结迁移格式**。
关联：[计划](../../2026-11-10-rust-migration-development-plan.md) §5.1/§5.3/§7 R0-06、
[r0-baseline.md](r0-baseline.md) §4.6、[研究](../../research/2026-11-10-rust-migration-feasibility.md) 凭据章节。

只使用合成明文/密文，未读取任何真实设置、真实凭据或真实 key。探针代码：
[`rust-app/prototypes/credential-probe/`](../../../rust-app/prototypes/credential-probe/)、
[`scripts/rust/probe-safestorage.js`](../../../scripts/rust/probe-safestorage.js)。
证据目录 `.tmp-r0-credential/`（gitignore，不提交）。

## 1. 关键发现（本机 Electron 43.8.3，非旧版 DOC 描述）

Windows 上 `safeStorage.encryptString` 的产物**不是"裸 DPAPI 密文"**，而是 Chromium OSCrypt 容器：

| 层 | 结构 | 本机实测 |
|---|---|---|
| 存储值 | `base64(OSCrypt 容器)`，即 `main/services/credential-store.js` 写在 `credentials.apiKey` 的内容 | 76 B（45 B 明文） |
| 容器 | `b"v10"` + 12 B random nonce + AES-256-GCM 密文（含 16 B tag） | `76 - 3 - 12 = 61 = 45 + 16`，吻合 |
| 密钥 | `userData/Local State` 的 `os_crypt.encrypted_key`：`base64(b"DPAPI" + DPAPI blob)`；DPAPI blob 解出 **32 B AES key**，无附加 entropy | encrypted_key 283 B，前缀 `DPAPI`；Rust DPAPI 解出 32 B |

因此"用任意 Rust DPAPI 库直接解密存储值"必然失败——**先解 Local State 密钥，再做 AES-256-GCM**
才是可行路径。负对照已实测：对整段存储值直接 `CryptUnprotectData` 返回 `数据无效 (0x8007000D)`。

## 2. 实测结果

| # | 方向 | 命令 | 结果 | 判定 |
|---|---|---|---|---|
| A | Electron 加密 → Rust 解密 | `unprotect --safestorage .tmp-r0-credential/safestorage.json --local-state "%APPDATA%/Electron/Local State"` | `unprotect_ok=true`、`plaintext_matches=true` | **通过** |
| B | Rust 加密 → Electron 解密 | `protect --plaintext ... --local-state ...` 后 `probe-safestorage.js --decrypt .tmp-r0-credential/rust-ciphertext.b64` | `decryptOk=true`，Electron 解出的 base64 与明文一致 | **通过** |
| C | Rust 自检（内存 key，AES-GCM 往返） | `self-test` | `plaintext_matches=true`（含中文/ASCII） | 通过 |
| D | 负样本：截断密文 | `unprotect --ciphertext-file invalid-truncated.bin --local-state ...` | `unprotect_ok=false`，`AES-256-GCM decrypt: aead::Error` | 按预期失败 |
| E | 负样本：无 v10 前缀随机字节 | 同上 | `ciphertext does not start with v10` | 按预期失败 |
| F | 负样本：整段存储值走裸 DPAPI | `unprotect --safestorage ...`（不带 `--local-state`） | `数据无效。(0x8007000D)` | 证明旧假设不成立 |

关键输出（原文摘录）：

```text
# A
$ cargo run --manifest-path rust-app/prototypes/credential-probe/Cargo.toml -- \
    unprotect --safestorage .tmp-r0-credential/safestorage.json \
    --local-state "$APPDATA/Electron/Local State" --out .tmp-r0-credential/rust-unprotect.json
safeStorage metadata: available=true roundtripOk=true ciphertextBytes=76
{"probe":"rust-oscrypt.unprotect","scheme":"v10+aes-256-gcm (local-state key)","unprotect_ok":true,
 "plaintext_matches":true,"plaintext_bytes":45,"error":""}

# B
{"probe":"rust-oscrypt.protect","protect_ok":true,"ciphertext_bytes":76,...}
{"probe":"safeStorage.decrypt-rust-ciphertext","decryptOk":true,"plaintextBase64":"...","error":""}
```

Electron 侧元数据（合成）：`safeStorage.isEncryptionAvailable()=true`、`backend=dpapi`、
`roundtripOk=true`、electron 43.8.3 / chromium 150.0.7871.250、ciphertextBytes=76。

## 3. 迁移方案评估（A/B/C，计划 §5.3）

| 方案 | 本机证据 | 结论/限制 |
|---|---|---|
| A. 旧版 Electron 一次性受控转存 | 未做端到端（需要旧 Electron 构建产物与本机数据副本）；格式已明确：写入方是 Electron，读出方是新宿主 | **保留为最后手段/兼容路径**；需要旧程序在场，违反"运行环境去 Node"终态，必须登记退出批次（D08） |
| B. Rust 读取 Local State 密钥 + AES-256-GCM 解密/加密 | **实测双向通过**（见 §2 A/B） | **候选可行**，但必须处理：userData/Local State 路径（便携/自定义数据根）、OSCrypt 前缀版本（v10/v11/v20 或未来变化）、密钥仅同用户上下文可用、密钥不得写日志/落盘、解密失败时保留原密文并走 C |
| C. 保留密文，要求用户重填 | 降级路径，无需解密 | **必须实现的兜底**：`isEncryptionAvailable=false`、格式未知、解密失败、跨用户/漫游、迁移中断时都走此路径；不得静默清空（计划 §5.3 第 5 条） |

**建议（ADR-0004 输入，非冻结）**：B 作为主路径，C 作为强制兜底，A 仅在同版本旧数据且 B/C 都不可行时使用。
G0 前仍需补：跨 Electron 版本/多用户/漫游/便携模式、Local State 密钥轮换与缺失、迁移中断恢复、
密钥材料内存清零（zeroize）与审计日志脱敏。未做真实 key 与真实数据验证。

## 4. 失败分支与错误处理

- 存储值非 base64 / 非 v10 前缀：明确失败（`does not start with v10`），不尝试"猜"。
- AES-GCM 校验失败（截断/被篡改/密钥不匹配）：返回可诊断错误，保留原密文并标记需重填（走 C）。
- Local State 缺失/`os_crypt.encrypted_key` 缺失/DPAPI 解 key 失败：走 C，不静默清空。
- `safeStorage.isEncryptionAvailable()=false`（企业策略/受限环境）：写入方旧程序本就不写密文；读取走 C/legacy 明文规则。
- 安全边界：Local State 与 settings 均属同一用户的安全上下文；迁移进程不得输出密钥、密文原文不得进日志/命令行（本次探针的合成密文仅作测试证据）。

## 5. 未解决限制

1. 只验证了本机 Electron 43.8.3 / Chromium 150 的 OSCrypt 格式；更早/未来 Electron 版本、Chrome App-Bound（v20）
   格式变化未验证，读取方必须做格式探测与失败回退，不得假定 v10 永久有效。
2. 真实产品 userData 路径（`%APPDATA%\Highlighter`）、便携模式、自定义数据根下的 Local State 位置未接入验证
   （本探针用的是裸 Electron 的 `%APPDATA%\Electron`）。
3. 多用户/漫游配置、DPAPI 跨机器不可解密等场景只做了原理判断，无实测。
4. 迁移中断、密钥轮换、证书/企业策略、内存清零与审计脱敏未验证。
5. 方案 B 依赖读取 Local State（含 DPAPI 保护密钥）；迁移程序必须声明这一敏感文件访问，
   并禁止记录密钥材料。G0 决策时需单独确认安全边界（计划 §4.3/§5.3）。

## 6. 复现

```powershell
cargo build --manifest-path rust-app/prototypes/credential-probe/Cargo.toml
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe --no-sandbox scripts/rust/probe-safestorage.js
cargo run --manifest-path rust-app/prototypes/credential-probe/Cargo.toml -- unprotect `
  --safestorage .tmp-r0-credential/safestorage.json `
  --local-state "$env:APPDATA/Electron/Local State" `
  --out .tmp-r0-credential/rust-unprotect.json
```

其它方向与负样本命令见 [探针 README](../../../rust-app/prototypes/credential-probe/README.md)。
