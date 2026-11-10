//! 对真实 `contracts/host/host-contracts.json` 的严格校验（不允许 skip）。
//!
//! 该文件由 `scripts/rust/extract-host-contracts.js` 生成（格式见
//! `docs/plans/rust-migration/contract-format.md` §3），是 Rust 侧的合同输入。本测试
//! 只读取，不复制合同内容当第二份真相；固定的期望值都注明计划/格式文档来源。
//!
//! 任一断言失败都要能指出 role / limit id / document 名，方便判断是生成脚本还是
//! Rust 视图的问题。

use std::collections::BTreeSet;

use highlighter_contracts::{
    host_contracts_path, HostContracts, WindowRole, CAPTURE_DOCUMENT_SCHEMA_VERSION,
    CLIPBOARD_DB_USER_VERSION, DATA_ROOT_MARKER_VERSION, HOST_CONTRACTS_KIND,
    HOST_CONTRACTS_SCHEMA_VERSION, HOST_CONTRACTS_STATUS, RECORDING_PROJECT_SCHEMA_VERSION,
    RESOURCE_LIMIT_COUNT, USAGE_DB_USER_VERSION, WINDOW_ROLE_COUNT,
};
use serde_json::Value;

/// 读取合同文件。缺失/解析失败直接失败（产物已由 contract-inventory 落地，Rust 侧不再 skip）。
fn load_contracts(test_name: &str) -> HostContracts {
    let path = host_contracts_path();
    assert!(
        path.is_file(),
        "{test_name}: contract file missing at {} (run scripts/rust/extract-host-contracts.js --write)",
        path.display()
    );
    HostContracts::load(&path)
        .unwrap_or_else(|error| panic!("{test_name}: cannot parse {}: {error}", path.display()))
}

#[test]
fn contract_file_header_baseline_and_thirteen_roles() {
    let contracts = load_contracts("contract_file_header_baseline_and_thirteen_roles");

    assert_eq!(
        contracts.schema_version, HOST_CONTRACTS_SCHEMA_VERSION,
        "contract-format.md §3 schemaVersion"
    );
    assert_eq!(contracts.kind, HOST_CONTRACTS_KIND);
    assert_eq!(contracts.status, HOST_CONTRACTS_STATUS);
    assert!(
        !contracts.baseline.app_version.is_empty(),
        "baseline.appVersion"
    );
    assert!(
        !contracts.baseline.git_commit.is_empty(),
        "baseline.gitCommit"
    );
    assert!(!contracts.baseline.electron.is_empty(), "baseline.electron");
    assert!(!contracts.baseline.node.is_empty(), "baseline.node");

    assert_eq!(
        contracts.roles.len(),
        WINDOW_ROLE_COUNT,
        "plan §4.1 freezes 13 page roles, got {:?}",
        contracts
            .roles
            .iter()
            .map(|role| role.role.as_str())
            .collect::<Vec<_>>()
    );

    let mut seen_roles = BTreeSet::new();
    let mut seen_globals = BTreeSet::new();
    for role in WindowRole::ALL {
        let entry = contracts
            .role_contract(role)
            .unwrap_or_else(|| panic!("contract is missing role `{}`", role.as_str()));
        assert!(
            seen_roles.insert(role.as_str()),
            "role `{}` appears more than once",
            role.as_str()
        );
        assert!(
            seen_globals.insert(entry.global_object.as_str()),
            "role `{}` reuses globalObject `{}`",
            role.as_str(),
            entry.global_object
        );
        assert!(
            !entry.page.is_empty(),
            "role `{}` has no page path",
            role.as_str()
        );
        assert!(
            !entry.preload.is_empty(),
            "role `{}` has no preload",
            role.as_str()
        );
        assert!(
            !entry.global_object.is_empty(),
            "role `{}` has no globalObject",
            role.as_str()
        );
        assert!(
            !entry.methods.is_empty(),
            "role `{}` exposes no parsed methods (record it in knownGaps instead)",
            role.as_str()
        );
        for gap in &entry.known_gaps {
            let object = gap.as_object().unwrap_or_else(|| {
                panic!(
                    "role `{}`: knownGaps entries must be objects",
                    role.as_str()
                )
            });
            for field in ["kind", "reason", "source"] {
                let text = object.get(field).and_then(Value::as_str);
                assert!(
                    text.is_some_and(|value| !value.is_empty()),
                    "role `{}`: knownGaps entry missing `{field}`",
                    role.as_str()
                );
            }
        }
    }

    // 合同里不允许出现无法映射到 WindowRole 的角色字符串。
    for entry in &contracts.roles {
        assert!(
            entry.role.parse::<WindowRole>().is_ok(),
            "contract role `{}` is not a WindowRole variant",
            entry.role
        );
    }
}

