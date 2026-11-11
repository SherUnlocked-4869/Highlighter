//! `data_root` 的集成测试：隔离 locator、路径安全、generation 单调性。
//!
//! 所有路径都来自系统临时目录；测试不会创建/删除真实数据根，也不会写
//! `Highlighter.location.json`。

mod support;

use std::fs;
use std::path::{Path, PathBuf};

use highlighter_storage::{
    default_base_directory, default_data_root, ensure_not_nested, is_legacy_locator_name,
    load_locator, locator_path, resolve_data_root, store_locator, switch_data_root,
    validate_data_root, DataRootChannel, DataRootLocator, LocatorError, LEGACY_LOCATOR_FILE,
    LOCATOR_KIND, LOCATOR_SCHEMA_VERSION,
};
use serde_json::json;

use support::TempDir;

fn write_raw_locator(base: &Path, channel: DataRootChannel, document: &serde_json::Value) {
    fs::create_dir_all(base).expect("create locator base");
    let path = locator_path(base, channel);
    support::write(
        &path,
        &serde_json::to_vec_pretty(document).expect("serialize raw locator"),
    );
}

#[test]
fn channels_keep_isolated_identity_and_never_reuse_the_electron_locator() {
    let mut locator_names = Vec::new();
    let mut directory_names = Vec::new();

    for channel in DataRootChannel::ALL {
        assert!(
            !is_legacy_locator_name(Path::new(channel.locator_file_name())),
            "channel `{channel}` must not reuse the Electron locator file name"
        );
        assert_ne!(channel.locator_file_name(), LEGACY_LOCATOR_FILE);
        assert!(
            !locator_names.contains(&channel.locator_file_name()),
            "channels must use distinct locator files"
        );
        assert!(
            !directory_names.contains(&channel.directory_name()),
            "channels must use distinct data-root directories"
        );
        assert!(!channel.as_str().is_empty());
        locator_names.push(channel.locator_file_name());
        directory_names.push(channel.directory_name());
    }

    assert!(is_legacy_locator_name(Path::new(LEGACY_LOCATOR_FILE)));
    assert!(
        is_legacy_locator_name(Path::new("highlighter.LOCATION.json")),
        "locator identity must be case-insensitive on Windows"
    );

    assert_eq!(DataRootChannel::Dev.as_str(), "dev");
    assert_eq!(DataRootChannel::Gray.as_str(), "gray");
    assert_eq!(
        "dev".parse::<DataRootChannel>().expect("parse dev"),
        DataRootChannel::Dev
    );
    assert!(matches!(
        "beta".parse::<DataRootChannel>(),
        Err(LocatorError::UnknownChannel { .. })
    ));
}

#[test]
fn default_layout_is_derived_only_from_the_explicit_base() {
    let temp = TempDir::new("data-root-layout");
    let base = default_base_directory(temp.path());

    assert_eq!(base, temp.path().join("HighlighterRust"));
    assert_eq!(
        locator_path(&base, DataRootChannel::Dev),
        base.join("Highlighter.rust-dev.location.json")
    );
    assert_eq!(
        locator_path(&base, DataRootChannel::Gray),
        base.join("Highlighter.rust-gray.location.json")
    );
    assert_eq!(
        default_data_root(&base, DataRootChannel::Dev),
        base.join("HighlighterRustDev")
    );
    assert_eq!(
        default_data_root(&base, DataRootChannel::Gray),
        base.join("HighlighterRustGray")
    );
}

#[test]
fn validates_absolute_roots_and_rejects_traversal_or_volume_roots() {
    let temp = TempDir::new("data-root-validate");
    let base = temp.path().to_path_buf();

    validate_data_root(&base.join("DataRoot")).expect("absolute normal root");

    assert!(matches!(
        validate_data_root(Path::new("relative-root")),
        Err(LocatorError::RelativeRoot { .. })
    ));
    assert!(matches!(
        validate_data_root(Path::new("")),
        Err(LocatorError::RelativeRoot { .. })
    ));
    assert!(matches!(
        validate_data_root(&base.join("nested").join("..").join("escape")),
        Err(LocatorError::ParentTraversal { .. })
    ));
    assert!(matches!(
        validate_data_root(&base.join(".").join("child")),
        Err(LocatorError::ParentTraversal { .. })
    ));

    #[cfg(windows)]
    {
        assert!(matches!(
            validate_data_root(Path::new("C:\\")),
            Err(LocatorError::VolumeRoot { .. })
        ));
        assert!(matches!(
            validate_data_root(Path::new("C:relative")),
            Err(LocatorError::RelativeRoot { .. })
        ));
    }
}

