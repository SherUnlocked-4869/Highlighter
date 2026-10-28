//! A v1 store must migrate in place to v2 without losing history. A second,
//! freshly created v2 store guards `schema-v2.sql` and the migration SQL against
//! drifting apart. Only synthetic rows and temporary directories are used.
use highlighter_clipboard::storage::{Filter, Store};
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

const TEXT_ID: &str = "11111111-1111-4111-8111-111111111111";
const IMAGE_ID: &str = "22222222-2222-4222-8222-222222222222";
const URL_ID: &str = "33333333-3333-4333-8333-333333333333";
const PINNED_ID: &str = "44444444-4444-4444-8444-444444444444";

fn temp_root(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "highlighter-clipboard-migrate-{}-{tag}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    root
}

/// Mirrors the payload content address the store computes, so seeded attachment
/// bytes can be verified by `payload()` after migration.
fn payload_hash(mime: &str, bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(b"highlighter-clipboard-payload-v1\0");
    digest.update((mime.len() as u64).to_le_bytes());
    digest.update(mime.as_bytes());
    digest.update((bytes.len() as u64).to_le_bytes());
    digest.update(bytes);
    format!("{:x}", digest.finalize())
}

struct SeedRow<'a> {
    id: &'a str,
    kind: &'a str,
    preview: &'a str,
    mime: &'a str,
    text: Option<&'a str>,
    attachment: Option<&'a [u8]>,
    pinned: bool,
    copy_count: i64,
    use_count: i64,
    sort_at: i64,
}

fn seed_row(db: &Connection, root: &Path, row: SeedRow<'_>) {
    let bytes: &[u8] = row
        .text
        .map(str::as_bytes)
        .or(row.attachment)
        .unwrap_or(&[]);
    let hash = payload_hash(row.mime, bytes);
    let (width, height) = if row.kind == "image" { (1, 1) } else { (0, 0) };
    db.execute(
        "INSERT INTO payloads VALUES(?1,?2,?3,?4,?5,?6)",
        params![hash, row.mime, bytes.len() as i64, row.text, width, height],
    )
    .unwrap();
    if let Some(attachment) = row.attachment {
        fs::write(root.join("attachments").join(format!("{hash}.png")), attachment).unwrap();
    }
    db.execute(
        "INSERT INTO items(id,payload_id,kind,preview,source,created_at,last_copied_at,last_used_at,sort_at,is_pinned,pinned_order,copy_count,use_count)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![
            row.id,
            hash,
            row.kind,
            row.preview,
            "synthetic.exe",
            row.sort_at,
            row.sort_at,
            row.use_count * 1000,
            row.sort_at,
            i64::from(row.pinned),
            if row.pinned { 777 } else { 0 },
            row.copy_count,
            row.use_count
        ],
    )
    .unwrap();
    if let Some(text) = row.text {
        db.execute(
            "INSERT INTO item_search(id,text) VALUES(?1,?2)",
            params![row.id, text.chars().take(32768).collect::<String>()],
        )
        .unwrap();
    }
}

/// Writes a v1 database (schema plus text, image, url and pinned text rows) into
/// `root` before the store ever opens it.
fn seed_v1(root: &Path) {
    fs::create_dir_all(root.join("attachments")).unwrap();
    let db = Connection::open(root.join("clipboard.sqlite3")).unwrap();
    let schema = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src/schema-v1.sql"),
    )
    .unwrap();
    db.execute_batch(&schema).unwrap();
    db.execute_batch("PRAGMA user_version=1").unwrap();
    db.execute(
        "INSERT INTO metadata VALUES(1,?1,0,?2)",
        params!["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 1_700_000_000_000i64],
    )
    .unwrap();
    seed_row(
        &db,
        root,
        SeedRow {
            id: TEXT_ID,
            kind: "text",
            preview: "hello world",
            mime: "text/plain;charset=utf-8",
            text: Some("hello world"),
            attachment: None,
            pinned: false,
            copy_count: 2,
            use_count: 1,
            sort_at: 3_000,
        },
    );
    seed_row(
        &db,
        root,
        SeedRow {
            id: IMAGE_ID,
            kind: "image",
            preview: "",
            mime: "image/png",
            text: None,
            attachment: Some(b"v1-image-bytes"),
            pinned: false,
            copy_count: 1,
            use_count: 0,
            sort_at: 2_000,
        },
    );
    seed_row(
        &db,
        root,
        SeedRow {
            id: URL_ID,
            kind: "url",
            preview: "https://example.com/v1",
            mime: "text/plain;charset=utf-8",
            text: Some("https://example.com/v1"),
            attachment: None,
            pinned: false,
            copy_count: 4,
            use_count: 2,
            sort_at: 1_000,
        },
    );
    seed_row(
        &db,
        root,
        SeedRow {
            id: PINNED_ID,
            kind: "text",
            preview: "pinned note",
            mime: "text/plain;charset=utf-8",
            text: Some("pinned note"),
            attachment: None,
            pinned: true,
            copy_count: 5,
            use_count: 3,
            sort_at: 500,
        },
    );
}