#[test]
fn parsed_methods_are_consistent_with_declared_surfaces() {
    // contract-format.md §3 提取规则 3：invoke 通道必须在该 role 的 handles 中，
    // send 通道必须在 listeners 中；subscribe（main→renderer）不强制登记 receives。
    let contracts = load_contracts("parsed_methods_are_consistent_with_declared_surfaces");

    for entry in &contracts.roles {
        let mut method_names = BTreeSet::new();
        for method in &entry.methods {
            assert!(
                !method.name.is_empty(),
                "role `{}` has an unnamed method",
                entry.role
            );
            assert!(
                method_names.insert((method.name.as_str(), method.channel.as_str())),
                "role `{}` declares method `{}` on channel `{}` twice",
                entry.role,
                method.name,
                method.channel
            );
            assert!(
                matches!(method.kind.as_str(), "invoke" | "send" | "subscribe"),
                "role `{}` method `{}` has unsupported kind `{}`",
                entry.role,
                method.name,
                method.kind
            );
            assert!(
                !method.channel.is_empty(),
                "role `{}` method `{}` has no channel",
                entry.role,
                method.name
            );
            assert!(
                !method.source.is_empty(),
                "role `{}` method `{}` has no source location",
                entry.role,
                method.name
            );
            match method.kind.as_str() {
                "invoke" => assert!(
                    entry
                        .surface
                        .handles
                        .iter()
                        .any(|channel| channel == &method.channel),
                    "role `{}` invoke `{}` channel `{}` missing from surface.handles",
                    entry.role,
                    method.name,
                    method.channel
                ),
                "send" => assert!(
                    entry
                        .surface
                        .listeners
                        .iter()
                        .any(|channel| channel == &method.channel),
                    "role `{}` send `{}` channel `{}` missing from surface.listeners",
                    entry.role,
                    method.name,
                    method.channel
                ),
                _ => {}
            }
        }
    }
}

/// 计划 §9.1 的 8 项资源限制 ID（contract-format.md §3 的 `resourceLimits` 集合）。
const EXPECTED_RESOURCE_LIMIT_IDS: [&str; RESOURCE_LIMIT_COUNT] = [
    "capture.commit-receipts",
    "clipboard.protocol",
    "clipboard.thumbnail-cache",
    "long-capture",
    "recording.event-track",
    "recording.export-queue",
    "recording.gif",
    "recording.segments",
];

#[test]
fn resource_limits_hold_the_eight_frozen_entries() {
    let contracts = load_contracts("resource_limits_hold_the_eight_frozen_entries");

    assert_eq!(
        contracts.resource_limits.len(),
        RESOURCE_LIMIT_COUNT,
        "plan §9.1 freezes exactly 8 resource limits, got {}",
        contracts.resource_limits.len()
    );

    let actual_ids: BTreeSet<&str> = contracts
        .resource_limits
        .iter()
        .map(|limit| limit.id.as_str())
        .collect();
    let expected_ids: BTreeSet<&str> = EXPECTED_RESOURCE_LIMIT_IDS.into_iter().collect();
    assert_eq!(
        actual_ids, expected_ids,
        "resource limit id set drifted (plan §9.1 / contract-format.md §3)"
    );

    for limit in &contracts.resource_limits {
        assert!(
            limit
                .id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-'),
            "resource limit id `{}` is not stable dotted lower-case form",
            limit.id
        );
        assert!(
            limit.value.is_object() && !limit.value.as_object().expect("object").is_empty(),
            "resource limit `{}` value must be a non-empty object",
            limit.id
        );
        assert!(
            !limit.source.is_empty(),
            "resource limit `{}` has no source",
            limit.id
        );
        assert!(
            !limit.symbols.is_empty(),
            "resource limit `{}` has no source symbols",
            limit.id
        );
    }

    // 计划 §9.1 剪贴板协议行的基线值；格式示例见 contract-format.md §3。
    let clipboard = contracts
        .resource_limit("clipboard.protocol")
        .expect("resourceLimits must contain `clipboard.protocol` (contract-format.md §3)");
    assert_eq!(clipboard.source, "shared/clipboard-protocol.js");
    for symbol in ["MAX_FRAME", "MAX_HEADER", "MAX_CHUNK"] {
        assert!(
            clipboard.symbols.iter().any(|entry| entry == symbol),
            "clipboard.protocol symbols must include {symbol}"
        );
    }
    assert_eq!(
        clipboard.value["maxFrameBytes"].as_u64(),
        Some(1024 * 1024),
        "plan §9.1: clipboard frame 1 MiB"
    );
    assert_eq!(
        clipboard.value["maxHeaderBytes"].as_u64(),
        Some(512 * 1024),
        "plan §9.1: clipboard header 512 KiB"
    );
    assert_eq!(
        clipboard.value["maxPayloadChunkBytes"].as_u64(),
        Some(256 * 1024),
        "plan §9.1: clipboard payload chunk 256 KiB"
    );
}

