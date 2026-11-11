# R0-06 合成凭据探针（Rust 侧）

验证 Electron `safeStorage` 密文与 Rust 的跨语言兼容性，只使用合成明文。
独立 Cargo 工程（不属于 `rust-app/` workspace；`[workspace]` 空表用于隔离）。

实测格式（本机 Electron 43.8.3）：safeStorage 存储值 = `b"v10"` + 12 B nonce +
AES-256-GCM 密文；AES key 在 `userData/Local State` 的 `os_crypt.encrypted_key`
（`base64(b"DPAPI" + DPAPI blob)`）。**裸 DPAPI 不能直接解密存储值**。
证据与结论见 [`docs/plans/rust-migration/r0-credential-migration.md`](../../../docs/plans/rust-migration/r0-credential-migration.md)。

## 命令（仓库根目录，PowerShell）

```powershell
# 0) 构建
cargo build --manifest-path rust-app/prototypes/credential-probe/Cargo.toml

# 1) Electron 生成合成密文（无窗口，15s 超时）
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe --no-sandbox scripts/rust/probe-safestorage.js

# 2) Rust 解密 Electron 密文并校验明文（A 方向）
cargo run --manifest-path rust-app/prototypes/credential-probe/Cargo.toml -- unprotect `
  --safestorage .tmp-r0-credential/safestorage.json `
  --local-state "$env:APPDATA/Electron/Local State" `
  --out .tmp-r0-credential/rust-unprotect.json

# 3) Rust 加密 → Electron 解密（B 方向）
cargo run --manifest-path rust-app/prototypes/credential-probe/Cargo.toml -- protect `
  --plaintext "synthetic-r0-credential-do-not-use-0123456789" `
  --local-state "$env:APPDATA/Electron/Local State" `
  --out-ciphertext .tmp-r0-credential/rust-ciphertext.b64 `
  --out .tmp-r0-credential/rust-protect.json
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe --no-sandbox `
  scripts/rust/probe-safestorage.js --decrypt .tmp-r0-credential/rust-ciphertext.b64 `
  --out .tmp-r0-credential/electron-decrypt.json

# 4) 本机 AES-GCM 自检（不依赖 Electron）
cargo run --manifest-path rust-app/prototypes/credential-probe/Cargo.toml -- self-test `
  --out .tmp-r0-credential/rust-self-test.json
```

负样本：`unprotect --ciphertext-file <path> --local-state ...`（截断/随机字节应失败）；
不带 `--local-state` 的裸 DPAPI 路径作为旧格式负对照（本机应返回 `0x8007000D`）。
`--local-state` 也可指向任意 Electron/Chromium 的 `Local State` 文件（同一用户上下文）。

## 边界

- 只处理合成明文与合成密文；不读取真实设置/凭据文件。
- 密钥材料不得打印/落盘；探针只在内存中使用解出的 AES key。
- 密文/日志写入 `.tmp-r0-credential/`（gitignore，不提交）。
