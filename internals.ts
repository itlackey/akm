// Internal helpers — not part of the primary public API.
// Use the subpath import "agentikit/internals" to access these.

export { parseMarkdownToc, extractSection, extractLineRange, extractFrontmatterOnly, formatToc } from "./src/markdown"
export type { TocHeading, KnowledgeToc } from "./src/markdown"
export { parseFrontmatter } from "./src/frontmatter"
export { resolveRg, isRgAvailable, ensureRg } from "./src/ripgrep"
export type { EnsureRgResult } from "./src/ripgrep"
export { resolveRegistryArtifact } from "./src/registry-resolve"
export {
  upsertInstalledRegistryEntry,
  removeInstalledRegistryEntry,
  getRegistryCacheRootDir,
  detectStashRoot,
} from "./src/registry-install"
export { enhanceMetadata, isLlmAvailable } from "./src/llm"
export { embed, cosineSimilarity, isEmbeddingAvailable } from "./src/embedder"
export type { EmbeddingVector } from "./src/embedder"
