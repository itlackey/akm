// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The workspace actions of `src/workspace` (feedback, bundles, config, documents) against a real sandbox stash
 * (integration: config file, state.db, index.db, git and CLI children). Ported from the retired `akm ui` server
 * tests with the HTTP layer removed: each action is called directly, and a refusal is the `AkmError` the transport
 * used to map to a status (usage 400, not-found 404, config or conflict code 409). An error that is not an
 * `AkmError` is the transport's 500.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { akmSearch } from "../../../src/commands/read/search";
import { loadConfig, resetConfigCache } from "../../../src/core/config/config";
import { AkmError } from "../../../src/core/errors";
import { getConfigPath, getDbPath } from "../../../src/core/paths";
import { getStateDbPath } from "../../../src/core/state-db";
import { acquireAssetMutationLease } from "../../../src/indexer/index-writer-lock";
import { akmIndex } from "../../../src/indexer/indexer";
import * as akmBin from "../../../src/tasks/resolve-akm-bin";
import { assets, bundles, config, documents, feedback } from "../../../src/workspace";
import { InvalidCommandResponse } from "../../../src/workspace/cli-child";
import { git } from "../../_helpers/git";
import { withEnv, writeSandboxConfig } from "../../_helpers/sandbox";
import {
  countRows,
  ctx,
  dbSnapshot,
  expectAkmError,
  expectConflict,
  expectUsage,
  filesNamed,
  GUIDE,
  type Json,
  NOTES,
  out,
  PLANTED_API_KEY,
  PLANTED_CONFIG_TOKEN,
  PLANTED_REGISTRY_PASSWORD,
  seed,
  sha256,
  useSandbox,
} from "./workspace-behaviour-helpers";

useSandbox();

/** A seeded stash whose connection key is an environment reference, as a config the owner may rewrite. */
async function writableConfig() {
  await seed();
  const current = loadConfig();
  writeSandboxConfig({
    ...current,
    connections: { default: { ...current.connections!.default!, apiKey: "$AKM_UI_TEST_KEY" } },
  });
}

const knowledge = (...parts: string[]) => path.join(ctx.storage.stashDir, "knowledge", ...parts);

describe("reads that follow a document", () => {
  test("asset navigation resolves indexed relative targets within the owning bundle and keeps fragment selectors", async () => {
    await seed();
    fs.writeFileSync(
      knowledge("guide.md"),
      `${GUIDE}\n## Details\n[notes](notes.md#notes) [missing](missing.md) [unsafe](javascript:bad)\n`,
    );
    await akmIndex({ stashDir: ctx.storage.stashDir, full: true });
    const result = await out(assets.show({ ref: "knowledge/guide" }));
    expect(result.links).toEqual({ "notes.md#notes": "stash//knowledge/notes#notes" });
    expect(result.headings.map((h: Json) => h.slug)).toEqual(["deploy-guide", "details"]);
  });

  test("search forwards explicit historical and scope controls without recording usage", async () => {
    await seed();
    for (const [name, belief, user] of [
      ["current", "active", "alice"],
      ["old", "deprecated", "alice"],
      ["other", "active", "bob"],
    ]) {
      fs.writeFileSync(
        path.join(ctx.storage.stashDir, "memories", `${name}.md`),
        `---\ntitle: Gateway\ndescription: Gateway memory\nbeliefState: ${belief}\nscope:\n  user: ${user}\n---\n# Gateway\nUse the gateway.\n`,
      );
    }
    await akmIndex({ stashDir: ctx.storage.stashDir, full: true });
    const scope = { user: "alice" };
    const current = await out(assets.search({ q: "gateway", type: "memory", scope }));
    const historical = await out(assets.search({ q: "gateway", type: "memory", belief: "historical", scope }));
    const all = await out(assets.search({ q: "gateway", type: "memory", belief: "all", scope }));
    expect(current.hits.map((h: Json) => h.name)).toEqual(["current"]);
    expect(historical.hits.map((h: Json) => h.name)).toEqual(["old"]);
    const direct = await akmSearch({
      query: "gateway",
      type: "memory",
      source: "local",
      belief: "all",
      filters: { user: "alice" },
      readOnly: true,
    });
    expect(all.hits.map((h: Json) => h.ref)).toEqual(direct.hits.flatMap((h) => ("ref" in h ? [h.ref] : [])));
    await expectUsage(() => assets.search({ q: "", belief: "invalid" }));
  });

  test("document history is file-scoped, read-only and only accepts returned revision IDs", async () => {
    await seed();
    fs.writeFileSync(knowledge("guide.md"), `${GUIDE}\nReviewed procedure.\n`);
    git(ctx.storage.stashDir, ["add", "knowledge/guide.md"]);
    git(ctx.storage.stashDir, ["commit", "-qm", "Review guide"]);
    const indexBefore = dbSnapshot(getDbPath());
    const stateBefore = dbSnapshot(getStateDbPath());
    const history = await out(assets.history({ ref: "knowledge/guide" }));
    expect(history.available).toBe(true);
    expect(history.commits).toHaveLength(2);
    expect(history.commits[0].subject).toBe("Review guide");
    const revision = history.commits[0].sha;
    const selected = await out(assets.history({ ref: "knowledge/guide", revision }));
    expect(selected.diff.before).toBe(GUIDE);
    expect(selected.diff.after).toBe(`${GUIDE}\nReviewed procedure.\n`);
    expect(selected.diff.unified).toContain("+Reviewed procedure.");
    await expectUsage(() => assets.history({ ref: "knowledge/guide", revision: "HEAD" }));
    expect((await out(assets.history({ ref: "env/prod" }))).available).toBe(false);
    expect(dbSnapshot(getDbPath())).toBe(indexBefore);
    expect(dbSnapshot(getStateDbPath())).toBe(stateBefore);
    fs.rmSync(path.join(ctx.storage.stashDir, ".git"), { recursive: true });
    expect((await out(assets.history({ ref: "knowledge/guide" }))).available).toBe(false);
  });
});

