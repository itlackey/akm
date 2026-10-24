# Documentation review prompt

A reusable prompt for a two-stage, code-verified review of a repository's
documentation: first the project's stated principles on their own, then the
whole docs tree checked against the principles and against the code.

How to use it:

1. Open a Claude Code session at the root of the repository to review.
2. Fill in the placeholders in the "Inputs" block below (or leave the defaults
   and let the reviewer discover them).
3. Paste everything below the horizontal rule as the first message. To run only
   the principles critique, paste through the end of "Stage 1" and say so.
4. For a re-run on the same repository, point `PRIOR_FINDINGS` at the appendix
   the last run produced so the new run reports what was fixed, what is still
   open, and what is new.

Budget: the full run on a 70k-line docs tree used four parallel sweeps of
roughly 250k to 300k tokens each plus the main thread, about twelve minutes of
wall clock per sweep. On a small repository run the sweeps sequentially in
one thread.

---

You are reviewing the DOCUMENTATION of the repository in the current working
directory. The documentation is the subject. The source code is read only to
verify what a document claims. Report findings; do not fix anything, do not
edit any repository file, and do not report code bugs, code style, or test
issues. A finding about code exists only when a document makes a claim the
code refutes.

## Inputs

```text
DOCS_ROOT:        docs/                      # the documentation tree
ROOT_DOCS:        README.md AGENTS.md CLAUDE.md CONTRIBUTING.md STABILITY.md SECURITY.md ROADMAP.md CHANGELOG.md   # whichever exist
PRINCIPLES_DOC:   <path, or "find it">       # the project's stated design principles / constraints / tenets
VERSION_SOURCE:   package.json               # or pyproject.toml, Cargo.toml, a VERSION file, git tags
PRIOR_FINDINGS:   <path or none>             # a previous run's appendix, for re-run mode
```

If `PRINCIPLES_DOC` is "find it", locate it by name (principles, tenets,
philosophy, design constraints, invariants) and by what `README.md` or the
docs index links as the design foundation. If there is none, say so and treat
the architecture overview plus any contributor rules file (AGENTS.md,
CLAUDE.md, CONTRIBUTING.md) as the de facto principles for Stage 2.

## Stage 1: the principles on their own

Read only `PRINCIPLES_DOC` and `README.md`. Do not read code or other docs
yet. Treat the README as the product's public promise and check the
principles against it. Produce a critical review that covers, with the
principle number cited for each point:

- **Contradictions and tensions** between principles, and between a
  principle and the README.
- **Gaps**: commitments the README makes that no principle covers (vendor
  neutrality, network and trust posture, privacy, what is authoritative versus
  derived, unattended execution, precedence when two principles collide,
  non-goals).
- **Unclear intent**: undefined terms, qualifier stacks that make a principle
  unfalsifiable, a slogan restating another principle, a tautology nobody
  would argue against.
- **Specification wearing a principle's clothes**: exact field lists, wire
  grammars, vendor or product names, version numbers. These rot and take the
  document's authority with them.
- **Ramifications**, good and bad: what each principle buys and what it costs,
  stated even where the document does not.
- **Precision check** on words like "opaque", "durable", "fail closed",
  "lightweight", "policy", "read-only": does the document say durable across
  what, read-only from whose side, what policy may decide.

End Stage 1 with a per-principle one-line verdict and a short recommendation
for restructuring. Deliver this before starting Stage 2 if the user asked for
the principles critique separately.

## Stage 2: the documentation as a system, verified against code

### Phase A: inventory (do this yourself, in one batch of commands)

1. List every Markdown file under `DOCS_ROOT` with its line count, and the
   total. Note the ratio of documentation lines to source lines.
2. List every `README.md` or index file inside `DOCS_ROOT`. Read the top-level
   docs index and the architecture index in full: they are where the project
   labels documents "normative", "current-truth", "authoritative", "historical",
   or "plan". Those labels are claims to test.
3. Read the current version from `VERSION_SOURCE`.
4. Check `git rev-parse --is-shallow-repository`. If the clone is shallow,
   git dates are useless for dating drift; use `CHANGELOG.md` release entries
   instead and say so in the report.
5. Grep the whole repository, docs and source, for citations of the
   principles document: its filename, "principle", "tenet", and each principle
   number. Record who cites it. If only index pages link to it and no decision
   record argues from it, that is itself a finding.
