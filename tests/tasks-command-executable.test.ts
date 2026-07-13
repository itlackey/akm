// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { findBareAkmExecutableIndex } from "../src/tasks/command-executable";

describe("findBareAkmExecutableIndex", () => {
  test.each([
    [["akm", "--version"], 0],
    [["akm.exe", "--version"], 0],
    [["env", "akm", "--version"], 1],
    [["/usr/bin/env", "-i", "--unset", "OLD", "NAME=value", "akm", "--version"], 5],
    [["C:\\tools\\env.exe", "--chdir", "C:\\work", "NAME=value", "akm.exe", "--version"], 4],
    [["env", "--", "NAME=value", "akm", "--version"], 3],
  ])("finds bare akm in the executable position of %j", (command, expected) => {
    expect(findBareAkmExecutableIndex(command)).toBe(expected);
  });

  test.each([
    [["/opt/vendor/akm", "--version"]],
    [["./akm", "--version"]],
    [["env", "NAME=value", "/opt/vendor/akm", "--version"]],
    [["env", "--unset", "akm", "node", "script.js"]],
    [["env", "AKM_BIN=/opt/vendor/akm", "node", "script.js"]],
    [["node", "/opt/vendor/akm", "--version"]],
    [["./env", "akm", "--version"]],
    [["env", "--split-string", "akm --version"]],
  ])("does not classify a path, env operand, or non-executable token in %j", (command) => {
    expect(findBareAkmExecutableIndex(command)).toBeUndefined();
  });
});
