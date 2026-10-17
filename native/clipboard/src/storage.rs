//! One serialized repository owns SQLite and all attachments. Paths and SQL are
//! never accepted from a renderer. An unpublished attachment is recoverable GC.
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, &'static str>;
const MIB: u64 = 1024 * 1024;
trait StoreResult<T> {
    fn stored(self) -> Result<T>;
}
impl<T, E> StoreResult<T> for std::result::Result<T, E> {
    fn stored(self) -> Result<T> {
        self.map_err(|_| "STORAGE_FAILED")
    }
}
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
pub fn valid_id(id: &str) -> bool {
    Uuid::parse_str(id).is_ok_and(|v| v.to_string() == id)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rules {
    pub capture_text: bool,
    pub capture_images: bool,
    pub history_limit: u32,
    pub retention_days: u32,
    pub max_payload_mi_b: u64,
    pub max_disk_mi_b: u64,
    pub max_thumbnail_mi_b: u64,
    pub excluded_apps: Vec<String>,
}
impl Default for Rules {
    fn default() -> Self {
        Self {
            capture_text: true,
            capture_images: true,
            history_limit: 500,
            retention_days: 30,
            max_payload_mi_b: 256,
            max_disk_mi_b: 384,
            max_thumbnail_mi_b: 64,
            excluded_apps: vec![],
        }
    }
}
impl Rules {
    pub fn validate(&self) -> Result<()> {
        if !(100..=5000).contains(&self.history_limit)
            || !(1..=365).contains(&self.retention_days)
            || !(64..=1024).contains(&self.max_payload_mi_b)
            || !(128..=2048).contains(&self.max_disk_mi_b)
            || !(16..=256).contains(&self.max_thumbnail_mi_b)
            || self.max_disk_mi_b < self.max_payload_mi_b + self.max_thumbnail_mi_b + 64
            || self.excluded_apps.len() > 100
            || self.excluded_apps.iter().any(|s| !valid_app(s))
        {
            return Err("INVALID_RULES");
        }
        Ok(())
    }
}
pub fn valid_app(s: &str) -> bool {
    s.len() <= 128
        && s.ends_with(".exe")
        && !s.contains(['/', '\\', ':', '\0'])
        && s == s.to_lowercase()
}

#[derive(Deserialize, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Filter {
    #[serde(default)]
    pub search: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub pinned_only: bool,
    pub cursor: Option<Cursor>,
    pub limit: Option<u32>,
}
#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cursor {
    dataset_id: String,
    revision: String,
    filter: String,
    pinned: i64,
    order: i64,
    sort: i64,
    id: String,
}

pub struct Store {
    db: Connection,
    root: PathBuf,
    pub rules: Rules,
    disk_bytes: u64,
    thumbnail_bytes: u64,
    last_calibration: Instant,
    last_maintenance: Instant,
    maintenance_pending: bool,
    can_compact: bool,
    pub last_error: Option<&'static str>,
}

fn safe_path(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        if let Ok(meta) = fs::symlink_metadata(ancestor) {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    return Err("UNSAFE_PATH");
                }
            }
            if meta.file_type().is_symlink() {
                return Err("UNSAFE_PATH");
            }
        }
    }
    Ok(())
}

