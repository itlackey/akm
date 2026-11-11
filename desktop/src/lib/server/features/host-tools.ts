// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "jsonc-parser";

type Env = NodeJS.ProcessEnv;
// Native CLI output is untyped JSON; each reader below checks the fields it uses.
// biome-ignore lint/suspicious/noExplicitAny: parsed output of host commands
type Loose = any;
type Run = (file: string, args: string[], options: { env?: Env; home?: string; timeout?: number }) => Promise<string>;
type Find = (name: string, env?: Env) => Promise<string | undefined>;
export interface PluginState {
  state: "installed" | "disabled" | "missing" | "configured" | "unknown";
  version?: string;
  note?: string;
  spec?: string;
  file?: string;
  /** Why a plugin could not be verified: the underlying error, for the Details line. */
  detail?: string;
}
export interface Detected {
  id: string;
  installed: boolean;
  path?: string;
  version?: string;
  runnable?: boolean;
  plugin?: PluginState;
  major?: number;
}
/** The lifecycle fields of an `akm upgrade` result, never its migration or file payloads. */
export interface UpgradeSummary {
  currentVersion?: string;
  latestVersion?: string;
  newVersion?: string;
  updateAvailable?: boolean;
  upgraded?: boolean;
  installMethod?: string;
  channel?: string;
  currentChannel?: string;
  targetChannel?: string;
  /** Each harness plugin akm found: the channel it follows (`latest`, `next`, `pinned`, `unknown`) and what the run did. */
  plugins?: Array<{ harness: string; channel?: string; outcome?: string; reason?: string }>;
  /** Why the CLI is held below the newest release (an OpenCode plugin's pin), when akm says so. */
  lockstep?: { heldBack?: boolean; plugin?: string; pinnedVersion?: string; newestVersion?: string; reason?: string };
  /** The status of the migration the upgrade ran: `current`, `applied`, `blocked`, `failed`, and so on. */
  migration?: string;
  postUpgradeFailed?: boolean;
}
export interface StartOptions {
  within?: (version: string | undefined) => boolean | undefined;
  /** The person agreed to replace what is there (the CLI binary) or to use what is there (an existing marketplace). */
  consent?: boolean;
}
export interface HostState {
  phase: string;
  cli: Detected | null;
  /** Where Install AKM CLI puts akm, as the person would write it. */
  cliDirectory: string;
  /** The Claude Code and Codex plugin hooks run on Bun (`bun akm-hook.ts`); the standalone akm CLI does not provide it. */
  bun: (Detected & { installCommand: string }) | null;
  harnesses: Detected[];
  checkedAt?: string;
  /** What went wrong, in words for the person using the app. */
  error?: string;
  /** The underlying cause (message and the command's stderr tail), shown under Details. */
  errorDetail?: string;
  receipt?: string;
  command?: string;
  upgrade?: UpgradeSummary;
  /** The last action's own command and result, kept apart from the check that follows it. */
  action?: { command: string; upgrade?: UpgradeSummary };
  /** Where Install AKM CLI would put akm is where the detected akm is, so Desktop may repair it with consent. */
  cliManaged?: boolean;
  /** What waits for the person's consent (`cli` or a harness id) after its action stopped to ask. */
  consent?: string;
  /** An action that timed out: its outcome is unknown until a check confirms it, and no other action may start. */
  unsettled?: string;
}

// The harness plugin-install recipe (plugin id, marketplace and channel syntax, OpenCode v1/v2 shapes) is kept here on
// purpose, with no akm surface. The source of truth is akm's src/commands/sources/plugin-channels.ts and
// plugin-upgrade.ts: change them together.
const pluginId = "akm@akm-plugins";
// OpenCode 1 and 2 are the same `opencode` program; its `--version` says which plugin it takes.
export const harnessIds = ["claude", "codex", "opencode"];
/** Bun's own installer, shown for the person to run: Desktop never runs it. https://bun.sh/docs/installation */
export const bunInstallCommand = (platform: string) =>
  platform === "win32" ? 'powershell -c "irm bun.sh/install.ps1 | iex"' : "curl -fsSL https://bun.sh/install | bash";