6. Grep `DOCS_ROOT` for status vocabulary: `Status:`, `normative`,
   `current-truth`, `authoritative`, `historical`, `superseded`, `proposed`,
   `draft`, `in progress`, `ready for implementation`, `TODO`, `will land`.
   Build a list of files that carry a status marker and files that do not.
7. Pick two or three distinctive sentences from the principles document and
   grep for them across `DOCS_ROOT` and the root docs. Count verbatim copies.
8. Read in full, yourself: the architecture overview, the principles document,
   the user-facing concepts or mental-model guide, the product-surface or
   feature-status page, the stability policy, the security policy, the roadmap,
   and the contributor rules file. These are the documents the rest should be
   consistent with, and you need them in your own context to brief the sweeps
   and to judge their findings.
9. Before fanning out, verify a handful of the principles' most concrete claims
   against code yourself, so the sweeps can be told what is already settled:
   default output format, the registered integrations or providers and their
   count, the single write path or chokepoint, any retired flag that a document
   still lists as a feature. Record file and line for each.

### Phase B: partition and sweep

Partition `DOCS_ROOT` so that each sweep reads a coherent set and no two
sweeps read the same files. A partition that worked:

1. **Reference pages versus code.** CLI reference, configuration reference,
   data formats, environment and secrets, telemetry or data inventory, network
   behaviour, supported formats, asset or type taxonomies.
2. **Internals and specs that carry the "current-truth" or "normative"
   label.** Test whether the label holds, file by file.
3. **Guides, plans, posts, migration notes, maintainer docs, integration docs,
   and every per-directory index.** Labelling of historical material, orphans,
   broken links and anchors, command and flag existence.
4. **Decision records and design documents** (ADRs, decision histories,
   subsystem design docs, reviews, comparisons) versus the principles and
   versus code.

Run the sweeps in parallel as subagents when the tool is available. Brief each
one with:

- The task framing above (docs are the subject, code is for verification,
  read-only, no code-quality findings).
- An instruction to read the principles document and skim the architecture
  overview first, with their paths and line counts.
- The facts you already verified in Phase A step 9, with file and line, marked
  "do not re-verify".
- The exact files in its scope, with line counts, and which large files to
  skim rather than read end to end.
- The specific verifications to perform (take them from the list in Phase C).
- The output format: a numbered list of findings, most consequential first,
  capped at about 25 to 30; each finding two to four lines giving
  `doc/path.md:line`, the claim quoted briefly, what the code does with
  `src/path:line`, and a verdict code; then a closing paragraph on whether the
  directory's label holds and which files should be relabelled or deleted.
- The instruction to say "inconclusive" rather than guess, and to skip typos.

### Phase C: what to verify (the checks that find the most)

Every sweep applies these to its scope. Each finding must cite the document
location and the code location that confirms or refutes it.

1. **Cited paths exist.** Every backticked source, script, test, or config
   path a document names: does the file exist, and does the symbol it names
   exist in it. Documents that cite deleted test files, deleted modules, or
   renamed helpers are the single most common form of rot.
2. **Numbers and constants.** Version numbers of persisted formats, schema or
   layout versions, weights, caps, limits, timeouts, TTLs, retention windows,
   counts of things ("fourteen types", "eleven adapters", "three bounds").
   Grep for each constant by name in the code and compare the value. Count how
   many documents repeat the same stale number.
3. **Output shapes.** Any document that lists the fields a command emits at a
   given verbosity or shape: find the projection code and compare field by
   field, including whether a higher level is a superset of a lower one.
4. **Commands and flags.** Sample two or three command examples per guide and
   confirm each subcommand and flag is registered. Grep guides for retired
   spellings the code itself lists as retired.
5. **Status banners versus the shipped version.** A document that says
   "the code does not yet implement", "proposed", "in progress", "ready for
   implementation", or "will": check whether the work shipped (changelog,
   version, presence of the described code). A plan whose work shipped is
   either a duplicate of the current-truth doc or stale.
6. **Network destinations.** For any page that inventories what the tool
   sends and where: enumerate every fetch, download, spawn of a network CLI,
   push, and credential attachment in the code, and diff against the page.
   Look specifically for model or asset downloads on first use, update
   checkers, health probes, publish or push paths, third-party API hosts
   behind a generic "website" feature, and tokens read from the environment
   or from another CLI.
7. **Security claims.** Any sentence of the form "rejects", "never",
   "always", "only through", "allowlist", "guard": find the exact module and
   confirm it is still on the path the document names. A security property
   that moved to a different subsystem, or was removed, is the highest-value
   finding there is.
