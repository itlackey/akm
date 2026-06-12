// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../core/common";

export interface EvalCase {
  ref: string;
  failureReason: string;
  assetType: string;
  rejectedAt: number;
  source: "distill_quality_rejected" | "proposal_rejected";
  /** Slug of the eval case file */
  slug: string;
}

export function writeEvalCase(stashDir: string, evalCase: EvalCase): string {
  const evalDir = path.join(stashDir, ".akm", "eval-cases");
  fs.mkdirSync(evalDir, { recursive: true });
  const fileName = `${evalCase.slug}.md`;
  const filePath = path.join(evalDir, fileName);
  const content = `---
ref: ${evalCase.ref}
failureReason: ${evalCase.failureReason}
assetType: ${evalCase.assetType}
rejectedAt: ${evalCase.rejectedAt}
source: ${evalCase.source}
---

# Eval Case: ${evalCase.ref}

**Failure reason:** ${evalCase.failureReason}
**Source:** ${evalCase.source}
**Asset type:** ${evalCase.assetType}

This case was automatically captured when a distillation or proposal was rejected.
Use it as a regression test: future improve runs on this ref should not produce
output that would be rejected for the same reason.
`;
  writeFileAtomic(filePath, content);
  return filePath;
}

export function countEvalCases(stashDir: string): number {
  const evalDir = path.join(stashDir, ".akm", "eval-cases");
  if (!fs.existsSync(evalDir)) return 0;
  try {
    return fs.readdirSync(evalDir).filter((f) => f.endsWith(".md")).length;
  } catch {
    return 0;
  }
}
