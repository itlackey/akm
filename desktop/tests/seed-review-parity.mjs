import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.env.AKM_DESKTOP_TEST_ROOT;
assert.ok(root && path.basename(root).startsWith("akm-desktop-fixture-"));
assert.equal(process.env.AKM_BUNDLE_DIR, path.join(root, "personal"));
await import("akm-cli/workspace");
const { createProposal } = await import("akm-cli/dist/commands/proposal/repository.js");
const lines = Array.from({ length: 35 }, (_, i) => `Evidence line ${i + 1}: retain the original source.`);
const before = `---\ntitle: Aligned review\ndescription: Synthetic review parity evidence\n---\n# Aligned review\n\n${lines.join("\n")}\n`;
const file = path.join(root, "personal/knowledge/review-aligned.md");
fs.writeFileSync(file, before);
const after = before.replace(
  "Evidence line 17: retain the original source.",
  "Evidence line 17: verify the original source.",
);
const proposal = createProposal(process.env.AKM_BUNDLE_DIR, {
  ref: "knowledge/review-aligned",
  source: "reflect",
  sourceRun: "synthetic-review-parity",
  confidence: 0.82,
  payload: { content: after },
});
console.log(JSON.stringify({ id: proposal.id, file, before }));
