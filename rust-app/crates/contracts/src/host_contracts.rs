//! `contracts/host/host-contracts.json` 的只读视图（格式见
//! `docs/plans/rust-migration/contract-format.md` §3）。
//!
//! 该文件由仓库根目录的 Node 提取脚本生成，属于另一并行任务的产物；Rust 侧只读取、
//! 不复制内容，也不依赖 Node。读取失败必须显式暴露，不允许回退到"内置默认合同"。
//!
//! R0 边界：这里只做结构解析与查找；运行时校验、权限映射与生产协议冻结属于 R1。

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::types::WindowRole;

/// 合同文件 schema 版本（contract-format.md §3 的草案 v1）。
pub const HOST_CONTRACTS_SCHEMA_VERSION: u32 = 1;
/// 合同文件 `kind` 常量。
pub const HOST_CONTRACTS_KIND: &str = "highlighter.host-contracts";
/// R0 草案状态。
pub const HOST_CONTRACTS_STATUS: &str = "r0-draft";
/// 计划 §4.1/§4.2 冻结的页面角色数量。
pub const WINDOW_ROLE_COUNT: usize = 13;
/// 计划 §9.1 冻结的资源限制项数。
pub const RESOURCE_LIMIT_COUNT: usize = 8;

// 计划 §5.1 与共享模块冻结的 schema 版本。文件存在时由测试交叉校验，
// 防止"代码升版、合同没升"（合同格式文档 §4/§5.1）。
/// `shared/capture-document.js` 的 `SCHEMA_VERSION`（截图文档 v3）。
pub const CAPTURE_DOCUMENT_SCHEMA_VERSION: u32 = 3;
/// 录屏项目 schema v1（计划 §5.1）。
pub const RECORDING_PROJECT_SCHEMA_VERSION: u32 = 1;
/// 剪贴板 SQLite `user_version`（计划 §5.1）。
pub const CLIPBOARD_DB_USER_VERSION: u32 = 2;
/// 用量 SQLite `user_version`（计划 §5.1）。
pub const USAGE_DB_USER_VERSION: u32 = 1;
/// 数据根迁移 marker v3（计划 §5.1）。
pub const DATA_ROOT_MARKER_VERSION: u32 = 3;

/// 仓库根目录：本 crate 固定在 `rust-app/crates/contracts`，向上三层即仓库根。
///
/// 这是编译期路径（`CARGO_MANIFEST_DIR`），因此测试不受进程当前目录影响。
#[must_use]
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("rust-app/crates/contracts is always three levels below the repository root")
        .to_path_buf()
}

/// 合同文件路径：`<repo>/contracts/host/host-contracts.json`。
#[must_use]
pub fn host_contracts_path() -> PathBuf {
    repo_root()
        .join("contracts")
        .join("host")
        .join("host-contracts.json")
}

/// 加载/解析合同文件时的错误。不静默降级。
#[derive(Debug)]
pub enum ContractError {
    /// 读取失败（文件缺失、权限、I/O）。
    Io {
        /// 出错的文件路径。
        path: PathBuf,
        /// 底层 I/O 错误。
        source: io::Error,
    },
    /// JSON 结构或语法不符合合同格式。
    Json {
        /// 出错的文件路径。
        path: PathBuf,
        /// 底层 serde_json 错误。
        source: serde_json::Error,
    },
}

impl fmt::Display for ContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ContractError::Io { path, source } => {
                write!(
                    formatter,
                    "failed to read host contracts {}: {source}",
                    path.display()
                )
            }
            ContractError::Json { path, source } => {
                write!(
                    formatter,
                    "failed to parse host contracts {}: {source}",
                    path.display()
                )
            }
        }
    }
}

impl std::error::Error for ContractError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            ContractError::Io { source, .. } => Some(source),
            ContractError::Json { source, .. } => Some(source),
        }
    }
}

/// 合同文件（R0 草案 v1）。字段与 contract-format.md §3 一一对应；
/// 未知的新增字段被忽略（向前兼容），已知字段的类型/必填性保持严格。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostContracts {
    /// 合同 schema 版本。
    pub schema_version: u32,
    /// 固定为 [`HOST_CONTRACTS_KIND`]。
    pub kind: String,
    /// 生命期状态（R0 为 `r0-draft`）。
    pub status: String,
    /// 基线版本信息。
    pub baseline: Baseline,
    /// 13 个页面角色。
    #[serde(default)]
    pub roles: Vec<RoleContract>,
    /// 权限拒绝/错误码。
    #[serde(default)]
    pub error_codes: Vec<ErrorCodeContract>,
    /// 计划 §9.1 的 8 项硬限制。
    #[serde(default)]
    pub resource_limits: Vec<ResourceLimitContract>,
    /// 计划 §5.1 的共享 schema 版本。
    #[serde(default)]
    pub shared_schemas: Vec<SharedSchemaContract>,
}

