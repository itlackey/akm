// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The OpenCode binary akm's own runtime runs (`runtime/binary.ts`, `runtime/tar.ts`):
 * which package a machine gets, the integrity check before anything is extracted,
 * the extraction of the one member, and the first-use fetch into akm's cache. The
 * registry is a mocked fetch serving a package tarball made with `tar`; the real
 * fetch is exercised by tests/integration/opencode-runtime-sessions.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ensureRuntimeBinary,
  type HostTraits,
  OPENCODE_RUNTIME_VERSION,
  opencodePackage,
  runtimeBinaryPath,
  verifyIntegrity,
} from "../src/integrations/harnesses/opencode/runtime/binary";
import { extractTarGzMember } from "../src/integrations/harnesses/opencode/runtime/tar";
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

describe("extracting the one member of a package tarball", () => {
  test.each([
    ["a few bytes", 20],
    ["exactly one block", 512],
    ["a size that fills no whole block", 1_500_017],
    ["many chunks", 6_000_000],
  ])("%s", async (_name, size) => {
    const content = randomBytes(size);
    const out = path.join(scratch.dir, "out");

    const written = await extractTarGzMember(packageTarball(content), "package/bin/opencode", out);

    expect(written).toBe(size);
    expect(fs.readFileSync(out).equals(content)).toBe(true);
    if (process.platform !== "win32") expect(fs.statSync(out).mode & 0o111).not.toBe(0);
  });

  test("a member the archive does not hold is reported by name", async () => {
    await expect(
      extractTarGzMember(packageTarball(Buffer.from("x")), "package/bin/opencode.exe", path.join(scratch.dir, "out")),
    ).rejects.toThrow(/has no package\/bin\/opencode\.exe/);
  });

  test("an archive cut inside the member is reported, and what was written is the caller's to remove", async () => {
    const archive = packageTarball(randomBytes(2_000_000));
    const cut = path.join(scratch.dir, "cut.tgz");
    fs.writeFileSync(cut, fs.readFileSync(archive).subarray(0, 1_000_000));

    await expect(extractTarGzMember(cut, "package/bin/opencode", path.join(scratch.dir, "out"))).rejects.toThrow();
  });
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