8. **Design decisions argued against the current code.** A section titled
   "why not X" where the code now does X, a rejected alternative that is now
   the implementation, a rationale for a mechanism that was deleted. These
   mark a document that was never re-baselined.
9. **Within-file contradictions.** A header note saying a feature landed
   above unchecked task boxes; a table row saying a path was removed and a
   later row listing it; "Status: historical" on line 3 and "Status: in
   progress" on line 10.
10. **Doc-to-doc contradictions.** Especially between the document that calls
    itself normative and the detailed document that defers to it. When two
    disagree, the code decides which is right, and the report names both
    locations and the code location.
11. **Copy-pasted sentences.** The same sentence in four places is four places
    to drift. Report the count and locations.
12. **README promises versus principles versus architecture.** The README is
    the strongest promise; check that each headline claim has a principle and
    that the architecture overview agrees.
13. **Labels under test.** For every file under a heading that says
    "normative", "current-truth", or "authoritative inventory", verify three to
    five of its most load-bearing claims. Report, per directory, how many
    files earn the label.
14. **Plans and their status lines.** For each plan or spec with a status
    line, classify as shipped, abandoned, open, or unknowable, with evidence.
    Flag any plan the index or the package manifest promotes to a normative or
    shipped document.
15. **Index completeness and link health.** Run the script in the appendix
    below. Report orphans (files not linked from any index), broken relative
    links, and broken heading anchors, with counts and lists. Distinguish real
    broken links from illustrative link literals inside spec prose or fixtures.
16. **How the principles are used.** Which documents cite them, by number or
    name. Whether any decision record justifies a decision from a principle.
    Whether a contributor rules file (AGENTS.md, CLAUDE.md) carries
    principle-grade rules the principles document does not.
17. **Duplicate mental-model documents.** A concepts guide, a principles
    document, and a contributor rules file that each state the model: list
    where they disagree.
18. **Decision records.** Status field present or absent, date, whether the
    decision is still what the code does (verify one or two claims each),
    whether supersession is recorded, whether more than one decision register
    exists and whether they cross-link, whether the index lists the directory.

Verdict codes, used consistently:

- `STALE`: the document describes code that no longer exists or behaves
  differently.
- `CONTRADICTS <path>`: two documents disagree; the code location says which
  is right.
- `GAP`: behaviour exists and is undocumented, or a document the structure
  implies is missing.
- `PLAN-NOT-CURRENT`: a document presented as normative or current describes
  unshipped, reversed, or superseded work.
- `UNLABELLED-HISTORICAL`, `ORPHAN`, `BROKEN-LINK`: structural findings.
- `OBSOLETE-PRINCIPLE`: a principle that no longer describes the design, as
  shown by the architecture docs and the code together.
- `UNVERIFIABLE`: could not be settled from the tree; say why.
- `OK`: verified accurate. Report these too, briefly, so the reader knows
  what was checked and holds.

### Phase D: verification discipline for the main thread

- Spot-check every headline claim a sweep returns before relaying it: open the
  document line and the code line yourself. A sweep's confident tone is not
  evidence. Drop anything you cannot confirm, or mark it `UNVERIFIABLE` and
  say the sweep asserted it.
- Never report a finding without both locations.
- When a sweep's finding contradicts your own earlier reading, resolve it
  against code before writing anything.
- Keep the principles document in your own context the whole time; every
  finding should be placeable against a principle or against the "no
  principle covers this" gap list.

### Phase E: synthesis

Write two deliverables.

**1. The appendix file**, written to the scratchpad or a path the user names,
with sections:

- A. The principles against the code: one subsection per principle, each with
  what verifies OK, what is stale, what is contradicted, what the principle
  omits, all with locations.
- B. Cross-document contradictions, both sides cited plus the code location.
- C. Stale claims by file, grouped by directory, with the directory's label
  and whether it holds.
- D. Index and link health: counts and lists from the script.
- E. How the principles are used: citations, verbatim copies, the de facto
  constitution document if different.
- F. Fix list, ordered: security-relevant prose first; then the principle
  decisions the maintainer has to make; then mechanical sweeps of repeated
  numbers and paths; then documents to delete or regenerate; then relabelling
  of specs and plans; then decision-record hygiene; then an automated check
  (extend any existing docs linter to verify cited code paths exist).

Send the file to the user.

**2. The chat message**, which must stand on its own for someone who did not
watch the work:

- Open with the verdict in a few sentences: is the principles document a
  governing instrument or a preamble, where the drift concentrates, what is
  healthy.