/// 基线版本信息（口径见 contract-format.md §3）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Baseline {
    /// `package.json` 的版本。
    pub app_version: String,
    /// 计划声明的源码基线提交；提取时记录实际 HEAD。
    pub git_commit: String,
    /// 基线 Electron 版本。
    pub electron: String,
    /// 基线 Node 版本。
    pub node: String,
}

/// 一个页面角色的合同。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleContract {
    /// 角色名，必须等于 [`WindowRole::as_str`] 之一。
    pub role: String,
    /// 页面路径（相对仓库根）。
    #[serde(default)]
    pub page: String,
    /// preload 文件。
    #[serde(default)]
    pub preload: String,
    /// 页面全局对象名（如 `electronAPI`）。
    #[serde(default)]
    pub global_object: String,
    /// 暴露的方法。
    #[serde(default)]
    pub methods: Vec<MethodContract>,
    /// `IPC_SURFACES` 的 handles/listeners。
    #[serde(default)]
    pub surface: SurfaceContract,
    /// 无法自动解析的项；形状按 contract-format.md 保持宽松。
    #[serde(default)]
    pub known_gaps: Vec<Value>,
}

/// 一个 preload 方法。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodContract {
    /// 方法名（preload 暴露对象上的键）。
    #[serde(default)]
    pub name: String,
    /// 调用方式：`invoke` | `send` | `subscribe`。
    #[serde(default)]
    pub kind: String,
    /// IPC channel。
    #[serde(default)]
    pub channel: String,
    /// 从源码记录的调用形式（参数名可省略）。
    #[serde(default)]
    pub call: String,
    /// 返回形态：invoke=Promise，send=void，subscribe=退订函数。
    #[serde(default)]
    pub returns: String,
    /// 源码位置，如 `preload.js:11`。
    #[serde(default)]
    pub source: String,
    /// 现有测试相对路径；没有就空数组。
    #[serde(default)]
    pub tests: Vec<String>,
}

/// `IPC_SURFACES` 权限面。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceContract {
    /// 该角色允许 handle 的通道。
    #[serde(default)]
    pub handles: Vec<String>,
    /// 该角色允许发送（send）的通道。
    #[serde(default)]
    pub listeners: Vec<String>,
    /// 主进程推送给该角色的通道（可选）。
    #[serde(default)]
    pub receives: Vec<String>,
}

/// 错误码/deny 分支。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorCodeContract {
    /// 机器码。
    pub code: String,
    /// 源码位置。
    #[serde(default)]
    pub source: String,
    /// 方向（如 `deny`）。
    #[serde(default)]
    pub direction: String,
    /// 含义说明。
    #[serde(default)]
    pub meaning: String,
}

/// 计划 §9.1 的一项资源限制。`value` 的具体形状由各项定义决定（对象）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceLimitContract {
    /// 稳定 ID（形如 `clipboard.protocol`）。
    pub id: String,
    /// 限制值（对象）。
    pub value: Value,
    /// 源码位置。
    #[serde(default)]
    pub source: String,
    /// 提取的源码符号。
    #[serde(default)]
    pub symbols: Vec<String>,
}

/// 共享 schema 版本登记（计划 §5.1）。
///
/// `version`/`versionSymbol` 允许为 `null`：例如 settings normalize 没有 schema 版本，
/// 生成脚本会显式写 null 而不是编造一个数字。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedSchemaContract {
    /// 对象名（如 `capture-document`）。
    pub document: String,
    /// 证据文件路径。
    #[serde(default)]
    pub path: String,
    /// schema 版本（SQLite 对象可为 `user_version`）。
    #[serde(default)]
    pub version: Option<u64>,
    /// 版本常量名；没有版本的模块为 null。
    #[serde(default)]
    pub version_symbol: Option<String>,
    /// SQLite `user_version`（仅数据库对象）。
    #[serde(default)]
    pub user_version: Option<u64>,
    /// 现有测试相对路径。
    #[serde(default)]
    pub tests: Vec<String>,
}

impl HostContracts {
    /// 从 JSON 字节解析。`<memory>` 标记表示没有磁盘路径（错误信息仍带该标记）。
    pub fn from_json_slice(bytes: &[u8]) -> Result<Self, ContractError> {
        serde_json::from_slice(bytes).map_err(|source| ContractError::Json {
            path: PathBuf::from("<memory>"),
            source,
        })
    }

