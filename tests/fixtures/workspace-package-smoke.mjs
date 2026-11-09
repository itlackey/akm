import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The caller provides a new, isolated home before this process starts.
const root = process.env.HOME;
assert.ok(root?.includes("akm-workspace-package-"));
const stash = path.join(root, "stash");
const catalog = path.join(root, "catalog");
fs.mkdirSync(path.join(stash, "knowledge"), { recursive: true });
fs.mkdirSync(path.join(catalog, "knowledge"), { recursive: true });
fs.writeFileSync(path.join(catalog, "knowledge", "reference.md"), "# Reference\nSynthetic catalog content.\n");
fs.mkdirSync(process.env.AKM_CONFIG_DIR, { recursive: true });
fs.writeFileSync(
  path.join(process.env.AKM_CONFIG_DIR, "config.json"),
  JSON.stringify({
    bundles: { stash: { path: stash, writable: true }, catalog: { path: catalog, writable: false } },
    defaultBundle: "stash",
    semanticSearchMode: "off",
  }),
);

const workspace = await import("akm-cli/workspace");
const {
  activity,
  assets,
  bundles,
  config,
  documents,
  feedback,
  proposals,
  sensitive,
  setup,
  AkmError,
  CONFLICT_CODES,
  scrubUrlCredentials,
} = workspace;
assert.equal(Boolean(process.versions.bun), process.argv[2] === "bun");
for (const [name, value] of Object.entries(workspace)) assert.notEqual(value, undefined, name);
for (const name of [
  "activity",
  "assets",
  "bundles",
  "config",
  "documents",
  "feedback",
  "proposals",
  "sensitive",
  "setup",
])
  assert.equal(typeof workspace[name], "object", name);
for (const name of [
  "UsageError",
  "NotFoundError",
  "ConfigError",
  "TransientError",
  "indexWrittenAssets",
  "scrubUrlCredentials",
])
  assert.equal(typeof workspace[name], "function", name);
for (const gone of ["handleApiRequest", "writeEnv", "withEnvSecretWrite", "akmClone"])
  assert.equal(workspace[gone], undefined, gone);

