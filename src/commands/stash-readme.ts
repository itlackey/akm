// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";

const TEMPLATE_PATH = path.join(import.meta.dir, "../assets/templates/stash-readme.md");
const README_FILENAME = "README.md";

/**
 * Write a README.md to a newly-created stash directory.
 *
 * Only writes when the file does not already exist — never overwrites a
 * README the user has already customised. The stash directory name is
 * interpolated into the template as the heading.
 *
 * Non-fatal: if the template is missing or the write fails the caller
 * continues normally — a missing README is not a blocking error.
 */
export function writeStashReadme(stashDir: string): void {
  const dest = path.join(stashDir, README_FILENAME);
  if (fs.existsSync(dest)) return;

  let template: string;
  try {
    template = fs.readFileSync(TEMPLATE_PATH, "utf8");
  } catch {
    return;
  }

  const stashName = path.basename(stashDir);
  const content = template.replace("{{STASH_NAME}}", stashName);

  try {
    fs.writeFileSync(dest, content, "utf8");
  } catch {
    // Non-fatal — stash is usable without a README
  }
}
