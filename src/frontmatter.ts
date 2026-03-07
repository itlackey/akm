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
 */
export function parseFrontmatter(raw: string): { data: Record<string, unknown>; content: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) {
    return { data: {}, content: raw }
  }

  const data: Record<string, unknown> = {}
  let currentKey: string | null = null
  let nested: Record<string, unknown> | null = null

  for (const line of match[1].split(/\r?\n/)) {
    const indented = line.match(/^  (\w[\w-]*):\s*(.+)$/)
    if (indented && currentKey && nested) {
      nested[indented[1]] = parseYamlScalar(indented[2].trim())
      continue
    }

    const top = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (!top) {
      continue
    }

    currentKey = top[1]
    const value = top[2].trim()
    if (value === "") {
      nested = {}
      data[currentKey] = nested
    } else {
      nested = null
      data[currentKey] = parseYamlScalar(value)
    }
  }
  return { data, content: match[2] }
}

/**
 * Parse a simple YAML scalar value (string, boolean, or number).
 */
export function parseYamlScalar(value: string): unknown {
  if (value === "") return ""
  if (value === "true") return true
  if (value === "false") return false
  const asNumber = Number(value)
  if (!Number.isNaN(asNumber)) return asNumber
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Coerce an unknown value to a trimmed string, or return undefined if empty/non-string.
 */
export function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}