fn normalized_schema(db: &Connection) -> Vec<(String, String, String)> {
    let mut statement = db
        .prepare(
            "SELECT type,name,COALESCE(sql,'') FROM sqlite_master
             WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
        )
        .unwrap();
    let rows = statement
        .query_map([], |row| {
            let sql: String = row.get(2)?;
            Ok((
                row.get(0)?,
                row.get(1)?,
                sql.split_whitespace().collect::<Vec<_>>().join(" "),
            ))
        })
        .unwrap();
    rows.map(|row| row.unwrap()).collect()
}

#[test]
fn migrates_v1_history_and_matches_a_fresh_v2_schema() {
    let root = temp_root("migrate");
    seed_v1(&root);
    let mut store = Store::open(&root).unwrap();
    assert_eq!(store.status().unwrap()["itemCount"], 4);

    // Every seeded row keeps its kind, preview, pin state and ordering.
    let all = store.list(Filter::default()).unwrap();
    let items = all["items"].as_array().unwrap();
    assert_eq!(items.len(), 4);
    let pinned = items
        .iter()
        .filter(|item| item["isPinned"].as_bool() == Some(true))
        .count();
    assert_eq!(pinned, 1);
    for id in [TEXT_ID, IMAGE_ID, URL_ID, PINNED_ID] {
        assert!(
            items.iter().any(|item| item["id"] == id),
            "missing seeded row {id}"
        );
    }

    // Index rows survive untouched, so search still works after the table rebuild.
    let hits = store
        .list(Filter {
            search: "hello".into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(hits["items"].as_array().unwrap().len(), 1);
    assert_eq!(hits["items"][0]["id"], TEXT_ID);
    let pinned_hits = store
        .list(Filter {
            pinned_only: true,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(pinned_hits["items"][0]["id"], PINNED_ID);

    // Text bodies and image attachments still resolve through `payload()`.
    let (mime, body) = store.payload(TEXT_ID, false).unwrap();
    assert_eq!(mime, "text/plain;charset=utf-8");
    assert_eq!(body, b"hello world");
    let (mime, body) = store.payload(IMAGE_ID, false).unwrap();
    assert_eq!(mime, "image/png");
    assert_eq!(body, b"v1-image-bytes");
    assert_eq!(store.detail(TEXT_ID).unwrap()["text"], "hello world");

    // The rebuilt table admits the new kind.
    store
        .accept(
            "files",
            b"C:\\new\\a.txt\nD:\\b.txt".to_vec(),
            "",
        )
        .unwrap();
    let files = store
        .list(Filter {
            kind: "files".into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(files["items"].as_array().unwrap().len(), 1);
    assert_eq!(files["items"][0]["fileCount"], 2);
    drop(store);

    // Counters that list/detail do not expose survive the copy verbatim.
    let db = Connection::open(root.join("clipboard.sqlite3")).unwrap();
    let version: u32 = db
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 2);
    let (copy_count, use_count, pinned_order, last_copied_at, kind): (
        i64,
        i64,
        i64,
        i64,
        String,
    ) = db
        .query_row(
            "SELECT copy_count,use_count,pinned_order,last_copied_at,kind FROM items WHERE id=?1",
            [PINNED_ID],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!((copy_count, use_count, pinned_order), (5, 3, 777));
    assert_eq!(last_copied_at, 500);
    assert_eq!(kind, "text");

    // A newly created v2 store must expose the exact same normalized DDL: this is
    // what keeps schema-v2.sql and MIGRATE_V1_TO_V2 from diverging.
    let fresh_root = temp_root("fresh");
    drop(Store::open(&fresh_root).unwrap());
    let fresh = Connection::open(fresh_root.join("clipboard.sqlite3")).unwrap();
    assert_eq!(normalized_schema(&db), normalized_schema(&fresh));
    let fresh_version: u32 = fresh
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(fresh_version, 2);
    drop(fresh);
    drop(db);
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&fresh_root);
}

#[test]
fn rejects_a_schema_version_from_the_future() {
    let root = temp_root("future");
    fs::create_dir_all(&root).unwrap();
    let db = Connection::open(root.join("clipboard.sqlite3")).unwrap();
    db.execute_batch("PRAGMA user_version=3").unwrap();
    drop(db);
    assert_eq!(Store::open(&root).err(), Some("SCHEMA_TOO_NEW"));
    let _ = fs::remove_dir_all(&root);
}
