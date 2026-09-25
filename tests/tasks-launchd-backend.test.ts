import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmTasksSync } from "../src/commands/tasks/tasks";
import { setSchedulerRefEnabled } from "../src/tasks/activation-config";
import type { LaunchdExec, LaunchdFs } from "../src/tasks/backends/launchd";
import { buildPlistXml, LAUNCHD_BACKEND } from "../src/tasks/backends/launchd";
import {
  type SchedulerBackendInspection,
  type SchedulerBinding,
  type SchedulerRemovalExpectation,
  schedulerNativeBindingId,
} from "../src/tasks/scheduler-binding";
import {
  resolveScheduledTaskContext,
  type ScheduledTaskContext,
  schedulerContextDescriptor,
  schedulerContextPath,
  writeSchedulerContextDescriptor,
} from "../src/tasks/scheduler-invocation";
import { sandboxStashDir } from "./_helpers/sandbox";
import {
  type SchedulerArtifactDrift,
  type SchedulerBackendContractDriver,
  type SchedulerNormalizedPeer,
  schedulerBackendConformance,
} from "./_helpers/scheduler-backend-conformance";

const SCHEDULED_CONTEXT: ScheduledTaskContext = {
  AKM_BUNDLE_DIR: "/Users/Akm User/stash & notes",
  AKM_CONFIG_DIR: "/Users/Akm User/config",
  AKM_DATA_DIR: "/Users/Akm User/data",
  AKM_CACHE_DIR: "/Users/Akm User/cache",
  AKM_STATE_DIR: "/Users/Akm User/state",
};
const contextPath = (envPath = "") => schedulerContextPath(schedulerContextDescriptor(SCHEDULED_CONTEXT, envPath));

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

  test("pathEnv is captured by descriptor rather than native environment", () => {
    const xml = buildPlistXml(
      makeTask("*/15 * * * *"),
      ["/abs/akm"],
      "/var/log/akm",
      contextPath("/usr/local/bin:/usr/bin:/bin"),
    );
    expect(xml).not.toContain("<key>EnvironmentVariables</key>");
    expect(xml).toContain("<string>--scheduler-context</string>");
  });

  test("pathEnv contents do not inflate or escape into the plist", () => {
    const xml = buildPlistXml(
      makeTask("*/15 * * * *"),
      ["/abs/akm"],
      "/var/log/akm",
      contextPath("/usr/local/bin&special<>bin"),
    );
    expect(xml).not.toContain("&amp;");
    expect(xml).not.toContain("&special<>bin");
  });

  test("pathEnv absent still uses a descriptor", () => {
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

const LAUNCHD_INSPECTION_EVENTS = ["exec:print", "exec:print-disabled"] as const;

type FakeLaunchdFs = LaunchdFs & {
  written: Map<string, string>;
  readFile(file: string): string;
  resetActivity(): void;
  accessCount(): number;
  mutationCount(): number;
};

function makeFakeFs(events?: string[]): FakeLaunchdFs {
  const written = new Map<string, string>();
  let accesses = 0;
  let mutations = 0;
  return {
    written,
    writeFile(file: string, content: string) {
      accesses += 1;
      mutations += 1;
      events?.push(`write:${file}`);
      written.set(file, content);
    },
    readFile(file: string) {
      accesses += 1;
      const content = written.get(file);
      if (content === undefined) throw new Error(`missing fake file: ${file}`);
      return content;
    },
    removeFile(file: string) {
      accesses += 1;
      mutations += 1;
      events?.push(`remove:${file}`);
      written.delete(file);
    },
    replaceFile(source: string, destination: string) {
      accesses += 1;
      mutations += 1;
      events?.push(`replace:${source}->${destination}`);
      const content = written.get(source);
      if (content === undefined) throw new Error(`missing fake file: ${source}`);
      written.set(destination, content);
      written.delete(source);
    },
    ensureDir(_dir: string) {
      accesses += 1;
    },
    list(dir: string) {
      accesses += 1;
      return [...written.keys()].filter((file) => file.startsWith(`${dir}/`)).map((file) => file.slice(dir.length + 1));
    },
    exists(file: string) {
      accesses += 1;
      return file === "/tmp/agents" || written.has(file);
    },
    resetActivity() {
      accesses = 0;
      mutations = 0;
    },
    accessCount: () => accesses,
    mutationCount: () => mutations,
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

function qualifiedTask(schedule: string, id = "ping"): SchedulerBinding {
  return {
    ...makeTask(schedule, id),
    nativeId: schedulerNativeBindingId(id),
    logicalSource: { kind: "task", ref: `stash//tasks/${id}` },
    invocation: ["task", "run", id, "--bundle", "stash", "--scheduled"],
  };
}

function mutationExpectation(binding: SchedulerBinding, state: "absent" | "present", fingerprint?: string) {
  return {
    state,
    bindingId: binding.id,
    nativeId: binding.nativeId ?? schedulerNativeBindingId(binding.id),
    logicalSource: binding.logicalSource,
    ordinal: binding.ordinal,
    invocation: binding.invocation,
    ...(fingerprint !== undefined ? { fingerprint } : {}),
  };
}

function launchdContractDriver(scheduledContext = SCHEDULED_CONTEXT): SchedulerBackendContractDriver {
  const exec = makeFakeExec();
  const fs = makeFakeFs();
  const { backend } = makeBackend(exec, fs, scheduledContext);
  const nativeId = (binding: SchedulerBinding) => binding.nativeId ?? schedulerNativeBindingId(binding.id);
  const artifactFile = (binding: SchedulerBinding) => `/tmp/agents/com.akm.task.${nativeId(binding)}.plist`;

  return {
    backend,
    captureState() {
      return {
        files: [...fs.written.entries()].sort(([left], [right]) => left.localeCompare(right)),
        loadedLabels: [...exec.loadedLabels].sort(),
        disabledLabels: [...exec.disabledLabels].sort(),
      };
    },
    clearArtifact(binding) {
      const id = nativeId(binding);
      fs.written.delete(artifactFile(binding));
      exec.loadedLabels.delete(`com.akm.task.${id}`);
      exec.disabledLabels.delete(`com.akm.task.${id}`);
    },
    driftArtifact(binding, drift: SchedulerArtifactDrift) {
      const file = artifactFile(binding);
      const prior = fs.written.get(file);
      if (!prior) throw new Error(`missing launchd plist fixture for ${binding.id}`);
      const next =
        drift === "foreign"
          ? prior.replaceAll("<string>ping</string>", "<string>foreign</string>")
          : drift === "malformed"
            ? prior.replaceAll("<string>--scheduled</string>", "<string>--broken</string>")
            : prior.replace("<key>Minute</key><integer>0</integer>", "<key>Minute</key><integer>7</integer>");
      if (next === prior) throw new Error(`failed to drift launchd fixture for ${drift}`);
      fs.written.set(file, next);
    },
    addNormalizedPeer(binding, peer: SchedulerNormalizedPeer) {
      const id = nativeId(binding);
      const plist = fs.written.get(artifactFile(binding));
      if (!plist) throw new Error(`missing launchd plist fixture for ${binding.id}`);
      const peerId = peer === "case" ? id.toUpperCase() : `${id}.`;
      fs.written.set(`/tmp/agents/com.akm.task.${peerId}.plist`, plist);
    },
    currentFingerprint(binding) {
      const artifact = (backend.listNativeArtifacts?.() as Array<{ nativeId: string; fingerprint?: string }>).find(
        (candidate) => candidate.nativeId === nativeId(binding),
      );
      if (!artifact?.fingerprint) throw new Error(`missing launchd fingerprint fixture for ${binding.id}`);
      return artifact.fingerprint;
    },
    resetActivity() {
      exec.calls.length = 0;
      fs.resetActivity();
    },
    accessCount: () => exec.calls.length + fs.accessCount(),
    mutationCount: () => launchdMutationCalls(exec.calls).length + fs.mutationCount(),
  };
}

schedulerBackendConformance({
  name: "launchd",
  scheduledContext: SCHEDULED_CONTEXT,
  movedContext: { ...SCHEDULED_CONTEXT, AKM_STATE_DIR: "/Users/Akm User/moved-state" },
  create: launchdContractDriver,
});

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
      if (verb === "print") {
        if (args[2] === "gui/501") {
          return {
            status: 0,
            stdout: launchdDomainPrint(activePlist === undefined ? [] : ["com.akm.task.ping"]),
            stderr: "",
          };
        }
        return activePlist === undefined
          ? { status: 113, stdout: "", stderr: "Could not find service" }
          : { status: 0, stdout: `${args[2]} = {}`, stderr: "" };
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
  test("envPath string: plist uses the context descriptor", () => {
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
    expect(plist).not.toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<string>--scheduler-context</string>");
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

  test("envPath not set: process PATH stays out of the plist", () => {
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
      expect(plist).not.toContain("<key>EnvironmentVariables</key>");
      expect(plist).not.toContain("/injected/bin:/usr/bin");
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe("LAUNCHD_BACKEND lifecycle", () => {
  test.each([
    "PING",
  ])("direct create CAS rejects a portable-key-equivalent enabled loaded-only service %s", (loadedId) => {
    const { backend, exec, fs } = makeBackend();
    const owned = qualifiedTask("0 9 * * *");
    exec.loadedLabels.add(`com.akm.task.${loadedId}`);
    exec.calls.length = 0;

    expect(() =>
      (backend.install as (...args: unknown[]) => void)(owned, undefined, mutationExpectation(owned, "absent")),
    ).toThrow(/changed|absence|exists|cardinality|collision|duplicate/i);
    expect(fs.written.has("/tmp/agents/com.akm.task.ping.plist")).toBe(false);
    expect(exec.loadedLabels.has(`com.akm.task.${loadedId}`)).toBe(true);
    expect(launchdMutationCalls(exec.calls)).toEqual([]);
  });

  test("direct install without an expectation rejects a case-equivalent enabled loaded-only service", () => {
    const { backend, exec, fs } = makeBackend();
    exec.loadedLabels.add("com.akm.task.PING");
    exec.calls.length = 0;

    expect(() => backend.install(qualifiedTask("0 9 * * *"))).toThrow(
      /changed|owner|exists|cardinality|collision|duplicate/i,
    );
    expect(fs.written.has("/tmp/agents/com.akm.task.ping.plist")).toBe(false);
    expect(exec.loadedLabels.has("com.akm.task.PING")).toBe(true);
    expect(launchdMutationCalls(exec.calls)).toEqual([]);
  });

  test("coherent inspection reports every loaded-only portable-key peer without inventing ownership", () => {
    const { backend, exec } = makeBackend();
    exec.loadedLabels.add("com.akm.task.PING");
    exec.loadedLabels.add("com.akm.task.ping.");

    const inspection = backend.inspectBindings?.() as SchedulerBackendInspection;

    expect(inspection?.installed).toEqual([]);
    expect(inspection?.artifacts.map((artifact) => artifact.nativeId)).toEqual(["PING", "ping."]);
    expect(inspection?.artifacts.every((artifact) => artifact.invocation === undefined)).toBe(true);
  });

  test("expected-present update and removal reject a loaded-only service with no frozen public owner", () => {
    const { backend, exec, fs } = makeBackend();
    const owned = qualifiedTask("0 9 * * *");
    backend.install(owned);
    const nativeId = schedulerNativeBindingId(owned.id);
    const fingerprint = backend.expectedSignature?.(owned);
    const expected = mutationExpectation(owned, "present", fingerprint) as SchedulerRemovalExpectation;
    fs.removeFile(`/tmp/agents/com.akm.task.${nativeId}.plist`);
    exec.calls.length = 0;

    expect(() =>
      (backend.install as (...args: unknown[]) => void)({ ...owned, cron: "30 10 * * *" }, undefined, expected),
    ).toThrow(/changed|owner|fingerprint|present/i);
    expect(() => backend.uninstall(nativeId, expected)).toThrow(/changed|owner|fingerprint|present/i);
    expect(exec.loadedLabels.has(`com.akm.task.${nativeId}`)).toBe(true);
    expect(launchdMutationCalls(exec.calls)).toEqual([]);
  });

  test("direct create CAS treats a persistent disabled override without a plist as native state", () => {
    const { backend, exec, fs } = makeBackend();
    const owned = qualifiedTask("0 9 * * *");
    exec.disabledLabels.add("com.akm.task.ping");

    expect(() =>
      (backend.install as (...args: unknown[]) => void)(owned, undefined, mutationExpectation(owned, "absent")),
    ).toThrow(/changed|absent|native|fingerprint/i);
    expect(fs.written.size).toBe(0);
    expect(exec.calls.some((call) => call[1] === "bootout")).toBe(false);
  });

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
    ).toThrow("scheduler context");
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

    const colliding = {
      ...makeTask("0 9 * * *", "task-b0117b892c35999ceb4d5386f8609932"),
      logicalSource: { kind: "task" as const, ref: "team//task-b0117b892c35999ceb4d5386f8609932" },
      invocation: ["task", "run", "task-b0117b892c35999ceb4d5386f8609932", "--bundle", "team", "--scheduled"],
    };
    expect(() => backend.install(colliding)).toThrow(/native scheduler artifact|different logical owner/i);
    expect(backend.list()).toEqual([expect.objectContaining({ id: "sub/deep/nightly", target: "team" })]);
  });

  test("rechecks the exact plist owner after preparing the temp file and before bootout", () => {
    const exec = makeFakeExec();
    const fs = makeFakeFs();
    const { backend } = makeBackend(exec, fs);
    const nested = {
      ...makeTask("0 9 * * *", "sub/deep/nightly"),
      logicalSource: { kind: "task" as const, ref: "team//sub/deep/nightly" },
      invocation: ["task", "run", "sub/deep/nightly", "--bundle", "team", "--scheduled"],
    };
    backend.install(nested);
    const finalFile = [...fs.written.keys()].find((file) => !path.basename(file).startsWith("."));
    if (!finalFile) throw new Error("missing installed plist");

    const writeFile = fs.writeFile.bind(fs);
    let swapAtTempWrite = true;
    fs.writeFile = (file, content) => {
      writeFile(file, content);
      if (swapAtTempWrite && path.basename(file).startsWith(".")) {
        swapAtTempWrite = false;
        fs.written.set(finalFile, fs.readFile(finalFile).replaceAll("sub/deep/nightly", "other-owner"));
      }
    };
    exec.calls.length = 0;

    expect(() => backend.install({ ...nested, cron: "30 10 * * *" })).toThrow(/belongs to|changed.*refusing/i);
    expect(exec.calls.some((call) => call[1] === "bootout")).toBe(false);
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

  test("direct uninstall without an expectation rejects a case-equivalent enabled loaded-only service", () => {
    const { backend, exec, fs } = makeBackend();
    exec.loadedLabels.add("com.akm.task.PING");
    exec.calls.length = 0;

    expect(() => backend.uninstall("ping")).toThrow(/owner|cardinality|collision|duplicate|unproven/i);
    expect(fs.written.has("/tmp/agents/com.akm.task.ping.plist")).toBe(false);
    expect(exec.loadedLabels.has("com.akm.task.PING")).toBe(true);
    expect(launchdMutationCalls(exec.calls)).toEqual([]);
  });

  test("direct uninstall rejects an exact-spelling loaded-only service with no provable public owner", () => {
    const { backend, exec, fs } = makeBackend();
    exec.loadedLabels.add("com.akm.task.ping");
    exec.calls.length = 0;

    expect(() => backend.uninstall("ping")).toThrow(/proven|owner|refusing/i);
    expect(fs.written.has("/tmp/agents/com.akm.task.ping.plist")).toBe(false);
    expect(exec.loadedLabels.has("com.akm.task.ping")).toBe(true);
    expect(launchdMutationCalls(exec.calls)).toEqual([]);
  });

  test("binding snapshots restore exact plist, loaded, enabled, and absent states", () => {
    const { backend, exec, fs } = makeBackend();
    const priorTask = { ...makeTask("0 9 * * *"), enabled: false };
    backend.install(priorTask);
    const file = "/tmp/agents/com.akm.task.ping.plist";
    const priorPlist = fs.readFile(file);
    const snapshot = backend.snapshotBindings?.(["ping", "absent"]);

    backend.install(makeTask("30 10 * * *"));
    backend.install(makeTask("15 11 * * *", "absent"));
    backend.restoreBindings?.(snapshot);

    expect(fs.readFile(file)).toBe(priorPlist);
    expect(fs.written.has("/tmp/agents/com.akm.task.absent.plist")).toBe(false);
    expect(exec.loadedLabels.has("com.akm.task.ping")).toBe(true);
    expect(exec.loadedLabels.has("com.akm.task.absent")).toBe(false);
    expect(exec.disabledLabels.has("com.akm.task.ping")).toBe(true);
    expect(exec.disabledLabels.has("com.akm.task.absent")).toBe(false);
  });

  test("binding snapshots include a case-equivalent enabled loaded-only service", () => {
    const { backend, exec } = makeBackend();
    exec.loadedLabels.add("com.akm.task.PING");

    const snapshot = backend.snapshotBindings?.(["ping"]) as unknown as {
      artifacts: ReadonlyArray<{ nativeId: string; fingerprint?: string }>;
      entries: ReadonlyArray<{ id: string; loaded: boolean; enabled: boolean }>;
    };

    expect(snapshot.artifacts).toEqual([
      expect.objectContaining({ nativeId: "PING", fingerprint: "launchd:missing-plist:enabled=true:loaded=true" }),
    ]);
    expect(snapshot.entries).toEqual([expect.objectContaining({ id: "PING", loaded: true, enabled: true })]);
  });

  test("direct restore leaves an unchanged loaded-only snapshot entry untouched", () => {
    const { backend, exec } = makeBackend();
    exec.loadedLabels.add("com.akm.task.ping");
    const snapshot = backend.snapshotBindings?.(["ping"]);
    exec.calls.length = 0;

    expect(() => backend.restoreBindings?.(snapshot)).not.toThrow();
    expect(exec.loadedLabels.has("com.akm.task.ping")).toBe(true);
    expect(launchdMutationCalls(exec.calls)).toEqual([]);
  });

  test("whole-snapshot restore preflights a plist-backed owner before a loaded-only normalized peer", () => {
    const { backend, exec, fs } = makeBackend();
    backend.install(qualifiedTask("0 9 * * *", "PING"));
    exec.loadedLabels.add("com.akm.task.ping");
    const snapshot = backend.snapshotBindings?.(["PING"]);
    const ownerFile = "/tmp/agents/com.akm.task.PING.plist";
    const ownerPlist = fs.readFile(ownerFile);
    exec.calls.length = 0;

    expect(() => backend.restoreBindings?.(snapshot)).toThrow(/restore|snapshot|cardinality|duplicate|collision/i);
    expect(fs.readFile(ownerFile)).toBe(ownerPlist);
    expect(exec.loadedLabels.has("com.akm.task.PING")).toBe(true);
    expect(exec.loadedLabels.has("com.akm.task.ping")).toBe(true);
    expect(launchdMutationCalls(exec.calls)).toEqual([]);
  });

  test("whole-snapshot restore validates expected-current coverage before restoring an earlier entry", () => {
    const { backend, exec, fs } = makeBackend();
    const ping = qualifiedTask("0 9 * * *");
    const second = qualifiedTask("15 9 * * *", "second");
    backend.install(ping);
    backend.install(second);
    const snapshot = backend.snapshotBindings?.(["ping", "second"]);
    const pingFile = "/tmp/agents/com.akm.task.ping.plist";
    const secondFile = "/tmp/agents/com.akm.task.second.plist";
    const pingPlist = fs.readFile(pingFile);
    const secondPlist = fs.readFile(secondFile);
    exec.calls.length = 0;
    const restore = backend.restoreBindings as unknown as (
      snapshot: unknown,
      guards: readonly Record<string, unknown>[],
    ) => void;

    expect(() =>
      restore(snapshot, [
        {
          nativeId: "ping",
          allowed: [
            {
              state: "present",
              bindingId: ping.id,
              invocation: ping.invocation,
              fingerprint: backend.expectedSignature?.(ping),
            },
          ],
        },
      ]),
    ).toThrow(/restore|preflight|expectation|coverage|missing/i);
    expect(fs.readFile(pingFile)).toBe(pingPlist);
    expect(fs.readFile(secondFile)).toBe(secondPlist);
    expect(launchdMutationCalls(exec.calls)).toEqual([]);
  });

  test("whole-snapshot restore rejects an expected-current entry outside the snapshot before mutation", () => {
    const { backend, exec, fs } = makeBackend();
    const ping = qualifiedTask("0 9 * * *");
    backend.install(ping);
    const snapshot = backend.snapshotBindings?.(["ping"]);
    const pingFile = "/tmp/agents/com.akm.task.ping.plist";
    const pingPlist = fs.readFile(pingFile);
    exec.calls.length = 0;
    const restore = backend.restoreBindings as unknown as (
      snapshot: unknown,
      guards: readonly Record<string, unknown>[],
    ) => void;

    expect(() =>
      restore(snapshot, [
        {
          nativeId: "ping",
          allowed: [
            {
              state: "present",
              bindingId: ping.id,
              invocation: ping.invocation,
              fingerprint: backend.expectedSignature?.(ping),
            },
          ],
        },
        { nativeId: "outside", allowed: [{ state: "absent" }] },
      ]),
    ).toThrow(/restore|preflight|expectation|snapshot|unexpected/i);
    expect(fs.readFile(pingFile)).toBe(pingPlist);
    expect(exec.loadedLabels.has("com.akm.task.ping")).toBe(true);
    expect(launchdMutationCalls(exec.calls)).toEqual([]);
  });

  test("whole-snapshot restore rejects duplicate normalized requested native IDs before mutation", () => {
    const { backend, exec, fs } = makeBackend();
    backend.install(qualifiedTask("0 9 * * *", "PING"));
    const snapshot = backend.snapshotBindings?.(["PING", "ping"]);
    const ownerFile = "/tmp/agents/com.akm.task.PING.plist";
    const ownerPlist = fs.readFile(ownerFile);
    exec.calls.length = 0;

    expect(() => backend.restoreBindings?.(snapshot)).toThrow(/restore|snapshot|normalized|duplicate|collision/i);
    expect(fs.readFile(ownerFile)).toBe(ownerPlist);
    expect(exec.loadedLabels.has("com.akm.task.PING")).toBe(true);
    expect(launchdMutationCalls(exec.calls)).toEqual([]);
  });

  test("whole-snapshot guarded restore reports one deterministic duplicate-snapshot preflight error", () => {
    const { backend, exec, fs } = makeBackend();
    backend.install(qualifiedTask("0 9 * * *", "PING"));
    exec.loadedLabels.add("com.akm.task.ping");
    const snapshot = backend.snapshotBindings?.(["PING"]) as unknown as {
      artifacts: ReadonlyArray<{
        nativeId: string;
        bindingId?: string;
        invocation?: readonly string[];
        fingerprint?: string;
      }>;
    };
    const guards = snapshot.artifacts.map((artifact) => ({
      nativeId: artifact.nativeId,
      allowed: [
        {
          state: "present",
          ...(artifact.bindingId !== undefined ? { bindingId: artifact.bindingId } : {}),
          ...(artifact.invocation !== undefined ? { invocation: artifact.invocation } : {}),
          fingerprint: artifact.fingerprint,
        },
      ],
    }));
    const ownerFile = "/tmp/agents/com.akm.task.PING.plist";
    const ownerPlist = fs.readFile(ownerFile);
    exec.calls.length = 0;
    const restore = backend.restoreBindings as unknown as (
      snapshot: unknown,
      expectedCurrent: readonly Record<string, unknown>[],
    ) => void;

    let caught: unknown;
    try {
      restore(snapshot, guards);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(1);
    expect(fs.readFile(ownerFile)).toBe(ownerPlist);
    expect(exec.loadedLabels.has("com.akm.task.PING")).toBe(true);
    expect(exec.loadedLabels.has("com.akm.task.ping")).toBe(true);
    expect(launchdMutationCalls(exec.calls)).toEqual([]);
  });

  test.each([
    { ownerId: "ping", peerId: "PING", guarded: false },
    { ownerId: "PING", peerId: "ping.", guarded: true },
  ])("whole-snapshot preflight rejects owner $ownerId and loaded-only peer $peerId before mutation (guarded=$guarded)", ({
    ownerId,
    peerId,
    guarded,
  }) => {
    const { backend, exec, fs } = makeBackend();
    backend.install(qualifiedTask("0 9 * * *", ownerId));
    exec.loadedLabels.add(`com.akm.task.${peerId}`);
    const snapshot = backend.snapshotBindings?.([ownerId]) as unknown as {
      artifacts: ReadonlyArray<{
        nativeId: string;
        bindingId?: string;
        invocation?: readonly string[];
        fingerprint?: string;
      }>;
    };
    const guards = snapshot.artifacts.map((artifact) => ({
      nativeId: artifact.nativeId,
      allowed: [
        {
          state: "present",
          ...(artifact.bindingId !== undefined ? { bindingId: artifact.bindingId } : {}),
          ...(artifact.invocation !== undefined ? { invocation: artifact.invocation } : {}),
          fingerprint: artifact.fingerprint,
        },
      ],
    }));
    const ownerFile = `/tmp/agents/com.akm.task.${ownerId}.plist`;
    const ownerPlist = fs.readFile(ownerFile);
    exec.calls.length = 0;
    const restore = backend.restoreBindings as unknown as (
      snapshot: unknown,
      expectedCurrent?: readonly Record<string, unknown>[],
    ) => void;

    let caught: unknown;
    try {
      restore(snapshot, guarded ? guards : undefined);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(1);
    expect(fs.readFile(ownerFile)).toBe(ownerPlist);
    expect(exec.loadedLabels.has(`com.akm.task.${ownerId}`)).toBe(true);
    expect(exec.loadedLabels.has(`com.akm.task.${peerId}`)).toBe(true);
    expect(launchdMutationCalls(exec.calls)).toEqual([]);
  });

  test("restore rechecks the preflight fingerprint immediately before each entry mutation", () => {
    const { backend, exec, fs } = makeBackend();
    const snapshot = backend.snapshotBindings?.(["ping"]);
    const run = exec.run.bind(exec);
    let domainPasses = 0;
    exec.run = (args) => {
      // Inject the drift right after the preflight scan's own domain print
      // (pass 1), so the SEPARATE immediate recheck right before mutating
      // "ping" (pass 2) observes it and its cardinality check against the
      // preflight-derived expectation fails.
      if (args[1] === "print" && args[2] === "gui/501" && ++domainPasses === 1) {
        exec.loadedLabels.add("com.akm.task.PING");
      }
      return run(args);
    };
    exec.calls.length = 0;

    expect(() => backend.restoreBindings?.(snapshot)).toThrow(/restore|changed|cardinality|concurrent|fingerprint/i);
    expect(fs.written.has("/tmp/agents/com.akm.task.ping.plist")).toBe(false);
    expect(exec.loadedLabels.has("com.akm.task.PING")).toBe(true);
    expect(launchdMutationCalls(exec.calls)).toEqual([]);
  });

  test.each([
    "disappeared",
    "case-peer",
    "duplicate-peer",
  ] as const)("direct restore rejects a %s loaded-only snapshot state without mutating it", (change) => {
    const { backend, exec } = makeBackend();
    exec.loadedLabels.add("com.akm.task.ping");
    const snapshot = backend.snapshotBindings?.(["ping"]);
    if (change === "disappeared") exec.loadedLabels.delete("com.akm.task.ping");
    if (change === "case-peer") {
      exec.loadedLabels.delete("com.akm.task.ping");
      exec.loadedLabels.add("com.akm.task.PING");
    }
    if (change === "duplicate-peer") exec.loadedLabels.add("com.akm.task.PING");
    const loadedBefore = [...exec.loadedLabels].sort();
    const disabledBefore = [...exec.disabledLabels].sort();
    exec.calls.length = 0;

    expect(() => backend.restoreBindings?.(snapshot)).toThrow(/restore|cardinality|changed|plist|snapshot/i);
    expect([...exec.loadedLabels].sort()).toEqual(loadedBefore);
    expect([...exec.disabledLabels].sort()).toEqual(disabledBefore);
    expect(launchdMutationCalls(exec.calls)).toEqual([]);
  });

  test("direct restore aborts the whole set before mutation on an unrestorable loaded-only mismatch", () => {
    const { backend, exec, fs } = makeBackend();
    exec.loadedLabels.add("com.akm.task.ping");
    const snapshot = backend.snapshotBindings?.(["ping", "second"]);
    backend.install(qualifiedTask("0 9 * * *", "second"));
    exec.loadedLabels.delete("com.akm.task.ping");
    exec.calls.length = 0;

    let caught: unknown;
    try {
      backend.restoreBindings?.(snapshot);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(1);
    expect(exec.loadedLabels.has("com.akm.task.ping")).toBe(false);
    expect(fs.written.has("/tmp/agents/com.akm.task.second.plist")).toBe(true);
    expect(exec.loadedLabels.has("com.akm.task.second")).toBe(true);
    expect(launchdMutationCalls(exec.calls)).toEqual([]);
  });

  test("whole-set transaction preparation reports an affected loaded-only artifact before mutation", async () => {
    const stash = sandboxStashDir();
    try {
      const tasksDir = path.join(stash.dir, "tasks");
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(path.join(tasksDir, "ping.yml"), 'version: 4\nrun: echo ping\nschedule: "0 9 * * *"\n', "utf8");
      activateTask(stash.dir);
      const { backend, exec, fs: launchdFs } = makeBackend();
      exec.loadedLabels.add("com.akm.task.ping");
      exec.calls.length = 0;

      // This is the only configured bundle, so the unscoped sync reports
      // the failure on an otherwise-empty plan instead of throwing.
      const result = await akmTasksSync({ backend });
      expect(result.installed).toEqual([]);
      expect(result.updated).toEqual([]);
      expect(
        result.failures.some((failure) => /owner|collision|artifact|scheduler|existing/i.test(failure.reason)),
      ).toBe(true);
      expect(launchdFs.written.size).toBe(0);
      expect(exec.loadedLabels.has("com.akm.task.ping")).toBe(true);
      expect(launchdMutationCalls(exec.calls)).toEqual([]);
    } finally {
      stash.cleanup();
    }
  });

  test("rollback rejects a case-equivalent enabled loaded-only service after removing the exact owner", () => {
    const { backend, exec, fs } = makeBackend();
    const prior = qualifiedTask("0 9 * * *");
    backend.install(prior);
    const snapshot = backend.snapshotBindings?.(["ping"]);
    backend.uninstall("ping");
    exec.loadedLabels.add("com.akm.task.PING");
    exec.calls.length = 0;
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
              bindingId: prior.id,
              invocation: prior.invocation,
              fingerprint: backend.expectedSignature?.(prior),
            },
          ],
        },
      ]),
    ).toThrow(/restore|rollback|cardinality|duplicate|collision|exactly one/i);
    expect(fs.written.has("/tmp/agents/com.akm.task.ping.plist")).toBe(false);
    expect(exec.loadedLabels.has("com.akm.task.PING")).toBe(true);
    expect(launchdMutationCalls(exec.calls)).toEqual([]);
  });

  test("rollback rejects a case-equivalent enabled loaded-only peer beside a transaction-created owner", () => {
    const { backend, exec, fs } = makeBackend();
    const owned = qualifiedTask("0 9 * * *");
    const snapshot = backend.snapshotBindings?.(["ping"]);
    backend.install(owned);
    exec.loadedLabels.add("com.akm.task.PING");
    exec.calls.length = 0;
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
              bindingId: owned.id,
              invocation: owned.invocation,
              fingerprint: backend.expectedSignature?.(owned),
            },
          ],
        },
      ]),
    ).toThrow(/restore|rollback|cardinality|duplicate|collision|exactly one/i);
    expect(fs.written.has("/tmp/agents/com.akm.task.ping.plist")).toBe(true);
    expect(exec.loadedLabels.has("com.akm.task.PING")).toBe(true);
    expect(launchdMutationCalls(exec.calls)).toEqual([]);
  });

  test("rollback fails closed before mutation when the loaded launchd domain cannot be enumerated", () => {
    const { backend, exec, fs } = makeBackend();
    const prior = qualifiedTask("0 9 * * *");
    backend.install(prior);
    const snapshot = backend.snapshotBindings?.(["ping"]);
    backend.uninstall("ping");
    exec.domainPrintResults = [{ status: 5, stdout: "", stderr: "injected domain print failure" }];
    exec.calls.length = 0;
    const restore = backend.restoreBindings as unknown as (
      snapshot: unknown,
      guards: readonly Record<string, unknown>[],
    ) => void;

    let caught: unknown;
    try {
      restore(snapshot, [
        {
          nativeId: "ping",
          allowed: [
            { state: "absent" },
            {
              state: "present",
              bindingId: prior.id,
              invocation: prior.invocation,
              fingerprint: backend.expectedSignature?.(prior),
            },
          ],
        },
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(1);
    expect(String(caught)).toMatch(/restore|rollback|enumerat|domain|launchctl|inventory/i);
    expect(fs.written.has("/tmp/agents/com.akm.task.ping.plist")).toBe(false);
    expect(launchdMutationCalls(exec.calls)).toEqual([]);
  });

  test("rollback fails closed when loaded launchd domain membership changes between the preflight and immediate scans", () => {
    const { backend, exec, fs } = makeBackend();
    const prior = qualifiedTask("0 9 * * *");
    backend.install(prior);
    const snapshot = backend.snapshotBindings?.(["ping"]);
    backend.uninstall("ping");
    exec.domainPrintResults = [
      { status: 0, stdout: launchdDomainPrint([]), stderr: "" },
      { status: 0, stdout: launchdDomainPrint(["com.akm.task.PING"]), stderr: "" },
    ];
    exec.calls.length = 0;
    const restore = backend.restoreBindings as unknown as (
      snapshot: unknown,
      guards: readonly Record<string, unknown>[],
    ) => void;

    let caught: unknown;
    try {
      restore(snapshot, [
        {
          nativeId: "ping",
          allowed: [
            { state: "absent" },
            {
              state: "present",
              bindingId: prior.id,
              invocation: prior.invocation,
              fingerprint: backend.expectedSignature?.(prior),
            },
          ],
        },
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(1);
    expect(String(caught)).toMatch(/restore|rollback|changed|stable|domain|inventory/i);
    expect(fs.written.has("/tmp/agents/com.akm.task.ping.plist")).toBe(false);
    expect(launchdMutationCalls(exec.calls)).toEqual([]);
  });

  test("rollback fails closed when launchd plist state changes between the preflight and immediate scans", () => {
    const { backend, exec, fs } = makeBackend();
    const owned = qualifiedTask("0 9 * * *");
    const snapshot = backend.snapshotBindings?.(["ping"]);
    backend.install(owned);
    const file = "/tmp/agents/com.akm.task.ping.plist";
    const raced = fs.readFile(file).replace("<integer>9</integer>", "<integer>7</integer>");
    const run = exec.run.bind(exec);
    let domainPasses = 0;
    exec.run = (args) => {
      const result = run(args);
      if (args[1] === "print" && args[2] === "gui/501" && ++domainPasses === 2) fs.writeFile(file, raced);
      return result;
    };
    exec.calls.length = 0;
    const restore = backend.restoreBindings as unknown as (
      snapshot: unknown,
      guards: readonly Record<string, unknown>[],
    ) => void;

    let caught: unknown;
    try {
      restore(snapshot, [
        {
          nativeId: "ping",
          allowed: [
            { state: "absent" },
            {
              state: "present",
              bindingId: owned.id,
              invocation: owned.invocation,
              fingerprint: backend.expectedSignature?.(owned),
            },
          ],
        },
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(1);
    expect(String(caught)).toMatch(/restore|rollback|changed|stable|domain|inventory/i);
    expect(fs.readFile(file)).toBe(raced);
    expect(launchdMutationCalls(exec.calls)).toEqual([]);
  });

  test("rollback preflight preserves a loaded-only peer and leaves every independent entry untouched", () => {
    const { backend, exec, fs } = makeBackend();
    const ping = qualifiedTask("0 9 * * *");
    const second = qualifiedTask("15 9 * * *", "second");
    backend.install(ping);
    backend.install(second);
    const snapshot = backend.snapshotBindings?.(["ping", "second"]);
    backend.uninstall("ping");
    backend.uninstall("second");
    exec.loadedLabels.add("com.akm.task.PING");
    exec.calls.length = 0;
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
    ).toThrow(/restore|rollback|cardinality|duplicate|collision|exactly one/i);
    expect(fs.written.has("/tmp/agents/com.akm.task.ping.plist")).toBe(false);
    expect(exec.loadedLabels.has("com.akm.task.PING")).toBe(true);
    expect(fs.written.has("/tmp/agents/com.akm.task.second.plist")).toBe(false);
    expect(exec.loadedLabels.has("com.akm.task.second")).toBe(false);
    expect(launchdMutationCalls(exec.calls)).toEqual([]);
  });

  test("rollback preflight rejects a duplicate launchd key before restoring any independent entry", () => {
    const { backend, exec, fs } = makeBackend();
    const ping = qualifiedTask("0 9 * * *");
    const second = qualifiedTask("15 9 * * *", "second");
    const snapshot = backend.snapshotBindings?.(["ping", "second"]);
    backend.install(ping);
    backend.install(second);
    const pingFile = "/tmp/agents/com.akm.task.ping.plist";
    const duplicate = "/tmp/agents/com.akm.task.PING.plist";
    const secondFile = "/tmp/agents/com.akm.task.second.plist";
    fs.writeFile(duplicate, fs.readFile(pingFile));
    exec.calls.length = 0;
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
    ).toThrow(/restore|rollback|cardinality|duplicate|collision|exactly one/i);
    expect(fs.written.has(pingFile)).toBe(true);
    expect(fs.written.has(duplicate)).toBe(true);
    expect(fs.written.has(secondFile)).toBe(true);
    expect(launchdMutationCalls(exec.calls)).toEqual([]);
  });

  test("binding snapshots preserve a plist whose service was unloaded", () => {
    const { backend, exec, fs } = makeBackend();
    backend.install(makeTask("0 9 * * *"));
    exec.loadedLabels.delete("com.akm.task.ping");
    const file = "/tmp/agents/com.akm.task.ping.plist";
    const priorPlist = fs.readFile(file);
    const snapshot = backend.snapshotBindings?.(["ping"]);

    backend.install(makeTask("30 10 * * *"));
    backend.restoreBindings?.(snapshot);

    expect(fs.readFile(file)).toBe(priorPlist);
    expect(exec.loadedLabels.has("com.akm.task.ping")).toBe(false);
  });

  test.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, true],
  ] as const)("snapshot restore preserves prior enabled=%s loaded=%s after replacement enabled=%s in strict order", (priorEnabled, priorLoaded, replacementEnabled) => {
    const events: string[] = [];
    const exec = makeFakeExec(events);
    const fakeFs = makeFakeFs(events);
    const { backend } = makeBackend(exec, fakeFs);
    backend.install({ ...makeTask("0 9 * * *"), enabled: priorEnabled });
    if (!priorLoaded) exec.loadedLabels.delete("com.akm.task.ping");
    const file = "/tmp/agents/com.akm.task.ping.plist";
    const priorPlist = fakeFs.readFile(file);
    const snapshot = backend.snapshotBindings?.(["ping"]);

    backend.install({ ...makeTask("30 10 * * *"), enabled: replacementEnabled });
    events.length = 0;
    backend.restoreBindings?.(snapshot);

    expect(fakeFs.readFile(file)).toBe(priorPlist);
    expect(exec.loadedLabels.has("com.akm.task.ping")).toBe(priorLoaded);
    expect(exec.disabledLabels.has("com.akm.task.ping")).toBe(!priorEnabled);
    expect(events).toEqual([
      ...LAUNCHD_INSPECTION_EVENTS,
      ...LAUNCHD_INSPECTION_EVENTS,
      "exec:bootout",
      `write:${file}`,
      ...(priorLoaded ? ["exec:enable", "exec:bootstrap"] : []),
      `exec:${priorEnabled ? "enable" : "disable"}`,
    ]);
  });

  test("snapshot restore removes a replacement that was absent and leaves it unloaded", () => {
    const events: string[] = [];
    const exec = makeFakeExec(events);
    const fakeFs = makeFakeFs(events);
    const { backend } = makeBackend(exec, fakeFs);
    const snapshot = backend.snapshotBindings?.(["absent"]);
    backend.install({ ...makeTask("0 9 * * *", "absent"), enabled: false });
    events.length = 0;

    backend.restoreBindings?.(snapshot);

    expect(fakeFs.written.has("/tmp/agents/com.akm.task.absent.plist")).toBe(false);
    expect(exec.loadedLabels.has("com.akm.task.absent")).toBe(false);
    expect(exec.disabledLabels.has("com.akm.task.absent")).toBe(false);
    expect(events).toEqual([
      ...LAUNCHD_INSPECTION_EVENTS,
      ...LAUNCHD_INSPECTION_EVENTS,
      "exec:bootout",
      "remove:/tmp/agents/com.akm.task.absent.plist",
      "exec:enable",
    ]);
  });

  test("snapshot restore continues after an apply-phase failure once the global preflight is clean", () => {
    const exec = makeFakeExec();
    const fakeFs = makeFakeFs();
    const { backend } = makeBackend(exec, fakeFs);
    backend.install({ ...makeTask("0 9 * * *", "first"), enabled: false });
    backend.install({ ...makeTask("15 9 * * *", "second"), enabled: true });
    const firstFile = "/tmp/agents/com.akm.task.first.plist";
    const secondFile = "/tmp/agents/com.akm.task.second.plist";
    const firstPrior = fakeFs.readFile(firstFile);
    const secondPrior = fakeFs.readFile(secondFile);
    const snapshot = backend.snapshotBindings?.(["first", "second"]);
    backend.install(makeTask("30 10 * * *", "first"));
    backend.install({ ...makeTask("45 10 * * *", "second"), enabled: false });

    const run = exec.run.bind(exec);
    let failed = false;
    exec.run = (args) => {
      if (!failed && args[1] === "bootout" && args[2]?.endsWith(".first")) {
        failed = true;
        return { status: 5, stdout: "", stderr: "injected first restore failure" };
      }
      return run(args);
    };

    let caught: unknown;
    try {
      backend.restoreBindings?.(snapshot);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(1);
    expect(fakeFs.readFile(firstFile)).not.toBe(firstPrior);
    expect(fakeFs.readFile(secondFile)).toBe(secondPrior);
    expect(exec.loadedLabels.has("com.akm.task.second")).toBe(true);
    expect(exec.disabledLabels.has("com.akm.task.second")).toBe(false);
  });

  test("uninstall compensates to the exact prior state after bootout fails", () => {
    const transaction = makeTransactionalBackend();
    transaction.backend.install({ ...makeTask("0 9 * * *"), enabled: false });
    const plistPath = "/tmp/agents/com.akm.task.ping.plist";
    const priorPlist = transaction.fs.readFile(plistPath);
    transaction.calls.length = 0;
    transaction.failNext("bootout");

    expect(() => transaction.backend.uninstall("ping")).toThrow("injected bootout failure");

    expect(launchdMutationCalls(transaction.calls)).toEqual([
      ["launchctl", "bootout", "gui/501/com.akm.task.ping"],
      ["launchctl", "bootout", "gui/501/com.akm.task.ping"],
      ["launchctl", "enable", "gui/501/com.akm.task.ping"],
      ["launchctl", "bootstrap", "gui/501", "/tmp/agents/com.akm.task.ping.plist"],
      ["launchctl", "disable", "gui/501/com.akm.task.ping"],
    ]);
    expect(transaction.fs.readFile(plistPath)).toBe(priorPlist);
    expect(transaction.disabledLabels.has("com.akm.task.ping")).toBe(true);
  });

  test.each([
    [true, true, "enable"],
    [false, false, "enable"],
    [true, false, "delete"],
    [false, true, "delete"],
  ] as const)("uninstall compensates exact prior enabled=%s loaded=%s state when %s fails", (priorEnabled, priorLoaded, failure) => {
    const transaction = makeTransactionalBackend();
    transaction.backend.install({ ...makeTask("0 9 * * *"), enabled: priorEnabled });
    const plistPath = "/tmp/agents/com.akm.task.ping.plist";
    const priorPlist = transaction.fs.readFile(plistPath);
    if (!priorLoaded) {
      transaction.exec.run(["launchctl", "bootout", "gui/501/com.akm.task.ping"]);
    }
    transaction.calls.length = 0;
    if (failure === "enable") {
      transaction.failNext("enable");
    } else {
      const removeFile = transaction.fs.removeFile.bind(transaction.fs);
      let failed = false;
      transaction.fs.removeFile = (file) => {
        if (!failed && file === plistPath) {
          failed = true;
          throw new Error("injected delete failure");
        }
        removeFile(file);
      };
    }

    expect(() => transaction.backend.uninstall("ping")).toThrow(`injected ${failure} failure`);

    expect(transaction.fs.readFile(plistPath)).toBe(priorPlist);
    expect(transaction.activePlist()).toBe(priorLoaded ? priorPlist : undefined);
    expect(transaction.disabledLabels.has("com.akm.task.ping")).toBe(!priorEnabled);
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
    expect(backend.listNativeArtifacts?.()).toEqual([{ nativeId: "ping" }]);
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
      writeSchedulerContextDescriptor(schedulerContextDescriptor(resolveScheduledTaskContext(), ""));
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
      writeSchedulerContextDescriptor(schedulerContextDescriptor(resolveScheduledTaskContext(), ""));
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
