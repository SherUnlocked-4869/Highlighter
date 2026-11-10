//! 开发/灰度隔离数据根 locator（计划 D07/R0、§5.3 第 1/6 步）。
//!
//! 目的：Rust 宿主在研发/灰度期使用**独立身份、独立 locator 文件、独立根目录**，不与
//! 现有 Electron 数据根互相接管。现有程序的 `Highlighter.location.json` **不被改写**
//! （计划 §5.3），本模块显式拒绝该文件名。
//!
//! R0 边界：只提供纯路径规则、locator JSON 读写与 generation 单调性。真实数据根迁移、
//! 停写协调、marker v1/v2/v3、复制/恢复都属于 R2-02，不在此实现。
//!
//! 安全约束（全部是纯函数，测试只在系统临时目录里建删除得掉的临时根）：
//!
//! - root 必须绝对、无 `.`/`..` 组件、不能是盘符根；
//! - 新旧 root 不能相同或互为父子（拒绝嵌套覆盖）；Windows 比较按 ASCII 大小写不敏感；
//! - locator `schemaVersion` 只接受当前版本，未知新版本拒绝写入；
//! - `generation` 只能递增，旧 writer 不能覆盖新 locator。

use std::fmt;
use std::path::{Component, Path, PathBuf};
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::atomic_json::{read_json_with_limit, write_json_atomic, StorageError};

/// 当前 locator schema 版本。未知**新**版本必须拒绝（不做静默降级）。
pub const LOCATOR_SCHEMA_VERSION: u32 = 1;
/// locator 文档 `kind`；用于识别写错的文件。
pub const LOCATOR_KIND: &str = "highlighter.rust-data-root";
/// 现有 Electron 程序的定位文件名：**只许识别，不许写**（计划 §5.3）。
pub const LEGACY_LOCATOR_FILE: &str = "Highlighter.location.json";
/// locator 文件读取上限（小文件；防止被伪造的大文件拖垮启动）。
pub const MAX_LOCATOR_BYTES: u64 = 64 * 1024;

/// Rust 宿主根的父目录名：`<LOCALAPPDATA>/HighlighterRust/`。
const BASE_DIRECTORY_NAME: &str = "HighlighterRust";

/// 数据根渠道：开发版与灰度版互相隔离（计划 D07）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DataRootChannel {
    /// 开发/自测渠道。
    Dev,
    /// 灰度/试用渠道。
    Gray,
}

impl DataRootChannel {
    /// 全部渠道。
    pub const ALL: [DataRootChannel; 2] = [DataRootChannel::Dev, DataRootChannel::Gray];

    /// 稳定字符串（出现在 locator 文档里）。
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            DataRootChannel::Dev => "dev",
            DataRootChannel::Gray => "gray",
        }
    }

    /// 独立 locator 文件名。必须与 [`LEGACY_LOCATOR_FILE`] 不同。
    #[must_use]
    pub fn locator_file_name(self) -> &'static str {
        match self {
            DataRootChannel::Dev => "Highlighter.rust-dev.location.json",
            DataRootChannel::Gray => "Highlighter.rust-gray.location.json",
        }
    }

    /// 默认数据根目录名（位于底座目录下）。
    #[must_use]
    pub fn directory_name(self) -> &'static str {
        match self {
            DataRootChannel::Dev => "HighlighterRustDev",
            DataRootChannel::Gray => "HighlighterRustGray",
        }
    }
}

impl fmt::Display for DataRootChannel {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for DataRootChannel {
    type Err = LocatorError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        DataRootChannel::ALL
            .into_iter()
            .find(|channel| channel.as_str() == value)
            .ok_or_else(|| LocatorError::UnknownChannel {
                found: value.to_owned(),
            })
    }
}

