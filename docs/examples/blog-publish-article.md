---
description: End-to-end workflow to research, draft, edit, quality-gate, publish (as a dev.to draft), and notify approvers for a brand-aligned technical blog article. Self-contained — embeds the rules and quality gates from the blog-writing skill so any agent can execute it without loading additional assets.
tags:
  - blog
  - content
  - publishing
  - seo
  - devto
params:
  topic: The article topic. If empty, propose 5 candidates from the brand pillars and ask the user to pick.
  pillar: Optional pillar name from brand.yaml to anchor the topic. If empty, the researcher selects the best fit.
  brand_config_path: Path to the YAML brand config. Defaults to skills/blog-writing/config/brand.yaml, then brand.example.yaml.
  workspace_dir: Directory for brief + draft artifacts. Defaults to workspace/blog.
  notify_channel: Apprise tag that routes to the reviewer channel. Defaults to publishing.approval.notify_channel from brand.yaml (e.g. blog-approvals).
---

# Workflow: Publish a Quality Blog Article

This workflow turns a topic (or pillar) into a publish-ready, SEO-optimized
draft on dev.to with a canonical URL pointed at the product blog, then sends
an approver notification. It encapsulates the full process from
`skills/blog-writing/SKILL.md` so it can be executed end-to-end without
loading additional assets, while still pointing at the underlying agents and
references when richer context is needed.

Pipeline summary:

```
LOAD-CONFIG → SELECT-TOPIC → RESEARCH → DRAFT → EDIT → QUALITY-GATE → PUBLISH-DRAFT → NOTIFY → REPORT
```

Hard rules that apply to every step:

- Brand-agnostic. Never hardcode product names, pillars, voice rules, or
  CTAs in the article — read them from `brand_config_path`.
- The product is an example, not the subject. Do not build the post around a
  product pitch.
- No fabricated sources, numbers, or benchmarks. Every performance / scale /
  adoption claim must trace to a source captured in the brief.
- Code must run as written: pin versions, include imports, show expected
  output.
- Publishing is a human decision. This workflow always finishes at
  `published: false`. Never flip it to `true`.

## Step: Load brand configuration
Step ID: load-config

### Instructions
Resolve the brand config in this priority order and load it into memory:

1. `$BLOG_BRAND_CONFIG` (absolute path) if set
2. The `brand_config_path` parameter
3. `./brand.yaml` in the current working directory
4. `skills/blog-writing/config/brand.yaml`
5. `skills/blog-writing/config/brand.example.yaml` (fallback)

Extract and treat as ground truth for the rest of the workflow:

- `product` — `name`, `domain`, `blog_url`, `tagline`, `one_liner`
- `pillars[]` — `name`, `description`, `example_topics`
- `audience` — `primary`, `secondary`, `seniority`
- `voice` — `person`, `tone`, `allow_humor`, `banned_phrases`, `require`
- `seo` — `canonical_strategy`, `internal_link_targets`,
  `min_internal_links_per_1000_words`, `devto_default_tags`
- `cta` — `primary`, `secondary`
- `publishing` — `devto.default_published`, `approval.notify_channel`,
  `approval.approver_mention`

Verify required environment:

- `DEVTO_API_KEY` is set (publish step will fail without it).
- An apprise tag matching `publishing.approval.notify_channel` (or the
  `notify_channel` param) is configured to reach the reviewer.

Ensure `workspace_dir` exists (default `workspace/blog`); create it if not.

### Completion Criteria
- Brand config loaded; the resolved path is recorded for the report.
- `DEVTO_API_KEY` present in the environment (or explicitly noted as missing
  with a plan to set it before the publish step).
- Notify channel resolved and confirmed routable.
- `workspace_dir` exists and is writable.

## Step: Select topic and pillar
Step ID: select-topic

### Instructions
Resolve the article subject:

1. If `topic` is provided, validate it maps cleanly to at least one
   `pillars[].name`. If it doesn't, stop and report the mismatch — do not
   invent a pillar.
2. If `topic` is empty but `pillar` is provided, propose 3 specific topic
   candidates within that pillar. Pick one (or ask the user to pick).
3. If both are empty, propose 5 topic candidates spanning the pillars
   (drawing from `pillars[].example_topics` for inspiration but going deeper)
   and ask the user to pick before proceeding.

Each topic candidate must:

