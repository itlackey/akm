// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// H6 (code-health round-2 audit) — typed error envelope + distinct INTERNAL
// exit code 70.
//
// `classifyExitCode` is internal to src/cli/shared.ts; we exercise it through
// the public `emitJsonError`, which is the single seam that maps a thrown value
// to (a) the JSON error envelope on stderr and (b) the process exit code. We
// stub `process.exit` and `console.error` to capture both without terminating
// the test runner.
//
// INTENTIONAL behaviour change asserted here: a genuinely-unexpected error
// (anything that is NOT an `AkmError` — e.g. a bare `Error`/`TypeError`) now
// exits 70 (sysexits EX_SOFTWARE / INTERNAL) instead of collapsing to 1.
// Scripts can therefore distinguish "akm threw unexpectedly" from an ordinary
// `NotFoundError` (still exit 1). Every existing classified exit code is
// asserted UNCHANGED below to lock that in.

import { describe, expect, it } from "bun:test";
import { emitJsonError } from "../../src/cli/shared";
import { ConfigError, NotFoundError, UsageError } from "../../src/core/errors";

interface Captured {
  exitCode: number;
  envelope: Record<string, unknown>;
}

/**
 * Invoke `emitJsonError` with `process.exit` / `console.error` stubbed, and
 * return the captured exit code plus the parsed JSON envelope. `emitJsonError`
 * is typed `never` (it normally calls `process.exit`); the stub throws a
 * sentinel so control returns here rather than tearing down the runner.
 */
function runEmit(error: unknown): Captured {
  const realExit = process.exit;
  const realError = console.error;
  let exitCode = -1;
  let stderr = "";
  process.exit = ((code?: number): never => {
    exitCode = code ?? 0;
    throw new Error("__emit_exit__");
  }) as unknown as typeof process.exit;
  console.error = (msg?: unknown) => {
    stderr += typeof msg === "string" ? msg : String(msg);
  };
  try {
    emitJsonError(error);
  } catch (err) {
    if (!(err instanceof Error) || err.message !== "__emit_exit__") throw err;
  } finally {
    process.exit = realExit;
    console.error = realError;
  }
  return { exitCode, envelope: JSON.parse(stderr) as Record<string, unknown> };
}

describe("classifyExitCode via emitJsonError (H6)", () => {
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
