<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import { afterNavigate } from "$app/navigation";
  import { api, appHref, assetSource, date, type StateUnavailable, stateUnavailableText } from "./client";
  import { documentTitle, libraryRead, typedLinks } from "./library-model";
  import type { AssetRead, Improvement, SearchHit } from "./library-model";
  import type { FileRequest } from "./library-files-model";
  import type { Bundle, FrontmatterRead, History, Retirement, Source, WriteResult } from "./types";
  import { headingId } from "./ui/markdown.js";
  import { sparkline } from "./ui/lib.js";
  import Markdown from "./Markdown.svelte";
  import Diff from "./Diff.svelte";
  import Icon from "./Icon.svelte";
  import Properties from "./Properties.svelte";
  import FileDialog from "./FileDialog.svelte";
  import AssetRelated from "./AssetRelated.svelte";
  import SensitiveAsset from "./SensitiveAsset.svelte";
  let {
    ref,
    query = new URLSearchParams(),
    returnTo = "/library/search",
    bundles = [],
    match = null,
    mode = "search",
    hideBack = false,
    filesHref = "",
    editHref = "",
    readingHref = "",
    onLoaded,
    onCompare,
    onComparePair,
    onChanged,
  }: {
    ref: string;
    query?: URLSearchParams;
    returnTo?: string;
    bundles?: Bundle[];
    match?: SearchHit | null;
    mode?: "search" | "files";
    /** Another view supplies the way back (project crumbs), so the reader's own link is left out. */
    hideBack?: boolean;
    filesHref?: string;
    editHref?: string;
    readingHref?: string;
    /** The asset was read. */
    onLoaded?: (read: AssetRead) => void;
    /** Compare this asset with one still to be chosen. */
    onCompare?: (ref: string) => void;
    /** Compare these two assets. */
    onComparePair?: (refs: string[]) => void;
    /** The asset was retired, restored, moved or (a sensitive file) rewritten. */
    onChanged?: () => void;
  } = $props();
  let retired = $state<Retirement | null>(null),
    retireRevision = $state("");
  // The asset's own file as it is on disk, and akm's reading of its frontmatter. A failed read is kept with its reason.
  let file = $state<Source | null>(null),
    fileError = $state(""),
    properties = $state<FrontmatterRead | null>(null),
    propertiesFailure = $state("");
  let data = $state<AssetRead | null>(null),
    improve = $state<Improvement | null>(null),
    improveNote = $state(""),
    history = $state<History | null>(null);
  let error = $state(""),
    loading = $state(false),
    tab = $state("Read"),
    busy = $state(false),
    notice = $state("");
  let signal = $state("positive"),
    reason = $state(""),
    tags = $state(""),
    replace = $state(""),
    replacement = $state(""),
    fixReason = $state(""),
    fixSource = $state("");
  let copyRequest = $state<FileRequest | null>(null),
    receipt = $state<WriteResult | null>(null);
  let more = $state<HTMLElement>(),
    moreTrigger = $state<HTMLButtonElement>();
  let heading = $state<HTMLHeadingElement>(),
    viewHeading = $state<HTMLHeadingElement>();
  let outlineOpen = $state(false);
  let controller: AbortController,
    previous = "",
    generation = 0;
  // Library stays mounted when another primary section is selected. A top-layer
  // popover must not outlive its route, even when its ancestor becomes hidden.
  afterNavigate(() => {
    if (more?.isConnected && more.matches(":popover-open")) more.hidePopover();
  });
  const canonical = $derived(data?.durableRef ?? ref);
  const pending = $derived(improve?.proposals.filter((p) => p.status === "pending") ?? []);
  const viewTitle = $derived(
    (
      {
        Related: "Related assets",
        Source: "Source",
        History: "Document history",
        Details: "Asset details",
        Feedback: "Give feedback",
        Fix: "Suggest a fix",
      } as Record<string, string>
    )[tab] ?? "",
  );
  const editorHref = $derived(
    editHref ||
      `/library/edit?ref=${encodeURIComponent(canonical)}&returnTo=${encodeURIComponent(filesHref || returnTo)}&readingFrom=${encodeURIComponent(readingHref || `/library/asset?ref=${encodeURIComponent(canonical)}&returnTo=${encodeURIComponent(returnTo)}`)}`,
  );
  // The page shows the file itself; only an asset with no file in a bundle shows what akm's renderer returned.
  const source = $derived(file ? file.content : data?.location ? "" : assetSource(data?.asset));
  // Where the body starts: akm's reading of the file, or of the text akm's renderer returned for an asset with no file.
  const bodyStart = $derived(file ? properties?.bodyStart : (data?.bodyStart ?? 0));
  const body = $derived(source.slice(bodyStart ?? 0));
  const openingTitle = $derived(body.match(/^#[ \t]+([^\n]+)(?:\n|$)/)?.[1]?.trim());
  const titleAnchor = $derived(
    openingTitle === documentTitle(data?.asset) && data?.headings?.[0]?.text === openingTitle
      ? headingId(data.headings[0].slug)
      : undefined,
  );
  const links = $derived(typedLinks(data?.asset?.links));
  const usageSpark = $derived(
    sparkline(
      (improve?.usageByWeek ?? []).map((week) => week.hits),
      "Weekly finds and opens, last 90 days",
    ),
  );
  // A new reference is read before the page updates, so the asset before it is never drawn under the new address.
  $effect.pre(() => {
    if (!ref || ref === previous) return;
    previous = ref;
    untrack(() => void load(ref));
  });
  // The section the address names is scrolled to once the asset is on screen.
  $effect(() => {
    if (query.get("section") && data) void revealHeading(query.get("section")!);
  });
  /** Focus that moves out of the open menu closes it, so it is not left open over the control that has focus. */
  function leaveMore(event: FocusEvent) {
    if (!(event.relatedTarget instanceof Node) || more?.contains(event.relatedTarget)) return;
    if (more?.matches(":popover-open")) more.hidePopover();
  }
  async function revealHeading(slug: string) {
    await tick();
    document.getElementById(headingId(slug))?.scrollIntoView({ block: "start" });
  }
  async function load(selected: string) {
    retired = null;
    retireRevision = "";
    file = null;
    fileError = "";
    properties = null;
    propertiesFailure = "";
    controller?.abort();
    controller = new AbortController();
    const request = ++generation;
    loading = true;
    error = "";
    data = null;
    improve = null;
    improveNote = "";
    history = null;
    tab = query.get("history") === "1" ? "History" : "Read";
    notice = "";
    receipt = null;
    reason = "";
    tags = "";
    replace = "";
    replacement = "";
    fixReason = "";
    fixSource = "";
    try {
      const read = await libraryRead<AssetRead>("/asset", { ref: selected }, controller.signal);
      if (request !== generation) return;
      data = read;
      onLoaded?.(read);
      if (!read.redacted) {
        if (read.location) void loadFile(read, request);
        libraryRead<Improvement | StateUnavailable>(
          "/asset/improve",
          { ref: read.durableRef ?? selected },
          controller.signal,
        )
          .then((next) => {
            if (request !== generation) return;
            if ("reason" in next) improveNote = stateUnavailableText(next);
            else improve = next;
          })
          .catch((cause: Error) => {
            if (cause.name !== "AbortError" && request === generation) improveNote = cause.message;
          });
        if (tab === "History") await loadHistory();
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError" && request === generation) error = (e as Error).message;
    } finally {
      if (request === generation) {
        loading = false;
        await tick();
        if (request === generation && !query.get("section")) {
          heading?.focus({ preventScroll: true });
          heading?.scrollIntoView({ block: "nearest" });
        }
      }
    }
  }
  async function loadFile(read: AssetRead, request: number) {
    const location = read.location!;
    try {
      const text = await libraryRead<Source>("/desktop/file", { ref: read.durableRef ?? ref }, controller.signal);
      if (request !== generation) return;
      file = text;
      if (read.actions?.retire.allowed) retireRevision = text.revision;
      try {
        const found = await api<FrontmatterRead>(
          "/documents/frontmatter",
          {},
          { bundle: location.bundle, path: location.path, content: text.content },
        );
        if (request === generation) properties = found;
      } catch (cause) {
        if (request === generation) propertiesFailure = (cause as Error).message;
      }
    } catch (cause) {
      if ((cause as Error).name !== "AbortError" && request === generation) fileError = (cause as Error).message;
    }
  }
  async function loadHistory(revision = "") {
    const request = generation;
    try {
      const read = await libraryRead<History>("/asset/history", { ref: canonical, revision }, controller?.signal);
      if (request === generation) history = read;
    } catch (e) {
      if ((e as Error).name !== "AbortError" && request === generation) error = (e as Error).message;
    }
  }
  async function copyRef() {
    more?.hidePopover();
    try {
      await navigator.clipboard.writeText(canonical);
      notice = "Reference copied.";
    } catch {
      notice = "Could not copy the reference.";
    }
    await tick();
    moreTrigger?.focus();
  }
  async function retire() {
    if (busy || !retireRevision || !data?.actions?.retire.allowed) return;
    more?.hidePopover();
    busy = true;
    error = "";
    const request = generation,
      selected = canonical;
    try {
      const result = await api<Retirement>("/asset/retire", {}, { ref: selected, revision: retireRevision });
      if (request === generation) retired = result;
      onChanged?.();
    } catch (cause) {
      error = (cause as Error).message;
    } finally {
      busy = false;
    }
  }
  async function undoRetirement() {
    if (!retired || busy) return;
    busy = true;
    error = "";
    try {
      await api("/proposals/" + encodeURIComponent(retired.proposalId) + "/revert", {}, {});
      await load(ref);
      notice = "Asset restored.";
      onChanged?.();
    } catch (cause) {
      error = (cause as Error).message;
    } finally {
      busy = false;
    }
  }
  async function feedback(fix = false) {
    const selected = canonical,
      request = generation;
    busy = true;
    error = "";
    notice = "";
    receipt = null;
    try {
      const outcome = await api<WriteResult>(
        "/feedback",
        {},
        fix
          ? {
              ref: canonical,
              signal: "negative",
              reason: fixReason,
              replace: [replace],
              with: [replacement],
              source: fixSource,
            }
          : {
              ref: canonical,
              signal,
              reason,
              tags: tags
                .split(",")
                .map((tag) => tag.trim())
                .filter(Boolean),
            },
      );
      if (request !== generation) return;
      receipt = outcome;
      notice = fix ? "Suggested fix recorded for review." : "Feedback recorded.";
      if (!fix) reason = "";
      const refreshed = await libraryRead<AssetRead>("/asset", { ref: selected });
      if (request === generation) data = refreshed;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  /** The same Copy to… as the tree's: akm's copy into a folder chosen in the folder picker. */
  function beginCopy() {
    const location = data?.location;
    if (!location || !data?.actions?.copy.allowed) return;
    more?.hidePopover();
    copyRequest = {
      kind: "copy",
      bundle: location.bundle,
      path: location.path,
      name: location.path.split("/").at(-1) ?? "",
      actions: data.actions,
      destination: { bundle: location.bundle, path: location.parent },
    };
  }
  async function copied(
    done: FileRequest,
    _result: Record<string, unknown>,
    destination: { bundle: string; path: string },
  ) {
    copyRequest = null;
    notice = `Copied ${done.name} to ${destination.path || destination.bundle}.`;
    await tick();
    moreTrigger?.focus();
  }
  async function cancelCopy() {
    copyRequest = null;
    await tick();
    moreTrigger?.focus();
  }
  async function showView(view: string) {
    more?.hidePopover();
    tab = view;
    if (view === "History") await loadHistory();
    await tick();
    const target = view === "Read" ? heading : viewHeading;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "nearest" });
  }
  function compare() {
    more?.hidePopover();
    onCompare?.(canonical);
  }
  function measureReader(node: HTMLElement) {
    let wide: boolean | undefined;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry.contentRect.width >= 960;
      if (next !== wide) {
        wide = next;
        outlineOpen = next;
      }
    });
    observer.observe(node);
    return {
      destroy() {
        observer.disconnect();
      },
    };
  }
  function assetHref(selected: string) {
    if (mode === "files") {
      const params = selected === canonical ? new URLSearchParams(query) : new URLSearchParams();
      params.delete("section");
      params.set("ref", selected);
      params.set("open", "1");
      if (readingHref) params.set("readingFrom", readingHref);
      return `/library/files?${params}`;
    }
    return `/library/asset?ref=${encodeURIComponent(selected)}&returnTo=${encodeURIComponent(returnTo)}`;
  }
  onDestroy(() => controller?.abort());
</script>

{#if error}<div class="notice notice-warn" role="alert">
    {error}{#if !data}<p><button class="btn-secondary" onclick={() => load(ref)}>Retry loading asset</button></p>{/if}
  </div>{/if}
{#if loading}<p class="state" role="status">Loading asset…</p>
{:else if retired}
  <section class="retirement-receipt" aria-label="Retirement receipt">
    <h1>Asset archived</h1>
    <p>Recorded as an accepted retirement. Undo it here, or revert it later from Review.</p>
    <div class="page-actions">
      <button onclick={undoRetirement} disabled={busy}>{busy ? "Restoring…" : "Undo retirement"}</button><a
        class="btn btn-secondary"
        href={appHref(returnTo)}>Back to {mode === "files" ? "folder" : "results"}</a
      >
    </div>
    {#each retired.warnings as warning}<p class="notice notice-warn">{warning}</p>{/each}
    <h3>Archive location</h3>
    {#each retired.archiveDirs as dir}<p class="mono wrap small">{retired.bundle}: {dir}</p>{/each}
  </section>
{:else if data}
  {#if data.redacted}{#key canonical}<SensitiveAsset ref={canonical} {onChanged} />{/key}
  {:else}
    {#if mode === "search" && !hideBack}<div class="reader-navigation">
        <a href={appHref(returnTo)}><Icon name="arrow-left" size={16} />Search results</a>
      </div>{/if}
    <header class="asset-heading">
      <div class="asset-title-row">
        <h1 bind:this={heading} id={titleAnchor} tabindex="-1">{documentTitle(data.asset)}</h1>
        <div class="page-actions">
          {#if data.actions?.edit.allowed}<a class="btn btn-secondary" href={appHref(editorHref)}
              ><Icon name="edit" size={16} />Edit page</a
            >{:else if data.actions}<button
              class="btn btn-secondary"
              aria-disabled="true"
              aria-describedby="edit-page-reason"><Icon name="edit" size={16} />Edit page</button
            >{/if}
          <div class="more-actions">
            <button type="button" class="more-trigger" bind:this={moreTrigger} popovertarget="asset-actions"
              ><Icon name="more" size={18} />More</button
            >
            <div
              id="asset-actions"
              class="action-menu"
              popover="auto"
              role="group"
              aria-label="Page actions"
              bind:this={more}
              onfocusout={leaveMore}
            >
              <div class="menu-group" role="group" aria-label="Inspect page">
                <span class="menu-label">Inspect</span>
                <button onclick={() => showView("Source")}><Icon name="file" size={16} />Source</button>
                <button onclick={() => showView("History")}><Icon name="history" size={16} />History</button>
                <button onclick={() => showView("Details")}><Icon name="sliders" size={16} />Details</button>
              </div>
              <div class="menu-group" role="group" aria-label="Organize page">
                <span class="menu-label">Organize</span>
                <button onclick={compare}>Compare with another asset</button>
                <button onclick={copyRef}><Icon name="link" size={16} />Copy ref</button>
                {#if data.actions}<button
                    onclick={beginCopy}
                    aria-disabled={data.actions.copy.allowed ? undefined : "true"}
                    aria-describedby={data.actions.copy.allowed ? undefined : "copy-reason"}
                    ><Icon name="copy" size={16} />Copy to…</button
                  >{#if !data.actions.copy.allowed}<span class="menu-reason" id="copy-reason"
                      >{data.actions.copy.reason}</span
                    >{/if}{/if}
                {#if data.actions}<button
                    onclick={retire}
                    aria-disabled={busy || !data.actions.retire.allowed || !retireRevision ? "true" : undefined}
                    aria-describedby={data.actions.retire.allowed ? undefined : "retire-reason"}
                    title="Move to the recoverable archive now"><Icon name="history" size={16} />Retire</button
                  >{#if !data.actions.retire.allowed}<span class="menu-reason" id="retire-reason"
                      >{data.actions.retire.reason}</span
                    >{/if}{/if}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="asset-context">
        <span>{data.bundle || data.asset.origin || "Local"} · {data.asset.type}</span>
        {#if data.actions && !data.actions.edit.allowed}<span id="edit-page-reason">{data.actions.edit.reason}</span
          >{/if}
        {#if mode === "search" && filesHref}<a href={appHref(filesHref)}
            ><Icon name="folder" size={15} />View in folder</a
          >{/if}
        <button class="text-action" onclick={() => showView("Related")}
          ><Icon name="link" size={15} />Related assets</button
        >
        {#if pending.length}<a class="pending-review" href={appHref("/review/" + encodeURIComponent(pending[0].id))}
            >{pending.length} proposed {pending.length === 1 ? "change" : "changes"}</a
          >{/if}
      </div>
    </header>
    {#if tab === "Read"}<Properties {properties} failure={propertiesFailure} />{/if}
    {#if notice}<div class="operation-notice" role="status">
        {notice}{#if receipt}<details>
            <summary>Operation receipt</summary
            >{#each Object.entries(receipt).filter( ([, value]) => ["string", "number", "boolean"].includes(typeof value), ) as [key, value]}<p
                class="small wrap"
              >
                <strong>{key}</strong>: {String(value)}
              </p>{/each}
          </details>{/if}
      </div>{/if}
    <div class="asset-main" use:measureReader>
      {#if tab !== "Read"}<div class="view-heading">
          <h3 bind:this={viewHeading} tabindex="-1">{viewTitle}</h3>
          <button class="text-action" onclick={() => showView("Read")}><Icon name="arrow-left" size={16} />Read</button>
        </div>{/if}
      {#if tab === "Read"}
        <div class="reading-layout" class:has-outline={(data.headings?.length ?? 0) > 1}>
          {#if (data.headings?.length ?? 0) > 1}<details class="heading-navigation" bind:open={outlineOpen}>
              <summary>On this page</summary>
              <ul>
                {#each data.headings ?? [] as h}<li>
                    <a href={appHref(assetHref(canonical) + "&section=" + encodeURIComponent(h.slug))}>{h.text}</a>
                  </li>{/each}
              </ul>
            </details>{/if}
          <section class="document-body" aria-label="Content">
            {#if fileError}<p class="notice notice-warn" role="alert">The file could not be read: {fileError}</p>
            {:else if file && !properties && !propertiesFailure}
              <!-- akm has not yet said whether this is a Markdown file -->
            {:else if file && !properties?.markdown}<pre class="code file-code">{file.content}</pre>
            {:else if body.trim()}<Markdown
                content={source}
                bodyStart={bodyStart ?? 0}
                omitHeading={documentTitle(data.asset)}
                ref={canonical}
                bundle={data.bundle ?? ""}
                links={data.links ?? {}}
                headings={data.headings ?? []}
              />
            {:else if !source.trim()}<p class="state">This file is empty.</p>{/if}
          </section>
        </div>
        <div class="reading-feedback">
          <span>Help improve this page</span><button class="text-action" onclick={() => showView("Feedback")}
            >Add feedback</button
          >{#if data.durableRef}<button class="text-action" onclick={() => showView("Fix")}>Suggest a correction</button
            >{/if}
        </div>
      {:else if tab === "Related"}
        {#key canonical}<AssetRelated
            ref={canonical}
            links={data.asset.links}
            href={assetHref}
            onCompare={onComparePair}
          />{/key}
      {:else if tab === "Source"}
        {#if fileError}<p class="notice notice-warn" role="alert">The file could not be read: {fileError}</p>
        {:else}<pre class="code raw-source" role="group" aria-label="Source">{source}</pre>{/if}
      {:else if tab === "History"}
        {#if !history}<p class="muted">Reading history…</p>
        {:else if !history.available}<p class="state">
            No Git history is available for this bundle. General manual-edit undo is not available for a non-Git source.
          </p>
        {:else if history.error}<p class="notice notice-warn" role="alert">Git could not be read: {history.error}</p>
        {:else}
          <ul class="history-list">
            {#each history.commits as c}<li>
                <button class="btn-secondary" onclick={() => loadHistory(c.sha)}>{c.sha.slice(0, 8)}</button>
                <div>
                  {c.subject}
                  <p class="muted small">{date(c.time)} · {c.author}</p>
                </div>
              </li>{/each}
          </ul>
          {#if !history.commits.length}<p class="muted">No committed versions of this file.</p>{/if}
          {#if history.diff}<Diff
              before={history.diff.before}
              after={history.diff.after}
              unified={history.diff.unified ?? ""}
              truncated={history.diff.truncated ?? false}
              redacted={history.diff.redacted ?? false}
            />{/if}
        {/if}
      {:else if tab === "Feedback"}
        <section class="feedback-view" id="asset-feedback" aria-label="Feedback">
          <form
            class="task-form form-grid"
            onsubmit={(event) => {
              event.preventDefault();
              void feedback();
            }}
          >
            <label
              >How was this page?<select bind:value={signal}
                ><option value="positive">Helpful</option><option value="negative">Incorrect or stale</option></select
              ></label
            >
            <label
              >Reason<textarea
                bind:value={reason}
                rows="3"
                required={signal === "negative" && data.feedbackRequireReason}></textarea></label
            >
            <p class="muted small">
              Choose “Incorrect or stale” for content problems, not simply a poor match for your task.
            </p>
            <label
              >Tags <span class="muted">(optional)</span><input
                bind:value={tags}
                placeholder="key:value tags, comma-separated"
              /></label
            >
            <div class="task-submit">
              <button disabled={busy}>Record feedback</button><button
                type="button"
                class="text-action"
                onclick={() => showView("Read")}>Cancel</button
              >
            </div>
          </form>
          <section class="feedback-history">
            <h3>Feedback history</h3>
            <p class="muted small">
              <strong>{data.feedback?.counts.positive ?? 0}</strong> positive ·
              <strong>{data.feedback?.counts.negative ?? 0}</strong> negative
            </p>
            {#if data.feedback?.history.length}<div class="table-wrap">
                <table>
                  <thead><tr><th>When</th><th>Signal</th><th>Source</th><th>Reason / tags</th></tr></thead><tbody
                    >{#each data.feedback.history as event}<tr
                        ><td>{date(event.at)}</td><td>{event.signal}</td><td>{event.source}</td><td
                          >{event.reason ?? ""} {(event.tags ?? []).join(", ")}</td
                        ></tr
                      >{/each}</tbody
                  >
                </table>
              </div>{:else}<p class="muted small">No feedback recorded for this asset.</p>{/if}
          </section>
        </section>
      {:else if tab === "Fix" && data.durableRef}
        <form
          class="task-form form-grid"
          id="asset-fix"
          onsubmit={(event) => {
            event.preventDefault();
            void feedback(true);
          }}
        >
          <p class="muted">Propose a specific correction for review. This does not edit the original page.</p>
          <label>Replace this exact text<textarea bind:value={replace} required rows="3"></textarea></label>
          <label>With<textarea bind:value={replacement} required rows="3"></textarea></label>
          <label>Why<input bind:value={fixReason} required /></label>
          <label
            >Source <span class="muted">(optional)</span><input
              bind:value={fixSource}
              placeholder="URL, command, or file that shows it"
            /></label
          >
          <p class="muted small">The original text must appear exactly once in the source.</p>
          <div class="task-submit">
            <button disabled={busy}>Send suggested fix</button><button
              type="button"
              class="text-action"
              onclick={() => showView("Read")}>Cancel</button
            >
          </div>
        </form>
      {:else if tab === "Details"}
        <div class="asset-details">
          {#if improve?.proposals.some((p) => p.status === "pending")}<section>
              <h3>Pending changes</h3>
              <ul>
                {#each improve.proposals.filter((p) => p.status === "pending") as p}<li>
                    <a href={appHref("/review/" + encodeURIComponent(p.id))}>{p.id}</a> · {p.source}
                  </li>{/each}
              </ul>
            </section>{/if}
          <dl class="asset-definition">
            <dt>Name</dt>
            <dd>{data.asset.name}</dd>
            <dt>Durable ref</dt>
            <dd class="mono wrap">{data.durableRef ?? "Not indexed"}</dd>
            <dt>Path</dt>
            <dd class="mono wrap">{data.asset.path ?? "Not returned"}</dd>
          </dl>
          {#if match}<section>
              <h3>Search match</h3>
              {#if match.description}<p>{match.description}</p>{/if}{#if typeof match.score === "number"}<p
                  class="muted small"
                >
                  Search score: {match.score.toFixed(3)}
                </p>{/if}{#if match.tags?.length}<p>{match.tags.join(" · ")}</p>{/if}
            </section>{/if}
          {#if links.length}<section>
              <h3>Links</h3>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>Direction</th><th>Kind</th><th>Assets</th></tr></thead><tbody
                    >{#each links as row}<tr
                        ><td>{row.direction}</td><td>{row.kind}</td><td
                          >{#each row.refs as linked}<p>
                              <a class="mono wrap" href={appHref(assetHref(linked))}>{linked}</a>
                            </p>{/each}{#if row.total > row.refs.length}<span class="muted">{row.total} total</span
                            >{/if}</td
                        ></tr
                      >{/each}</tbody
                  >
                </table>
              </div>
            </section>{/if}
          <section>
            <h3>Usage and review history</h3>
            {#if improve}<div class="usage-spark">
                {@html typeof usageSpark === "string" ? usageSpark : usageSpark.text}
              </div>
              <p class="muted small">
                {improve.usageByWeek.reduce((sum, w) => sum + w.hits, 0)} finds and opens · last 90 days
              </p>
              <h4>Recent decisions</h4>
              <ul class="plain">
                {#each improve.proposals.filter((p) => p.status !== "pending").slice(0, 5) as p}<li class="small">
                    <a href={appHref("/review/" + encodeURIComponent(p.id))}
                      >{p.outcome === "you"
                        ? "Accepted by you"
                        : p.outcome === "judge"
                          ? "Accepted by judge"
                          : p.outcome === "unknown"
                            ? "Accepted · reviewer unknown"
                            : p.outcome}</a
                    >
                    · {p.source} <span class="muted">{date(p.decidedAt)}</span>
                  </li>{/each}
              </ul>
              {#if !improve.proposals.length}<p class="muted small">
                  No proposals recorded for this asset.
                </p>{/if}{:else}<p class="muted small">
                Usage and proposal context unavailable.{improveNote ? ` ${improveNote}` : ""}
              </p>{/if}
          </section>
        </div>
      {/if}
    </div>
  {/if}
{/if}
{#if copyRequest}<FileDialog
    request={copyRequest}
    bundles={bundles.filter((entry) => entry.enabled).map((entry) => entry.name)}
    onDone={copied}
    onCancel={cancelCopy}
  />{/if}

<style>
  .retirement-receipt {
    max-width: 760px;
    padding: var(--space-5) 0;
  }
  /* The page's heading in this state, at the size it had as a second-level heading. */
  .retirement-receipt h1 {
    margin: 0 0 var(--space-3);
    font-size: var(--text-l);
    line-height: inherit;
    letter-spacing: var(--tracking-snug);
  }
  .retirement-receipt > p {
    line-height: 1.65;
  }
  .retirement-receipt h3 {
    margin-top: var(--space-6);
    font-size: var(--text-m);
  }
  .retirement-receipt .page-actions {
    justify-content: flex-start;
    margin-top: var(--space-5);
    gap: var(--space-3);
  }
  .reader-navigation {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    margin: 0 0 var(--space-4);
    font-size: var(--text-xs);
  }
  .reader-navigation > a {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-height: var(--control-height, 40px);
    color: var(--muted);
    font-weight: 500;
    text-decoration: none;
  }
  .reader-navigation > a:hover {
    color: var(--text);
  }
  .asset-heading {
    margin-bottom: var(--space-6);
  }
  .asset-title-row {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: var(--space-5);
  }
  .asset-heading h1 {
    font-size: clamp(26px, 2.5vw, 34px);
    line-height: 1.25;
    letter-spacing: -0.025em;
    margin: 0;
    overflow-wrap: anywhere;
  }
  .page-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: none;
  }
  .page-actions > .btn {
    white-space: nowrap;
  }
  .asset-heading h1[tabindex="-1"]:focus {
    outline: none;
  }
  .asset-context {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-1) 20px;
    margin-top: var(--space-3);
    font-size: var(--text-xs);
    color: var(--muted);
  }
  .asset-context > a {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    font-weight: 400;
    color: var(--muted);
    text-decoration: none;
  }
  .asset-context > a:hover {
    color: var(--accent);
  }
  .asset-context > .pending-review {
    font-weight: 400;
    color: var(--accent);
  }
  .more-actions {
    position: relative;
    border: 0;
    background: none;
    padding: 0;
  }
  .more-trigger {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: var(--space-2) 10px;
    min-height: var(--control-height, 40px);
    border: 0;
    background: none;
    color: var(--muted);
    font-size: var(--text-xs);
    font-weight: 500;
    border-radius: var(--radius-small);
    anchor-name: --asset-actions;
  }
  .action-menu {
    position: fixed;
    position-anchor: --asset-actions;
    position-area: bottom span-left;
    position-try-fallbacks: flip-block, flip-inline;
    inset: auto;
    justify-self: end;
    margin: var(--space-2) 0;
    width: 248px;
    max-width: calc(100vw - 24px);
    max-height: min(calc(100% - 16px), calc(100dvh - 24px));
    overflow: auto;
    padding: 6px;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-popover);
  }
  /* Menu rows are shorter than buttons, so the eight items fit the native minimum window without a scrollbar. */
  .menu-reason {
    display: block;
    padding: 0 var(--space-3) var(--space-2);
    font-size: var(--text-2xs);
    color: var(--muted);
  }
  .action-menu button {
    display: flex;
    align-items: center;
    justify-content: start;
    gap: var(--space-2);
    min-height: 32px;
    width: 100%;
    text-align: left;
    background: none;
    border: 0;
    color: var(--text);
    padding: 6px 10px;
    font-size: var(--text-xs);
    font-weight: 400;
  }
  .menu-group + .menu-group {
    border-top: 1px solid var(--border);
    padding-top: 6px;
    margin-top: 6px;
  }
  .menu-label {
    display: block;
    color: var(--muted);
    font-size: var(--text-3xs);
    padding: 6px 10px;
  }
  .action-menu button:hover {
    background: var(--surface-2);
  }
  .asset-main {
    min-width: 0;
    container-type: inline-size;
  }
  .document-body {
    max-width: 76ch;
    font-size: var(--text-base);
    line-height: 1.75;
    margin: 0;
    min-width: 0;
  }
  .document-body :global(.md) {
    padding: 0;
    border: 0;
    background: none;
  }
  .document-body :global(blockquote) {
    border-inline-start: 2px solid var(--border-strong);
    padding: var(--space-2) 20px;
    margin: var(--space-5) 0;
    color: var(--muted);
  }
  .document-body :global(.markdown > p:first-child) {
    margin-top: 0;
  }
  .document-body :global(.markdown h2) {
    margin-top: var(--space-6);
  }
  .view-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    margin-bottom: 20px;
  }
  .view-heading h3 {
    margin: 0;
    font-size: var(--text-lead);
  }
  .text-action {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    background: none;
    border: 0;
    color: var(--accent);
    font-size: var(--text-xs);
    min-height: var(--control-height, 40px);
    padding: 6px 0;
  }
  .heading-navigation {
    border: 0;
    background: none;
    margin: 0 0 var(--space-5);
    padding: 0;
  }
  .heading-navigation > summary {
    min-height: var(--control-height, 36px);
    padding: var(--space-2) 0;
    background: none;
    border: 0;
    font-size: var(--text-2xs);
    color: var(--muted);
  }
  .heading-navigation ul {
    list-style: none;
    padding: 0;
    margin: var(--space-2) 0 0;
  }
  .heading-navigation li {
    margin: 0 0 var(--space-2);
    font-size: var(--text-xs);
    line-height: 1.5;
  }
  .heading-navigation a {
    display: block;
    padding: var(--space-1) 0;
    color: var(--muted);
  }
  .heading-navigation a:hover {
    color: var(--accent);
  }
  @container (min-width:960px) {
    .reading-layout.has-outline {
      display: grid;
      grid-template-columns: minmax(0, 76ch) minmax(150px, 1fr);
      gap: var(--space-7);
    }
    .document-body {
      grid-row: 1;
      grid-column: 1;
    }
    .heading-navigation {
      grid-row: 1;
      grid-column: 2;
      align-self: start;
      position: sticky;
      top: 24px;
      margin: 0;
    }
    .heading-navigation > summary {
      font-weight: 600;
      font-size: var(--text-2xs);
    }
  }
  .raw-source {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin: 0;
  }
  .task-form {
    max-width: 640px;
    gap: 20px;
    margin: 0;
  }
  .task-form > p {
    margin: 0;
  }
  .task-submit {
    display: flex;
    align-items: center;
    gap: 20px;
  }
  .feedback-view {
    margin: 0;
  }
  .feedback-history {
    margin-top: 40px;
    border-top: 1px solid var(--border);
    padding-top: var(--space-5);
  }
  .feedback-history h3 {
    margin: 0;
  }
  .reading-feedback {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2) 20px;
    max-width: 76ch;
    margin-top: 40px;
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
    font-size: var(--text-2xs);
    color: var(--muted);
  }
  .reading-feedback .text-action {
    font-size: var(--text-2xs);
  }
  .operation-notice {
    font-size: var(--text-xs);
    margin: 0 0 20px;
    color: var(--ok);
  }
  .operation-notice details {
    margin-top: var(--space-3);
  }
  .asset-definition {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--space-3) var(--space-5);
    font-size: var(--text-xs);
    margin: 0 0 var(--space-6);
  }
  .asset-definition dt {
    color: var(--muted);
  }
  .asset-definition dd {
    margin: 0;
  }
  .asset-details {
    max-width: 880px;
  }
  .asset-details > section {
    margin-top: var(--space-6);
  }
  .asset-details h3 {
    font-size: var(--text-subtitle);
    margin: 0 0 var(--space-4);
  }
  .asset-details h4 {
    font-size: var(--text-s);
    margin: var(--space-5) 0 var(--space-3);
  }
  .asset-details table {
    font-size: var(--text-xs);
  }
  .history-list {
    list-style: none;
    padding: 0;
  }
  .history-list li {
    display: flex;
    gap: var(--space-4);
    align-items: start;
    margin-bottom: 20px;
  }
  .history-list p {
    margin: var(--space-1) 0;
  }
  @media (max-width: 850px) {
    .reader-navigation {
      margin-bottom: var(--space-4);
    }
    .action-menu button {
      min-height: var(--control-height, 44px);
    }
    .asset-heading h1 {
      font-size: var(--text-title);
    }
    .asset-title-row {
      flex-wrap: wrap;
      gap: var(--space-4);
    }
    .page-actions {
      margin-left: auto;
    }
    .asset-context {
      gap: var(--space-1) var(--space-4);
    }
    .asset-definition {
      grid-template-columns: 1fr;
      gap: var(--space-1);
    }
    .asset-definition dd {
      margin-bottom: var(--space-3);
    }
    .reading-feedback {
      gap: var(--space-1) var(--space-4);
    }
    .reading-feedback > span {
      flex-basis: 100%;
    }
  }
</style>
