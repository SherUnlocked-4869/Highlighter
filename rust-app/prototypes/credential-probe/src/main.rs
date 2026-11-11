//! R0-06 合成凭据探针（Rust 侧）。
//!
//! 实测结论（见 docs/plans/rust-migration/r0-credential-migration.md）：
//! 本机 Electron 43.8.3 的 `safeStorage.encryptString` 在 Windows 上不是"裸 DPAPI 密文"，
//! 而是 Chromium OSCrypt 格式：`b"v10"` + 12 字节 nonce + AES-256-GCM 密文（含 16 字节 tag）。
//! 真正的 AES 密钥存放在 `userData/Local State` 的 `os_crypt.encrypted_key`（base64，
//! 前缀 `b"DPAPI"`，其余为 DPAPI 保护的 32 字节密钥）。
//!
//! 因此 Rust 迁移路径是：读取 Local State → DPAPI 解出 AES key → AES-256-GCM 解密/加密。
//! 只处理合成明文/密文，不读取真实设置/凭据文件。用法见同目录 README.md。

use std::path::{Path, PathBuf};

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
};

/// `CRYPTPROTECT_UI_FORBIDDEN`：迁移后台运行不弹 UI；与 Electron 一样不使用附加 entropy。
const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;
/// Electron/Chromium 在 Windows 上的 OSCrypt 前缀。
const OSCRYPT_PREFIX: &[u8] = b"v10";
/// Local State 中 DPAPI 保护密钥的 base64 前缀。
const DPAPI_KEY_PREFIX: &[u8] = b"DPAPI";
const GCM_NONCE_BYTES: usize = 12;

#[derive(Debug, Deserialize)]
struct SafestorageJson {
    #[serde(rename = "plaintextBase64")]
    plaintext_base64: String,
    #[serde(rename = "ciphertextBase64")]
    ciphertext_base64: String,
    #[serde(rename = "available", default)]
    available: bool,
    #[serde(rename = "roundtripOk", default)]
    roundtrip_ok: bool,
}

#[derive(Debug, Deserialize)]
struct LocalStateJson {
    #[serde(rename = "os_crypt")]
    os_crypt: Option<OsCryptJson>,
}

#[derive(Debug, Deserialize)]
struct OsCryptJson {
    #[serde(rename = "encrypted_key")]
    encrypted_key: String,
}

#[derive(Debug, Serialize)]
struct ProtectResult {
    probe: &'static str,
    scheme: &'static str,
    protect_ok: bool,
    ciphertext_base64: String,
    ciphertext_bytes: usize,
    plaintext_base64: String,
    plaintext_bytes: usize,
    error: String,
}

#[derive(Debug, Serialize)]
struct UnprotectResult {
    probe: &'static str,
    scheme: &'static str,
    unprotect_ok: bool,
    plaintext_matches: bool,
    plaintext_base64: String,
    plaintext_bytes: usize,
    error: String,
}

fn protect_dpapi(data: &[u8]) -> windows::core::Result<Vec<u8>> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )?;
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        let _ = LocalFree(Some(HLOCAL(output.pbData as _)));
    }
    Ok(bytes)
}

fn unprotect_dpapi(data: &[u8]) -> windows::core::Result<Vec<u8>> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let mut description: PWSTR = PWSTR::null();
    unsafe {
        CryptUnprotectData(
            &input,
            Some(&mut description),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )?;
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        let _ = LocalFree(Some(HLOCAL(output.pbData as _)));
        if !description.is_null() {
            let _ = LocalFree(Some(HLOCAL(description.as_ptr() as _)));
        }
    }
    Ok(bytes)
}