- Be specific enough to scope a 1500–3000 word article.
- Make a concrete claim or solve a concrete problem (not "an overview of X").
- Front-load a primary keyword a real reader would search for.

Record the chosen `topic` and the `pillar_primary` (and optional
`pillar_secondary`).

### Completion Criteria
- A single `topic` is chosen and recorded.
- The chosen topic maps to at least one configured pillar.
- A `slug` is derived (kebab-case, 3–5 words, no dates, primary keyword
  present) and recorded for downstream artifact naming.

## Step: Research and brief
Step ID: research

### Instructions
Dispatch `agents/blog/researcher.md` (or perform the role inline if the
agent isn't loaded) with `topic`, `pillar_primary`, and the loaded brand
config. The researcher produces a brief at
`<workspace_dir>/<slug>-brief.md` that includes:

1. **Pillar fit** stated in plain English. Hard stop if the topic does not
   fit any pillar.
2. **Reader** — one sentence describing who this post is for and the
   decision/task they are on when they find it (drawn from `audience`).
3. **SERP & intent scan** — for the primary keyword:
   - search intent (informational | commercial | comparison | transactional)
   - dominant format among top 5 (tutorial | deep-dive | comparison |
     listicle | pillar-guide)
   - common H2s across top 5 results
   - the gap the top 5 skip (where you earn the ranking)
   - estimated word count (median of top 5 ± 20%)
   - PAA / "People Also Ask" questions (each becomes an H3 or FAQ entry)
4. **Sources** — 5–10 credible sources, each with URL, publisher, year, a
   one-sentence summary, and which claim it supports. Prefer official docs,
   vendor engineering blogs, peer-reviewed papers, reproducible benchmarks.
   For version-, benchmark-, or vendor-specific claims, prefer sources < 24
   months old. Mark unverified sources explicitly.
5. **Product hooks** — 2–3 places where the product is a natural example
   (drawn from `pillars[].description`, `product.one_liner`, and
   `seo.internal_link_targets`). For each, state the section, the concept it
   illustrates, the framing (demo → concept or concept → demo), and the
   internal link target + anchor hint.
6. **Title candidates** — 3 candidates, each ≤ 65 chars, primary keyword
   front-loaded, making a specific claim.
7. **Meta description candidates** — 2 candidates, 105–160 chars, primary
   keyword present, with a clear payoff.
8. **Outline** with TL;DR slot, H2s, FAQ if commercial intent, and closing.
9. **Risks / gaps** — anything you couldn't verify or a claim the writer
   should handle carefully.

For richer guidance, the researcher may consult
`skills/blog-writing/references/ai-seo.md` for AEO/GEO patterns when the
intent is commercial or comparison.

### Completion Criteria
- Brief written to `<workspace_dir>/<slug>-brief.md` matching the structure
  in `agents/blog/researcher.md`.
- Pillar fit confirmed; if not, the workflow halts here.
- 5–10 sources captured with URLs and one-sentence summaries.
- 3 title candidates and 2 meta description candidates produced.
- 2–3 product hooks identified with section + internal link + anchor hint.

## Step: Draft the article
Step ID: draft

### Instructions
Dispatch `agents/blog/writer.md` with the brief path and brand config.
The writer produces `<workspace_dir>/<slug>.md` following this contract:

Frontmatter (for `devto-cli.ts` to consume):

```yaml
---
title: "<one of the brief's title candidates, or a sharper version>"
description: "<meta description, 105–160 chars, primary keyword present>"
tags: <3–4 tags from seo.devto_default_tags or keyword-derived>
slug: "<from the brief>"
cover_image: "<optional URL>"
canonical_url: "<{product.blog_url}/<slug>>"
published: false
---
```

Body structure:

1. **Opening** (2–3 sentences): state the problem or the conclusion. Never
   open with company history, hype, or "In today's fast-paced world."
2. **TL;DR** (80–100 words). Self-contained — an LLM quoting only this
   paragraph should still get the whole point. Include the primary keyword
   once, naturally.
3. **Informative H2s** — write headings that state what the section argues,
   not generic labels like "Background" or "Conclusion".
4. **FAQ** (only if `search_intent` is `commercial` or `comparison`) using
   the PAA questions from the brief, with short, self-contained answers.
5. **What to try next** — one concrete next step: doc link, repo, demo, or
   CTA from `cta`.

Voice and SEO discipline (enforced from `brand.yaml`):

- `voice.person` and `voice.tone` apply throughout.
- No phrase from `voice.banned_phrases`.
- Satisfy every rule in `voice.require` (specific numbers, trade-offs
  surfaced, versions pinned, diagram for >2-component systems).
- Primary keyword in: title, H1, first 100 words, meta description, slug.
- 2–3 H2s include the primary keyword or close secondary.
- Keyword density 0.5–2.5% — never stuff.
- Internal links: use `seo.internal_link_targets` with the suggested anchor
  hints. Hit `seo.min_internal_links_per_1000_words`. Never "click here".
- Self-contained paragraphs (no "as mentioned above").
- Numbered lists for any process; definitions lead each section.

Code blocks:

- Language tag on every fence.
- Imports, setup, and `cd` steps present where a reader would need them.
- Versions pinned. Mark untested snippets clearly so the editor catches them.
- Show expected output after long snippets.
- Mermaid (or described diagram) for any system with >2 components.

Product hooks: use exactly the hooks in the brief. Roughly one hook per
600–800 words. Hooks are worked examples — never interruptions, never
opening or closing pitches.

For pattern depth, the writer may consult
`skills/blog-writing/references/blog-writing-specialist.md` (post-type
templates), `devrel-content.md` (code conventions), `content-patterns.md`
(reusable AEO/GEO blocks), and `platform-ranking-factors.md`.

### Completion Criteria
- Draft written to `<workspace_dir>/<slug>.md`.
- Frontmatter complete with `title`, `description`, `tags` (≤ 4), `slug`,
  `canonical_url` set to `{product.blog_url}/<slug>`, and
  `published: false`.
- Word count within ±20% of the brief's `target_word_count`.
- Writer has returned a list of any flagged issues (untested snippets,
  unverified sources, brief items deliberately not included and why).

## Step: Editorial passes
Step ID: edit

### Instructions
Dispatch `agents/blog/editor.md` with the draft path, brief path, and brand
config. The editor preserves the writer's voice and runs five passes:

1. **Factual** — every performance number, adoption stat, year, and product
   capability traces to a source in the brief or an authoritative link in
   the draft. Strike unsourced claims unless flagged "confirm before
   publish". Verify version numbers, dates, names, and that each product
   hook from the brief actually landed.
2. **Voice** — search the draft for every entry in `voice.banned_phrases`;
   each match must be rewritten (never silently delete the surrounding
   sentence). Enforce `voice.person`, `voice.tone`, and `voice.require`.
   Replace vague quantities with specific numbers from the brief, or remove
   the claim. Pin unpinned dependency versions.
3. **Technical** — every fenced code block has a language tag; imports and
   setup are present; commands run as written; expected output shown after
   long snippets; >2-component systems have a diagram; spot-check links.
4. **SEO / AEO** — primary keyword placements (title, H1, first 100 words,
   meta, slug); title ≤ 65 chars; meta 105–160 chars with a payoff; slug
   3–5 words and hyphenated; internal link count ≥
   `seo.min_internal_links_per_1000_words` with descriptive anchors;
   canonical URL set to `{product.blog_url}/<slug>`; self-contained
   paragraphs; TL;DR present (80–120 words); FAQ if commercial/comparison
   intent; numbered lists for processes; definitions lead sections; no
   keyword stuffing.
5. **Frontmatter** — `title`, `description`, `tags` (≤ 4), `slug`,
   `canonical_url`, optional `cover_image`, and `published: false` all
   present.

Decision after passes:

- **ship** — all non-negotiables pass; overwrite `<workspace_dir>/<slug>.md`
  with the corrected draft.
- **loopback** — return to `draft` with a prioritized fix list.
- **kill** — fabricated claims, wrong pillar fit, or no original angle;
  recommend a different topic and stop.

### Completion Criteria
- Editor decision is `ship` (otherwise loop back to step `draft` or stop).
- Edited draft saved at `<workspace_dir>/<slug>.md`.
- Changelog produced citing the rule each change enforces (e.g.
  `[voice.banned_phrases]`, `[seo.min_internal_links_per_1000_words]`).

## Step: Verify quality gates
Step ID: quality-gate

### Instructions
Re-check the final draft against every non-negotiable below. All must pass
before publishing — even if the editor returned `ship`, this step is the
last guardrail.

1. Topic fits at least one pillar in `brand.yaml`.
2. No banned phrase from `voice.banned_phrases` is present.
3. Every performance / adoption / version claim has a cited source in the
   brief or an authoritative link in the body.
4. Every fenced code block has a language tag and would run as written
   (versions pinned, imports present, no orphan placeholders).
5. `canonical_url` is set and points to `{product.blog_url}/<slug>` —
   never to `dev.to`.
6. Internal link count ≥ `seo.min_internal_links_per_1000_words`, computed
   against the actual word count.
7. TL;DR present and 80–120 words.
8. Title ≤ 65 chars and includes the primary keyword.
9. Meta description 105–160 chars and includes the primary keyword.
10. Frontmatter has `published: false`.

If any gate fails, return to `edit` (or `draft` if structural). Do not
proceed to `publish-draft`.

### Completion Criteria
- All ten non-negotiables pass.
- Final word count, internal link count, and primary-keyword placements
  recorded for the report.

## Step: Publish as dev.to draft
Step ID: publish-draft

### Instructions
Run the dev.to CLI from the blog-writing skill to create the article with
`published: false` and `canonical_url` pointed at the product blog:

```bash
bun skills/blog-writing/scripts/devto-cli.ts draft \
  --file <workspace_dir>/<slug>.md \
  --brand <brand_config_path>
```

The CLI:

- Reads frontmatter (`title`, `description`, `tags`, `cover_image`) from the
  markdown.
- Builds `canonical_url` as `{product.blog_url}/<slug>` from the brand
  config (or honors the value already in frontmatter).
- Defaults tags to `seo.devto_default_tags` if frontmatter omits them.
- POSTs to `https://dev.to/api/articles` with header
  `api-key: $DEVTO_API_KEY`.
- Prints the draft URL (e.g. `https://dev.to/<user>/<slug>-temp-slug`) and
  the dev.to article ID.

To update an existing draft instead of creating a new one:

```bash
bun skills/blog-writing/scripts/devto-cli.ts update \
  --id <article_id> \
  --file <workspace_dir>/<slug>.md
```

To list current drafts for sanity-checking:

```bash
bun skills/blog-writing/scripts/devto-cli.ts list-drafts
```

### Completion Criteria
- CLI exits 0.
- `devto_article_id` and `devto_draft_url` captured.
- A spot-check of the draft URL shows the article exists with
  `published: false` and the expected canonical URL.

## Step: Notify approver
Step ID: notify

### Instructions
Call the existing `notify` skill (apprise transport) with the channel from
`publishing.approval.notify_channel` (or the `notify_channel` param if
overridden):

```bash
bash skills/notify/scripts/notify.sh \
  --channel <notify_channel> \
  --subject "Blog draft ready for review: <title>" \
  --body "$(cat <<EOF
<approver_mention> — a new draft is ready.

Title: <title>
Topic: <topic>
Pillar: <pillar_primary>
Word count: <word_count>
Dev.to draft: <devto_draft_url>
Canonical (on publish): <canonical_url>

Summary:
<one-paragraph TL;DR from the article>

Reply in-thread to approve or request changes.
EOF
)"
```

`<approver_mention>` comes from `publishing.approval.approver_mention` in
the brand config. The `--channel` value must match a tag in the apprise
config that routes to the reviewer's webhook.

### Completion Criteria
- Notify command exits 0.
- The notification appears in the reviewer channel with the draft URL,
  TL;DR, and approver mention.
- `notified_channel` recorded for the report.

## Step: Emit final report
Step ID: report

### Instructions
Print (or persist) a JSON summary of the run so the caller — or downstream
tooling — can pick the article up after approval. Use this exact shape:

```json
{
  "topic": "<topic>",
  "pillar": "<pillar_primary>",
  "brief_path": "<workspace_dir>/<slug>-brief.md",
  "draft_path": "<workspace_dir>/<slug>.md",
  "devto_article_id": 123456,
  "devto_draft_url": "https://dev.to/<user>/<slug>-temp-slug",
  "canonical_url": "https://<domain>/blog/<slug>",
  "notified_channel": "<notify_channel>",
  "word_count": 1847,
  "internal_link_count": 6,
  "status": "awaiting-approval"
}
```

Status is always `awaiting-approval` on a successful run. The article stays
at `published: false` until a human flips it.

### Completion Criteria
- Report JSON emitted with every field populated.
- `status` is `awaiting-approval`.
- Workflow run is marked complete.
