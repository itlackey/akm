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
 * - **Top-level values**: string, boolean, and number scalars are supported,
 *   as well as top-level list-valued keys using YAML block sequences
 *   (`- item`) or flow arrays (`[a, b, c]`).
 * - **List item types**: list items must be scalar values and may be strings,
 *   booleans, or numbers.
 * - **No nested objects beyond one level**: Only a single level of indented
 *   key-value pairs is supported.
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
  /** "scalar" | "list" | "object" | "pending" — "pending" means empty value, mode determined by next line */
  let mode: "scalar" | "list" | "object" | "pending" = "scalar";
  let nested: Record<string, unknown> | null = null;
  let currentList: unknown[] | null = null;

  const flushPending = () => {
    // Called when we start a new top-level key and the previous key was still "pending".
    // An empty-value key followed by another top-level key means it was an empty scalar.
    if (mode === "pending" && currentKey !== null) {
      data[currentKey] = "";
    }
  };

  for (const line of parsedBlock.frontmatter.split(/\r?\n/)) {
    // Block-sequence item: "- value" or "  - value" (optional 2-space indent)
    // Only match when the current key is in list or pending mode.
    const seqItem = line.match(/^(?: {2})?- (.*)$/);
    if (seqItem && currentKey !== null && (mode === "list" || mode === "pending")) {
      if (mode === "pending") {
        // First block-sequence item after an empty-value key — switch to list mode
        currentList = [];
        data[currentKey] = currentList;
        mode = "list";
      }
      (currentList as unknown[]).push(parseYamlScalar(seqItem[1].trim()));
      continue;
    }

    // Indented nested key-value (object under a key with empty value)
    const indented = line.match(/^ {2}(\w[\w-]*):\s*(.+)$/);
    if (indented && currentKey !== null && (mode === "object" || mode === "pending")) {
      if (mode === "pending") {
        // First indented k-v after an empty-value key — switch to object mode
        nested = {};
        data[currentKey] = nested;
        mode = "object";
      }
      (nested as Record<string, unknown>)[indented[1]] = parseYamlScalar(indented[2].trim());
      continue;
    }

    // Top-level key (possibly with inline value)
    const top = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!top) {
      continue;
    }

    // Starting a new top-level key — flush any pending empty-value key
    flushPending();

    currentKey = top[1];
    const value = top[2].trim();

    if (value === "") {
      // Defer mode decision until we see the next line
      mode = "pending";
      nested = null;
      currentList = null;
      // Don't store anything yet — flushPending will set "" if no continuation
    } else if (value.startsWith("[") && value.endsWith("]")) {
      // Inline flow array: tags: [ops, networking]
      mode = "list";
      nested = null;
      currentList = parseFlowArray(value);
      data[currentKey] = currentList;
    } else {
      mode = "scalar";
      nested = null;
      currentList = null;
      data[currentKey] = parseYamlScalar(value);
    }
  }

  // Flush the last key if it was still pending (empty value, no continuation)
  flushPending();

  return {
    data,
    content: parsedBlock.content,
    frontmatter: parsedBlock.frontmatter,
    bodyStartLine: parsedBlock.bodyStartLine,
  };
}

/**
 * Parse a YAML flow array string like `[a, b, c]` into an array of scalars.
 */
function parseFlowArray(value: string): unknown[] {
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((item) => parseYamlScalar(item.trim()));
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
