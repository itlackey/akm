// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test } from "bun:test";
import { runCliCapture } from "./_helpers/cli";

test("akm doctor --help states its exit codes", async () => {
  const { code, stdout } = await runCliCapture(["doctor", "--help"]);
  expect(code).toBe(0);
  expect(stdout).toContain("Exits 0 when healthy, 4 on a warning, 1 on a failure");
});
