CREATE TABLE metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),dataset_id TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE payloads(id TEXT PRIMARY KEY,mime TEXT NOT NULL,byte_length INTEGER NOT NULL,text_body TEXT,width INTEGER NOT NULL,height INTEGER NOT NULL);
CREATE TABLE items(id TEXT PRIMARY KEY,payload_id TEXT NOT NULL UNIQUE REFERENCES payloads(id),kind TEXT NOT NULL CHECK(kind IN ('text','url','image','files')),
 preview TEXT NOT NULL,source TEXT NOT NULL,created_at INTEGER NOT NULL,last_copied_at INTEGER NOT NULL,last_used_at INTEGER NOT NULL DEFAULT 0,sort_at INTEGER NOT NULL,
 is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0,1)),pinned_order INTEGER NOT NULL DEFAULT 0,copy_count INTEGER NOT NULL DEFAULT 1,use_count INTEGER NOT NULL DEFAULT 0);
CREATE INDEX items_order ON items(is_pinned DESC,pinned_order DESC,sort_at DESC,id DESC);
CREATE INDEX items_kind ON items(kind,sort_at DESC,id DESC);
CREATE VIRTUAL TABLE item_search USING fts5(id UNINDEXED,text,tokenize='trigram');
CREATE TABLE gc_jobs(payload_id TEXT PRIMARY KEY,attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE operation_receipts(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at INTEGER NOT NULL);
