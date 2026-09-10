import { describe, expect, test } from "bun:test";
import {
  buildCronLine,
  CRON_BACKEND,
  type CronExec,
  type CronExecResult,
  cronBlockBody,
  extractCronInvocation,
  extractInstalledTarget,
  listBlocks,
  removeBlock,
  renderBlock,
  toggleBlock,
  upsertBlock,
} from "../src/tasks/backends/cron";
import type { InstalledSchedulerBinding } from "../src/tasks/backends/types";
import { type SchedulerBinding, schedulerNativeBindingId } from "../src/tasks/scheduler-binding";
import {
  type ScheduledTaskContext,
  schedulerContextDescriptor,
  schedulerContextPath,
} from "../src/tasks/scheduler-invocation";
import {
  type SchedulerArtifactDrift,
  type SchedulerBackendContractDriver,
  type SchedulerNormalizedPeer,
  schedulerBackendConformance,
} from "./_helpers/scheduler-backend-conformance";

const SCHEDULED_CONTEXT: ScheduledTaskContext = {
  AKM_BUNDLE_DIR: "/srv/akm stash/100%'s",
  AKM_CONFIG_DIR: "/srv/akm config",
  AKM_DATA_DIR: "/srv/akm data",
  AKM_CACHE_DIR: "/srv/akm cache",
  AKM_STATE_DIR: "/srv/akm state",
};
const contextPath = (envPath = "") => schedulerContextPath(schedulerContextDescriptor(SCHEDULED_CONTEXT, envPath));

const TASK: SchedulerBinding = {
  id: "ping",
  logicalSource: { kind: "task", ref: "stash//tasks/ping" },
  cron: "*/15 * * * *",
  source: "akm.schedule",
  ordinal: 0,
  enabled: true,
  invocation: ["task", "run", "ping", "--scheduled"],
};

function targeted(binding: SchedulerBinding, target: string): SchedulerBinding {
  return {
    ...binding,
    logicalSource: { ...binding.logicalSource, ref: `${target}//tasks/${binding.id}` },
    invocation: ["task", "run", binding.id, "--bundle", target, "--scheduled"],
  };
}

