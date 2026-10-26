// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The OpenCode binary akm's own agent runtime runs, fetched on first use.
 *
 * OpenCode 2 is published as a prebuilt binary on npm: `@opencode/cli`, whose
 * platform packages each hold one executable. akm does not depend on that
 * package: the package manager would install every platform package that matches
 * the OS and CPU (four, for Linux x64, about 900 MB), because none of them
 * declares its libc or CPU features. akm fetches the one that matches this
 * machine from the npm registry the first time its runtime is used, checks it
 * against the registry's integrity hash, and keeps the executable under
 * `<akm cache dir>/opencode/<version>/`. Package selection mirrors the
 * `postinstall.mjs` of `@opencode/cli`.
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fetchWithRetry, isRecord, toErrorMessage } from "../../../../core/common";
import { getCacheDir } from "../../../../core/paths";
import { info } from "../../../../core/warn";
import { writeResponseToFileCapped } from "../../../../runtime";
import { extractTarGzMember } from "./tar";

/**
 * The OpenCode release akm's own runtime runs. It is pinned because the runtime depends on things no OpenCode release
 * promises: the inline config's shape, the `--standalone` flag, the plugin API, the text `run` prints, and the
 * `opencode.db` tables that `../session-log-v2.ts` reads. To move it, change this version and `PACKAGES` if the release
 * adds or drops a platform package, then run `tests/integration/opencode-runtime.test.ts` against the new binary
 * (it fetches it) and read `docs/reference/configuration.md` ("akm's own runtime") for what the version changes.
 */
export const OPENCODE_RUNTIME_VERSION = "2.1.4";

const REGISTRY = "https://registry.npmjs.org";

/** The platform packages of `@opencode/cli` at {@link OPENCODE_RUNTIME_VERSION}. */
const PACKAGES: ReadonlySet<string> = new Set([
  "@opencode/cli-linux-x64",
  "@opencode/cli-linux-x64-baseline",
  "@opencode/cli-linux-x64-musl",
  "@opencode/cli-linux-x64-baseline-musl",
  "@opencode/cli-linux-arm64",
  "@opencode/cli-linux-arm64-musl",
  "@opencode/cli-darwin-x64",
  "@opencode/cli-darwin-x64-baseline",
  "@opencode/cli-darwin-arm64",
  "@opencode/cli-windows-x64",
  "@opencode/cli-windows-x64-baseline",
  "@opencode/cli-windows-arm64",
]);

/** What decides which package runs on a machine. */
export interface HostTraits {
  readonly platform: "linux" | "darwin" | "windows";
  readonly arch: "x64" | "arm64";
  /** Linux with musl libc (Alpine). */
  readonly musl: boolean;
  /** An x64 CPU with AVX2; without it the baseline build runs. */
  readonly avx2: boolean;
}

/** The package for a machine: `@opencode/cli-<platform>-<arch>`, with `-baseline` for an x64 CPU without AVX2 and `-musl` for musl. */
export function opencodePackage({ platform, arch, musl, avx2 }: HostTraits): string {
  const name = [
    `@opencode/cli-${platform}-${arch}`,
    ...(arch === "x64" && !avx2 ? ["baseline"] : []),
    ...(platform === "linux" && musl ? ["musl"] : []),
  ].join("-");
  if (!PACKAGES.has(name)) {
    throw new Error(`OpenCode ${OPENCODE_RUNTIME_VERSION} publishes no binary for ${platform} ${arch} (${name}).`);
  }
  return name;
}

function run(command: string, args: string[], timeout: number): SpawnSyncReturns<string> {
  return spawnSync(command, args, { encoding: "utf8", timeout, windowsHide: true });
}

const AVX2_WINDOWS_PROBE =
  '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)';

/** Whether an x64 CPU has AVX2, asked the way OpenCode's own installer asks it. */
function hasAvx2(platform: HostTraits["platform"]): boolean {
  try {
    if (platform === "linux") return /(^|\s)avx2(\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"));
    if (platform === "darwin") {
      const probe = run("sysctl", ["-n", "hw.optional.avx2_0"], 1500);
      return probe.status === 0 && probe.stdout.trim() === "1";
    }
    for (const shell of ["powershell.exe", "pwsh.exe", "pwsh", "powershell"]) {
      const probe = run(shell, ["-NoProfile", "-NonInteractive", "-Command", AVX2_WINDOWS_PROBE], 3000);
      if (probe.status !== 0) continue;
      const answer = probe.stdout.trim().toLowerCase();
      if (answer === "true" || answer === "1") return true;
      if (answer === "false" || answer === "0") return false;
    }
  } catch {
    // Not knowing is the baseline build, which runs everywhere.
  }
  return false;
}

/** Whether this Linux uses musl libc. */
function isMusl(): boolean {
  if (fs.existsSync("/etc/alpine-release")) return true;
  const probe = run("ldd", ["--version"], 5000);
  return `${probe.stdout ?? ""}${probe.stderr ?? ""}`.toLowerCase().includes("musl");
}

/** This machine, as the package choice sees it. */
export function detectHost(
  env: NodeJS.ProcessEnv = process.env,
  operatingSystem: NodeJS.Platform = process.platform,
  processArch: string = process.arch,
): HostTraits {
  const platform = ({ darwin: "darwin", linux: "linux", win32: "windows" } as const)[
    operatingSystem as "darwin" | "linux" | "win32"
  ];
  const nodeArch = ({ x64: "x64", arm64: "arm64" } as const)[processArch as "x64" | "arm64"];
  if (!platform || !nodeArch) throw new Error(`OpenCode publishes no binary for ${operatingSystem} ${processArch}.`);
  // An x64 process on Windows for ARM still names the host CPU in PROCESSOR_IDENTIFIER, and the arm64 build is the one to run.
  const arch =
    platform === "windows" && nodeArch === "x64" && env.PROCESSOR_IDENTIFIER?.startsWith("ARM") ? "arm64" : nodeArch;
  return { platform, arch, musl: platform === "linux" && isMusl(), avx2: arch === "x64" && hasAvx2(platform) };
}

/** Where the OpenCode binary is kept once fetched. */
export function runtimeBinaryPath(platform: NodeJS.Platform = process.platform): string {
  return path.join(
    getCacheDir(),
    "opencode",
    OPENCODE_RUNTIME_VERSION,
    platform === "win32" ? "opencode.exe" : "opencode",
  );
}

/** The `sha512-<base64>` integrity npm records for a tarball. */
function sha512Integrity(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha512");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(`sha512-${hash.digest("base64")}`));
  });
}

