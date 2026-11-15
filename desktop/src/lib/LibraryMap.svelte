<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  // The library, or one bundle of it, as a mind map of asset types and the tags their assets carry. Choosing a type or a
  // tag draws what it is joined to (declared links and near-duplicate content) and fills the side column with what that
  // group needs: how much of it is read, what is outdated, disliked or duplicated, what it connects to, which bundles
  // repeat it, what people searched for and did not find, and, for any asset, the content closest to it in meaning.
  import { api } from "./client";
  import {
    buildOverview,
    firstProblem,
    groupFacts,
    mindMap,
    OUTDATED_LINKS,
    type Overview,
    type OverviewPayload,
    type Pair,
    PROBLEMS,
    RECENT_DAYS,
    relations,
    tally,
    USE_CLASSES,
    VIEWS,
    type View,
  } from "./library-overview";
  import { filesHref } from "./library-files-model";
  import { libraryRead, searchHref } from "./library-model";
  import MindMap, { type Segment } from "./MindMap.svelte";
  import { workspace } from "./state/workspace.svelte";

  /** `?select=<ref>`: open the tag this asset is under. */
  let { select: wanted = "" }: { select?: string } = $props();

  type Miss = { query: string; count: number; lastAt: string };
  type Similar = { ref: string; title: string; cosine: number };

  let o = $state.raw<Overview | null>(null);
  let misses = $state.raw<Miss[]>([]);
  let error = $state("");
  let notice = $state("");
  let view = $state<View>("contents");
  let bundle = $state(-1);
  let selected = $state("");
  /** The asset whose closest content is open, and what was found. */
  let near = $state<{ ref: string; matches: Similar[] | null; error: string } | null>(null);

  const open = (ref: string) => searchHref(new URLSearchParams(), ref);
  const compare = (a: string, b: string) =>
    `/library/search?${new URLSearchParams([
      ["compare", a],
      ["compare", b],
    ])}`;
  const pct = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)}%` : "–");
  const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  const short = (ref: string) => ref.split("//").at(-1) ?? ref;

  async function load() {
    error = "";
    try {
      const payload = await api<OverviewPayload>("/graph");
      if (!payload.available) {
        notice = payload.note;
        return;
      }
      o = buildOverview(payload);
    } catch (cause) {
      error = (cause as Error).message;
    }
    try {
      misses = (await api<{ misses: Miss[] }>("/search/misses", { since: "90d" })).misses;
    } catch {
      misses = [];
    }
  }
  void load();

  /** The assets in scope: one bundle, or all of them. */
  const scope = $derived(o ? o.ref.map((_, i) => i).filter((i) => bundle < 0 || o!.bundle[i] === bundle) : []);
  const readsOf = (members: readonly number[]) => members.reduce((sum, i) => sum + o!.shows[i]!, 0);
  // Each view draws the tags its question is about: the largest, the most read, or the ones with most problems.
  const branches = $derived(
    o ? mindMap(o, 44, scope, view === "use" ? readsOf : view === "problems" ? (m) => problemsOf(m) : undefined) : [],
  );
  const parts = $derived(
    new Map(
      branches.flatMap((b) => [
        [b.key, { name: b.label, type: "", tag: "", members: b.members }] as const,
        ...b.leaves.map((l) => [l.key, { name: l.label, type: b.label, tag: l.label, members: l.members }] as const),
      ]),
    ),
  );
  const largestTag = $derived(Math.max(1, ...branches.flatMap((b) => b.leaves.map((l) => l.members.length))));
  $effect(() => {
    if (!o || !wanted) return;
    const i = o.ref.indexOf(wanted);
    if (i < 0) {
      notice = `No asset “${wanted}” is in the library.`;
      return;
    }
    const b = branches.find((x) => x.members.includes(i));
    selected = b?.leaves.find((l) => l.members.includes(i))?.key ?? b?.key ?? "";
  });

  const useOf = (members: readonly number[]) =>
    tally(
      members,
      (i) => o!.use[i] ?? null,
      USE_CLASSES.map((u) => u.id),
    );
  function problemsOf(members: readonly number[]) {
    return members.filter((i) => o!.problems[i]!.length > 0).length;
  }

  /** What a type's or tag's label says in each view. */
  function figure(members: number[]): string {
    if (view === "use" && o!.useKnown) return `${plural(readsOf(members), "read")}`;
    if (view === "problems") return plural(problemsOf(members), "problem");
    return members.length.toLocaleString();
  }
  /** The bar under a tag: its assets, split by what the view shows. */
  function bar(members: number[]): Segment[] {
    if (view === "use" && o!.useKnown) {
      const u = useOf(members);
      return USE_CLASSES.map((c) => ({ n: u[c.id], token: c.token }));
    }
    if (view === "problems") {
      const p = tally(
        members,
        (i) => firstProblem(o!, i),
        PROBLEMS.map((x) => x.id),
      );
      const none = members.length - PROBLEMS.reduce((sum, x) => sum + p[x.id], 0);
      return [...PROBLEMS.map((x) => ({ n: p[x.id], token: x.token })), { n: none, token: "--use-0" }];
    }
    return [{ n: members.length, token: `--map-${o!.family[members[0] ?? 0]! + 1}` }];
  }

  function choose(key: string) {
    selected = selected === key ? "" : key;
    near = null;
  }
  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape" && selected) choose(selected);
  }

  // ---- The side column ----
  const part = $derived(parts.get(selected) ?? null);
  const members = $derived(part?.members ?? scope);
  const facts = $derived(o ? groupFacts(o, members) : null);
  // Problems draws only what makes a problem: replacement and contradiction links, and near-duplicates.
  const joined = $derived(
    o && selected ? relations(o, branches, selected, view === "problems" ? OUTDATED_LINKS : null) : [],
  );
  /** How many declared links each asset has, either way. */
  const degree = $derived.by(() => {
    const d = new Array<number>(o?.count ?? 0).fill(0);
    for (const l of o?.links ?? []) {
      d[l.from]!++;
      d[l.to]!++;
    }
    return d;
  });
  const top = (list: readonly number[], by: (i: number) => number) =>
    list.filter((i) => by(i) > 0).sort((a, b) => by(b) - by(a) || a - b);
  const mostRead = $derived(o ? top(members, (i) => o!.shows[i]!) : []);
  const mostLinked = $derived(o ? top(members, (i) => degree[i]!) : []);
  /** Never read in the window, the longest unchanged first. */
  const neverRead = $derived(
    o
      ? members
          .filter((i) => o!.use[i] === "unread" || o!.use[i] === "new")
          .sort((a, b) => (o!.modified[a] ?? "").localeCompare(o!.modified[b] ?? "") || a - b)
      : [],
  );
  const liked = $derived(o ? members.filter((i) => o!.positive[i]! > o!.negative[i]!).length : 0);
  /** What the group is made of: its bundles and its asset types, largest first. */
  const madeOf = $derived.by(() => {
    const count = (label: (i: number) => string) => {
      const m = new Map<string, number>();
      for (const i of members) m.set(label(i), (m.get(label(i)) ?? 0) + 1);
      return [...m].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
    };
    return o
      ? { bundles: count((i) => o!.bundles[o!.bundle[i]!]!), types: count((i) => o!.types[o!.type[i]!]!) }
      : { bundles: [], types: [] };
  });
  const edited = (i: number) => (o!.modified[i] ? `edited ${new Date(o!.modified[i]!).toLocaleDateString()}` : "");
  /** Whether a query uses a tag as a whole word or phrase ("secret" does not mention "sec"). */
  const mentions = (query: string, tag: string) =>
    ` ${query.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `.includes(` ${tag.replace(/[^a-z0-9]+/g, " ").trim()} `);
  /** Searches that found nothing: for a tag, the ones that mention it. */
  const gaps = $derived(part?.tag ? misses.filter((m) => mentions(m.query, part.tag)).slice(0, 6) : misses.slice(0, 6));
  const scopeName = $derived(bundle < 0 ? "All bundles" : (o?.bundles[bundle] ?? ""));
  const nameOf = (key: string) => {
    const p = parts.get(key);
    return p ? (p.type ? `${p.name} · ${p.type}` : `${p.name}, under no tag on the map`) : key;
  };

  async function similar(ref: string) {
    if (near?.ref === ref) {
      near = null;
      return;
    }
    near = { ref, matches: null, error: "" };
    try {
      const result = await libraryRead<{ matches: Similar[] }>("/asset/related", { ref, scope: "all" });
      if (near?.ref === ref) near = { ref, matches: result.matches.slice(0, 6), error: "" };
    } catch (cause) {
      if (near?.ref === ref) near = { ref, matches: [], error: (cause as Error).message };
    }
  }

  const filesLink = $derived(
    filesHref({
      bundle: workspace.bundles.find((b) => b.default)?.name ?? workspace.bundles.find((b) => b.enabled)?.name ?? "",
      path: "",
    }),
  );
  const question = $derived(VIEWS.find((v) => v.id === view)!.question);
  const mapLabel = $derived(
    o
      ? `${question} A mind map of ${plural(scope.length, "asset")} in ${scopeName}: asset types and the tags their assets carry most. Choosing one draws what it is joined to; the column beside it gives its figures.`
      : "",
  );
</script>

{#snippet assetList(list: number[], note: (i: number) => string = () => "", limit = 8)}
  <ul class="read">
    {#each list.slice(0, limit) as i}<li>
        <div class="read-row">
          <a href={open(o!.ref[i]!)} title={o!.ref[i]}>{short(o!.ref[i]!)}</a>{#if note(i)}<span class="count"
              >{note(i)}</span
            >{/if}<button
            class="btn-quiet small"
            title="The assets closest to this one in meaning"
            aria-expanded={near?.ref === o!.ref[i]}
            onclick={() => similar(o!.ref[i]!)}>Closest</button
          >
        </div>
        {#if near?.ref === o!.ref[i]}<div class="near">
            {#if near.error}<p class="muted small">{near.error}</p>
            {:else if !near.matches}<p class="muted small">Finding the closest content…</p>
            {:else if !near.matches.length}<p class="muted small">No embedded content to compare.</p>
            {:else}<ul>
                {#each near.matches as m}<li>
                    <a href={open(m.ref)} title={m.ref}>{short(m.ref)}</a><span class="muted small"
                      >{m.cosine.toFixed(2)}</span
                    ><a class="small" href={compare(o!.ref[i]!, m.ref)}>Compare</a>
                  </li>{/each}
              </ul>{/if}
          </div>{/if}
      </li>{/each}
  </ul>
  {#if list.length > limit}<p class="more">and {(list.length - limit).toLocaleString()} more</p>{/if}
{/snippet}

{#snippet pairList(list: Pair[], limit = 8)}
  <ul class="pairs">
    {#each list.slice(0, limit) as d}<li>
        <a href={open(o!.ref[d.a]!)} title={o!.ref[d.a]}>{short(o!.ref[d.a]!)}</a>
        <a href={open(o!.ref[d.b]!)} title={o!.ref[d.b]}>{short(o!.ref[d.b]!)}</a>
        <span class="pair-foot"
          ><span class="muted">cosine {d.cosine.toFixed(3)}</span><a href={compare(o!.ref[d.a]!, o!.ref[d.b]!)}
            >Compare</a
          ></span
        >
      </li>{/each}
  </ul>
  {#if list.length > limit}<p class="more">and {(list.length - limit).toLocaleString()} more</p>{/if}
{/snippet}

{#snippet connects(what: string)}
  <section>
    <h3>How it connects</h3>
    <dl class="figures">
      <dt>Assets with links</dt>
      <dd>{pct(facts!.linked, facts!.count)}</dd>
      {#if part || bundle >= 0}<dt>Links to the rest of the library</dt>
        <dd>{facts!.linksOut.toLocaleString()}</dd>{/if}
    </dl>
    {#if selected}<p class="muted small">{what}:</p>
      {#if joined.length}<ul class="joined">
          {#each joined.slice(0, 10) as r}<li>
              <button class="link" onclick={() => choose(r.key)}>{nameOf(r.key)}</button>
              <span class="muted small"
                >{r.links ? plural(r.links, "link") : ""}{r.links && r.duplicates ? " · " : ""}{r.duplicates
                  ? plural(r.duplicates, "duplicate")
                  : ""}</span
              >
            </li>{/each}
        </ul>{:else}<p class="muted small">Nothing on the map.</p>{/if}
    {:else}<p class="muted small">Choose a type or tag on the map to see what it is joined to.</p>{/if}
  </section>
{/snippet}

{#snippet overlap()}
  {#if facts!.overlap.length}<section>
      <h3>Repeated in other bundles</h3>
      <ul class="rows">
        {#each facts!.overlap.slice(0, 6) as row}<li>
            {row.bundle}<span class="count">{plural(row.pairs, "near-duplicate pair")}</span>
          </li>{/each}
      </ul>
    </section>{/if}
{/snippet}

<svelte:window onkeydown={onKey} />
<nav class="library-views" aria-label="Library views" data-sveltekit-reset="false">
  <a href="/library/search">Search</a>
  <a href={filesLink}>Files</a>
  <a href="/library/map" aria-current="page">Map</a>
</nav>
<div class="map-page">
  <div class="map-toolbar">
    <h1>Library map</h1>
    <div class="views" role="tablist" aria-label="Question">
      {#each VIEWS as v}<button
          role="tab"
          aria-selected={view === v.id}
          class="btn-quiet"
          title={v.question}
          onclick={() => (view = v.id)}>{v.label}</button
        >{/each}
    </div>
    {#if o}<label class="bundle-pick"
        >Bundle <select
          bind:value={bundle}
          onchange={() => {
            selected = "";
            near = null;
          }}
          ><option value={-1}>All bundles</option>{#each o.bundles as name, b}<option value={b}>{name}</option
            >{/each}</select
        ></label
      >{/if}
  </div>
  <p class="question">{question}</p>
  {#if error}<div class="notice notice-warn" role="alert">
      {error}<button class="btn-secondary" onclick={load}>Retry</button>
    </div>{/if}
  {#if notice}<p class="notice" role="status">{notice}</p>{/if}
  {#if o === null && !error && !notice}<p class="muted" role="status">Reading the library…</p>{/if}
  {#if o && facts}
    <div class="map-body">
      <div class="map-main">
        <div class="map-legend">
          {#if view === "contents"}<p class="muted small">
              Each branch is an asset type; at its end are the tags its assets carry most. Choose a type or tag to draw
              what it is joined to by links or near-duplicate content.
            </p>
          {:else if view === "use"}{#if o.useKnown}<p class="muted small">
                The tags read most; each shows its number of reads, and its bar splits its assets by when they were last
                read.
              </p>
              <ul>
                {#each USE_CLASSES as u}<li>
                    <span class="swatch" style={`background:var(${u.token})`}></span>{u.label}
                  </li>{/each}
              </ul>{:else}<p class="muted small">No usage history is available, so use cannot be shown.</p>{/if}
          {:else}<p class="muted small">
              The tags with the most problem assets; each bar splits its assets by their worst problem.
            </p>
            <ul>
              {#each PROBLEMS as p}<li>
                  <span class="swatch" style={`background:var(${p.token})`}></span>{p.label}
                </li>{/each}
              <li><span class="swatch" style="background:var(--use-0)"></span>No problem recorded</li>
            </ul>{/if}
        </div>
        <div class="map-stage">
          <MindMap
            {branches}
            rootLabel={scopeName}
            rootFigure={view === "contents" ? scope.length.toLocaleString() : figure(scope)}
            {figure}
            {bar}
            scale={largestTag}
            {selected}
            related={joined.slice(0, 12)}
            onSelect={choose}
            label={mapLabel}
          />
        </div>
      </div>

      <aside class="map-side" aria-label="Figures" aria-live="polite">
        <header class="side-head">
          <div>
            <h2>{part ? part.name : scopeName}</h2>
            <p class="muted small">
              {part ? `${part.type ? `Tag in ${part.type} · ` : "Asset type · "}${scopeName}` : "The whole scope"} ·
              {plural(facts.count, "asset")}
            </p>
          </div>
          {#if part}<button class="btn-quiet" onclick={() => choose(selected)} aria-label="Close">✕</button>{/if}
        </header>

        {#if view === "contents"}<section>
            <h3>What it is made of</h3>
            <div class="made-of">
              <ul class="rows">
                {#each madeOf.bundles.slice(0, 5) as [name, n]}<li>
                    {name}<span class="count">{n.toLocaleString()}</span>
                  </li>{/each}
              </ul>
              <ul class="rows">
                {#each madeOf.types.slice(0, 5) as [name, n]}<li>
                    {name}<span class="count">{n.toLocaleString()}</span>
                  </li>{/each}
              </ul>
            </div>
          </section>
          {@render connects("Joined by links and near-duplicates")}
          <section>
            <h3>Most connected</h3>
            {#if mostLinked.length}{@render assetList(mostLinked, (i) => plural(degree[i]!, "link"))}{:else}<p
                class="muted small"
              >
                None of these assets has a declared link.
              </p>{/if}
          </section>
          {@render overlap()}
        {:else if view === "use"}{#if o.useKnown}<section>
              <h3>Is it used?</h3>
              <div class="use-bar" role="img" aria-label="How the assets are used">
                {#each USE_CLASSES as u}{#if facts.use[u.id]}<span
                      style={`flex:${facts.use[u.id]};background:var(${u.token})`}
                      title={`${u.label}: ${facts.use[u.id].toLocaleString()}`}
                    ></span>{/if}{/each}
              </div>
              <dl class="figures">
                <dt>Read in the last {RECENT_DAYS} days</dt>
                <dd>{pct(facts.use.recent, facts.count)}</dd>
                <dt>Never read since {o.useSince ? new Date(o.useSince).toLocaleDateString() : "–"}</dt>
                <dd>{pct(facts.use.new + facts.use.unread, facts.count)}</dd>
                <dt>Liked · disliked</dt>
                <dd>{liked.toLocaleString()} · {facts.disliked.length.toLocaleString()}</dd>
              </dl>
            </section>
            <section>
              <h3>Most read</h3>
              {#if mostRead.length}{@render assetList(mostRead, (i) => plural(o!.shows[i]!, "read"))}{:else}<p
                  class="muted small"
                >
                  Nothing here has been read.
                </p>{/if}
            </section>
            <section>
              <h3>Never read, longest unchanged first</h3>
              {@render assetList(neverRead, edited)}
            </section>{:else}<section><p class="muted small">{o.note}</p></section>{/if}
          <section>
            <h3>Searched for, not found</h3>
            {#if gaps.length}<ul class="rows">
                {#each gaps as m}<li>
                    <a href={`/library/search?${new URLSearchParams([["q", m.query]])}`}>{m.query}</a><span
                      class="count">×{m.count}</span
                    >
                  </li>{/each}
              </ul>{:else}<p class="muted small">
                No search {part?.tag ? `mentioning “${part.tag}” ` : ""}came back empty in the last 90 days.
              </p>{/if}
          </section>
          {@render connects("Joined by links and near-duplicates")}
        {:else}<section>
            <h3>What to fix</h3>
            <details open={facts.outdated.length > 0}>
              <summary
                >Outdated but still here<span class="count">{facts.outdated.length.toLocaleString()}</span></summary
              >
              <p class="muted small">Superseded, contradicted or deprecated: retire them or fix the link.</p>
              {@render assetList(facts.outdated, edited)}
            </details>
            <details open={facts.outdated.length === 0 && facts.duplicatesInside.length > 0}>
              <summary
                >Near-duplicates inside<span class="count">{facts.duplicatesInside.length.toLocaleString()}</span
                ></summary
              >
              <p class="muted small">Both assets here: compare and keep one.</p>
              {@render pairList(facts.duplicatesInside)}
            </details>
            <details>
              <summary
                >Near-duplicates elsewhere<span class="count">{facts.duplicatesOutside.length.toLocaleString()}</span
                ></summary
              >
              <p class="muted small">One asset here, the other outside {part ? "this group" : "this bundle"}.</p>
              {@render pairList(facts.duplicatesOutside)}
            </details>
            <details>
              <summary>Disliked<span class="count">{facts.disliked.length.toLocaleString()}</span></summary>
              <p class="muted small">More negative feedback than positive.</p>
              {@render assetList(facts.disliked, (i) => `${o!.negative[i]} − · ${o!.positive[i]} +`)}
            </details>
            {#if o.duplicatesTruncated}<p class="muted small">
                Near-duplicates count the {o.duplicates.length.toLocaleString()} most alike pairs in the library (cosine
                {o.duplicateThreshold} or more); there are more.
              </p>{/if}
          </section>
          {@render connects("Joined by replacement or contradiction links and near-duplicates")}
          {@render overlap()}
        {/if}
      </aside>
    </div>
  {/if}
</div>

<style>
  .library-views {
    display: flex;
    gap: 24px;
    padding: 0 24px;
    border-bottom: 1px solid var(--border);
    min-height: 44px;
  }
  .library-views a {
    display: flex;
    align-items: center;
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
  .map-page {
    padding: 16px 24px 24px;
  }
  .map-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 12px 16px;
    align-items: center;
  }
  .map-toolbar h1 {
    margin: 0;
  }
  .views {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    min-inline-size: 0;
  }
  .views button[aria-selected="true"] {
    color: var(--text);
    background: var(--surface-2);
    font-weight: 600;
  }
  .bundle-pick {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-inline-start: auto;
    font-size: 13px;
    color: var(--muted);
  }
  .question {
    margin: 6px 0 12px;
    color: var(--muted);
  }
  .map-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 24rem;
    gap: 24px;
    align-items: start;
  }
  .map-main {
    display: grid;
    gap: 8px;
    min-inline-size: 0;
  }
  .map-stage {
    border: 1px solid var(--border);
    background: var(--surface);
    padding: 8px;
    min-inline-size: 0;
  }
  .map-legend {
    min-block-size: 24px;
  }
  .map-legend ul {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 16px;
    font-size: 13px;
  }
  .map-legend li {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .map-legend p {
    margin: 0;
    max-inline-size: 60rem;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .swatch {
    inline-size: 10px;
    block-size: 10px;
    border-radius: 2px;
    flex: none;
  }
  .map-side {
    border: 1px solid var(--border);
    background: var(--surface);
    min-inline-size: 0;
  }
  .map-side section {
    margin: 0;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
  }
  .map-side section > h3 {
    margin: 0 0 8px;
  }
  .map-side p {
    margin: 0 0 4px;
  }
  .side-head {
    display: flex;
    gap: 8px;
    align-items: start;
    padding: 12px 16px;
  }
  .side-head div {
    flex: 1;
    min-inline-size: 0;
  }
  .side-head h2 {
    font-size: 16px;
    margin: 0 0 2px;
    overflow-wrap: anywhere;
  }
  .side-head p {
    margin: 0;
  }
  h3 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    margin: 0 0 8px;
  }
  .made-of {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .use-bar {
    display: flex;
    block-size: 8px;
    border-radius: 4px;
    overflow: hidden;
    background: var(--surface-2);
    margin-block-end: 8px;
  }
  .figures {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 4px 12px;
    margin: 0;
    font-size: 13px;
  }
  .figures dd {
    margin: 0;
    text-align: end;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  details {
    border-bottom: 1px solid var(--border);
  }
  details:last-of-type {
    border-bottom: 0;
  }
  summary {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 0;
    font-size: 13px;
    cursor: pointer;
  }
  details[open] {
    padding-block-end: 8px;
  }
  .count {
    flex: none;
    white-space: nowrap;
    margin-inline-start: auto;
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  summary .count {
    color: var(--text);
    font-weight: 600;
  }
  .rows li,
  .joined li {
    display: flex;
    gap: 8px;
    align-items: baseline;
    font-size: 13px;
    padding: 2px 0;
    min-inline-size: 0;
  }
  .rows a,
  .pairs a,
  .read a,
  .near a {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-inline-size: 0;
  }
  .pairs li {
    display: grid;
    gap: 2px;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .pairs li:last-child {
    border-bottom: 0;
  }
  .pair-foot {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
  }
  .more {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--muted);
  }
  .joined li {
    justify-content: space-between;
  }
  .read li {
    padding: 2px 0;
  }
  .read-row {
    display: flex;
    gap: 8px;
    align-items: baseline;
    font-size: 13px;
    min-inline-size: 0;
  }
  .read-row button {
    padding: 0 6px;
    min-block-size: 0;
    font-size: 12px;
  }
  .near {
    margin: 4px 0 6px 12px;
    padding-inline-start: 8px;
    border-inline-start: 2px solid var(--accent);
  }
  .near li {
    display: flex;
    gap: 8px;
    align-items: baseline;
    font-size: 12px;
  }
  .small {
    font-size: 12px;
  }
  button.link {
    min-block-size: 0;
    border: 0;
    background: none;
    padding: 0;
    color: var(--link);
    font: inherit;
    text-align: start;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  button.link:hover {
    text-decoration: underline;
  }
  /* The map needs about 1,000 px to be read at full size; below that the figures go under it. */
  @media (max-width: 1400px) {
    .map-body {
      grid-template-columns: 1fr;
    }
  }
</style>
