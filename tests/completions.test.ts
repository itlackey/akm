import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runCliCapture } from "./_helpers/cli";
import { makeSandboxDir, type SandboxedDir, withEnv } from "./_helpers/sandbox";

// Helpers.
//
// Migrated from per-test spawnSync("bun", ["./src/cli.ts", ...]) to the shared
// in-process harness (tests/_helpers/cli.ts). `completions` emits a pure bash
// script on stdout / exit code, so the script-content and unsupported-shell
// tests are ideal in-process candidates. Env/temp-dir mutation goes through the
// allowlisted sandbox helpers (withEnv / makeSandboxDir).
//
// The `--install` test (real subprocess, asserts user-visible stderr) moved to
// tests/integration/completions-install.test.ts.

// ── Helpers ─────────────────────────────────────────────────────────────────

const disposers: SandboxedDir[] = [];

function makeTempDir(): string {
  const d = makeSandboxDir("akm-completions-");
  disposers.push(d);
  return d.dir;
}

afterAll(() => {
  for (const d of disposers) d.cleanup();
  disposers.length = 0;
});

const xdgCache = makeTempDir();
const xdgConfig = makeTempDir();
const xdgData = makeTempDir();
const xdgState = makeTempDir();
const isolatedHome = makeTempDir();

async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; status: number }> {
  const { stdout, stderr, code } = await withEnv(
    {
      AKM_BUNDLE_DIR: undefined,
      HOME: isolatedHome,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
    },
    () => runCliCapture(args),
  );
  return { stdout, stderr, status: code };
}

// ── Unit tests (generated script content) ────────────────────────────────────

describe("completions command", () => {
  let script = "";
  let status = 1;

  beforeAll(async () => {
    const result = await runCli("completions");
    script = result.stdout;
    status = result.status;
  });

  test("exits 0 and outputs a bash script", () => {
    expect(status).toBe(0);
    expect(script).toStartWith("#!/bin/bash");
  });

  test("contains complete -F _akm akm", () => {
    expect(script).toContain("complete -F _akm akm");
  });

  test("contains all top-level subcommands", () => {
    const expected = [
      "bundle",
      "index",
      "upgrade",
      "search",
      "curate",
      "show",
      "workflow",
      "remember",
      "import",
      "clone",
      "feedback",
      "registry",
      "config",
      "migrate",
      "help",
      "hints",
      "completions",
    ];
    for (const cmd of expected) {
      expect(script).toContain(cmd);
    }
  });

  // `migrate` was `meta.hidden` (S11) so tab-completion wouldn't surface the
  // self-update contract's internal command. Unhidden: the 0.9.0 upgrade
  // instructions tell users to run `akm migrate status`/`apply` first, so it
  // needs to be as discoverable as any other command, completions included.
  test("suggests the migrate command", () => {
    expect(script).toContain('"akm migrate"');
  });

  test("contains nested bundle subcommands", () => {
    expect(script).toContain('"akm bundle"');
    for (const sub of ["create", "add", "list", "show", "remove", "update"]) {
      expect(script).toContain(sub);
    }
  });

  test("contains nested config subcommands", () => {
    expect(script).toContain('"akm config"');
    for (const sub of ["path", "list", "get", "set", "unset"]) {
      expect(script).toContain(sub);
    }
  });

  test("contains nested registry subcommands", () => {
    expect(script).toContain('"akm registry"');
    for (const sub of ["list", "add", "remove", "search"]) {
      expect(script).toContain(sub);
    }
  });

  test("contains nested migrate subcommands", () => {
    expect(script).toContain('"akm migrate"');
    for (const sub of ["status", "apply"]) {
      expect(script).toContain(sub);
    }
  });

  test("offers command names as help topics", () => {
    expect(script).toContain('"akm help"');
    for (const topic of ["bundle", "env", "task", "migrate"]) {
      expect(script).toContain(`"akm help ${topic}"`);
    }
  });

  test("contains flag value completions for --format", () => {
    expect(script).toContain("--format)");
    expect(script).toContain("json jsonl yaml text md html");
  });

  test("contains flag value completions for --detail", () => {
    expect(script).toContain("--detail)");
    expect(script).toContain("brief normal full");
    // `summary` is a --shape value, not a detail level.
    expect(script).not.toContain("brief normal full summary");
  });

  test("contains flag value completions for --shape", () => {
    expect(script).toContain("--shape)");
    expect(script).toContain("human agent summary");
  });

  test("contains flag value completions for --type", () => {
    expect(script).toContain("--type)");
    // Derived from placementTypes(), so this list grows when a new
    // stash-resident asset type is registered — `instruction` joined it with
    // owner ruling 11. Update deliberately rather than loosening the match.
    expect(script).toContain(
      "skill command agent knowledge instruction workflow script memory env secret lesson task session fact any",
    );
  });

  test("contains flag value completions for --from", () => {
    expect(script).toContain("--from)");
    expect(script).toContain("local registry all");
  });

  test("includes canonical negated boolean flags", () => {
    for (const flag of ["--no-init", "--no-push"]) {
      expect(script).toContain(flag);
    }
  });

  test("recognizes subcommands without treating positionals and option values as command paths", () => {
    expect(script).toContain('"akm task:run") cmd_path="akm task run"');
    expect(script).toContain('"akm workflow:create") cmd_path="akm workflow create"');
    expect(script).toContain("skip_value=1; continue");
    expect(script).toContain("if (( skip_value )); then");
    const legacyPathAppend = 'cmd_path="$' + "{cmd_path} $" + '{words[i]}"';
    expect(script).not.toContain(legacyPathAppend);
  });

  // R-052(a): --from means a closed enum on search/curate but a free-form
  // existing-file path (workflow create) elsewhere. FLAG_VALUES used to be a
  // flat Record keyed by flag NAME, so the enum leaked onto every command
  // with a --from flag. The fix scopes the rule to a cmd_path match inside
  // the --from case.
  test("scopes --from completion to search/curate, not globally (R-052a)", () => {
    const sourceCase = script.match(/--from\)[\s\S]*?return 0\n\s*;;/)?.[0];
    expect(sourceCase).toBeDefined();
    // Literal bash text, not a JS template placeholder.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting on generated bash source, not a JS template
    expect(sourceCase).toContain('case "${cmd_path}" in');
    expect(sourceCase).toContain('"akm search"|"akm curate")');
    expect(sourceCase).toContain("local registry all");
    // workflow create's --from (a free-form existing-file path) must not be
    // lumped into the search/curate enum branch, and there must be no
    // unscoped fallback branch re-offering the enum to every other command.
    expect(sourceCase).not.toContain('"akm workflow create"');
    expect(sourceCase).not.toMatch(/\*\)\s*\n\s*COMPREPLY/);
  });
});

// The `--install` real-subprocess test lives in
// tests/integration/completions-install.test.ts — real spawns are banned from
// the unit suite (a stalled sync spawn freezes the shard past every JS-level
// timeout).

// ── Unsupported shell ────────────────────────────────────────────────────────

describe("completions unsupported shell", () => {
  // R-052(b): `completionsCommand` used to be a bare `run()` that threw
  // directly, so the error escaped the standard JSON envelope entirely — a
  // real subprocess printed a raw stack trace and exited 1 instead of the
  // classified exit-2 usage error every other command produces. Wrapping the
  // body in `runWithJsonErrors` fixes both the envelope and the exit code.
  test("--shell fish produces a classified JSON error envelope and exits 2 (R-052b)", async () => {
    const { stderr, status } = await runCli("completions", "--shell", "fish");
    expect(status).toBe(2);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("Unsupported shell: fish");
  });
});
