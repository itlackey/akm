/**
 * Shared frontmatter parsing utilities.
 *
 * Provides a single, canonical YAML-subset frontmatter parser used by both
 * the stash open logic and the metadata generator.
 */

/**
 * Parse YAML-subset frontmatter from a Markdown (or similar) string.
 *
 * Returns the parsed key-value data and the remaining body content.
 *
 * **Limitations**: This is a hand-rolled YAML-subset parser with intentional
 * constraints for simplicity and safety:
 * - **No list support**: YAML block sequences (`- item`) and flow arrays
 *   (`[a, b, c]`) are silently ignored. List-valued frontmatter keys will
 *   produce an empty string or be skipped. Callers must NOT rely on list-
 *   valued frontmatter.
 * - **No nested objects beyond one level**: Only a single level of indented
 *   key-value pairs is supported.
 * - **Scalar values only**: string, boolean, and number scalars are supported.
 */
export function parseFrontmatter(raw: string): {
  data: Record<string, unknown>;
  content: string;
  frontmatter: string | null;
  bodyStartLine: number;
} {
  const parsedBlock = parseFrontmatterBlock(raw);
  if (!parsedBlock) {
    return { data: {}, content: raw, frontmatter: null, bodyStartLine: 1 };
  }

  const data: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let nested: Record<string, unknown> | null = null;

  for (const line of parsedBlock.frontmatter.split(/\r?\n/)) {
    const indented = line.match(/^ {2}(\w[\w-]*):\s*(.+)$/);
    if (indented && currentKey && nested) {
      nested[indented[1]] = parseYamlScalar(indented[2].trim());
      continue;
    }

    const top = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!top) {
      continue;
    }

    currentKey = top[1];
    const value = top[2].trim();
    if (value === "") {
      nested = {};
      data[currentKey] = nested;
    } else {
      nested = null;
      data[currentKey] = parseYamlScalar(value);
    }
  }
  return {
    data,
    content: parsedBlock.content,
    frontmatter: parsedBlock.frontmatter,
    bodyStartLine: parsedBlock.bodyStartLine,
  };
}

export function parseFrontmatterBlock(
  raw: string,
): { frontmatter: string; content: string; bodyStartLine: number } | null {
  // Handle both LF and CRLF line endings throughout.
  // The closing --- may be preceded by \r\n; capture and strip trailing \r
  // from the frontmatter block so key parsing sees clean LF-terminated lines.
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r\n|\r|\n|$)([\s\S]*)$/);
  if (!match) return null;
  // Strip any \r characters from the frontmatter block to normalise CRLF → LF
  const frontmatter = match[1].replace(/\r/g, "");
  const content = match[2];
  return {
    frontmatter,
    content,
    bodyStartLine: countLines(raw.slice(0, match[0].length - match[2].length)) + 1,
  };
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r?\n/).length - 1;
}

/**
 * Parse a simple YAML scalar value (string, boolean, or number).
 */
export function parseYamlScalar(value: string): unknown {
  if (value === "") return "";
  if (value === "true") return true;
  if (value === "false") return false;
  const asNumber = Number(value);
  if (!Number.isNaN(asNumber)) return asNumber;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Coerce an unknown value to a trimmed string, or return undefined if empty/non-string.
 */
export function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