/// 读取 Electron/Chromium `Local State` 中的 OSCrypt 密钥（DPAPI 保护）。
fn load_oscrypt_key(local_state: &Path) -> Result<[u8; 32], String> {
    let raw = std::fs::read_to_string(local_state)
        .map_err(|error| format!("read Local State {local_state:?}: {error}"))?;
    let parsed: LocalStateJson =
        serde_json::from_str(&raw).map_err(|error| format!("parse Local State: {error}"))?;
    let encrypted_key = parsed
        .os_crypt
        .ok_or_else(|| "Local State: os_crypt missing".to_string())?
        .encrypted_key;
    let decoded = BASE64
        .decode(encrypted_key.as_bytes())
        .map_err(|error| format!("os_crypt.encrypted_key base64: {error}"))?;
    let dpapi_blob = decoded
        .strip_prefix(DPAPI_KEY_PREFIX)
        .ok_or_else(|| "os_crypt.encrypted_key does not start with DPAPI".to_string())?;
    let key = unprotect_dpapi(dpapi_blob).map_err(|error| format!("DPAPI key unwrap: {error}"))?;
    let key: [u8; 32] = key
        .as_slice()
        .try_into()
        .map_err(|_| format!("unexpected OSCrypt key length: {}", key.len()))?;
    Ok(key)
}

fn oscrypt_decrypt(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, String> {
    let body = data
        .strip_prefix(OSCRYPT_PREFIX)
        .ok_or_else(|| "ciphertext does not start with v10".to_string())?;
    if body.len() < GCM_NONCE_BYTES + 16 {
        return Err(format!("v10 ciphertext too short: {} bytes", body.len()));
    }
    let (nonce, ciphertext) = body.split_at(GCM_NONCE_BYTES);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|error| format!("AES key: {error}"))?;
    cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|error| format!("AES-256-GCM decrypt: {error}"))
}

fn oscrypt_encrypt(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|error| format!("AES key: {error}"))?;
    let mut nonce = [0u8; GCM_NONCE_BYTES];
    getrandom::getrandom(&mut nonce).map_err(|error| format!("nonce: {error}"))?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext)
        .map_err(|error| format!("AES-256-GCM encrypt: {error}"))?;
    let mut output = Vec::with_capacity(OSCRYPT_PREFIX.len() + GCM_NONCE_BYTES + ciphertext.len());
    output.extend_from_slice(OSCRYPT_PREFIX);
    output.extend_from_slice(&nonce);
    output.extend_from_slice(&ciphertext);
    Ok(output)
}

fn write_json(path: &PathBuf, value: &impl Serialize) -> Result<(), String> {
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(value).map_err(|error| error.to_string())?
    );
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(path, text).map_err(|error| error.to_string())
}

fn next_value(args: &[String], flag: &str) -> Result<String, String> {
    args.iter()
        .position(|arg| arg == flag)
        .and_then(|index| args.get(index + 1))
        .cloned()
        .ok_or_else(|| format!("missing argument for {flag}"))
}