/**
 * Where the release installer puts akm for Desktop: `~/.local/bin` on Linux and macOS, and on Windows install.ps1's own
 * default, `%LOCALAPPDATA%\akm`, which it also adds to the user's PATH.
 */
function cliDirectory(platform: string, env: Env, home: string) {
  return platform === "win32"
    ? { path: path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "akm"), shown: "%LOCALAPPDATA%\\akm" }
    : { path: path.join(home, ".local/bin"), shown: "~/.local/bin" };
}
const versionOf = (text: string | undefined) => text?.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?/)?.[0];
class SoftwareError extends Error {}

export async function hostEnvironment(
  env: Env = process.env,
  home = os.homedir(),
  platform: string = process.platform,
) {
  const next = { ...env };
  // Electron's Node child uses a launcher for bundled workspace commands.
  // Never pass it (or the private session) to the real host CLI/harnesses.
  for (const key of Object.keys(next))
    if (/^AKM_(?:LAUNCHER_|DESKTOP_)/.test(key) || ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH"].includes(key))
      delete next[key];
  const paths = (next.PATH ?? "").split(path.delimiter).filter((item) => path.isAbsolute(item));
  const extra = [".local/bin", ".bun/bin", ".opencode/bin"].map((item) => path.join(home, item));
  if (platform === "win32") extra.push(cliDirectory(platform, next, home).path);
  try {
    const nvm = path.join(next.NVM_DIR || path.join(home, ".nvm"), "versions/node");
    const versions = (await readdir(nvm))
      .filter((item) => /^v\d+\.\d+\.\d+$/.test(item))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    extra.push(...versions.map((item) => path.join(nvm, item, "bin")));
  } catch {
    /* NVM is optional; do not run shell startup files. */
  }
  next.PATH = [...new Set([...paths, ...extra])].join(path.delimiter);
  return next;
}

export const findProgram: Find = async (name, env = process.env) => {
  // Windows programs carry their extension; akm and Bun install as .exe there.
  const names = process.platform === "win32" ? [`${name}.exe`, name] : [name];
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter((item) => path.isAbsolute(item))) {
    for (const file of names.map((item) => path.join(directory, item))) {
      try {
        await access(file, constants.X_OK);
        return file;
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined;
};

/** Kill a command and everything it started: its process group (POSIX) or tree (Windows). */
function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (process.platform === "win32")
      execFile(
        path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
        ["/pid", String(pid), "/T", "/F"],
        { windowsHide: true },
      );
    else process.kill(-pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * `--next` is Deprecated in the CLI and prints one deprecation line on stderr. It is not the same as `--channel next`
 * (that switches the installed plugins too) and the host CLI may be older, so keep `--next` and silence the notice.
 */
const quietNext = (flags: readonly string[]): string[] => (flags.includes("--next") ? ["--quiet"] : []);

export const runHost: Run = (file, args, { env, home, timeout = 30_000 }) =>
  new Promise((resolve, reject) => {
    // Its own process group on POSIX, so the timeout can end installer children as well as the command itself.
    const child = spawn(file, args, {
      env,
      cwd: home,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stopped: "timeout" | "output" | undefined;
    const stop = (why: typeof stopped) => {
      stopped ??= why;
      killTree(child.pid);
    };
    const timer = setTimeout(() => stop("timeout"), timeout);
    const collect = (kind: "stdout" | "stderr") => (chunk: string) => {
      if (kind === "stdout") stdout += chunk;
      else stderr += chunk;
      if (stdout.length + stderr.length > 4 * 1024 * 1024) stop("output");
    };
    child.stdout.setEncoding("utf8").on("data", collect("stdout"));
    child.stderr.setEncoding("utf8").on("data", collect("stderr"));
    child.stdin.on("error", () => undefined);
    child.stdin.end(); // Native consent must not hang on an unattended input pipe.
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(Object.assign(error, { stdout, stderr }));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !stopped) return resolve(stdout);
      const error = new Error(`Command failed: ${[file, ...args].join(" ")}`);
      reject(
        Object.assign(error, {
          code: stopped === "timeout" ? "ETIMEDOUT" : stopped === "output" ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" : code,
          killed: Boolean(stopped),
          signal,
          stdout,
          stderr,
        }),
      );
    });
  });

function json(text: string): Loose {
  const value = JSON.parse(text);
  // AKM's normal JSON is the payload; tolerate an explicitly enveloped response.
  if (value?.ok === false) throw new Error("AKM reported a failed operation.");
  return value?.data ?? value;
}

// The same lookup as akm's `openCodeConfigSpec` (src/commands/sources/plugin-upgrade.ts), so Software and `akm upgrade`
// agree on which plugin OpenCode loads: opencode.jsonc before opencode.json, OPENCODE_CONFIG only for OpenCode 1, and
// for OpenCode 1 the first global file that sets the list decides. Unlike akm, a file Desktop cannot read stops the
// check (the plugin shows as unverified) rather than being skipped.
async function openCodePlugin(env: Env, home: string, major: number) {
  const directory =
    env.OPENCODE_CONFIG_DIR?.trim() || path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode");
  const explicit = major === 2 ? undefined : env.OPENCODE_CONFIG?.trim();
  const files = [explicit, path.join(directory, "opencode.jsonc"), path.join(directory, "opencode.json")].filter(
    Boolean,
  );
  const pkg = major === 2 ? "akm-opencode-v2" : "akm-opencode";
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file as string, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const errors: unknown[] = [],
      config = parse(text, errors as never[], { allowTrailingComma: true });
    if (errors.length || !config || typeof config !== "object")
      throw new Error("OpenCode configuration could not be read.");
    let setsList = false;
    for (const key of major === 2 ? ["plugins", "plugin"] : ["plugin"]) {
      if (config[key] !== undefined && !Array.isArray(config[key]))
        throw new Error("OpenCode plugin configuration is not a list.");
      if (config[key] !== undefined) setsList = true;
      for (const entry of config[key] ?? []) {
        const spec = Array.isArray(entry) ? entry[0] : entry;
        if (typeof spec === "string" && (spec === pkg || spec.startsWith(`${pkg}@`))) return { spec, file };
      }
    }
    if (setsList && file !== explicit && major === 1) return undefined;
  }
  return undefined;
}

function errorMessage(error: Loose) {
  if (error instanceof SoftwareError) return error.message;
  if (error?.code === "EACCES" || error?.code === "EPERM")
    return "Permission denied. Use the installer that owns this CLI; Desktop will not use sudo.";
  if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
    return "The command produced too much output and was stopped. Check its native status before retrying.";
  if (error?.killed || error?.code === "ETIMEDOUT")
    return "The command timed out. Check its native status before retrying.";
  return "The native command did not complete successfully. Check the connection and use the command shown in Details for diagnostics.";
}

/** The underlying cause of a failure: its message and the end of the command's stderr, bounded. */
export function errorDetail(error: unknown): string | undefined {
  if (error instanceof SoftwareError) return undefined;
  const cause = error as { message?: unknown; stderr?: unknown };
  const parts = [cause?.message, typeof cause?.stderr === "string" ? cause.stderr.trim().slice(-500) : undefined]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .map((part) => part.trim());
  return parts.length ? [...new Set(parts)].join("\n").slice(0, 1000) : undefined;
}

/** Host lifecycle only. All upgrades/migration/plugin writes are native commands. */
export class HostTools {
  home: string;
  sourceEnv: Env;
  run: Run;
  find: Find;
  fetcher: typeof fetch;
  platform: string;
  desktopVersion?: string;
  state: HostState;
  pending?: Promise<void>;
  constructor({
    home = os.homedir(),
    env = process.env,
    run = runHost,
    find = findProgram,
    fetcher = fetch,
    platform = process.platform,
    desktopVersion = process.env.AKM_DESKTOP_VERSION,
  }: {
    home?: string;
    env?: Env;
    run?: Run;
    find?: Find;
    fetcher?: typeof fetch;
    platform?: string;
    desktopVersion?: string;
  } = {}) {
    this.home = home;
    this.sourceEnv = env;
    this.run = run;
    this.find = find;
    this.fetcher = fetcher;
    this.platform = platform;
    this.desktopVersion = desktopVersion;
    this.state = {
      phase: "idle",
      cli: null,
      cliDirectory: cliDirectory(platform, env, home).shown,
      bun: null,
      harnesses: [],
      checkedAt: undefined,
      error: undefined,
      receipt: undefined,
    };
  }
  snapshot() {
    return structuredClone(this.state);
  }
  async environment() {
    return hostEnvironment(this.sourceEnv, this.home, this.platform);
  }
  async invoke(file: string, args: string[], env: Env, timeout?: number) {
    return this.run(file, args, { env, home: this.home, timeout });
  }
  async detect(name: string, env: Env): Promise<Detected> {
    const file = await this.find(name, env);
    if (!file) return { id: name, installed: false };
    try {
      const version = versionOf(await this.invoke(file, ["--version"], env));
      return { id: name, installed: true, path: file, version, runnable: Boolean(version) };
    } catch {
      return { id: name, installed: true, path: file, runnable: false };
    }
  }
  async inventory(env: Env) {
    const cli = await this.detect("akm", env);
    const bun = { ...(await this.detect("bun", env)), installCommand: bunInstallCommand(this.platform) };
    const harnesses = await Promise.all(
      harnessIds.map(async (id) => {
        const harness = await this.detect(id, env);
        if (!harness.runnable || !harness.path) return harness;
        try {
          if (id === "claude") {
            const list = json(await this.invoke(harness.path, ["plugin", "list", "--json"], env));
            if (!Array.isArray(list)) throw new Error("Unrecognized plugin inventory.");
            const item = list.find((item: Loose) => item.id === pluginId && (!item.scope || item.scope === "user"));
            harness.plugin = item
              ? { state: item.enabled === false ? "disabled" : "installed", version: item.version }
              : { state: "missing" };
          } else if (id === "codex") {
            const list = json(
              await this.invoke(harness.path, ["plugin", "list", "--marketplace", "akm-plugins", "--json"], env),
            );
            if (!Array.isArray(list?.installed)) throw new Error("Unrecognized plugin inventory.");
            const item = list.installed.find((item: Loose) => item.pluginId === pluginId);
            harness.plugin = item
              ? {
                  state: "installed",
                  version: item.version,
                  note: "Review the AKM hooks in Codex /hooks. Installation does not approve them.",
                }
              : { state: "missing" };
          } else {
            const major = Number(harness.version?.split(".")[0]);
            if (![1, 2].includes(major)) throw new Error("Unsupported OpenCode major.");
            const configured = await openCodePlugin(env, this.home, major);
            harness.plugin = configured ? { state: "configured", ...configured } : { state: "missing" };
            harness.major = major;
          }
        } catch (error) {
          harness.plugin = {
            state: "unknown",
            note: "Native inventory could not verify the plugin. Review it in the harness before installing.",
            detail: errorDetail(error),
          };
        }
        return harness;
      }),
    );
    const target = cliDirectory(this.platform, env, this.home).path;
    const file = path.join(target, this.platform === "win32" ? "akm.exe" : "akm");
    // Desktop's own install is a regular file where its installer puts it, and a standalone binary as akm itself reports (so only after a check): a link, or a file akm has not yet reported as a standalone binary, is not Desktop's to replace.
    const stat = await lstat(file).catch(() => undefined);
    const method = this.state.upgrade?.installMethod;
    const cliManaged = cli.path === file && stat?.isFile() === true && method === "binary";
    Object.assign(this.state, { cli, bun, harnesses, cliManaged });
  }
  /**
   * `within` says whether a host release is one Desktop's own engine can still read: true when it is not newer, false
   * when it is, undefined when it is not a version. Without it no release is refused.
   */
  start(action: string, harness?: string, channel = "latest", options: StartOptions = {}) {
    if (
      !["check", "install-cli", "upgrade-cli", "switch-channel", "install-plugin"].includes(action) ||
      (action === "install-plugin" && !harnessIds.includes(harness as string)) ||
      !["latest", "next"].includes(channel)
    )
      throw new Error("Invalid software action.");
    if (this.pending) throw new Error("A software operation is already running.");
    if (action !== "check" && this.state.unsettled)
      throw new Error(
        `The earlier ${this.state.unsettled} was stopped, and its installer may still be running. Use Check CLI & plugins to confirm what it left before trying again.`,
      );
    if (action !== "check" && process.send) process.send({ type: "desktop-host-operation", busy: true });
    this.state.phase = action;
    this.state.error = undefined;
    this.state.errorDetail = undefined;
    this.state.receipt = undefined;
    this.state.command = undefined;
    this.state.consent = undefined;
    this.state.action = undefined;
    // `--next` selects the newest release, prereleases included, for a check and for the upgrade; a switch is explicit.
    const flags = action === "switch-channel" ? ["--channel", channel] : channel === "next" ? ["--next"] : [];
    this.pending = Promise.resolve()
      .then(async () => {
        const env = await this.environment();
        await this.inventory(env);
        if (action === "install-cli") await this.installCli(env, options);
        if (action === "upgrade-cli" || action === "switch-channel") {
          if (!this.state.cli?.runnable || !this.state.cli.path)
            throw new SoftwareError("Install a working CLI first.");
          await this.verifyTarget(env, flags, options.within);
          this.state.command = ["akm upgrade", ...flags, "--format json"].join(" ");
          const upgraded = await this.upgrade(env, flags);
          // Summarize only lifecycle fields, not complete migration/file payloads.
          this.state.upgrade = upgraded;
          this.state.action = { command: this.state.command, upgrade: upgraded };
          this.state.receipt =
            action === "switch-channel"
              ? `Native AKM switched the CLI and installed plugins to the ${channel === "next" ? "prerelease" : "stable"} channel.`
              : "Native AKM upgrade completed. The bundled desktop engine is unchanged.";
        }
        if (action === "install-plugin") await this.installPlugin(harness as string, channel, env, options);
        await this.inventory(env);
        if (this.state.cli?.runnable && this.state.cli.path) {
          const acted = this.state.command;
          // Look again the way the CLI is followed after this action: an explicit switch names its target channel, an
          // upgrade or check keeps its own flag, and a plugin or CLI install changes no CLI channel.
          const check =
            action === "switch-channel"
              ? channel === "next"
                ? ["--next"]
                : []
              : action === "upgrade-cli" || action === "check"
                ? flags
                : [];
          const checked = ["akm upgrade --check", ...check, "--format json"].join(" ");
          this.state.command = checked;
          try {
            const summary = summarizeUpgrade(
              json(
                await this.invoke(
                  this.state.cli.path,
                  ["upgrade", "--check", ...check, ...quietNext(check), "--format", "json"],
                  env,
                  120_000,
                ),
              ),
            );
            this.state.upgrade = summary;
          } catch (error) {
            if (action === "check") throw error;
            // The change itself went through; only looking again failed.
            this.state.error = "The change completed, but checking the result afterwards failed.";
            this.state.errorDetail = errorDetail(error);
            return;
          } finally {
            // A check that follows an action does not replace the command that did the work.
            if (action !== "check" && acted) this.state.command = acted;
          }
        }
        this.state.checkedAt = new Date().toISOString();
        if (action === "check") this.state.unsettled = undefined;
      })
      .catch(async (error) => {
        this.state.error = errorMessage(error);
        this.state.errorDetail = errorDetail(error);
        if (action !== "check" && (error?.killed || error?.code === "ETIMEDOUT")) this.state.unsettled = action;
        // A failed or partial action may still have changed what is installed: show what is there now.
        if (action !== "check")
          await this.environment()
            .then((env) => this.inventory(env))
            .catch(() => undefined);
      })
      .finally(() => {
        this.state.phase = "idle";
        this.pending = undefined;
        if (action !== "check" && process.send) process.send({ type: "desktop-host-operation", busy: false });
      });
    return this.snapshot();
  }
  /** Run `akm upgrade`; a nonzero exit still carries akm's own result, so its lifecycle fields are kept. */
  async upgrade(env: Env, flags: string[]): Promise<UpgradeSummary> {
    let result: Loose;
    try {
      result = json(
        await this.invoke(
          this.state.cli?.path as string,
          ["upgrade", ...flags, ...quietNext(flags), "--format", "json"],
          env,
          30 * 60_000,
        ),
      );
    } catch (error) {
      let partial: UpgradeSummary | undefined;
      try {
        const value = JSON.parse((error as { stdout?: string }).stdout ?? "");
        partial = summarizeUpgrade(value?.data ?? value);
      } catch {
        /* no structured result: the generic message and Details stand */
      }
      if (!partial) throw error;
      this.state.upgrade = partial;
      this.state.action = { command: this.state.command as string, upgrade: partial };
      throw new SoftwareError(upgradeFailure(partial) ?? "AKM's upgrade exited with an error.");
    }
    const summary = summarizeUpgrade(result);
    const failure = upgradeFailure(summary);
    if (failure) {
      this.state.upgrade = summary;
      this.state.action = { command: this.state.command as string, upgrade: summary };
      throw new SoftwareError(failure);
    }
    return summary;
  }
  /**
   * Ask akm which release the upgrade would install, right before it runs, so the guard never rests on an earlier
   * check. A target Desktop cannot read, or one that cannot be verified, stops the upgrade before anything changes.
   */
  async verifyTarget(env: Env, flags: string[], within?: StartOptions["within"]) {
    if (!within || !this.state.cli?.path) return;
    this.state.command = ["akm upgrade --check", ...flags, "--format json"].join(" ");
    let summary: UpgradeSummary;
    try {
      summary = summarizeUpgrade(
        json(
          await this.invoke(
            this.state.cli.path,
            ["upgrade", "--check", ...flags, ...quietNext(flags), "--format", "json"],
            env,
            120_000,
          ),
        ),
      );
    } catch {
      throw new SoftwareError(
        "Could not check which release the update would install, so nothing was changed. Check the connection, then use Check CLI & plugins and try again.",
      );
    }
    this.state.upgrade = summary;
    if (summary.updateAvailable === false) return;
    const allowed = within(summary.latestVersion);
    if (allowed === undefined)
      throw new SoftwareError(
        "The release the update would install could not be verified, so nothing was changed. Use Check CLI & plugins and try again.",
      );
    if (!allowed)
      throw new SoftwareError(
        `Update AKM Desktop first. The CLI would upgrade to ${summary.latestVersion}, past the engine built into this app.`,
      );
  }
  async installCli(env: Env, options: StartOptions) {
    if (!["linux", "darwin", "win32"].includes(this.platform))
      throw new SoftwareError("This build supports host installation on Linux, macOS and Windows.");
    const windows = this.platform === "win32";
    // The official installer verifies the release checksum and installs a
    // standalone binary. No Node/Bun prerequisite, npm-global shadow copy or sudo.
    const target = cliDirectory(this.platform, env, this.home);
    const directory = target.path;
    const targetFile = path.join(directory, windows ? "akm.exe" : "akm");
    const detected = this.state.cli;
    // Never overwrite an install Desktop did not make: one elsewhere belongs to the installer that put it there.
    if (detected?.installed && !this.state.cliManaged)
      throw new SoftwareError(
        `akm is installed at ${detected.path}, not as a standalone binary Desktop put in ${target.shown}. Update or repair it with the installer that owns it (for example your package manager); Desktop will not replace it.`,
      );
    await mkdir(directory, { recursive: true });
    await access(directory, constants.W_OK);
    // A binary already in the install directory (even off PATH, or one that does not run) is replaced only on request.
    const found = await lstat(targetFile).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    });
    if (found && !found.isFile())
      throw new SoftwareError(
        `${targetFile} is a link or not a regular file, so another installer owns it. Desktop will not replace it.`,
      );
    const present = Boolean(found);
    if (present && !options.consent) {
      this.state.consent = "cli";
      throw new SoftwareError(
        `${
          detected?.runnable ? `akm ${detected.version} is` : "An akm that does not run is"
        } already in ${target.shown}. Replacing it installs the release that matches this app. Nothing was changed.`,
      );
    }
    // The installer of Desktop's own release, told that release's tag (it defaults to `latest`), installs the same akm
    // version, so host and engine start equal. A development run keeps desktop/package.json's unstamped 0.0.0, has no
    // release and takes the latest.
    const stamped = this.desktopVersion && this.desktopVersion !== "0.0.0" ? this.desktopVersion : undefined;
    const tag = stamped ? [`v${stamped}`] : [];
    const shown = tag.map((item) => ` ${item}`).join("");
    const release = stamped ? `download/v${stamped}` : "latest/download";
    const script = windows ? "install.ps1" : "install.sh";
    const response = await this.fetcher(`https://github.com/itlackey/akm/releases/${release}/${script}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("Installer download failed.");
    const text = await response.text();
    if (text.length > 128 * 1024 || !text.startsWith(windows ? "#Requires" : "#!/usr/bin/env bash"))
      throw new Error("Unexpected installer.");
    const temporary = await mkdtemp(path.join(os.tmpdir(), "akm-desktop-install-"));
    const file = path.join(temporary, script);
    try {
      await writeFile(file, text, { mode: 0o600 });
      const installEnv = { ...env, AKM_INSTALL_DIR: directory };
      if (windows) {
        // A downloaded script is blocked by the default execution policy; Bypass applies to this one process only.
        this.state.command = `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1${shown} (official release installer)`;
        await this.invoke(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, ...tag],
          installEnv,
          10 * 60_000,
        );
      } else {
        this.state.command = `AKM_INSTALL_DIR="$HOME/.local/bin" bash install.sh${shown} (official release installer)`;
        await this.invoke("/bin/bash", [file, ...tag], installEnv, 10 * 60_000);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    const installed = await this.detect("akm", env);
    if (!installed.runnable) throw new Error("The installed CLI could not report a version.");
    if (stamped && installed.version !== stamped)
      throw new SoftwareError(
        `The installer put akm ${installed.version} in place, not the ${stamped} that matches this app.`,
      );
    this.state.receipt = `AKM CLI installed in ${target.shown}. ${
      windows
        ? "The installer added it to your PATH; open a new terminal to use it."
        : "Add that directory to your terminal PATH if needed; Desktop already finds it."
    }`;
  }
  async installPlugin(id: string, channel: string, env: Env, options: StartOptions) {
    const harness = this.state.harnesses.find((item) => item.id === id);
    if (!harness?.runnable || !harness.path || !this.state.cli?.runnable)
      throw new SoftwareError("Install AKM and the harness first.");
    const harnessPath = harness.path;
    if (harness.plugin?.state !== "missing")
      throw new SoftwareError("The plugin is already present or could not be verified. No change was made.");
    const command = async (args: string[]) => {
      this.state.command = [id, ...args].join(" ");
      await this.invoke(harnessPath, args, env, 180_000);
    };
    let kept = false;
    if (id === "claude" || id === "codex") {
      if (!this.state.bun?.installed)
        throw new SoftwareError("Install Bun first: the AKM hooks use it. No harness configuration was changed.");
      // List first: preserve an existing marketplace's source and release channel.
      const listed = json(await this.invoke(harnessPath, ["plugin", "marketplace", "list", "--json"], env));
      const list = Array.isArray(listed) ? listed : listed?.marketplaces;
      if (!Array.isArray(list)) throw new Error("Unrecognized marketplace inventory.");
      const exists = list.some((item: Loose) => (item.name ?? item.marketplaceName) === "akm-plugins");
      // The marketplace's own channel is its ref, which only an explicit channel switch changes: installing from one that
      // is already there uses that channel, so the prerelease choice is not applied until the person agrees.
      if (exists && channel === "next" && !options.consent) {
        this.state.consent = id;
        throw new SoftwareError(
          "The akm-plugins marketplace is already set up and keeps the channel it follows, so the prerelease choice would not apply to this install. Nothing was changed.",
        );
      }
      kept = exists;
      if (!exists)
        await command([
          "plugin",
          "marketplace",
          "add",
          `itlackey/akm-plugins${id === "claude" && channel === "next" ? "@next" : ""}`,
          ...(id === "codex" && channel === "next" ? ["--ref", "next"] : []),
        ]);
      await command(id === "claude" ? ["plugin", "install", pluginId, "--scope", "user"] : ["plugin", "add", pluginId]);
    } else {
      const pkg = harness.major === 2 ? "akm-opencode-v2" : "akm-opencode";
      await command(
        harness.major === 2 ? ["plugin", "add", `${pkg}@${channel}`] : ["plugin", `${pkg}@${channel}`, "--global"],
      );
    }
    await this.inventory(env);
    const after = this.state.harnesses.find((item) => item.id === id)?.plugin;
    if (!after || !["installed", "configured"].includes(after.state))
      throw new Error("The native installation could not be verified.");
    this.state.receipt =
      (id === "codex"
        ? "AKM installed for Codex. Review its hooks in Codex /hooks to enable automatic recall."
        : "AKM plugin installed. Restart the harness to load it.") +
      (kept ? " The existing akm-plugins marketplace was kept; its channel was not changed." : "");
  }
}

const bounded = (value: unknown) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 200) : undefined;

/** Why an upgrade did not finish, in words, from its summary; undefined when it finished. */
function upgradeFailure(summary: UpgradeSummary): string | undefined {
  const parts = [
    summary.migration === "blocked" || summary.migration === "failed" ? `the migration ${summary.migration}` : "",
    summary.postUpgradeFailed ? "rebuilding the index failed" : "",
    ...(summary.plugins ?? [])
      .filter((item) => item.outcome === "failed")
      .map((item) => `the ${item.harness} plugin failed`),
  ].filter(Boolean);
  return parts.length
    ? `AKM's upgrade did not finish: ${parts.join(", ")}. The versions shown are what is installed now. Use akm upgrade in your terminal to review its diagnostics.`
    : undefined;
}

export function summarizeUpgrade(result: Loose): UpgradeSummary {
  const summary: UpgradeSummary = Object.fromEntries(
    [
      "currentVersion",
      "latestVersion",
      "newVersion",
      "updateAvailable",
      "upgraded",
      "installMethod",
      "channel",
      "currentChannel",
      "targetChannel",
    ]
      .filter((key) => ["string", "boolean"].includes(typeof result?.[key]))
      .map((key) => [key, result[key]]),
  );
  // Which plugin follows which channel and what the run did with it, plus the reason a plugin was deferred or failed:
  // the entries' backups and file paths stay out of the snapshot.
  if (Array.isArray(result?.plugins)) {
    summary.plugins = result.plugins
      .filter((entry: Loose) => typeof entry?.harness === "string")
      .map((entry: Loose) => ({
        harness: entry.harness as string,
        ...(typeof entry.channel === "string" ? { channel: entry.channel as string } : {}),
        ...(typeof entry.outcome === "string" ? { outcome: entry.outcome as string } : {}),
        ...(["deferred", "failed"].includes(entry.outcome) && bounded(entry.message)
          ? { reason: bounded(entry.message) }
          : {}),
      }));
  }
  const lock = result?.lockstep;
  if (lock && typeof lock === "object")
    summary.lockstep = {
      ...(typeof lock.heldBack === "boolean" ? { heldBack: lock.heldBack } : {}),
      ...(typeof lock.plugin === "string" ? { plugin: lock.plugin } : {}),
      ...(typeof lock.pinnedVersion === "string" ? { pinnedVersion: lock.pinnedVersion } : {}),
      ...(typeof lock.newestVersion === "string" ? { newestVersion: lock.newestVersion } : {}),
      ...(bounded(lock.reason) ? { reason: bounded(lock.reason) } : {}),
    };
  if (typeof result?.migration?.status === "string") summary.migration = result.migration.status;
  if (result?.postUpgrade?.ok === false) summary.postUpgradeFailed = true;
  return summary;
}
