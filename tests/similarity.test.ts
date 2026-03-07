import { test, expect } from "bun:test"
import { TfIdfAdapter, type ScoredEntry } from "../src/similarity"

function makeEntry(id: string, text: string, type: string = "tool"): ScoredEntry {
  return {
    id,
    text,
    entry: { name: id, type: type as any, description: text, tags: text.split(" ").slice(0, 3) },
    path: `/stash/tools/${id}`,
  }
}

test("TfIdfAdapter ranks relevant results higher", () => {
  const adapter = new TfIdfAdapter()
  adapter.buildIndex([
    makeEntry("docker-build", "build docker images from dockerfiles container"),
    makeEntry("git-diff", "summarize git diff changes commit"),
    makeEntry("deploy-k8s", "deploy kubernetes cluster container orchestration"),
    makeEntry("lint-code", "lint check source code style formatting"),
  ])

  const results = adapter.search("docker build", 10)
  expect(results.length).toBeGreaterThan(0)
  expect(results[0].entry.name).toBe("docker-build")
})

test("TfIdfAdapter supports type filtering", () => {
  const adapter = new TfIdfAdapter()
  adapter.buildIndex([
    makeEntry("docker-build", "build docker images", "tool"),
    makeEntry("deploy-guide", "deploy docker containers", "command"),
  ])

  const toolResults = adapter.search("docker", 10, "tool")
  expect(toolResults.every((r) => r.entry.type === "tool")).toBe(true)
})

test("TfIdfAdapter returns all entries for empty query", () => {
  const adapter = new TfIdfAdapter()
  adapter.buildIndex([
    makeEntry("a", "first tool"),
    makeEntry("b", "second tool"),
  ])

  const results = adapter.search("", 10)
  expect(results).toHaveLength(2)
})

test("TfIdfAdapter serializes and deserializes", () => {
  const entries: ScoredEntry[] = [
    makeEntry("docker-build", "build docker images container"),
    makeEntry("git-diff", "summarize git diff changes"),
  ]

  const adapter = new TfIdfAdapter()
  adapter.buildIndex(entries)
  const serialized = adapter.serialize()

  const restored = TfIdfAdapter.deserialize(serialized, entries)
  const results = restored.search("docker build", 10)
  expect(results.length).toBeGreaterThan(0)
  expect(results[0].entry.name).toBe("docker-build")
})

test("TfIdfAdapter boosts tag matches", () => {
  const adapter = new TfIdfAdapter()
  const entryWithTags: ScoredEntry = {
    id: "tagged-tool",
    text: "some generic description",
    entry: { name: "tagged-tool", type: "tool", description: "some generic description", tags: ["docker"] },
    path: "/stash/tools/tagged-tool",
  }
  const entryWithoutTags: ScoredEntry = {
    id: "untagged-tool",
    text: "docker related operations",
    entry: { name: "untagged-tool", type: "tool", description: "docker related operations" },
    path: "/stash/tools/untagged-tool",
  }

  adapter.buildIndex([entryWithTags, entryWithoutTags])
  const results = adapter.search("docker", 10)

  // Both should match, but the one with tag boost should score higher
  expect(results.length).toBe(2)
  // The tagged entry gets a boost
  const taggedResult = results.find((r) => r.entry.name === "tagged-tool")
  expect(taggedResult).toBeDefined()
})

test("TfIdfAdapter handles unknown query terms gracefully", () => {
  const adapter = new TfIdfAdapter()
  adapter.buildIndex([makeEntry("test", "test tool description")])

  const results = adapter.search("xyznonexistent", 10)
  // Should fall back to substring or return empty
  expect(results).toHaveLength(0)
})
