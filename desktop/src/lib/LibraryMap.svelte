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
  import { api, apiState } from "./client";
  import { FAMILIES } from "./graph-model";
  import {
    buildOverview,
    DAY,
    depthText,
    firstProblem,
    groupFacts,
    groupJoins,
    groupsOf,
    type Lens,
    lensFor,
    mindMap,
    OUTDATED_LINKS,
    type Overview,
    type OverviewPayload,
    type Pair,
    PROBLEMS,
    placeBy,
    RECENT_DAYS,
    relations,
    tally,
    unplaced,
    USE_CLASSES,
    VIEWS,
    type View,
  } from "./library-overview";
  import { joinsOf, LEVEL_CAP, LEVEL_STYLES, reach } from "./link-levels";
  import { filesHref } from "./library-files-model";
  import { libraryRead, searchHref } from "./library-model";
  import MapOptions from "./MapOptions.svelte";
  import MindMap, { type Segment } from "./MindMap.svelte";
  import SimilarityMap from "./SimilarityMap.svelte";
  import { workspace } from "./state/workspace.svelte";

  /** `?select=<ref>`: open the tag this asset is under. */
  let { select: wanted = "" }: { select?: string } = $props();

  type Miss = { query: string; count: number; lastAt: string };
  type Similar = { ref: string; title: string; cosine: number };

  let o = $state.raw<Overview | null>(null);
  let misses = $state.raw<Miss[]>([]);
  /** Why the searches that found nothing could not be read, when they could not. */
  let missesNote = $state("");
  let error = $state("");
  let notice = $state("");
  let view = $state<View>("contents");
  let bundle = $state(-1);
  let selected = $state("");
  /** Words typed to narrow the map: an asset matches when its name and tags together contain every one. */
  let filter = $state("");
  let cloud = $state<ReturnType<typeof SimilarityMap>>();
  /** The `?select=` asset already opened, so choosing anything else, or resetting, is not undone by it. */
  let opened = "";
  /** The map drawn as tags (types and tags, SVG) or as points in 3D (every asset by meaning, three.js); unchosen,
   * points when the index has assets grouped by meaning. */
  let chosenDepth = $state<"2d" | "3d" | null>(null);
  const depth = $derived(chosenDepth ?? (o?.groupCount ? "3d" : "2d"));
  /** What depth shows on the points: each view opens on its own lens, and Problems with its lens flipped, so what the
   * view is about is in front. A choice lasts until the view changes. */
  const VIEW_LENS: Record<View, Lens["id"]> = { contents: "meaning", use: "recency", problems: "lifecycle" };
  let chosenLens = $state<Lens["id"] | null>(null);
  let chosenFlip = $state<boolean | null>(null);
  /** The points drawn in one plane. */
  let flat = $state(false);
  const lens = $derived(o ? lensFor(o, chosenLens, VIEW_LENS[view]) : null);
  const flip = $derived(!!lens?.bands.length && (chosenFlip ?? (view === "problems" && lens.id === "lifecycle")));
  const place = $derived(o && lens ? placeBy(o, lens, flip, flat) : new Float32Array(0));
  /** What a point's size stands for: Use opens on reads, the other views on one size. A choice lasts as a lens does. */
  const SIZES = [
    { id: "same", label: "One size" },
    { id: "reads", label: "Reads" },
    { id: "links", label: "Links" },
  ] as const;
  type Sizing = (typeof SIZES)[number]["id"];
  let chosenSize = $state<Sizing | null>(null);
  const size = $derived(chosenSize ?? (view === "use" && o?.useKnown ? "reads" : "same"));
  /** Only the assets of this type family (-1: any), and only those of this class of the view's key ("": any). */
  let kind = $state(-1);
  let only = $state("");
  function show(next: View) {
    view = next;
    chosenLens = null;
    chosenFlip = null;
    chosenSize = null;
    only = "";
  }
  /** In 3D, the asset chosen on the map, or -1. */
  let picked = $state(-1);
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
      misses = (await apiState<{ misses: Miss[] }>("/search/misses", { since: "90d" })).misses;
    } catch (cause) {
      misses = [];
      missesNote = (cause as Error).message;
    }
  }
  void load();

  /** The assets in the bundle chosen, or in all of them. */
  const bundleScope = $derived(o ? o.ref.map((_, i) => i).filter((i) => bundle < 0 || o!.bundle[i] === bundle) : []);
  const words = $derived(filter.toLowerCase().split(/\s+/).filter(Boolean));
  /** The class of the view's key an asset is drawn in: its use in Use, its worst problem (or "none") in Problems. */
  const classOf = (i: number) =>
    view === "use" ? (o!.use[i] ?? "") : view === "problems" ? (firstProblem(o!, i) ?? "none") : "";
  /** The assets every filter keeps (the words typed in name or tags, the type, the class chosen in the key), or null
   * when nothing narrows the map. */
  const matching = $derived.by(() => {
    if (!o || (!words.length && kind < 0 && !only)) return null;
    const found = new Set<number>();
    for (const i of bundleScope) {
      if ((kind >= 0 && o.family[i] !== kind) || (only && classOf(i) !== only)) continue;
      const text = `${o.ref[i]} ${(o.tags[i] ?? []).map((t) => o!.tagNames[t]).join(" ")}`.toLowerCase();
      if (words.every((w) => text.includes(w))) found.add(i);
    }
    return found;
  });
  /** The type families the bundle holds, for the Type filter. */
  const kinds = $derived(
    FAMILIES.map((family, k) => ({ k, label: family.label })).filter((f) =>
      bundleScope.some((i) => o!.family[i] === f.k),
    ),
  );
  /** The assets in scope: those of the bundle that match what is typed. */
  const scope = $derived(matching ? bundleScope.filter((i) => matching.has(i)) : bundleScope);
  const readsOf = (members: readonly number[]) => members.reduce((sum, i) => sum + o!.shows[i]!, 0);
  // Each view draws the tags its question is about: the largest, the most read, or the ones with most problems.
  const branches = $derived(
    o ? mindMap(o, 44, scope, view === "use" ? readsOf : view === "problems" ? (m) => problemsOf(m) : undefined) : [],
  );
  /** Groups by meaning, for the 3D map. */
  const groups = $derived(o ? groupsOf(o, bundleScope) : []);
  const parts = $derived(
    new Map<string, { name: string; type: string; tag: string; group: boolean; members: number[] }>([
      ...branches.flatMap((b) => [
        [b.key, { name: b.label, type: "", tag: "", group: false, members: b.members }] as const,
        ...b.leaves.map(
          (l) => [l.key, { name: l.label, type: b.label, tag: l.label, group: false, members: l.members }] as const,
        ),
      ]),
      ...groups.map((g) => [g.key, { name: g.label, type: "", tag: "", group: true, members: g.members }] as const),
    ]),
  );
  const largestTag = $derived(Math.max(1, ...branches.flatMap((b) => b.leaves.map((l) => l.members.length))));
  $effect(() => {
    if (!o || !wanted || opened === wanted) return;
    const i = o.ref.indexOf(wanted);
    if (i < 0) {
      notice = `No asset “${wanted}” is in the library.`;
      return;
    }
    const b = branches.find((x) => x.members.includes(i));
    selected = b?.leaves.find((l) => l.members.includes(i))?.key ?? b?.key ?? "";
    opened = wanted;
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
    picked = -1;
    near = null;
  }
  /** A point chosen on the 3D map: it and its group. */
  function pick(i: number) {
    if (picked === i) {
      choose(selected);
      return;
    }
    selected = `g:${o!.group[i]}`;
    picked = i;
    near = null;
  }
  /** The arrow keys on the 3D map: the previous or next asset of the picked one's group, in name order; with nothing
   * picked, the first of the first group. */
  function step(direction: -1 | 1) {
    const group = groups.find((g) => g.key === (picked >= 0 ? `g:${o!.group[picked]}` : ""));
    const order = [...(group ?? groups[0])!.members].sort((a, b) => (o!.ref[a]! < o!.ref[b]! ? -1 : 1));
    const at = order.indexOf(picked);
    const next = at < 0 ? order[0] : order[(at + direction + order.length) % order.length];
    if (next !== undefined && next !== picked) pick(next);
  }
  /** Everything the map can be changed by, and the camera, back to how it opens. */
  function reset() {
    show("contents");
    flat = false;
    kind = -1;
    bundle = -1;
    filter = "";
    chosenDepth = null;
    selected = "";
    picked = -1;
    near = null;
    opened = wanted;
    cloud?.reset();
  }
  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape" && filter && event.target instanceof HTMLInputElement) filter = "";
    else if (event.key === "Escape" && picked >= 0) picked = -1;
    else if (event.key === "Escape" && selected) choose(selected);
  }

  // ---- The side column ----
  const part = $derived(parts.get(selected) ?? null);
  const members = $derived(part?.members ?? scope);
  const facts = $derived(o ? groupFacts(o, members) : null);
  // Problems draws only what makes a problem: replacement and contradiction links, and near-duplicates.
  const joined = $derived(
    !o || !selected
      ? []
      : selected.startsWith("g:")
        ? groupJoins(o, Number(selected.slice(2)), view === "problems" ? OUTDATED_LINKS : null)
        : relations(o, branches, selected, view === "problems" ? OUTDATED_LINKS : null),
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
  /** Assets in the bundle that are not points on the 3D map: akm's stored layout has no group for them. */
  const offMap = $derived(o ? unplaced(o, bundleScope) : 0);
  const scopeName = $derived(bundle < 0 ? "All bundles" : (o?.bundles[bundle] ?? ""));
  const nameOf = (key: string) => {
    const p = parts.get(key);
    if (!p) return key;
    return p.group || p.type ? (p.type ? `${p.name} · ${p.type}` : p.name) : `${p.name}, under no tag on the map`;
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

  // ---- The 3D map ----
  /** Contents colours a point by its group (hues spaced by the golden angle), Use by its use, Problems by its problem. */
  const colourOf = (i: number) => {
    if (view === "use" && o!.useKnown) return USE_CLASSES.find((u) => u.id === o!.use[i])?.token ?? "--border";
    if (view === "problems") return PROBLEMS.find((p) => p.id === firstProblem(o!, i))?.token ?? "--border";
    return `hsl(${Math.round((o!.group[i]! * 137.508) % 360)} 62% 56%)`;
  };
  /** Every join akm reports for this view: declared links (Problems: replacement and contradiction only) and
   * near-duplicates. */
  const allJoins = $derived(o ? joinsOf(o, view === "problems" ? OUTDATED_LINKS : null) : []);
  /** What the picked asset is joined to directly. */
  const pickedJoins = $derived.by(() => {
    const out: Array<{ i: number; what: string }> = [];
    if (picked >= 0)
      for (const j of allJoins)
        if (j.a === picked || j.b === picked) out.push({ i: j.a === picked ? j.b : j.a, what: j.what });
    return out;
  });
  /** What it is joined to one, two and three steps out. */
  const reached = $derived(o && picked >= 0 ? reach(allJoins, o.count, picked) : null);
  /** Whether an asset is a point on this map: it has a group by meaning and is in the bundle chosen. */
  const drawn = (i: number) => o!.group[i]! >= 0 && (bundle < 0 || o!.bundle[i] === bundle);
  /** Per level: the assets shown on the map, those reached but not on it, and those cut by the cap. */
  const levelFigures = $derived(
    reached?.levels.map((l) => {
      const shown = l.nodes.filter(drawn);
      return { shown, off: l.nodes.length - shown.length, cut: l.cut };
    }) ?? null,
  );
  const lit = $derived(
    picked >= 0
      ? new Set([picked, ...(reached?.levels.flatMap((l) => l.nodes) ?? [])])
      : part?.group
        ? new Set(matching ? part.members.filter((i) => matching.has(i)) : part.members)
        : matching,
  );
  const lines = $derived.by(() => {
    if (!o) return [];
    if (picked >= 0)
      return (reached?.links ?? [])
        .filter((l) => drawn(l.a) && drawn(l.b))
        .map((l) => ({ from: l.a, to: l.b, weight: 1, level: l.level }));
    if (!part?.group) return [];
    const strongest = Math.max(1, ...joined.map((r) => r.links + r.duplicates));
    return joined
      .slice(0, 12)
      .filter((r) => groups.some((g) => g.key === r.key))
      .map((r) => ({ from: selected, to: r.key, weight: (r.links + r.duplicates) / strongest }));
  });
  /** How much larger than plain a point is drawn: by the square root of its figure against the bundle's largest. */
  const sized = $derived(size === "reads" ? (o?.shows ?? []) : size === "links" ? degree : null);
  const largestSized = $derived(sized ? Math.max(0, ...bundleScope.map((i) => sized[i]!)) : 0);
  const sizeOf = (i: number) => (sized && largestSized ? 1 + 1.5 * Math.sqrt(sized[i]! / largestSized) : 1);
  const sizeText = $derived(
    sized
      ? `Size: more ${size}, larger; the largest has ${plural(largestSized, size === "reads" ? "read" : "link")}.${flat ? "" : " A nearer point also draws larger."}`
      : "",
  );
  /** What an asset's colour, depth and size stand for, in akm's recorded figures: said after its name on the map. */
  const ago = (iso: string) => {
    const days = Math.floor((o!.at - Date.parse(iso)) / DAY);
    return days < 1 ? "today" : `${plural(days, "day")} ago`;
  };
  const reads = (i: number) =>
    !o!.useKnown
      ? "reads unknown"
      : o!.shows[i]
        ? `read ${plural(o!.shows[i]!, "time")}${o!.lastShown[i] ? `, last ${ago(o!.lastShown[i]!)}` : ""}`
        : "not read in the window";
  const problem = (i: number) => PROBLEMS.find((p) => p.id === firstProblem(o!, i))?.label.toLowerCase();
  function describe(i: number): string {
    const colour =
      view === "use"
        ? reads(i)
        : view === "problems"
          ? (problem(i) ?? "no problem recorded")
          : (parts.get(`g:${o!.group[i]}`)?.name ?? "");
    const byLens: Record<Lens["id"], () => string[]> = {
      meaning: () => [],
      recency: () => [reads(i)],
      frequency: () => [reads(i)],
      feedback: () => [
        o!.feedbackKnown ? `${o!.positive[i]} positive, ${o!.negative[i]} negative feedback` : "feedback unknown",
      ],
      lifecycle: () => [
        ...(o!.problems[i]!.includes("outdated") ? [PROBLEMS[0]!.label.toLowerCase()] : []),
        edited(i) || "edit time unknown",
      ],
    };
    const bySize = size === "reads" ? reads(i) : size === "links" ? plural(degree[i]!, "link") : "";
    return [...new Set([colour, ...(flat ? [] : byLens[lens!.id]()), bySize])].filter(Boolean).join(" · ");
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

{#snippet keyPick(id: string, label: string, token: string)}
  <button
    class="key-pick"
    aria-pressed={only === id}
    title="Show only these; choose it again to show all"
    onclick={() => (only = only === id ? "" : id)}
    ><span class="swatch" style={`background:var(${token})`}></span>{label}</button
  >
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
          onclick={() => show(v.id)}>{v.label}</button
        >{/each}
    </div>
    <div class="views" role="group" aria-label="Drawing">
      {#each [["2d", "Tags"], ["3d", "Points"]] as const as [id, name]}<button
          class="btn-quiet"
          aria-pressed={depth === id}
          onclick={() => (chosenDepth = id)}>{name}</button
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
      >
      <label class="map-filter"
        >Type <select bind:value={kind}
          ><option value={-1}>All types</option>{#each kinds as f}<option value={f.k}>{f.label}</option>{/each}</select
        ></label
      >
      <label class="map-filter"
        >Filter <input type="search" bind:value={filter} placeholder="Name or tag" autocomplete="off" /></label
      >
      {#if matching}<span class="muted small" role="status"
          >{matching.size.toLocaleString()} of {plural(bundleScope.length, "asset")}</span
        >{/if}
      <button
        class="btn-quiet"
        title="Camera, view, bundle, filter and selection back to how the map opens"
        onclick={reset}>Reset</button
      >
    {/if}
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
          {#if depth === "3d"}<p class="sr-only" role="status">
              {picked >= 0 && levelFigures
                ? `Selected ${o.ref[picked]}. ${levelFigures.map((l, k) => `${LEVEL_STYLES[k]!.label}: ${plural(l.shown.length, "asset")}`).join(". ")}.`
                : ""}
            </p>{/if}
          {#if depth === "3d" && view === "contents"}<p class="muted small">
              Each point is an asset, coloured by its group by meaning.
            </p>
          {:else if view === "contents"}<p class="muted small">
              Each branch is an asset type; at its end are the tags its assets carry most. Choose a type or tag to draw
              what it is joined to by links or near-duplicate content.
            </p>
          {:else if view === "use"}{#if o.useKnown}<p class="muted small">
                {depth === "3d"
                  ? "Each point is an asset, coloured by when it was last read."
                  : "The tags read most; each shows its number of reads, and its bar splits its assets by when they were last read."}
                Choose one below to show only it.
              </p>
              <ul>
                {#each USE_CLASSES as u}<li>{@render keyPick(u.id, u.label, u.token)}</li>{/each}
              </ul>{:else}<p class="muted small">No usage history is available, so use cannot be shown.</p>{/if}
          {:else}<p class="muted small">
              {depth === "3d"
                ? "Each point is an asset, coloured by its worst problem; assets with none are faint."
                : "The tags with the most problem assets; each bar splits its assets by their worst problem."}
              Choose one below to show only it.
            </p>
            <ul>
              {#each PROBLEMS as p}<li>{@render keyPick(p.id, p.label, p.token)}</li>{/each}
              <li>{@render keyPick("none", "No problem recorded", "--use-0")}</li>
            </ul>
            {#if !o.feedbackKnown || !o.duplicatesKnown}<p class="muted small">
                {o.feedbackKnown ? "" : "Disliked assets cannot be shown. "}{o.duplicatesKnown
                  ? ""
                  : "Near-duplicates cannot be shown. "}{o.note}
              </p>{/if}{/if}
        </div>
        <div class="map-stage">
          {#if depth === "3d"}{#if groups.length && lens}<MapOptions
                {o}
                {lens}
                {flip}
                {flat}
                onLens={(id) => {
                  chosenLens = id;
                  chosenFlip = null;
                }}
                onFlip={() => (chosenFlip = !flip)}
                onFlat={() => (flat = !flat)}
                onFront={() => cloud?.faceFront()}
                sizes={SIZES.filter((s) => s.id !== "reads" || o!.useKnown)}
                {size}
                onSize={(id) => (chosenSize = id as Sizing)}
              />
              <SimilarityMap
                bind:this={cloud}
                {o}
                {place}
                {flat}
                depthNote={`${depthText(lens, flip, flat)} ${sizeText}`.trim()}
                {describe}
                {sizeOf}
                scope={bundleScope}
                {groups}
                {colourOf}
                {lit}
                {lines}
                levels={levelFigures
                  ? [levelFigures[0]!.shown, levelFigures[1]!.shown, levelFigures[2]!.shown]
                  : undefined}
                {picked}
                {selected}
                related={joined.slice(0, 12).map((r) => r.key)}
                onPick={pick}
                onGroup={choose}
                onStep={step}
                label={`${question} The ${plural(bundleScope.length - offMap, "asset")} of ${scopeName} that have a group by meaning, as points, in ${plural(groups.length, "group")} named by their tags, groups alike in meaning near each other. ${depthText(lens, flip, flat)}${offMap ? ` ${plural(offMap, "asset")} not shown.` : ""}`}
              >
                {#snippet legend()}{#if picked >= 0 && levelFigures}<div class="levels">
                      <p class="small">
                        <strong>{short(o!.ref[picked]!)}</strong> and what it is joined to, three steps out. A join is drawn
                        once, at the nearest level it belongs to.
                      </p>
                      <ul>
                        {#each LEVEL_STYLES as style, k}
                          {@const f = levelFigures[k]!}
                          {@const colour = `color-mix(in srgb, var(--map-highlight) ${Math.round(100 - 100 * style.mute)}%, var(--bg))`}
                          <li>
                            <svg class="level-key" width="46" height="26" viewBox="0 0 46 26" aria-hidden="true">
                              <line
                                x1="2"
                                x2="30"
                                y1="13"
                                y2="13"
                                style={`stroke:${colour}`}
                                stroke-width={style.width}
                                stroke-dasharray={style.dash ? "5 3" : undefined}
                              />
                              <circle
                                cx="36"
                                cy="13"
                                r={style.ring / 2 - 1.5}
                                fill="none"
                                style={`stroke:${colour}`}
                                stroke-width="2"
                              />
                            </svg>
                            <span
                              >{style.label}: {plural(f.shown.length, "asset")}{f.off
                                ? `, ${f.off.toLocaleString()} not on this map`
                                : ""}{f.cut
                                ? `, ${f.cut.toLocaleString()} more not shown (a level shows its ${LEVEL_CAP} most joined assets)`
                                : ""}</span
                            >
                          </li>
                        {/each}
                      </ul>
                    </div>{/if}{/snippet}
              </SimilarityMap>
              <p class="muted small">
                Each point is an asset. Groups alike in meaning sit near each other and are named by the tags their
                assets carry most; position inside a group is approximate, so use Closest for measured similarity.
                {flat ? "Drag to move (turning is off while flattened)" : "Drag to turn, right-drag to move"}, scroll to
                zoom, hover a point for its name and figures. Choose a group's name to draw what joins it to other
                groups, or a point to draw its links and near-duplicates. With the map focused: left and right step
                through a group's assets{flat ? "" : ", up, down and Shift with left or right turn the view"}, + and −
                zoom, 0 faces the front.
              </p>
              {#if offMap}<p class="muted small" role="status">
                  {plural(offMap, "asset")}
                  {offMap === 1 ? "has" : "have"} no group by meaning, so {offMap === 1 ? "is" : "are"} not shown (not embedded,
                  or added since the last index build).
                </p>{/if}{:else}<p class="notice">
                No stored embeddings, so assets cannot be placed by meaning. Build the index with embeddings, or use
                Tags.
              </p>{/if}
          {:else}<MindMap
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
            />{/if}
        </div>
      </div>

      <aside class="map-side" aria-label="Figures" aria-live="polite">
        <header class="side-head">
          <div>
            <h2>{part ? part.name : scopeName}</h2>
            <p class="muted small">
              {part
                ? `${part.group ? "Group by meaning · " : part.type ? `Tag in ${part.type} · ` : "Asset type · "}${scopeName}`
                : "The whole scope"} ·
              {plural(facts.count, "asset")}
            </p>
          </div>
          {#if part}<button class="btn-quiet" onclick={() => choose(selected)} aria-label="Close">✕</button>{/if}
        </header>

        {#if picked >= 0}<section>
            <h3>Chosen asset</h3>
            {@render assetList([picked], (i) => plural(o!.shows[i]!, "read"))}
            {#if pickedJoins.length}<ul class="rows">
                {#each pickedJoins.slice(0, 10) as j}<li>
                    <button class="link" onclick={() => pick(j.i)} title={o.ref[j.i]}>{short(o.ref[j.i]!)}</button><span
                      class="count">{j.what}</span
                    >
                  </li>{/each}
              </ul>{:else}<p class="muted small">No links or near-duplicates.</p>{/if}
          </section>{/if}

        {#if depth === "3d" && !part && groups.length}<section>
            <h3>Groups by meaning</h3>
            <ul class="rows">
              {#each groups as g (g.key)}<li>
                  <button class="link" onclick={() => choose(g.key)}>{g.label}</button><span class="count"
                    >{figure(g.members)}</span
                  >
                </li>{/each}
            </ul>
          </section>{/if}

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
                <dd>
                  {#if o.feedbackKnown}{liked.toLocaleString()} · {facts.disliked.length.toLocaleString()}{:else}unavailable{/if}
                </dd>
              </dl>
              {#if !o.feedbackKnown}<p class="muted small">Feedback is unavailable: {o.note}</p>{/if}
              {#if facts.useUnclassed}<p class="muted small">
                  {plural(facts.useUnclassed, "asset")} not read in the window and with no edit time akm could read, so they
                  are not classed.
                </p>{/if}
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
              </ul>{:else if missesNote}<p class="muted small">
                Searches that found nothing are unavailable. {missesNote}
              </p>{:else}<p class="muted small">
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
                >Near-duplicates inside<span class="count"
                  >{o.duplicatesKnown ? facts.duplicatesInside.length.toLocaleString() : "unavailable"}</span
                ></summary
              >
              <p class="muted small">Both assets here: compare and keep one.</p>
              {@render pairList(facts.duplicatesInside)}
            </details>
            <details>
              <summary
                >Near-duplicates elsewhere<span class="count"
                  >{o.duplicatesKnown ? facts.duplicatesOutside.length.toLocaleString() : "unavailable"}</span
                ></summary
              >
              <p class="muted small">One asset here, the other outside {part ? "this group" : "this bundle"}.</p>
              {@render pairList(facts.duplicatesOutside)}
            </details>
            <details>
              <summary
                >Disliked<span class="count"
                  >{o.feedbackKnown ? facts.disliked.length.toLocaleString() : "unavailable"}</span
                ></summary
              >
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
  .views button[aria-selected="true"],
  .views button[aria-pressed="true"] {
    color: var(--text);
    background: var(--surface-2);
    font-weight: 600;
  }
  .map-filter {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 13px;
    color: var(--muted);
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
  .levels {
    padding: 6px 10px;
  }
  .levels p {
    margin: 0 0 4px;
  }
  .levels ul {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .levels li {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: var(--text-xs);
  }
  .level-key {
    flex: none;
  }
  .map-legend {
    min-block-size: 24px;
  }
  .key-pick {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 1px 6px;
    font: inherit;
    color: inherit;
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
  }
  .key-pick:hover {
    border-color: var(--border);
  }
  .key-pick[aria-pressed="true"] {
    font-weight: 600;
    background: var(--surface-2);
    border-color: var(--text);
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