- State scope and method in two or three sentences, including the shallow
  clone caveat if it applies.
- Section one: the principles against the code, one bullet per principle that
  needed a verdict, leading with the ones the code has left behind. Each
  bullet names the document and the code evidence in words.
- Section two: the documentation as a system. Decision registers, labels that
  do not hold, the one number wrong in many places, the plans directory,
  which document is the real constitution, and a bullet on what is healthy.
- Section three: what to change, as an ordered list that mirrors section F.
- Close with a pointer to the appendix.

Formatting for the message: lead with the outcome; short sentences; bullets
of one to three sentences with the first words bold; no more than three
headers; code identifiers only where the reader must go there; no
parentheticals, em-dashes, or arrows; numbers in a table or on their own line
only when they change what the reader does.

### Re-run mode

When `PRIOR_FINDINGS` is set, read it first. For every prior finding, check
the same document location and code location again and classify it
`FIXED`, `STILL-OPEN`, or `REGRESSED` (fixed once, drifted again). Then run
the full review for new findings. The chat message opens with the three
counts and the appendix carries the per-finding classification above the new
material.

### Appendix: index, link, and anchor checker

Write this to the scratchpad, not the repository, and run it with
`python3 -I script.py <repo-root> <docs-dir>`. It reports files not linked
from any index file inside the docs tree, relative Markdown links whose target
does not exist, and heading anchors that do not resolve.

```python
import os, re, sys

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".")
DOCS = os.path.join(ROOT, sys.argv[2] if len(sys.argv) > 2 else "docs")
INDEX_NAMES = {"README.md", "index.md", "SUMMARY.md"}

md_files = sorted(
    os.path.join(dp, f) for dp, _, fn in os.walk(DOCS) for f in fn if f.endswith(".md")
)
root_readme = os.path.join(ROOT, "README.md")
all_md = md_files + ([root_readme] if os.path.exists(root_readme) else [])
indexes = {p for p in md_files if os.path.basename(p) in INDEX_NAMES}

link_re = re.compile(r"\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
heading_re = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")


def slugify(text):
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = text.strip().lower()
    text = re.sub(r"[^\w\- ]", "", text)
    return text.replace(" ", "-")


def anchors_for(path):
    seen, out = {}, set()
    with open(path, encoding="utf-8", errors="replace") as fh:
        in_fence = False
        for line in fh:
            if line.startswith("```"):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            m = heading_re.match(line)
            if not m:
                continue
            slug = slugify(m.group(2))
            n = seen.get(slug, 0)
            seen[slug] = n + 1
            out.add(slug if n == 0 else f"{slug}-{n}")
    return out


anchor_cache = {}
broken_links, broken_anchors, linked_from_index = [], [], set()

for src in all_md:
    with open(src, encoding="utf-8", errors="replace") as fh:
        for ln, line in enumerate(fh, 1):
            for m in link_re.finditer(line):
                tgt = m.group(1)
                if re.match(r"^[a-z]+:", tgt):
                    continue
                path_part, _, frag = tgt.partition("#")
                target = src if not path_part else os.path.normpath(
                    os.path.join(os.path.dirname(src), path_part)
                )
                if path_part and not path_part.endswith(".md"):
                    continue
                if not os.path.exists(target):
                    broken_links.append((os.path.relpath(src, ROOT), ln, tgt))
                    continue
                if src in indexes and target != src:
                    linked_from_index.add(os.path.realpath(target))
                if frag:
                    if target not in anchor_cache:
                        anchor_cache[target] = anchors_for(target)
                    if frag.lower() not in anchor_cache[target]:
                        broken_anchors.append((os.path.relpath(src, ROOT), ln, tgt))

orphans = [
    os.path.relpath(p, ROOT)
    for p in md_files
    if os.path.basename(p) not in INDEX_NAMES and os.path.realpath(p) not in linked_from_index
]

print(f"markdown files under docs: {len(md_files)} (index files: {len(indexes)})")
print(f"ORPHANS not linked from any index file: {len(orphans)}")
for o in orphans:
    print("  ", o)
print(f"BROKEN LINKS: {len(broken_links)}")
for s, ln, t in broken_links:
    print(f"   {s}:{ln} -> {t}")
print(f"BROKEN ANCHORS: {len(broken_anchors)}")
for s, ln, t in broken_anchors:
    print(f"   {s}:{ln} -> {t}")
```

Inspect every reported broken link before counting it: link literals inside
spec prose or test fixtures are examples, not links.
