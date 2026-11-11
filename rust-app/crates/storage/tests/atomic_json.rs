//! `atomic_json` 的集成测试：失败不覆盖旧文件、不残留临时文件、JSON 确定性。

mod support;

use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;

use highlighter_storage::{
    read_json, read_json_with_limit, write_atomic, write_json_atomic, StorageError, MAX_JSON_BYTES,
};
use serde_json::json;

use support::TempDir;

#[test]
fn writes_a_new_file_without_leaving_staging_files() {
    let temp = TempDir::new("atomic-new");
    let path = temp.child("settings.json");

    write_atomic(&path, b"{\"a\":1}").expect("atomic write");

    assert_eq!(support::read(&path), b"{\"a\":1}");
    assert_eq!(temp.entries(), ["settings.json".to_owned()]);
}

#[test]
fn replaces_existing_content_and_keeps_the_directory_clean() {
    let temp = TempDir::new("atomic-replace");
    let path = temp.child("settings.json");
    write_atomic(&path, b"old-bytes").expect("initial write");

    write_atomic(&path, b"new-bytes").expect("replace write");

    assert_eq!(support::read(&path), b"new-bytes");
    assert_eq!(temp.entries(), ["settings.json".to_owned()]);
}

#[test]
fn json_writes_are_deterministic_pretty_utf8_with_one_trailing_newline() {
    let temp = TempDir::new("atomic-json");
    let path = temp.child("settings.json");
    let value = json!({ "b": 2, "a": "中文", "list": [1, 2, 3] });

    write_json_atomic(&path, &value).expect("first write");
    let first = support::read(&path);
    write_json_atomic(&path, &value).expect("second write");

    assert_eq!(
        support::read(&path),
        first,
        "same value must produce same bytes"
    );
    assert!(first.ends_with(b"\n"), "must end with exactly one newline");
    assert!(!first.ends_with(b"\n\n"), "must not end with a blank line");
    let text = String::from_utf8(first).expect("UTF-8");
    // serde_json 默认对象键按字典序输出；2 空格缩进是合同格式约定。
    assert!(
        text.starts_with("{\n  \"a\": "),
        "pretty JSON with 2-space indent expected, got: {text}"
    );
    assert!(text.contains("\"中文\""));

    let roundtrip: serde_json::Value = read_json(&path).expect("roundtrip");
    assert_eq!(roundtrip, value);
}

#[test]
fn read_json_with_limit_rejects_oversized_files_before_parsing() {
    let temp = TempDir::new("atomic-limit");
    let path = temp.child("settings.json");
    write_json_atomic(&path, &json!({"key": "value"})).expect("write");

    let bytes = fs::metadata(&path).expect("metadata").len();
    assert!(bytes > 8, "fixture should exceed the 8-byte limit");

    let error = read_json_with_limit::<serde_json::Value>(&path, 8).expect_err("over limit");
    match error {
        StorageError::TooLarge {
            bytes: actual,
            limit,
            ..
        } => {
            assert_eq!(actual, bytes);
            assert_eq!(limit, 8);
        }
        other => panic!("expected TooLarge, got {other:?}"),
    }

    read_json_with_limit::<serde_json::Value>(&path, 1_000_000).expect("under limit");
    let default_limit = MAX_JSON_BYTES;
    assert!(
        default_limit > 1_000_000,
        "default limit is generous for config files"
    );
}

#[test]
fn invalid_json_reports_the_path() {
    let temp = TempDir::new("atomic-bad-json");
    let path = temp.child("broken.json");
    support::write(&path, b"{ oops");

    let error = read_json::<serde_json::Value>(&path).expect_err("invalid json");
    assert!(matches!(error, StorageError::Json { .. }));
    assert!(
        error.to_string().contains("broken.json"),
        "error must name the file: {error}"
    );
}

#[test]
fn missing_file_reports_not_found() {
    let temp = TempDir::new("atomic-missing");
    let error = read_json::<serde_json::Value>(&temp.child("missing.json")).expect_err("missing");
    match error {
        StorageError::Io { source, .. } => assert_eq!(source.kind(), ErrorKind::NotFound),
        other => panic!("expected Io(NotFound), got {other:?}"),
    }
}

#[test]
fn failing_replace_does_not_clobber_the_destination_or_leave_temp_files() {
    let temp = TempDir::new("atomic-fail-target-dir");
    let destination = temp.child("target");
    fs::create_dir(&destination).expect("create target dir");
    let marker = destination.join("keep.txt");
    fs::write(&marker, b"untouched").expect("write marker");

    // 目标是一个目录：同目录 rename 替换会失败；旧目标必须保持原样。
    let error = write_atomic(&destination, b"replacement").expect_err("must fail");
    assert!(matches!(error, StorageError::Io { .. }), "got {error:?}");
    assert!(destination.is_dir());
    assert_eq!(support::read(&marker), b"untouched");
    assert_eq!(
        temp.entries(),
        ["target".to_owned()],
        "no staging files may remain"
    );
}

#[test]
fn unwritable_parent_directory_reports_an_error_without_staging_files() {
    let temp = TempDir::new("atomic-fail-parent-file");
    let parent_file = temp.child("parent-file");
    support::write(&parent_file, b"x");

    let error = write_atomic(&parent_file.join("child.json"), b"data").expect_err("must fail");
    assert!(matches!(error, StorageError::Io { .. }), "got {error:?}");
    assert_eq!(temp.entries(), ["parent-file".to_owned()]);
    assert_eq!(support::read(&parent_file), b"x");
}

/// 去掉只读属性，保证 Windows 上 TempDir 的递归清理能成功。
#[cfg(windows)]
struct ClearReadonly(PathBuf);

#[cfg(windows)]
impl Drop for ClearReadonly {
    #[allow(clippy::permissions_set_readonly_false)]
    fn drop(&mut self) {
        if let Ok(metadata) = fs::metadata(&self.0) {
            let mut permissions = metadata.permissions();
            // Windows-only: 清除 FILE_ATTRIBUTE_READONLY；该 lint 的 Unix 含义不适用于本测试。
            permissions.set_readonly(false);
            let _ = fs::set_permissions(&self.0, permissions);
        }
    }
}

#[cfg(windows)]
#[test]
fn readonly_destination_fails_without_clobbering_or_leaving_temp_files() {
    let temp = TempDir::new("atomic-readonly");
    let path = temp.child("settings.json");
    support::write(&path, b"old-config");
    let mut permissions = fs::metadata(&path).expect("metadata").permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&path, permissions).expect("set readonly");
    let _clear = ClearReadonly(path.clone());

    let error = write_atomic(&path, b"new-config").expect_err("readonly replace must fail");
    assert!(matches!(error, StorageError::Io { .. }), "got {error:?}");
    assert_eq!(support::read(&path), b"old-config");
    assert_eq!(temp.entries(), ["settings.json".to_owned()]);
}