#[test]
fn shared_schema_versions_match_plan_section_5_1() {
    let contracts = load_contracts("shared_schema_versions_match_plan_section_5_1");

    let expected_documents = [
        "capture-document",
        "clipboard-db",
        "data-root-marker",
        "recording-project",
        "settings-normalize",
        "usage-db",
    ];
    for document in expected_documents {
        assert!(
            contracts.shared_schema(document).is_some(),
            "sharedSchemas is missing `{document}` (plan §5.1)"
        );
    }

    for schema in &contracts.shared_schemas {
        assert!(
            !schema.document.is_empty(),
            "shared schema without document name"
        );
        assert!(
            !schema.path.is_empty(),
            "shared schema `{}` has no evidence path",
            schema.document
        );
        if let Some(version) = schema.version {
            assert!(
                version > 0,
                "shared schema `{}` has version 0",
                schema.document
            );
            assert!(
                schema
                    .version_symbol
                    .as_deref()
                    .is_some_and(|symbol| !symbol.is_empty()),
                "shared schema `{}` has a version but no versionSymbol",
                schema.document
            );
        } else {
            assert!(
                schema.version_symbol.is_none(),
                "shared schema `{}` has a versionSymbol without a version",
                schema.document
            );
        }
    }

    let capture = contracts
        .shared_schema("capture-document")
        .expect("capture-document schema");
    assert_eq!(
        capture.version,
        Some(u64::from(CAPTURE_DOCUMENT_SCHEMA_VERSION)),
        "plan §5.1 / shared/capture-document.js SCHEMA_VERSION"
    );

    let recording = contracts
        .shared_schema("recording-project")
        .expect("recording-project schema");
    assert_eq!(
        recording.version,
        Some(u64::from(RECORDING_PROJECT_SCHEMA_VERSION)),
        "plan §5.1 recording project v1"
    );

    let clipboard_db = contracts
        .shared_schema("clipboard-db")
        .expect("clipboard-db schema");
    assert_eq!(
        clipboard_db.user_version,
        Some(u64::from(CLIPBOARD_DB_USER_VERSION)),
        "plan §5.1: clipboard SQLite user_version=2"
    );

    let usage_db = contracts
        .shared_schema("usage-db")
        .expect("usage-db schema");
    assert_eq!(
        usage_db.user_version,
        Some(u64::from(USAGE_DB_USER_VERSION)),
        "plan §5.1: usage SQLite user_version=1"
    );

    let marker = contracts
        .shared_schema("data-root-marker")
        .expect("data-root-marker schema");
    assert_eq!(
        marker.version,
        Some(u64::from(DATA_ROOT_MARKER_VERSION)),
        "plan §5.1: data-root marker v3"
    );

    // settings normalize 没有 schema 版本；生成脚本显式写 null，而不是编一个数字。
    let settings = contracts
        .shared_schema("settings-normalize")
        .expect("settings-normalize schema");
    assert_eq!(settings.version, None);
    assert_eq!(settings.version_symbol, None);
}

#[test]
fn error_codes_are_unique_and_sourced() {
    let contracts = load_contracts("error_codes_are_unique_and_sourced");

    assert!(
        !contracts.error_codes.is_empty(),
        "contract must list errorCodes"
    );
    let mut codes = BTreeSet::new();
    for entry in &contracts.error_codes {
        assert!(!entry.code.is_empty(), "error code without value");
        assert!(
            codes.insert(entry.code.as_str()),
            "duplicate error code `{}` (contract-format.md §3: duplicates are merged)",
            entry.code
        );
        assert!(
            !entry.source.is_empty(),
            "error code `{}` has no source location",
            entry.code
        );
        assert!(
            !entry.direction.is_empty(),
            "error code `{}` has no direction (deny/block)",
            entry.code
        );
        assert!(
            !entry.meaning.is_empty(),
            "error code `{}` has no meaning",
            entry.code
        );
    }
}