#[test]
fn nested_roots_are_rejected_in_both_directions_but_siblings_are_allowed() {
    let temp = TempDir::new("data-root-nested");
    let root = temp.path().join("DataRoot");
    let child = root.join("nested-root");
    let parent = temp.path().to_path_buf();
    let sibling = temp.path().join("OtherRoot");

    for (candidate, existing) in [
        (&child, &root),
        (&root, &child),
        (&root, &root),
        (&parent, &root),
    ] {
        assert!(
            matches!(
                ensure_not_nested(candidate, existing),
                Err(LocatorError::NestedRoot { .. })
            ),
            "expected NestedRoot for candidate={} existing={}",
            candidate.display(),
            existing.display()
        );
    }
    ensure_not_nested(&sibling, &root).expect("sibling roots are independent");
}

#[cfg(windows)]
#[test]
fn windows_path_comparison_is_ascii_case_insensitive() {
    let temp = TempDir::new("data-root-case");
    let root = temp.path().join("DataRoot");
    let upper = PathBuf::from(root.to_string_lossy().to_ascii_uppercase());
    assert!(matches!(
        ensure_not_nested(&upper, &root),
        Err(LocatorError::NestedRoot { .. })
    ));
    let child_upper = PathBuf::from(root.join("Child").to_string_lossy().to_ascii_uppercase());
    assert!(matches!(
        ensure_not_nested(&child_upper, &root),
        Err(LocatorError::NestedRoot { .. })
    ));
}

#[test]
fn first_locator_roundtrip_creates_only_the_rust_locator() {
    let temp = TempDir::new("data-root-roundtrip");
    let base = default_base_directory(temp.path());

    assert!(load_locator(&base, DataRootChannel::Dev)
        .expect("missing locator is not an error")
        .is_none());

    let root = default_data_root(&base, DataRootChannel::Dev);
    let document =
        DataRootLocator::for_channel(DataRootChannel::Dev, &root, 1).expect("build first locator");
    store_locator(&base, DataRootChannel::Dev, &document).expect("store locator");

    assert!(locator_path(&base, DataRootChannel::Dev).is_file());
    assert!(
        !base.join(LEGACY_LOCATOR_FILE).exists(),
        "the Electron locator must never be written (plan §5.3)"
    );
    let loaded = load_locator(&base, DataRootChannel::Dev)
        .expect("load")
        .expect("locator present");
    assert_eq!(loaded, document);
    assert_eq!(
        resolve_data_root(&base, DataRootChannel::Dev).expect("resolve"),
        root
    );

    // 渠道隔离：gray 不会读到 dev 的 locator，也不会创建任何目录。
    assert!(load_locator(&base, DataRootChannel::Gray)
        .expect("gray locator")
        .is_none());
    let expected_gray = default_data_root(&base, DataRootChannel::Gray);
    assert_eq!(
        resolve_data_root(&base, DataRootChannel::Gray).expect("gray resolve"),
        expected_gray
    );
    assert!(
        !expected_gray.exists(),
        "resolve must not create directories"
    );

    let text = String::from_utf8(support::read(&locator_path(&base, DataRootChannel::Dev)))
        .expect("locator is UTF-8");
    assert!(text.contains("\"schemaVersion\": 1"));
    assert!(text.contains(LOCATOR_KIND));
    assert!(text.contains("\"channel\": \"dev\""));
    assert!(text.contains("\"generation\": 1"));
    assert_eq!(temp.entries(), ["HighlighterRust".to_owned()]);
}

#[test]
fn unknown_locator_schema_version_is_rejected_on_load_and_store() {
    let temp = TempDir::new("data-root-schema");
    let base = default_base_directory(temp.path());
    let channel = DataRootChannel::Dev;
    let root = default_data_root(&base, channel);
    let root_text = root.to_string_lossy().into_owned();

    for version in [0u32, 2, 99] {
        write_raw_locator(
            &base,
            channel,
            &json!({
                "schemaVersion": version,
                "kind": LOCATOR_KIND,
                "channel": "dev",
                "root": root_text,
                "generation": 1
            }),
        );
        match load_locator(&base, channel) {
            Err(LocatorError::UnsupportedSchemaVersion { found, expected }) => {
                assert_eq!(found, version);
                assert_eq!(expected, LOCATOR_SCHEMA_VERSION);
            }
            other => panic!("version {version}: expected UnsupportedSchemaVersion, got {other:?}"),
        }
    }

    let mut document = DataRootLocator::for_channel(channel, &root, 1).expect("build locator");
    document.schema_version = LOCATOR_SCHEMA_VERSION + 1;
    assert!(matches!(
        store_locator(&base, channel, &document),
        Err(LocatorError::UnsupportedSchemaVersion { .. })
    ));
}

