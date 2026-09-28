-- Real-shaped layout-25 derived index, written by 0.9.17-alpha.7 (`akm index --full`) over a
-- small stash and trimmed to the tables the layout-26 migration reads. The frontmatter relations
-- (xrefs, supersededBy, contradictedBy, derivedFrom, wiki sources, a task target) sit in
-- document_json exactly as that release stored them; nothing stored them as links.
CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO index_meta VALUES ('version', '25');
INSERT INTO index_meta VALUES ('hasEmbeddings', '0');
INSERT INTO index_meta VALUES ('stashDir', '/fixture/stash');
CREATE TABLE entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_ref TEXT NOT NULL UNIQUE,
  bundle_id TEXT NOT NULL, component_id TEXT NOT NULL, concept_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL, type TEXT NOT NULL, file_path TEXT NOT NULL,
  content_hash TEXT, document_json TEXT NOT NULL, derived_from TEXT, embed_hash TEXT
);
CREATE INDEX idx_entries_bundle ON entries(bundle_id);
CREATE INDEX idx_entries_type ON entries(type);
CREATE INDEX idx_entries_file_path ON entries(file_path);
CREATE INDEX idx_entries_derived_from ON entries(derived_from);
CREATE TABLE entry_fragments (
  entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE, safe_markdown TEXT NOT NULL
);
CREATE VIRTUAL TABLE entries_fts USING fts5(entry_id UNINDEXED, name, description, tags, hints, content,
  content='', contentless_delete=1, tokenize='porter unicode61');
