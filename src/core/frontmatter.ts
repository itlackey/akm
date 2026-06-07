// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Same-path re-export shim (#490 reorg, Phase 6). frontmatter.ts moved into
// core/asset/frontmatter.ts as part of the core/asset/ nest. This shim keeps
// the historical core/frontmatter import path byte-diff-free for its high
// fan-in external importers (18 sites). Explicit named re-exports only (never
// `export *`), one level; retire once aliases are universal.

export {
  parseFrontmatter,
  parseFrontmatterBlock,
  parseYamlScalar,
} from "./asset/frontmatter";
