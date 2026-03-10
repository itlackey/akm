# Library API

Agentikit exports its core functions for use as a library in Bun-based
TypeScript and JavaScript projects. Bun v1.0+ is required as the runtime
since agentikit depends on `bun:sqlite`.

```ts
import {
  // Core operations
  agentikitAdd,
  agentikitClone,
  agentikitInit,
  agentikitIndex,
  agentikitList,
  agentikitRemove,
  agentikitSearch,
  agentikitShow,
  agentikitUpdate,
  checkForUpdate,
  performUpgrade,

  // Stash sources
  resolveStashSources,
  resolveAllStashDirs,
  findSourceForPath,

  // Ripgrep
  resolveRg,
  isRgAvailable,
  ensureRg,

  // Markdown
  parseMarkdownToc,
  extractSection,
  extractLineRange,
  extractFrontmatterOnly,
  formatToc,
  parseFrontmatter,

  // Config
  loadConfig,
  saveConfig,
  updateConfig,

  // Registry
  parseRegistryRef,
  resolveRegistryArtifact,
  searchRegistry,
  installRegistryRef,
  upsertInstalledRegistryEntry,
  removeInstalledRegistryEntry,
  getRegistryCacheRootDir,
  detectStashRoot,

  // LLM & Embeddings
  enhanceMetadata,
  isLlmAvailable,
  embed,
  cosineSimilarity,
  isEmbeddingAvailable,

  // Asset type handler registry
  registerAssetType,
  getHandler,
  tryGetHandler,
  getAllHandlers,
  getRegisteredTypeNames,

  // Flexible asset resolution (matcher/renderer system)
  buildFileContext,
  registerMatcher,
  registerRenderer,
  getRenderer,
  getAllRenderers,
  runMatchers,
  buildRenderContext,
  walkStashFlat,
} from "agentikit"
```

## Functions