/// locator 操作错误。所有错误都带路径/值，不静默降级。
#[derive(Debug)]
pub enum LocatorError {
    /// 底层原子 JSON 读写失败。
    Storage(StorageError),
    /// root 不是绝对路径。
    RelativeRoot {
        /// 传入的 root。
        root: PathBuf,
    },
    /// root 含 `.` 或 `..` 组件（越界写法）。
    ParentTraversal {
        /// 传入的 root。
        root: PathBuf,
    },
    /// root 是盘符/卷根（不允许把数据根放在卷根）。
    VolumeRoot {
        /// 传入的 root。
        root: PathBuf,
    },
    /// root 含不能安全写进 UTF-8 JSON 的路径分量。
    NonUnicodeRoot {
        /// 传入的 root。
        root: PathBuf,
    },
    /// 新旧 root 相同或互为父子（拒绝嵌套覆盖）。
    NestedRoot {
        /// 候选 root。
        candidate: PathBuf,
        /// 已有的 root。
        existing: PathBuf,
    },
    /// 试图写现有 Electron 程序的 locator 文件。
    LegacyLocatorName {
        /// 被拒绝的路径。
        path: PathBuf,
    },
    /// locator schemaVersion 不受支持。
    UnsupportedSchemaVersion {
        /// 文件里的版本。
        found: u32,
        /// 支持的版本。
        expected: u32,
    },
    /// locator 文档 kind 不匹配。
    WrongKind {
        /// 文件里的 kind。
        found: String,
        /// 期望的 kind。
        expected: &'static str,
    },
    /// 渠道不匹配（例如把 dev locator 当 gray 用）。
    WrongChannel {
        /// 文件里的渠道。
        found: String,
        /// 期望的渠道。
        expected: String,
    },
    /// 无法识别的渠道字符串。
    UnknownChannel {
        /// 文件里的渠道。
        found: String,
    },
    /// 旧 generation 试图覆盖新 generation。
    StaleGeneration {
        /// 当前 generation。
        current: u64,
        /// 请求的 generation。
        requested: u64,
    },
}

impl fmt::Display for LocatorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LocatorError::Storage(error) => write!(formatter, "{error}"),
            LocatorError::RelativeRoot { root } => {
                write!(formatter, "data root must be absolute: {}", root.display())
            }
            LocatorError::ParentTraversal { root } => write!(
                formatter,
                "data root must not contain `.` or `..` components: {}",
                root.display()
            ),
            LocatorError::VolumeRoot { root } => write!(
                formatter,
                "data root must not be a volume root: {}",
                root.display()
            ),
            LocatorError::NonUnicodeRoot { root } => write!(
                formatter,
                "data root cannot be represented as UTF-8: {}",
                root.display()
            ),
            LocatorError::NestedRoot {
                candidate,
                existing,
            } => write!(
                formatter,
                "data root {} overlaps the existing root {} (nested roots are rejected)",
                candidate.display(),
                existing.display()
            ),
            LocatorError::LegacyLocatorName { path } => write!(
                formatter,
                "refusing to write the existing Electron locator {} (plan §5.3)",
                path.display()
            ),
            LocatorError::UnsupportedSchemaVersion { found, expected } => write!(
                formatter,
                "unsupported data-root locator schemaVersion {found} (expected {expected})"
            ),
            LocatorError::WrongKind { found, expected } => {
                write!(
                    formatter,
                    "unexpected locator kind `{found}` (expected `{expected}`)"
                )
            }
            LocatorError::WrongChannel { found, expected } => write!(
                formatter,
                "locator channel `{found}` does not match `{expected}`"
            ),
            LocatorError::UnknownChannel { found } => {
                write!(formatter, "unknown data-root channel `{found}`")
            }
            LocatorError::StaleGeneration { current, requested } => write!(
                formatter,
                "stale data-root generation {requested} (current generation is {current})"
            ),
        }
    }
}

impl std::error::Error for LocatorError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            LocatorError::Storage(error) => Some(error),
            _ => None,
        }
    }
}

impl From<StorageError> for LocatorError {
    fn from(error: StorageError) -> Self {
        LocatorError::Storage(error)
    }
}

impl From<std::io::Error> for LocatorError {
    fn from(source: std::io::Error) -> Self {
        LocatorError::Storage(StorageError::Io {
            path: PathBuf::from("<locator>"),
            source,
        })
    }
}

/// 隔离数据根 locator 文档（`Highlighter.rust-<channel>.location.json`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataRootLocator {
    /// 文档版本；只接受 [`LOCATOR_SCHEMA_VERSION`]。
    pub schema_version: u32,
    /// 固定为 [`LOCATOR_KIND`]。
    pub kind: String,
    /// 渠道（`dev`/`gray`）。
    pub channel: String,
    /// 数据根绝对路径（字符串形式写入 JSON）。
    pub root: String,
    /// 数据根 generation；只能递增。
    pub generation: u64,
}

