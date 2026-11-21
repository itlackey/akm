// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Env file lines whose value holds a `#`, with the value a person reads in them. `bash` is false where bash's
 * `source` reads the line differently (a space outside quotes splits words; `A=#x` is the value `#x`), so only the
 * stated value is the reference, which is dotenv's and docker compose's.
 */
export const ENV_HASH_CASES: { name: string; text: string; key: string; value: string; bash: boolean }[] = [
  { name: "url fragment", text: "URL=http://x/y#frag\n", key: "URL", value: "http://x/y#frag", bash: true },
  { name: "hash then words", text: "PW=pa#ss word\n", key: "PW", value: "pa#ss word", bash: false },
  { name: "comment after space", text: "A=v # c\n", key: "A", value: "v", bash: true },
  { name: "value starting with #", text: "A=#x\n", key: "A", value: "", bash: false },
  { name: "single-quoted", text: "A='q#x'\n", key: "A", value: "q#x", bash: true },
  { name: "double-quoted", text: 'A="q#x"\n', key: "A", value: "q#x", bash: true },
  { name: "multi-line quoted", text: 'A="l1\nl2 # not\n#l3"\n', key: "A", value: "l1\nl2 # not\n#l3", bash: true },
  { name: "export", text: "export A=b#c\n", key: "A", value: "b#c", bash: true },
  { name: "hash and comment", text: "A=v#a #b\n", key: "A", value: "v#a", bash: true },
  { name: "tab before comment", text: "A=v\t#c\n", key: "A", value: "v", bash: true },
  { name: "value with a quote", text: "A=it's#x\n", key: "A", value: "it's#x", bash: false },
  {
    name: "all three quotes then hash",
    text: 'C=it\'s `q` "d"#tail\n',
    key: "C",
    value: 'it\'s `q` "d"#tail',
    bash: false,
  },
  { name: "quoted assignment of the same key later", text: "A=x#y\nA='z#w'\n", key: "A", value: "z#w", bash: true },
];

/** What bash gives `key` after `set -a; . file`. */
export function bashValue(text: string, key: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-env-bash-"));
  try {
    const file = path.join(dir, "case.env");
    fs.writeFileSync(file, text);
    const result = spawnSync("bash", ["-c", `set -a; . "$1"; printf %s "\${${key}-}"`, "bash", file], {
      encoding: "utf8",
    });
    return result.stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