#[test]
fn wrong_kind_or_channel_is_rejected() {
    let temp = TempDir::new("data-root-kind");
    let base = default_base_directory(temp.path());
    let channel = DataRootChannel::Gray;
    let root = default_data_root(&base, channel);
    let root_text = root.to_string_lossy().into_owned();

    write_raw_locator(
        &base,
        channel,
        &json!({
            "schemaVersion": 1, "kind": "other", "channel": "gray",
            "root": root_text, "generation": 1
        }),
    );
    assert!(matches!(
        load_locator(&base, channel),
        Err(LocatorError::WrongKind { .. })
    ));

    write_raw_locator(
        &base,
        channel,
        &json!({
            "schemaVersion": 1, "kind": LOCATOR_KIND, "channel": "dev",
            "root": root_text, "generation": 1
        }),
    );
    assert!(matches!(
        load_locator(&base, channel),
        Err(LocatorError::WrongChannel { .. })
    ));

    write_raw_locator(
        &base,
        channel,
        &json!({
            "schemaVersion": 1, "kind": LOCATOR_KIND, "channel": "beta",
            "root": root_text, "generation": 1
        }),
    );
    assert!(matches!(
        load_locator(&base, channel),
        Err(LocatorError::UnknownChannel { .. })
    ));

    let dev_document =
        DataRootLocator::for_channel(DataRootChannel::Dev, &root, 1).expect("build dev locator");
    assert!(matches!(
        store_locator(&base, channel, &dev_document),
        Err(LocatorError::WrongChannel { .. })
    ));
}

#[test]
fn generation_must_increase_and_stale_writers_are_rejected() {
    let temp = TempDir::new("data-root-generation");
    let base = default_base_directory(temp.path());
    let channel = DataRootChannel::Dev;
    let root = default_data_root(&base, channel);

    let first = DataRootLocator::for_channel(channel, &root, 1).expect("build first");
    store_locator(&base, channel, &first).expect("first store");

    assert!(matches!(
        store_locator(&base, channel, &first),
        Err(LocatorError::StaleGeneration {
            current: 1,
            requested: 1
        })
    ));
    let older = DataRootLocator::for_channel(channel, &root, 0).expect("build older");
    assert!(matches!(
        store_locator(&base, channel, &older),
        Err(LocatorError::StaleGeneration {
            current: 1,
            requested: 0
        })
    ));

    let second = DataRootLocator::for_channel(channel, &root, 2).expect("build second");
    store_locator(&base, channel, &second).expect("second store");
    assert_eq!(
        load_locator(&base, channel)
            .expect("load")
            .expect("present"),
        second
    );
}

#[test]
fn switch_data_root_requires_a_newer_generation_and_a_disjoint_root() {
    let temp = TempDir::new("data-root-switch");
    let base = temp.path().join("base");
    let current_root = base.join("CurrentRoot");
    let current =
        DataRootLocator::for_channel(DataRootChannel::Dev, &current_root, 5).expect("current");
    let candidate = base.join("NextRoot");

    assert!(matches!(
        switch_data_root(&current, &candidate, 5),
        Err(LocatorError::StaleGeneration {
            current: 5,
            requested: 5
        })
    ));
    assert!(matches!(
        switch_data_root(&current, &candidate, 4),
        Err(LocatorError::StaleGeneration {
            current: 5,
            requested: 4
        })
    ));

    let next = switch_data_root(&current, &candidate, 6).expect("valid switch");
    assert_eq!(next.generation, 6);
    assert_eq!(next.channel, "dev");
    assert_eq!(next.root_path(), candidate);

    assert!(matches!(
        switch_data_root(&current, &current_root.join("child-root"), 6),
        Err(LocatorError::NestedRoot { .. })
    ));

    // 切换到新根后原子写入并回读。
    let locator_base = default_base_directory(temp.path());
    let first_root = default_data_root(&locator_base, DataRootChannel::Dev);
    let first =
        DataRootLocator::for_channel(DataRootChannel::Dev, &first_root, 1).expect("first document");
    store_locator(&locator_base, DataRootChannel::Dev, &first).expect("store first");
    let next_for_store = switch_data_root(&first, &candidate, 2).expect("switch document");
    store_locator(&locator_base, DataRootChannel::Dev, &next_for_store).expect("store next");
    assert_eq!(
        load_locator(&locator_base, DataRootChannel::Dev)
            .expect("load")
            .expect("present"),
        next_for_store
    );
}

#[test]
fn resolve_rejects_a_relative_base_before_creating_anything() {
    let error = resolve_data_root(Path::new("relative-base"), DataRootChannel::Dev)
        .expect_err("relative base must be rejected");
    assert!(matches!(error, LocatorError::RelativeRoot { .. }));
    assert!(!Path::new("relative-base").exists());
}
