// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";

/**
 * Read a secret's value: the file content as UTF-8 with surrounding whitespace
 * trimmed. The one read every consumer uses (`secret run`, env `${ref}`
 * tokens, config credentials, website fetchers), so a hand-written file's
 * trailing newline never lands in an HTTP header. Callers MUST NOT write the
 * returned value to stdout or any log.
 */
export function readValue(secretPath: string): string {
  return fs.readFileSync(secretPath, "utf8").trim();
}
