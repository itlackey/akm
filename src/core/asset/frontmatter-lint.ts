// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { parseDocument } from "yaml";

/**
 * Report a colon-bearing description only when its YAML does not parse. A
 * plain scalar such as a URL or `admin:snapshot` is valid YAML and stays clean;
 * `a: b` in a plain scalar is a nested mapping YAML rejects.
 */
export function checkUnquotedDescriptionColon(frontmatterText: string | null): string | null {
  if (!frontmatterText || parseDocument(frontmatterText).errors.length === 0) return null;

  const lines = frontmatterText.split(/\r?\n/);
  const start = lines.findIndex((candidate) => candidate.startsWith("description:"));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && /^[ \t]/.test(lines[end] as string)) end++;
  const region = lines.slice(start, end).join("\n");
  const value = lines[start]?.slice("description:".length).trim();
  if (!region.includes(":") || parseDocument(region).errors.length === 0) return null;
  return `description value contains unquoted colon: ${value}`;
}
