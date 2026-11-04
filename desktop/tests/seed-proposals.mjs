// Test-only seeding uses AKM's own repository implementation, never product code or live data.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.env.AKM_DESKTOP_TEST_ROOT;
assert.ok(root && path.basename(root).startsWith("akm-desktop-fixture-"));
assert.equal(process.env.AKM_BUNDLE_DIR, path.join(root, "personal"));
await import("akm-cli/workspace");
const { createProposal } = await import("akm-cli/dist/commands/proposal/repository.js");
const note = fs.readFileSync(path.join(root, "personal/knowledge/restore-laptop.md"), "utf8");
const stash = process.env.AKM_BUNDLE_DIR;
const make = (ref, content) =>
  createProposal(stash, {
    ref,
    source: "reflect",
    sourceRun: "synthetic-desktop-test",
    payload: { content },
  }).id;
const document = (title, body) =>
  `---\ntitle: ${title}\ndescription: Synthetic desktop acceptance test guidance\n---\n# ${title}\n\n${body}\n`;
// Existing source gives AKM a real backup for native proposal reversion.
fs.writeFileSync(
  path.join(stash, "knowledge/review-example.md"),
  document(
    "Review example",
    "Original review guidance retained for the rollback check. Keep the source evidence alongside proposed changes and verify it before accepting an update.",
  ),
);
const ids = {
  stale: make("knowledge/restore-laptop", note.replace("checksum", "checksum and available space")),
  fresh: make(
    "knowledge/recovery-checklist",
    document(
      "Recovery checklist",
      "Confirm the intended target disk before restoring. Preserve the original backup and verify its checksum. After restoring, verify that the new system boots and that the restored files can be opened. Record any failures before retrying.",
    ),
  ),
  reject: make(
    "knowledge/review-example",
    document(
      "Review example",
      "This document is a synthetic proposal used to test manual rejection and reopening. Its contents have no authority over any real installation. A reviewer can inspect the proposed source, reject it with a reason, and reopen it without changing another document.",
    ),
  ),
};
console.log(JSON.stringify(ids));
