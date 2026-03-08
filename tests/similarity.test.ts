import { test, expect } from "bun:test"

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "during", "before", "after", "above", "below",
  "and", "but", "or", "nor", "not", "so", "yet", "both", "either",
  "neither", "each", "every", "all", "any", "few", "more", "most",
  "other", "some", "such", "no", "only", "own", "same", "than",
  "too", "very", "just", "because", "if", "when", "where", "how",
  "what", "which", "who", "whom", "this", "that", "these", "those",
  "it", "its",
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
}

test("tokenize splits text and removes stop words", () => {
  const tokens = tokenize("build docker images from dockerfiles container")
  expect(tokens).toContain("build")
  expect(tokens).toContain("docker")
  expect(tokens).toContain("container")
  expect(tokens).not.toContain("from") // stop word
})

test("tokenize handles empty input", () => {
  const tokens = tokenize("")
  expect(tokens).toHaveLength(0)
})

test("tokenize removes short tokens", () => {
  const tokens = tokenize("a b cd efg")
  expect(tokens).not.toContain("a")
  expect(tokens).not.toContain("b")
  expect(tokens).toContain("cd")
  expect(tokens).toContain("efg")
})
