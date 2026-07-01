# Ingest workflow for wiki:{{WIKI_NAME}}

Wiki location: {{WIKI_DIR}}
Schema: {{SCHEMA_PATH}}

Follow these steps. akm commands handle the invariants; use your native
Read/Write/Edit tools for page edits.

This workflow is for ingesting sources that are ALREADY present under
`{{WIKI_DIR}}/raw/`. Do not ask the user for a source unless the raw queue is
empty and the caller explicitly asked for interactive ingest.

1. **Read the schema.** Open `{{SCHEMA_PATH}}`. It defines the voice, page
   kinds, contradiction policy, and any wiki-specific conventions. Do not
   skip this step even on familiar wikis — the schema may have changed.

2. **Discover the pending raw queue.**
   ```sh
   akm wiki lint {{WIKI_NAME}}
   ```
   Focus on `uncited-raw` findings: those raw files exist under `raw/` but are
   not yet cited by any authored page. Treat each `uncited-raw` finding as a
   pending ingest item, and sort the queue **oldest raw file first** (by
   filename/mtime). Processing oldest-first keeps backlog age bounded even
   when the queue is larger than one run can finish. If there are no
   `uncited-raw` findings, exit cleanly after a final `akm index` +
   `akm wiki lint {{WIKI_NAME}}` verification.

   Do not read or classify the whole backlog upfront. Work the queue as a
   bounded loop, one raw file at a time: fully finish a raw (read → decide →
   edit → log entry, steps 3-7 below) before looking at the next one. If you
   run low on time partway through a large backlog, stop after finishing your
   current raw — do not start a new one you can't complete. This is expected
   and fine: whatever you already merged is committed to the pages and
   `log.md`, so the next scheduled run picks up where you left off instead of
   redoing this run's work.

3. **For the current raw file, read the source and find related pages.**
   Open the raw file directly from `{{WIKI_DIR}}/raw/`.

   If the file does not read as text (binary content, garbled bytes, e.g. a
   raw PDF byte-dump that was never text-extracted), do not attempt deep
   forensic recovery (no web searches, no `strings`-style dumps). Append a
   one-line `log.md` entry noting it as skipped/unprocessable with a short
   reason, then move on to the next raw in the queue.

   Otherwise, search for related pages:
   ```sh
   akm wiki search {{WIKI_NAME}} "<key terms from the raw source>"
   ```
   Read the top hits with `akm show wiki:{{WIKI_NAME}}/pages/<page>`. Use
   `akm show wiki:{{WIKI_NAME}}/pages/<page> toc` for large pages.

4. **Decide for each candidate.** For each related page:
   - **Append**: add a section or paragraph under the relevant heading.
     Include the raw source in the page's `sources:` frontmatter list.
   - **Contradict**: note the tension explicitly; don't silently overwrite.
     Follow the schema's contradiction policy.
   - **Skip**: source doesn't add to this page — move on.

5. **Create new pages for concepts/entities the source introduces**, under
   `{{WIKI_DIR}}/pages/` (never at the wiki root — only `schema.md`,
   `index.md`, and `log.md` belong there). Each new page must have
   frontmatter with `description`, `pageKind`, `xrefs`, and `sources`.
   Cross-reference with related pages both directions.

6. **Update xrefs both ways.** If page A now xrefs page B, page B must xref
   page A. `akm wiki lint {{WIKI_NAME}}` will flag violations.

7. **Append to `log.md`.** One entry per processed raw source (ingested or
   skipped-as-unprocessable): date, raw slug, one-line summary, refs to
   created/edited pages. Newest at the top.

8. **Regenerate the index + verify.**
   ```sh
   akm index
   akm wiki lint {{WIKI_NAME}}
   ```
   Resolve any lint findings before calling the ingest done.

That's it. `akm` never calls an LLM — reasoning is your job; it just owns
the invariants (raw immutability, ref validation, index regeneration,
structural lint).
