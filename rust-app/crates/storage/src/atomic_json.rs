//! 原子 JSON/字节写入（R0）。
//!
//! 语义：同目录创建唯一临时文件 → 写入 → `sync_all`（FlushFileBuffers）→ 关闭句柄 →
//! `fs::rename` 覆盖目标。Windows 上 `std::fs::rename` 使用 `MoveFileExW` +
//! `MOVEFILE_REPLACE_EXISTING`，在同一卷/NTFS 上原子替换目标；失败时旧文件保持不变。
//!
//! 临时文件由 [`TempGuard`] 管理：任何失败路径都会 best-effort 删除它，不残留
//! `*.tmp`。Windows 上若其它进程仍持有临时文件句柄，删除可能失败——此时返回原始错误，
//! 残留的临时文件不影响旧目标（后续 GC 可在 R2 清理）。

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::de::DeserializeOwned;
use serde::Serialize;

/// 默认 JSON 读取上限：8 MiB。设置/项目描述等小文件用它；截图文档另有 16 MiB 上限
/// （`shared/capture-document.js` 的 `MAX_DOCUMENT_BYTES`，R4 接入）。
pub const MAX_JSON_BYTES: u64 = 8 * 1024 * 1024;

/// `write_atomic`/`read_json` 的错误。读与写都带路径，便于诊断。
#[derive(Debug)]
pub enum StorageError {
    /// 文件系统 I/O 失败。
    Io {
        /// 出错路径。
        path: PathBuf,
        /// 底层错误。
        source: io::Error,
    },
    /// JSON 序列化/反序列化失败。
    Json {
        /// 出错路径。
        path: PathBuf,
        /// 底层 serde_json 错误。
        source: serde_json::Error,
    },
    /// 文件超过调用方给定的字节上限。
    TooLarge {
        /// 出错路径。
        path: PathBuf,
        /// 实际字节数。
        bytes: u64,
        /// 允许的上限。
        limit: u64,
    },
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StorageError::Io { path, source } => {
                write!(
                    formatter,
                    "storage I/O failed for {}: {source}",
                    path.display()
                )
            }
            StorageError::Json { path, source } => {
                write!(
                    formatter,
                    "storage JSON failed for {}: {source}",
                    path.display()
                )
            }
            StorageError::TooLarge { path, bytes, limit } => write!(
                formatter,
                "storage file {} is {bytes} bytes, above the {limit}-byte limit",
                path.display()
            ),
        }
    }
}

impl std::error::Error for StorageError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            StorageError::Io { source, .. } => Some(source),
            StorageError::Json { source, .. } => Some(source),
            StorageError::TooLarge { .. } => None,
        }
    }
}

fn io_error(path: &Path, source: io::Error) -> StorageError {
    StorageError::Io {
        path: path.to_path_buf(),
        source,
    }
}

/// 在目标所在目录创建唯一临时文件的 guard；未 `commit` 时 Drop 会删除它。
struct TempGuard {
    file: Option<File>,
    temp_path: PathBuf,
    /// 目标路径（仅用于错误信息）。
    destination: PathBuf,
    armed: bool,
}

impl TempGuard {
    fn create(destination: &Path) -> Result<Self, StorageError> {
        let parent = destination.parent().ok_or_else(|| {
            io_error(
                destination,
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "destination has no parent directory",
                ),
            )
        })?;
        let file_name = destination
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "data".to_owned());
        static COUNTER: AtomicU64 = AtomicU64::new(0);

        for _ in 0..64 {
            let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
            let candidate = parent.join(format!(
                ".{file_name}.{}.{}.tmp",
                std::process::id(),
                unique
            ));
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)
            {
                Ok(file) => {
                    return Ok(Self {
                        file: Some(file),
                        temp_path: candidate,
                        destination: destination.to_path_buf(),
                        armed: true,
                    })
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(source) => return Err(io_error(&candidate, source)),
            }
        }
        Err(io_error(
            destination,
            io::Error::new(
                io::ErrorKind::AlreadyExists,
                "could not allocate a unique staging file",
            ),
        ))
    }

    fn file_mut(&mut self) -> Result<&mut File, StorageError> {
        self.file.as_mut().ok_or_else(|| {
            io_error(
                &self.destination,
                io::Error::other("staging file already closed"),
            )
        })
    }

    /// 先同步并关闭句柄再 rename：Windows 上目标被本进程占用时 rename 会失败。
    fn close(&mut self) -> Result<(), StorageError> {
        if let Some(file) = self.file.take() {
            return file
                .sync_all()
                .map_err(|source| io_error(&self.temp_path, source));
        }
        Ok(())
    }

    fn commit(&mut self) {
        self.armed = false;
    }
}

impl Drop for TempGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.file = None;
        let _ = fs::remove_file(&self.temp_path);
    }
}

/// 原子写入字节。要求目标父目录存在（会自动 `create_dir_all`）。
///
/// 任何失败都不会覆盖已有目标文件；临时文件不残留（best effort）。
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), StorageError> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| {
            io_error(
                path,
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "destination has no parent directory",
                ),
            )
        })?;
    fs::create_dir_all(parent).map_err(|source| io_error(parent, source))?;

    let mut guard = TempGuard::create(path)?;
    guard
        .file_mut()?
        .write_all(bytes)
        .map_err(|source| io_error(guard.temp_path.as_path(), source))?;
    guard.close()?;

    // 同目录原子替换；Windows: MoveFileExW(MOVEFILE_REPLACE_EXISTING)。
    fs::rename(&guard.temp_path, path).map_err(|source| io_error(path, source))?;
    guard.commit();
    Ok(())
}

/// 以确定性 JSON（2 空格缩进 + 末尾单个换行）原子写入。
pub fn write_json_atomic<T: Serialize + ?Sized>(
    path: &Path,
    value: &T,
) -> Result<(), StorageError> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|source| StorageError::Json {
        path: path.to_path_buf(),
        source,
    })?;
    bytes.push(b'\n');
    write_atomic(path, &bytes)
}

/// 读取 JSON，默认上限 [`MAX_JSON_BYTES`]。
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, StorageError> {
    read_json_with_limit(path, MAX_JSON_BYTES)
}

/// 读取 JSON，并对文件字节数强制上限（在 `JSON.parse` 之前按字节拒绝）。
pub fn read_json_with_limit<T: DeserializeOwned>(
    path: &Path,
    limit: u64,
) -> Result<T, StorageError> {
    let metadata = fs::metadata(path).map_err(|source| io_error(path, source))?;
    if metadata.len() > limit {
        return Err(StorageError::TooLarge {
            path: path.to_path_buf(),
            bytes: metadata.len(),
            limit,
        });
    }
    let bytes = fs::read(path).map_err(|source| io_error(path, source))?;
    // 读后复核，避免 metadata 与读取之间的文件增长/替换绕过上限。
    if bytes.len() as u64 > limit {
        return Err(StorageError::TooLarge {
            path: path.to_path_buf(),
            bytes: bytes.len() as u64,
            limit,
        });
    }
    serde_json::from_slice(&bytes).map_err(|source| StorageError::Json {
        path: path.to_path_buf(),
        source,
    })
}
