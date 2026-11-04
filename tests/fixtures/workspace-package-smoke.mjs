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
    defaultWriteTarget: "stash",
    semanticSearchMode: "off",
  }),
);

const workspace = await import("akm-cli/workspace");
const {
  akmClone,
  handleApiRequest,
  NO_SUCH_ROUTE,
  handleWorkspaceAction,
  matchWorkspaceAction,
  matchWriteRoute,
  handleWriteRequest,
  classifyWorkspaceError,
  classifyProposalError,
  scrubUrlCredentials,
  AkmError,
} = workspace;
assert.equal(Boolean(process.versions.bun), process.argv[2] === "bun");
assert.equal(Object.keys(workspace).length, 23);
for (const [name, value] of Object.entries(workspace)) assert.notEqual(value, undefined, name);
for (const name of [
  "UsageError",
  "writeEnv",
  "removeEnv",
  "setSecret",
  "removeSecret",
  "withEnvSecretWrite",
  "sensitiveMarkerPath",
  "deriveCanonicalAssetName",
])
  assert.equal(typeof workspace[name], "function", name);
assert.equal(await handleApiRequest("/not-a-route", new URLSearchParams()), NO_SUCH_ROUTE);
assert.equal(matchWorkspaceAction("/api/knowledge/create"), "knowledge-create");
assert.equal(matchWorkspaceAction("/unknown"), null);
assert.equal(matchWriteRoute("/unknown"), null);

