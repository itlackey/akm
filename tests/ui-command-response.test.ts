// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test } from "bun:test";
import { parseCommandResponse } from "../src/commands/ui/workspace-actions";

test("workspace command responses require the expected JSON result and never report false success", () => {
  for (const stdout of [
    "",
    "not JSON",
    "null",
    "[]",
    "{}",
    '{"shape":"remove","schemaVersion":1}',
    '{"shape":"import","schemaVersion":1,"ok":false}',
  ]) {
    expect(() => parseCommandResponse(stdout, "import")).toThrow("State may already have changed");
    try {
      parseCommandResponse(stdout, "import");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_COMMAND_RESPONSE" });
      expect((error as Error).message).toContain("Reload the view before retrying");
    }
  }
  expect(parseCommandResponse('{"shape":"import","schemaVersion":1,"ref":"knowledge/new"}', "import")).toMatchObject({
    ref: "knowledge/new",
  });
});
