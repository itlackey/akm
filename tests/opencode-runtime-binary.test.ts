// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The OpenCode binary akm's own runtime runs (`runtime/binary.ts`, with the npm
 * package fetch and tar reader it uses, `core/npm-package.ts`, `core/tar.ts`):
 * which package a machine gets, the integrity check before anything is extracted,
 * the extraction of the members asked for, and the first-use fetch into akm's cache. The
 * registry is a mocked fetch serving a package tarball made with `tar`; the real
 * fetch is exercised by tests/integration/opencode-runtime-sessions.test.ts.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fetchNpmPackageFiles, verifyIntegrity } from "../src/core/npm-package";
import { extractTarGzMembers } from "../src/core/tar";
import {
  detectHost,
  ensureRuntimeBinary,
  type HostTraits,
  OPENCODE_RUNTIME_VERSION,
  opencodePackage,
  runtimeBinaryPath,
} from "../src/integrations/harnesses/opencode/runtime/binary";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
  withMockedFetch,
} from "./_helpers/sandbox";

let storage: IsolatedAkmStorage;
let scratch: SandboxedDir;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  scratch = makeSandboxDir("akm-runtime-binary");
});

afterEach(() => {
  scratch.cleanup();
  storage.cleanup();
});

/** A package tarball as the registry serves one: `package/package.json` and `package/bin/<name>`, made with `tar`. */
function packageTarball(content: Buffer, name = "opencode"): string {
  const root = path.join(scratch.dir, "pack");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "package", "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "package", "package.json"), '{"name":"@opencode/cli-fixture"}\n');
  fs.writeFileSync(path.join(root, "package", "bin", name), content, { mode: 0o755 });
  const archive = path.join(scratch.dir, "fixture.tgz");
  const made = spawnSync("tar", ["-czf", archive, "-C", root, "package"], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`tar failed: ${made.stderr}`);
  return archive;
}

const integrityOf = (file: string): string =>
  `sha512-${createHash("sha512").update(fs.readFileSync(file)).digest("base64")}`;

describe("which package a machine gets", () => {
  const host = (platform: HostTraits["platform"], arch: HostTraits["arch"], musl = false, avx2 = true): HostTraits => ({
    platform,
    arch,
    musl,
    avx2,
  });

  test.each([
    [host("linux", "x64"), "@opencode/cli-linux-x64"],
    [host("linux", "x64", false, false), "@opencode/cli-linux-x64-baseline"],
    [host("linux", "x64", true), "@opencode/cli-linux-x64-musl"],
    [host("linux", "x64", true, false), "@opencode/cli-linux-x64-baseline-musl"],
    [host("linux", "arm64"), "@opencode/cli-linux-arm64"],
    [host("linux", "arm64", true), "@opencode/cli-linux-arm64-musl"],
    // AVX2 matters for x64 only: an arm64 CPU has none and needs no baseline build.
    [host("linux", "arm64", false, false), "@opencode/cli-linux-arm64"],
    [host("darwin", "x64"), "@opencode/cli-darwin-x64"],
    [host("darwin", "x64", false, false), "@opencode/cli-darwin-x64-baseline"],
    [host("darwin", "arm64"), "@opencode/cli-darwin-arm64"],
    [host("windows", "x64"), "@opencode/cli-windows-x64"],
    [host("windows", "x64", false, false), "@opencode/cli-windows-x64-baseline"],
    [host("windows", "arm64"), "@opencode/cli-windows-arm64"],
    // musl is a Linux libc: it changes nothing elsewhere.
    [host("darwin", "arm64", true), "@opencode/cli-darwin-arm64"],
  ])("%j is %s", (traits, expected) => {
    expect(opencodePackage(traits)).toBe(expected);
  });

  test("a machine OpenCode publishes no binary for is refused by name", () => {
    expect(() => opencodePackage(host("darwin", "arm64", false, false))).not.toThrow();
    expect(() => opencodePackage({ platform: "freebsd" as never, arch: "x64", musl: false, avx2: true })).toThrow(
      /publishes no binary for freebsd x64/,
    );
  });

  test("an x64 process on Windows for ARM runs the arm64 build: the host CPU is named in PROCESSOR_IDENTIFIER", () => {
    const arm = { PROCESSOR_IDENTIFIER: "ARMv8 (64-bit) Family 8 Model 1 Revision 0" };
    expect(detectHost(arm, "win32", "x64")).toMatchObject({ platform: "windows", arch: "arm64" });
    expect(detectHost({ PROCESSOR_IDENTIFIER: "Intel64 Family 6 Model 140" }, "win32", "x64")).toMatchObject({
      platform: "windows",
      arch: "x64",
    });
    // The rule is Windows's: an x64 Linux process on an ARM variable is x64.
    expect(detectHost(arm, "linux", "x64")).toMatchObject({ platform: "linux", arch: "x64" });
    expect(() => detectHost({}, "freebsd", "x64")).toThrow(/publishes no binary for freebsd x64/);
  });

  test("the binary is kept under the cache directory by version, with .exe on Windows", () => {
    const unix = runtimeBinaryPath("linux");
    expect(unix).toBe(path.join(storage.root, "cache", "akm", "opencode", OPENCODE_RUNTIME_VERSION, "opencode"));
    expect(runtimeBinaryPath("win32")).toBe(`${unix}.exe`);
  });
});

