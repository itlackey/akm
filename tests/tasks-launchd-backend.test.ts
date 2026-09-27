import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmTasksSync } from "../src/commands/tasks/tasks";
import { setSchedulerRefEnabled } from "../src/tasks/activation-config";
import type { LaunchdExec, LaunchdFs } from "../src/tasks/backends/launchd";
import { buildPlistXml, LAUNCHD_BACKEND } from "../src/tasks/backends/launchd";
import type { SchedulerBinding } from "../src/tasks/scheduler-binding";
import {
  resolveScheduledTaskContext,
  type ScheduledTaskContext,
  schedulerContextDescriptor,
  schedulerContextPath,
  writeSchedulerContextDescriptor,
} from "../src/tasks/scheduler-invocation";
import { sandboxStashDir } from "./_helpers/sandbox";
import {
  type SchedulerBackendContractDriver,
  schedulerBackendConformance,
} from "./_helpers/scheduler-backend-conformance";

const SCHEDULED_CONTEXT: ScheduledTaskContext = {
  AKM_BUNDLE_DIR: "/Users/Akm User/stash & notes",
  AKM_CONFIG_DIR: "/Users/Akm User/config",
  AKM_DATA_DIR: "/Users/Akm User/data",
  AKM_CACHE_DIR: "/Users/Akm User/cache",
  AKM_STATE_DIR: "/Users/Akm User/state",
};
const contextPath = () => schedulerContextPath(schedulerContextDescriptor(SCHEDULED_CONTEXT));

function makeTask(schedule: string, id = "ping"): SchedulerBinding {
  return {
    id,
    logicalSource: { kind: "task", ref: `stash//tasks/${id}` },
    cron: schedule,
    source: "akm.schedule",
    ordinal: 0,
    enabled: true,
    invocation: ["task", "run", id, "--scheduled"],
  };
}

function activateTask(stashDir: string, id = "ping"): void {
  setSchedulerRefEnabled(`${path.basename(stashDir).toLowerCase()}//tasks/${id}`, true);
}

describe("buildPlistXml", () => {
  test("step minutes -> wall-clock StartCalendarInterval array", () => {
    const xml = buildPlistXml(makeTask("*/15 * * * *"), ["/abs/akm"], "/var/log/akm", contextPath());
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
    expect(xml).toContain("<string>task</string>");
    expect(xml).toContain("<string>run</string>");
    expect(xml).toContain("<string>ping</string>");
    expect(xml).toContain("<string>--scheduled</string>");
    expect(xml).toContain("<string>--scheduler-context</string>");
    expect(xml).toContain("/tasks/context/");
    expect(xml).not.toContain("<key>AKM_BUNDLE_DIR</key>");
    expect(xml).not.toContain("AKM_LLM_API_KEY");
    expect(xml).toContain("<string>/var/log/akm/ping.log</string>");
  });

  test("renders a qualified workflow binding without task-only arguments", () => {
    const workflow: SchedulerBinding = {
      ...makeTask("0 8 * * 1", "wf-1234"),
      logicalSource: { kind: "workflow", ref: "team//workflows/release" },
      source: "workflows/release.yml:on.schedule[0]",
      invocation: ["workflow", "run", "team//workflows/release"],
    };
    const xml = buildPlistXml(workflow, ["/abs/akm"], "/var/log/akm", contextPath());
    expect(xml).toContain("<string>workflow</string>");
    expect(xml).toContain("<string>team//workflows/release</string>");
    expect(xml).not.toContain("<string>--scheduled</string>");
  });

  test("daily at HH:MM -> StartCalendarInterval", () => {
    const xml = buildPlistXml(makeTask("30 9 * * *"), ["/abs/akm"], "/var/log/akm", contextPath());
    expect(xml).toContain("<key>StartCalendarInterval</key>");
    expect(xml).toContain("<key>Hour</key><integer>9</integer>");
    expect(xml).toContain("<key>Minute</key><integer>30</integer>");
  });

  test("weekly on Mon -> Weekday=1", () => {
    const xml = buildPlistXml(makeTask("0 8 * * 1"), ["/abs/akm"], "/var/log/akm", contextPath());
    expect(xml).toContain("<key>Weekday</key><integer>1</integer>");
  });

  // ── PATH environment injection ───────────────────────────────────────────

  test("PATH goes into EnvironmentVariables, never into the descriptor argv", () => {
    const xml = buildPlistXml(
      makeTask("*/15 * * * *"),
      ["/abs/akm"],
      "/var/log/akm",
      contextPath(),
      "/usr/local/bin:/usr/bin:/bin",
    );
    expect(xml).toContain("<key>EnvironmentVariables</key>");
    expect(xml).toContain("<key>PATH</key>");
    expect(xml).toContain("<string>/usr/local/bin:/usr/bin:/bin</string>");
    expect(xml).toContain("<string>--scheduler-context</string>");
  });

  test("PATH contents are XML-escaped inside the plist", () => {
    const xml = buildPlistXml(
      makeTask("*/15 * * * *"),
      ["/abs/akm"],
      "/var/log/akm",
      contextPath(),
      "/usr/local/bin&special<>bin",
    );
    expect(xml).toContain("<string>/usr/local/bin&amp;special&lt;&gt;bin</string>");
    expect(xml).not.toContain("&special<>bin");
  });

  test("no PATH: no EnvironmentVariables block, the descriptor is still referenced", () => {
    const xml = buildPlistXml(makeTask("*/15 * * * *"), ["/abs/akm"], "/var/log/akm", contextPath());
    expect(xml).toContain("--scheduler-context");
    expect(xml).not.toContain("EnvironmentVariables");
    expect(xml).not.toContain("<key>PATH</key>");
  });
});