impl DataRootLocator {
    /// 为渠道构造 locator 文档；只校验不写盘。
    pub fn for_channel(
        channel: DataRootChannel,
        root: &Path,
        generation: u64,
    ) -> Result<Self, LocatorError> {
        validate_data_root(root)?;
        Ok(Self {
            schema_version: LOCATOR_SCHEMA_VERSION,
            kind: LOCATOR_KIND.to_owned(),
            channel: channel.as_str().to_owned(),
            root: root
                .to_str()
                .ok_or_else(|| LocatorError::NonUnicodeRoot {
                    root: root.to_path_buf(),
                })?
                .to_owned(),
            generation,
        })
    }

    /// root 的 `PathBuf` 形式。
    #[must_use]
    pub fn root_path(&self) -> PathBuf {
        PathBuf::from(&self.root)
    }

    /// 解析并校验渠道字段。
    pub fn resolved_channel(&self) -> Result<DataRootChannel, LocatorError> {
        self.channel.parse()
    }

    /// 校验文档版本/kind/渠道/root 本身。
    pub fn validate(&self) -> Result<DataRootChannel, LocatorError> {
        if self.schema_version != LOCATOR_SCHEMA_VERSION {
            return Err(LocatorError::UnsupportedSchemaVersion {
                found: self.schema_version,
                expected: LOCATOR_SCHEMA_VERSION,
            });
        }
        if self.kind != LOCATOR_KIND {
            return Err(LocatorError::WrongKind {
                found: self.kind.clone(),
                expected: LOCATOR_KIND,
            });
        }
        let channel = self.resolved_channel()?;
        validate_data_root(&self.root_path())?;
        Ok(channel)
    }

    /// 校验文档属于给定渠道。
    pub fn validate_for(&self, channel: DataRootChannel) -> Result<(), LocatorError> {
        let found = self.validate()?;
        if found != channel {
            return Err(LocatorError::WrongChannel {
                found: self.channel.clone(),
                expected: channel.as_str().to_owned(),
            });
        }
        Ok(())
    }
}

/// 是否为现有 Electron 程序的定位文件名（**只许识别，不许写**）。
#[must_use]
pub fn is_legacy_locator_name(path: &Path) -> bool {
    path.file_name().is_some_and(|name| {
        name.to_string_lossy()
            .eq_ignore_ascii_case(LEGACY_LOCATOR_FILE)
    })
}

/// Rust 宿主的底座目录：`<LOCALAPPDATA>/HighlighterRust`。
///
/// 纯函数：显式接收输入，不读取环境变量，便于测试与后续定位策略替换。
#[must_use]
pub fn default_base_directory(local_app_data: &Path) -> PathBuf {
    local_app_data.join(BASE_DIRECTORY_NAME)
}

/// 渠道的 locator 文件路径：`<base>/Highlighter.rust-<channel>.location.json`。
#[must_use]
pub fn locator_path(base: &Path, channel: DataRootChannel) -> PathBuf {
    base.join(channel.locator_file_name())
}

/// 渠道的默认数据根目录：`<base>/HighlighterRust<Dev|Gray>`。
#[must_use]
pub fn default_data_root(base: &Path, channel: DataRootChannel) -> PathBuf {
    base.join(channel.directory_name())
}

/// 校验一个候选数据根：绝对、无 `.`/`..`、不是卷根、可安全写入 UTF-8 JSON。
pub fn validate_data_root(root: &Path) -> Result<(), LocatorError> {
    if !root.is_absolute() {
        return Err(LocatorError::RelativeRoot {
            root: root.to_path_buf(),
        });
    }
    // `Path::components()` 会归一化掉中间的 `.`（例如 `C:\a\.\b`），所以除组件检查外
    // 还要按原始字符串扫描 `.`/`..` 段，避免"看起来规范"的越界写法混过去。
    let contains_traversal_segment = root
        .to_string_lossy()
        .split(['\\', '/'])
        .any(|segment| segment == "." || segment == "..");
    if contains_traversal_segment
        || root
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(LocatorError::ParentTraversal {
            root: root.to_path_buf(),
        });
    }
    if root.file_name().is_none() {
        return Err(LocatorError::VolumeRoot {
            root: root.to_path_buf(),
        });
    }
    if root.to_str().is_none() {
        return Err(LocatorError::NonUnicodeRoot {
            root: root.to_path_buf(),
        });
    }
    Ok(())
}