describe("the integrity check", () => {
  test("a tarball with the integrity the registry lists passes, any other fails", async () => {
    const archive = packageTarball(Buffer.from("binary"));
    await expect(verifyIntegrity(archive, integrityOf(archive))).resolves.toBeUndefined();
    await expect(verifyIntegrity(archive, `sha512-${Buffer.from("not it").toString("base64")}`)).rejects.toThrow(
      /sha512 integrity is sha512-.* not the sha512-.* the registry lists/,
    );
  });

  test("a listing with no sha512 is refused, not skipped", async () => {
    const archive = packageTarball(Buffer.from("binary"));
    await expect(verifyIntegrity(archive, "sha1-abc")).rejects.toThrow(/no sha512 integrity/);
    await expect(verifyIntegrity(archive, "")).rejects.toThrow(/no sha512 integrity/);
  });
});

/** Extract one member, as the OpenCode fetch does, and return its size. */
async function extractOne(archive: string, member: string, destination: string): Promise<number | undefined> {
  return (await extractTarGzMembers(archive, new Map([[member, destination]]))).get(member);
}

describe("extracting members of a package tarball", () => {
  test.each([
    ["a few bytes", 20],
    ["exactly one block", 512],
    ["a size that fills no whole block", 1_500_017],
    ["many chunks", 6_000_000],
  ])("%s", async (_name, size) => {
    const content = randomBytes(size);
    const out = path.join(scratch.dir, "out");

    const written = await extractOne(packageTarball(content), "package/bin/opencode", out);

    expect(written).toBe(size);
    expect(fs.readFileSync(out).equals(content)).toBe(true);
    if (process.platform !== "win32") expect(fs.statSync(out).mode & 0o111).not.toBe(0);
  });

  test("several members come out of one pass, each to its own destination", async () => {
    const root = path.join(scratch.dir, "several");
    fs.mkdirSync(path.join(root, "package", "bin"), { recursive: true });
    const library = randomBytes(700_001);
    const binding = randomBytes(3_000);
    fs.writeFileSync(path.join(root, "package", "bin", "library"), library);
    fs.writeFileSync(path.join(root, "package", "bin", "skipped"), randomBytes(5_000));
    fs.writeFileSync(path.join(root, "package", "bin", "binding"), binding);
    const archive = path.join(scratch.dir, "several.tgz");
    spawnSync("tar", [
      "-czf",
      archive,
      "-C",
      root,
      "package/bin/library",
      "package/bin/skipped",
      "package/bin/binding",
    ]);

    const sizes = await extractTarGzMembers(
      archive,
      new Map([
        ["package/bin/binding", path.join(scratch.dir, "binding")],
        ["package/bin/library", path.join(scratch.dir, "library")],
      ]),
    );

    expect(Object.fromEntries(sizes)).toEqual({ "package/bin/library": 700_001, "package/bin/binding": 3_000 });
    expect(fs.readFileSync(path.join(scratch.dir, "library")).equals(library)).toBe(true);
    expect(fs.readFileSync(path.join(scratch.dir, "binding")).equals(binding)).toBe(true);
    expect(fs.existsSync(path.join(scratch.dir, "skipped"))).toBe(false);
  });

  test("a member the archive does not hold is reported by name", async () => {
    await expect(
      extractOne(packageTarball(Buffer.from("x")), "package/bin/opencode.exe", path.join(scratch.dir, "out")),
    ).rejects.toThrow(/has no package\/bin\/opencode\.exe/);
  });

  test("an archive cut inside the member is reported, and what was written is the caller's to remove", async () => {
    const archive = packageTarball(randomBytes(2_000_000));
    const cut = path.join(scratch.dir, "cut.tgz");
    fs.writeFileSync(cut, fs.readFileSync(archive).subarray(0, 1_000_000));

    await expect(extractOne(cut, "package/bin/opencode", path.join(scratch.dir, "out"))).rejects.toThrow();
  });

  test.skipIf(process.platform !== "linux")(
    "the archive is closed once the member is written, though more follows it",
    async () => {
      const root = path.join(scratch.dir, "after");
      fs.mkdirSync(path.join(root, "package", "bin"), { recursive: true });
      fs.writeFileSync(path.join(root, "package", "bin", "opencode"), randomBytes(1_000));
      fs.writeFileSync(path.join(root, "package", "zz-after"), randomBytes(4_000_000));
      const archive = path.join(scratch.dir, "after.tgz");
      spawnSync("tar", ["-czf", archive, "-C", root, "package/bin/opencode", "package/zz-after"]);
      const openOnArchive = () =>
        fs.readdirSync("/proc/self/fd").filter((fd) => {
          try {
            return fs.readlinkSync(`/proc/self/fd/${fd}`) === archive;
          } catch {
            return false;
          }
        });

      await extractOne(archive, "package/bin/opencode", path.join(scratch.dir, "out"));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(openOnArchive()).toEqual([]);
    },
  );
});

