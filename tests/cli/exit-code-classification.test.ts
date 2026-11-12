// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it, test } from "bun:test";
import { emitJsonError } from "../../src/cli/shared";
import { ConfigError, NotFoundError, TransientError, UsageError } from "../../src/core/errors";
import { EMBEDDED_HINTS } from "../../src/output/cli-hints";

// H6 (code-health round-2 audit) — typed error envelope + distinct INTERNAL
// exit code 70.
//
// `classifyExitCode` is internal to src/cli/shared.ts; we exercise it through
// the public `emitJsonError`, which is the single seam that maps a thrown value
// to (a) the JSON error envelope on stderr and (b) the process exit code.
//
// R-067 (PKG-8): `emitJsonError` no longer calls `process.exit()` — it sets
// `process.exitCode` and returns, so a caller's pending `finally` blocks
// (cleanup, e.g. `disposeLlmUsageSink()` in src/cli.ts) actually run
// instead of being skipped by a synchronous process-terminating call. This
// helper now reads `process.exitCode` after the (non-throwing) call instead
// of stubbing `process.exit` to catch a sentinel throw — `emitJsonError`
// doesn't throw or exit at all anymore, so there is nothing to catch.
//
// INTENTIONAL behaviour change asserted here: a genuinely-unexpected error
// (anything that is NOT an `AkmError` — e.g. a bare `Error`/`TypeError`) now
// exits 70 (sysexits EX_SOFTWARE / INTERNAL) instead of collapsing to 1.
// Scripts can therefore distinguish "akm threw unexpectedly" from an ordinary
// `NotFoundError` (still exit 1). Every existing classified exit code is
// asserted UNCHANGED below to lock that in.

interface Captured {
  exitCode: number;
  envelope: Record<string, unknown>;
}

/**
 * Invoke `emitJsonError` with `console.error` stubbed and `process.exitCode`
 * saved/restored, and return the captured exit code plus the parsed JSON
 * envelope.
 */
function runEmit(error: unknown): Captured {
  const realError = console.error;
  const realExitCode = process.exitCode;
  let stderr = "";
  process.exitCode = undefined;
  console.error = (msg?: unknown) => {
    stderr += typeof msg === "string" ? msg : String(msg);
  };
  let exitCode: number;
  try {
    emitJsonError(error);
    exitCode = typeof process.exitCode === "number" ? process.exitCode : -1;
  } finally {
    process.exitCode = realExitCode ?? 0;
    console.error = realError;
  }
  return { exitCode, envelope: JSON.parse(stderr) as Record<string, unknown> };
}

describe("classifyExitCode via emitJsonError (H6)", () => {
  it("restores the local process exit code to numeric zero", () => {
    process.exitCode = 0;
    runEmit(new UsageError("bad flag", "INVALID_FLAG_VALUE"));
    expect(process.exitCode).toBe(0);
  });
  it("UsageError -> exit 2 (unchanged) and carries its code", () => {
    const { exitCode, envelope } = runEmit(new UsageError("bad flag", "INVALID_FLAG_VALUE"));
    expect(exitCode).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("INVALID_FLAG_VALUE");
  });

  it("ConfigError -> exit 78 (unchanged) and carries its code", () => {
    const { exitCode, envelope } = runEmit(new ConfigError("no stash", "STASH_DIR_NOT_FOUND"));
    expect(exitCode).toBe(78);
    expect(envelope.code).toBe("STASH_DIR_NOT_FOUND");
  });

  it("NotFoundError -> exit 1 (unchanged) and carries its code", () => {
    const { exitCode, envelope } = runEmit(new NotFoundError("missing", "ASSET_NOT_FOUND"));
    expect(exitCode).toBe(1);
    expect(envelope.code).toBe("ASSET_NOT_FOUND");
  });

  // #948 addendum: TEMPFAIL(75), distinct from USAGE(2) — a scheduler/cron
  // wrapper retries a TransientError instead of treating it as a bad command
  // line. Single-source table lives in EXIT_CODES (src/cli/shared.ts).
  it("TransientError -> exit 75 (TEMPFAIL) and carries its code", () => {
    const { exitCode, envelope } = runEmit(new TransientError("locked", "STATE_DB_CONTENDED"));
    expect(exitCode).toBe(75);
    expect(envelope.code).toBe("STATE_DB_CONTENDED");
  });

  // INTENTIONAL behaviour change: non-AkmError now exits 70, not 1.
  it("bare Error (unexpected/internal) -> exit 70 (INTERNAL), no code field", () => {
    const { exitCode, envelope } = runEmit(new Error("akm internally threw"));
    expect(exitCode).toBe(70);
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toBe("akm internally threw");
    // Unexpected errors have no stable machine-readable code.
    expect(envelope.code).toBeUndefined();
  });

  it("TypeError (programming bug) -> exit 70 (INTERNAL)", () => {
    const { exitCode } = runEmit(new TypeError("x is not a function"));
    expect(exitCode).toBe(70);
  });

  it("non-Error throw (string) -> exit 70 (INTERNAL)", () => {
    const { exitCode, envelope } = runEmit("boom");
    expect(exitCode).toBe(70);
    expect(envelope.error).toBe("boom");
  });
});

