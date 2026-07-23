import { describe, expect, test } from "bun:test";
import type { InstalledTaskRef } from "../src/tasks/backends";
import {
  buildCronLine,
  CRON_BACKEND,
  type CronExec,
  type CronExecResult,
  cronBlockBody,
  extractInstalledTarget,
  listBlocks,
  removeBlock,
  renderBlock,
  toggleBlock,
  upsertBlock,
} from "../src/tasks/backends/cron";
import type { ScheduledTaskContext } from "../src/tasks/scheduler-invocation";
import type { TaskDocument } from "../src/tasks/schema";

const SCHEDULED_CONTEXT: ScheduledTaskContext = {
  AKM_STASH_DIR: "/srv/akm stash/100%'s",
  AKM_CONFIG_DIR: "/srv/akm config",
  AKM_DATA_DIR: "/srv/akm data",
  AKM_CACHE_DIR: "/srv/akm cache",
  AKM_STATE_DIR: "/srv/akm state",
};

const TASK: TaskDocument = {
  version: 2,
  schemaVersion: 2,
  id: "ping",
  schedule: "*/15 * * * *",
  enabled: true,
  target: { kind: "workflow", ref: "workflows/noop", params: {} },
  source: { path: "/stash/tasks/ping.yml" },
};

describe("cron backend helpers", () => {
  test("buildCronLine emits absolute akm path", () => {
    const line = buildCronLine(TASK, ["/usr/local/bin/akm"], "/var/log/akm", undefined, SCHEDULED_CONTEXT);
    expect(line).toContain("/usr/local/bin/akm tasks run ping --scheduled");
    expect(line).toContain("AKM_STASH_DIR=");
    expect(line).not.toContain("AKM_LLM_API_KEY");
  });

  test("buildCronLine embeds --target only when a non-default bundle is given", () => {
    const withTarget = buildCronLine(TASK, ["/usr/local/bin/akm"], "/var/log", undefined, SCHEDULED_CONTEXT, "work");
    expect(withTarget).toContain("tasks run ping --target work --scheduled");
    const withoutTarget = buildCronLine(TASK, ["/usr/local/bin/akm"], "/var/log", undefined, SCHEDULED_CONTEXT);
    expect(withoutTarget).toContain("tasks run ping --scheduled");
    expect(withoutTarget).not.toContain("--target");
  });

  test("extractInstalledTarget recovers the bundle from a cron body (and undefined for the primary form)", () => {
    const withTarget = buildCronLine(
      TASK,
      ["/usr/local/bin/akm"],
      "/var/log",
      undefined,
      SCHEDULED_CONTEXT,
      "team-stash",
    );
    expect(extractInstalledTarget(withTarget)).toBe("team-stash");
    expect(extractInstalledTarget(cronBlockBody(withTarget, false))).toBe("team-stash");
    const primary = buildCronLine(TASK, ["/usr/local/bin/akm"], "/var/log", undefined, SCHEDULED_CONTEXT);
    expect(extractInstalledTarget(primary)).toBeUndefined();
  });

  test("buildCronLine quotes paths containing spaces", () => {
    const line = buildCronLine(TASK, ["/Applications/My Stuff/akm"], "/var/log", undefined, SCHEDULED_CONTEXT);
    expect(line).toContain("'/Applications/My Stuff/akm'");
  });

  test("buildCronLine preserves the installer PATH for scheduled children", () => {
    const line = buildCronLine(
      TASK,
      ["/home/user/.bun/bin/bun", "/opt/akm/cli.js"],
      "/var/log",
      "/home/user/.bun/bin:/usr/bin",
      SCHEDULED_CONTEXT,
    );
    expect(line).toContain("PATH=/home/user/.bun/bin:/usr/bin /home/user/.bun/bin/bun /opt/akm/cli.js tasks run ping");
  });

  test("buildCronLine escapes apostrophes for POSIX shell", () => {
    const line = buildCronLine(TASK, ["/opt/akm's/bin/akm"], "/var/log/akm's", undefined, SCHEDULED_CONTEXT);
    expect(line).toContain("'/opt/akm'\\''s/bin/akm'");
    expect(line).toContain("'/var/log/akm'\\''s/ping.log'");
  });

  test("buildCronLine escapes cron percent syntax even inside POSIX shell quotes", () => {
    const task = { ...TASK, id: "ping%done" };
    const line = buildCronLine(
      task,
      ["/opt/100% ready/akm's bin"],
      "/var/log/100% ready",
      "/opt/100% tools/bin:/usr/bin",
      SCHEDULED_CONTEXT,
    );
    expect(line).toContain("PATH='/opt/100'\\%' tools/bin:/usr/bin'");
    expect(line).toContain("'/opt/100'\\%' ready/akm'\\''s bin'");
    expect(line).toContain("tasks run ping\\%done");
    expect(line).toContain("'/var/log/100'\\%' ready/ping'\\%'done.log'");
  });

  test("buildCronLine rejects newline injection from every interpolated input", () => {
    const cases: Array<() => string> = [
      () =>
        buildCronLine(TASK, ["/usr/local/bin/akm"], "/var/log/akm", "/usr/bin\n* * * * * injected", SCHEDULED_CONTEXT),
      () =>
        buildCronLine(TASK, ["/usr/local/bin/akm\n* * * * * injected"], "/var/log/akm", undefined, SCHEDULED_CONTEXT),
      () =>
        buildCronLine(
          { ...TASK, id: "ping\n* * * * * injected" },
          ["/usr/local/bin/akm"],
          "/var/log/akm",
          undefined,
          SCHEDULED_CONTEXT,
        ),
      () =>
        buildCronLine(TASK, ["/usr/local/bin/akm"], "/var/log/akm\n* * * * * injected", undefined, SCHEDULED_CONTEXT),
    ];
    for (const build of cases) expect(build).toThrow("control characters");
  });

  test("buildCronLine rejects C0, DEL, and C1 controls", () => {
    for (const control of ["\0", "\t", "\n", "\r", "\u001f", "\u007f", "\u0085", "\u009f"]) {
      expect(() =>
        buildCronLine(TASK, ["/usr/local/bin/akm"], "/var/log/akm", `/usr/bin${control}/bin`, SCHEDULED_CONTEXT),
      ).toThrow("control characters");
    }
  });

  test("renderBlock rejects control characters in marker ids", () => {
    expect(() => renderBlock("ping\n# injected", "* * * * * X", true)).toThrow("control characters");
  });

  test("renderBlock wraps the cron line in begin/end markers", () => {
    const block = renderBlock("ping", "* * * * * /bin/akm tasks run ping", true);
    expect(block.split("\n")).toEqual([
      "# akm:task ping BEGIN",
      "* * * * * /bin/akm tasks run ping",
      "# akm:task ping END",
    ]);
  });

  test("renderBlock with enabled=false comments the cron line", () => {
    const block = renderBlock("ping", "* * * * * /bin/akm tasks run ping", false);
    const middle = block.split("\n")[1];
    expect(middle!.startsWith("# akm:disabled ")).toBe(true);
  });

  test("upsertBlock inserts when absent", () => {
    const next = upsertBlock("# user line\n0 * * * * other-job\n", "ping", renderBlock("ping", "X", true));
    expect(next).toContain("# user line");
    expect(next).toContain("0 * * * * other-job");
    expect(next).toContain("# akm:task ping BEGIN");
    expect(next).toContain("# akm:task ping END");
  });

  test("upsertBlock replaces when present, leaves other lines untouched", () => {
    const initial = [
      "# user line",
      "0 * * * * other-job",
      "# akm:task ping BEGIN",
      "* * * * * old-cmd",
      "# akm:task ping END",
      "# trailing user line",
    ].join("\n");
    const next = upsertBlock(initial, "ping", renderBlock("ping", "* * * * * NEW", true));
    expect(next).toContain("0 * * * * other-job");
    expect(next).toContain("# trailing user line");
    expect(next).toContain("* * * * * NEW");
    expect(next).not.toContain("old-cmd");
  });

  test("removeBlock leaves untouched when block absent", () => {
    const initial = "0 * * * * other-job";
    expect(removeBlock(initial, "ping")).toBe(initial);
  });

  test("removeBlock removes only the named block", () => {
    const initial = [
      "0 * * * * other-job",
      "# akm:task other BEGIN",
      "0 0 * * * /bin/akm tasks run other",
      "# akm:task other END",
      "# akm:task ping BEGIN",
      "* * * * * /bin/akm tasks run ping",
      "# akm:task ping END",
    ].join("\n");
    const next = removeBlock(initial, "ping");
    expect(next).toContain("# akm:task other BEGIN");
    expect(next).not.toContain("# akm:task ping BEGIN");
    expect(next).toContain("0 * * * * other-job");
  });

  test("toggleBlock comments and uncomments the body", () => {
    const enabled = renderBlock("ping", "* * * * * X", true);
    const disabled = toggleBlock(enabled, "ping", false);
    expect(disabled).toContain("# akm:disabled * * * * * X");
    const reenabled = toggleBlock(disabled, "ping", true);
    expect(reenabled).toContain("* * * * * X");
    expect(reenabled).not.toContain("akm:disabled");
  });

  test("cronBlockBody comments only when disabled", () => {
    expect(cronBlockBody("* * * * * X", true)).toBe("* * * * * X");
    expect(cronBlockBody("* * * * * X", false)).toBe("# akm:disabled * * * * * X");
  });

  test("listBlocks parses id and body between markers", () => {
    const crontab = [
      "# user line",
      "# akm:task ping BEGIN",
      "*/15 * * * * /bin/akm tasks run ping",
      "# akm:task ping END",
      "# akm:task other BEGIN",
      "# akm:disabled 0 2 * * * /bin/akm tasks run other",
      "# akm:task other END",
    ].join("\n");
    expect(listBlocks(crontab)).toEqual([
      { id: "ping", body: "*/15 * * * * /bin/akm tasks run ping" },
      { id: "other", body: "# akm:disabled 0 2 * * * /bin/akm tasks run other" },
    ]);
  });

  test("malformed marker blocks fail instead of consuming following crontab entries", () => {
    const malformed = ["# akm:task ping BEGIN", "*/15 * * * * /bin/akm tasks run ping", "0 1 * * * user-job"].join(
      "\n",
    );

    expect(() => listBlocks(malformed)).toThrow("malformed akm task block");
    expect(() => removeBlock(malformed, "ping")).toThrow("malformed akm task block");
    expect(() => toggleBlock(malformed, "ping", false)).toThrow("malformed akm task block");
    expect(() => upsertBlock(malformed, "ping", renderBlock("ping", "X", true))).toThrow("malformed akm task block");
    expect(malformed).toContain("0 1 * * * user-job");
  });
});