describe("feedback", () => {
  test("enforces CLI reason policy and persists user-attributed tags, counts and ranking effects", async () => {
    await seed();
    const missing = await expectUsage(() => feedback.record({ ref: "stash//knowledge/guide", signal: "negative" }));
    expect(missing.message).toContain("reason");
    const result = await withEnv({ AKM_EVENT_SOURCE: undefined }, () =>
      out(
        feedback.record({
          ref: "stash//knowledge/guide",
          signal: "positive",
          reason: "Clear procedure",
          tags: ["status:tested", "team:platform"],
        }),
      ),
    );
    expect(result.rankingUpdate.applied).toBe(true);
    const asset = await out(assets.show({ ref: "stash//knowledge/guide" }));
    expect(asset.feedback.counts.positive).toBe(2);
    expect(asset.feedback.history).toContainEqual(
      expect.objectContaining({
        signal: "positive",
        source: "user",
        reason: "Clear procedure",
        tags: ["status:tested", "team:platform"],
      }),
    );
    // A reload observes the stored event; there is no in-memory vote store.
    expect((await out(assets.show({ ref: "knowledge/guide" }))).feedback.counts.positive).toBe(2);
    // An ambient event source (an improve or task run driving the host) wins over the default, as for every akm run.
    await withEnv({ AKM_EVENT_SOURCE: "improve" }, () =>
      feedback.record({ ref: "stash//knowledge/guide", signal: "positive", reason: "Ambient run" }),
    );
    expect((await out(assets.show({ ref: "knowledge/guide" }))).feedback.history).toContainEqual(
      expect.objectContaining({ signal: "positive", source: "improve", reason: "Ambient run" }),
    );
    writeSandboxConfig({ ...loadConfig(), feedback: { requireReason: false } });
    await feedback.record({ ref: "stash//knowledge/guide", signal: "negative" });
  });

  test("a suggested fix needs at least one pair and at most ten", async () => {
    await seed();
    const ref = "stash//knowledge/guide";
    const bad = (fix: unknown, source?: string) =>
      feedback.record({ ref, signal: "negative", reason: "wrong", fix, source } as never);
    await expectUsage(() => bad([]));
    await expectUsage(() => bad("a"));
    await expectUsage(() => bad([{ replace: "a" }]));
    await expectUsage(() => bad([{ replace: 1, with: "b" }]));
    const many = Array.from({ length: 11 }, (_, i) => ({ replace: `x${i}`, with: `x${i}` }));
    await expectUsage(() => bad(many));
    // A pair whose text does not occur is the CLI's refusal, not a crash.
    const missing = await bad([{ replace: "text that is not in the guide", with: "anything" }], "docs").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(missing, "a fix whose text is absent is refused").toBeInstanceOf(AkmError);
  });

  test("feedback succeeds under a legacy literal apiKey and leaves config bytes untouched", async () => {
    await seed();
    const current = loadConfig();
    writeSandboxConfig({
      ...current,
      connections: { default: { ...current.connections!.default!, apiKey: PLANTED_API_KEY } },
    });
    const configPath = getConfigPath();
    const before = fs.readFileSync(configPath, "utf8");
    await feedback.record({ ref: "knowledge/guide", signal: "positive", reason: "Works" });
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(fs.readFileSync(configPath, "utf8")).toContain(PLANTED_API_KEY);
  });
});