describe("embedded exit-code hints", () => {
  for (const [name, hints] of [["brief", EMBEDDED_HINTS]] as const) {
    test(`${name} pins health/internal codes and command failure semantics`, () => {
      expect(hints).toContain("| 4 | Health warning (`akm doctor` or `akm health`) |");
      expect(hints).toContain("| 70 | Internal / unclassified error |");
      expect(hints).toContain("Not found or command-reported failure");
      expect(hints).toContain("| 75 | Transient");
    });
  }
});

/**
 * "Not found" must mean exit 1 everywhere.
 *
 * STABILITY.md documents exit 1 as "requested resource missing" and scripts
 * branch on it, but three commands disagreed: `feedback` and `sync` raised
 * UsageError (exit 2, "you typed it wrong") for a well-formed ref that simply
 * did not exist, and `registry remove` returned a SUCCESS envelope with
 * `removed: false` and exit 0 — so `akm registry remove typo && deploy` ran
 * the deploy. A missing proposal additionally reported FILE_NOT_FOUND, whose
 * canned hint ("Check the path exists and is readable") describes a
 * filesystem path, not the id or ref the user actually passed.
 */

describe("not-found error classification", () => {
  test("PROPOSAL_NOT_FOUND hints at the command that lists valid ids", () => {
    const err = new NotFoundError('Proposal "p-123" not found.', "PROPOSAL_NOT_FOUND");

    expect(err.hint()).toContain("akm proposal list");
    // The old FILE_NOT_FOUND hint pointed at a filesystem path, which a
    // proposal id never is.
    expect(err.hint()).not.toContain("path exists");
  });

  test("every not-found code carries the not-found kind (which maps to exit 1)", () => {
    for (const code of [
      "ASSET_NOT_FOUND",
      "SOURCE_NOT_FOUND",
      "WORKFLOW_NOT_FOUND",
      "PROPOSAL_NOT_FOUND",
      "FILE_NOT_FOUND",
      "IMPROVE_RUN_NOT_FOUND",
    ] as const) {
      expect(new NotFoundError("missing", code).kind).toBe("not-found");
    }
  });

  test("IMPROVE_RUN_NOT_FOUND hints at akm improve report, not raw sqlite3 (#944)", () => {
    const err = new NotFoundError("akm improve report: no improve runs recorded yet.", "IMPROVE_RUN_NOT_FOUND");

    expect(err.hint()).toContain("akm improve report --since 30d");
    // #944 exists specifically to make querying state.db by hand unnecessary
    // for this — the hint must not send operators back to raw sqlite3.
    expect(err.hint()).not.toContain("sqlite3");
  });

  test("an explicit hint overrides the code's canned one", () => {
    const err = new NotFoundError(
      'No registry matching "x" is configured.',
      "SOURCE_NOT_FOUND",
      "Run `akm registry list` to see configured registries.",
    );

    expect(err.hint()).toContain("akm registry list");
  });
});
