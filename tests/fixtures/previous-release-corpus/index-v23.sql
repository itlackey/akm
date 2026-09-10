-- Real-shaped v23 derived index essentials: parent entries, the parent-level
-- FTS population, and the isolated fragment FTS population 0.9.14 added
-- before the index-redesign (index-redesign B5c drops both entries_fts and
-- entry_fragments_fts in v24 — units_fts replaces them).
CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO index_meta VALUES ('version', '23');
CREATE TABLE entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_ref TEXT NOT NULL UNIQUE,
  bundle_id TEXT NOT NULL, component_id TEXT NOT NULL, concept_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL, type TEXT NOT NULL, file_path TEXT NOT NULL,
  content_hash TEXT, document_json TEXT NOT NULL, search_text TEXT NOT NULL,
  derived_from TEXT
);
INSERT INTO entries (item_ref,bundle_id,component_id,concept_id,adapter_id,type,file_path,document_json,search_text)
VALUES ('stash//knowledge/v23-note','stash','stash','knowledge/v23-note','akm','knowledge','/fixture/v23-note.md',
 '{"name":"v23-note","type":"knowledge","description":"prior release parent row","content":"# V23 note\n\nwhole body evidence"}',
 'v23-note prior release parent row whole body evidence');
CREATE VIRTUAL TABLE entries_fts USING fts5(entry_id UNINDEXED,name,description,tags,hints,content,tokenize='porter unicode61');
INSERT INTO entries_fts VALUES (1,'v23-note','prior release parent row','','','whole body evidence');
CREATE TABLE entry_fragments (
  entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  safe_markdown TEXT NOT NULL
);
INSERT INTO entry_fragments VALUES (1, '# V23 note

whole body evidence');
CREATE VIRTUAL TABLE entry_fragments_fts USING fts5(entry_id UNINDEXED,fragment_id UNINDEXED,fragment_ordinal UNINDEXED,content,tokenize='porter unicode61');
INSERT INTO entry_fragments_fts VALUES (1,'akm-fragment-1-aaaaaaaaaaaa',0,'whole body evidence');
