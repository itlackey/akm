import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmTasksSync } from "../../src/commands/tasks/tasks";
import type { LaunchdExec, LaunchdFs } from "../../src/tasks/backends/launchd";
import { buildPlistXml, LAUNCHD_BACKEND } from "../../src/tasks/backends/launchd";
import type { ScheduledTaskContext } from "../../src/tasks/scheduler-invocation";
import type { TaskDocument } from "../../src/tasks/schema";
import { sandboxStashDir } from "../_helpers/sandbox";

const SCHEDULED_CONTEXT: ScheduledTaskContext = {
  AKM_STASH_DIR: "/Users/Akm User/stash & notes",
  AKM_CONFIG_DIR: "/Users/Akm User/config",
  AKM_DATA_DIR: "/Users/Akm User/data",
  AKM_CACHE_DIR: "/Users/Akm User/cache",
  AKM_STATE_DIR: "/Users/Akm User/state",
};

function makeTask(schedule: string, id = "ping"): TaskDocument {
  return {
    version: 2,
    schemaVersion: 2,
    id,
    schedule,
    enabled: true,
    target: { kind: "workflow", ref: "workflows/noop", params: {} },
    source: { path: `/stash/tasks/${id}.yml` },
  };
}

describe("buildPlistXml", () => {
  test("step minutes -> wall-clock StartCalendarInterval array", () => {
    const xml = buildPlistXml(makeTask("*/15 * * * *"), ["/abs/akm"], "/var/log/akm", undefined, SCHEDULED_CONTEXT);
    expect(xml).toContain("<key>Label</key>");
    expect(xml).toContain("<string>com.akm.task.ping</string>");
    expect(xml).toContain("<key>StartCalendarInterval</key>");
    expect(xml).toContain("<array>");
    expect(xml).toContain("<key>Minute</key><integer>0</integer>");
    expect(xml).toContain("<key>Minute</key><integer>15</integer>");
    expect(xml).toContain("<key>Minute</key><integer>30</integer>");
    expect(xml).toContain("<key>Minute</key><integer>45</integer>");
    expect(xml).not.toContain("<key>StartInterval</key>");
    expect(xml).toContain("<string>/abs/akm</string>");
    expect(xml).toContain("<string>tasks</string>");
    expect(xml).toContain("<string>run</string>");
    expect(xml).toContain("<string>ping</string>");
    expect(xml).toContain("<string>--scheduled</string>");
    expect(xml).toContain("<key>AKM_STASH_DIR</key>");
    expect(xml).toContain("stash &amp; notes");
    expect(xml).not.toContain("AKM_LLM_API_KEY");
    expect(xml).toContain("<string>/var/log/akm/ping.log</string>");
  });

  test("daily at HH:MM -> StartCalendarInterval", () => {
    const xml = buildPlistXml(makeTask("30 9 * * *"), ["/abs/akm"], "/var/log/akm", undefined, SCHEDULED_CONTEXT);
    expect(xml).toContain("<key>StartCalendarInterval</key>");
    expect(xml).toContain("<key>Hour</key><integer>9</integer>");
    expect(xml).toContain("<key>Minute</key><integer>30</integer>");
  });

  test("weekly on Mon -> Weekday=1", () => {
    const xml = buildPlistXml(makeTask("0 8 * * 1"), ["/abs/akm"], "/var/log/akm", undefined, SCHEDULED_CONTEXT);
    expect(xml).toContain("<key>Weekday</key><integer>1</integer>");
  });

  // ── PATH environment injection ───────────────────────────────────────────

  test("pathEnv set: EnvironmentVariables block with correct PATH appears in output", () => {
    const xml = buildPlistXml(
      makeTask("*/15 * * * *"),
      ["/abs/akm"],
      "/var/log/akm",
      "/usr/local/bin:/usr/bin:/bin",
      SCHEDULED_CONTEXT,
    );
    expect(xml).toContain("<key>EnvironmentVariables</key>");
    expect(xml).toContain("<key>PATH</key>");
    expect(xml).toContain("<string>/usr/local/bin:/usr/bin:/bin</string>");
  });

  test("pathEnv set with XML-special characters: value is escaped", () => {
    const xml = buildPlistXml(
      makeTask("*/15 * * * *"),
      ["/abs/akm"],
      "/var/log/akm",
      "/usr/local/bin&special<>bin",
      SCHEDULED_CONTEXT,
    );
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&lt;");
    expect(xml).toContain("&gt;");
    expect(xml).not.toContain("&special<>bin");
  });

  test("pathEnv absent: AKM context remains but PATH is omitted", () => {
    const xml = buildPlistXml(makeTask("*/15 * * * *"), ["/abs/akm"], "/var/log/akm", undefined, SCHEDULED_CONTEXT);
    expect(xml).toContain("EnvironmentVariables");
    expect(xml).toContain("<key>AKM_STASH_DIR</key>");
    expect(xml).not.toContain("<key>PATH</key>");
  });

  test("pathEnv undefined explicitly: EnvironmentVariables contains only AKM context", () => {
    const xml = buildPlistXml(makeTask("*/15 * * * *"), ["/abs/akm"], "/var/log/akm", undefined, SCHEDULED_CONTEXT);
    expect(xml).toContain("EnvironmentVariables");
    expect(xml).not.toContain("<key>PATH</key>");
  });
});