    /// 从磁盘读取并解析。
    pub fn load(path: &Path) -> Result<Self, ContractError> {
        let bytes = fs::read(path).map_err(|source| ContractError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        serde_json::from_slice(&bytes).map_err(|source| ContractError::Json {
            path: path.to_path_buf(),
            source,
        })
    }

    /// 读取仓库默认位置的合同文件（[`host_contracts_path`]）。
    pub fn load_default() -> Result<Self, ContractError> {
        Self::load(&host_contracts_path())
    }

    /// 按角色查找合同。
    #[must_use]
    pub fn role_contract(&self, role: WindowRole) -> Option<&RoleContract> {
        self.roles.iter().find(|entry| entry.role == role.as_str())
    }

    /// 按稳定 ID 查找资源限制。
    #[must_use]
    pub fn resource_limit(&self, id: &str) -> Option<&ResourceLimitContract> {
        self.resource_limits.iter().find(|entry| entry.id == id)
    }

    /// 按对象名查找共享 schema 版本。
    #[must_use]
    pub fn shared_schema(&self, document: &str) -> Option<&SharedSchemaContract> {
        self.shared_schemas
            .iter()
            .find(|entry| entry.document == document)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_contract() -> HostContracts {
        let bytes = br#"{
          "schemaVersion": 1,
          "kind": "highlighter.host-contracts",
          "status": "r0-draft",
          "baseline": { "appVersion": "4.2.0", "gitCommit": "abc", "electron": "43.8.3", "node": "24.22.1" },
          "roles": [ {
            "role": "main",
            "page": "config/config.html",
            "preload": "preload.js",
            "globalObject": "electronAPI",
            "methods": [ {
              "name": "getSettings", "kind": "invoke", "channel": "settings:get",
              "call": "( )", "returns": "Promise<unknown>", "source": "preload.js:11", "tests": []
            } ],
            "surface": { "handles": ["settings:get"], "listeners": [] },
            "knownGaps": []
          } ],
          "errorCodes": [ { "code": "window-owner-mismatch", "source": "main/services/ipc-security.js", "direction": "deny", "meaning": "..." } ],
          "resourceLimits": [ { "id": "clipboard.protocol", "value": { "maxFrameBytes": 1048576 }, "source": "shared/clipboard-protocol.js", "symbols": ["MAX_FRAME"] } ],
          "sharedSchemas": [ { "document": "capture-document", "path": "shared/capture-document.js", "version": 3, "versionSymbol": "SCHEMA_VERSION", "tests": [] } ]
        }"#;
        HostContracts::from_json_slice(bytes).expect("synthetic contract parses")
    }

    #[test]
    fn parses_documented_shape_and_finds_entries() {
        let contracts = minimal_contract();
        assert_eq!(contracts.schema_version, HOST_CONTRACTS_SCHEMA_VERSION);
        assert_eq!(contracts.kind, HOST_CONTRACTS_KIND);
        assert_eq!(contracts.roles.len(), 1);

        let role = contracts
            .role_contract(WindowRole::Main)
            .expect("main role");
        assert_eq!(role.global_object, "electronAPI");
        assert_eq!(role.methods[0].kind, "invoke");
        assert_eq!(role.methods[0].channel, "settings:get");
        assert_eq!(role.surface.handles, ["settings:get"]);

        assert_eq!(
            contracts
                .resource_limit("clipboard.protocol")
                .expect("limit")
                .value["maxFrameBytes"],
            1_048_576
        );
        assert_eq!(
            contracts
                .shared_schema("capture-document")
                .expect("schema")
                .version,
            Some(3)
        );
        assert!(contracts.role_contract(WindowRole::Clipboard).is_none());
    }

    #[test]
    fn unknown_fields_are_ignored_but_bad_json_is_rejected() {
        let bytes = br#"{
          "schemaVersion": 1,
          "kind": "highlighter.host-contracts",
          "status": "r0-draft",
          "baseline": { "appVersion": "4.2.0", "gitCommit": "abc", "electron": "43.8.3", "node": "24.22.1", "futureField": "ignored" },
          "roles": [],
          "sharedSchemas": [
            { "document": "settings-normalize", "path": "main/services/settings-normalize.js", "version": null, "versionSymbol": null }
          ],
          "futureTopLevel": { "anything": true }
        }"#;
        let contracts = HostContracts::from_json_slice(bytes).expect("forward compatible");
        assert!(contracts.roles.is_empty());
        let settings = contracts
            .shared_schema("settings-normalize")
            .expect("schemaless module is recorded with null version");
        assert_eq!(settings.version, None);
        assert_eq!(settings.version_symbol, None);

        let error = HostContracts::from_json_slice(b"{ not json").expect_err("bad json");
        assert!(error.to_string().contains("<memory>"));
        assert!(matches!(error, ContractError::Json { .. }));
    }

    #[test]
    fn repo_root_contains_the_contract_format_document() {
        // 仓库内路径的稳定性检查；不读取合同本身，因此夹具未落地时也能通过。
        let root = repo_root();
        assert!(root
            .join("docs/plans/rust-migration/contract-format.md")
            .is_file());
        assert_eq!(
            host_contracts_path(),
            root.join("contracts/host/host-contracts.json")
        );
    }
}
