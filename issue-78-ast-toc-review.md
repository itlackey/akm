# Review of issue #78: cocoindex-code as a source, AST maps, and TOC views

Issue: [itlackey/akm#78](https://github.com/itlackey/akm/issues/78), "Add support for cocoindex-code as a stash source (AST integration with stash results)". Labels `enhancement` and `considering`, milestone Backlog, no comments. Reviewed against branch `release/0.10.0` on 2026-10-27.

## TL;DR

- **Don't build what the issue describes.** Adding cocoindex-code as a source and merging its AST and embedding results into akm search would bring in a second index, a second embedding stack and a Python runtime. It would also mean ranking results across two vector spaces that can't be compared. akm's own principles (1 and 10) argue against all of that, and the coding-agent field has moved away from pre-built indexes of live code.
- **Your TOC idea is the best payoff and is mostly built already.** akm parses every markdown knowledge doc's TOC at index time, stores it and folds it into search. It also splits docs into heading-aligned fragments that `show #slug` can address. The only gap: an agent can't see the TOC unless it asks for a fragment that doesn't exist and reads the error.
- **Your AST-map idea is sound if it works as a generator, not a source.** Generate a compact repo or directory map (Aider and Agentless style) as an ordinary markdown knowledge asset. akm's existing TOC, fragment, search and `show` machinery then handles it with no new dependencies in core. Start with a recipe that wraps an existing tool. Bring tree-sitter into core only if an eval shows a gain.

## 1. What the issue asks for

1. Add cocoindex-code as an optional source.
2. Merge its AST information into akm's search results.
3. Define a structure for overlaying AST data on akm's data format.
4. Expose the enhanced data downstream.
5. Alternatives the issue lists: run cocoindex-code separately with a pre- or post-processing step, or build a plug-in architecture for AST parsers.

## 2. What akm already does (checked in code)

| Capability | Where | Relevance |
| --- | --- | --- |
| The TOC of every markdown knowledge doc (`TocHeading[]`) is parsed at index time | `src/core/adapter/adapters/akm-metadata.ts:165-170` (`toc-metadata`) | TOC generation is already done |
| TOC heading text is folded into the searchable content field | `src/indexer/search/search-fields.ts:63-64` | Headings already help ranking |
| Docs are split deterministically into heading-aligned fragments of at most 1,600 chars, with ordinals, line ranges and hashes | `src/core/asset/markdown-fragments.ts:15-28` | This is the markdown equivalent of cAST's structure-aware chunking ([§4a](#4a-structure-first-context-beats-full-text-or-blind-chunks)) |
| `akm show ref#slug` returns one section. `--context lead` returns the lead plus the matched fragment within a budget, with `fragmentOrdinal`, `fragmentCount`, `previousRef` and `nextRef` | `docs/reference/cli.md:823-936` | Navigation by fragment already exists |
| The search projection **drops fenced code** and keeps prose, headings, link labels and inline identifiers | `src/indexer/passes/metadata.ts:1059-1062` | **A constraint on any generated code map** (§6.2) |
| Scripts get only a description taken from their comments, with no symbols or signatures | `akm-metadata.ts:210-220` (`script-comment-metadata`) | This is the real code-structure gap |
| Pattern: materialize a snapshot, then index it read-only (`website-snapshot`). LLM wikis are indexed through `llm-wiki` | `docs/reference/supported-formats.md` | Precedents for "generate → index" without a new runtime |

**The gap, reproduced.** I indexed a sample `knowledge/guide.md` that has four headings:

```text
$ akm show knowledge/guide --detail brief
{ "type": "knowledge", "ref": "knowledge/guide", "action": "... read one section with `akm show <ref>#fragment` (an unmatched #fragment lists the available slugs).", ... }   # no toc

$ akm show knowledge/guide#nope
{ "ok": false, "error": "Fragment \"#nope\" not found in guide. Available fragments: #guide, #install, #authentication, #tokens.", "code": "ASSET_NOT_FOUND" }
```

The TOC is computed and stored, but an agent can only get it by triggering an `ASSET_NOT_FOUND` error. The `action` hint even tells agents to do exactly that. The result is flat, with no levels and no line ranges.

## 3. What cocoindex-code is

From the project README ([cocoindex-io/cocoindex-code](https://github.com/cocoindex-io/cocoindex-code)) and the [CocoIndex product page](https://www.cocoindex.io/cocoindex-code):

- A semantic code search CLI and MCP server built on CocoIndex, a Rust engine. It chunks code with tree-sitter into units such as functions and classes, and covers about 35 languages, Markdown among them.
- Installed as a Python package (`pipx install 'cocoindex-code[full]'`). The `[full]` extra pulls in about 1 GB of torch and sentence-transformers for local embeddings, default `snowflake-arctic-embed-xs`. Without it, you need a cloud embedding provider (via LiteLLM) and an API key.
- Commands: `ccc init`, `ccc index`, `ccc search "<query>"`, `ccc grep` (structural, no index), `ccc mcp` and a daemon. The index lives in `<project>/.cocoindex_code/` (LMDB plus SQLite). Changing the model forces a re-index.
- Results are code chunks with path, language, line numbers and a similarity score. The README documents this format only for MCP output.
- The project claims "~70% fewer tokens". That is the vendor's own figure, and I found no independent benchmark.

**What akm would get from it.** Embedding-ranked code chunks. akm can't use those directly as assets: they have no stable identity, they live in a different vector space from akm's embedder, and they go stale whenever the code changes.

## 4. Research landscape

### 4a. Structure-first context beats full text or blind chunks

| Work | Finding | Lesson for akm |
| --- | --- | --- |
| **Aider repo map** ([docs](https://github.com/Aider-AI/aider/blob/main/aider/website/docs/repomap.md)) | Sends "a concise map of your whole git repository" listing files with their key classes, functions and signatures. Tree-sitter extracts definitions and references. Graph ranking (files as nodes, dependencies as edges) picks the most relevant parts within `--map-tokens`, which defaults to 1k tokens. | The artifact that pays off is a **small ranked outline**, not an index of every chunk. |
| **Agentless** ([arXiv 2407.01489](https://arxiv.org/pdf/2407.01489)) | Localizes bugs by first showing the model each file's "skeleton": class and function headers, fields, method signatures and module comments. The model then picks which elements to expand. | A skeleton is enough to navigate. Bodies are fetched on demand, which matches akm's `search` → `show` loop. |
| **repomix `--compress`** ([README](https://github.com/yamadashy/repomix), ~29k★, MIT) | Uses tree-sitter to keep imports, doc comments and signatures and drop bodies. Marked experimental. Claims about 70% token reduction. | You can generate a map with an existing tool today, without writing a parser. |
| **cAST** (Zhang et al., Findings of EMNLP 2025, [arXiv 2506.15655](https://arxiv.org/abs/2506.15655)) | Splits code along AST boundaries and merges siblings up to a size budget. Reports +4.3 Recall@5 on RepoEval and +2.67 Pass@1 on SWE-bench over line-based chunking. | Chunks that follow structure beat chunks cut at fixed sizes. akm already does this for markdown (heading fragments), and a generated code map gets it automatically if each file or symbol is a heading. |
| **RepoGraph** (Ouyang et al., ICLR 2025, [arXiv 2410.14684](https://arxiv.org/abs/2410.14684)) | A repository-level code graph used as a plug-in navigation module. It improved four SWE-bench pipelines. | Repository structure helps localization. The authors ship it as a **plug-in to the agent**, not as an extension of a search index. |
| **LocAgent** (Chen et al., ACL 2025, [anthology](https://aclanthology.org/2025.acl-long.426)) | Parses a repository into a heterogeneous graph that agents traverse in multiple hops. Reports up to 92.7% file-level localization accuracy. | The same lesson: a structural graph the agent navigates. |
| **Serena** ([summary](https://www.greptile.com/grepository/serena)) | An MCP server with LSP-backed tools such as `get_symbols_overview` and `find_symbol`. | Live, precise symbol lookup is a solved problem, handled by dedicated per-agent tools. akm doesn't need to rebuild it. |
| **Universal Ctags JSON** ([docs](https://docs.ctags.io/en/latest/man/ctags-json-output.5.html)) | One JSON tag per line with name, kind, scope and line range (`--fields=+ne`). Covers many languages. | A lightweight existing extractor that could feed a map generator. |

### 4b. Hierarchical, TOC-style navigation for documents

| Work | Finding | Lesson for akm |
| --- | --- | --- |
| **PageIndex** ([VectifyAI/PageIndex](https://gittrend.io/repo/VectifyAI/PageIndex), [review](https://rubinlake.com/en/technology-radar/ai-and-data-engineering/pageindex)) | Retrieval with no vectors: builds a TOC tree per document and has the model reason over it. Self-reports 98.7% on FinanceBench, an unverified figure. It is weaker on noisy structure. | A **TOC is itself a retrieval interface**. Exposing it lets the agent pick sections by reasoning. |
| **RAPTOR** (Sarthi et al., ICLR 2024, [arXiv 2401.18059](https://arxiv.org/abs/2401.18059)) | A tree of recursive summaries. Retrieving across levels of abstraction gave +20% absolute on QuALITY with GPT-4. | Hierarchy helps on long documents. akm's headings give it a free hierarchy that needs no LLM summarization. |
| **llms.txt** ([proposal](https://www.answer.ai/posts/2024-09-03-llmstxt.md), [llmstxt.org](https://llmstxt.org/)) | A curated markdown index (H1, summary, H2 lists of links) as the entry point an LLM reads first. | The ecosystem keeps converging on markdown indexes as the first thing an agent reads. |
| **Agent Skills progressive disclosure** ([Anthropic engineering](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)) | Load metadata first, then the body, then linked files, only when they are needed. | A TOC is the step between metadata and body that akm is missing for large docs. |
| **Context engineering / just-in-time retrieval** (Anthropic guidance, as summarized [here](https://agentic-ai.readthedocs.io/en/latest/ContextEngineering/anthropic/)) | Keep lightweight pointers such as paths and refs and load data through tools when needed. | TOC entries with slugs are exactly those pointers. |
| **Context Rot** (Chroma, Jul 2025, [report](https://trychroma.com/research/context-rot)) | Across 18 models, reliability falls as input length grows, even on simple tasks. | Load a section instead of the whole doc. A TOC makes that choice cheap. |
| **Contextual Retrieval** ([Anthropic](https://www.anthropic.com/news/contextual-retrieval)) | Adding context to each chunk (contextual embeddings plus BM25) cut top-20 retrieval failures by 49%. | Heading breadcrumbs on fragments are a cheap form of this. Worth an eval later, not now. |

### 4c. Evidence against indexing live code

| Source | Finding |
| --- | --- |
| **Claude Code** (Boris Cherny, reported in [yage.ai](https://yage.ai/share/why-coding-agents-still-use-grep-en-20260327.html) and [AI Engineer Europe 2026](https://www.ai.engineer/talks/UM6sFg_jdlE-rag-is-dead-right-kuba-rogut)). Primary transcripts weren't reachable, so this is second-hand. | Early versions used RAG with a local vector DB. Agentic search with glob and grep "outperformed everything, by a lot". The reasons given were index upkeep as code changes and privacy. |
| **Cline** ([blog, May 2025](https://cline.bot/blog/why-cline-doesnt-index-your-codebase-and-why-thats-a-good-thing)) | Deliberately doesn't index codebases. Chunking breaks code logic, code changes constantly and it holds sensitive IP. It explores with ripgrep, listings and AST parsing on demand. |
| **Counterpoint** ([fast.io comparison](https://fast.io/resources/augment-code-vs-cline-codebase-indexing/)) | Without an index, agents are slower and use more tokens on very large repos. |

**Synthesis.** For live code, the leading agents prefer on-demand tools over a maintained embedding index. Where structure clearly helps, the form that wins is a **compact, ranked outline or skeleton** the model navigates (Aider, Agentless, RepoGraph, LocAgent), not more vector chunks. For documents, the evidence favours **hierarchy and TOC-first navigation** (PageIndex, RAPTOR, progressive disclosure).

## 5. Assessment of #78 as written

**Value: low compared with its cost. I recommend closing it as proposed or reframing it.**

1. **It duplicates infrastructure.** akm already has an index, an embedder and fragment search. cocoindex-code adds a Python runtime (about 1 GB with local embeddings), an LMDB/SQLite index and a daemon. That is the opposite of principle 10, "heavy machinery and tight coupling are the opposite of akm's goals" (`docs/architecture/akm-core-principles.md:232-240`). It also fails principle 1's test, "demonstrably helped a real user": the issue has no reported user need.
2. **"Merging AST data into stash results" has no coherent design.** cocoindex scores are cosine similarities in another model's space. akm's scores come from its own FTS, embeddings and usage re-ranking. Fusing them would need calibration across both systems, and a pinned embedder (`package.json` pins the tokenizer because "a different release can change … every stored vector") makes it worse.
3. **The results aren't assets.** akm's model is a stable ref → `show` → feedback → proposal. Code chunks have no stable identity, can't take feedback meaningfully, and go stale when the code changes (the Claude Code and Cline arguments in §4c).
4. **Agents already have this.** Users who want cocoindex-code can run `ccc mcp` next to akm today. The capability is reachable without akm in the data path.
5. **The plug-in architecture for AST parsers is speculative.** It is an abstraction with no second user (principle 1, and "no abstractions for single-use code").

**The issue's own first alternative points the right way:** keep the tool separate and produce something akm indexes. Taken one step further, akm should ingest the generator's **output as a markdown asset**, not its index.

## 6. Your proposed concepts

### 6.1 Auto-generated TOC views of markdown assets and fragments: strong yes, small change

**Why:** PageIndex, RAPTOR, progressive disclosure, just-in-time retrieval and context-rot all point the same way. A TOC lets the agent spend a few tokens choosing a section before it loads one. akm already computes the data (§2), so this is mostly exposure work.

**Proposed shape (minimal):**

- Include `toc` in `akm show` for markdown documents at `--detail brief` and the default detail, as `[{ level, text, slug, startLine }]`, with slugs that resolve through `#slug`. Optionally add each heading's fragment ordinal or size so agents can see which sections are large.
- Change the `knowledge` `action` hint from "an unmatched #fragment lists the available slugs" to "pick a section from `toc`". Error-as-API is a smell, and it costs agents a failed call.
- Leave search hits unchanged for now. Fragment refs already appear there, and adding a TOC per hit inflates output.

**Cost and risk:** one output-shape change plus tests and a CLI doc update. It is additive to the JSON, so no persisted-format migration is needed, because `toc` is already in the index. The `brief` output gets a little larger for documents with many headings, so consider capping the depth (for example H1–H3) if real docs turn out noisy.

### 6.2 An AST map for code, a directory or a repo, stored as an akm asset: yes, as a generator, not a source

**Why it fits:** Aider's repo map and Agentless skeletons show that a compact outline of files and symbols is what helps a model navigate code. Once that outline is a **markdown knowledge doc**, akm handles it with what it already has:

- Each file or directory becomes a **heading**, so it appears in the TOC (§6.1), gets its own fragment and is addressable as `akm show knowledge/repo-map/akm#src-indexer-indexer-ts`.
- Search covers paths, symbol names and doc-comment first lines.
- `curate`, feedback and `show --context lead` work unchanged.
- It is indexed read-only like a website snapshot, and regenerating it replaces it.

**One constraint from akm's indexer.** Search **drops fenced code** (`metadata.ts:1059-1062`). A map rendered Aider or repomix style, inside ``` fences, would contribute only its headings to search. The generator should emit symbols as **list items with inline code**, which is kept:

```markdown
---
description: Symbol map of itlackey/akm @ 3f2c1ab (generated 2026-10-27)
generated_from: git:itlackey/akm@3f2c1ab
---
# akm repo map
## src/indexer
### src/indexer/indexer.ts
- `function runIndex(opts: IndexOptions): Promise<IndexResult>`: full or incremental rebuild
- `class IndexWriter`: `write()`, `flush()`
```

Generation options, simplest first:

| Option | New deps in akm core | Notes |
| --- | --- | --- |
| **A. Recipe or script in a bundle** (for example in `akm-stash`) that runs an existing extractor (`ctags --output-format=json --fields=+ne`, `repomix --compress`, or `ccc` itself) and writes the markdown above into a bundle. Kept current with an akm task schedule or run by hand. | **None** | It ships a capability rather than a feature, which is the akm way. Best for proving value. Needs a small conversion from ctags JSON to markdown (or from repomix output, stripping fences). |
| **B. Built-in generator** with `web-tree-sitter` (WASM, so no native build) plus grammar `.wasm` files | 1 package plus a `.wasm` per language | Only after option A shows value in an eval (`docs/maintainers/eval.md`). Upstream notes WASM is "considerably slower" than native bindings ([binding_web README](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web)), and per-language grammars are an ongoing maintenance cost. |
| **C. Integrate cocoindex-code (#78)** | Python, torch and LMDB, out of process | Not recommended (§5). |

**Freshness.** Record the commit SHA in frontmatter (`generated_from`) so agents and `akm` can see when the map is stale. Present the map as **orientation, like AGENTS.md or `.meta/`, not as truth about the code**. The agent still reads the real files through its own tools. This avoids the stale-index problem from §4c, because the map is small, cheap to regenerate, and pointers can't be "wrong code".

**Ranking (optional, later).** Aider's PageRank-style selection matters when the map has to fit in 1k tokens of a prompt. akm doesn't inject the map; agents fetch fragments on demand. So a full but well-sectioned map plus TOC navigation probably makes ranking unnecessary. Check that with an eval before you build it.

### 6.3 Other resource types and whole repos

- **Scripts already indexed by akm:** the narrow version of "AST for other resource types" is adding top-level function names and signatures to a script's `searchHints`. That would need option B's parser, so defer it on the same eval gate.
- **A prose wiki for a whole repo** (DeepWiki, [deepwiki-open](https://dev.co/devops/open-source/deepwiki-open)): akm already indexes Karpathy-style LLM wikis (`llm-wiki` adapter). An agent-authored "how this repo works" wiki is a workflow you can run today with no code changes, and it complements a mechanical symbol map.

## 7. Recommendations

| # | Action | Effort | Payoff |
| --- | --- | --- | --- |
| 1 | **Close #78 as proposed** (or retitle it to "Repo/code maps as generated knowledge assets") and link this review. | — | Removes a backlog item that conflicts with akm's principles |
| 2 | **Expose `toc` in `akm show`** for markdown (levels, slugs, start lines) and update the `action` hint. | Small | High. Uses data already in the index and serves every knowledge doc, wiki page and website snapshot |
| 3 | **Ship a "repo map" recipe** (script plus optional task) that produces a markdown symbol map with headings per file and inline-code symbols, using ctags or repomix. Document it under `docs/guides/recipes/`. | Small–medium, no core deps | Medium. Tests the AST-map idea with zero lock-in |
| 4 | **Run an eval** comparing "agent + repo-map asset" with "agent alone" on a few localization-style tasks before you consider option B. | Medium | Decides whether tree-sitter belongs in core |
| 5 | *(Optional)* A small skill telling agents when to use `ccc search`, `ccc grep` or Serena for live code next to akm. | Tiny | Gets the cocoindex benefit through a capability rather than an integration |
| — | **Don't:** merge external embedding results into akm ranking, add a parser plug-in architecture, or bundle Python or torch. | | |

## 8. Assumptions and open questions

- I assumed "stash source" in the issue means today's bundle or source providers (`src/sources/providers`), since "stash" is the pre-0.9 name.
- The AST-map value claims rest on agent-in-the-loop research (Aider, Agentless, RepoGraph, LocAgent). I found no study of a map stored in a separate knowledge library and fetched by ref, which is why recommendation 4 is an eval and not a build.
- Vendor numbers (cocoindex and repomix "~70% tokens", PageIndex 98.7%) are self-reported and unverified.
- The container's network policy blocked arxiv.org, aider.chat, cline.bot, llmstxt.org and the jsDelivr CDN. For those sources, the details come from search-engine summaries of the linked pages, not direct reads. GitHub-hosted sources (cocoindex-code, aider docs, repomix, tree-sitter) were read directly.

## Sources

Projects and docs
- cocoindex-code README: https://github.com/cocoindex-io/cocoindex-code
- CocoIndex Code product page: https://www.cocoindex.io/cocoindex-code
- Aider repo map docs: https://github.com/Aider-AI/aider/blob/main/aider/website/docs/repomap.md
- RepoMapper (Aider repo map as an MCP server): https://mcpservers.org/servers/pdavis68/RepoMapper
- repomix README (`--compress`): https://github.com/yamadashy/repomix
- Universal Ctags JSON output: https://docs.ctags.io/en/latest/man/ctags-json-output.5.html
- web-tree-sitter README: https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web
- ast-grep napi: https://www.npmjs.com/package/@ast-grep/napi
- Serena overview: https://www.greptile.com/grepository/serena
- PageIndex: https://gittrend.io/repo/VectifyAI/PageIndex ; assessment: https://rubinlake.com/en/technology-radar/ai-and-data-engineering/pageindex
- llms.txt: https://llmstxt.org/ ; proposal: https://www.answer.ai/posts/2024-09-03-llmstxt.md
- DeepWiki guide: https://huggingface.co/blog/lynn-mikami/deepwiki ; deepwiki-open: https://dev.co/devops/open-source/deepwiki-open

Research
- Zhang et al., "cAST: Enhancing Code RAG with Structural Chunking via AST", Findings of EMNLP 2025: https://arxiv.org/abs/2506.15655
- Ouyang et al., "RepoGraph", ICLR 2025: https://arxiv.org/abs/2410.14684 , https://proceedings.iclr.cc/paper_files/paper/2025/hash/4a4a3c197deac042461c677219efd36c-Abstract-Conference.html
- Chen et al., "LocAgent: Graph-Guided LLM Agents for Code Localization", ACL 2025: https://aclanthology.org/2025.acl-long.426
- Xia et al., "Agentless: Demystifying LLM-based Software Engineering Agents": https://arxiv.org/pdf/2407.01489
- Sarthi et al., "RAPTOR", ICLR 2024: https://arxiv.org/abs/2401.18059
- Hong, Troynikov, Huber, "Context Rot", Chroma, Jul 2025: https://trychroma.com/research/context-rot

Industry practice
- Anthropic, "Equipping agents for the real world with Agent Skills": https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- Anthropic, "Contextual Retrieval": https://www.anthropic.com/news/contextual-retrieval
- Anthropic context-engineering guidance (summary): https://agentic-ai.readthedocs.io/en/latest/ContextEngineering/anthropic/
- Cline, "Why Cline Doesn't Index Your Codebase": https://cline.bot/blog/why-cline-doesnt-index-your-codebase-and-why-thats-a-good-thing
- "Why coding agents still use grep" (Claude Code / Boris Cherny reporting): https://yage.ai/share/why-coding-agents-still-use-grep-en-20260327.html
- AI Engineer Europe 2026, "RAG is dead, right?": https://www.ai.engineer/talks/UM6sFg_jdlE-rag-is-dead-right-kuba-rogut
- Augment Code vs Cline (counterpoint): https://fast.io/resources/augment-code-vs-cline-codebase-indexing/

akm code referenced (branch `release/0.10.0`)
- `src/core/adapter/adapters/akm-metadata.ts:165-170, 210-220`
- `src/indexer/search/search-fields.ts:63-64`
- `src/core/asset/markdown-fragments.ts:15-28`
- `src/indexer/passes/metadata.ts:1059-1062`
- `docs/reference/cli.md:823-936`
- `docs/architecture/akm-core-principles.md:19-32, 232-240`
