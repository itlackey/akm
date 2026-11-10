<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import { afterNavigate } from "$app/navigation";
  import { assetSource, title, toggleSelection, date, matchesAssetRef, type ApiError } from "./client";
  import { libraryRead, resultContext, searchHref, documentTitle } from "./library-model";
  import { filesHref, parseFilesHref } from "./library-files-model";
  import type { FileLocation, FilesViewState } from "./library-files-model";
  import type { SearchResult, AssetRead } from "./library-model";
  import type { Bundle } from "./types";
  import LibraryAsset from "./LibraryAsset.svelte";
  import LibraryEditor from "./LibraryEditor.svelte";
  import LibraryFile from "./LibraryFile.svelte";
  import SensitiveAsset from "./SensitiveAsset.svelte";
  import SensitiveEditor from "./SensitiveEditor.svelte";
  import LibraryFiles from "./LibraryFiles.svelte";
  import Diff from "./Diff.svelte";
  import Icon from "./Icon.svelte";
  import { navigate } from "./navigation";
  let {
    route = "/search",
    query = new URLSearchParams(),
    bundles = [],
    defaultWriteTarget = "",
    bundleRevision = 0,
  }: {
    route?: string;
    query?: URLSearchParams;
    bundles?: Bundle[];
    defaultWriteTarget?: string;
    bundleRevision?: number;
  } = $props();
  // Plain, not state, like `observed` below: what the two effects last acted on.
  let seenRevision = -1;
  let q = $state(""),
    bundle = $state(""),
    type = $state(""),
    belief = $state("current"),
    limit = $state("50"),
    scope = $state({ user: "", agent: "", run: "", channel: "" });
  let result = $state<SearchResult | null>(null),
    selected = $state<string[]>([]),
    error = $state(""),
    errorCode = $state(""),
    loading = $state(false);
  let searchParams = $state(new URLSearchParams()),
    observed = "",
    searchKey = "",
    controller: AbortController;
  let compared = $state<AssetRead[]>([]),
    compareBusy = $state(false),
    compareKey = "",
    compareController: AbortController;
  let resultList = $state<HTMLElement>(),
    lastRef = "",
    comparisonMode = $state(false);
  let filterDetails = $state<HTMLDetailsElement>(),
    filterTrigger = $state<HTMLElement>();
  let lastFiles = $state(""),
    lastSearch = $state("/library/search"),
    loadedAsset = $state<AssetRead | null>(null),
    locatedRef = $state(""),
    localFileRevision = $state(0),
    mutationRevision = $state(0);
  let resolvingLocation = $state(false),
    locationController: AbortController,
    searchScroll = 0,
    searchWindowScroll = 0,
    searchContainer = $state<HTMLElement>();
  const filesViewState: FilesViewState = {};
  let pendingResultFocus = "";
  let newFiles = $state<HTMLElement>(),
    writeWarnings = $state<string[]>([]);
  afterNavigate(() => {
    if (newFiles?.matches(":popover-open")) newFiles.hidePopover();
  });
  let misses = $state<{
    searches: number;
    foundNothing: number;
    misses: Array<{ query: string; count: number; days: number; lastAt: string }>;
  } | null>(null);
  const types = $derived(
    [
      ...new Set([
        ...bundles.flatMap((b) => Object.keys(b.byType ?? {})),
        ...(result?.hits ?? []).map((h) => h.type ?? ""),
      ]),
    ]
      .filter(Boolean)
      .sort(),
  );
  const defaultBundle = $derived(bundles.find((b) => b.default)?.name ?? "");
  const normalizedRoute = $derived(route.replace(/^#?\//, ""));
  const editing = $derived(normalizedRoute === "edit" || normalizedRoute === "new");
  const newSensitive = $derived(normalizedRoute === "new-sensitive");
  const inFiles = $derived(normalizedRoute === "files" || editing || newSensitive);
  const ref = $derived(query.get("ref") ?? "");
  const compareRefs = $derived(query.getAll("compare"));
  const fileQuery = $derived(
    normalizedRoute === "files" ? query : (parseFilesHref(query.get("returnTo")) ?? new URLSearchParams()),
  );
  const fileBundle = $derived(
    fileQuery.get("bundle") || query.get("bundle") || defaultWriteTarget || bundles.find((b) => b.enabled)?.name || "",
  );
  const filePath = $derived(fileQuery.get("path") ?? query.get("path") ?? "");
  const selectedFilePath = $derived(fileQuery.get("file") ?? "");
  const readingHref = $derived(query.get("readingFrom") || fileQuery.get("readingFrom") || "");
  const reviewHref = $derived(query.get("reviewFrom") || fileQuery.get("reviewFrom") || "");
  const returnTo = $derived(
    normalizedRoute === "new" && query.get("returnTo") === "/"
      ? "/"
      : inFiles
        ? filesHref({ bundle: fileBundle, path: filePath, file: selectedFilePath, ref, open: !!ref }, readingHref)
        : searchHref(resultContext(query)),
  );
  const currentHref = $derived("/library/" + normalizedRoute + (query.size ? "?" + query : ""));
  const activeLocation = $derived(locatedRef === ref ? loadedAsset?.location : null);
  const folderHref = $derived(
    activeLocation
      ? filesHref(
          { bundle: activeLocation.bundle, path: activeLocation.parent, file: activeLocation.path },
          inFiles ? readingHref : currentHref,
        )
      : "",
  );
  const sourceHref = $derived(
    activeLocation
      ? filesHref(
          {
            bundle: activeLocation.bundle,
            path: activeLocation.parent,
            file: activeLocation.path,
            ref: loadedAsset?.durableRef || ref,
            open: true,
          },
          inFiles ? readingHref : currentHref,
        )
      : inFiles
        ? returnTo
        : "",
  );
  const editHref = $derived(
    sourceHref
      ? "/library/edit?" +
          new URLSearchParams({
            ref: loadedAsset?.durableRef || ref,
            returnTo: withReview(sourceHref),
            ...(inFiles ? (readingHref ? { readingFrom: readingHref } : {}) : { readingFrom: currentHref }),
          })
      : "",
  );
  const active = $derived(
    ["type", "bundle", "scope_user", "scope_agent", "scope_run", "scope_channel"].filter((key) => searchParams.get(key))
      .length +
      (searchParams.get("belief") && searchParams.get("belief") !== "current" ? 1 : 0) +
      (searchParams.get("limit") && searchParams.get("limit") !== "50" ? 1 : 0),
  );
  // The address decides what is shown. When it changes, the search, the open asset and the comparison are brought in
  // line with it before the page updates, so nothing is drawn for the new address from the state of the one before.
  $effect.pre(() => {
    if (currentHref === observed) return;
    observed = currentHref;
    untrack(synchronize);
  });
  // Bundles were added, removed, renamed or reindexed: the results on screen are searched again.
  $effect.pre(() => {
    if (seenRevision === bundleRevision) return;
    seenRevision = bundleRevision;
    untrack(() => {
      if (!inFiles) void search();
    });
  });
  function fail(cause: unknown) {
    error = (cause as Error).message;
    errorCode = (cause as ApiError).code ?? "";
  }
  function withReview(href: string) {
    if (!reviewHref || !href) return href;
    const [base, params = ""] = href.split("?"),
      next = new URLSearchParams(params);
    next.set("reviewFrom", reviewHref);
    return base + "?" + next;
  }
  function synchronize() {
    const returningFrom = !ref && !editing && !compareRefs.length ? lastRef : "";
    if (ref !== lastRef) {
      loadedAsset = null;
      locatedRef = "";
    }
    lastRef = ref;
    if (inFiles) {
      if (normalizedRoute === "files") lastFiles = currentHref;
      if (query.has("saved")) localFileRevision++;
      if (editing && ref && !parseFilesHref(query.get("returnTo"))) void resolveLocation(true);
    } else if (normalizedRoute === "asset" && query.get("view") === "files") {
      void resolveLocation(false);
      return;
    } else {
      const previousKey = searchKey;
      searchParams = resultContext(query);
      q = searchParams.get("q") ?? "";
      resetFilterInputs();
      searchKey = searchParams.toString();
      if (!compareRefs.length) lastSearch = currentHref;
      if (searchKey !== previousKey || !result || query.has("saved")) void search();
      if (returningFrom) {
        pendingResultFocus = returningFrom;
        if (!loading) void restoreResultFocus(returningFrom);
      } else if (ref) pendingResultFocus = "";
    }
    const comparison = compareRefs.join("\n");
    if (comparison && comparison !== compareKey && compareRefs.length === 2) {
      compareKey = comparison;
      void compare(compareRefs);
    }
  }
  async function resolveLocation(edit: boolean) {
    locationController?.abort();
    locationController = new AbortController();
    const signal = locationController.signal;
    resolvingLocation = true;
    error = "";
    errorCode = "";
    try {
      const read = await libraryRead<AssetRead>("/asset", { ref }, signal);
      if (signal.aborted) return;
      loadedAsset = read;
      locatedRef = ref;
      if (!read.location) {
        error = "This asset does not have a browsable local bundle location. It can still be read in Search.";
        return;
      }
      const location = read.location;
      const destination = new URLSearchParams(
        filesHref({
          bundle: location.bundle,
          path: location.parent,
          file: location.path,
          ref: read.durableRef || ref,
          open: true,
        }).split("?")[1],
      );
      const origin = query.get("returnTo");
      if (origin?.startsWith("/review")) destination.set("reviewFrom", origin);
      else if (origin?.startsWith("/library/search") || origin?.startsWith("/library/asset"))
        destination.set("readingFrom", origin);
      const href = "/library/files?" + destination;
      await navigate(
        edit
          ? "/library/edit?" +
              new URLSearchParams({
                ref,
                returnTo: href,
                ...(origin?.startsWith("/library/search") ? { readingFrom: origin } : {}),
              })
          : href,
        true,
      );
    } catch (cause) {
      if (!signal.aborted) fail(cause);
    } finally {
      if (!signal.aborted) resolvingLocation = false;
    }
  }
  async function restoreResultFocus(previous: string) {
    await tick();
    if (searchContainer) searchContainer.scrollTop = searchScroll;
    window.scrollTo(0, searchWindowScroll);
    const hit = result?.hits.find((hit) => matchesAssetRef(hit, previous, defaultBundle));
    const link = [...(resultList?.querySelectorAll<HTMLAnchorElement>(".library-hit-content") ?? [])].find(
      (link) => new URLSearchParams(link.search).get("ref") === hit?.ref,
    );
    link?.focus({ preventScroll: true });
    if (link) pendingResultFocus = "";
  }
  function rememberSearch() {
    searchScroll = searchContainer?.scrollTop ?? 0;
    searchWindowScroll = window.scrollY;
  }
  export async function openSearch() {
    const context =
      searchKey || result ? searchParams : resultContext(new URLSearchParams(readingHref.split("?")[1] ?? ""));
    await navigate(searchHref(context));
    await tick();
    searchContainer?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
  }
  function submit() {
    if (filterDetails?.open) {
      // Applied from inside the panel: focus goes back to Filters instead of being dropped with the panel.
      const inside = filterDetails.contains(document.activeElement);
      filterDetails.open = false;
      if (inside) filterTrigger?.focus();
    }
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries({
      q,
      bundle,
      type,
      belief,
      limit,
      ...Object.fromEntries(Object.entries(scope).map(([key, value]) => ["scope_" + key, value])),
    }))
      if (value) next.set(key, value);
    const href = searchHref(next);
    if (location.pathname + location.search === href) {
      searchParams = next;
      void search();
    } else void navigate(href);
  }
  function resetFilterInputs() {
    bundle = searchParams.get("bundle") ?? "";
    type = searchParams.get("type") ?? "";
    belief = searchParams.get("belief") || "current";
    limit = searchParams.get("limit") || "50";
    scope = {
      user: searchParams.get("scope_user") ?? "",
      agent: searchParams.get("scope_agent") ?? "",
      run: searchParams.get("scope_run") ?? "",
      channel: searchParams.get("scope_channel") ?? "",
    };
  }
  function closeFilters() {
    if (filterDetails) filterDetails.open = false;
    resetFilterInputs();
    filterTrigger?.focus();
  }
  /** Focus that moves out of an open overlay closes it, so it is not left open over the control that has focus. */
  function leaveFilters(event: FocusEvent) {
    if (!filterDetails?.open || !(event.relatedTarget instanceof Node)) return;
    if (filterDetails.contains(event.relatedTarget)) return;
    filterDetails.open = false;
    resetFilterInputs();
  }
  function leaveNewFiles(event: FocusEvent) {
    if (!(event.relatedTarget instanceof Node) || newFiles?.contains(event.relatedTarget)) return;
    if (newFiles?.matches(":popover-open")) newFiles.hidePopover();
  }
  function dismissFilters(event: MouseEvent | KeyboardEvent) {
    if (!filterDetails?.open) return;
    if (event instanceof KeyboardEvent) {
      if (event.key === "Escape") closeFilters();
    } else if (event.target instanceof Node && !filterDetails.contains(event.target)) {
      filterDetails.open = false;
      resetFilterInputs();
    }
  }
  /** Ctrl/Cmd+K returns to the search box with the results in view; the shell handles it from other sections. */
  function searchShortcut(event: KeyboardEvent) {
    if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
    event.preventDefault();
    openSearch().catch(fail);
  }
  async function search() {
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    loading = true;
    error = "";
    errorCode = "";
    try {
      if (searchParams.get("tab") === "misses") {
        const next = await libraryRead<NonNullable<typeof misses>>("/search/misses", { since: "30d" }, signal);
        if (!signal.aborted) misses = next;
        return;
      }
      const next = await libraryRead<SearchResult>(
        "/search",
        {
          q,
          bundle,
          type,
          belief,
          limit,
          ...Object.fromEntries(Object.entries(scope).map(([key, value]) => ["scope_" + key, value])),
        },
        signal,
      );
      if (!signal.aborted) result = next;
    } catch (e) {
      if ((e as Error).name !== "AbortError") fail(e);
    } finally {
      if (!signal.aborted) {
        loading = false;
        if (pendingResultFocus && !ref && !inFiles) void restoreResultFocus(pendingResultFocus);
      }
    }
  }
  function tabHref(tab: string) {
    const next = new URLSearchParams(searchParams);
    if (tab === "results") next.delete("tab");
    else next.set("tab", tab);
    return searchHref(next);
  }
  function compareHref() {
    const next = new URLSearchParams(inFiles ? query : searchParams);
    next.delete("compare");
    for (const ref of selected) next.append("compare", ref);
    return (inFiles ? "/library/files?" : "/library/search?") + next;
  }
  function closeComparison() {
    const next = new URLSearchParams(query);
    next.delete("compare");
    return "/library/" + normalizedRoute + (next.size ? "?" + next : "");
  }
  function comparisonLabel(ref: string) {
    const hit = result?.hits.find((hit) => hit.ref === ref);
    return hit ? title(hit) : ref.split("/").at(-1)?.replace(/[-_]/g, " ") || ref;
  }
  function cancelComparison() {
    comparisonMode = false;
    selected = [];
    if (compareRefs.length) void navigate(closeComparison());
  }
  async function compare(refs: string[]) {
    compareController?.abort();
    compareController = new AbortController();
    const signal = compareController.signal;
    compareBusy = true;
    error = "";
    errorCode = "";
    try {
      const data = await Promise.all(refs.map((ref) => libraryRead<AssetRead>("/asset", { ref }, signal)));
      if (!signal.aborted) compared = data;
    } catch (e) {
      if ((e as Error).name !== "AbortError") fail(e);
    } finally {
      if (!signal.aborted) compareBusy = false;
    }
  }
  function receiveAsset(read: AssetRead) {
    loadedAsset = read;
    locatedRef = ref;
  }
  function beginCompare(chosen: string) {
    selected = [chosen];
    comparisonMode = true;
    // Continue in the user's current discovery view, rather than changing
    // Search readers into file-management sessions just to find a second page.
    if (inFiles && folderHref) void navigate(withReview(folderHref));
    else void navigate(searchHref(searchParams));
  }
  function comparePair(refs: string[]) {
    selected = refs;
    comparisonMode = false;
    void navigate(compareHref());
  }
  function navigateFiles(location: FileLocation) {
    void navigate(withReview(filesHref(location, readingHref)));
  }
  async function savedAsset(savedRef: string, unchanged: boolean) {
    if (query.get("file")) {
      const params = new URLSearchParams((query.get("returnTo") ?? "").split("?")[1]);
      params.set("saved", unchanged ? "unchanged" : "1");
      await navigate("/library/files?" + params);
      return;
    }
    const read = await libraryRead<AssetRead>("/asset", { ref: savedRef });
    const location = read.location;
    const href = location
      ? filesHref(
          {
            bundle: location.bundle,
            path: location.parent,
            file: location.path,
            ref: read.durableRef || savedRef,
            open: true,
          },
          readingHref,
        )
      : filesHref({ bundle: fileBundle, path: filePath, ref: savedRef, open: true }, readingHref);
    const params = new URLSearchParams(href.split("?")[1]);
    params.set("saved", unchanged ? "unchanged" : "1");
    await navigate(withReview("/library/files?" + params));
  }
  function createHref(bundle: string, path: string, readingFrom: string, reviewFrom: string) {
    const location = new URLSearchParams(filesHref({ bundle, path }, readingFrom).split("?")[1]);
    if (reviewFrom) location.set("reviewFrom", reviewFrom);
    return (
      "/library/new?" +
      new URLSearchParams({
        bundle,
        path,
        returnTo: "/library/files?" + location,
        ...(readingFrom ? { readingFrom } : {}),
      })
    );
  }
  function createSensitiveHref(kind: string, bundle: string, path: string) {
    return "/library/new-sensitive?" + new URLSearchParams({ kind, bundle, returnTo: filesHref({ bundle, path }) });
  }
  async function savedSensitive(saved: { bundle: string; file: string; ref: string; warnings: string[] }) {
    writeWarnings = saved.warnings;
    mutationRevision++;
    await navigate(
      filesHref({
        bundle: saved.bundle,
        path: saved.file.split("/").slice(0, -1).join("/"),
        file: saved.file,
        open: true,
      }),
    );
  }
  onDestroy(() => {
    controller?.abort();
    compareController?.abort();
    locationController?.abort();
  });
</script>

<svelte:window
  onclick={dismissFilters}
  onkeydown={(event) => {
    dismissFilters(event);
    searchShortcut(event);
  }}
/>
{#if !(ref && !inFiles) && !(normalizedRoute === "asset" && query.get("view") === "files")}
  <nav class="library-views" aria-label="Library views" data-sveltekit-reset="false">
    <a href={lastSearch} aria-current={!inFiles ? "page" : undefined}>Search</a>
    <a
      href={lastFiles || filesHref({ bundle: defaultBundle || bundles.find((b) => b.enabled)?.name || "", path: "" })}
      aria-current={inFiles ? "page" : undefined}>Files</a
    >
  </nav>
{/if}
{#if query.has("saved")}<p class="write-receipt" role="status">
    <Icon name="check" size={16} />{query.get("saved") === "unchanged" ? "No changes to save." : "Changes saved."}
  </p>{/if}
{#each writeWarnings as warning}<p class="notice notice-warn">{warning}</p>{/each}
{#if error}<p class="notice notice-warn" role="alert">
    {error}
    {#if errorCode === "STASH_DIR_NOT_FOUND"}<a href="/setup">Set up akm</a>{/if}
    {#if resolvingLocation}<span>Resolving location…</span>{:else if query.get("view") === "files"}<a
        href={"/library/asset?ref=" + encodeURIComponent(ref)}>Read in Search</a
      >{:else}<button class="btn-secondary" onclick={() => (compareRefs.length === 2 ? compare(compareRefs) : search())}
        >Retry</button
      >{/if}
  </p>{/if}
{#if comparisonMode && compareRefs.length !== 2}<div class="comparison-selection">
    <div>
      <strong
        >{selected.length === 2
          ? "Ready to compare"
          : selected.length === 1
            ? "Choose a second asset"
            : "Choose two assets"}</strong
      ><span
        >{selected.length
          ? selected.map(comparisonLabel).join(" / ")
          : "Select two pages from the results or folders."}</span
      >
    </div>
    {#if selected.length === 2}<a class="btn" href={compareHref()}>Compare</a>{/if}{#if selected.length}<button
        class="quiet"
        onclick={() => (selected = [])}>Clear selection</button
      >{/if}<button class="quiet" onclick={cancelComparison}><Icon name="close" size={16} />Cancel comparison</button>
  </div>{/if}

{#snippet comparison()}
  <header class="comparison-header">
    <div>
      <h1>Compare assets</h1>
      <p class="muted small">Changes between the two source files.</p>
    </div>
    <a href={closeComparison()} onclick={() => (comparisonMode = true)}
      ><Icon name="arrow-left" size={16} />Close comparison</a
    >
  </header>
  {#if compareBusy}<p role="status">Loading both sources…</p>{:else if compared.length === 2}
    {#if compared.some((d) => d.redacted)}<p class="notice">Sensitive values cannot be compared.</p>
    {:else}<div class="comparison-identities">
        {#each compared as item, index}<div>
            <span class="comparison-side"
              >{index === 0 ? "First asset" : "Second asset"} · {item.bundle || item.asset.origin || "Local"}</span
            ><strong>{documentTitle(item.asset)}</strong><a
              href={inFiles && item.location
                ? filesHref(
                    {
                      bundle: item.location.bundle,
                      path: item.location.parent,
                      file: item.location.path,
                      ref: item.durableRef ?? item.asset.ref,
                      open: true,
                    },
                    readingHref,
                  )
                : searchHref(searchParams, item.durableRef ?? item.asset.ref)}
              >Open {documentTitle(item.asset)}<Icon name="arrow-right" size={16} /></a
            >
          </div>{/each}
      </div>
      <Diff
        before={assetSource(compared[0].asset)}
        after={assetSource(compared[1].asset)}
        beforeLabel={documentTitle(compared[0].asset)}
        afterLabel={documentTitle(compared[1].asset)}
        comparing
      />{/if}
  {/if}
{/snippet}
{#if inFiles}
  <LibraryFiles
    {bundles}
    viewState={filesViewState}
    bundleName={fileBundle}
    path={filePath}
    file={selectedFilePath}
    documentOpen={editing || newSensitive || !!ref || fileQuery.get("open") === "1" || compareRefs.length === 2}
    revision={bundleRevision + localFileRevision + mutationRevision}
    {comparisonMode}
    selectedCompare={selected}
    onNavigate={navigateFiles}
    onSelect={(chosen) => (selected = toggleSelection(selected, chosen, 2))}
    onSearch={(name) => navigate(searchHref(new URLSearchParams({ bundle: name })))}
  >
    {#snippet actions()}<div class="files-actions">
        {#if reviewHref}<a href={reviewHref}>Back to review</a>{:else if readingHref && !editing}<a href={readingHref}
            >Back to reading</a
          >{/if}
        {#if !editing && !newSensitive}<div class="new-file-actions">
            <a class="btn btn-secondary" href={createHref(fileBundle, filePath, readingHref, reviewHref)}
              ><Icon name="plus" size={16} />New knowledge</a
            ><button
              class="btn-secondary new-file-trigger"
              popovertarget="new-file-types"
              aria-label="Other file types"
              title="Other file types"><Icon name="chevron-down" size={16} /></button
            >
          </div>
          <div
            id="new-file-types"
            class="new-file-menu"
            popover="auto"
            role="group"
            aria-label="Create file"
            bind:this={newFiles}
            onfocusout={leaveNewFiles}
          >
            <a href={createSensitiveHref("env", fileBundle, filePath)}>Environment file</a><a
              href={createSensitiveHref("secret", fileBundle, filePath)}>Secret</a
            >
          </div>{/if}
      </div>{/snippet}
    {#snippet children({ selectedFile, loading: folderLoading, error: folderError })}<section
        class="inspector files-inspector"
        aria-label="Asset workspace"
      >
        {#if newSensitive}
          {#key query.get("kind")}<SensitiveEditor
              creating
              type={query.get("kind") === "secret" ? "secret" : "env"}
              bundle={fileBundle}
              {bundles}
              onSaved={savedSensitive}
              onCancel={() => navigate(query.get("returnTo") || "/library/files")}
            />{/key}
        {:else if editing}
          {#key normalizedRoute + ":" + ref + ":" + query.get("file")}<LibraryEditor
              ref={normalizedRoute === "new" ? "" : ref}
              file={normalizedRoute === "edit" && !ref && query.get("file")
                ? { bundle: fileBundle, path: query.get("file")! }
                : undefined}
              {query}
              {bundles}
              {defaultWriteTarget}
              returnTo={withReview(returnTo)}
              cancelHref={query.get("file") ? query.get("returnTo")! : withReview(returnTo)}
              {readingHref}
              onSaved={savedAsset}
            />{/key}
        {:else if compareRefs.length === 2}{@render comparison()}
        {:else if ref}
          {#if comparisonMode && !selected.includes(ref)}<button
              class="btn-secondary candidate-button"
              disabled={selected.length === 2}
              onclick={() => (selected = toggleSelection(selected, ref, 2))}>Use for comparison</button
            >{/if}
          {#key bundleRevision + ":" + localFileRevision}<LibraryAsset
              {ref}
              {query}
              returnTo={withReview(filesHref({ bundle: fileBundle, path: filePath }, readingHref))}
              {bundles}
              {defaultWriteTarget}
              mode="files"
              filesHref={folderHref}
              {editHref}
              {readingHref}
              onLoaded={receiveAsset}
              onCompare={beginCompare}
              onComparePair={comparePair}
              onChanged={() => {
                mutationRevision++;
                if (!inFiles) void search();
              }}
            />{/key}
        {:else if /^(env|secrets)\//.test(selectedFilePath)}
          {#key fileBundle + ":" + selectedFilePath}<SensitiveAsset
              bundle={fileBundle}
              file={selectedFilePath}
              onChanged={() => mutationRevision++}
            />{/key}
        {:else if folderError}<p role="alert">{folderError}</p>
          <a href={withReview(filesHref({ bundle: fileBundle, path: filePath }, readingHref))}>Back to folder</a>
        {:else if folderLoading}<p role="status">Checking file…</p>
        {:else if selectedFile?.unavailable}<h1>{selectedFile.name}</h1>
          <p class="notice">{selectedFile.unavailable}</p>
        {:else if selectedFile && selectedFile.assets.length > 1}<h1>{selectedFile.name}</h1>
          <p>This file contains multiple indexed assets. Choose the one to read.</p>
          <ul class="asset-choices">
            {#each selectedFile.assets as { ref: choice }}<li>
                <a
                  href={withReview(
                    filesHref(
                      { bundle: fileBundle, path: filePath, file: selectedFile.path, ref: choice, open: true },
                      readingHref,
                    ),
                  )}>{choice}</a
                >
              </li>{/each}
          </ul>
        {:else if selectedFile}
          {#key fileBundle + ":" + selectedFilePath + ":" + localFileRevision}<LibraryFile
              bundle={fileBundle}
              file={selectedFilePath}
              returnTo={currentHref}
              folderHref={withReview(filesHref({ bundle: fileBundle, path: filePath }, readingHref))}
            />{/key}
        {:else}<h1>{selectedFilePath.split("/").at(-1) || "File"}</h1>
          <p class="notice">This file is no longer present in the folder listing.</p>
          <a href={withReview(filesHref({ bundle: fileBundle, path: filePath, file: selectedFilePath }, readingHref))}
            >Back to folder</a
          >{/if}
      </section>{/snippet}
  </LibraryFiles>
{:else if normalizedRoute === "asset" && query.get("view") === "files"}
  {#if resolvingLocation}<p role="status">Opening the asset’s folder…</p>{/if}
{:else if ref}
  <section class="inspector reading-inspector" aria-label="Asset workspace">
    <LibraryAsset
      {ref}
      {query}
      {returnTo}
      {bundles}
      {defaultWriteTarget}
      mode="search"
      filesHref={folderHref}
      {editHref}
      onLoaded={receiveAsset}
      onCompare={beginCompare}
      onComparePair={comparePair}
      onChanged={() => {
        mutationRevision++;
        if (!inFiles) void search();
      }}
      match={result?.hits.find((hit) => matchesAssetRef(hit, ref, defaultBundle)) ?? null}
    />
  </section>
{:else if compareRefs.length === 2}
  <section class="inspector comparison-inspector" aria-label="Asset workspace">{@render comparison()}</section>
{:else if searchParams.get("tab") === "misses"}
  <section class="library-gaps">
    <a href={tabHref("results")}>Back to library</a>
    <h1>Where searches found nothing</h1>
    {#if misses}<p>{misses.foundNothing} of {misses.searches} searches returned no results in the last 30 days.</p>
      {#if misses.misses.length}<div class="table-wrap">
          <table>
            <thead><tr><th>Query</th><th>Times</th><th>Days</th><th>Last seen</th><th>Next step</th></tr></thead><tbody
              >{#each misses.misses as miss}<tr
                  ><td>{miss.query}</td><td>{miss.count}</td><td>{miss.days}</td><td>{date(miss.lastAt)}</td><td
                    ><a
                      href={"/library/new?q=" +
                        encodeURIComponent(miss.query) +
                        "&returnTo=" +
                        encodeURIComponent(returnTo)}>Write this up</a
                    ></td
                  ></tr
                >{/each}</tbody
            >
          </table>
        </div>{:else}<p>No search gaps recorded in this window.</p>{/if}{/if}
  </section>
{:else}
  <section class="search-page" bind:this={searchContainer}>
    <h1>Library</h1>
    <form
      class="search-form"
      role="search"
      onsubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <input type="search" bind:value={q} placeholder="Search the library" aria-label="Search library" />
      <button disabled={loading}><Icon name="search" size={18} />Search</button>
      <details class="search-filters" bind:this={filterDetails} onfocusout={leaveFilters}>
        <summary
          bind:this={filterTrigger}
          onclick={() => {
            if (filterDetails?.open) resetFilterInputs();
          }}><Icon name="sliders" size={18} />Filters{active ? " (" + active + ")" : ""}</summary
        >
        <div class="filter-panel" role="group" aria-label="Filters">
          <div class="form-grid library-filters">
            <label
              >Bundle<select bind:value={bundle}
                ><option value="">All bundles</option>{#each bundles as b}<option value={b.name}
                    >{b.name}{!b.writable ? " · read-only" : ""}</option
                  >{/each}</select
              ></label
            >
            <label
              >Type<select bind:value={type}
                ><option value="">All types</option>{#each types as t}<option value={t}>{t}</option>{/each}</select
              ></label
            >
            <label
              >Belief state<select bind:value={belief}
                ><option value="current">Current</option><option value="historical">Historical</option><option
                  value="all">All states</option
                ></select
              ></label
            >
            <label
              >Results<select bind:value={limit}><option>50</option><option>100</option><option>200</option></select
              ></label
            >
            {#each ["user", "agent", "run", "channel"] as key}<label
                >Scope: {key}<input
                  value={scope[key as keyof typeof scope]}
                  oninput={(event) => (scope = { ...scope, [key]: event.currentTarget.value })}
                  placeholder="Any"
                /></label
              >{/each}
          </div>
          <div class="filter-footer">
            <button type="submit">Apply filters</button><button
              type="button"
              class="btn-secondary"
              onclick={closeFilters}>Cancel</button
            >{#if active}<a href="/library/search" data-sveltekit-reset="false" onclick={closeFilters}>Clear filters</a
              >{/if}
          </div>
        </div>
      </details>
    </form>
    <div class="search-summary">
      <span class="muted small"
        >{result?.hits.length ?? 0} {q ? "matches" : "assets"} shown{loading ? " · searching…" : ""}</span
      >
      <div>
        <a href={tabHref("misses")}>Search gaps</a>{#if !comparisonMode}<button
            class="quiet"
            onclick={() => (comparisonMode = true)}>Compare assets</button
          >{/if}
      </div>
    </div>
    {#if result?.warnings?.length}<details class="notice">
        <summary>Search notices ({result.warnings.length})</summary>
        <ul>
          {#each result.warnings as warning}<li>{warning}</li>{/each}
        </ul>
      </details>{/if}
    {#if (result?.hits.length ?? 0) >= Number(limit)}<p class="muted small">
        First {limit} matches. Narrow your search to see more specific results.
      </p>{/if}
    <section aria-label="Search results" aria-busy={loading} bind:this={resultList}>
      {#if result && !result.hits.length}<div class="list-empty">
          <h2>No matching assets</h2>
          <p>{result.tip ?? "Try a shorter query or another bundle."}</p>
          {#if q}<a href={"/library/new?q=" + encodeURIComponent(q) + "&returnTo=" + encodeURIComponent(returnTo)}
              >Write this up</a
            >{/if}
          <p><a href="/library/search">Clear filters</a></p>
        </div>{/if}
      <ul class="search-results">
        {#each result?.hits ?? [] as hit (hit.ref)}<li class="search-result">
            {#if comparisonMode}<input
                type="checkbox"
                aria-label={"Select " + title(hit) + " for comparison"}
                checked={selected.includes(hit.ref)}
                disabled={!selected.includes(hit.ref) && selected.length === 2}
                onchange={() => (selected = toggleSelection(selected, hit.ref, 2))}
              />{/if}
            <article>
              <h2>
                <a class="library-hit-content" href={searchHref(searchParams, hit.ref)} onclick={rememberSearch}
                  >{title(hit)}</a
                >
              </h2>
              {#if hit.description}<p>{hit.description}</p>{/if}
              <div class="result-context">
                {hit.origin || (hit.ref.includes("//") ? hit.ref.split("//")[0] : "Default bundle")} · {hit.type}
              </div>
            </article>
          </li>{/each}
      </ul>
    </section>
  </section>
{/if}

<style>
  .new-file-actions {
    display: flex;
    gap: 4px;
  }
  .new-file-trigger {
    anchor-name: --new-file-types;
    padding-inline: 10px;
  }
  .new-file-menu {
    position: fixed;
    position-anchor: --new-file-types;
    position-area: bottom span-left;
    position-try-fallbacks: flip-block, flip-inline;
    inset: auto;
    margin: 8px 0;
    padding: 6px;
    width: 220px;
    max-width: calc(100vw - 24px);
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.12);
  }
  .new-file-menu a {
    display: flex;
    align-items: center;
    min-height: 40px;
    padding: 8px 12px;
    color: var(--text);
    border-radius: 4px;
  }
  .new-file-menu a:hover {
    background: var(--surface-2);
  }
  .inspector,
  .search-page > section {
    margin-block-start: 0;
  }
  .library-views {
    display: flex;
    gap: 24px;
    flex: none;
    padding: 0 24px;
    border-bottom: 1px solid var(--border);
    min-height: 44px;
    align-items: stretch;
  }
  /* Above the search and gaps pages the tabs share their centred column; above Files they span the page. */
  @media (min-width: 851px) {
    :global(.desktop-shell:not(.workspace-active)) .library-views {
      max-width: 1040px;
      margin-inline: auto;
      padding-inline: 48px;
    }
  }
  .library-views a {
    display: flex;
    align-items: center;
    min-height: 44px;
    border-bottom: 2px solid transparent;
    color: var(--muted);
    text-decoration: none;
    font-size: 13px;
  }
  .library-views a[aria-current] {
    color: var(--accent);
    border-color: var(--accent);
    font-weight: 600;
  }
  .search-page {
    max-width: 1040px;
    width: 100%;
    padding: 36px 48px 60px;
    margin: 0 auto;
    overflow: auto;
    min-height: 0;
  }
  .search-page h1 {
    font-size: 28px;
    margin: 0 0 24px;
  }
  .search-form {
    display: flex;
    align-items: stretch;
    gap: 8px;
    position: relative;
    max-width: 800px;
    margin: 0;
  }
  .search-form > input {
    flex: 1;
    min-width: 0;
    font-size: 16px;
    min-height: 44px;
  }
  .search-form > button {
    min-height: 44px;
    padding-inline: 24px;
  }
  .search-filters {
    position: relative;
    flex: none;
    border: 0;
    background: none;
    padding: 0;
  }
  .search-filters > summary {
    min-height: 44px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border: 0;
    background: none;
    font-size: 13px;
    white-space: nowrap;
    cursor: pointer;
    list-style: none;
  }
  .search-filters > summary::-webkit-details-marker {
    display: none;
  }
  .filter-panel {
    position: absolute;
    z-index: 20;
    top: calc(100% + 8px);
    right: 0;
    width: min(680px, calc(100vw - 64px));
    padding: 24px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.1);
  }
  /* Eight fields in two rows, so the panel's footer stays on screen in a short window. */
  .library-filters {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 16px;
  }
  .library-filters :is(select, input) {
    inline-size: 100%;
    min-inline-size: 0;
  }
  .filter-footer {
    display: flex;
    gap: 12px;
    margin-top: 20px;
    align-items: center;
    flex-wrap: wrap;
  }
  .search-filters > summary::before {
    display: none;
  }
  .search-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    max-width: 800px;
    margin: 18px 0 26px;
  }
  .search-summary > div {
    display: flex;
    align-items: center;
    gap: 20px;
    font-size: 12px;
  }
  .quiet {
    background: none;
    border: 0;
    color: var(--muted);
    font-size: 12px;
    min-height: var(--control-height, 36px);
    padding: 4px 0;
    font-weight: 400;
  }
  .search-results {
    list-style: none;
    margin: 0;
    padding: 0;
    max-width: 800px;
  }
  .search-result {
    display: flex;
    gap: 12px;
    margin: 0 0 20px;
    padding: 0 0 18px;
    border-bottom: 1px solid var(--border);
  }
  .search-result:last-child {
    border: 0;
  }
  .search-result > input {
    align-self: start;
    margin-top: 7px;
    flex: none;
  }
  .search-result article {
    min-width: 0;
  }
  .search-result h2 {
    font-size: 21px;
    font-weight: 600;
    line-height: 1.4;
    margin: 0;
  }
  .search-result h2 a {
    text-decoration: none;
    color: var(--accent);
  }
  .search-result h2 a:hover {
    text-decoration: underline;
  }
  .search-result p {
    font-size: 14px;
    line-height: 1.7;
    margin: 5px 0 0;
    max-width: 72ch;
  }
  .result-context {
    font-size: 12px;
    color: var(--muted);
    margin-top: 6px;
  }
  .inspector {
    min-width: 0;
    background: var(--surface);
  }
  .reading-inspector {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 24px clamp(24px, 4vw, 56px) 48px;
  }
  .files-inspector {
    padding: 24px clamp(24px, 3vw, 40px) 48px;
  }
  .comparison-inspector {
    padding: 28px 40px;
    overflow: auto;
  }
  .comparison-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 20px;
    margin-bottom: 24px;
  }
  .comparison-header h1 {
    margin: 0;
    font-size: 25px;
  }
  .comparison-header p {
    margin: 8px 0 0;
  }
  .comparison-header > a {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    white-space: nowrap;
  }
  .comparison-identities {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
    padding: 20px 0;
    margin: 0 0 24px;
    border-block: 1px solid var(--border);
  }
  .comparison-identities strong {
    display: block;
    overflow-wrap: anywhere;
    font-size: 17px;
    margin: 6px 0;
  }
  .comparison-side {
    font-size: 12px;
    color: var(--muted);
  }
  .comparison-identities a {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }
  .comparison-selection {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: none;
    background: var(--surface-2);
    padding: 12px 24px;
    border-bottom: 1px solid var(--border);
  }
  .comparison-selection > div {
    flex: 1;
    min-width: 0;
    font-size: 13px;
  }
  .comparison-selection span {
    display: block;
    font-size: 11px;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .comparison-selection button,
  .comparison-selection .btn {
    min-height: var(--control-height, 36px);
  }
  .candidate-button {
    margin-bottom: 20px;
  }
  .files-actions {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-left: auto;
    font-size: 13px;
  }
  .files-actions .btn {
    min-height: var(--control-height, 36px);
  }
  .asset-choices {
    padding-left: 20px;
  }
  .asset-choices li {
    margin: 14px 0;
    overflow-wrap: anywhere;
  }
  .library-gaps {
    max-width: 1040px;
    margin-inline: auto;
    padding: 28px 48px;
    overflow: auto;
    min-height: 0;
  }
  .write-receipt {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
    margin: 0;
    padding: 12px 24px;
    font-size: 13px;
    color: var(--ok);
  }
  .list-empty {
    padding: 32px 0;
  }
  .list-empty h2 {
    font-size: 20px;
  }
  @media (max-width: 850px) {
    .library-views {
      padding: 0 20px;
    }
    .search-page {
      padding: 28px 24px;
    }
    .search-form {
      flex-wrap: wrap;
    }
    .search-form > input {
      flex: 1;
      max-width: none;
    }
    .search-form > button {
      padding-inline: 16px;
    }
    .search-filters {
      position: static;
      width: 100%;
    }
    .search-filters > summary {
      display: inline-flex;
      padding-left: 0;
    }
    /* The panel spans the search form, which is the page column, so no field is cut at the edge. */
    .filter-panel {
      left: 0;
      right: 0;
      width: auto;
      padding: 16px;
    }
    .library-filters {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .search-summary {
      align-items: start;
      gap: 8px;
      margin-top: 8px;
    }
    .search-summary > div {
      gap: 14px;
      flex-wrap: wrap;
      justify-content: end;
    }
    .reading-inspector {
      padding: 20px 24px 40px;
    }
    .files-inspector {
      padding: 24px 20px;
    }
    .comparison-selection {
      flex-wrap: wrap;
      padding: 12px 16px;
    }
    .comparison-selection > div {
      flex-basis: 100%;
    }
    .comparison-identities {
      grid-template-columns: 1fr;
    }
    .files-actions {
      font-size: 12px;
    }
    .library-filters {
      grid-template-columns: 1fr 1fr;
    }
  }
</style>
