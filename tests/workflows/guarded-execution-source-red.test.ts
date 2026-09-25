// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExecutionSourceIdentity } from "../../src/execution/source";
import { makeSandboxDir, type SandboxedDir } from "../_helpers/sandbox";

const sandboxes: SandboxedDir[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0).reverse()) sandbox.cleanup();
});

async function guardedSourceApi() {
  return import("../../src/execution/guarded-source");
}

function sandbox(prefix: string): string {
  const created = makeSandboxDir(prefix);
  sandboxes.push(created);
  return created.dir;
}

function write(root: string, relative: string, bytes: string | Uint8Array): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

function digest(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function identity(
  bundle: string,
  conceptId: string,
  adapter: string,
  file: string,
  bytes: string | Uint8Array,
): ExecutionSourceIdentity {
  return {
    ref: `${bundle}//${conceptId}`,
    bundle,
    adapter,
    file,
    hash: digest(bytes),
  };
}

function physicalIdentity(realPath: string, stat: fs.BigIntStats): string {
  return stat.ino === 0n ? `path:${realPath}` : `inode:${stat.dev}:${stat.ino}`;
}

function sourceKey(source: { identity?: ExecutionSourceIdentity }): string {
  if (!source.identity) throw new Error("expected a bound execution source identity");
  return `${source.identity.ref}\0${source.identity.adapter}\0${source.identity.file}`;
}

describe("shared guarded retained-byte capture", () => {
  test("opens no-follow, reads exact descriptor bytes, and retains hash, size, root identity, and file dev+ino", async () => {
    const { captureGuardedExecutionSource } = await guardedSourceApi();
    const root = sandbox("akm-guarded-capture");
    const bytes = Buffer.from("---\nname: caf\u00e9\n---\nReview exactly.\n", "utf8");
    const file = write(root, "commands/review.md", bytes);
    const sourceIdentity = identity("alpha", "commands/review", "akm", "commands/review.md", bytes);
    const open = spyOn(fs, "openSync");

    const captured = captureGuardedExecutionSource(file, root, { identity: sourceIdentity, authored: true });

    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(file);
    const rootStat = fs.statSync(realRoot, { bigint: true });
    const fileStat = fs.statSync(realFile, { bigint: true });
    expect(open).toHaveBeenCalledTimes(1);
    const flags = open.mock.calls[0]?.[1];
    expect(typeof flags).toBe("number");
    if (process.platform !== "win32" && typeof fs.constants.O_NOFOLLOW === "number") {
      expect((flags as number) & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    }
    expect(Buffer.from(captured.bytesBase64, "base64")).toEqual(bytes);
    expect(captured.content).toBe(bytes.toString("utf8"));
    expect(captured.sha256).toBe(digest(bytes));
    expect(captured.size).toBe(bytes.byteLength);
    expect(captured.identity).toEqual(sourceIdentity);
    expect(captured.sourcePath).toBe(path.resolve(file));
    expect(captured.relativePath).toBe("commands/review.md");
    expect(captured.realPath).toBe(realFile);
    expect(captured.containmentRealPath).toBe(realRoot);
    expect(captured.containmentPhysicalIdentity).toBe(physicalIdentity(realRoot, rootStat));
    expect(captured.physicalIdentity).toBe(physicalIdentity(realFile, fileStat));
    expect(captured.mtimeNs).toBe(String(fileStat.mtimeNs));
    expect(captured.ctimeNs).toBe(String(fileStat.ctimeNs));
  });

  test("supports an identity-free retained read before an adapter binds authoritative identity", async () => {
    const { captureGuardedExecutionSource } = await guardedSourceApi();
    const root = sandbox("akm-guarded-unbound");
    const file = write(root, "commands/review.md", "Review.\n");

    const captured = captureGuardedExecutionSource(file, root);

    expect(captured.identity).toBeUndefined();
    expect(Buffer.from(captured.bytesBase64, "base64").toString("utf8")).toBe("Review.\n");
  });

  test("rejects invalid UTF-8 rather than returning lossy adapter input", async () => {
    const { captureGuardedExecutionSource } = await guardedSourceApi();
    const root = sandbox("akm-guarded-utf8");
    const file = write(root, "commands/invalid.md", Uint8Array.from([0x61, 0xff, 0x62]));

    expect(() => captureGuardedExecutionSource(file, root)).toThrow(/UTF-8|encoding/i);
  });

  test("fails closed when before/after fstat proves a read-time mutation", async () => {
    const { captureGuardedExecutionSource } = await guardedSourceApi();
    const root = sandbox("akm-guarded-fstat");
    const file = write(root, "commands/raced.md", "before\n");
    const originalFstat = fs.fstatSync.bind(fs);
    let calls = 0;
    spyOn(fs, "fstatSync").mockImplementation(((descriptor: number) => {
      const actual = originalFstat(descriptor, { bigint: true });
      calls += 1;
      if (calls !== 2 || typeof actual.ctimeNs !== "bigint") return actual;
      return new Proxy(actual, {
        get(target, property, receiver) {
          if (property === "ctimeNs") return target.ctimeNs + 1n;
          return Reflect.get(target, property, receiver);
        },
      });
    }) as typeof fs.fstatSync);

    expect(() => captureGuardedExecutionSource(file, root)).toThrow(/changed|guard|race|read/i);
    expect(calls).toBe(2);
  });

  test("rejects lexical escapes, ancestor escapes, symlink files, and non-regular sources", async () => {
    const { captureGuardedExecutionSource } = await guardedSourceApi();
    const outer = sandbox("akm-guarded-escape");
    const root = path.join(outer, "bundle");
    fs.mkdirSync(root);
    const outside = write(outer, "outside.md", "outside\n");
    const inside = write(root, "commands/inside.md", "inside\n");
    const linkedInside = path.join(root, "commands", "linked-inside.md");
    const linkedOutside = path.join(root, "commands", "linked-outside.md");
    fs.symlinkSync(inside, linkedInside);
    fs.symlinkSync(outside, linkedOutside);
    const escapedDirectory = path.join(root, "agents");
    fs.symlinkSync(path.dirname(outside), escapedDirectory, "dir");

    expect(() => captureGuardedExecutionSource(outside, root)).toThrow(/outside|escape|contain/i);
    expect(() => captureGuardedExecutionSource(linkedInside, root)).toThrow(/symbolic|symlink|identity|no.follow/i);
    expect(() => captureGuardedExecutionSource(linkedOutside, root)).toThrow(/outside|escape|symbolic|symlink/i);
    expect(() => captureGuardedExecutionSource(path.join(escapedDirectory, "outside.md"), root)).toThrow(
      /outside|escape|contain|symbolic/i,
    );
    expect(() => captureGuardedExecutionSource(path.join(root, "commands"), root)).toThrow(/regular|file/i);
  });
});

describe("GuardedExecutionSourceCollector retained adapter inputs", () => {
  test("fileContext content and stat remain frozen after replacement and deletion while final CAS fails", async () => {
    const { GuardedExecutionSourceCollector } = await guardedSourceApi();
    const root = sandbox("akm-guarded-context");
    const original = Buffer.from("---\nname: frozen\n---\nOriginal body.\n");
    const file = write(root, "commands/frozen.md", original);
    const before = fs.statSync(file);
    const collector = new GuardedExecutionSourceCollector();
    const retained = collector.readBytes(file, root);
    const context = collector.fileContext(root, file);

    const replacement = path.join(root, "commands", ".replacement.md");
    fs.writeFileSync(replacement, "replacement with a different byte length\n");
    fs.renameSync(replacement, file);
    fs.unlinkSync(file);
    const stat = spyOn(fs, "statSync").mockImplementation(() => {
      throw new Error("live stat reread forbidden");
    });

    expect(Buffer.from(retained)).toEqual(original);
    expect(context.content()).toBe(original.toString("utf8"));
    expect(context.stat().size).toBe(before.size);
    expect(context.stat().dev).toBe(before.dev);
    expect(context.stat().ino).toBe(before.ino);
    expect(stat).not.toHaveBeenCalled();
    expect(() => collector.revalidate()).toThrow(/changed|missing|read set|source|CAS/i);
  });

  test("bindIdentity accepts the adapter identity after fileContext capture and snapshots it canonically", async () => {
    const { GuardedExecutionSourceCollector } = await guardedSourceApi();
    const root = sandbox("akm-guarded-bind");
    const bytes = "Review.\n";
    const file = write(root, "commands/review.md", bytes);
    const sourceIdentity = identity("primary", "commands/review", "akm", "commands/review.md", bytes);
    const collector = new GuardedExecutionSourceCollector();

    expect(collector.fileContext(root, file).content()).toBe(bytes);
    const bound = collector.bindIdentity(file, root, sourceIdentity);

    expect(bound.identity).toEqual(sourceIdentity);
    expect(collector.snapshot().sources).toEqual([bound]);
  });

  test("sorts cross-bundle owners by canonical logical identity without collapsing equal content", async () => {
    const { GuardedExecutionSourceCollector } = await guardedSourceApi();
    const outer = sandbox("akm-guarded-cross-bundle");
    const alpha = path.join(outer, "alpha");
    const omega = path.join(outer, "omega");
    fs.mkdirSync(alpha);
    fs.mkdirSync(omega);
    const bytes = "Same rendered bytes.\n";
    const omegaFile = write(omega, "commands/review.md", bytes);
    const alphaFile = write(alpha, "commands/review.md", bytes);
    const collector = new GuardedExecutionSourceCollector();

    collector.capture(omegaFile, omega, {
      identity: identity("omega", "commands/review", "akm", "commands/review.md", bytes),
    });
    collector.capture(alphaFile, alpha, {
      identity: identity("alpha", "commands/review", "akm", "commands/review.md", bytes),
    });
    const sources = collector.snapshot().sources;

    expect(sources.map(sourceKey)).toEqual([
      "alpha//commands/review\0akm\0commands/review.md",
      "omega//commands/review\0akm\0commands/review.md",
    ]);
    expect(sources[0]?.sha256).toBe(sources[1]?.sha256);
    expect(sources[0]?.containmentPhysicalIdentity).not.toBe(sources[1]?.containmentPhysicalIdentity);
    expect(sources[0]?.physicalIdentity).not.toBe(sources[1]?.physicalIdentity);
  });

  test("rejects a second qualified logical owner for one physical file and containment root", async () => {
    const { GuardedExecutionSourceCollector } = await guardedSourceApi();
    const root = sandbox("akm-guarded-owner-alias");
    const bytes = "Shared inode.\n";
    const command = write(root, "commands/shared.md", bytes);
    const aliases = [
      ["agents/shared.md", "agents/shared", "akm"],
      ["scripts/shared.sh", "scripts/shared", "akm"],
      ["tasks/shared.yml", "tasks/shared", "akm-task"],
      ["workflows/shared.yml", "workflows/shared", "akm-workflow"],
    ] as const;

    for (const [relative, conceptId, adapter] of aliases) {
      const alias = path.join(root, relative);
      fs.mkdirSync(path.dirname(alias), { recursive: true });
      fs.linkSync(command, alias);
      const collector = new GuardedExecutionSourceCollector();
      collector.capture(command, root, {
        identity: identity("primary", "commands/shared", "akm", "commands/shared.md", bytes),
      });
      collector.capture(alias, root);

      expect(() =>
        collector.bindIdentity(alias, root, identity("primary", conceptId, adapter, relative, bytes)),
      ).toThrow(/alias|same physical|identity|owner|collision/i);
    }
  });

  test("rejects two bundle refs that alias the same physical root and file through a root symlink", async () => {
    const { GuardedExecutionSourceCollector } = await guardedSourceApi();
    const outer = sandbox("akm-guarded-root-alias");
    const root = path.join(outer, "real-bundle");
    fs.mkdirSync(root);
    const aliasRoot = path.join(outer, "alias-bundle");
    fs.symlinkSync(root, aliasRoot, "dir");
    const bytes = "One physical owner.\n";
    const file = write(root, "commands/owner.md", bytes);
    const collector = new GuardedExecutionSourceCollector();
    collector.capture(file, root, {
      identity: identity("alpha", "commands/owner", "akm", "commands/owner.md", bytes),
    });
    const aliasFile = path.join(aliasRoot, "commands", "owner.md");
    collector.capture(aliasFile, aliasRoot);

    expect(() =>
      collector.bindIdentity(
        aliasFile,
        aliasRoot,
        identity("omega", "commands/owner", "akm", "commands/owner.md", bytes),
      ),
    ).toThrow(/alias|same physical|root|owner|collision/i);
  });
});

describe("guarded touched-directory manifests and final source CAS", () => {
  test("enumerateTree records every nested touched directory with sorted exact entry kinds and physical versions", async () => {
    const { GuardedExecutionSourceCollector } = await guardedSourceApi();
    const root = sandbox("akm-guarded-tree");
    write(root, "commands/zeta.md", "zeta\n");
    write(root, "commands/nested/alpha.md", "alpha\n");
    write(root, "agents/persona.md", "persona\n");
    write(root, "scripts/run.sh", "#!/bin/sh\n");
    write(root, "tasks/build.yml", "version: 4\nrun: true\n");
    write(root, "workflows/nightly.yml", "name: nightly\n");
    const collector = new GuardedExecutionSourceCollector();

    const files = collector.enumerateTree(root, root);
    const snapshot = collector.snapshot();

    expect(files.map((file: string) => path.relative(root, file).replaceAll("\\", "/"))).toEqual([
      "agents/persona.md",
      "commands/nested/alpha.md",
      "commands/zeta.md",
      "scripts/run.sh",
      "tasks/build.yml",
      "workflows/nightly.yml",
    ]);
    expect(snapshot.directoryManifests.map((manifest: { relativePath: string }) => manifest.relativePath)).toEqual([
      ".",
      "agents",
      "commands",
      "commands/nested",
      "scripts",
      "tasks",
      "workflows",
    ]);
    const commands = snapshot.directoryManifests.find(
      (manifest: { relativePath: string }) => manifest.relativePath === "commands",
    );
    expect(commands?.entries.map(({ name, kind }: { name: string; kind: string }) => [name, kind])).toEqual([
      ["nested", "directory"],
      ["zeta.md", "file"],
    ]);
    for (const manifest of snapshot.directoryManifests) {
      expect(manifest.directoryPath).toBe(path.resolve(root, manifest.relativePath));
      expect(manifest.containmentPhysicalIdentity).toMatch(/^(?:inode:|path:)/);
      expect(manifest.physicalIdentity).toMatch(/^(?:inode:|path:)/);
      expect(manifest.version).toMatch(/^\d+:\d+:\d+$/);
      expect(manifest.entries.map((entry: { name: string }) => entry.name)).toEqual(
        [...manifest.entries.map((entry: { name: string }) => entry.name)].sort(),
      );
      for (const entry of manifest.entries) {
        expect(entry.physicalIdentity).toMatch(/^(?:inode:|path:)/);
        expect(entry.version).toMatch(/^\d+:\d+:\d+$/);
      }
    }
  });

  test("trackDirectory covers an empty discovery directory so a later addition invalidates the read set", async () => {
    const { GuardedExecutionSourceCollector } = await guardedSourceApi();
    const root = sandbox("akm-guarded-empty-dir");
    const workflows = path.join(root, "workflows");
    fs.mkdirSync(workflows);
    const collector = new GuardedExecutionSourceCollector();

    const manifest = collector.trackDirectory(workflows, root);
    expect(manifest.entries).toEqual([]);
    expect(() => collector.revalidate()).not.toThrow();
    write(root, "workflows/new.yml", "name: new\n");

    expect(() => collector.revalidate()).toThrow(/directory|manifest|read set|changed|added/i);
  });

  test("enumeration rejects a symbolic directory entry rather than following an unguarded tree", async () => {
    const { GuardedExecutionSourceCollector } = await guardedSourceApi();
    const outer = sandbox("akm-guarded-tree-link");
    const root = path.join(outer, "bundle");
    const outside = path.join(outer, "outside");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    write(outside, "workflow.yml", "name: outside\n");
    fs.symlinkSync(outside, path.join(root, "workflows"), "dir");
    const collector = new GuardedExecutionSourceCollector();

    expect(() => collector.enumerateTree(root, root)).toThrow(/symbolic|symlink|outside|ambiguous/i);
  });

  test("records an in-bundle symlink directory entry as its own kind instead of refusing the whole directory", async () => {
    const { GuardedExecutionSourceCollector } = await guardedSourceApi();
    const root = sandbox("akm-guarded-symlink-entry");
    write(root, "AGENTS.md", "agents\n");
    fs.symlinkSync(path.join(root, "AGENTS.md"), path.join(root, "CLAUDE.md"));
    const collector = new GuardedExecutionSourceCollector();

    const manifest = collector.trackDirectory(root, root);
    const claude = manifest.entries.find((entry) => entry.name === "CLAUDE.md");
    const agents = manifest.entries.find((entry) => entry.name === "AGENTS.md");

    expect(claude?.kind).toBe("symlink");
    expect(claude?.target).toBe(path.join(root, "AGENTS.md"));
    expect(claude?.physicalIdentity).toMatch(/^(?:inode:|path:)/);
    expect(agents?.kind).toBe("file");
    // A symlink entry is never a source candidate: enumerateTree must not
    // treat it as a file (or descend into it as a directory).
    const files = collector.enumerateTree(root, root);
    expect(files).toEqual([path.join(root, "AGENTS.md")]);
  });

  test("rejects a broken symbolic directory entry as ambiguous ownership", async () => {
    const { GuardedExecutionSourceCollector } = await guardedSourceApi();
    const root = sandbox("akm-guarded-broken-symlink");
    fs.symlinkSync(path.join(root, "missing-target.md"), path.join(root, "broken.md"));
    const collector = new GuardedExecutionSourceCollector();

    expect(() => collector.trackDirectory(root, root)).toThrow(/symbolic|symlink|identity|no.follow|ambiguous/i);
  });

  test("revalidation detects a directory symlink entry retargeted between projection and mutation", async () => {
    const { GuardedExecutionSourceCollector } = await guardedSourceApi();
    const root = sandbox("akm-guarded-symlink-retarget");
    write(root, "AGENTS.md", "agents\n");
    write(root, "OTHER.md", "other\n");
    fs.symlinkSync(path.join(root, "AGENTS.md"), path.join(root, "CLAUDE.md"));
    const collector = new GuardedExecutionSourceCollector();
    collector.trackDirectory(root, root);
    fs.unlinkSync(path.join(root, "CLAUDE.md"));
    fs.symlinkSync(path.join(root, "OTHER.md"), path.join(root, "CLAUDE.md"));

    expect(() => collector.revalidate()).toThrow(/changed|manifest|read set|directory/i);
  });

  for (const scenario of [
    {
      name: "added command",
      initial: [["commands/review.md", "review\n"]] as const,
      mutate(root: string) {
        write(root, "commands/extra.md", "extra\n");
      },
    },
    {
      name: "removed persona",
      initial: [["agents/reviewer.md", "persona\n"]] as const,
      mutate(root: string) {
        fs.unlinkSync(path.join(root, "agents", "reviewer.md"));
      },
    },
    {
      name: "renamed script",
      initial: [["scripts/build.sh", "#!/bin/sh\n"]] as const,
      mutate(root: string) {
        fs.renameSync(path.join(root, "scripts", "build.sh"), path.join(root, "scripts", "release.sh"));
      },
    },
    {
      name: "byte-identical inode-replaced task",
      initial: [["tasks/build.yml", "version: 4\nrun: echo build\n"]] as const,
      mutate(root: string) {
        const file = path.join(root, "tasks", "build.yml");
        const replacement = path.join(root, "tasks", ".replacement.yml");
        fs.writeFileSync(replacement, fs.readFileSync(file));
        fs.renameSync(replacement, file);
      },
    },
    {
      name: "original-raced-original ABA workflow",
      initial: [["workflows/nightly.yml", "name: original\n"]] as const,
      mutate(root: string) {
        const file = path.join(root, "workflows", "nightly.yml");
        fs.writeFileSync(file, "name: raced\n");
        fs.writeFileSync(file, "name: original\n");
      },
    },
  ]) {
    test(`final CAS rejects a ${scenario.name}`, async () => {
      const { GuardedExecutionSourceCollector } = await guardedSourceApi();
      const root = sandbox("akm-guarded-cas");
      for (const [relative, bytes] of scenario.initial) write(root, relative, bytes);
      const collector = new GuardedExecutionSourceCollector();
      const files = collector.enumerateTree(root, root);
      for (const file of files) collector.readBytes(file, root);

      scenario.mutate(root);

      expect(() => collector.revalidate()).toThrow(/source|directory|manifest|read set|changed|identity|CAS/i);
    });
  }

  test("revalidation detects a byte-identical directory-root replacement", async () => {
    const { GuardedExecutionSourceCollector } = await guardedSourceApi();
    const outer = sandbox("akm-guarded-dir-replace");
    const root = path.join(outer, "bundle");
    fs.mkdirSync(root);
    write(root, "workflows/nightly.yml", "name: nightly\n");
    const collector = new GuardedExecutionSourceCollector();
    collector.enumerateTree(root, root);
    const oldRoot = path.join(outer, "old-bundle");
    fs.renameSync(root, oldRoot);
    fs.mkdirSync(root);
    write(root, "workflows/nightly.yml", "name: nightly\n");

    expect(() => collector.revalidate()).toThrow(/root|directory|physical|identity|changed/i);
  });

  test("retained deletion bytes survive for freeze, but final CAS prevents publication", async () => {
    const { GuardedExecutionSourceCollector } = await guardedSourceApi();
    const root = sandbox("akm-guarded-publish-delete");
    const bytes = Buffer.from("Review before deletion.\n");
    const file = write(root, "commands/review.md", bytes);
    const collector = new GuardedExecutionSourceCollector();
    collector.trackDirectory(path.dirname(file), root);
    const retained = collector.readBytes(file, root);
    fs.unlinkSync(file);
    let published = false;

    const publish = () => {
      collector.revalidate();
      published = true;
    };

    expect(Buffer.from(retained)).toEqual(bytes);
    expect(publish).toThrow(/source|directory|missing|changed|CAS/i);
    expect(published).toBe(false);
  });

  test("retained replacement bytes survive for freeze, but final CAS prevents publication", async () => {
    const { GuardedExecutionSourceCollector } = await guardedSourceApi();
    const root = sandbox("akm-guarded-publish-replace");
    const bytes = Buffer.from("Review before replacement.\n");
    const file = write(root, "commands/review.md", bytes);
    const collector = new GuardedExecutionSourceCollector();
    collector.trackDirectory(path.dirname(file), root);
    const retained = collector.readBytes(file, root);
    const replacement = path.join(root, "commands", ".review.md");
    fs.writeFileSync(replacement, bytes);
    fs.renameSync(replacement, file);
    let published = false;

    const publish = () => {
      collector.revalidate();
      published = true;
    };

    expect(Buffer.from(retained)).toEqual(bytes);
    expect(publish).toThrow(/source|directory|identity|changed|CAS/i);
    expect(published).toBe(false);
  });
});
