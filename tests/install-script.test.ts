import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const INSTALL_SCRIPT = path.join(PROJECT_ROOT, "install.sh");
const BASH_PATH = resolveCommand("bash");
const CHMOD_PATH = resolveCommand("chmod");

const tempRoots: string[] = [];

function resolveCommand(name: string): string {
  const result = spawnSync("bash", ["-lc", `command -v ${name}`], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Unable to resolve command: ${name}`);
  }
  return result.stdout.trim();
}

function writeExecutable(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function addProxy(fakeBin: string, name: string): void {
  const real = resolveCommand(name);
  writeExecutable(`${fakeBin}/${name}`, `#!${BASH_PATH}\nexec ${real} "$@"\n`);
}

interface HarnessOptions {
  osName?: string;
  archName?: string;
  downloader?: "curl" | "wget" | "none";
  checksumMode?: "match" | "missing" | "mismatch";
  installDirWritable?: boolean;
  useSudo?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-install-test-"));
  tempRoots.push(root);

  const fakeBin = path.join(root, "fakebin");
  const installDir = path.join(root, "install-dir");
  const logFile = path.join(root, "requests.log");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });

  addProxy(fakeBin, "mktemp");
  addProxy(fakeBin, "awk");
  addProxy(fakeBin, "chmod");
  addProxy(fakeBin, "mv");
  addProxy(fakeBin, "rm");

  addProxy(fakeBin, "sha256sum");

  const osName = options.osName ?? "Linux";
  const archName = options.archName ?? "x86_64";
  writeExecutable(
    path.join(fakeBin, "uname"),
    `#!${BASH_PATH}
if [ "\${1:-}" = "-s" ]; then
  printf '%s\n' '${osName}'
elif [ "\${1:-}" = "-m" ]; then
  printf '%s\n' '${archName}'
else
  printf '%s\n' '${osName}'
fi
`,
  );

  const downloader = options.downloader ?? "curl";
  const binaryName = `akm-${osName === "Darwin" ? "darwin" : osName === "Linux" ? "linux" : "windows"}-${archName === "x86_64" ? "x64" : archName}`;
  const binaryContent = "fake-akm-binary";
  const binaryHash = createHash("sha256").update(binaryContent).digest("hex");
  const checksumMode = options.checksumMode ?? "match";

  const downloadScript = `#!${BASH_PATH}
set -euo pipefail
outfile=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      outfile="$2"
      shift 2
      ;;
    -qO)
      outfile="$2"
      shift 2
      ;;
    -fsSL|-q)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
printf '%s\n' "$url" >> "${logFile}"
if [[ "$url" == *checksums.txt ]]; then
  case "${checksumMode}" in
    match)
      printf '%s  %s\n' '${binaryHash}' '${binaryName}' > "$outfile"
      ;;
    mismatch)
      printf '%s  %s\n' 'deadbeef' '${binaryName}' > "$outfile"
      ;;
    missing)
      printf '%s  %s\n' '${binaryHash}' 'other-binary' > "$outfile"
      ;;
  esac
else
  printf '%s' '${binaryContent}' > "$outfile"
fi
`;

  if (downloader === "curl") {
    writeExecutable(path.join(fakeBin, "curl"), downloadScript);
  }
  if (downloader === "wget") {
    writeExecutable(path.join(fakeBin, "wget"), downloadScript);
  }

  if (options.useSudo) {
    writeExecutable(
      path.join(fakeBin, "sudo"),
      `#!${BASH_PATH}
set -euo pipefail
printf 'sudo %s\n' "$*" >> "${logFile}"
if [ "$1" = "mv" ]; then
  dest="${installDir}"
  ${CHMOD_PATH} u+w "$dest"
fi
exec "$@"
`,
    );
  }

  if (downloader === "none") {
    // Intentionally do not create curl/wget so command -v fails.
  }

  if (options.installDirWritable === false) {
    fs.chmodSync(installDir, 0o555);
  }

  return {
    root,
    installDir,
    logFile,
    binaryName,
    run: (args: string[] = []) =>
      spawnSync(BASH_PATH, [INSTALL_SCRIPT, ...args], {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: downloader === "none" ? buildPathWithoutDownloaders(fakeBin) : fakeBin,
          AKM_INSTALL_DIR: installDir,
        },
      }),
  };
}

function buildPathWithoutDownloaders(fakeBin: string): string {
  const segments = (process.env.PATH ?? "").split(":").filter(Boolean);
  const filtered = segments.filter((segment) => {
    for (const name of ["curl", "wget"] as const) {
      const candidate = path.join(segment, name);
      if (fs.existsSync(candidate)) {
        return false;
      }
    }
    return true;
  });
  return [fakeBin, ...filtered].join(":");
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("install.sh", () => {
  test("installs the latest linux x64 binary with curl into a custom dir", () => {
    const harness = createHarness();
    const result = harness.run();

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(harness.installDir, "akm"))).toBe(true);
    expect(result.stdout).toContain(`akm installed to ${harness.installDir}/akm`);
    const log = fs.readFileSync(harness.logFile, "utf8");
    expect(log).toContain(`/releases/latest/download/${harness.binaryName}`);
    expect(log).toContain("/releases/latest/download/checksums.txt");
  });

  test("uses wget fallback and pinned tags when curl is unavailable", () => {
    const harness = createHarness({ downloader: "wget" });
    const result = harness.run(["v1.2.3"]);

    expect(result.status).toBe(0);
    const log = fs.readFileSync(harness.logFile, "utf8");
    expect(log).toContain(`/releases/download/v1.2.3/${harness.binaryName}`);
    expect(log).toContain("/releases/download/v1.2.3/checksums.txt");
  });

  test("fails clearly when checksum entry is missing", () => {
    const harness = createHarness({ checksumMode: "missing" });
    const result = harness.run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`checksum not found for ${harness.binaryName}`);
  });

  test("fails clearly on checksum mismatch", () => {
    const harness = createHarness({ checksumMode: "mismatch" });
    const result = harness.run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`checksum verification failed for ${harness.binaryName}`);
  });

  test("fails when no downloader is available", () => {
    const harness = createHarness({ downloader: "none" });
    const result = harness.run();

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("curl or wget is required");
  });

  test("uses sudo mv when install dir is not writable", () => {
    const harness = createHarness({ installDirWritable: false, useSudo: true });
    const result = harness.run();

    expect(result.status).toBe(0);
    const log = fs.readFileSync(harness.logFile, "utf8");
    expect(log).toContain("sudo mv");
    expect(fs.existsSync(path.join(harness.installDir, "akm"))).toBe(true);
  });

  test("prints the Windows install.ps1 guidance on MINGW", () => {
    const harness = createHarness({ osName: "MINGW64_NT" });
    const result = harness.run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("install.ps1");
  });
});
