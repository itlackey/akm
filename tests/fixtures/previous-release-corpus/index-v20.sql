-- Real-shaped layout-20 derived index, written by 0.9.1 (`akm index --full`) over a two-note stash and
-- trimmed to the tables the opener reads. `entries` keeps the transitional columns layout 21 removed
-- (`entry_key`, `dir_path`, `stash_dir`, `entry_json`, `entry_type`, each NOT NULL) beside the current
-- ones, which it filled in except `document_json`: that is NULL on every row, and the entry sits in `entry_json`.
-- Paths are rebased to /fixture/stash.
CREATE TABLE index_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
INSERT INTO index_meta VALUES ('builtAt', '2026-10-07T01:57:15.531Z');
INSERT INTO index_meta VALUES ('hasEmbeddings', '0');
INSERT INTO index_meta VALUES ('stashDir', '/fixture/stash');
INSERT INTO index_meta VALUES ('stashDirs', '["/fixture/stash"]');
INSERT INTO index_meta VALUES ('version', '20');
CREATE TABLE entries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_key   TEXT NOT NULL UNIQUE,
      dir_path    TEXT NOT NULL,
      file_path   TEXT NOT NULL,
      stash_dir   TEXT NOT NULL,
      entry_json  TEXT NOT NULL,
      search_text TEXT NOT NULL,
      entry_type  TEXT NOT NULL,
      derived_from TEXT,
      -- Chunk-5 Step 2 / DB v18 (spec 14.4): bundle-adapter identity + provenance,
      -- ADDITIVE alongside the legacy columns above. item_ref is the durable
      -- <bundle>//<concept-id> spelling; nullable during the transition so a
      -- pre-repoint reader path never trips a NOT NULL on a partially-migrated row.
      item_ref     TEXT,
      bundle_id    TEXT,
      component_id TEXT,
      concept_id   TEXT,
      adapter_id   TEXT,
      type         TEXT,
      content_hash TEXT,
      document_json TEXT
    );
CREATE INDEX idx_entries_dir ON entries(dir_path);
CREATE INDEX idx_entries_type ON entries(entry_type);
CREATE INDEX idx_entries_file_path ON entries(file_path);
CREATE UNIQUE INDEX idx_entries_item_ref ON entries(item_ref);
CREATE INDEX idx_entries_derived_from ON entries(derived_from);
CREATE VIRTUAL TABLE entries_fts USING fts5(
        entry_id UNINDEXED,
        name,
        description,
        tags,
        hints,
        content,
        tokenize='porter unicode61'
      );
CREATE TABLE embeddings (
      id        INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL,
      FOREIGN KEY (id) REFERENCES entries(id)
    );
CREATE TABLE utility_scores (
      entry_id     INTEGER PRIMARY KEY,
      utility      REAL NOT NULL DEFAULT 0,
      show_count   INTEGER NOT NULL DEFAULT 0,
      search_count INTEGER NOT NULL DEFAULT 0,
      select_rate  REAL NOT NULL DEFAULT 0,
      last_used_at TEXT,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
    );
CREATE TABLE index_dir_state (
      dir_path          TEXT PRIMARY KEY,
      file_set_hash     TEXT NOT NULL,
      file_mtime_max_ms REAL NOT NULL,
      reason            TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );
INSERT INTO index_dir_state VALUES ('/fixture/stash/knowledge', 'akm@0.9.0', 1791338235308.91, 'full-rebuild', '2026-10-07T01:57:15.528Z');
INSERT INTO entries (id, entry_key, dir_path, file_path, stash_dir, entry_json, search_text, entry_type, derived_from, item_ref, bundle_id, component_id, concept_id, adapter_id, type, content_hash, document_json) VALUES (1, '/fixture/stash:knowledge:cache', '/fixture/stash/knowledge', '/fixture/stash/knowledge/cache.md', '/fixture/stash', '{"name":"cache","type":"knowledge","filename":"cache.md","description":"Second note about caching.","tags":["cache"],"quality":"generated","confidence":0.9,"toc":[{"level":1,"text":"Cache","line":4}],"source":"frontmatter","fileSize":76}', 'cache second note about caching. cache cache', 'knowledge', NULL, 'stash//knowledge/cache', 'stash', 'stash', 'knowledge/cache', 'akm', 'knowledge', '257db89fca35db8b166c2d612a96c7bfd49beae661915058a755973385090f1e', NULL);
INSERT INTO entries (id, entry_key, dir_path, file_path, stash_dir, entry_json, search_text, entry_type, derived_from, item_ref, bundle_id, component_id, concept_id, adapter_id, type, content_hash, document_json) VALUES (2, '/fixture/stash:knowledge:demo', '/fixture/stash/knowledge', '/fixture/stash/knowledge/demo.md', '/fixture/stash', '{"name":"demo","type":"knowledge","filename":"demo.md","description":"Demo note.","tags":["demo"],"quality":"generated","confidence":0.9,"toc":[{"level":1,"text":"Demo","line":4}],"source":"frontmatter","fileSize":46}', 'demo demo note. demo demo', 'knowledge', NULL, 'stash//knowledge/demo', 'stash', 'stash', 'knowledge/demo', 'akm', 'knowledge', 'a5029a82d755ac19faeae3b67a2ce4d7d7d4980ca4d5ac99524c10017cfabfc5', NULL);
INSERT INTO entries_fts (rowid, entry_id, name, description, tags, hints, content) VALUES (1, 1, 'cache', 'second note about caching.', 'cache', '', 'cache');
INSERT INTO entries_fts (rowid, entry_id, name, description, tags, hints, content) VALUES (2, 2, 'demo', 'demo note.', 'demo', '', 'demo');
