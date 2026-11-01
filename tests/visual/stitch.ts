// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A labelled side-by-side of two screenshots (plan 11.5.2: `reference | actual`).
 * `bun tests/visual/stitch.ts <left.png> <right.png> <out.png> [leftLabel] [rightLabel]`
 */

import fs from "node:fs";
import type { Page } from "@playwright/test";
import { renderSheet, withPage } from "./sheet";

export interface StitchSide {
  label: string;
  file: string;
  /** The picture's width in px, which the composite keeps. */
  width: number;
}

export function stitch(page: Page, left: StitchSide, right: StitchSide): Promise<Buffer> {
  return renderSheet(page, [left, right], { columns: 2, cellWidth: Math.max(left.width, right.width) });
}

/** A PNG's width, from its IHDR chunk. */
export function pngWidth(file: string): number {
  return fs.readFileSync(file).readUInt32BE(16);
}

if (import.meta.main) {
  const [leftFile, rightFile, out, leftLabel = "reference", rightLabel = "actual"] = process.argv.slice(2);
  if (!leftFile || !rightFile || !out)
    throw new Error("usage: stitch.ts <left.png> <right.png> <out.png> [leftLabel] [rightLabel]");
  const png = await withPage((page) =>
    stitch(
      page,
      { label: leftLabel, file: leftFile, width: pngWidth(leftFile) },
      { label: rightLabel, file: rightFile, width: pngWidth(rightFile) },
    ),
  );
  fs.writeFileSync(out, png);
}
