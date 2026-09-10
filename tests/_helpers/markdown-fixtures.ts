// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared markdown-fixture writer, factored out of
 * tests/integration/bundle-update-embedding-durability.test.ts so
 * tests/integration/indexer/embedding-mid-run-visibility.test.ts (#954,
 * field-report follow-up) can reuse it rather than duplicating it.
 */

import fs from "node:fs";
import path from "node:path";

/** Write `fileCount` trivial knowledge entries under `rootDir/knowledge/`. */
export function writeMarkdownFiles(rootDir: string, fileCount: number, marker: string): void {
  fs.mkdirSync(path.join(rootDir, "knowledge"), { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    fs.writeFileSync(
      path.join(rootDir, "knowledge", `entry-${i}.md`),
      `---\ndescription: ${marker} entry ${i}\n---\n\nContent for ${marker} entry ${i}.\n`,
    );
  }
}
