// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Characterization test for WS8 (epic #490) — unifying the two atomic-write
 * implementations into one. Before this slice, `src/commands/secret.ts` carried
 * a hand-rolled `writeSecretAtomic(target, Buffer)` byte-for-byte identical to
 * `core/common.ts:writeFileAtomic` except it accepted a `Buffer` instead of a
 * `string`. This test pins the behaviour `writeFileAtomic` MUST preserve once
 * the Buffer overload is folded in and `writeSecretAtomic` is deleted:
 *
 *   1. Buffer content round-trips byte-exact (binary/CRLF preserved) —
 *      the reason secret.ts needed its own impl.
 *   2. The created file is mode 0600 (secrets must never be world-readable,
 *      even transiently — the temp file is opened 0600 from the start).
 *   3. String content still writes byte-exact (existing callers unaffected).
 *   4. Default mode for string writes is 0600 (the documented default).
 *
 * Written BEFORE the swap, per the #490 HARD CONTRACT (characterization tests
 * precede any non-mechanical change; the secret swap is gated on same-bytes +
 * same-mode).
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../../src/core/common";

const createdDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-atomic-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("writeFileAtomic — Buffer + string content, 0600 mode", () => {
  test("writes Buffer content byte-exact (binary preserved)", () => {
    const dir = tmpDir();
    const target = path.join(dir, "secret.bin");
    // Bytes that would be mangled by any text-mode round-trip: NUL, high bytes,
    // CR/LF, a lone CR.
    const data = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x41, 0x0d, 0xfe, 0x42]);
    writeFileAtomic(target, data, 0o600);
    const read = fs.readFileSync(target);
    expect(read.equals(data)).toBe(true);
  });

  test("creates the file at mode 0600 when written with a Buffer", () => {
    const dir = tmpDir();
    const target = path.join(dir, "secret.key");
    writeFileAtomic(target, Buffer.from("super-secret"), 0o600);
    const mode = fs.statSync(target).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("writes string content byte-exact (existing callers unaffected)", () => {
    const dir = tmpDir();
    const target = path.join(dir, "config.json");
    const content = '{"a":1}\n';
    writeFileAtomic(target, content);
    expect(fs.readFileSync(target, "utf8")).toBe(content);
  });

  test("defaults to mode 0600 for string content", () => {
    const dir = tmpDir();
    const target = path.join(dir, "default-mode.txt");
    writeFileAtomic(target, "data");
    const mode = fs.statSync(target).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("honours an explicit non-default mode", () => {
    const dir = tmpDir();
    const target = path.join(dir, "world-readable.txt");
    writeFileAtomic(target, "data", 0o644);
    const mode = fs.statSync(target).mode & 0o777;
    expect(mode).toBe(0o644);
  });

  test("leaves no temp files behind after a successful write", () => {
    const dir = tmpDir();
    const target = path.join(dir, "clean.txt");
    writeFileAtomic(target, "data");
    const leftovers = fs.readdirSync(dir).filter((n) => n.includes(".tmp."));
    expect(leftovers).toEqual([]);
  });
});
