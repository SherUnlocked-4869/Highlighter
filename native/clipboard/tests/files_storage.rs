//! `files` rows are path-only payloads. These tests use synthetic path lists and
//! temporary stores only; the interactive clipboard is never read or written.
use highlighter_clipboard::limits::{FILES_MIME, MAX_HDROP_BYTES};
use highlighter_clipboard::storage::{Filter, Rules, Store};
use std::fs;
use std::path::PathBuf;

fn temp_root(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "highlighter-clipboard-files-{}-{tag}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    root
}

fn open(tag: &str) -> (Store, PathBuf) {
    let root = temp_root(tag);
    (Store::open(&root).unwrap(), root)
}

#[test]
fn round_trips_a_file_list_through_list_detail_and_payload() {
    let (mut store, root) = open("roundtrip");
    let paths = [
        "C:\\Users\\me\\a.txt".to_string(),
        "D:\\dir\\b.png".to_string(),
    ];
    let body = paths.join("\n").into_bytes();
    store.accept("files", body.clone(), "").unwrap();
    assert_eq!(store.status().unwrap()["itemCount"], 1);
    let page = store.list(Filter::default()).unwrap();
    let items = page["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["kind"], "files");
    assert_eq!(items[0]["previewText"], "a.txt");
    assert_eq!(items[0]["fileCount"], 2);
    assert_eq!(items[0]["width"], 0);
    assert_eq!(items[0]["height"], 0);
    assert_eq!(items[0]["byteLength"], body.len() as u64);
    let id = items[0]["id"].as_str().unwrap().to_string();
    let detail = store.detail(&id).unwrap();
    assert_eq!(detail["kind"], "files");
    assert_eq!(detail["text"], paths.join("\n"));
    assert_eq!(detail["truncated"], false);
    let (mime, payload) = store.payload(&id, false).unwrap();
    assert_eq!(mime, FILES_MIME);
    assert_eq!(payload, body);
    // File rows have no thumbnail; never synthesize one from a path list.
    assert_eq!(store.payload(&id, true).unwrap_err(), "UNSUPPORTED");
    drop(store);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn filters_by_kind_and_reports_file_count_only_for_files() {
    let (mut store, root) = open("kinds");
    store
        .accept("text", b"hello world".to_vec(), "")
        .unwrap();
    store
        .accept("files", b"C:\\a.txt\nD:\\b.txt".to_vec(), "")
        .unwrap();
    let all = store.list(Filter::default()).unwrap();
    let items = all["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    let text = items
        .iter()
        .find(|item| item["kind"] == "text")
        .unwrap();
    assert_eq!(text["fileCount"], 0);
    let files = store
        .list(Filter {
            kind: "files".into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(files["items"].as_array().unwrap().len(), 1);
    assert_eq!(files["items"][0]["fileCount"], 2);
    let texts = store
        .list(Filter {
            kind: "text".into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(texts["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        store
            .list(Filter {
                kind: "video".into(),
                ..Default::default()
            })
            .unwrap_err(),
        "INVALID_FILTER"
    );
    drop(store);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn duplicate_lists_update_the_existing_item() {
    let (mut store, root) = open("dedupe");
    let body = b"C:\\A.txt\nD:\\b.png".to_vec();
    store.accept("files", body.clone(), "").unwrap();
    store.accept("files", body, "").unwrap();
    assert_eq!(store.status().unwrap()["itemCount"], 1);
    let page = store.list(Filter::default()).unwrap();
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["previewText"], "A.txt");
    drop(store);
    let db = rusqlite::Connection::open(root.join("clipboard.sqlite3")).unwrap();
    let (count, copies): (i64, i64) = db
        .query_row(
            "SELECT count(*),COALESCE(max(copy_count),0) FROM items",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((count, copies), (1, 2));
    drop(db);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn refuses_files_while_the_switch_is_off() {
    let (mut store, root) = open("switch-off");
    store
        .configure(Rules {
            capture_files: false,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        store
            .accept("files", b"C:\\a.txt".to_vec(), "")
            .unwrap_err(),
        "unsupported"
    );
    // Other kinds keep their own switches.
    store
        .accept("text", b"hello".to_vec(), "")
        .unwrap();
    assert_eq!(store.status().unwrap()["itemCount"], 1);
    drop(store);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn rejects_invalid_lists_without_storing_anything() {
    let (mut store, root) = open("invalid");
    for body in [
        b"relative\\path.txt".to_vec(),
        b"C:\\a.txt\ndevice".to_vec(),
        b"C:\\a.txt\n".to_vec(),
    ] {
        assert_eq!(store.accept("files", body, "").unwrap_err(), "unsupported");
    }
    assert_eq!(
        store.accept("files", vec![0xff, 0xfe], "").unwrap_err(),
        "invalid_encoding"
    );
    let many = (0..=64)
        .map(|index| format!("C:\\f{index}.txt"))
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(
        store.accept("files", many.into_bytes(), "").unwrap_err(),
        "oversized"
    );
    assert_eq!(
        store
            .accept("files", vec![b'C'; MAX_HDROP_BYTES + 1], "")
            .unwrap_err(),
        "oversized"
    );
    assert_eq!(store.status().unwrap()["itemCount"], 0);
    drop(store);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn rules_default_capture_files_when_the_parent_omits_the_new_switch() {
    // A parent build predating the files feature sends every old field but not
    // captureFiles; that must mean "on", not INVALID_RULES.
    let legacy = r#"{"captureText":true,"captureImages":true,"historyLimit":500,
        "retentionDays":30,"maxPayloadMiB":256,"maxDiskMiB":384,
        "maxThumbnailMiB":64,"excludedApps":[]}"#;
    let rules: Rules = serde_json::from_str(legacy).unwrap();
    assert!(rules.capture_files);
    assert!(rules.validate().is_ok());
    let explicit = r#"{"captureText":true,"captureImages":true,"captureFiles":false,
        "historyLimit":500,"retentionDays":30,"maxPayloadMiB":256,"maxDiskMiB":384,
        "maxThumbnailMiB":64,"excludedApps":[]}"#;
    let rules: Rules = serde_json::from_str(explicit).unwrap();
    assert!(!rules.capture_files);
    assert!(!serde_json::to_value(&rules).unwrap()["captureFiles"]
        .as_bool()
        .unwrap());
}

#[test]
fn searches_file_names_and_directories() {
    let (mut store, root) = open("search");
    store
        .accept(
            "files",
            b"C:\\docs\\quarterly-report.pdf\nC:\\pics\\shot.png".to_vec(),
            "",
        )
        .unwrap();
    store
        .accept("text", b"unrelated note".to_vec(), "")
        .unwrap();
    let by_name = store
        .list(Filter {
            search: "quarterly".into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(by_name["items"].as_array().unwrap().len(), 1);
    assert_eq!(by_name["items"][0]["kind"], "files");
    let by_directory = store
        .list(Filter {
            search: "pics".into(),
            kind: "files".into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(by_directory["items"].as_array().unwrap().len(), 1);
    let miss = store
        .list(Filter {
            search: "nothing-here".into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(miss["items"].as_array().unwrap().len(), 0);
    drop(store);
    let _ = fs::remove_dir_all(&root);
}
