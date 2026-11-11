//! 依赖方向测试（计划 §3.2）。
//!
//! `contracts` 是纯数据层：除了 serde/serde_json，不允许引入 tauri、windows、sqlite、
//! 异步运行时、时钟/文件监听或任何其它 workspace crate。测试直接解析本 workspace 的
//! `Cargo.toml`，因此 Cargo 依赖写错时必须在这里失败，而不是靠 review 目测。

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

fn crates_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("contracts crate lives under rust-app/crates")
        .to_path_buf()
}

/// 提取 `[dependencies]`、`[dev-dependencies]`、`[build-dependencies]` 以及
/// `[target.'cfg(...)'.dependencies]` 段的依赖名（不含表头本身）。
///
/// 支持 `name.workspace = true` 这类 TOML 点号键：取第一个 `.` 之前的段作为 crate 名。
fn dependency_names(manifest: &str) -> BTreeSet<String> {
    let mut section = String::new();
    let mut names = BTreeSet::new();
    for raw in manifest.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            section = line
                .trim_matches(|c| c == '[' || c == ']')
                .to_ascii_lowercase();
            continue;
        }
        if !section.ends_with("dependencies") {
            continue;
        }
        let Some((key, _)) = line.split_once('=') else {
            continue;
        };
        let name = key.trim().split('.').next().unwrap_or("").trim();
        assert!(!name.is_empty(), "malformed dependency line: {raw}");
        names.insert(name.to_owned());
    }
    names
}

fn read_manifest(crate_name: &str) -> (PathBuf, String) {
    let path = crates_dir().join(crate_name).join("Cargo.toml");
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    (path, text)
}

#[test]
fn contracts_has_only_pure_data_dependencies() {
    let (path, manifest) = read_manifest("contracts");
    let names = dependency_names(&manifest);
    let allowed: BTreeSet<String> = ["serde", "serde_json"]
        .into_iter()
        .map(str::to_owned)
        .collect();
    let unexpected: Vec<&String> = names.difference(&allowed).collect();
    assert!(
        unexpected.is_empty(),
        "contracts/Cargo.toml at {} gained non-data dependencies: {unexpected:?}",
        path.display()
    );
    assert!(
        !names.iter().any(|name| name.starts_with("highlighter-")),
        "contracts must not depend on another workspace crate: {names:?}"
    );
}

#[test]
fn contracts_does_not_pull_host_storage_or_async_crates() {
    let (_, manifest) = read_manifest("contracts");
    let names = dependency_names(&manifest);
    for forbidden in [
        "tauri",
        "windows",
        "windows-sys",
        "windef",
        "rusqlite",
        "sqlx",
        "tokio",
        "async-std",
        "futures",
        "notify",
        "chrono",
        "time",
        "highlighter-core",
        "highlighter-storage",
        "highlighter-service-host",
        "highlighter-media",
        "highlighter-windows-platform",
    ] {
        assert!(
            !names.contains(forbidden),
            "plan §3.2 violation: contracts depends on `{forbidden}`"
        );
    }
}

#[test]
fn core_depends_on_contracts_but_not_on_platform_or_storage_implementations() {
    let (_, manifest) = read_manifest("core");
    let names = dependency_names(&manifest);
    assert!(
        names.contains("highlighter-contracts"),
        "core must depend on the contracts DTO crate: {names:?}"
    );
    for forbidden in [
        "tauri",
        "windows",
        "rusqlite",
        "sqlx",
        "tokio",
        "notify",
        "highlighter-storage",
        "highlighter-service-host",
        "highlighter-media",
        "highlighter-windows-platform",
    ] {
        assert!(
            !names.contains(forbidden),
            "plan §3.2: core must reach storage/platform through interfaces, not `{forbidden}`"
        );
    }
}

#[test]
fn windows_platform_stays_a_leaf_crate() {
    let (_, manifest) = read_manifest("windows-platform");
    let names = dependency_names(&manifest);
    assert!(
        names.is_empty(),
        "R0 windows-platform is a leaf: no dependencies yet (R3 adds windows-sys with an ADR): {names:?}"
    );
}