fn command_protect(args: &[String]) -> Result<i32, String> {
    let plaintext = next_value(args, "--plaintext")?;
    let out_ciphertext = PathBuf::from(next_value(args, "--out-ciphertext")?);
    let out_json = PathBuf::from(next_value(args, "--out")?);
    let local_state = args
        .iter()
        .position(|arg| arg == "--local-state")
        .map(|index| PathBuf::from(&args[index + 1]));
    let plaintext_bytes = plaintext.as_bytes();

    let result = match local_state {
        Some(local_state_path) => match load_oscrypt_key(&local_state_path)
            .and_then(|key| oscrypt_encrypt(&key, plaintext_bytes))
        {
            Ok(ciphertext) => {
                if let Some(parent) = out_ciphertext.parent() {
                    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                std::fs::write(&out_ciphertext, format!("{}\n", BASE64.encode(&ciphertext)))
                    .map_err(|error| error.to_string())?;
                ProtectResult {
                    probe: "rust-oscrypt.protect",
                    scheme: "v10+aes-256-gcm (local-state key)",
                    protect_ok: true,
                    ciphertext_base64: BASE64.encode(&ciphertext),
                    ciphertext_bytes: ciphertext.len(),
                    plaintext_base64: BASE64.encode(plaintext_bytes),
                    plaintext_bytes: plaintext_bytes.len(),
                    error: String::new(),
                }
            }
            Err(error) => ProtectResult {
                probe: "rust-oscrypt.protect",
                scheme: "v10+aes-256-gcm (local-state key)",
                protect_ok: false,
                ciphertext_base64: String::new(),
                ciphertext_bytes: 0,
                plaintext_base64: BASE64.encode(plaintext_bytes),
                plaintext_bytes: plaintext_bytes.len(),
                error,
            },
        },
        None => match protect_dpapi(plaintext_bytes) {
            Ok(ciphertext) => {
                if let Some(parent) = out_ciphertext.parent() {
                    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                std::fs::write(&out_ciphertext, format!("{}\n", BASE64.encode(&ciphertext)))
                    .map_err(|error| error.to_string())?;
                ProtectResult {
                    probe: "rust-dpapi.protect",
                    scheme: "bare-dpapi",
                    protect_ok: true,
                    ciphertext_base64: BASE64.encode(&ciphertext),
                    ciphertext_bytes: ciphertext.len(),
                    plaintext_base64: BASE64.encode(plaintext_bytes),
                    plaintext_bytes: plaintext_bytes.len(),
                    error: String::new(),
                }
            }
            Err(error) => ProtectResult {
                probe: "rust-dpapi.protect",
                scheme: "bare-dpapi",
                protect_ok: false,
                ciphertext_base64: String::new(),
                ciphertext_bytes: 0,
                plaintext_base64: BASE64.encode(plaintext_bytes),
                plaintext_bytes: plaintext_bytes.len(),
                error: format!("{error}"),
            },
        },
    };
    write_json(&out_json, &result)?;
    println!(
        "{}",
        serde_json::to_string(&result).map_err(|error| error.to_string())?
    );
    Ok(if result.protect_ok { 0 } else { 1 })
}

fn command_unprotect(args: &[String]) -> Result<i32, String> {
    let out_json = PathBuf::from(next_value(args, "--out")?);
    let local_state = args
        .iter()
        .position(|arg| arg == "--local-state")
        .map(|index| PathBuf::from(&args[index + 1]));

    let (expected_plaintext, ciphertext) = if args.iter().any(|arg| arg == "--safestorage") {
        let path = PathBuf::from(next_value(args, "--safestorage")?);
        let raw =
            std::fs::read_to_string(&path).map_err(|error| format!("read {path:?}: {error}"))?;
        let parsed: SafestorageJson =
            serde_json::from_str(&raw).map_err(|error| format!("parse {path:?}: {error}"))?;
        let expected = BASE64
            .decode(parsed.plaintext_base64.as_bytes())
            .map_err(|error| format!("plaintextBase64: {error}"))?;
        let ciphertext = BASE64
            .decode(parsed.ciphertext_base64.as_bytes())
            .map_err(|error| format!("ciphertextBase64: {error}"))?;
        println!(
            "safeStorage metadata: available={} roundtripOk={} ciphertextBytes={}",
            parsed.available,
            parsed.roundtrip_ok,
            ciphertext.len()
        );
        (Some(expected), ciphertext)
    } else if args.iter().any(|arg| arg == "--ciphertext-file") {
        let path = PathBuf::from(next_value(args, "--ciphertext-file")?);
        let raw = std::fs::read(&path).map_err(|error| format!("read {path:?}: {error}"))?;
        let bytes = match std::str::from_utf8(&raw) {
            Ok(text) => BASE64.decode(text.trim()).unwrap_or_else(|_| raw.clone()),
            Err(_) => raw.clone(),
        };
        (None, bytes)
    } else {
        return Err(
            "unprotect requires --safestorage <json> or --ciphertext-file <path>".to_string(),
        );
    };

    let result = match local_state {
        Some(local_state_path) => {
            let key = load_oscrypt_key(&local_state_path);
            let decrypted = key.and_then(|key| oscrypt_decrypt(&key, &ciphertext));
            match decrypted {
                Ok(plaintext) => {
                    let matches = expected_plaintext
                        .as_ref()
                        .map(|expected| expected.as_slice() == plaintext.as_slice());
                    UnprotectResult {
                        probe: "rust-oscrypt.unprotect",
                        scheme: "v10+aes-256-gcm (local-state key)",
                        unprotect_ok: true,
                        plaintext_matches: matches.unwrap_or(false),
                        plaintext_base64: BASE64.encode(&plaintext),
                        plaintext_bytes: plaintext.len(),
                        error: String::new(),
                    }
                }
                Err(error) => UnprotectResult {
                    probe: "rust-oscrypt.unprotect",
                    scheme: "v10+aes-256-gcm (local-state key)",
                    unprotect_ok: false,
                    plaintext_matches: false,
                    plaintext_base64: String::new(),
                    plaintext_bytes: 0,
                    error,
                },
            }
        }
        None => {
            // 兼容路径：旧版/裸 DPAPI 密文；本机 Electron 43 会失败，作为负对照保留。
            let decrypted = unprotect_dpapi(&ciphertext);
            match decrypted {
                Ok(plaintext) => {
                    let matches = expected_plaintext
                        .as_ref()
                        .map(|expected| expected.as_slice() == plaintext.as_slice());
                    UnprotectResult {
                        probe: "rust-dpapi.unprotect",
                        scheme: "bare-dpapi",
                        unprotect_ok: true,
                        plaintext_matches: matches.unwrap_or(false),
                        plaintext_base64: BASE64.encode(&plaintext),
                        plaintext_bytes: plaintext.len(),
                        error: String::new(),
                    }
                }
                Err(error) => UnprotectResult {
                    probe: "rust-dpapi.unprotect",
                    scheme: "bare-dpapi",
                    unprotect_ok: false,
                    plaintext_matches: false,
                    plaintext_base64: String::new(),
                    plaintext_bytes: 0,
                    error: format!("{error}"),
                },
            }
        }
    };
    write_json(&out_json, &result)?;
    println!(
        "{}",
        serde_json::to_string(&result).map_err(|error| error.to_string())?
    );
    let success = result.unprotect_ok && (expected_plaintext.is_none() || result.plaintext_matches);
    Ok(if success { 0 } else { 1 })
}

fn command_self_test(args: &[String]) -> Result<i32, String> {
    let out_json = PathBuf::from(next_value(args, "--out")?);
    const SAMPLE: &str = "synthetic-r0-credential-do-not-use-0123456789 中文-样例";
    let key = [0x42u8; 32];
    let ciphertext = oscrypt_encrypt(&key, SAMPLE.as_bytes())?;
    let decrypted = oscrypt_decrypt(&key, &ciphertext)?;
    let result = UnprotectResult {
        probe: "rust-oscrypt.self-test",
        scheme: "v10+aes-256-gcm (in-memory key)",
        unprotect_ok: true,
        plaintext_matches: decrypted == SAMPLE.as_bytes(),
        plaintext_base64: BASE64.encode(&decrypted),
        plaintext_bytes: decrypted.len(),
        error: String::new(),
    };
    write_json(&out_json, &result)?;
    println!(
        "{}",
        serde_json::to_string(&result).map_err(|error| error.to_string())?
    );
    Ok(if result.plaintext_matches { 0 } else { 1 })
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("self-test");
    let result = match command {
        "protect" => command_protect(&args[1..]),
        "unprotect" => command_unprotect(&args[1..]),
        "self-test" => command_self_test(&args[1..]),
        other => Err(format!(
            "unknown command {other}; expected self-test|protect|unprotect"
        )),
    };
    match result {
        Ok(code) => std::process::exit(code),
        Err(message) => {
            eprintln!("credential-probe: {message}");
            std::process::exit(2);
        }
    }
}