// ── LAUNCHD_BACKEND integration with envPath option ──────────────────────────

type FakeLaunchdExec = LaunchdExec & {
  calls: string[][];
  disabledLabels: Set<string>;
  loadedLabels: Set<string>;
  printDisabledResult?: { status: number; stdout: string; stderr: string };
  domainPrintResults?: Array<{ status: number; stdout: string; stderr: string }>;
};

function launchdDomainPrint(labels: readonly string[]): string {
  const services = labels.map((label, index) => `\t${index + 100} = ${label}`).join("\n");
  return `gui/501 = {\n\tservices = {\n${services}${services ? "\n" : ""}\t}\n}\n`;
}

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
        if (target === "gui/501") {
          const next = exec.domainPrintResults?.shift();
          if (next) return next;
          return { status: 0, stdout: launchdDomainPrint([...loadedLabels]), stderr: "" };
        }
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

function launchdMutationCalls(calls: readonly string[][]): readonly string[][] {
  return calls.filter((call) => call[1] !== "print" && call[1] !== "print-disabled");
}

type FakeLaunchdFs = LaunchdFs & {
  written: Map<string, string>;
  readFile(file: string): string;
};

function makeFakeFs(events?: string[]): FakeLaunchdFs {
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

function makeBackend(
  exec = makeFakeExec(),
  fs = makeFakeFs(),
  scheduledContext: ScheduledTaskContext = SCHEDULED_CONTEXT,
) {
  return {
    backend: LAUNCHD_BACKEND({
      exec,
      fs,
      agentsDir: "/tmp/agents",
      logDir: "/tmp/logs",
      akmArgv: ["/abs/akm"],
      envPath: false,
      scheduledContext,
    }),
    exec,
    fs,
  };
}

function launchdContractDriver(scheduledContext = SCHEDULED_CONTEXT): SchedulerBackendContractDriver {
  const { backend, exec, fs } = makeBackend(makeFakeExec(), makeFakeFs(), scheduledContext);
  return {
    backend,
    captureState: () => ({
      files: [...fs.written.entries()].sort(([left], [right]) => left.localeCompare(right)),
      loadedLabels: [...exec.loadedLabels].sort(),
      disabledLabels: [...exec.disabledLabels].sort(),
    }),
    rowText: (nativeId) => fs.written.get(`/tmp/agents/com.akm.task.${nativeId}.plist`),
    addForeignRow() {
      const file = "/tmp/agents/com.example.backup.plist";
      fs.written.set(file, "<plist><dict><key>Label</key><string>com.example.backup</string></dict></plist>");
      exec.loadedLabels.add("com.example.backup");
      return () => ({ plist: fs.written.get(file), loaded: exec.loadedLabels.has("com.example.backup") });
    },
  };
}

schedulerBackendConformance({
  name: "launchd",
  scheduledContext: SCHEDULED_CONTEXT,
  movedContext: { ...SCHEDULED_CONTEXT, AKM_STATE_DIR: "/Users/Akm User/moved-state" },
  create: launchdContractDriver,
});

describe("LAUNCHD_BACKEND — envPath option", () => {
  test("envPath string: PATH lands in the plist's EnvironmentVariables, the descriptor holds directories only", () => {
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
    expect(plist).toContain("<string>--scheduler-context</string>");
    expect(backend.expectedSignature?.(makeTask("*/5 * * * *"))).toBe(
      (backend.list() as Array<{ signature: string }>)[0]?.signature,
    );
  });

  test("envPath false: plist still uses a descriptor without native environment", () => {
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
    expect(plist).toContain("--scheduler-context");
    expect(plist).not.toContain("EnvironmentVariables");
    expect(plist).not.toContain("<key>PATH</key>");
  });

  test("envPath not set: the process PATH is captured into the plist", () => {
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
    expect(() =>
      LAUNCHD_BACKEND({
        exec,
        fs: fakeFs,
        agentsDir: "/tmp/agents",
        logDir: "/tmp/logs",
        akmArgv: ["/abs/akm"],
        envPath: `/usr/bin${String.fromCharCode(1)}/bin`,
        scheduledContext: SCHEDULED_CONTEXT,
      }).install(makeTask("0 9 * * *")),
    ).toThrow("XML-forbidden control characters");
    expect(fakeFs.written.size).toBe(0);
    expect(exec.calls).toEqual([]);
  });

  test("install explicitly enables an enabled task before bootstrap", () => {
    const { backend, exec } = makeBackend();
    backend.install(makeTask("0 9 * * *"));

    expect(launchdMutationCalls(exec.calls)).toEqual([
      ["launchctl", "bootout", "gui/501/com.akm.task.ping"],
      ["launchctl", "enable", "gui/501/com.akm.task.ping"],
      ["launchctl", "bootstrap", "gui/501", "/tmp/agents/com.akm.task.ping.plist"],
    ]);
  });

  test("round-trips a nested logical id through a flat portable label and plist filename", () => {
    const { backend, fs } = makeBackend();
    const nested = {
      ...makeTask("0 9 * * *", "sub/deep/nightly"),
      logicalSource: { kind: "task" as const, ref: "team//sub/deep/nightly" },
      invocation: ["task", "run", "sub/deep/nightly", "--bundle", "team", "--scheduled"],
    };

    backend.install(nested);

    const [file] = [...fs.written.keys()];
    expect(path.relative("/tmp/agents", file ?? "")).not.toContain("/");
    expect(fs.readFile(file ?? "")).not.toContain("<string>com.akm.task.sub/deep/nightly</string>");
    expect(backend.list()).toEqual([expect.objectContaining({ id: "sub/deep/nightly", target: "team" })]);
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

    expect(launchdMutationCalls(exec.calls)).toEqual([
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

    expect(launchdMutationCalls(exec.calls)).toEqual([
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

    expect(launchdMutationCalls(exec.calls)).toEqual([
      ["launchctl", "bootout", "gui/501/com.akm.task.ping"],
      ["launchctl", "enable", "gui/501/com.akm.task.ping"],
    ]);
    expect(fs.written.size).toBe(0);
    expect(exec.disabledLabels.has("com.akm.task.ping")).toBe(false);
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
});

describe("LAUNCHD_BACKEND drift signatures", () => {
  // 0.9 scheduler ABI respelling (S6): an installed plist whose invocation no
  // longer parses is an orphan of its marker id, not a hard failure —
  // `list()` omits it so `akmTasksSync` treats the id as "not present" and
  // reinstalls it from the task file.
  test("omits an installed plist without the current context descriptor", () => {
    const { backend, fs } = makeBackend();
    backend.install(makeTask("0 9 * * *"));
    const file = "/tmp/agents/com.akm.task.ping.plist";
    fs.written.set(
      file,
      fs.readFile(file).replace(/\s*<string>--scheduler-context<\/string>\s*<string>[^<]+<\/string>/, ""),
    );

    expect(backend.list()).toEqual([]);
  });

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
      ["launchctl", "print", "gui/501"],
      ["launchctl", "print-disabled", "gui/501"],
    ]);
  });

  test("an existing plist for an unloaded service is reported as drift", () => {
    const { backend, exec } = makeBackend();
    backend.install(makeTask("0 9 * * *"));
    exec.loadedLabels.delete("com.akm.task.ping");
    exec.calls.length = 0;

    expect(backend.list()).toMatchObject([
      { id: "ping", enabled: false, nativeId: "ping", binding: ["/abs/akm"], contextPath: expect.any(String) },
    ]);
    expect(exec.calls).toEqual([
      ["launchctl", "print", "gui/501"],
      ["launchctl", "print-disabled", "gui/501"],
    ]);
  });

  test("tasks sync repairs an unloaded service whose plist is already current", async () => {
    const stash = sandboxStashDir();
    try {
      const tasksDir = path.join(stash.dir, "tasks");
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(path.join(tasksDir, "ping.yml"), 'version: 4\nrun: echo ping\nschedule: "0 9 * * *"\n', "utf8");
      activateTask(stash.dir);
      // #846: this describe block's default SCHEDULED_CONTEXT points at an
      // intentionally unwritable fake path (exercising special-character
      // handling), so belongsToBundle's owning-path check could never
      // resolve it. Use the real, writable sandboxed context instead, so
      // the backend's own default scheduler-context descriptor is one this
      // test can actually write and read back.
      const { backend, exec } = makeBackend(undefined, undefined, resolveScheduledTaskContext());
      // The backend falls back to its own default context descriptor path
      // (no `schedulerRuntime` deps here) — write it for real so the
      // second sync's owning-path lookup can read it back.
      writeSchedulerContextDescriptor(schedulerContextDescriptor(resolveScheduledTaskContext()));
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
      fs.writeFileSync(path.join(tasksDir, "ping.yml"), 'version: 4\nrun: echo ping\nschedule: "0 9 * * *"\n', "utf8");
      activateTask(stash.dir);
      // #846: same rationale as the previous test — this describe block's
      // default SCHEDULED_CONTEXT can't back a resolvable owning path, so
      // use the real, writable sandboxed context instead.
      const { backend, exec } = makeBackend(undefined, undefined, resolveScheduledTaskContext());
      writeSchedulerContextDescriptor(schedulerContextDescriptor(resolveScheduledTaskContext()));
      expect((await akmTasksSync({ backend })).installed).toEqual(["ping"]);

      exec.disabledLabels.add("com.akm.task.ping");
      exec.calls.length = 0;
      const bundleName = path.basename(stash.dir).toLowerCase();
      const qualifiedTask: SchedulerBinding = {
        ...makeTask("0 9 * * *"),
        logicalSource: { kind: "task", ref: `${bundleName}//tasks/ping` },
        invocation: ["task", "run", "ping", "--bundle", bundleName, "--scheduled"],
      };
      const drifted = backend.list() as Array<{
        id: string;
        enabled?: boolean;
        nativeId?: string;
        signature?: string;
        target?: string;
        binding?: string[];
        contextPath?: string;
      }>;

      expect(drifted).toMatchObject([
        {
          id: "ping",
          enabled: false,
          nativeId: "ping",
          signature: backend.expectedSignature?.({ ...qualifiedTask, enabled: false }),
          target: bundleName,
          binding: ["/abs/akm"],
          contextPath: expect.any(String),
        },
      ]);
      expect(drifted[0]!.signature).not.toBe(backend.expectedSignature?.(qualifiedTask));

      const result = await akmTasksSync({ backend });

      expect(result.updated).toEqual(["ping"]);
      expect(result.unchanged).toEqual([]);
      expect(exec.disabledLabels.has("com.akm.task.ping")).toBe(false);
      expect((backend.list() as Array<{ signature?: string }>)[0]!.signature).toBe(
        backend.expectedSignature?.(qualifiedTask),
      );
      expect(exec.calls).toContainEqual(["launchctl", "print-disabled", "gui/501"]);
    } finally {
      stash.cleanup();
    }
  });

  // print-disabled failing outright, or returning
  // output this parser doesn't recognize (a header line a newer macOS
  // release adds, an SSH session with no GUI domain), used to abort
  // scheduler state inspection entirely. It now degrades to "nothing is
  // known to be disabled" — the task shows up enabled, same as if
  // print-disabled had simply reported no disabled services.
  test("unreadable or unknown launchctl disabled state degrades to 'nothing disabled' instead of failing closed", () => {
    for (const printDisabledResult of [
      { status: 1, stdout: "", stderr: "domain unavailable" },
      { status: 0, stdout: "unexpected launchctl output", stderr: "" },
    ]) {
      const exec = makeFakeExec();
      const { backend } = makeBackend(exec);
      const task = makeTask("0 9 * * *");
      backend.install(task);
      exec.printDisabledResult = printDisabledResult;
      exec.calls.length = 0;

      expect(backend.list()).toMatchObject([
        {
          id: "ping",
          enabled: true,
          nativeId: "ping",
          signature: backend.expectedSignature?.(task),
          binding: ["/abs/akm"],
          contextPath: expect.any(String),
        },
      ]);
      expect(exec.calls).toEqual([
        ["launchctl", "print", "gui/501"],
        ["launchctl", "print-disabled", "gui/501"],
      ]);
    }
  });

  test("a com.akm.task. entry inside an unrecognized print-disabled envelope is still found", () => {
    const exec = makeFakeExec();
    const { backend } = makeBackend(exec);
    const task = makeTask("0 9 * * *");
    backend.install(task);
    // A header line before the envelope, and no closing brace at all — real
    // launchctl output this parser previously required an exact-grammar
    // match against, in full.
    exec.printDisabledResult = {
      status: 0,
      stdout: 'some diagnostic banner\ndisabled services = {\n\t"com.akm.task.ping" => disabled\n',
      stderr: "",
    };

    expect(backend.list()).toMatchObject([
      {
        id: "ping",
        enabled: false,
        nativeId: "ping",
        signature: backend.expectedSignature?.({ ...task, enabled: false }),
        binding: ["/abs/akm"],
        contextPath: expect.any(String),
      },
    ]);
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

    expect(backend.list()).toMatchObject([
      {
        id: "ping",
        enabled: false,
        nativeId: "ping",
        signature: backend.expectedSignature?.({ ...task, enabled: false }),
        binding: ["/abs/akm"],
        contextPath: expect.any(String),
      },
    ]);
  });

  test("signature changes with schedule or enabled state", () => {
    const { backend } = makeBackend();
    const task = makeTask("0 9 * * *");

    expect(backend.expectedSignature?.({ ...task, cron: "0 10 * * *" })).not.toBe(backend.expectedSignature?.(task));
    expect(backend.expectedSignature?.({ ...task, enabled: false })).not.toBe(backend.expectedSignature?.(task));
  });
});