// ── LAUNCHD_BACKEND integration with envPath option ──────────────────────────

type FakeLaunchdExec = LaunchdExec & {
  calls: string[][];
  disabledLabels: Set<string>;
  loadedLabels: Set<string>;
  printDisabledResult?: { status: number; stdout: string; stderr: string };
};

function makeFakeExec(events?: string[]): FakeLaunchdExec {
  const calls: string[][] = [];
  const disabledLabels = new Set<string>();
  const loadedLabels = new Set<string>();
  const exec: FakeLaunchdExec = {
    calls,
    disabledLabels,
    loadedLabels,
    run(args: string[]) {
      calls.push(args);
      const verb = args[1];
      events?.push(`exec:${verb}`);
      const target = args[2] ?? "";
      const targetLabel = target.slice(target.lastIndexOf("/") + 1);
      if (verb === "bootout") {
        if (!loadedLabels.has(targetLabel)) {
          return {
            status: 113,
            stdout: "",
            stderr: `Could not find service "${targetLabel}" in domain for user gui: 501`,
          };
        }
        loadedLabels.delete(targetLabel);
      }
      if (verb === "bootstrap") {
        loadedLabels.add(path.basename(args[3]!, ".plist"));
      }
      if (verb === "enable") disabledLabels.delete(targetLabel);
      if (verb === "disable") disabledLabels.add(targetLabel);
      if (verb === "print-disabled") {
        if (exec.printDisabledResult) return exec.printDisabledResult;
        const entries = [...disabledLabels].map((label) => `\t"${label}" => true`).join("\n");
        return { status: 0, stdout: `disabled services = {\n${entries}${entries ? "\n" : ""}}\n`, stderr: "" };
      }
      if (verb === "print") {
        return loadedLabels.has(targetLabel)
          ? { status: 0, stdout: `${target} = {}`, stderr: "" }
          : { status: 113, stdout: "", stderr: "Could not find service" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    uid() {
      return 501;
    },
  };
  return exec;
}

function makeFakeFs(events?: string[]): LaunchdFs & { written: Map<string, string>; readFile(file: string): string } {
  const written = new Map<string, string>();
  return {
    written,
    writeFile(file: string, content: string) {
      events?.push(`write:${file}`);
      written.set(file, content);
    },
    readFile(file: string) {
      const content = written.get(file);
      if (content === undefined) throw new Error(`missing fake file: ${file}`);
      return content;
    },
    removeFile(file: string) {
      events?.push(`remove:${file}`);
      written.delete(file);
    },
    replaceFile(source: string, destination: string) {
      events?.push(`replace:${source}->${destination}`);
      const content = written.get(source);
      if (content === undefined) throw new Error(`missing fake file: ${source}`);
      written.set(destination, content);
      written.delete(source);
    },
    ensureDir(_dir: string) {},
    list(dir: string) {
      return [...written.keys()].filter((file) => file.startsWith(`${dir}/`)).map((file) => file.slice(dir.length + 1));
    },
    exists(file: string) {
      return file === "/tmp/agents" || written.has(file);
    },
  };
}

function makeBackend(exec = makeFakeExec(), fs = makeFakeFs()) {
  return {
    backend: LAUNCHD_BACKEND({
      exec,
      fs,
      agentsDir: "/tmp/agents",
      logDir: "/tmp/logs",
      akmArgv: ["/abs/akm"],
      envPath: false,
      scheduledContext: SCHEDULED_CONTEXT,
    }),
    exec,
    fs,
  };
}

function makeTransactionalBackend() {
  const fakeFs = makeFakeFs();
  const calls: string[][] = [];
  const disabledLabels = new Set<string>();
  let activePlist: string | undefined;
  let failNextVerb: string | undefined;
  const exec: LaunchdExec = {
    run(args) {
      calls.push(args);
      const verb = args[1];
      const targetLabel = (args[2] ?? "").slice((args[2] ?? "").lastIndexOf("/") + 1);
      let result = { status: 0, stdout: "", stderr: "" };
      if (verb === "print-disabled") {
        const entries = [...disabledLabels].map((label) => `\t"${label}" => true`).join("\n");
        return { status: 0, stdout: `disabled services = {\n${entries}${entries ? "\n" : ""}}\n`, stderr: "" };
      }
      if (verb === "bootout" && verb === failNextVerb) {
        failNextVerb = undefined;
        return { status: 1, stdout: "", stderr: `injected ${verb} failure` };
      }
      if (verb === "bootout") activePlist = undefined;
      if (verb === "enable") disabledLabels.delete(targetLabel);
      if (verb === "disable") disabledLabels.add(targetLabel);
      if (verb === "bootstrap") activePlist = fakeFs.readFile(args[3]!);
      if (verb === failNextVerb) {
        failNextVerb = undefined;
        result = { status: 1, stdout: "", stderr: `injected ${verb} failure` };
      }
      return result;
    },
    uid: () => 501,
  };
  return {
    backend: LAUNCHD_BACKEND({
      exec,
      fs: fakeFs,
      agentsDir: "/tmp/agents",
      logDir: "/tmp/logs",
      akmArgv: ["/abs/akm"],
      envPath: false,
      scheduledContext: SCHEDULED_CONTEXT,
    }),
    exec,
    fs: fakeFs,
    calls,
    disabledLabels,
    activePlist: () => activePlist,
    failNext(verb: string) {
      failNextVerb = verb;
    },
  };
}

describe("LAUNCHD_BACKEND — envPath option", () => {
  test("envPath string: plist written to fake fs contains the provided PATH", () => {
    const fakeFs = makeFakeFs();
    const backend = LAUNCHD_BACKEND({
      exec: makeFakeExec(),
      fs: fakeFs,
      agentsDir: "/tmp/agents",
      logDir: "/tmp/logs",
      akmArgv: ["/abs/akm"],
      envPath: "/custom/bin:/usr/bin:/bin",
      scheduledContext: SCHEDULED_CONTEXT,
    });
    backend.install(makeTask("*/5 * * * *"));
    const entries = [...fakeFs.written.values()];
    expect(entries.length).toBe(1);
    const plist = entries[0];
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain("<string>/custom/bin:/usr/bin:/bin</string>");
  });

  test("envPath false: plist keeps AKM context but omits PATH", () => {
    const fakeFs = makeFakeFs();
    const backend = LAUNCHD_BACKEND({
      exec: makeFakeExec(),
      fs: fakeFs,
      agentsDir: "/tmp/agents",
      logDir: "/tmp/logs",
      akmArgv: ["/abs/akm"],
      envPath: false,
      scheduledContext: SCHEDULED_CONTEXT,
    });
    backend.install(makeTask("*/5 * * * *"));
    const entries = [...fakeFs.written.values()];
    expect(entries.length).toBe(1);
    const plist = entries[0];
    expect(plist).toContain("EnvironmentVariables");
    expect(plist).toContain("<key>AKM_STASH_DIR</key>");
    expect(plist).not.toContain("<key>PATH</key>");
  });

  test("envPath not set: plist contains EnvironmentVariables with process PATH", () => {
    // When envPath is not provided, LAUNCHD_BACKEND captures process.env.PATH.
    // We cannot assert the exact value, but we can verify the block is present
    // as long as process.env.PATH is defined.
    const savedPath = process.env.PATH;
    process.env.PATH = "/injected/bin:/usr/bin";
    try {
      const fakeFs = makeFakeFs();
      const backend = LAUNCHD_BACKEND({
        exec: makeFakeExec(),
        fs: fakeFs,
        agentsDir: "/tmp/agents",
        logDir: "/tmp/logs",
        akmArgv: ["/abs/akm"],
        scheduledContext: SCHEDULED_CONTEXT,
      });
      backend.install(makeTask("*/5 * * * *"));
      const entries = [...fakeFs.written.values()];
      expect(entries.length).toBe(1);
      const plist = entries[0];
      expect(plist).toContain("<key>EnvironmentVariables</key>");
      expect(plist).toContain("<string>/injected/bin:/usr/bin</string>");
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe("LAUNCHD_BACKEND lifecycle", () => {
  test("rejects XML-forbidden control characters before writing the plist", () => {
    const exec = makeFakeExec();
    const fakeFs = makeFakeFs();
    const backend = LAUNCHD_BACKEND({
      exec,
      fs: fakeFs,
      agentsDir: "/tmp/agents",
      logDir: "/tmp/logs",
      akmArgv: ["/abs/akm"],
      envPath: `/usr/bin${String.fromCharCode(1)}/bin`,
      scheduledContext: SCHEDULED_CONTEXT,
    });

    expect(() => backend.install(makeTask("0 9 * * *"))).toThrow("XML-forbidden control characters");
    expect(fakeFs.written.size).toBe(0);
    expect(exec.calls).toEqual([]);
  });

  test("install explicitly enables an enabled task before bootstrap", () => {
    const { backend, exec } = makeBackend();
    backend.install(makeTask("0 9 * * *"));

    expect(exec.calls).toEqual([
      ["launchctl", "bootout", "gui/501/com.akm.task.ping"],
      ["launchctl", "enable", "gui/501/com.akm.task.ping"],
      ["launchctl", "bootstrap", "gui/501", "/tmp/agents/com.akm.task.ping.plist"],
    ]);
  });

  test("install temp-writes, unloads, atomically replaces, then bootstraps", () => {
    const events: string[] = [];
    const { backend } = makeBackend(makeFakeExec(events), makeFakeFs(events));

    backend.install(makeTask("0 9 * * *"));

    const finalFile = "/tmp/agents/com.akm.task.ping.plist";
    const tempWrite = events.find((event) => event.startsWith("write:") && event !== `write:${finalFile}`);
    expect(tempWrite).toBeDefined();
    const tempFile = tempWrite?.slice("write:".length) ?? "";
    const replace = `replace:${tempFile}->${finalFile}`;
    expect(events).not.toContain(`write:${finalFile}`);
    expect(events.indexOf(tempWrite ?? "")).toBeLessThan(events.indexOf("exec:bootout"));
    expect(events.indexOf("exec:bootout")).toBeLessThan(events.indexOf(replace));
    expect(events.indexOf(replace)).toBeLessThan(events.indexOf("exec:bootstrap"));
  });

  test("install clears an old override before setting a task disabled", () => {
    const { backend, exec } = makeBackend();
    backend.install({ ...makeTask("0 9 * * *"), enabled: false });

    expect(exec.calls).toEqual([
      ["launchctl", "bootout", "gui/501/com.akm.task.ping"],
      ["launchctl", "enable", "gui/501/com.akm.task.ping"],
      ["launchctl", "bootstrap", "gui/501", "/tmp/agents/com.akm.task.ping.plist"],
      ["launchctl", "disable", "gui/501/com.akm.task.ping"],
    ]);
  });

  test("uninstall clears a persistent disable override", () => {
    const { backend, exec, fs } = makeBackend();
    backend.install({ ...makeTask("0 9 * * *"), enabled: false });
    exec.calls.length = 0;

    backend.uninstall("ping");

    expect(exec.calls).toEqual([
      ["launchctl", "bootout", "gui/501/com.akm.task.ping"],
      ["launchctl", "enable", "gui/501/com.akm.task.ping"],
    ]);
    expect(fs.written.size).toBe(0);
  });

  test("uninstall removes an already-unloaded task and clears its override", () => {
    const { backend, exec, fs } = makeBackend();
    backend.install({ ...makeTask("0 9 * * *"), enabled: false });
    exec.loadedLabels.delete("com.akm.task.ping");
    exec.calls.length = 0;

    backend.uninstall("ping");

    expect(exec.calls).toEqual([
      ["launchctl", "bootout", "gui/501/com.akm.task.ping"],
      ["launchctl", "enable", "gui/501/com.akm.task.ping"],
    ]);
    expect(fs.written.size).toBe(0);
    expect(exec.disabledLabels.has("com.akm.task.ping")).toBe(false);
  });

  test("uninstall aborts without enabling or deleting after bootout fails", () => {
    const transaction = makeTransactionalBackend();
    transaction.backend.install({ ...makeTask("0 9 * * *"), enabled: false });
    const plistPath = "/tmp/agents/com.akm.task.ping.plist";
    const priorPlist = transaction.fs.readFile(plistPath);
    transaction.calls.length = 0;
    transaction.failNext("bootout");

    expect(() => transaction.backend.uninstall("ping")).toThrow("injected bootout failure");

    expect(transaction.calls).toEqual([["launchctl", "bootout", "gui/501/com.akm.task.ping"]]);
    expect(transaction.fs.readFile(plistPath)).toBe(priorPlist);
    expect(transaction.disabledLabels.has("com.akm.task.ping")).toBe(true);
  });

  test("log-directory creation failure aborts install before plist or launchctl mutation", () => {
    const exec = makeFakeExec();
    const fakeFs = makeFakeFs();
    const backend = LAUNCHD_BACKEND({
      exec,
      fs: {
        ...fakeFs,
        ensureDir(dir) {
          if (dir === "/tmp/logs") throw new Error("injected log directory failure");
        },
      },
      agentsDir: "/tmp/agents",
      logDir: "/tmp/logs",
      akmArgv: ["/abs/akm"],
      envPath: false,
      scheduledContext: SCHEDULED_CONTEXT,
    });

    expect(() => backend.install(makeTask("0 9 * * *"))).toThrow("injected log directory failure");
    expect(fakeFs.written.size).toBe(0);
    expect(exec.calls).toEqual([]);
  });

  for (const scenario of [
    { failure: "bootout", priorEnabled: false, replacementEnabled: true },
    { failure: "enable", priorEnabled: false, replacementEnabled: true },
    { failure: "bootstrap", priorEnabled: false, replacementEnabled: true },
    { failure: "disable", priorEnabled: true, replacementEnabled: false },
  ]) {
    test(`install restores the prior plist and enabled state when ${scenario.failure} fails`, () => {
      const transaction = makeTransactionalBackend();
      const priorTask = { ...makeTask("0 9 * * *"), enabled: scenario.priorEnabled };
      transaction.backend.install(priorTask);
      const plistPath = "/tmp/agents/com.akm.task.ping.plist";
      const priorPlist = transaction.fs.readFile(plistPath);
      transaction.failNext(scenario.failure);

      expect(() =>
        transaction.backend.install({
          ...makeTask("30 10 * * *"),
          enabled: scenario.replacementEnabled,
        }),
      ).toThrow(`injected ${scenario.failure} failure`);

      expect(transaction.fs.readFile(plistPath)).toBe(priorPlist);
      expect(transaction.activePlist()).toBe(priorPlist);
      expect(transaction.disabledLabels.has("com.akm.task.ping")).toBe(!scenario.priorEnabled);
    });
  }
});

describe("LAUNCHD_BACKEND drift signatures", () => {
  test("no-op comparison reads a stable signature from the actual launchd enabled state", () => {
    const { backend, exec } = makeBackend();
    const task = makeTask("0 9 * * *");
    backend.install(task);
    exec.calls.length = 0;

    const listed = backend.list() as Array<{ id: string; signature?: string }>;

    expect(listed).toHaveLength(1);
    expect(listed[0]!.signature).toBeDefined();
    expect(listed[0]!.signature).toBe(backend.expectedSignature?.(task));
    expect(exec.calls).toEqual([
      ["launchctl", "print-disabled", "gui/501"],
      ["launchctl", "print", "gui/501/com.akm.task.ping"],
    ]);
  });

  test("an existing plist for an unloaded service is reported as drift", () => {
    const { backend, exec } = makeBackend();
    backend.install(makeTask("0 9 * * *"));
    exec.loadedLabels.delete("com.akm.task.ping");
    exec.calls.length = 0;

    expect(backend.list()).toEqual([{ id: "ping" }]);
    expect(exec.calls).toEqual([
      ["launchctl", "print-disabled", "gui/501"],
      ["launchctl", "print", "gui/501/com.akm.task.ping"],
    ]);
  });

  test("tasks sync repairs an unloaded service whose plist is already current", async () => {
    const stash = sandboxStashDir();
    try {
      const tasksDir = path.join(stash.dir, "tasks");
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(
        path.join(tasksDir, "ping.yml"),
        'version: 2\nschedule: "0 9 * * *"\ncommand: echo ping\nenabled: true\n',
        "utf8",
      );
      const { backend, exec } = makeBackend();
      expect((await akmTasksSync({ backend })).installed).toEqual(["ping"]);
      exec.loadedLabels.delete("com.akm.task.ping");
      exec.calls.length = 0;

      const result = await akmTasksSync({ backend });

      expect(result.updated).toEqual(["ping"]);
      expect(result.unchanged).toEqual([]);
      expect(exec.loadedLabels.has("com.akm.task.ping")).toBe(true);
      expect(exec.calls).toContainEqual(["launchctl", "bootout", "gui/501/com.akm.task.ping"]);
      expect(exec.calls).toContainEqual(["launchctl", "bootstrap", "gui/501", "/tmp/agents/com.akm.task.ping.plist"]);
    } finally {
      stash.cleanup();
    }
  });

  test("a launchctl-disabled override changes the listed signature and tasks sync repairs it", async () => {
    const stash = sandboxStashDir();
    try {
      const tasksDir = path.join(stash.dir, "tasks");
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(
        path.join(tasksDir, "ping.yml"),
        'version: 2\nschedule: "0 9 * * *"\ncommand: echo ping\nenabled: true\n',
        "utf8",
      );
      const { backend, exec } = makeBackend();
      expect((await akmTasksSync({ backend })).installed).toEqual(["ping"]);

      exec.disabledLabels.add("com.akm.task.ping");
      exec.calls.length = 0;
      const drifted = backend.list() as Array<{ id: string; signature?: string }>;

      expect(drifted).toEqual([
        { id: "ping", signature: backend.expectedSignature?.({ ...makeTask("0 9 * * *"), enabled: false }) },
      ]);
      expect(drifted[0]!.signature).not.toBe(backend.expectedSignature?.(makeTask("0 9 * * *")));

      const result = await akmTasksSync({ backend });

      expect(result.updated).toEqual(["ping"]);
      expect(result.unchanged).toEqual([]);
      expect(exec.disabledLabels.has("com.akm.task.ping")).toBe(false);
      expect((backend.list() as Array<{ signature?: string }>)[0]!.signature).toBe(
        backend.expectedSignature?.(makeTask("0 9 * * *")),
      );
      expect(exec.calls).toContainEqual(["launchctl", "print-disabled", "gui/501"]);
    } finally {
      stash.cleanup();
    }
  });

  test("unreadable or unknown launchctl disabled state is reported as drift", () => {
    for (const printDisabledResult of [
      { status: 1, stdout: "", stderr: "domain unavailable" },
      { status: 0, stdout: "unexpected launchctl output", stderr: "" },
    ]) {
      const exec = makeFakeExec();
      const { backend } = makeBackend(exec);
      backend.install(makeTask("0 9 * * *"));
      exec.printDisabledResult = printDisabledResult;
      exec.calls.length = 0;

      expect(backend.list()).toEqual([{ id: "ping" }]);
      expect(exec.calls).toEqual([["launchctl", "print-disabled", "gui/501"]]);
    }
  });

  test("reads modern launchctl enabled and disabled values", () => {
    const exec = makeFakeExec();
    const { backend } = makeBackend(exec);
    const task = makeTask("0 9 * * *");
    backend.install(task);
    exec.printDisabledResult = {
      status: 0,
      stdout: 'disabled services = {\n\t"com.akm.task.ping" => disabled\n\t"com.example.enabled" => enabled\n}\n',
      stderr: "",
    };

    expect(backend.list()).toEqual([
      { id: "ping", signature: backend.expectedSignature?.({ ...task, enabled: false }) },
    ]);
  });

  test("signature changes with schedule or enabled state", () => {
    const { backend } = makeBackend();
    const task = makeTask("0 9 * * *");

    expect(backend.expectedSignature?.({ ...task, schedule: "0 10 * * *" })).not.toBe(
      backend.expectedSignature?.(task),
    );
    expect(backend.expectedSignature?.({ ...task, enabled: false })).not.toBe(backend.expectedSignature?.(task));
  });

  test("signature changes when the resolved AKM context changes", () => {
    const original = makeBackend().backend;
    const moved = LAUNCHD_BACKEND({
      exec: makeFakeExec(),
      fs: makeFakeFs(),
      agentsDir: "/tmp/agents",
      logDir: "/tmp/logs",
      akmArgv: ["/abs/akm"],
      envPath: false,
      scheduledContext: { ...SCHEDULED_CONTEXT, AKM_DATA_DIR: "/Users/Akm User/moved data" },
    });
    const task = makeTask("0 9 * * *");

    expect(original.expectedSignature?.(task)).not.toBe(moved.expectedSignature?.(task));
  });
});
