// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "../../src/core/paths";

/** Empty the credentials store in the current config directory, so the next test starts with no stored key. */
export function clearCredentials(): void {
  fs.rmSync(path.join(getConfigDir(), "credentials.json"), { force: true });
}