CREATE TABLE index_dir_state (
  dir_path TEXT PRIMARY KEY, file_set_hash TEXT NOT NULL, file_mtime_max_ms REAL NOT NULL, reason TEXT NOT NULL,
  updated_at TEXT NOT NULL, row_count INTEGER, index_variant TEXT
);
INSERT INTO entries (id, item_ref, bundle_id, component_id, concept_id, adapter_id, type, file_path, content_hash, document_json, derived_from, embed_hash) VALUES (1, 'stash//memories/deploy-window-moved.derived', 'stash', 'stash', 'memories/deploy-window-moved.derived', 'akm', 'memory', '/fixture/stash/memories/deploy-window-moved.derived.md', '19ab42b364f3d3ab932c22df3eb6aaf37e6f58e1f6e02d26efcb28ef8b8b8acf', '{"name":"deploy-window-moved.derived","type":"memory","filename":"deploy-window-moved.derived.md","description":"Derived summary of the Thursday deploy window","tags":["deploy","window","moved","derived"],"content":"Thursday is the deploy window.","aliases":["deploy window moved.derived","deploy window moved derived"],"searchHints":["memories/deploy-window-moved","observed_at:2026-09-28"],"quality":"generated","confidence":0.9,"derivedFrom":"memories/deploy-window-moved","source":"frontmatter","fileSize":151}', 'memories/deploy-window-moved', '95b487526a42ad239a294a47ba49de268275d9d3ea41ba49e1c1287c5476193b');
INSERT INTO entries_fts (rowid, name, description, tags, hints, content) VALUES (1, 'deploy window moved.derived', 'Derived summary of the Thursday deploy window', 'deploy window moved derived', 'memories/deploy-window-moved observed_at:2026-09-28', 'Thursday is the deploy window.');
INSERT INTO entries (id, item_ref, bundle_id, component_id, concept_id, adapter_id, type, file_path, content_hash, document_json, derived_from, embed_hash) VALUES (2, 'stash//memories/deploy-window-moved', 'stash', 'stash', 'memories/deploy-window-moved', 'akm', 'memory', '/fixture/stash/memories/deploy-window-moved.md', '80039969c542239c9176db7c9323286cc8251c6184cad70254031b2c5e2dc7e2', '{"name":"deploy-window-moved","type":"memory","filename":"deploy-window-moved.md","description":"The deploy window moved to Thursday","tags":["deploy"],"content":"The deploy window moved to Thursday.","aliases":["deploy window moved"],"searchHints":["observed_at:2026-09-28"],"quality":"generated","confidence":0.9,"captureMode":"hot","source":"frontmatter","fileSize":149}', NULL, 'f3a93a8b357c89f17d4b523bbeddf1f56ddbe549a8ba217e3ae7a72ad5299c3f');
INSERT INTO entries_fts (rowid, name, description, tags, hints, content) VALUES (2, 'deploy window moved', 'The deploy window moved to Thursday', 'deploy', 'observed_at:2026-09-28', 'The deploy window moved to Thursday.');
INSERT INTO entries (id, item_ref, bundle_id, component_id, concept_id, adapter_id, type, file_path, content_hash, document_json, derived_from, embed_hash) VALUES (3, 'stash//memories/deploy-window', 'stash', 'stash', 'memories/deploy-window', 'akm', 'memory', '/fixture/stash/memories/deploy-window.md', '9223433ba34dcb23c0f01d57733b924d36eebd6bf2890de28e02b07b0d30efa8', '{"name":"deploy-window","type":"memory","filename":"deploy-window.md","description":"Deploys run in the Tuesday window","tags":["deploy"],"content":"Deploys run in the Tuesday window.","aliases":["deploy window"],"searchHints":["observed_at:2026-09-28"],"quality":"generated","confidence":0.9,"beliefState":"contradicted","captureMode":"hot","xrefs":["memories/release-checklist","wiki:notes/pages/release-train"],"source":"frontmatter","contradictedBy":["memory:deploy-window-moved"],"sources":["session:claude-code:agent-a0000000000000001"],"fileSize":348}', NULL, 'f1dd7d48d0650c908b9be3edd14936398721f0c9323b74690260c498a902a4c4');
INSERT INTO entries_fts (rowid, name, description, tags, hints, content) VALUES (3, 'deploy window', 'Deploys run in the Tuesday window', 'deploy', 'observed_at:2026-09-28', 'Deploys run in the Tuesday window.');
INSERT INTO entries (id, item_ref, bundle_id, component_id, concept_id, adapter_id, type, file_path, content_hash, document_json, derived_from, embed_hash) VALUES (4, 'stash//knowledge/release-guide-v2', 'stash', 'stash', 'knowledge/release-guide-v2', 'akm', 'knowledge', '/fixture/stash/knowledge/release-guide-v2.md', 'd00a3ffc9fa6c5b62aa92b8d74b43cce9f80121a9aa1d6d9e9ae87b9deb11eb2', '{"name":"release-guide-v2","type":"knowledge","filename":"release-guide-v2.md","description":"How releases are cut, second edition","tags":["release","guide","v2"],"content":"Release guide v2","aliases":["release guide v2"],"quality":"generated","confidence":0.9,"toc":[{"level":1,"text":"Release guide v2","line":5}],"source":"frontmatter","fileSize":78}', NULL, '33397f7a7e54e5ae45bce93f87b339296ca07eeef0417793ac7fd140c320af77');
INSERT INTO entries_fts (rowid, name, description, tags, hints, content) VALUES (4, 'release guide v2', 'How releases are cut, second edition', 'release guide v2', '', 'Release guide v2');
INSERT INTO entries (id, item_ref, bundle_id, component_id, concept_id, adapter_id, type, file_path, content_hash, document_json, derived_from, embed_hash) VALUES (5, 'stash//knowledge/release-guide', 'stash', 'stash', 'knowledge/release-guide', 'akm', 'knowledge', '/fixture/stash/knowledge/release-guide.md', '8056c929c0ee03970f06af37d9c1d031cb27fa9f8ae552bbb7505309121bf3f8', '{"name":"release-guide","type":"knowledge","filename":"release-guide.md","description":"How releases are cut","tags":["release","guide"],"content":"Release guide","aliases":["release guide"],"quality":"generated","confidence":0.9,"xrefs":["knowledge/missing-page"],"toc":[{"level":1,"text":"Release guide","line":9}],"source":"frontmatter","supersededBy":["stash//knowledge/release-guide-v2"],"fileSize":145}', NULL, 'c4081a49cfb55f92ea0ad34140fb805e545c282d519c31c4388a65cf5bcb5e1b');
INSERT INTO entries_fts (rowid, name, description, tags, hints, content) VALUES (5, 'release guide', 'How releases are cut', 'release guide', '', 'Release guide');
INSERT INTO entries (id, item_ref, bundle_id, component_id, concept_id, adapter_id, type, file_path, content_hash, document_json, derived_from, embed_hash) VALUES (6, 'stash//knowledge/wikis/notes/pages/release-train', 'stash', 'stash', 'knowledge/wikis/notes/pages/release-train', 'akm', 'knowledge', '/fixture/stash/wikis/notes/pages/release-train.md', 'c69d79a7a677b9fb7a665bb92d93dd38c77b6a28d0f142dce84dd7f2de4dc99c', '{"name":"wikis/notes/pages/release-train","type":"knowledge","filename":"release-train.md","description":"The release train page","tags":["release","train","wikis","notes","pages"],"content":"Release train","aliases":["wikis/notes/pages/release train","release train wikis notes pages"],"quality":"generated","confidence":0.9,"xrefs":["wiki:notes/raw/train-source"],"pageKind":"concept","toc":[{"level":1,"text":"Release train","line":10}],"source":"frontmatter","sources":["raw/train-source.md"],"fileSize":151}', NULL, '11d7ef607dbd6aca5a10390b0d770107960258faa54d2ee97b02466aa97c6e2c');
INSERT INTO entries_fts (rowid, name, description, tags, hints, content) VALUES (6, 'wikis/notes/pages/release train', 'The release train page', 'release train wikis notes pages', '', 'Release train');
INSERT INTO entries (id, item_ref, bundle_id, component_id, concept_id, adapter_id, type, file_path, content_hash, document_json, derived_from, embed_hash) VALUES (7, 'stash//knowledge/wikis/notes/raw/train-source', 'stash', 'stash', 'knowledge/wikis/notes/raw/train-source', 'akm', 'knowledge', '/fixture/stash/wikis/notes/raw/train-source.md', '2b52613b5766a7df2e1c4d5071e4d3e128dfe474f9341a32ddeb686b2be16406', '{"name":"wikis/notes/raw/train-source","type":"knowledge","filename":"train-source.md","description":"Snapshot of the release train source","tags":["train","source","wikis","notes","raw"],"content":"Source text.","aliases":["wikis/notes/raw/train source","train source wikis notes raw"],"quality":"generated","confidence":0.9,"source":"frontmatter","fileSize":72}', NULL, '98236898afbc2804b84730456a6cde44d35022f9b7c849f24f33acda98fec2ec');
INSERT INTO entries_fts (rowid, name, description, tags, hints, content) VALUES (7, 'wikis/notes/raw/train source', 'Snapshot of the release train source', 'train source wikis notes raw', '', 'Source text.');
INSERT INTO entries (id, item_ref, bundle_id, component_id, concept_id, adapter_id, type, file_path, content_hash, document_json, derived_from, embed_hash) VALUES (15, 'stash//tasks/nightly-release', 'stash', 'stash', 'tasks/nightly-release', 'akm', 'task', '/fixture/stash/tasks/nightly-release.yml', 'c24512446158321f70316355a653c9e4965827120391c4982fabb50e939dee60', '{"name":"nightly-release","type":"task","filename":"nightly-release.yml","description":"Run the release workflow nightly.","tags":["task","scheduled"],"aliases":["nightly release","task scheduled"],"searchHints":["schedule:0 3 * * *","workflow:workflows/release"],"quality":"generated","confidence":0.9,"source":"task-source","fileSize":126}', NULL, '433554b102964447d4657b6383989e443efb9330a24f9855a81df56e548bdcc5');
INSERT INTO entries_fts (rowid, name, description, tags, hints, content) VALUES (15, 'nightly release', 'Run the release workflow nightly.', 'task scheduled', 'schedule:0 3 * * * workflow:workflows/release', '');
INSERT INTO entries (id, item_ref, bundle_id, component_id, concept_id, adapter_id, type, file_path, content_hash, document_json, derived_from, embed_hash) VALUES (16, 'stash//commands/cut-release', 'stash', 'stash', 'commands/cut-release', 'akm', 'command', '/fixture/stash/commands/cut-release.md', '81a8b201454461142bd40874caf0fc6a11fb89eebbdb497622415235e852acae', '{"name":"cut-release","type":"command","filename":"cut-release.md","description":"Cut a release branch","tags":["cut","release"],"content":"Cut the release branch for $ARGUMENTS.","aliases":["cut release"],"quality":"generated","confidence":0.9,"parameters":[{"name":"ARGUMENTS"}],"source":"frontmatter","fileSize":82}', NULL, 'bd258cb6480997582420de1fe723894d5c2c94235368a14935ef5519def34757');
INSERT INTO entries_fts (rowid, name, description, tags, hints, content) VALUES (16, 'cut release', 'Cut a release branch', 'cut release', '', 'Cut the release branch for $ARGUMENTS.');
INSERT INTO entries (id, item_ref, bundle_id, component_id, concept_id, adapter_id, type, file_path, content_hash, document_json, derived_from, embed_hash) VALUES (25, 'stash//workflows/release', 'stash', 'stash', 'workflows/release', 'akm', 'workflow', '/fixture/stash/workflows/release.yml', '9616ddbfd3247c8a1cade6d2585aed6d678cf98f15099342257c1aeb32cc54d1', '{"name":"release","type":"workflow","filename":"release.yml","description":"release","tags":["release"],"searchHints":["cut","Invoke local target commands/cut-release."],"quality":"generated","confidence":0.55,"source":"filename","fileSize":191}', NULL, 'c51287cc797cb7d18b7873d81d978d1e85156589eeb2de253c388f0dbd0f33b2');
INSERT INTO entries_fts (rowid, name, description, tags, hints, content) VALUES (25, 'release', 'release', 'release', 'cut Invoke local target commands/cut-release.', '');
INSERT INTO entry_fragments VALUES (1, '





Thursday is the deploy window.
');
INSERT INTO entry_fragments VALUES (2, '







The deploy window moved to Thursday.
');
INSERT INTO entry_fragments VALUES (3, '















Deploys run in the Tuesday window.
');
INSERT INTO entry_fragments VALUES (4, '



# Release guide v2
');
INSERT INTO entry_fragments VALUES (5, '







# Release guide
');
INSERT INTO entry_fragments VALUES (6, '








# Release train
');
INSERT INTO entry_fragments VALUES (7, '



Source text.
');
INSERT INTO entry_fragments VALUES (16, '



Cut the release branch for $ARGUMENTS.
');
INSERT INTO index_dir_state VALUES ('/fixture/stash/commands', 'f04716e51dfe28d07d29f0c6cf0ec9f9b50004462b3f0e64d30ac1fdc2a9095d', 1790605709992.0, 'full-rebuild', '2026-09-28T14:28:36.443Z', 1, 'akm@0.9.0');
INSERT INTO index_dir_state VALUES ('/fixture/stash/knowledge', 'c12860eef7a5b8cec5db0b04572b826eeac986763dfc870ff545a776a09d22e2', 1790605679499.0, 'full-rebuild', '2026-09-28T14:28:36.442Z', 2, 'akm@0.9.0');
INSERT INTO index_dir_state VALUES ('/fixture/stash/memories', '5726531d9161b70d5805894c076a09f9ef9616a494410bb391ccdda74741851c', 1790605679494.0, 'full-rebuild', '2026-09-28T14:28:36.442Z', 3, 'akm@0.9.0');
INSERT INTO index_dir_state VALUES ('/fixture/stash/tasks', 'e09f25b2de62085eab75660e941dd9ecd31e70983aee07d2af6c45481100190d', 1790605709997.0, 'full-rebuild', '2026-09-28T14:28:36.443Z', 1, 'akm@0.9.0');
INSERT INTO index_dir_state VALUES ('/fixture/stash/wikis/notes/pages', 'a7e85a02643e5b4ac11fd5427e01787070f51fa7903fd6a1a4cd794ef0799805', 1790605679501.0, 'full-rebuild', '2026-09-28T14:28:36.442Z', 1, 'akm@0.9.0');
INSERT INTO index_dir_state VALUES ('/fixture/stash/wikis/notes/raw', '8b5eba375cd75f6a7c91cf2344b790579d95451247be8d404177ae0b95112d56', 1790605679505.0, 'full-rebuild', '2026-09-28T14:28:36.442Z', 1, 'akm@0.9.0');
INSERT INTO index_dir_state VALUES ('/fixture/stash/workflows', '939198d9666370570703a6e6e8878115b7ef17745bbae0a0e5050f8531d6e055', 1790605716225.0, 'full-rebuild', '2026-09-28T14:28:36.443Z', 1, 'akm@0.9.0');