/** Throws unless the tarball at `file` has the integrity the registry lists for it. */
export async function verifyIntegrity(file: string, expected: string): Promise<void> {
  const listed = expected.split(/\s+/).filter((integrity) => integrity.startsWith("sha512-"));
  if (listed.length === 0) throw new Error(`the registry lists no sha512 integrity for it (${expected || "none"})`);
  const actual = await sha512Integrity(file);
  if (!listed.includes(actual))
    throw new Error(`its sha512 integrity is ${actual}, not the ${listed.join(" or ")} the registry lists`);
}

async function registryDocument(url: string): Promise<{ tarball: string; integrity: string }> {
  const response = await fetchWithRetry(url, { headers: { accept: "application/json" } }, { timeout: 30_000 });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`the registry answered HTTP ${response.status}`);
  }
  const dist = ((await response.json()) as { dist?: unknown }).dist;
  if (!isRecord(dist) || typeof dist.tarball !== "string" || typeof dist.integrity !== "string") {
    throw new Error("the registry document has no dist.tarball and dist.integrity");
  }
  return { tarball: dist.tarball, integrity: dist.integrity };
}

/**
 * Fetch the binary of the package `name` into `binary`: the registry document of that one package, its tarball, the
 * integrity check before anything is extracted, then the executable by temp file and rename. Two akm processes fetching
 * at once both finish: a rename that loses to the other leaves the file the other made.
 */
async function fetchBinary(name: string, binary: string): Promise<void> {
  const directory = path.dirname(binary);
  fs.mkdirSync(directory, { recursive: true });
  const download = path.join(directory, `.download-${process.pid}.tgz`);
  const partial = path.join(directory, `.opencode-${process.pid}.tmp`);
  try {
    const { tarball, integrity } = await registryDocument(`${REGISTRY}/${name}/${OPENCODE_RUNTIME_VERSION}`);
    info(
      `Fetching OpenCode ${OPENCODE_RUNTIME_VERSION} for akm's own agent runtime (about 114 MB, once) into ${directory}.`,
    );
    const response = await fetchWithRetry(tarball, undefined, { timeout: 60_000 });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${tarball} answered HTTP ${response.status}`);
    }
    await writeResponseToFileCapped(download, response);
    await verifyIntegrity(download, integrity);
    const size = await extractTarGzMember(download, `package/bin/${path.basename(binary)}`, partial);
    fs.chmodSync(partial, 0o755);
    try {
      fs.renameSync(partial, binary);
    } catch (error) {
      // Where an open executable cannot be replaced, the other process's file stands.
      if (!fs.existsSync(binary) || fs.statSync(binary).size !== size) throw error;
    }
  } finally {
    fs.rmSync(download, { force: true });
    fs.rmSync(partial, { force: true });
  }
}

/** Fetch the binary for this machine, naming the package, its URL and the cache path when it cannot. */
async function fetchForThisMachine(binary: string): Promise<string> {
  let name = "an @opencode/cli platform package";
  try {
    name = opencodePackage(detectHost());
    await fetchBinary(name, binary);
    return binary;
  } catch (error) {
    throw new Error(
      `Could not fetch OpenCode ${OPENCODE_RUNTIME_VERSION}, which akm's own agent runtime runs: package ${name} from ${REGISTRY}/${name}/${OPENCODE_RUNTIME_VERSION} into ${path.dirname(binary)}: ${toErrorMessage(error)}. ` +
        "Without network access for this step, enable the opencode harness with an installed OpenCode 2 instead (see docs/reference/configuration.md).",
    );
  }
}

let fetching: Promise<string> | undefined;

/**
 * The path of the OpenCode binary akm's runtime runs, fetched first if it is not in the cache. A process fetches once,
 * however many runs ask meanwhile.
 */
export function ensureRuntimeBinary(): Promise<string> {
  const binary = runtimeBinaryPath();
  if (fs.existsSync(binary)) return Promise.resolve(binary);
  fetching ??= fetchForThisMachine(binary).finally(() => {
    fetching = undefined;
  });
  return fetching;
}
