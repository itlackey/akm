import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { copyIncludedPaths } from "../../../src/sources/include";
import { copyDirectoryContents, detectStashRoot } from "../../../src/sources/providers/provider-utils";
import { type Cleanup, makeSandboxDir, makeStashDir } from "../../_helpers/sandbox";

/** The conformance-oracle fixtures the ordered §1.2 probe classifies. */
const AKM_ROOT = path.resolve(__dirname, "../../fixtures/stashes/all-types");
const OKF_ROOT = path.resolve(__dirname, "../../fixtures/bundles/okf-sample");

let cleanup: Cleanup = () => {};

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

describe("source provider copy safety", () => {
  test("copyDirectoryContents skips symlinks instead of dereferencing them", () => {
    const source = makeSandboxDir("akm-provider-copy-src");
    const dest = makeSandboxDir("akm-provider-copy-dest");
    cleanup = () => {
      dest.cleanup();
      source.cleanup();
    };

    const outside = path.join(dest.dir, "outside.txt");
    fs.writeFileSync(path.join(source.dir, "safe.md"), "safe\n", "utf8");
    fs.writeFileSync(outside, "outside\n", "utf8");
    fs.symlinkSync(outside, path.join(source.dir, "escaped.md"));

    copyDirectoryContents(source.dir, dest.dir);

    expect(fs.readFileSync(path.join(dest.dir, "safe.md"), "utf8")).toBe("safe\n");
    expect(fs.existsSync(path.join(dest.dir, "escaped.md"))).toBe(false);
  });

  test("copyIncludedPaths rejects symlink include targets", () => {
    const source = makeSandboxDir("akm-include-src");
    const dest = makeSandboxDir("akm-include-dest");
    cleanup = () => {
      dest.cleanup();
      source.cleanup();
    };

    fs.writeFileSync(path.join(source.dir, "real.md"), "inside\n", "utf8");
    fs.symlinkSync(path.join(source.dir, "real.md"), path.join(source.dir, "leak.md"));

    expect(() => copyIncludedPaths(["leak.md"], source.dir, dest.dir)).toThrow("must not be a symlink");
    expect(fs.existsSync(path.join(dest.dir, "leak.md"))).toBe(false);
  });
});

describe("detectStashRoot — ordered §1.2 registry probe (WI: registry wiring)", () => {
  test("an akm stash root (type dirs) is returned as-is — behavior-identical to the old akm-only probe", () => {
    // `akm.looksLikeRoot` fires (type dirs), same as the former hardcoded probe.
    expect(detectStashRoot(AKM_ROOT)).toBe(path.resolve(AKM_ROOT));
  });

  test("a `.stash`-marker root is returned as-is (akm marker path)", () => {
    const sb = makeSandboxDir("akm-detect-dotstash");
    cleanup = sb.cleanup;
    fs.mkdirSync(path.join(sb.dir, ".stash"), { recursive: true });
    expect(detectStashRoot(sb.dir)).toBe(path.resolve(sb.dir));
  });

  test("a NON-akm bundle root (okf: root index doc) is now recognized at the top level", () => {
    // The single-adapter probe missed this; the ordered registry probe claims it
    // via `okf.looksLikeRoot`. (The pre-wiring code also returned this via its
    // final `return root` fallback, so the outcome is identical here too.)
    expect(detectStashRoot(OKF_ROOT)).toBe(path.resolve(OKF_ROOT));
  });

  test("a nested stash under a plain wrapper is still discovered by the BFS fallback", () => {
    const sb = makeSandboxDir("akm-detect-nested");
    cleanup = sb.cleanup;
    const inner = path.join(sb.dir, "inner");
    fs.mkdirSync(path.join(inner, ".stash"), { recursive: true });
    // The wrapper has no bundle marker, so no adapter claims it → BFS finds inner.
    expect(detectStashRoot(sb.dir)).toBe(inner);
  });

  test("a directory no adapter claims and with no nested stash returns the root itself", () => {
    const sb = makeSandboxDir("akm-detect-plain");
    cleanup = sb.cleanup;
    fs.writeFileSync(path.join(sb.dir, "readme.txt"), "nothing bundle-shaped\n");
    expect(detectStashRoot(sb.dir)).toBe(path.resolve(sb.dir));
  });

  test("a freshly-scaffolded stash skeleton (type dirs, no .stash) resolves to akm", () => {
    const stash = makeStashDir();
    cleanup = stash.cleanup;
    expect(detectStashRoot(stash.dir)).toBe(path.resolve(stash.dir));
  });
});