impl Store {
    pub fn open(root: &Path) -> Result<Self> {
        if !root.is_absolute() || root.to_string_lossy().starts_with("\\\\") {
            return Err("UNSUPPORTED_PATH");
        }
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            let drive: Vec<u16> = root
                .ancestors()
                .last()
                .ok_or("UNSUPPORTED_PATH")?
                .as_os_str()
                .encode_wide()
                .chain([0])
                .collect();
            // Removable, fixed and RAM disks are local. Also reject mapped
            // network drives, which do not have a UNC-looking input path.
            let kind = unsafe {
                windows::Win32::Storage::FileSystem::GetDriveTypeW(windows::core::PCWSTR(
                    drive.as_ptr(),
                ))
            };
            if !matches!(kind, 2 | 3 | 6) {
                return Err("UNSUPPORTED_PATH");
            }
        }
        safe_path(root)?;
        fs::create_dir_all(root).stored()?;
        for dir in ["attachments", "thumbnails", "staging"] {
            safe_path(&root.join(dir))?;
            fs::create_dir_all(root.join(dir)).stored()?;
        }
        let file = root.join("clipboard.sqlite3");
        for suffix in ["", "-wal", "-shm"] {
            safe_path(&root.join(format!("clipboard.sqlite3{suffix}")))?;
        }
        let db = Connection::open(file).stored()?;
        db.busy_timeout(Duration::from_secs(1)).stored()?;
        // Reject newer schemas before changing any persistent pragma.
        let version: u32 = db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .stored()?;
        if version > 1 {
            return Err("SCHEMA_TOO_NEW");
        }
        let integrity: String = db
            .query_row("PRAGMA quick_check(1)", [], |r| r.get(0))
            .stored()?;
        if integrity != "ok" {
            return Err("DATABASE_DAMAGED");
        }
        if version == 0 {
            let tables: i64 = db
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
                    [],
                    |r| r.get(0),
                )
                .stored()?;
            if tables != 0 {
                return Err("UNSUPPORTED_SCHEMA");
            }
            db.execute_batch("PRAGMA auto_vacuum=INCREMENTAL")
                .stored()?;
        }
        db.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
            PRAGMA cache_size=-4096; PRAGMA mmap_size=0; PRAGMA wal_autocheckpoint=256;",
        )
        .stored()?;
        // An unavailable trigram tokenizer is a startup failure, not a silent scan.
        db.execute_batch("CREATE VIRTUAL TABLE temp.fts_capability USING fts5(value,tokenize='trigram'); DROP TABLE temp.fts_capability;").stored()?;
        if version == 0 {
            let tx = db.unchecked_transaction().stored()?;
            tx.execute_batch(include_str!("schema-v1.sql")).stored()?;
            tx.execute(
                "INSERT INTO metadata VALUES(1,?1,0,?2)",
                params![Uuid::new_v4().to_string(), now()],
            )
            .stored()?;
            tx.execute_batch("PRAGMA user_version=1").stored()?;
            tx.commit().stored()?;
        }
        // Bound even one- and two-character LIKE scans. A retained set has <=5000
        // ordinary items; pinned items are additionally bounded by byte budgets.
        let can_compact = db
            .query_row("PRAGMA auto_vacuum", [], |r| r.get::<_, i32>(0))
            .stored()?
            == 2;
        let mut store = Self {
            db,
            root: root.to_path_buf(),
            rules: Rules::default(),
            disk_bytes: 0,
            thumbnail_bytes: 0,
            last_calibration: Instant::now(),
            last_maintenance: Instant::now(),
            maintenance_pending: false,
            can_compact,
            last_error: None,
        };
        store.recover()?;
        store.calibrate()?;
        Ok(store)
    }

    pub fn configure(&mut self, rules: Rules) -> Result<()> {
        rules.validate()?;
        self.rules = rules;
        self.prune_thumbnails()?;
        self.maintain()?;
        Ok(())
    }
    fn file(&self, hash: &str, thumbnail: bool) -> Result<PathBuf> {
        if hash.len() != 64
            || !hash
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err("INVALID_PAYLOAD");
        }
        let p = self
            .root
            .join(if thumbnail {
                "thumbnails"
            } else {
                "attachments"
            })
            .join(format!("{hash}.png"));
        safe_path(&p)?;
        Ok(p)
    }
    fn publish(&mut self, hash: &str, bytes: &[u8], thumbnail: bool) -> Result<()> {
        let destination = self.file(hash, thumbnail)?;
        if destination.exists() {
            // Existing immutable content must agree. Do not overwrite a damaged
            // or externally replaced original under the same content address.
            let existing =
                self.read_file(hash, thumbnail, crate::limits::MAX_ENCODED_IMAGE_BYTES)?;
            if existing != bytes {
                return Err("ATTACHMENT_DAMAGED");
            }
            return Ok(());
        }
        if thumbnail
            && self.thumbnail_bytes + bytes.len() as u64 > self.rules.max_thumbnail_mi_b * MIB
        {
            return Ok(());
        }
        let staging = self.root.join("staging").join(Uuid::new_v4().to_string());
        safe_path(&staging)?;
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staging)
            .stored()?;
        let result = (|| {
            file.write_all(bytes).stored()?;
            file.sync_all().stored()?;
            drop(file);
            fs::rename(&staging, destination).stored()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(staging);
        } else {
            self.disk_bytes = self.disk_bytes.saturating_add(bytes.len() as u64);
            if thumbnail {
                self.thumbnail_bytes += bytes.len() as u64;
            }
        }
        result
    }
    fn read_file(&self, hash: &str, thumbnail: bool, max: usize) -> Result<Vec<u8>> {
        let path = self.file(hash, thumbnail)?;
        let file = fs::File::open(path).map_err(|_| "ATTACHMENT_MISSING")?;
        let meta = file.metadata().stored()?;
        if !meta.is_file() || meta.len() > max as u64 {
            return Err("ATTACHMENT_DAMAGED");
        }
        let mut bytes = Vec::with_capacity(meta.len() as usize);
        file.take(max as u64 + 1).read_to_end(&mut bytes).stored()?;
        if bytes.len() > max {
            return Err("ATTACHMENT_DAMAGED");
        }
        Ok(bytes)
    }

    pub fn accept(&mut self, kind: &str, bytes: Vec<u8>, source: &str) -> Result<()> {
        if (!self.rules.excluded_apps.is_empty() && source.is_empty())
            || self.rules.excluded_apps.iter().any(|s| s == source)
        {
            return Err("excluded");
        }
        if (kind == "text" && !self.rules.capture_text)
            || (kind != "text" && !self.rules.capture_images)
        {
            return Err("unsupported");
        }
        let (kind, body, data, thumb, width, height) = if kind == "text" {
            if bytes.len() > crate::limits::MAX_TEXT_BYTES {
                return Err("oversized");
            }
            let text = String::from_utf8(bytes).map_err(|_| "invalid_encoding")?;
            if text.is_empty() {
                return Err("unsupported");
            }
            let trimmed = text.trim();
            let url = !trimmed.contains(char::is_whitespace)
                && (trimmed.starts_with("https://") || trimmed.starts_with("http://"));
            (
                if url { "url" } else { "text" },
                Some(text),
                Vec::new(),
                Vec::new(),
                0,
                0,
            )
        } else {
            // At most one input (<=64MiB), bitmap (<=64MiB), compressed result
            // (<=16MiB) and thumbnail: serial, no retained payload queue.
            let image = crate::images::prepare(kind, &bytes)?;
            (
                "image",
                None,
                image.png,
                image.thumbnail,
                image.width,
                image.height,
            )
        };
        let original = body.as_ref().map(|s| s.as_bytes()).unwrap_or(&data);
        let mime = if body.is_some() {
            "text/plain;charset=utf-8"
        } else {
            "image/png"
        };
        let mut digest = Sha256::new();
        digest.update(b"highlighter-clipboard-payload-v1\0");
        digest.update((mime.len() as u64).to_le_bytes());
        digest.update(mime.as_bytes());
        digest.update((original.len() as u64).to_le_bytes());
        digest.update(original);
        let hash = format!("{:x}", digest.finalize());
        let byte_length = original.len() as u64;
        let duplicate: bool = self
            .db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM payloads WHERE id=?1)",
                [&hash],
                |r| r.get(0),
            )
            .stored()?;
        self.maintain_if_due()?;
        let mut payload_bytes: i64 = self
            .db
            .query_row(
                "SELECT COALESCE(sum(byte_length),0) FROM payloads",
                [],
                |r| r.get(0),
            )
            .stored()?;
        if !duplicate
            && (payload_bytes as u64 + byte_length > self.rules.max_payload_mi_b * MIB
                || self.disk_bytes + byte_length * 3 + 4 * MIB
                    > self.rules.max_disk_mi_b * MIB - 32 * MIB)
        {
            // Reclaim at most 50 ordinary records per admission. Pins are never
            // eligible; unreclaimed GC remains charged to capacity.
            let tx = self.db.unchecked_transaction().stored()?;
            let ids: Vec<String> = {
                let mut q = tx
                    .prepare("SELECT id FROM items WHERE is_pinned=0 ORDER BY sort_at,id LIMIT 50")
                    .stored()?;
                let rows = q.query_map([], |r| r.get(0)).stored()?;
                rows.collect::<rusqlite::Result<_>>().stored()?
            };
            for id in &ids {
                delete(&tx, id)?;
            }
            if !ids.is_empty() {
                bump(&tx)?;
            }
            tx.commit().stored()?;
            self.gc()?;
            self.checkpoint()?;
            self.calibrate()?;
            payload_bytes = self
                .db
                .query_row(
                    "SELECT COALESCE(sum(byte_length),0) FROM payloads",
                    [],
                    |r| r.get(0),
                )
                .stored()?;
        }
        if !duplicate
            && (payload_bytes as u64 + byte_length > self.rules.max_payload_mi_b * MIB
                || self
                    .disk_bytes
                    .saturating_add(byte_length * 2 + thumb.len() as u64 + 4 * MIB)
                    > self.rules.max_disk_mi_b * MIB - 32 * MIB)
        {
            self.last_error = Some("STORAGE_FULL");
            return Err("STORAGE_FULL");
        }
        if body.is_none() {
            self.publish(&hash, &data, false)?;
            self.publish(&hash, &thumb, true)?;
        }
        let stamp = now();
        let preview: String = body.as_deref().unwrap_or("").chars().take(500).collect();
        let tx = self.db.unchecked_transaction().stored()?;
        tx.execute("INSERT OR IGNORE INTO payloads(id,mime,byte_length,text_body,width,height) VALUES(?1,?2,?3,?4,?5,?6)", params![hash,mime,byte_length as i64,body,width,height]).stored()?;
        let existing: Option<String> = tx
            .query_row("SELECT id FROM items WHERE payload_id=?1", [&hash], |r| {
                r.get(0)
            })
            .optional()
            .stored()?;
        if let Some(id) = existing {
            tx.execute("UPDATE items SET last_copied_at=?2,sort_at=?2,source=?3,copy_count=copy_count+1 WHERE id=?1", params![id,stamp,source]).stored()?;
        } else {
            let id = Uuid::new_v4().to_string();
            tx.execute("INSERT INTO items(id,payload_id,kind,preview,source,created_at,last_copied_at,sort_at) VALUES(?1,?2,?3,?4,?5,?6,?6,?6)", params![id,hash,kind,preview,source,stamp]).stored()?;
            tx.execute(
                "INSERT INTO item_search(id,text) VALUES(?1,?2)",
                params![
                    id,
                    body.as_deref()
                        .unwrap_or("")
                        .chars()
                        .take(32768)
                        .collect::<String>()
                ],
            )
            .stored()?;
        }
        bump(&tx)?;
        tx.commit().stored()?;
        // Include inline text, index/WAL amplification and metadata until the
        // next physical calibration, rather than counting attachments alone.
        self.disk_bytes = self.disk_bytes.saturating_add(if duplicate {
            8192
        } else {
            byte_length * 3 + 8192
        });
        self.last_error = None;
        self.maintain()?;
        Ok(())
    }

    fn revision(&self) -> Result<(String, String)> {
        self.db
            .query_row(
                "SELECT dataset_id,CAST(revision AS TEXT) FROM metadata WHERE singleton=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .stored()
    }
    pub fn status(&self) -> Result<Value> {
        let (dataset, revision) = self.revision()?;
        let (count, pinned): (i64, i64) = self
            .db
            .query_row(
                "SELECT count(*),COALESCE(sum(is_pinned),0) FROM items",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .stored()?;
        let bytes: i64 = self
            .db
            .query_row(
                "SELECT COALESCE(sum(byte_length),0) FROM payloads",
                [],
                |r| r.get(0),
            )
            .stored()?;
        let gc: i64 = self.db.query_row("SELECT COALESCE(sum(byte_length),0) FROM payloads WHERE id IN (SELECT payload_id FROM gc_jobs)", [], |r| r.get(0)).stored()?;
        Ok(
            json!({"datasetId":dataset,"revision":revision,"itemCount":count,"pinnedCount":pinned,"payloadBytes":bytes,"actualDiskBytes":self.disk_bytes,"pendingGcBytes":gc,"messageKey":self.last_error,"maintenancePending":self.maintenance_pending}),
        )
    }
    pub fn list(&self, filter: Filter) -> Result<Value> {
        if filter.search.chars().count() > 200
            || !["", "text", "url", "image"].contains(&filter.kind.as_str())
        {
            return Err("INVALID_FILTER");
        }
        let limit = filter.limit.unwrap_or(50).clamp(1, 100) as usize;
        let (dataset, revision) = self.revision()?;
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(&filter.search, &filter.kind, filter.pinned_only)).stored()?
            )
        );
        if filter.cursor.as_ref().is_some_and(|c| {
            c.dataset_id != dataset
                || c.revision != revision
                || c.filter != fingerprint
                || !valid_id(&c.id)
        }) {
            return Err("CURSOR_STALE");
        }
        let fts = filter.search.chars().count() >= 3;
        let literal = if fts {
            format!("\"{}\"", filter.search.replace('"', "\"\""))
        } else {
            format!(
                "%{}%",
                filter
                    .search
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            )
        };
        let search_clause = if filter.search.is_empty() {
            "1"
        } else if fts {
            "i.id IN (SELECT id FROM item_search WHERE item_search MATCH ?3)"
        } else {
            "i.id IN (SELECT id FROM item_search WHERE text LIKE ?3 ESCAPE '\\')"
        };
        let cursor = filter.cursor;
        let sql = format!("SELECT i.id,i.kind,i.preview,i.source,i.created_at,i.last_copied_at,i.last_used_at,i.is_pinned,p.width,p.height,p.byte_length,i.pinned_order,i.sort_at
            FROM items i JOIN payloads p ON p.id=i.payload_id WHERE (?1='' OR i.kind=?1) AND (?2=0 OR i.is_pinned=1) AND {search_clause}
            AND (?4=0 OR (i.is_pinned,i.pinned_order,i.sort_at,i.id)<(?5,?6,?7,?8))
            ORDER BY i.is_pinned DESC,i.pinned_order DESC,i.sort_at DESC,i.id DESC LIMIT ?9");
        let started = Instant::now();
        self.db
            .progress_handler(
                2000,
                Some(move || started.elapsed() > Duration::from_millis(200)),
            )
            .stored()?;
        let result = (|| {
            let mut stmt = self.db.prepare(&sql).stored()?;
            let mut rows = stmt
                .query(params![
                    filter.kind,
                    filter.pinned_only,
                    literal,
                    cursor.is_some(),
                    cursor.as_ref().map_or(0, |c| c.pinned),
                    cursor.as_ref().map_or(0, |c| c.order),
                    cursor.as_ref().map_or(0, |c| c.sort),
                    cursor.as_ref().map_or("", |c| c.id.as_str()),
                    (limit + 1) as i64
                ])
                .stored()?;
            let mut values = vec![];
            let mut last = None;
            let mut more = false;
            while let Some(r) = rows.next().stored()? {
                if values.len() == limit {
                    more = true;
                    break;
                }
                let id: String = r.get(0).stored()?;
                let pinned: i64 = r.get(7).stored()?;
                last = Some(Cursor {
                    dataset_id: dataset.clone(),
                    revision: revision.clone(),
                    filter: fingerprint.clone(),
                    pinned,
                    order: r.get(11).stored()?,
                    sort: r.get(12).stored()?,
                    id: id.clone(),
                });
                values.push(json!({"id":id,"kind":r.get::<_,String>(1).stored()?,"previewText":r.get::<_,String>(2).stored()?,"sourceDisplayName":r.get::<_,String>(3).stored()?,
                    "createdAt":r.get::<_,i64>(4).stored()?,"lastCopiedAt":r.get::<_,i64>(5).stored()?,"lastUsedAt":r.get::<_,i64>(6).stored()?,"isPinned":pinned==1,
                    "width":r.get::<_,u32>(8).stored()?,"height":r.get::<_,u32>(9).stored()?,"byteLength":r.get::<_,i64>(10).stored()?,"availability":"available"}));
            }
            Ok(
                json!({"items":values,"cursor":if more {last}else{None},"datasetId":dataset,"revision":revision}),
            )
        })();
        self.db.progress_handler(0, None::<fn() -> bool>).stored()?;
        result
    }
    pub fn detail(&self, id: &str) -> Result<Value> {
        if !valid_id(id) {
            return Err("INVALID_ID");
        }
        let row = self.db.query_row("SELECT p.text_body,p.byte_length,i.kind FROM items i JOIN payloads p ON p.id=i.payload_id WHERE i.id=?1", [id], |r| Ok((r.get::<_,Option<String>>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?))).optional().stored()?.ok_or("NOT_FOUND")?;
        let text = row.0.unwrap_or_default();
        let mut boundary = text.len().min(64 * 1024);
        while !text.is_char_boundary(boundary) {
            boundary -= 1;
        }
        Ok(
            json!({"id":id,"kind":row.2,"text":&text[..boundary],"byteLength":row.1,"truncated":boundary<text.len()}),
        )
    }
    pub fn payload(&mut self, id: &str, thumbnail: bool) -> Result<(String, Vec<u8>)> {
        if !valid_id(id) {
            return Err("INVALID_ID");
        }
        let (hash,mime,text): (String,String,Option<String>) = self.db.query_row("SELECT p.id,p.mime,p.text_body FROM items i JOIN payloads p ON p.id=i.payload_id WHERE i.id=?1", [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().stored()?.ok_or("NOT_FOUND")?;
        if let Some(text) = text {
            if thumbnail {
                return Err("UNSUPPORTED");
            }
            return Ok((mime, text.into_bytes()));
        }
        let bytes = if thumbnail {
            match self.read_file(&hash, true, 1024 * 1024) {
                Ok(bytes) => bytes,
                Err("ATTACHMENT_MISSING") => {
                    let original =
                        self.read_file(&hash, false, crate::limits::MAX_ENCODED_IMAGE_BYTES)?;
                    let image = crate::images::prepare("png", &original)?;
                    self.publish(&hash, &image.thumbnail, true)?;
                    image.thumbnail
                }
                Err(e) => return Err(e),
            }
        } else {
            self.read_file(&hash, false, crate::limits::MAX_ENCODED_IMAGE_BYTES)?
        };
        if thumbnail {
            let (width, height) =
                crate::limits::png_dimensions(&bytes).map_err(|_| "ATTACHMENT_DAMAGED")?;
            if width > 240 || height > 240 {
                return Err("ATTACHMENT_DAMAGED");
            }
        }
        if !thumbnail {
            let mut digest = Sha256::new();
            digest.update(b"highlighter-clipboard-payload-v1\0");
            digest.update((mime.len() as u64).to_le_bytes());
            digest.update(mime.as_bytes());
            digest.update((bytes.len() as u64).to_le_bytes());
            digest.update(&bytes);
            if format!("{:x}", digest.finalize()) != hash {
                return Err("ATTACHMENT_DAMAGED");
            }
        }
        Ok((mime, bytes))
    }

    pub fn begin_copy(&self, id: &str, op: &str) -> Result<bool> {
        if !valid_id(id) || !valid_id(op) {
            return Err("INVALID_OPERATION");
        }
        let fingerprint = format!("copy:{id}");
        let prior: Option<(String, String)> = self
            .db
            .query_row(
                "SELECT fingerprint,result FROM operation_receipts WHERE id=?1",
                [op],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .stored()?;
        if let Some((expected, result)) = prior {
            if fingerprint != expected {
                return Err("OPERATION_CONFLICT");
            }
            if result != "copied" {
                return Err("COPY_OUTCOME_UNKNOWN");
            }
            return Ok(false);
        }
        self.db
            .execute(
                "INSERT INTO operation_receipts VALUES(?1,?2,'pending',?3)",
                params![op, fingerprint, now()],
            )
            .stored()?;
        Ok(true)
    }
    pub fn finish_copy(&self, id: &str, op: &str) -> Result<()> {
        let tx = self.db.unchecked_transaction().stored()?;
        tx.execute(
            "UPDATE items SET last_used_at=?2,sort_at=?2,use_count=use_count+1 WHERE id=?1",
            params![id, now()],
        )
        .stored()?;
        tx.execute(
            "UPDATE operation_receipts SET result='copied' WHERE id=?1",
            [op],
        )
        .stored()?;
        tx.execute("DELETE FROM operation_receipts WHERE id NOT IN (SELECT id FROM operation_receipts ORDER BY created_at DESC LIMIT 256)",[]).stored()?;
        bump(&tx)?;
        tx.commit().stored()
    }
    pub fn mutate(&mut self, method: &str, args: &Value) -> Result<Value> {
        let op = args
            .get("operationId")
            .and_then(Value::as_str)
            .filter(|id| valid_id(id))
            .ok_or("INVALID_OPERATION")?;
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(method, args)).stored()?)
        );
        let receipt: Option<(String, String)> = self
            .db
            .query_row(
                "SELECT fingerprint,result FROM operation_receipts WHERE id=?1",
                [op],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .stored()?;
        if let Some((expected, value)) = receipt {
            if fingerprint != expected {
                return Err("OPERATION_CONFLICT");
            }
            return serde_json::from_str(&value).stored();
        }
        let tx = self.db.unchecked_transaction().stored()?;
        let mut affected = 0;
        match method {
            "set-pinned" | "used" => {
                let id = args
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|s| valid_id(s))
                    .ok_or("INVALID_ID")?;
                affected = if method == "used" {
                    tx.execute("UPDATE items SET last_used_at=?2,sort_at=?2,use_count=use_count+1 WHERE id=?1", params![id,now()]).stored()?
                } else {
                    let pinned = args
                        .get("pinned")
                        .and_then(Value::as_bool)
                        .ok_or("INVALID_ARGUMENT")?;
                    tx.execute("UPDATE items SET is_pinned=?2,pinned_order=CASE WHEN ?2 THEN ?3 ELSE 0 END WHERE id=?1", params![id,pinned,now()]).stored()?
                };
                if affected == 0 {
                    return Err("NOT_FOUND");
                }
            }
            "delete" => {
                let ids = args
                    .get("ids")
                    .and_then(Value::as_array)
                    .filter(|v| !v.is_empty() && v.len() <= 100)
                    .ok_or("INVALID_IDS")?;
                for id in ids {
                    let id = id.as_str().filter(|s| valid_id(s)).ok_or("INVALID_ID")?;
                    affected += delete(&tx, id)?;
                }
            }
            "clear" => {
                let expected = args
                    .get("revision")
                    .and_then(Value::as_str)
                    .ok_or("INVALID_ARGUMENT")?;
                let revision: String = tx
                    .query_row("SELECT CAST(revision AS TEXT) FROM metadata", [], |r| {
                        r.get(0)
                    })
                    .stored()?;
                if expected != revision {
                    return Err("CLEAR_STALE");
                }
                let include_pinned = args
                    .get("includePinned")
                    .and_then(Value::as_bool)
                    .ok_or("INVALID_ARGUMENT")?;
                tx.execute("INSERT OR IGNORE INTO gc_jobs SELECT payload_id,0 FROM items WHERE ?1 OR is_pinned=0",[include_pinned]).stored()?;
                tx.execute("DELETE FROM item_search WHERE id IN (SELECT id FROM items WHERE ?1 OR is_pinned=0)",[include_pinned]).stored()?;
                affected = tx
                    .execute(
                        "DELETE FROM items WHERE ?1 OR is_pinned=0",
                        [include_pinned],
                    )
                    .stored()?;
            }
            _ => return Err("UNSUPPORTED_METHOD"),
        }
        if affected > 0 {
            bump(&tx)?;
        }
        let value = json!({"affected":affected});
        tx.execute(
            "INSERT INTO operation_receipts VALUES(?1,?2,?3,?4)",
            params![op, fingerprint, value.to_string(), now()],
        )
        .stored()?;
        tx.execute("DELETE FROM operation_receipts WHERE id NOT IN (SELECT id FROM operation_receipts ORDER BY created_at DESC LIMIT 256) OR created_at<?1",[now()-24*3600*1000]).stored()?;
        tx.commit().stored()?;
        self.gc()?;
        self.maintenance_pending = self
            .db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM gc_jobs WHERE attempts=0)",
                [],
                |r| r.get(0),
            )
            .stored()?;
        self.maintenance_pending |= self.needs_compaction()?;
        Ok(value)
    }
    pub fn checkpoint(&self) -> Result<()> {
        self.db
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .stored()
    }
    pub fn maintain_if_due(&mut self) -> Result<()> {
        if self.last_calibration.elapsed() >= Duration::from_secs(300) {
            self.calibrate()?;
        }
        if self.maintenance_pending || self.last_maintenance.elapsed() >= Duration::from_secs(600) {
            self.maintain()?;
        }
        Ok(())
    }
    pub fn maintain(&mut self) -> Result<()> {
        let compacting = self.maintenance_pending;
        let tx = self.db.unchecked_transaction().stored()?;
        let cutoff = now() - i64::from(self.rules.retention_days) * 24 * 3600 * 1000;
        let ids: Vec<String> = {
            let mut stmt = tx.prepare("SELECT id FROM items WHERE is_pinned=0 AND (sort_at<?1 OR id IN
            (SELECT id FROM items WHERE is_pinned=0 ORDER BY sort_at DESC,id DESC LIMIT -1 OFFSET ?2)) LIMIT 50").stored()?;
            let rows = stmt
                .query_map(params![cutoff, self.rules.history_limit], |r| r.get(0))
                .stored()?;
            rows.collect::<rusqlite::Result<_>>().stored()?
        };
        for id in &ids {
            delete(&tx, id)?;
        }
        if !ids.is_empty() {
            bump(&tx)?;
        }
        tx.commit().stored()?;
        self.gc()?;
        if self.can_compact {
            self.db
                .execute_batch("PRAGMA incremental_vacuum(128)")
                .stored()?;
        }
        self.maintenance_pending = ids.len() == 50
            || self
                .db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM gc_jobs WHERE attempts=0)",
                    [],
                    |r| r.get(0),
                )
                .stored()?;
        self.maintenance_pending |= self.needs_compaction()?;
        self.last_maintenance = Instant::now();
        // A passive checkpoint never waits on readers; physical calibration is
        // amortized and is forced near the limit.
        self.db
            .execute_batch("PRAGMA wal_checkpoint(PASSIVE)")
            .stored()?;
        if compacting && !self.maintenance_pending {
            self.checkpoint()?;
        }
        if (compacting && !self.maintenance_pending)
            || self.disk_bytes + 32 * MIB >= self.rules.max_disk_mi_b * MIB
        {
            self.calibrate()?;
        }
        Ok(())
    }
    fn needs_compaction(&self) -> Result<bool> {
        Ok(self.can_compact
            && self
                .db
                .query_row("PRAGMA freelist_count", [], |r| r.get::<_, i64>(0))
                .stored()?
                > 256)
    }
    fn recover(&mut self) -> Result<()> {
        // Enumerate names once at startup, never on each clipboard notification.
        for entry in fs::read_dir(self.root.join("staging")).stored()? {
            let path = entry.stored()?.path();
            safe_path(&path)?;
            if path.is_file() {
                fs::remove_file(path).stored()?;
            }
        }
        for dir in ["attachments", "thumbnails"] {
            for entry in fs::read_dir(self.root.join(dir)).stored()? {
                let path = entry.stored()?.path();
                safe_path(&path)?;
                let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                if name.len() != 64 || path.extension().and_then(|s| s.to_str()) != Some("png") {
                    continue;
                }
                let referenced: bool = self
                    .db
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM items WHERE payload_id=?1)",
                        [name],
                        |r| r.get(0),
                    )
                    .stored()?;
                if !referenced && path.is_file() {
                    fs::remove_file(path).stored()?;
                }
            }
        }
        self.gc()
    }
    fn gc(&mut self) -> Result<()> {
        let started = Instant::now();
        let ids: Vec<String> = {
            let mut stmt = self
                .db
                .prepare("SELECT payload_id FROM gc_jobs LIMIT 50")
                .stored()?;
            let rows = stmt.query_map([], |r| r.get(0)).stored()?;
            rows.collect::<rusqlite::Result<_>>().stored()?
        };
        for hash in ids {
            if started.elapsed() > Duration::from_millis(100) {
                break;
            }
            let referenced: bool = self
                .db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM items WHERE payload_id=?1)",
                    [&hash],
                    |r| r.get(0),
                )
                .stored()?;
            if !referenced {
                let mut failed = false;
                for thumbnail in [false, true] {
                    let p = self.file(&hash, thumbnail)?;
                    let length = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                    if let Err(e) = fs::remove_file(p) {
                        if e.kind() != std::io::ErrorKind::NotFound {
                            failed = true;
                        }
                    } else {
                        self.disk_bytes = self.disk_bytes.saturating_sub(length);
                        if thumbnail {
                            self.thumbnail_bytes = self.thumbnail_bytes.saturating_sub(length);
                        }
                    }
                }
                if failed {
                    self.db
                        .execute(
                            "UPDATE gc_jobs SET attempts=attempts+1 WHERE payload_id=?1",
                            [&hash],
                        )
                        .stored()?;
                    continue;
                }
                self.db
                    .execute("DELETE FROM payloads WHERE id=?1", [&hash])
                    .stored()?;
            }
            self.db
                .execute("DELETE FROM gc_jobs WHERE payload_id=?1", [&hash])
                .stored()?;
        }
        Ok(())
    }
    fn calibrate(&mut self) -> Result<()> {
        let mut size = 0u64;
        let mut thumbnails = 0u64;
        for dir in [
            self.root.clone(),
            self.root.join("attachments"),
            self.root.join("thumbnails"),
            self.root.join("staging"),
        ] {
            safe_path(&dir)?;
            for entry in fs::read_dir(dir).stored()? {
                let path = entry.stored()?.path();
                safe_path(&path)?;
                let meta = fs::metadata(&path).stored()?;
                if meta.is_file() {
                    size = size.saturating_add(meta.len());
                    if path.parent() == Some(self.root.join("thumbnails").as_path()) {
                        thumbnails += meta.len();
                    }
                }
            }
        }
        self.disk_bytes = size;
        self.thumbnail_bytes = thumbnails;
        self.last_calibration = Instant::now();
        Ok(())
    }

    fn prune_thumbnails(&mut self) -> Result<()> {
        if self.thumbnail_bytes <= self.rules.max_thumbnail_mi_b * MIB {
            return Ok(());
        }
        let directory = self.root.join("thumbnails");
        safe_path(&directory)?;
        let mut files = Vec::new();
        for entry in fs::read_dir(directory).stored()? {
            let path = entry.stored()?.path();
            safe_path(&path)?;
            let meta = fs::metadata(&path).stored()?;
            if meta.is_file() {
                files.push((meta.modified().ok(), path, meta.len()));
            }
        }
        files.sort_by_key(|entry| entry.0);
        for (_, path, length) in files {
            if self.thumbnail_bytes <= self.rules.max_thumbnail_mi_b * MIB {
                break;
            }
            if fs::remove_file(path).is_ok() {
                self.thumbnail_bytes = self.thumbnail_bytes.saturating_sub(length);
                self.disk_bytes = self.disk_bytes.saturating_sub(length);
            }
        }
        Ok(())
    }
}
fn bump(tx: &Transaction<'_>) -> Result<()> {
    tx.execute(
        "UPDATE metadata SET revision=revision+1 WHERE singleton=1",
        [],
    )
    .stored()?;
    Ok(())
}
fn delete(tx: &Transaction<'_>, id: &str) -> Result<usize> {
    tx.execute(
        "INSERT OR IGNORE INTO gc_jobs SELECT payload_id,0 FROM items WHERE id=?1",
        [id],
    )
    .stored()?;
    tx.execute("DELETE FROM item_search WHERE id=?1", [id])
        .stored()?;
    tx.execute("DELETE FROM items WHERE id=?1", [id]).stored()
}