const pkg = fileURLToPath(import.meta.resolve("akm-cli/package.json"));
const cli = path.join(path.dirname(pkg), "dist", process.versions.bun ? "cli.js" : "cli-node.mjs");
execFileSync(process.execPath, [cli, "index", "--format=json"], { env: process.env, stdio: "pipe" });
const read = (route, params = {}) => handleApiRequest(route, new URLSearchParams(params));
assert.ok((await read("/api/bundles")).bundles.length === 2);
const created = await handleWorkspaceAction("knowledge-create", {
  name: "desktop-note",
  bundle: "stash",
  content: "# Desktop note\nSynthetic workspace evidence.\n",
});
assert.ok(created);
assert.ok(
  fs.readFileSync(path.join(stash, "knowledge", "desktop-note.md"), "utf8").includes("Synthetic workspace evidence"),
);
assert.ok((await read("/api/search", { q: "Synthetic", bundle: "stash" })).hits.length > 0);
const source = await read("/api/asset/source", { ref: "stash//knowledge/desktop-note" });
assert.equal(source.type, "knowledge");
assert.equal(source.revision.length, 64);
const content = source.content.replace("Synthetic workspace evidence", "Revised workspace evidence");
await handleWorkspaceAction("document-save", { ref: source.ref, revision: source.revision, content });
assert.ok(
  fs.readFileSync(path.join(stash, "knowledge", "desktop-note.md"), "utf8").includes("Revised workspace evidence"),
);
try {
  await handleWorkspaceAction("document-save", { ref: source.ref, revision: source.revision, content: source.content });
  assert.fail("stale revision should fail");
} catch (error) {
  assert.ok(error instanceof AkmError);
  assert.equal(classifyWorkspaceError(error).status, 409);
}
const copied = await akmClone({
  sourceRef: "catalog//knowledge/reference",
  target: "stash",
  newName: "copied-reference",
});
assert.equal(copied.overwritten, false);
assert.ok(fs.readFileSync(copied.destination.path, "utf8").includes("Synthetic catalog content"));
await assert.rejects(
  akmClone({ sourceRef: "catalog//knowledge/reference", target: "stash", newName: "copied-reference" }),
);
await assert.rejects(akmClone({ sourceRef: source.ref, target: "catalog" }));
await assert.rejects(read("/api/asset/source", { ref: "catalog//knowledge/reference" }));
assert.deepEqual((await read("/api/proposals")).proposals, []);
const corrected = await handleWorkspaceAction("feedback", {
  ref: source.ref,
  signal: "negative",
  reason: "Verified synthetic correction",
  source: "fixture",
  replace: ["Revised workspace evidence"],
  with: ["Reviewed workspace evidence"],
});
assert.ok(corrected.fix.proposalId);
const proposal = await read(`/api/proposals/${corrected.fix.proposalId}`);
assert.equal(proposal.proposal.status, "accepted");
const reverted = await handleWriteRequest(matchWriteRoute(`/api/proposals/${corrected.fix.proposalId}/revert`), {});
assert.equal(reverted.proposal.status, "reverted");
assert.ok(
  fs.readFileSync(path.join(stash, "knowledge", "desktop-note.md"), "utf8").includes("Revised workspace evidence"),
);
await handleWorkspaceAction("config-set", { set: { "output.format": "text" } });
assert.equal((await read("/api/config")).config.output.format, "text");
const missing = matchWriteRoute("/api/proposals/nonexistent/accept");
assert.ok(missing);
try {
  await handleWriteRequest(missing, {});
  assert.fail("missing proposal should fail");
} catch (error) {
  assert.equal(classifyProposalError(error).status, 404);
}
assert.ok(
  !JSON.stringify(scrubUrlCredentials({ url: "https://example.test/?token=planted-credential" })).includes(
    "planted-credential",
  ),
);
// Another single-file type saves through the same route; related content reports honestly without embeddings.
fs.mkdirSync(path.join(stash, "scripts"), { recursive: true });
fs.writeFileSync(path.join(stash, "scripts", "tool.sh"), "#!/bin/sh\necho one\n");
execFileSync(process.execPath, [cli, "index", "--format=json"], { env: process.env, stdio: "pipe" });
const script = await read("/api/asset/source", { ref: "stash//scripts/tool.sh" });
await handleWorkspaceAction("document-save", {
  ref: script.ref,
  revision: script.revision,
  content: "#!/bin/sh\necho two\n",
});
assert.equal(fs.readFileSync(path.join(stash, "scripts", "tool.sh"), "utf8"), "#!/bin/sh\necho two\n");
assert.equal((await read("/api/asset/related", { ref: source.ref })).available, false);
// The env/secret operations the CLI uses.
const written = workspace.resolveSecretWriteTarget("secrets/smoke", "stash");
workspace.withEnvSecretWrite(written.target, { type: "secret", name: written.name }, "Update", [written.absPath], () =>
  workspace.setSecret(written.absPath, Buffer.from("synthetic")),
);
assert.equal(fs.readFileSync(written.absPath, "utf8"), "synthetic");
assert.equal(workspace.resolveSecretPath("stash//secrets/smoke").absPath, written.absPath);
assert.equal(
  workspace.withEnvSecretWrite(
    written.target,
    { type: "secret", name: written.name },
    "Remove",
    [written.absPath],
    () => workspace.removeSecret(written.absPath),
  ),
  true,
);
assert.equal(fs.existsSync(written.absPath), false);
const current = await read("/api/asset/source", { ref: source.ref });
const archived = await handleWorkspaceAction("document-retire", { ref: current.ref, revision: current.revision });
assert.equal(fs.existsSync(path.join(stash, "knowledge/desktop-note.md")), false);
assert.equal((await read(`/api/proposals/${archived.proposalId}`)).proposal.status, "accepted");
assert.ok(archived.archiveDirs.length > 0);
const restored = await handleWriteRequest(matchWriteRoute(`/api/proposals/${archived.proposalId}/revert`), {});
assert.equal(restored.proposal.status, "reverted");
assert.equal(fs.readFileSync(path.join(stash, "knowledge/desktop-note.md"), "utf8"), current.content);
for (const dir of archived.archiveDirs) assert.equal(fs.existsSync(path.join(stash, dir)), false);
console.log(JSON.stringify({ ok: true, runtime: process.versions.bun ? "bun" : "node", version: process.version }));