const pkg = fileURLToPath(import.meta.resolve("akm-cli/package.json"));
const cli = path.join(path.dirname(pkg), "dist", process.versions.bun ? "cli.js" : "cli-node.mjs");
execFileSync(process.execPath, [cli, "index", "--format=json"], { env: process.env, stdio: "pipe" });
assert.ok((await bundles.list()).bundles.length === 2);
assert.equal(typeof (await setup.detect()).stashDir, "string");
const created = await documents.createKnowledge({
  name: "desktop-note",
  bundle: "stash",
  content: "# Desktop note\nSynthetic workspace evidence.\n",
});
assert.ok(created);
assert.equal(created.shape, undefined);
assert.ok(
  fs.readFileSync(path.join(stash, "knowledge", "desktop-note.md"), "utf8").includes("Synthetic workspace evidence"),
);
assert.ok((await assets.search({ q: "Synthetic", bundle: "stash" })).hits.length > 0);
const source = await documents.readSource({ ref: "stash//knowledge/desktop-note" });
assert.equal(source.type, "knowledge");
assert.equal(source.revision.length, 64);
const content = source.content.replace("Synthetic workspace evidence", "Revised workspace evidence");
await documents.save({ ref: source.ref, revision: source.revision, content });
assert.ok(
  fs.readFileSync(path.join(stash, "knowledge", "desktop-note.md"), "utf8").includes("Revised workspace evidence"),
);
try {
  await documents.save({ ref: source.ref, revision: source.revision, content: source.content });
  assert.fail("stale revision should fail");
} catch (error) {
  assert.ok(error instanceof AkmError);
  assert.ok(CONFLICT_CODES.has(error.code));
}
const copied = await documents.copy({
  sourceRef: "catalog//knowledge/reference",
  target: "stash",
  newName: "copied-reference",
});
assert.equal(copied.overwritten, false);
assert.ok(fs.readFileSync(copied.destination.path, "utf8").includes("Synthetic catalog content"));
await assert.rejects(
  documents.copy({ sourceRef: "catalog//knowledge/reference", target: "stash", newName: "copied-reference" }),
);
await assert.rejects(documents.copy({ sourceRef: source.ref, target: "catalog" }));
await assert.rejects(documents.readSource({ ref: "catalog//knowledge/reference" }));
assert.deepEqual((await proposals.list()).proposals, []);
const corrected = await feedback.record({
  ref: source.ref,
  signal: "negative",
  reason: "Verified synthetic correction",
  source: "fixture",
  fix: [{ replace: "Revised workspace evidence", with: "Reviewed workspace evidence" }],
});
assert.ok(corrected.fix.proposalId);
const proposal = await proposals.get({ id: corrected.fix.proposalId });
assert.equal(proposal.proposal.status, "accepted");
const reverted = await proposals.revert({ id: corrected.fix.proposalId });
assert.equal(reverted.proposal.status, "reverted");
assert.ok(
  fs.readFileSync(path.join(stash, "knowledge", "desktop-note.md"), "utf8").includes("Revised workspace evidence"),
);
await config.change({ set: { "output.format": "text" } });
assert.equal(config.get().config.output.format, "text");
try {
  await proposals.accept({ id: "nonexistent" });
  assert.fail("missing proposal should fail");
} catch (error) {
  assert.equal(error.kind, "not-found");
}
assert.ok(
  !JSON.stringify(scrubUrlCredentials({ url: "https://example.test/?token=planted-credential" })).includes(
    "planted-credential",
  ),
);
// A host that edits a bundle file itself refreshes the index for it, and related content reports honestly without embeddings.
fs.mkdirSync(path.join(stash, "scripts"), { recursive: true });
fs.writeFileSync(path.join(stash, "scripts", "tool.sh"), "#!/bin/sh\necho one\n");
execFileSync(process.execPath, [cli, "index", "--format=json"], { env: process.env, stdio: "pipe" });
fs.writeFileSync(path.join(stash, "scripts", "tool.sh"), "#!/bin/sh\necho two\n");
assert.equal(
  await workspace.indexWrittenAssets(stash, [path.join(stash, "scripts", "tool.sh")], { bundleId: "stash" }),
  true,
);
assert.equal((await assets.related({ ref: source.ref })).available, false);
// Env and secret operations: create, describe, stale revision, replace, remove.
const made = await sensitive.save({ ref: "stash//secrets/smoke", content: "synthetic" });
assert.equal(made.ref, "stash//secrets/smoke");
await assert.rejects(sensitive.save({ ref: made.ref, content: "again" }));
const info = sensitive.describe({ ref: made.ref });
assert.equal(info.revision, made.revision);
assert.equal(sensitive.readValue({ ref: made.ref }).content, "synthetic");
await assert.rejects(sensitive.save({ ref: made.ref, content: "x", revision: "0".repeat(64) }), (error) =>
  CONFLICT_CODES.has(error.code),
);
const replaced = await sensitive.save({ ref: made.ref, content: "replaced", revision: made.revision });
assert.notEqual(replaced.revision, made.revision);
await sensitive.remove({ ref: made.ref, revision: replaced.revision });
assert.equal(fs.existsSync(info.path), false);
const current = await documents.readSource({ ref: source.ref });
const archived = await documents.retire({ ref: current.ref, revision: current.revision });
assert.equal(fs.existsSync(path.join(stash, "knowledge/desktop-note.md")), false);
assert.equal((await proposals.get({ id: archived.proposalId })).proposal.status, "accepted");
assert.ok(archived.archiveDirs.length > 0);
const restored = await proposals.revert({ id: archived.proposalId });
assert.equal(restored.proposal.status, "reverted");
assert.equal(fs.readFileSync(path.join(stash, "knowledge/desktop-note.md"), "utf8"), current.content);
for (const dir of archived.archiveDirs) assert.equal(fs.existsSync(path.join(stash, dir)), false);
assert.equal(typeof activity.meta().version, "string");
console.log(JSON.stringify({ ok: true, runtime: process.versions.bun ? "bun" : "node", version: process.version }));
