// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { isTerminal, stdout } from "../core/stdio";
import { shouldDecorate } from "../core/tty";

/**
 * Help text for the terminal it is printed to: wrapped to its width (80 when
 * unknown); free of ANSI unless akm's one color rule (`shouldDecorate`) allows it, and, when stdout is
 * not a TTY, free of column padding.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — ANSI escape codes
const ANSI = /\x1b\[[0-9;]*m/g;

const visibleLength = (text: string): number => text.replace(ANSI, "").length;

function terminalWidth(): number {
  const columns = stdout().columns ?? Number(process.env.COLUMNS);
  return Number.isInteger(columns) && columns >= 40 ? columns : 80;
}

function wrapLine(line: string, width: number): string[] {
  if (visibleLength(line) <= width) return [line];
  const indent = /^ */.exec(line)?.[0] ?? "";
  const hang = `${indent}    `;
  const rows: string[] = [];
  let row = "";
  for (const word of line.trim().split(/ +/)) {
    if (row !== "" && visibleLength(row) + 1 + visibleLength(word) > width) {
      rows.push(row);
      row = hang.slice(0, width - 20) + word;
    } else {
      row = row === "" ? indent + word : `${row} ${word}`;
    }
  }
  rows.push(row);
  return rows;
}

export function formatHelp(text: string): string {
  const plain = !isTerminal(1);
  const color = shouldDecorate();
  const width = terminalWidth();
  return text
    .split("\n")
    .flatMap((raw) => {
      let line = raw.replace(/ +$/, "");
      if (!color) line = line.replace(ANSI, "");
      if (plain) line = line.replace(/(\S) {2,}/g, "$1 ").replace(/^ {3,}/, "  ");
      return wrapLine(line, width);
    })
    .join("\n");
}