// ── drift detection (the `tasks sync` schedule-change fix) ───────────────────

/** In-memory crontab so the backend never touches the real one. */
function memoryExec(initial = ""): CronExec & { current: () => string } {
  let store = initial;
  return {
    read(): CronExecResult {
      return { status: 0, stdout: store, stderr: "" };
    },
    write(content: string): CronExecResult {
      store = content;
      return { status: 0, stdout: "", stderr: "" };
    },
    current: () => store,
  };
}

const SYNC_TASK: TaskDocument = {
  version: 2,
  schemaVersion: 2,
  id: "ping",
  schedule: "*/15 * * * *",
  enabled: true,
  target: { kind: "workflow", ref: "workflows/noop", params: {} },
  source: { path: "/stash/tasks/ping.yml" },
};

describe("cron backend drift detection", () => {
  const opts = (exec: CronExec) => ({
    exec,
    fs: { ensureDir() {} },
    logDir: "/var/log/akm",
    akmArgv: ["/usr/local/bin/akm"],
    envPath: false as const,
    scheduledContext: SCHEDULED_CONTEXT,
  });
  // The cron backend's list() is synchronous, but the TaskBackend interface
  // types it as `… | Promise<…>`; resolve through the concrete array shape so
  // indexing stays type-safe.
  const listSync = (b: ReturnType<typeof CRON_BACKEND>): InstalledTaskRef[] => b.list() as InstalledTaskRef[];

  test("list() returns a signature equal to expectedSignature for an installed task", () => {
    const exec = memoryExec();
    const backend = CRON_BACKEND(opts(exec));
    backend.install(SYNC_TASK);
    const listed = listSync(backend);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe("ping");
    expect(listed[0]!.signature).toBe(backend.expectedSignature?.(SYNC_TASK));
    // No --target token → primary attribution (target omitted).
    expect(listed[0]!.target).toBeUndefined();
  });

  test("list() attributes a target-installed entry, and its signature matches the target-aware expectation", () => {
    const exec = memoryExec();
    const backend = CRON_BACKEND(opts(exec));
    backend.install(SYNC_TASK, { target: "work" });
    const listed = listSync(backend);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.target).toBe("work");
    expect(listed[0]!.signature).toBe(backend.expectedSignature?.(SYNC_TASK, { target: "work" }));
    // The target-aware signature differs from the primary (no-target) one.
    expect(backend.expectedSignature?.(SYNC_TASK, { target: "work" })).not.toBe(backend.expectedSignature?.(SYNC_TASK));
  });

  test("expectedSignature changes when the schedule changes (drift is detectable)", () => {
    const exec = memoryExec();
    const backend = CRON_BACKEND(opts(exec));
    backend.install(SYNC_TASK);
    const installedSig = listSync(backend)[0]!.signature;
    const rescheduled: TaskDocument = { ...SYNC_TASK, schedule: "45 */6 * * *" };
    expect(backend.expectedSignature?.(rescheduled)).not.toBe(installedSig);
  });

  test("expectedSignature changes when enabled flips", () => {
    const backend = CRON_BACKEND(opts(memoryExec()));
    const enabledSig = backend.expectedSignature?.({ ...SYNC_TASK, enabled: true });
    const disabledSig = backend.expectedSignature?.({ ...SYNC_TASK, enabled: false });
    expect(enabledSig).not.toBe(disabledSig);
  });

  test("signature is stable across reinstall when nothing changed", () => {
    const backend = CRON_BACKEND(opts(memoryExec()));
    backend.install(SYNC_TASK);
    const sig1 = listSync(backend)[0]!.signature;
    backend.install(SYNC_TASK);
    const sig2 = listSync(backend)[0]!.signature;
    expect(sig1).toBe(sig2);
    expect(sig1).toBe(backend.expectedSignature?.(SYNC_TASK));
  });

  test("signature remains stable with escaped percent, spaces, and apostrophes", () => {
    const exec = memoryExec();
    const backend = CRON_BACKEND({
      exec,
      fs: { ensureDir() {} },
      logDir: "/var/log/100% ready/akm's",
      akmArgv: ["/opt/100% ready/akm's bin"],
      envPath: "/opt/100% tools/bin:/usr/bin",
      scheduledContext: SCHEDULED_CONTEXT,
    });
    backend.install(SYNC_TASK);
    const sig1 = listSync(backend)[0]!.signature;
    backend.install(SYNC_TASK);
    const sig2 = listSync(backend)[0]!.signature;
    expect(sig1).toBe(sig2);
    expect(sig1).toBe(backend.expectedSignature?.(SYNC_TASK));
  });

  test("expected signature changes when the resolved AKM context changes", () => {
    const original = CRON_BACKEND(opts(memoryExec()));
    const moved = CRON_BACKEND({
      ...opts(memoryExec()),
      scheduledContext: { ...SCHEDULED_CONTEXT, AKM_DATA_DIR: "/srv/moved data" },
    });

    expect(original.expectedSignature?.(SYNC_TASK)).not.toBe(moved.expectedSignature?.(SYNC_TASK));
  });

  test("a failed crontab replacement restores the complete prior crontab", () => {
    let store = "0 1 * * * user-job\n";
    let failNextWrite = false;
    const writes: string[] = [];
    const exec: CronExec = {
      read: () => ({ status: 0, stdout: store, stderr: "" }),
      write(content) {
        writes.push(content);
        store = content;
        if (failNextWrite) {
          failNextWrite = false;
          return { status: 1, stdout: "", stderr: "injected write failure" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    const backend = CRON_BACKEND(opts(exec));
    backend.install(SYNC_TASK);
    const prior = store;
    failNextWrite = true;

    expect(() => backend.install({ ...SYNC_TASK, schedule: "45 */6 * * *" })).toThrow("injected write failure");

    expect(writes).toHaveLength(3);
    expect(store).toBe(prior);
    expect(store).toContain("*/15 * * * *");
    expect(store).not.toContain("45 */6 * * *");
  });

  test("an unterminated block aborts uninstall without writing the crontab", () => {
    const malformed = "# akm:task ping BEGIN\n*/15 * * * * old-command\n0 1 * * * user-job\n";
    let writes = 0;
    const exec: CronExec = {
      read: () => ({ status: 0, stdout: malformed, stderr: "" }),
      write: () => {
        writes += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
    };

    expect(() => CRON_BACKEND(opts(exec)).uninstall("ping")).toThrow("malformed akm task block");
    expect(writes).toBe(0);
  });

  test("log-directory creation failure aborts install before reading or writing crontab", () => {
    let reads = 0;
    let writes = 0;
    const exec: CronExec = {
      read: () => {
        reads += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
      write: () => {
        writes += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    const backend = CRON_BACKEND({
      ...opts(exec),
      fs: {
        ensureDir() {
          throw new Error("injected log directory failure");
        },
      },
    });

    expect(() => backend.install(SYNC_TASK)).toThrow("injected log directory failure");
    expect(reads).toBe(0);
    expect(writes).toBe(0);
  });
});