describe("cron backend helpers", () => {
  test("buildCronLine emits absolute akm path", () => {
    const line = buildCronLine(TASK, ["/usr/local/bin/akm"], "/var/log/akm", contextPath());
    expect(line).toContain("/usr/local/bin/akm --scheduler-context");
    expect(line).toContain("task run ping --scheduled");
    expect(line).not.toContain("AKM_BUNDLE_DIR=");
    expect(line).not.toContain("AKM_LLM_API_KEY");
  });

  // #951: the raw crontab redirect is a bootstrap safety net that only
  // needs to catch akm crashing before it reaches its own per-run log
  // (src/tasks/run/task-log.ts); an unconditional `>>` append grew forever
  // (a two-month-old "No stash directory found" line survived in every
  // container). Truncate instead so the file always holds exactly the
  // latest run's raw output.
  test("buildCronLine truncates the raw log redirect instead of appending forever", () => {
    const line = buildCronLine(TASK, ["/usr/local/bin/akm"], "/var/log/akm", contextPath());
    expect(line).toContain("> /var/log/akm/ping.log 2>&1");
    expect(line).not.toContain(">>");
  });

  test("buildCronLine renders a qualified workflow binding without task-only arguments", () => {
    const workflow: SchedulerBinding = {
      ...TASK,
      id: "wf-1234",
      logicalSource: { kind: "workflow", ref: "team//workflows/release" },
      source: "workflows/release.yml:on.schedule[0]",
      invocation: ["workflow", "run", "team//workflows/release"],
    };
    const line = buildCronLine(workflow, ["/usr/local/bin/akm"], "/var/log", contextPath());
    expect(line).toContain("workflow run team//workflows/release");
    expect(line).not.toContain("--scheduled");
  });

  test("buildCronLine renders the binding invocation without hidden target state", () => {
    const withTarget = buildCronLine(targeted(TASK, "work"), ["/usr/local/bin/akm"], "/var/log", contextPath());
    expect(withTarget).toContain("task run ping --bundle work --scheduled");
    const withoutTarget = buildCronLine(TASK, ["/usr/local/bin/akm"], "/var/log", contextPath());
    expect(withoutTarget).toContain("task run ping --scheduled");
    expect(withoutTarget).not.toContain("--bundle");
  });

  test("extractInstalledTarget recovers the bundle from a cron body (and undefined for the primary form)", () => {
    const withTarget = buildCronLine(targeted(TASK, "team-stash"), ["/usr/local/bin/akm"], "/var/log", contextPath());
    expect(extractInstalledTarget(withTarget)).toBe("team-stash");
    expect(extractInstalledTarget(cronBlockBody(withTarget, false))).toBe("team-stash");
    const primary = buildCronLine(TASK, ["/usr/local/bin/akm"], "/var/log", contextPath());
    expect(extractInstalledTarget(primary)).toBeUndefined();
  });

  // #951: `extractCronInvocation` must parse a freshly built `>` (truncate)
  // row and the identical row with `>` replaced by `>>` (the append form
  // every pre-change row on disk still has) into the same invocation — a
  // rolling upgrade reads both shapes side by side, and the parse must not
  // depend on which redirect operator wrote the row.
  test("extractCronInvocation parses a truncating `>` row the same as the pre-change `>>` row", () => {
    const line = buildCronLine(TASK, ["/usr/local/bin/akm"], "/var/log/akm", contextPath());
    expect(line).toContain(" > ");
    const legacyAppendLine = line.replace(" > ", " >> ");
    expect(legacyAppendLine).toContain(" >> ");
    expect(extractCronInvocation(legacyAppendLine)).toEqual(extractCronInvocation(line));
  });

  test("buildCronLine quotes paths containing spaces", () => {
    const line = buildCronLine(TASK, ["/Applications/My Stuff/akm"], "/var/log", contextPath());
    expect(line).toContain("'/Applications/My Stuff/akm'");
  });

  test("buildCronLine preserves the installer PATH for scheduled children", () => {
    const line = buildCronLine(
      TASK,
      ["/home/user/.bun/bin/bun", "/opt/akm/cli.js"],
      "/var/log",
      contextPath("/home/user/.bun/bin:/usr/bin"),
    );
    expect(line).not.toContain("PATH=");
    expect(line).toContain("/home/user/.bun/bin/bun /opt/akm/cli.js --scheduler-context");
  });

  test("buildCronLine escapes apostrophes for POSIX shell", () => {
    const line = buildCronLine(TASK, ["/opt/akm's/bin/akm"], "/var/log/akm's", contextPath());
    expect(line).toContain("'/opt/akm'\\''s/bin/akm'");
    expect(line).toContain("'/var/log/akm'\\''s/ping.log'");
  });

  test("buildCronLine escapes cron percent syntax even inside POSIX shell quotes", () => {
    const line = buildCronLine(
      TASK,
      ["/opt/100% ready/akm's bin"],
      "/var/log/100% ready",
      contextPath("/opt/100% tools/bin:/usr/bin"),
    );
    expect(line).not.toContain("PATH=");
    expect(line).toContain("'/opt/100'\\%' ready/akm'\\''s bin'");
    expect(line).toContain("task run ping");
    expect(line).toContain("'/var/log/100'\\%' ready/ping.log'");
  });

  test("buildCronLine rejects newline injection from every interpolated input", () => {
    const cases: Array<() => string> = [
      () => buildCronLine(TASK, ["/usr/local/bin/akm"], "/var/log/akm", "/context\n* * * * * injected"),
      () => buildCronLine(TASK, ["/usr/local/bin/akm\n* * * * * injected"], "/var/log/akm", contextPath()),
      () =>
        buildCronLine(
          { ...TASK, id: "ping\n* * * * * injected" },
          ["/usr/local/bin/akm"],
          "/var/log/akm",
          contextPath(),
        ),
      () => buildCronLine(TASK, ["/usr/local/bin/akm"], "/var/log/akm\n* * * * * injected", contextPath()),
    ];
    for (const build of cases) expect(build).toThrow();
  });

  test("buildCronLine rejects C0, DEL, and C1 controls", () => {
    for (const control of ["\0", "\t", "\n", "\r", "\u001f", "\u007f", "\u0085", "\u009f"]) {
      expect(() =>
        buildCronLine(TASK, ["/usr/local/bin/akm"], "/var/log/akm", `/context${control}/file.json`),
      ).toThrow();
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

type MemoryCronExec = CronExec & {
  current(): string;
  replace(content: string): void;
  resetActivity(): void;
  accessCount(): number;
  mutationCount(): number;
};

/** In-memory crontab so the backend never touches the real one. */
function memoryExec(initial = ""): MemoryCronExec {
  let store = initial;
  let reads = 0;
  let writes = 0;
  return {
    read(): CronExecResult {
      reads += 1;
      return { status: 0, stdout: store, stderr: "" };
    },
    write(content: string): CronExecResult {
      writes += 1;
      store = content;
      return { status: 0, stdout: "", stderr: "" };
    },
    current: () => store,
    replace(content) {
      store = content;
    },
    resetActivity() {
      reads = 0;
      writes = 0;
    },
    accessCount: () => reads + writes,
    mutationCount: () => writes,
  };
}

const SYNC_TASK: SchedulerBinding = {
  id: "ping",
  logicalSource: { kind: "task", ref: "stash//tasks/ping" },
  cron: "*/15 * * * *",
  source: "akm.schedule",
  ordinal: 0,
  enabled: true,
  invocation: ["task", "run", "ping", "--scheduled"],
};

function cronBackendOptions(exec: CronExec, scheduledContext: ScheduledTaskContext = SCHEDULED_CONTEXT) {
  return {
    exec,
    // A no-op writeFile is present (not just ensureDir) so this shared
    // default satisfies CronFs even for a caller that happens to trip the
    // long-invocation wrapper-script path — see cronBackendOptions callers
    // that need to actually INSPECT what was written, which build their own
    // richer fs mock instead of this default.
    fs: { ensureDir() {}, writeFile() {} },
    logDir: "/var/log/akm",
    akmArgv: ["/usr/local/bin/akm"],
    envPath: false as const,
    scheduledContext,
  };
}

function cronContractDriver(scheduledContext = SCHEDULED_CONTEXT): SchedulerBackendContractDriver {
  const exec = memoryExec();
  const backend = CRON_BACKEND(cronBackendOptions(exec, scheduledContext));
  const nativeId = (binding: SchedulerBinding) => binding.nativeId ?? schedulerNativeBindingId(binding.id);
  const replaceArtifact = (binding: SchedulerBinding, replacement: string) => {
    const marker = `# akm:task ${nativeId(binding)}`;
    const prior = exec.current();
    const duplicate = prior.replaceAll(marker, `# akm:task ${replacement}`);
    if (duplicate === prior) throw new Error(`missing cron artifact fixture for ${binding.id}`);
    exec.replace(`${prior}${duplicate}`);
  };

  return {
    backend,
    captureState: exec.current,
    clearArtifact(binding) {
      exec.replace(removeBlock(exec.current(), nativeId(binding)));
    },
    driftArtifact(binding, drift: SchedulerArtifactDrift) {
      const prior = exec.current();
      let next: string;
      if (drift === "foreign") {
        next = prior.replace(
          " task run ping --bundle stash --scheduled ",
          " task run foreign --bundle stash --scheduled ",
        );
      } else if (drift === "malformed") {
        next = prior.replace(" --scheduled ", " --broken ");
      } else {
        const fields = binding.cron.split(" ");
        fields[0] = fields[0] === "0" ? "7" : "8";
        next = prior.replace(binding.cron, fields.join(" "));
      }
      if (next === prior) throw new Error(`failed to drift cron artifact fixture for ${drift}`);
      exec.replace(next);
    },
    addNormalizedPeer(binding, peer: SchedulerNormalizedPeer) {
      const id = nativeId(binding);
      replaceArtifact(binding, peer === "case" ? id.toUpperCase() : `${id}.`);
    },
    currentFingerprint(binding) {
      const artifact = (backend.listNativeArtifacts?.() as Array<{ nativeId: string; fingerprint?: string }>).find(
        (candidate) => candidate.nativeId === nativeId(binding),
      );
      if (!artifact?.fingerprint) throw new Error(`missing cron fingerprint fixture for ${binding.id}`);
      return artifact.fingerprint;
    },
    resetActivity: exec.resetActivity,
    accessCount: exec.accessCount,
    mutationCount: exec.mutationCount,
  };
}

schedulerBackendConformance({
  name: "cron",
  scheduledContext: SCHEDULED_CONTEXT,
  movedContext: { ...SCHEDULED_CONTEXT, AKM_DATA_DIR: "/srv/moved data" },
  create: cronContractDriver,
});

describe("cron backend drift detection", () => {
  const opts = cronBackendOptions;
  // The cron backend's list() is synchronous, but the SchedulerBackend interface
  // types it as `… | Promise<…>`; resolve through the concrete array shape so
  // indexing stays type-safe.
  const listSync = (b: ReturnType<typeof CRON_BACKEND>): InstalledSchedulerBinding[] =>
    b.list() as InstalledSchedulerBinding[];

  test("list() returns a signature equal to expectedSignature for an installed task", () => {
    const exec = memoryExec();
    const backend = CRON_BACKEND(opts(exec));
    backend.install(SYNC_TASK);
    const listed = listSync(backend);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe("ping");
    expect(listed[0]!.signature).toBe(backend.expectedSignature?.(SYNC_TASK));
    // No --bundle token → primary attribution (target omitted).
    expect(listed[0]!.target).toBeUndefined();
  });

  test("list() attributes a target-installed entry, and its signature matches the target-aware expectation", () => {
    const exec = memoryExec();
    const backend = CRON_BACKEND(opts(exec));
    const targetBinding = targeted(SYNC_TASK, "work");
    backend.install(targetBinding);
    const listed = listSync(backend);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.target).toBe("work");
    expect(listed[0]!.signature).toBe(backend.expectedSignature?.(targetBinding));
    // The target-aware signature differs from the primary (no-target) one.
    expect(backend.expectedSignature?.(targetBinding)).not.toBe(backend.expectedSignature?.(SYNC_TASK));
  });

  test("round-trips a nested logical id through a portable native marker", () => {
    const exec = memoryExec();
    const backend = CRON_BACKEND(opts(exec));
    const nested = {
      ...SYNC_TASK,
      id: "sub/deep/nightly",
      logicalSource: { kind: "task" as const, ref: "team//sub/deep/nightly" },
      invocation: ["task", "run", "sub/deep/nightly", "--bundle", "team", "--scheduled"],
    };

    backend.install(nested);

    expect(exec.current()).not.toContain("# akm:task sub/deep/nightly BEGIN");
    expect(listSync(backend)).toEqual([expect.objectContaining({ id: "sub/deep/nightly", target: "team" })]);

    const colliding = {
      ...SYNC_TASK,
      id: "task-b0117b892c35999ceb4d5386f8609932",
      logicalSource: { kind: "task" as const, ref: "team//task-b0117b892c35999ceb4d5386f8609932" },
      invocation: ["task", "run", "task-b0117b892c35999ceb4d5386f8609932", "--bundle", "team", "--scheduled"],
    };
    expect(() => backend.install(colliding)).toThrow(/native scheduler artifact|different logical owner/i);
    expect(listSync(backend)).toEqual([expect.objectContaining({ id: "sub/deep/nightly", target: "team" })]);
  });

  // 0.9 scheduler ABI respelling (S6): an entry whose invocation no longer
  // parses (missing context descriptor, pre-rename `tasks run` spelling, or
  // any other foreign content between the markers) is an orphan of its
  // marker id, not a hard failure — `list()` omits it so `akmTasksSync`
  // treats the id as "not present" and reinstalls it from the task file.
  test("list() omits an entry without the current context descriptor", () => {
    const exec = memoryExec(
      [
        "# akm:task ping BEGIN",
        "*/15 * * * * /usr/local/bin/akm tasks run ping --scheduled >> /var/log/akm/ping.log 2>&1",
        "# akm:task ping END",
        "",
      ].join("\n"),
    );

    const backend = CRON_BACKEND(opts(exec));
    expect(backend.list()).toEqual([]);
    expect(backend.listNativeArtifacts?.()).toEqual([{ nativeId: "ping" }]);
  });

  test("expectedSignature changes when the schedule changes (drift is detectable)", () => {
    const exec = memoryExec();
    const backend = CRON_BACKEND(opts(exec));
    backend.install(SYNC_TASK);
    const installedSig = listSync(backend)[0]!.signature;
    const rescheduled: SchedulerBinding = { ...SYNC_TASK, cron: "45 */6 * * *" };
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

    expect(() => backend.install({ ...SYNC_TASK, cron: "45 */6 * * *" })).toThrow("injected write failure");

    expect(writes).toHaveLength(3);
    expect(store).toBe(prior);
    expect(store).toContain("*/15 * * * *");
    expect(store).not.toContain("45 */6 * * *");
  });

  test("binding snapshots restore the exact whole crontab after multi-binding mutation", () => {
    const exec = memoryExec("0 1 * * * user-job\n");
    const backend = CRON_BACKEND(opts(exec));
    const second = { ...SYNC_TASK, id: "second", invocation: ["task", "run", "second", "--scheduled"] };
    backend.install(SYNC_TASK);
    backend.install(second);
    const prior = exec.current();
    const snapshot = backend.snapshotBindings?.([SYNC_TASK.id, second.id, "absent"]);

    backend.uninstall(SYNC_TASK.id);
    backend.install({ ...second, cron: "45 */6 * * *" });
    backend.restoreBindings?.(snapshot);

    expect(exec.current()).toBe(prior);
    expect(exec.current()).toStartWith("0 1 * * * user-job\n");
  });

  test("rollback continues past one duplicate key and restores independent native IDs", () => {
    const exec = memoryExec();
    const backend = CRON_BACKEND(opts(exec));
    const ping = targeted(SYNC_TASK, "stash");
    const second = targeted(
      { ...SYNC_TASK, id: "second", invocation: ["task", "run", "second", "--scheduled"] },
      "stash",
    );
    const snapshot = backend.snapshotBindings?.(["ping", "second"]);
    backend.install(ping);
    const pingBlock = exec.current();
    backend.install(second);
    exec.write(`${exec.current()}${pingBlock.replaceAll("# akm:task ping", "# akm:task PING")}`);
    const raced = exec.current();
    const restore = backend.restoreBindings as unknown as (
      snapshot: unknown,
      guards: readonly Record<string, unknown>[],
    ) => void;

    expect(() =>
      restore(snapshot, [
        {
          nativeId: "ping",
          allowed: [
            { state: "absent" },
            {
              state: "present",
              bindingId: ping.id,
              invocation: ping.invocation,
              fingerprint: backend.expectedSignature?.(ping),
            },
          ],
        },
        {
          nativeId: "second",
          allowed: [
            { state: "absent" },
            {
              state: "present",
              bindingId: second.id,
              invocation: second.invocation,
              fingerprint: backend.expectedSignature?.(second),
            },
          ],
        },
      ]),
    ).toThrow(/rollback|cardinality|duplicate|collision|exactly one/i);
    expect(exec.current()).not.toContain("# akm:task second BEGIN");
    expect(exec.current()).toContain("# akm:task ping BEGIN");
    expect(exec.current()).toContain("# akm:task PING BEGIN");
    expect(raced).toContain("# akm:task second BEGIN");
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

  // #910: a supercronic-managed container (OpenPalm) has no real `crontab`
  // binary, so any nonzero exit from a fake/absent one must not be
  // misdiagnosed. Three shapes, one per case in the issue's fix:
  describe("crontab -l failures (#910)", () => {
    test("a genuinely missing binary (ENOENT) reports the binary is missing", () => {
      const exec: CronExec = {
        read: () => ({ status: 1, stdout: "", stderr: "", enoent: true }),
        write: () => ({ status: 0, stdout: "", stderr: "" }),
      };
      const backend = CRON_BACKEND(opts(exec));

      expect(() => backend.list()).toThrow(/crontab.*binary was not found on PATH/i);
      try {
        backend.list();
        throw new Error("expected list() to throw");
      } catch (err) {
        const hint = (err as { hint?: () => string | undefined }).hint?.();
        expect(hint).toMatch(/install.*crontab.*binary|add one to PATH/i);
      }
    });

    test("a nonzero exit with empty stdout is an empty crontab, not an error (supercronic PATH shim, #910)", () => {
      // Models OpenPalm's `/tmp/openpalm-bin/crontab` shim: present on PATH,
      // spawns fine, but there is no real spool yet — exits nonzero with
      // nothing on stdout or stderr.
      const exec: CronExec = {
        read: () => ({ status: 1, stdout: "", stderr: "" }),
        write: () => ({ status: 0, stdout: "", stderr: "" }),
      };
      const backend = CRON_BACKEND(opts(exec));

      expect(backend.list()).toEqual([]);
    });

    test("a nonzero exit with empty stdout but a real stderr message is an error, not an empty crontab", () => {
      // A refusal is not an empty crontab: cron said something, and that
      // something is what the operator needs to read.
      const exec: CronExec = {
        read: () => ({ status: 1, stdout: "", stderr: "crontab: you are not allowed to use this program\n" }),
        write: () => ({ status: 0, stdout: "", stderr: "" }),
      };
      const backend = CRON_BACKEND(opts(exec));

      expect(() => backend.list()).toThrow(/not allowed to use this program/);
    });

    test("a nonzero exit with stderr saying 'no crontab' is an empty crontab (BSD wording)", () => {
      const exec: CronExec = {
        read: () => ({ status: 1, stdout: "", stderr: "no crontab for someone\n" }),
        write: () => ({ status: 0, stdout: "", stderr: "" }),
      };
      const backend = CRON_BACKEND(opts(exec));

      expect(backend.list()).toEqual([]);
    });

    test("any other nonzero exit still errors, but never claims the binary is missing", () => {
      const exec: CronExec = {
        read: () => ({ status: 2, stdout: "permission denied\n", stderr: "crontab: permission denied\n" }),
        write: () => ({ status: 0, stdout: "", stderr: "" }),
      };
      const backend = CRON_BACKEND(opts(exec));

      let thrown: unknown;
      try {
        backend.list();
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      expect((thrown as Error).message).not.toMatch(/binary.*missing|was not found on PATH/i);
      const hint = (thrown as { hint?: () => string | undefined }).hint?.();
      expect(hint).not.toMatch(/install.*crontab.*binary|add one to PATH/i);
    });
  });

  // A cron line over vixie-cron's real MAX_COMMAND
  // used to refuse the install outright. It now spills the invocation into a
  // short generated wrapper script under logDir and references THAT from the
  // crontab line instead — never truncates the command (which would execute
  // a partial, destructive one), and never simply warns-and-writes an
  // over-length line either.
  test("spills a too-long cron command into a wrapper script instead of refusing to install", () => {
    let reads = 0;
    let installedCrontab = "";
    const exec: CronExec = {
      read: () => {
        reads += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
      write: (content) => {
        installedCrontab = content;
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    const written = new Map<string, string>();
    const backend = CRON_BACKEND({
      ...opts(exec),
      fs: {
        ensureDir() {},
        writeFile(file, content) {
          written.set(file, content);
        },
      },
      akmArgv: [`/${"x".repeat(1100)}`],
    });

    backend.install(SYNC_TASK);

    // The install completes (reads the crontab once, writes it back once)...
    expect(reads).toBe(1);
    expect(installedCrontab).not.toBe("");
    // ...by referencing a generated wrapper script via `sh <path>`, rather
    // than embedding the long invocation directly.
    expect(written.size).toBe(1);
    const [wrapperPath, wrapperContent] = [...written.entries()][0]!;
    expect(Buffer.byteLength(wrapperPath, "utf8")).toBeLessThan(200);
    expect(wrapperContent).toStartWith("#!/bin/sh\nexec ");
    expect(wrapperContent).toContain(`/${"x".repeat(1100)}`);
    expect(installedCrontab).toContain(`sh ${wrapperPath}`);
    expect(installedCrontab).not.toContain("x".repeat(1100));
    // #951: the wrapper-spill redirect truncates too, same as the direct line.
    expect(installedCrontab).toContain("> ");
    expect(installedCrontab).not.toContain(">>");
    for (const line of installedCrontab.split("\n")) {
      if (line.startsWith("#")) continue;
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(1000);
    }
  });

  test("changing a too-long invocation changes the wrapper script's path (drift detection survives the spill)", () => {
    const written = new Map<string, string>();
    const fs = {
      ensureDir() {},
      writeFile(file: string, content: string) {
        written.set(file, content);
      },
    };
    const first = CRON_BACKEND({
      ...opts(memoryExec()),
      fs,
      akmArgv: [`/${"x".repeat(1100)}`],
    });
    first.install(SYNC_TASK);
    const firstPaths = new Set(written.keys());
    expect(firstPaths.size).toBe(1);

    const second = CRON_BACKEND({
      ...opts(memoryExec()),
      fs,
      akmArgv: [`/${"y".repeat(1100)}`],
    });
    second.install(SYNC_TASK);
    const secondPaths = [...written.keys()].filter((path) => !firstPaths.has(path));
    expect(secondPaths.length).toBe(1);
    expect(secondPaths[0]).not.toBe([...firstPaths][0]);
  });

  test("still refuses when even the wrapper-referencing line cannot fit (an absurdly long logDir)", () => {
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
      fs: { ensureDir() {}, writeFile() {} },
      logDir: `/${"d".repeat(1100)}`,
      akmArgv: [`/${"x".repeat(1100)}`],
    });

    expect(() => backend.install(SYNC_TASK)).toThrow("limited to 1000 bytes");
    expect(reads).toBe(0);
    expect(writes).toBe(0);
  });
});
