// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Integration test for `buildShellExportScript` under a REAL bash process.
 *
 * Why this needs a real subprocess: the contract under test is shell-quoting
 * semantics — sourcing (`.`) the generated export script in an actual shell
 * must populate the environment WITHOUT executing any payload embedded in the
 * raw `.env` values (e.g. `$(touch ...)`). Only a real `bash` can prove that;
 * the in-process CLI harness cannot exercise shell evaluation.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildShellExportScript } from "../../src/commands/env/env";

const createdTmpDirs: string[] = [];

function tmpDir(label = "env"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `akm-${label}-`));
  createdTmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildShellExportScript (real bash)", () => {
  test("eval-ing the emitted script populates env without executing payloads", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    // A raw .env value crafted to run `touch evidence` if it ever reaches a
    // shell unescaped. The export script must keep it a literal string.
    const evidence = path.join(dir, "evidence");
    fs.writeFileSync(fp, `EVIL=$(touch ${evidence})\nOK=ok-value\n`);
    const script = buildShellExportScript(fp);
    const scriptPath = path.join(dir, "eval-me.sh");
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync("bash", ["-c", `set -eu; . '${scriptPath}'; printf '%s\\n' "$EVIL" "$OK"`], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const [evilOut, okOut] = (result.stdout ?? "").split("\n");
    expect(evilOut).toBe(`$(touch ${evidence})`);
    expect(okOut).toBe("ok-value");
    // The command substitution must NOT have run.
    expect(fs.existsSync(evidence)).toBe(false);
  });
});
