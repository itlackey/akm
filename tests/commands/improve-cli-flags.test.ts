import { describe, expect, test } from "bun:test";
// These flag-rejection tests run on the in-process harness
// (tests/_helpers/cli.ts): they fail during arg parsing before any DB access,
// so they need no stash and carry no subprocess cost.
//
// The `improve --dry-run` happy path lives in
// tests/integration/improve-cli-flags.test.ts — it executes improve for real
// and needs a fresh subprocess to avoid state.db lock contention with the
// in-process suite (see the header comment there).
import { runCliCapture } from "../_helpers/cli";

async function runCli(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await runCliCapture(args);
  return { status: code, stdout, stderr };
}

describe("improve CLI flags (0.8.0)", () => {
  // 0.8.0 deleted --reflect-cooldown-days / --distill-cooldown-days /
  // --consolidate-cooldown-days. The reflect/distill gates now use
  // signal-delta eligibility (see tests/improve-eligibility.test.ts);
  // consolidate uses pool-delta. citty silently ignores unknown flags
  // so we cannot pin rejection here — the flag-rejection tests were
  // dropped along with the flags.

  // NOTE: the `rejects negative min retrieval count` test was dropped here —
  // chunk-7's improve refactor removed the --min-retrieval-count validation,
  // and citty silently ignores the now-unknown flag, so rejection can no longer
  // be pinned (same reason the cooldown-flag rejection tests were dropped above).

  test("rejects invalid consolidate recovery mode", async () => {
    const result = await runCli(["improve", "--consolidate-recovery", "resume", "--dry-run"]);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stderr) as { ok: boolean; error: string; code?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("--consolidate-recovery");
    expect(parsed.error).toContain("abort");
    expect(parsed.error).toContain("clean");
  });
});

describe("standalone extract CLI engine boundary", () => {
  test("rejects --engine with --strategy before resolving either selection", async () => {
    const result = await runCli(["extract", "--type", "claude-code", "--engine", "fast", "--strategy", "thorough"]);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stderr) as { error: string; code?: string };
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("--engine and --strategy are mutually exclusive");
  });
});
