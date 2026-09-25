import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../src/core/common";
import { type ResolvedWriteTarget, withWriteTargetMutation } from "../../src/core/write-source";
import { sleepSync } from "../../src/runtime";
import { createWorkflowAsset } from "../../src/workflows/authoring/authoring";

const [mode, root, content, enteredPath, releasePath, readyPath] = process.argv.slice(2);

if (mode === "workflow") {
  createWorkflowAsset({ name: "leased" });
} else if (mode === "helper" && root && content && enteredPath && releasePath && readyPath) {
  const target: ResolvedWriteTarget = {
    source: { kind: "git", name: "team", path: root, repoPath: root },
    config: { type: "git", name: "team", writable: true },
  };
  const assetPath = path.join(root, "workflows", "shared.md");
  fs.writeFileSync(readyPath, "ready");
  withWriteTargetMutation(target, [assetPath], { purpose: `test-${content}`, message: `Write ${content}` }, () => {
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    writeFileAtomic(assetPath, content, 0o644);
    fs.writeFileSync(enteredPath, "entered");
    while (!fs.existsSync(releasePath)) sleepSync(10);
  });
} else {
  throw new Error("Invalid write-mutation lease worker arguments.");
}