| Function | Description |
| --- | --- |
| `agentikitInit()` | Initialize stash directory and config (async) |
| `agentikitIndex({ full?, stashDir? })` | Build or rebuild the search index |
| `agentikitSearch({ query, type?, limit?, usage?, source? })` | Search local stash and/or registry |
| `agentikitShow({ ref, view? })` | Show asset content by ref (async, auto-installs if needed) |
| `agentikitAdd({ ref })` | Install a kit from npm, GitHub, or local path |
| `agentikitList()` | List installed kits with status flags |
| `agentikitRemove({ target })` | Remove an installed kit and reindex |
| `agentikitUpdate({ target?, all?, force? })` | Update one or all kits to latest version (`--force` busts cache) |
| `checkForUpdate(currentVersion)` | Check if a newer akm release is available |
| `performUpgrade(check, opts?)` | Upgrade akm binary to the latest release |
| `agentikitClone({ sourceRef, newName?, force?, dest? })` | Copy an asset into the working stash or custom destination (async). Fetches remote origins automatically |
| `resolveStashSources()` | Resolve all stash sources in priority order |
| `resolveAllStashDirs(stashDir)` | Resolve all stash directories including mounted dirs |
| `findSourceForPath(path, sources)` | Find which stash source a file path belongs to |
| `resolveRg(stashDir?)` | Resolve the path to ripgrep binary |
| `isRgAvailable()` | Check if ripgrep is available |
| `ensureRg(stashDir)` | Install ripgrep if not available |
| `parseMarkdownToc(content)` | Parse table of contents from markdown |
| `extractSection(content, heading)` | Extract a section from markdown by heading |
| `extractLineRange(content, start, end)` | Extract a line range from content |
| `extractFrontmatterOnly(content)` | Extract only the frontmatter from markdown |
| `formatToc(toc)` | Format a TOC for display |
| `parseFrontmatter(content)` | Parse YAML frontmatter from markdown |
| `loadConfig()` | Load the agentikit config from disk |
| `saveConfig(config)` | Save config to disk |
| `updateConfig(partial)` | Merge partial config and save |
| `parseRegistryRef(ref)` | Parse a registry reference string |
| `resolveRegistryArtifact(parsed)` | Resolve a parsed ref to a downloadable artifact |
| `searchRegistry(query, options?)` | Search the npm/GitHub registry |
| `installRegistryRef(ref, config)` | Install a registry reference |
| `upsertInstalledRegistryEntry(entry)` | Add or update an installed entry in config |
| `removeInstalledRegistryEntry(id)` | Remove an installed entry from config |
| `getRegistryCacheRootDir()` | Get the registry cache root directory |
| `detectStashRoot(extractedDir)` | Detect the stash root inside an extracted package |
| `enhanceMetadata(llmConfig, entry, content?)` | Enhance entry metadata using LLM |
| `isLlmAvailable(llmConfig)` | Check if LLM endpoint is available |
| `embed(text, embeddingConfig?)` | Generate an embedding vector |
| `cosineSimilarity(a, b)` | Compute cosine similarity between two vectors |
| `isEmbeddingAvailable(config?)` | Check if embedding provider is available |
| `registerAssetType(handler)` | Register a custom asset type handler |
| `getHandler(type)` | Get handler for an asset type (throws if not found) |
| `tryGetHandler(type)` | Get handler for an asset type (returns undefined if not found) |
| `getAllHandlers()` | Get all registered asset type handlers |
| `getRegisteredTypeNames()` | Get all registered asset type names |
| `buildFileContext(stashRoot, absPath)` | Build a FileContext with lazy content/frontmatter/stat getters |
| `registerMatcher(matcher)` | Register a custom asset matcher function |
| `registerRenderer(renderer)` | Register a custom asset renderer |
| `getRenderer(name)` | Get a renderer by name (returns undefined if not found) |
| `getAllRenderers()` | Get all registered renderers |
| `runMatchers(ctx)` | Run all matchers against a FileContext, return highest-specificity result |
| `buildRenderContext(ctx, match, stashDirs)` | Build a RenderContext from FileContext + MatchResult |
| `walkStashFlat(stashRoot)` | Walk entire stash root returning FileContext[] for all files |

## Types

All public types are re-exported from the main entry point:

```ts
import type {
  // Core types
  AgentikitAssetType,
  AgentikitSearchType,
  InitResponse,
  IndexResponse,
  SearchUsageMode,

  // Search
  AddResponse,
  LocalSearchHit,
  RegistrySearchResultHit,
  SearchSource,
  SearchHit,
  SearchResponse,

  // Show
  ShowResponse,
  KnowledgeView,

  // Registry management
  ListResponse,
  RemoveResponse,
  UpdateResponse,
  RegistryListEntry,
  RegistryInstallStatus,
  UpdateResultItem,
  UpgradeCheckResponse,
  UpgradeResponse,

  // Stash sources
  StashSource,
  StashSourceKind,
  CloneOptions,
  CloneResponse,

  // Tool runner
  ToolKind,

  // Metadata
  StashEntry,
  StashFile,
  StashIntent,

  // Config
  AgentikitConfig,
  EmbeddingConnectionConfig,
  LlmConnectionConfig,
  RegistryConfig,

  // Registry internals
  RegistrySource,
  ParsedRegistryRef,
  ParsedNpmRef,
  ParsedGithubRef,
  ResolvedRegistryArtifact,
  RegistryInstalledEntry,
  RegistryInstallResult,
  RegistrySearchHit,
  RegistrySearchResponse,

  // Markdown
  TocHeading,
  KnowledgeToc,

  // Ripgrep
  EnsureRgResult,

  // Embeddings
  EmbeddingVector,

  // Asset type handler
  AssetTypeHandler,
  ShowInput,

  // Flexible asset resolution
  FileContext,
  MatchResult,
  AssetMatcher,
  RenderContext,
  AssetRenderer,
} from "agentikit"
```