describe("bundle settings and config", () => {
  test("settings save only allowed fields and preserve secrets, unknown values and disabled/default state", async () => {
    await writableConfig();
    const current = loadConfig();
    writeSandboxConfig({
      ...current,
      // A disabled bundle cannot be a default, and settings no longer edit the defaults.
      defaultBundle: undefined,
      bundles: {
        ...current.bundles,
        stash: {
          ...current.bundles!.stash!,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
      },
      unrelated: { keep: [1, "two"] },
    });
    // Fields beyond the typed input are ignored, not applied.
    const changed = await bundles.setSettings({
      bundle: "stash",
      enabled: false,
      writable: false,
      componentWritability: { main: false },
      connections: { default: { apiKey: "[redacted]" } },
      unrelated: "overwrite attempt",
    } as never);
    expect(changed).toEqual({ saved: true });
    const saved = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    expect(saved.bundles.stash).toMatchObject({
      enabled: false,
      writable: false,
      components: { main: { writable: false } },
    });
    expect(saved.connections.default.apiKey).toBe("$AKM_UI_TEST_KEY");
    expect(saved.someToken).toBe(PLANTED_CONFIG_TOKEN);
    expect(saved.unrelated).toEqual({ keep: [1, "two"] });
    const listed = await out(bundles.list());
    expect(listed.bundles.find((b: Json) => b.name === "stash")).toMatchObject({ enabled: false, writable: false });
    await expectUsage(() => bundles.setSettings({ bundle: "constructor", enabled: true }));
    await expectUsage(() => bundles.setSettings({ bundle: "stash", componentWritability: { constructor: true } }));
    // The defaults are edited through config only; settings ignore them.
    expect(bundles.setSettings({ defaultBundle: "stash" } as never)).toEqual({ saved: false });
  });

  test("config change validates like the CLI, keeps secrets and unrelated keys, and unsets", async () => {
    await writableConfig();
    writeSandboxConfig({ ...loadConfig(), unrelated: { keep: [1, "two"] } });
    const changed = config.change({
      set: { semanticSearchMode: "auto", "output.detail": "full", "feedback.requireReason": "true" },
    });
    expect(changed).toEqual({ saved: true });
    const saved = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    expect(saved).toMatchObject({
      semanticSearchMode: "auto",
      output: { detail: "full" },
      feedback: { requireReason: true },
    });
    expect(saved.connections.default.apiKey).toBe("$AKM_UI_TEST_KEY");
    expect(saved.someToken).toBe(PLANTED_CONFIG_TOKEN);
    expect(saved.unrelated).toEqual({ keep: [1, "two"] });
    // Schema errors, literal API keys and configVersion are refused, and nothing is written.
    await expectUsage(() => config.change({ set: { "output.detail": "loud" } }));
    await expectUsage(() => config.change({ set: { "connections.default.apiKey": "sk-literal" } }));
    await expectUsage(() => config.change({ set: { configVersion: "1" } }));
    await expectUsage(() => config.change({ set: { semanticSearchMode: 1 } } as never));
    expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).output.detail).toBe("full");
    expect(config.change({ unset: ["output.detail"] })).toEqual({ saved: true });
    expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).output?.detail).toBeUndefined();
    expect(config.change({})).toEqual({ saved: false });
  });

  test("config changeProjects adds, edits, renames and removes projects, validates, and reports akm's warnings", async () => {
    await writableConfig();
    writeSandboxConfig({ ...loadConfig(), unrelated: { keep: [1] } });
    const configPath = getConfigPath();
    const saved = () => JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(
      config.changeProjects({
        set: {
          "acme.corp": { paths: ["~/clients/acme"], filters: { channel: ["acme", ""] }, write: { channel: "acme" } },
          akm: { paths: ["/work/akm"] },
        },
      }),
    ).toEqual({ saved: true });
    expect(saved().projects["acme.corp"].filters).toEqual({ channel: ["acme", ""] });
    expect(saved().unrelated).toEqual({ keep: [1] });

    // A rename is the new name set and the old one unset, in one write; an edit replaces the whole entry.
    expect(config.changeProjects({ set: { acme: { paths: ["/work/acme"] } }, unset: ["acme.corp"] })).toEqual({
      saved: true,
    });
    expect(Object.keys(saved().projects).sort()).toEqual(["acme", "akm"]);
    expect(saved().projects.acme).toEqual({ paths: ["/work/acme"] });
    expect(config.changeProjects({ unset: ["akm"] })).toEqual({ saved: true });
    expect(Object.keys(saved().projects)).toEqual(["acme"]);
    expect(config.changeProjects({})).toEqual({ saved: false });

    // akm's schema decides what is accepted; a refusal writes nothing.
    const before = fs.readFileSync(configPath, "utf8");
    await expectUsage(() => config.changeProjects({ set: { none: { paths: ["/x"] } } }));
    await expectUsage(() => config.changeProjects({ set: { " ": {} } }));
    await expectUsage(() => config.changeProjects({ set: { bad: "x" } } as never));
    await expectAkmError(() => config.changeProjects({ set: { bad: { paths: "x" } } } as never), { kind: "config" });
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);

    // A malformed entry written by hand is ignored with akm's own warning, which config.get returns.
    fs.writeFileSync(
      configPath,
      JSON.stringify({ ...saved(), projects: { ...saved().projects, hand: { paths: ["relative"], from: 3 } } }),
    );
    resetConfigCache();
    const warnings = (config.get() as { projectWarnings: string[] }).projectWarnings;
    expect(warnings.some((w) => w.includes("projects.hand.paths") && w.includes("must be an absolute path"))).toBe(
      true,
    );
    expect(warnings.some((w) => w.includes("projects.hand.from"))).toBe(true);
  });

  test("changeProjects writes a project whole, refuses what the file does not hold, and keeps projects unredacted", async () => {
    await writableConfig();
    const configPath = getConfigPath();
    const saved = () => JSON.parse(fs.readFileSync(configPath, "utf8"));
    writeSandboxConfig({
      ...loadConfig(),
      projects: {
        acme: { paths: ["/srv/acme"] },
        hand: { paths: ["relative", "/srv/hand"], from: 3 },
        "acme.corp": "not a project",
      },
    });
    const get = () => config.get() as unknown as { config: { projects: Record<string, unknown> } };

    // A project akm ignores is not read, dotted names included.
    expect(Object.keys(get().config.projects).sort()).toEqual(["acme", "hand"]);

    // Editing a malformed local entry clears what akm ignored.
    expect(config.changeProjects({ set: { hand: { paths: ["/srv/hand2"] } } })).toEqual({ saved: true });
    expect(saved().projects.hand).toEqual({ paths: ["/srv/hand2"] });
    expect(get().config.projects.hand).toEqual({ paths: ["/srv/hand2"] });

    // A malformed local entry saved unchanged from the form (its effective value) is rewritten, and its warning is gone.
    writeSandboxConfig({ ...saved(), projects: { ...saved().projects, bad: { paths: ["relative", "/srv/bad"] } } });
    expect(get().config.projects.bad).toEqual({ paths: ["/srv/bad"] });
    expect(config.changeProjects({ set: { bad: { paths: ["/srv/bad"] } } })).toEqual({ saved: true });
    expect(saved().projects.bad).toEqual({ paths: ["/srv/bad"] });
    expect((get() as unknown as { projectWarnings: string[] }).projectWarnings.join()).not.toContain("projects.bad");

    // A project the file does not hold cannot be unset or renamed, and nothing is written.
    const before = fs.readFileSync(configPath, "utf8");
    await expectUsage(() => config.changeProjects({ unset: ["acme.corp"] }), "TARGET_NOT_UPDATABLE");
    await expectUsage(() => config.changeProjects({ unset: ["nope"] }), "TARGET_NOT_UPDATABLE");
    await expectUsage(
      () => config.changeProjects({ set: { renamed: { paths: ["/srv/dot"] } }, unset: ["acme.corp"] }),
      "TARGET_NOT_UPDATABLE",
    );
    for (const name of ["__proto__", "constructor", "prototype"])
      await expectUsage(() => config.changeProjects({ set: { [name]: {} } }));
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);

    // A set that changes nothing neither rewrites the file nor backs it up.
    const mtime = fs.statSync(configPath).mtimeMs;
    expect(config.changeProjects({ set: { acme: { paths: ["/srv/acme"] } } })).toEqual({ saved: false });
    expect(fs.statSync(configPath).mtimeMs).toBe(mtime);

    // Values that look like secrets are not redacted: a save would write "[redacted]" back.
    config.changeProjects({
      set: { acme: { paths: ["/srv/acme"], filters: { env: "prod" }, write: { metadata: { tokenBudget: 5 } } } },
    });
    expect(get().config.projects.acme).toEqual({
      paths: ["/srv/acme"],
      filters: { env: "prod" },
      write: { metadata: { tokenBudget: 5 } },
    });
  });

  test("config unset refuses an entry akm ignores, and does nothing without a config file", async () => {
    await seed();
    const configPath = getConfigPath();
    fs.writeFileSync(
      configPath,
      JSON.stringify({ configVersion: "0.9.0", connections: { draft: { models: { fast: "m" } } } }),
    );
    resetConfigCache();
    const before = fs.readFileSync(configPath, "utf8");
    await expectUsage(
      () => config.change({ unset: ["connections.draft.models.fast"] }),
      "TARGET_NOT_UPDATABLE",
      'connection "draft", which akm ignores',
    );
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);

    fs.rmSync(configPath);
    resetConfigCache();
    expect(config.change({ unset: ["output.detail"] })).toEqual({ saved: false });
    expect(fs.existsSync(configPath)).toBe(false);
    // A set alongside an unset still creates the file.
    expect(config.change({ set: { "output.detail": "full" }, unset: ["output.format"] })).toEqual({ saved: true });
    expect(fs.existsSync(configPath)).toBe(true);
  });

  test("config-affecting actions refuse unrelated sanitizer changes rather than losing registry credentials", async () => {
    await seed();
    writeSandboxConfig({
      registries: [
        { url: `https://bot:${PLANTED_REGISTRY_PASSWORD}@registry.example.test/index.json`, name: "private" },
      ],
    });
    const configPath = getConfigPath();
    const before = fs.readFileSync(configPath, "utf8");
    const attempts: Array<[string, () => Promise<unknown> | unknown]> = [
      ["settings", () => bundles.setSettings({ bundle: "stash", writable: false })],
      ["add", () => bundles.add({ source: ctx.storage.stashDir, name: "renamed" })],
      ["remove", () => bundles.remove({ bundle: "stash", confirm: true })],
      ["rename", () => bundles.rename({ bundle: "stash", name: "renamed" })],
    ];
    for (const [name, attempt] of attempts) {
      const error = await expectUsage(attempt, "INVALID_FLAG_VALUE", "sanitizer");
      expect(error.message, name).not.toContain(PLANTED_REGISTRY_PASSWORD);
      expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    }
    // A rename preview writes nothing, so it is not refused.
    await bundles.rename({ bundle: "stash", name: "renamed", dryRun: true });
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    // A settings request that changes nothing writes nothing, so it is not refused.
    expect(bundles.setSettings({})).toEqual({ saved: false });
    // `bundle update` writes only the lockfile, so the config guard does not apply.
    await bundles.update({ bundle: "stash" });
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
  });
});