/// 拒绝两个 root 相同或互为父子（计划 §5.3 第 1 步：拒绝嵌套覆盖）。
pub fn ensure_not_nested(candidate: &Path, existing: &Path) -> Result<(), LocatorError> {
    if paths_overlap(candidate, existing) {
        return Err(LocatorError::NestedRoot {
            candidate: candidate.to_path_buf(),
            existing: existing.to_path_buf(),
        });
    }
    Ok(())
}

/// 读取渠道 locator；文件不存在返回 `Ok(None)`（首次启动），存在则严格校验。
pub fn load_locator(
    base: &Path,
    channel: DataRootChannel,
) -> Result<Option<DataRootLocator>, LocatorError> {
    let path = locator_path(base, channel);
    if !path.exists() {
        return Ok(None);
    }
    let document: DataRootLocator = read_json_with_limit(&path, MAX_LOCATOR_BYTES)?;
    document.validate_for(channel)?;
    Ok(Some(document))
}

/// 原子写入渠道 locator，并强制 generation 单调递增。
///
/// - 首次写入任何 generation 都接受；
/// - 后续写入必须 `generation >` 现有 generation，且不同 root 时不得嵌套；
/// - 绝不写 [`LEGACY_LOCATOR_FILE`]（路径由渠道固定，另加显式防御）。
pub fn store_locator(
    base: &Path,
    channel: DataRootChannel,
    document: &DataRootLocator,
) -> Result<(), LocatorError> {
    document.validate_for(channel)?;
    let path = locator_path(base, channel);
    if is_legacy_locator_name(&path) {
        return Err(LocatorError::LegacyLocatorName { path });
    }

    if let Some(existing) = load_locator(base, channel)? {
        if document.generation <= existing.generation {
            return Err(LocatorError::StaleGeneration {
                current: existing.generation,
                requested: document.generation,
            });
        }
        if !same_path(&document.root_path(), &existing.root_path()) {
            ensure_not_nested(&document.root_path(), &existing.root_path())?;
        }
    }

    write_json_atomic(&path, document)?;
    Ok(())
}

/// 解析当前渠道的数据根：locator 存在时用 locator，否则返回默认隔离根（不写盘）。
pub fn resolve_data_root(base: &Path, channel: DataRootChannel) -> Result<PathBuf, LocatorError> {
    match load_locator(base, channel)? {
        Some(document) => Ok(document.root_path()),
        None => {
            let root = default_data_root(base, channel);
            validate_data_root(&root)?;
            Ok(root)
        }
    }
}

/// 生成"切换数据根"的下一份 locator 文档（纯函数，不写盘；写入用 [`store_locator`]）。
///
/// 要求目录不嵌套、generation 严格递增；调用方先完成停写/复制/校验
/// （计划 §5.3 第 2～4 步，R2-02）再原子写 locator。
pub fn switch_data_root(
    current: &DataRootLocator,
    candidate_root: &Path,
    requested_generation: u64,
) -> Result<DataRootLocator, LocatorError> {
    let channel = current.validate()?;
    validate_data_root(candidate_root)?;
    ensure_not_nested(candidate_root, &current.root_path())?;
    if requested_generation <= current.generation {
        return Err(LocatorError::StaleGeneration {
            current: current.generation,
            requested: requested_generation,
        });
    }
    DataRootLocator::for_channel(channel, candidate_root, requested_generation)
}

/// Windows 路径比较按 ASCII 大小写不敏感（完整 Unicode case folding 不在 R0 范围，
/// 这里只是防止同一目录写成不同字母大小写造成伪"新根"）。
fn comparable_components(path: &Path) -> Vec<String> {
    path.components()
        .map(|component| match component {
            Component::Prefix(prefix) => prefix.as_os_str().to_string_lossy().to_ascii_lowercase(),
            Component::RootDir => std::path::MAIN_SEPARATOR.to_string(),
            Component::CurDir => ".".to_owned(),
            Component::ParentDir => "..".to_owned(),
            Component::Normal(part) => part.to_string_lossy().to_ascii_lowercase(),
        })
        .collect()
}

fn path_within(child: &Path, ancestor: &Path) -> bool {
    let child = comparable_components(child);
    let ancestor = comparable_components(ancestor);
    child.len() >= ancestor.len()
        && ancestor
            .iter()
            .zip(&child)
            .all(|(left, right)| left == right)
}

fn paths_overlap(first: &Path, second: &Path) -> bool {
    path_within(first, second) || path_within(second, first)
}

fn same_path(first: &Path, second: &Path) -> bool {
    paths_overlap(first, second)
        && comparable_components(first).len() == comparable_components(second).len()
}
