//! 存储测试的临时目录工具。
//!
//! 使用 Cargo 为集成测试提供的 `CARGO_TARGET_TMPDIR`（位于 `rust-app/target/` 内，已被
//! `.gitignore` 排除）。**不使用** `std::env::temp_dir()`：本仓库的受限宿主机不给子进程
//! `%LOCALAPPDATA%\Temp` 写权限（见 AGENTS.md 的环境陷阱），而 target 目录始终可写。
//!
//! 每个测试用独立 label + 进程 id + 计数器，因此并行运行也不会互相覆盖；Drop 会清理
//! 自己的目录。所有路径都在仓库 target 内，绝不触碰真实用户数据根。

#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 所有测试临时根的共同父目录（Cargo 集成测试专用）。
fn base_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("highlighter-storage-tests")
}

pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    pub fn new(label: &str) -> Self {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = base_dir().join(format!("{}-{label}-{unique}", std::process::id()));
        fs::create_dir_all(&path)
            .unwrap_or_else(|error| panic!("create temp dir {}: {error}", path.display()));
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn child(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }

    /// 目录内条目名（排序后），用于断言没有残留临时文件。
    pub fn entries(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(&self.path)
            .unwrap_or_else(|error| panic!("read temp dir {}: {error}", self.path.display()))
            .map(|entry| {
                entry
                    .unwrap_or_else(|error| panic!("read temp entry: {error}"))
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        names.sort();
        names
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        // Windows 上可能仍有句柄延迟；清理失败不影响断言结果。
        let _ = fs::remove_dir_all(&self.path);
    }
}

pub fn read(path: &Path) -> Vec<u8> {
    fs::read(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

pub fn write(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap_or_else(|error| panic!("write {}: {error}", path.display()))
}