describe("bundle lifecycle", () => {
  test("bundle lifecycle uses real local-source add, update and confirmed remove operations", async () => {
    await writableConfig();
    const source = path.join(ctx.storage.root, "extra");
    fs.mkdirSync(path.join(source, "knowledge"), { recursive: true });
    fs.writeFileSync(path.join(source, "knowledge", "extra.md"), "# Extra\nFirst revision.\n");
    await bundles.add({ source, name: "extra" });
    expect((await out(bundles.list())).bundles.map((b: Json) => b.name)).toContain("extra");
    // The asset view reads a local-dir bundle live from disk, so the update is observed through the index.
    const indexed = async () =>
      (await out(assets.search({ q: "zephyrrevision", bundle: "extra" }))).hits.map((h: Json) => h.ref);
    fs.writeFileSync(path.join(source, "knowledge", "extra.md"), "# Extra\nUpdated zephyrrevision.\n");
    expect(await indexed()).toEqual([]);
    await bundles.update({ bundle: "extra" });
    expect(await indexed()).toEqual(["extra//knowledge/extra"]);
    await expectUsage(() => bundles.remove({ bundle: "extra", confirm: false }));
    await bundles.remove({ bundle: "extra", confirm: true });
    expect((await out(bundles.list())).bundles.map((b: Json) => b.name)).not.toContain("extra");
    expect(fs.existsSync(path.join(source, "knowledge", "extra.md"))).toBe(true);
  });

  test("bundle rename previews with --dry-run, then renames through the CLI", async () => {
    await writableConfig();
    const preview = await out(bundles.rename({ bundle: "stash", name: "renamed", dryRun: true }));
    expect(preview.applied).toBe(false);
    expect((await out(bundles.list())).bundles.map((b: Json) => b.name)).toContain("stash");
    const renamed = await out(bundles.rename({ bundle: "stash", name: "renamed" }));
    expect(renamed.applied).toBe(true);
    expect(renamed.newId).toBe("renamed");
    const names = (await out(bundles.list())).bundles.map((b: Json) => b.name);
    expect(names).toContain("renamed");
    expect(names).not.toContain("stash");
    await expectAkmError(bundles.rename({ bundle: "missing", name: "other" }), { kind: "not-found" });
  });

  test("bundle names that begin with a dash can be updated and removed", async () => {
    await writableConfig();
    const source = path.join(ctx.storage.root, "dash");
    fs.mkdirSync(path.join(source, "knowledge"), { recursive: true });
    fs.writeFileSync(path.join(source, "knowledge", "dash.md"), "# Dash\n");
    await bundles.add({ source, name: "-dash" });
    // Without `--` before the name, the CLI reads it as an unknown flag.
    const updated = await out(bundles.update({ bundle: "-dash" }));
    expect(updated.target).toBe("-dash");
    const removed = await out(bundles.remove({ bundle: "-dash", confirm: true }));
    expect(removed.removed.id).toBe("-dash");
    expect((await out(bundles.list())).bundles.map((b: Json) => b.name)).not.toContain("-dash");
  });

  test("a child's exit code maps to the CLI contract, and a malformed success is not an AkmError", async () => {
    await seed();
    const child = (name: string, script: string) => {
      const file = path.join(ctx.storage.root, `${name}.js`);
      fs.writeFileSync(file, script);
      return { argv: [process.execPath, file], via: "checkout" as const };
    };
    const fail = (exit: number, code: string) =>
      child(
        `exit-${exit}`,
        `process.stderr.write(${JSON.stringify(`${JSON.stringify({ ok: false, error: `exit ${exit}`, code })}\n`)}); process.exit(${exit});`,
      );
    const run = async (invocation: ReturnType<typeof child>) => {
      const spy = spyOn(akmBin, "resolveAkmInvocation").mockReturnValue(invocation);
      try {
        return await bundles.update({ bundle: "stash" }).then(
          () => undefined,
          (error: unknown) => error,
        );
      } finally {
        spy.mockRestore();
      }
    };

    // The transport's 500s: the operation's error is not an AkmError.
    const malformed = await run(child("malformed", 'process.stdout.write("not json\\n");'));
    expect(malformed).toBeInstanceOf(InvalidCommandResponse);
    expect(malformed).not.toBeInstanceOf(AkmError);
    expect((malformed as InvalidCommandResponse).code).toBe("INVALID_COMMAND_RESPONSE");
    const internal = await run(fail(70, "INTERNAL_ERROR"));
    expect(internal).toBeInstanceOf(Error);
    expect(internal).not.toBeInstanceOf(AkmError);

    // Exit 1 not-found, 2 usage, 75 retryable conflict, 78 config: each keeps its kind and code.
    const cases: Array<[number, string, AkmError["kind"]]> = [
      [1, "ASSET_NOT_FOUND", "not-found"],
      [2, "INVALID_FLAG_VALUE", "usage"],
      [75, "ASSET_MUTATION_LEASE_HELD", "transient"],
      [78, "INVALID_CONFIG_FILE", "config"],
    ];
    for (const [exit, code, kind] of cases) {
      const error = await run(fail(exit, code));
      expect(error, `exit ${exit}`).toBeInstanceOf(AkmError);
      expect({ exit, kind: (error as AkmError).kind, code: (error as AkmError).code }).toEqual({ exit, kind, code });
    }
  });
});

