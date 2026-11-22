// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";

/**
 * Read a secret file's value: the file content as UTF-8 with surrounding
 * whitespace trimmed, so a hand-written file's trailing newline never lands in
 * an HTTP header. Consumers (`secret run`, env `${ref}` tokens, config
 * credentials, website fetchers) read a secret through `readSecret`
 * (`env-secret-ref.ts`), which calls this for a secret kept as a file. Callers
 * MUST NOT write the returned value to stdout or any log.
 */
export function readValue(secretPath: string): string {
  return fs.readFileSync(secretPath, "utf8").trim();
}