describe("the first-use fetch", () => {
  const BINARY = Buffer.from("#!/bin/sh\necho opencode\n");

  /** A registry serving `archive` for whatever package this machine asks for; `requests` lists the URLs asked. */
  function registry(archive: string, integrity = integrityOf(archive)) {
    const requests: string[] = [];
    const serve = (url: string): Response => {
      requests.push(url);
      if (/\/@opencode\/cli-[^/]+\/2\.1\.4$/.test(url)) {
        return Response.json({ dist: { tarball: url.replace(/\/2\.1\.4$/, "/-/package-2.1.4.tgz"), integrity } });
      }
      if (url.endsWith("/-/package-2.1.4.tgz")) return new Response(fs.readFileSync(archive));
      return new Response("not found", { status: 404 });
    };
    return { requests, serve };
  }

  const leftovers = (): string[] =>
    fs.readdirSync(path.dirname(runtimeBinaryPath())).filter((name) => name !== path.basename(runtimeBinaryPath()));

  test("fetches the one package, checks it, and keeps the executable in the cache", async () => {
    const { requests, serve } = registry(packageTarball(BINARY));

    const binary = await withMockedFetch(() => ensureRuntimeBinary(), serve);

    expect(binary).toBe(runtimeBinaryPath());
    expect(fs.readFileSync(binary).equals(BINARY)).toBe(true);
    if (process.platform !== "win32") expect(fs.statSync(binary).mode & 0o777).toBe(0o755);
    expect(requests).toHaveLength(2);
    expect(requests.every((url) => url.startsWith("https://registry.npmjs.org/@opencode/cli-"))).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  test("a second use fetches nothing", async () => {
    const { requests, serve } = registry(packageTarball(BINARY));
    await withMockedFetch(() => ensureRuntimeBinary(), serve);
    requests.length = 0;

    await withMockedFetch(() => ensureRuntimeBinary(), serve);

    expect(requests).toEqual([]);
  });

  test("runs that ask while it is being fetched share the one fetch", async () => {
    const { requests, serve } = registry(packageTarball(BINARY));

    const both = await withMockedFetch(() => Promise.all([ensureRuntimeBinary(), ensureRuntimeBinary()]), serve);

    expect(both[0]).toBe(both[1] as string);
    expect(requests).toHaveLength(2);
  });

  test("a binary another process finishes while this one downloads is left in place, not renamed over", async () => {
    const { serve } = registry(packageTarball(BINARY));
    const binary = runtimeBinaryPath();
    // A process without the fetch lock (an older akm) finishes while this one downloads.
    const otherFinishes = (url: string): Response => {
      if (url.endsWith("/-/package-2.1.4.tgz")) {
        fs.mkdirSync(path.dirname(binary), { recursive: true });
        fs.writeFileSync(binary, BINARY, { mode: 0o755 });
      }
      return serve(url);
    };
    const renamed = spyOn(fs, "renameSync");

    await expect(withMockedFetch(() => ensureRuntimeBinary(), otherFinishes)).resolves.toBe(binary);

    expect(renamed.mock.calls.filter(([, to]) => to === binary)).toEqual([]);
    expect(fs.readFileSync(binary).equals(BINARY)).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  test("a rename that fails with nothing in place is a failed fetch, not a binary that is not there", async () => {
    const { serve } = registry(packageTarball(BINARY));
    spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("EACCES: permission denied, rename"), { code: "EACCES" });
    });

    await expect(withMockedFetch(() => ensureRuntimeBinary(), serve)).rejects.toThrow(/EACCES/);

    expect(fs.existsSync(runtimeBinaryPath())).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  test("a tarball that does not match the registry's integrity is refused before anything is kept", async () => {
    const { serve } = registry(packageTarball(BINARY), `sha512-${Buffer.from("something else").toString("base64")}`);

    await expect(withMockedFetch(() => ensureRuntimeBinary(), serve)).rejects.toThrow(/sha512 integrity is/);

    expect(fs.existsSync(runtimeBinaryPath())).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  test("a failed fetch names the package, the URL and the cache path, and says what to do without network", async () => {
    let message = "";
    try {
      await withMockedFetch(
        () => ensureRuntimeBinary(),
        () => new Response("gone", { status: 404 }),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(
      /package @opencode\/cli-[a-z0-9-]+ from https:\/\/registry\.npmjs\.org\/@opencode\/cli-[a-z0-9-]+\/2\.1\.4/,
    );
    expect(message).toContain(path.dirname(runtimeBinaryPath()));
    expect(message).toContain("HTTP 404");
    expect(message).toContain("enable the opencode harness with an installed OpenCode 2");
    // The next use tries again: a failure is not remembered.
    const { serve } = registry(packageTarball(BINARY));
    await expect(withMockedFetch(() => ensureRuntimeBinary(), serve)).resolves.toBe(runtimeBinaryPath());
  });
});

describe("one fetch per cache directory at a time", () => {
  const BINARY = Buffer.from("#!/bin/sh\necho opencode\n");
  const PACKAGE = "@opencode/cli-fixture";
  const FILES = [{ member: "package/bin/opencode", file: "opencode" }];
  let directory: string;

  beforeEach(() => {
    directory = path.join(scratch.dir, "cache", "opencode", OPENCODE_RUNTIME_VERSION);
  });

  /** A registry serving a package holding `BINARY`; `requests` lists the URLs asked. */
  function stubRegistry() {
    const archive = packageTarball(BINARY);
    const requests: string[] = [];
    const serve = async (url: string): Promise<Response> => {
      requests.push(url);
      if (url === `https://registry.npmjs.org/${PACKAGE}/2.1.4`) {
        return Response.json({ dist: { tarball: `${url}.tgz`, integrity: integrityOf(archive) } });
      }
      // The tarball takes a while, so a second fetch starts while the first is under way.
      await new Promise((resolve) => setTimeout(resolve, 100));
      return new Response(fs.readFileSync(archive));
    };
    return { requests, serve };
  }

  const fetchBinary = () => fetchNpmPackageFiles(PACKAGE, "2.1.4", directory, FILES);

  test("two fetches into one empty cache download once and leave one binary", async () => {
    const { requests, serve } = stubRegistry();

    await withMockedFetch(() => Promise.all([fetchBinary(), fetchBinary()]), serve);

    expect(requests).toEqual([
      `https://registry.npmjs.org/${PACKAGE}/2.1.4`,
      `https://registry.npmjs.org/${PACKAGE}/2.1.4.tgz`,
    ]);
    expect(fs.readdirSync(directory)).toEqual(["opencode"]);
    expect(fs.readFileSync(path.join(directory, "opencode")).equals(BINARY)).toBe(true);
  });

  test("a fetch into a cache that already holds the binary downloads nothing and leaves it as it is", async () => {
    const binary = path.join(directory, "opencode");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(binary, BINARY, { mode: 0o755 });
    const inode = fs.statSync(binary).ino;
    const { requests, serve } = stubRegistry();

    await withMockedFetch(fetchBinary, serve);

    expect(requests).toEqual([]);
    expect(fs.statSync(binary).ino).toBe(inode);
    expect(fs.readdirSync(directory)).toEqual(["opencode"]);
  });

  test("a fetch waits for a live holder, then downloads nothing if the holder finished the binary", async () => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "fetch.lock"), JSON.stringify({ pid: process.pid, lockId: "other" }));
    const { requests, serve } = stubRegistry();

    const fetching = withMockedFetch(fetchBinary, serve);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(requests).toEqual([]);
    fs.writeFileSync(path.join(directory, "opencode"), BINARY, { mode: 0o755 });
    fs.rmSync(path.join(directory, "fetch.lock"));
    await fetching;

    expect(requests).toEqual([]);
    expect(fs.readdirSync(directory)).toEqual(["opencode"]);
  });

  test("a lock left by a dead process is reclaimed and the fetch goes ahead", async () => {
    const dead = spawnSync(process.execPath, ["--version"]).pid;
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "fetch.lock"), JSON.stringify({ pid: dead, lockId: "gone" }));
    const { requests, serve } = stubRegistry();

    await withMockedFetch(fetchBinary, serve);

    expect(requests).toHaveLength(2);
    expect(fs.readdirSync(directory)).toEqual(["opencode"]);
    expect(fs.readFileSync(path.join(directory, "opencode")).equals(BINARY)).toBe(true);
  });

  test("a failed fetch releases the lock, so the next fetch is not blocked", async () => {
    await expect(withMockedFetch(fetchBinary, async () => new Response("gone", { status: 404 }))).rejects.toThrow(
      /HTTP 404/,
    );
    expect(fs.readdirSync(directory)).toEqual([]);

    const { requests, serve } = stubRegistry();
    await withMockedFetch(fetchBinary, serve);

    expect(requests).toHaveLength(2);
    expect(fs.readdirSync(directory)).toEqual(["opencode"]);
  });
});