describe("documents", () => {
  test("knowledge creation preserves Markdown through import and refuses overwrites and path escapes", async () => {
    await writableConfig();
    const content =
      "---\ntitle: New knowledge\ncustom: [keep, me]\n---\n# New knowledge\n\n| A | B |\n| --- | --- |\n| one | two |\n";
    await documents.createKnowledge({ bundle: "stash", name: "new", content });
    const read = await out(assets.show({ ref: "stash//knowledge/new" }));
    expect(read.asset.content).toContain("custom:");
    expect(read.asset.content).toContain("| one | two |");
    const before = fs.readFileSync(knowledge("new.md"), "utf8");
    await expectAkmError(documents.createKnowledge({ bundle: "stash", name: "new", content: "overwrite" }), {
      kind: "usage",
      code: "RESOURCE_ALREADY_EXISTS",
    });
    expect(fs.readFileSync(knowledge("new.md"), "utf8")).toBe(before);
    const escaped = await expectUsage(
      () => documents.createKnowledge({ bundle: "stash", name: "escape", path: "../../outside", content }),
      "INVALID_FLAG_VALUE",
    );
    expect(escaped.message).toBe("--path must be a relative directory without '.' or '..' segments.");
    expect(filesNamed(ctx.storage.root, "escape.md")).toEqual([]);
  });

  test("a refused knowledge creation with a large body is an ordinary refusal, not a hang or a broken pipe", async () => {
    await writableConfig();
    const content = "x".repeat(1024 * 1024);
    await expectUsage(() => documents.createKnowledge({ bundle: "missing", name: "reject", content }));
  });

  test("knowledge creation succeeds under a legacy literal apiKey and leaves config bytes untouched", async () => {
    await seed();
    const current = loadConfig();
    writeSandboxConfig({
      ...current,
      connections: { default: { ...current.connections!.default!, apiKey: PLANTED_API_KEY } },
    });
    const configPath = getConfigPath();
    const before = fs.readFileSync(configPath, "utf8");
    await documents.createKnowledge({ bundle: "stash", name: "literal-key", content: "# Created\n" });
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(fs.readFileSync(knowledge("literal-key.md"), "utf8")).toContain("# Created");
    expect(fs.readFileSync(configPath, "utf8")).toContain(PLANTED_API_KEY);
  });

  test("source editing uses live full Markdown, preserves nested targets and rejects stale saves without mutation", async () => {
    await seed();
    const file = knowledge("review", "guide.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, GUIDE);
    await akmIndex({ stashDir: ctx.storage.stashDir, full: true });
    // Deliberately newer than the indexed hash, with formatting the display/serializer must not invent.
    const live = "---\n# Keep comment\ntitle: 'Live title'\ncustom: [keep, me]\n---\n# Live guide\n\nOriginal body.\n";
    fs.writeFileSync(file, live);
    const source = await out(documents.readSource({ ref: "stash//knowledge/review/guide" }));
    expect(source).toMatchObject({ ref: "stash//knowledge/review/guide", type: "knowledge", content: live });
    expect(source.revision).toBe(createHash("sha256").update(live).digest("hex"));
    const mtime = fs.statSync(file, { bigint: true }).mtimeNs;
    const noop = { events: countRows("events"), index: dbSnapshot(getDbPath()) };
    const unchanged = await out(documents.save(source as never));
    expect(unchanged.unchanged).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(live);
    expect(fs.statSync(file, { bigint: true }).mtimeNs).toBe(mtime);
    // No event and no reindex. (This filesystem bundle has no commit path, so commits are not asserted.)
    expect({ events: countRows("events"), index: dbSnapshot(getDbPath()) }).toEqual(noop);
    const changed = `${live}\nquasarprocedure verified.\n`;
    await documents.save({ ...source, content: changed } as never);
    const saved = fs.readFileSync(file, "utf8");
    expect(saved).toContain("# Keep comment\ntitle: 'Live title'\ncustom: [keep, me]");
    expect(saved).toContain("quasarprocedure verified");
    expect(fs.readFileSync(knowledge("guide.md"), "utf8")).toBe(GUIDE);
    expect((await out(assets.search({ q: "quasarprocedure" }))).hits.map((h: Json) => h.ref)).toContain(
      "knowledge/review/guide",
    );
    const indexBefore = dbSnapshot(getDbPath());
    const stateBefore = dbSnapshot(getStateDbPath());
    await expectConflict(documents.save({ ...source, content: "Stale draft" } as never), "ASSET_CONTENT_CHANGED");
    expect(fs.readFileSync(file, "utf8")).toBe(saved);
    expect(dbSnapshot(getDbPath())).toBe(indexBefore);
    expect(dbSnapshot(getStateDbPath())).toBe(stateBefore);
  });

  test("memory editing reuses the writer and refuses unsupported, read-only or redacted source", async () => {
    await seed();
    const memory = path.join(ctx.storage.stashDir, "memories", "note.md");
    const credentials = knowledge("private-url.md");
    fs.writeFileSync(memory, "---\ntitle: Memory\n---\n# Memory\nRemember this.\n");
    const secretSource = "# Private link\n[link](https://user:private-password@example.test/path)\n";
    fs.writeFileSync(credentials, secretSource);
    await akmIndex({ stashDir: ctx.storage.stashDir, full: true });
    const source = await out(documents.readSource({ ref: "memories/note" }));
    expect(source.type).toBe("memory");
    await documents.save({ ...source, content: `${source.content}\nUpdated memory.\n` } as never);
    expect(fs.readFileSync(memory, "utf8")).toContain("Updated memory.");
    const refusals: Array<[string, "usage" | "not-found", string, string]> = [
      ["env/prod", "usage", "INVALID_FLAG_VALUE", "Only knowledge and memory support source editing in this UI."],
      [
        "knowledge/guide#deploy-guide",
        "usage",
        "INVALID_FLAG_VALUE",
        'Export fragment "#deploy-guide" is not accepted here — drop it from "knowledge/guide#deploy-guide".',
      ],
      ["knowledge/missing", "not-found", "ASSET_NOT_FOUND", "Stash asset not found for ref: knowledge/missing."],
      [
        "knowledge/private-url",
        "usage",
        "INVALID_FLAG_VALUE",
        "This document contains URL credentials hidden by the UI. Edit it outside the UI to preserve those values.",
      ],
    ];
    for (const [ref, kind, code, message] of refusals) {
      const error = await expectAkmError(documents.readSource({ ref }), { kind, code });
      expect(error.message).not.toContain("private-password");
      expect(error.message, ref).toStartWith(message);
    }
    const rejected = await expectUsage(
      () =>
        documents.save({
          ref: "stash//knowledge/private-url",
          revision: createHash("sha256").update(secretSource).digest("hex"),
          content: "# Replacement\n",
        }),
      "INVALID_FLAG_VALUE",
    );
    expect(rejected.message).toBe(
      "This document contains URL credentials hidden by the UI. Edit it outside the UI to preserve those values.",
    );
    expect(fs.readFileSync(credentials, "utf8")).toBe(secretSource);
    const current = loadConfig();
    writeSandboxConfig({
      ...current,
      bundles: { ...current.bundles, stash: { ...current.bundles!.stash!, writable: false } },
    });
    // A read-only bundle is a refusal the owner can address, not a failure of akm.
    const readOnlyRead = await expectAkmError(documents.readSource({ ref: "knowledge/guide" }), {
      kind: "config",
      code: "INVALID_CONFIG_FILE",
    });
    expect(readOnlyRead.message).toBe("source stash is not writable");
    const readOnly = await expectAkmError(documents.save(source as never), {
      kind: "config",
      code: "INVALID_CONFIG_FILE",
    });
    expect(readOnly.message).toBe("source stash is not writable");
    expect(fs.readFileSync(memory, "utf8")).toContain("Updated memory.");
  });

  test("a document over 64 KiB can be saved and created", async () => {
    await seed();
    const file = knowledge("guide.md");
    const source = await out(documents.readSource({ ref: "knowledge/guide" }));
    const content = `${source.content}\n${"A long procedure line.\n".repeat(4000)}`;
    expect(Buffer.byteLength(content)).toBeGreaterThan(64 * 1024);
    await documents.save({ ...source, content } as never);
    expect(fs.statSync(file).size).toBeGreaterThan(64 * 1024);
    await documents.createKnowledge({ bundle: "stash", name: "large", content });
    expect(fs.statSync(knowledge("large.md")).size).toBeGreaterThan(64 * 1024);
  });

  test("saves and creates fail fast with a retryable conflict while another writer holds the lease", async () => {
    await seed();
    const source = await out(documents.readSource({ ref: "knowledge/guide" }));
    const lease = await acquireAssetMutationLease({ purpose: "test-holder", mode: "try" });
    expect(lease).toBeDefined();
    const message = "Another akm process or request is writing to the bundle right now. Try again in a moment.";
    try {
      const save = await expectConflict(
        documents.save({ ...source, content: `${source.content}\nHeld.\n` } as never),
        "ASSET_MUTATION_LEASE_HELD",
      );
      expect(save.message).toBe(message);
      const create = await expectConflict(
        documents.createKnowledge({ bundle: "stash", name: "held", content: "# Held\n" }),
        "ASSET_MUTATION_LEASE_HELD",
      );
      expect(create.message).toBe(message);
    } finally {
      lease?.release();
    }
    expect(fs.readFileSync(knowledge("guide.md"), "utf8")).toBe(GUIDE);
    expect(fs.existsSync(knowledge("held.md"))).toBe(false);
  }, 15_000);

  test("a save after the document was deleted is refused and does not recreate it", async () => {
    await seed();
    const file = knowledge("notes.md");
    const source = await out(documents.readSource({ ref: "knowledge/notes" }));
    fs.rmSync(file);
    await expectAkmError(documents.save({ ...source, content: `${source.content}\nEdited.\n` } as never), {
      kind: "not-found",
      code: "ASSET_NOT_FOUND",
    });
    expect(fs.existsSync(file)).toBe(false);
  });

  test("a symlinked document outside the bundle is read but never written through; a symlinked directory is not followed", async () => {
    await seed();
    const outside = path.join(ctx.storage.root, "outside-bundle");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "target.md"), NOTES);
    fs.symlinkSync(path.join(outside, "target.md"), knowledge("linked.md"));
    fs.symlinkSync(outside, knowledge("linkdir"));
    await akmIndex({ stashDir: ctx.storage.stashDir, full: true });
    // A file symlink is read like any other file (#1237), but a write never follows a symlink out of the bundle.
    expect((await out(documents.readSource({ ref: "knowledge/linked" }))).content).toBe(NOTES);
    const linkedSave = await expectUsage(() =>
      documents.save({ ref: "knowledge/linked", revision: sha256(NOTES), content: "# Replaced\n" }),
    );
    expect(linkedSave.message).toContain("escapes the stash");
    // A directory symlink is never descended, so nothing under it resolves.
    const ref = "knowledge/linkdir/target";
    await expectAkmError(documents.readSource({ ref }), { kind: "not-found", code: "ASSET_NOT_FOUND" });
    await expectAkmError(documents.save({ ref, revision: sha256(NOTES), content: "# Replaced\n" }), {
      kind: "not-found",
      code: "ASSET_NOT_FOUND",
    });
    expect(fs.readFileSync(path.join(outside, "target.md"), "utf8")).toBe(NOTES);
  });

  test("a ref that escapes the bundle is refused by save and writes nothing outside", async () => {
    await seed();
    for (const ref of ["knowledge/../../escaped", "stash//knowledge/../../../escaped"]) {
      const error = await expectUsage(
        () => documents.save({ ref, revision: sha256(""), content: "# Escaped\n" }),
        "PATH_ESCAPE_VIOLATION",
      );
      expect(error.message).toBe("Asset name cannot contain relative path segments.");
    }
    expect(filesNamed(ctx.storage.root, "escaped.md")).toEqual([]);
  });
});
