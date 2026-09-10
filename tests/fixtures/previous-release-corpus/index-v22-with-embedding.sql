-- Real-shaped v22 derived index with a live embedding present, used by
-- #955: a generation bump must salvage the embedding across the v22->v23
-- rebuild rather than silently discarding it and forcing a re-embed.
CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO index_meta VALUES ('version', '22');
INSERT INTO index_meta VALUES ('embeddingFingerprint', 'local:test-model');
CREATE TABLE entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_ref TEXT NOT NULL UNIQUE,
  bundle_id TEXT NOT NULL, component_id TEXT NOT NULL, concept_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL, type TEXT NOT NULL, file_path TEXT NOT NULL,
  content_hash TEXT, document_json TEXT NOT NULL, search_text TEXT NOT NULL,
  derived_from TEXT
);
INSERT INTO entries (item_ref,bundle_id,component_id,concept_id,adapter_id,type,file_path,document_json,search_text)
VALUES ('stash//knowledge/v22-embedded','stash','stash','knowledge/v22-embedded','akm','knowledge','/fixture/v22-embedded.md',
 '{"name":"v22-embedded","type":"knowledge","description":"prior release parent row with an embedding","content":"whole body evidence"}',
 'v22-embedded prior release parent row with an embedding whole body evidence');
CREATE TABLE embeddings (
  id INTEGER PRIMARY KEY,
  embedding BLOB NOT NULL,
  FOREIGN KEY (id) REFERENCES entries(id)
);
-- Float32[1.0, 2.0, 3.0], little-endian.
INSERT INTO embeddings (id, embedding) VALUES (1, X'0000803F0000004000004040');
CREATE VIRTUAL TABLE entries_fts USING fts5(entry_id UNINDEXED,name,description,tags,hints,content,tokenize='porter unicode61');
INSERT INTO entries_fts VALUES (1,'v22-embedded','prior release parent row with an embedding','','','whole body evidence');
