<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script module lang="ts">
  import type { View } from "./library-overview";

  /** Where the map was left this session: opening an asset and coming back returns to the same view, bundle, filter,
   * drawing and group, so a long list can be worked down without finding the place again. */
  const remembered: {
    view: View;
    bundle: number;
    chosenFinding: Partial<Record<View, string>>;
    drawing: "tags" | "2d" | "3d" | null;
    selected: string;
  } = { view: "contents", bundle: -1, chosenFinding: {}, drawing: null, selected: "" };
</script>

<script lang="ts">
  // The library, or one bundle of it, as a mind map of asset types and the tags their assets carry. Choosing a type or a
  // tag draws what it is joined to (declared links and near-duplicate content) and fills the side column with what that
  // group needs: how much of it is read, what is outdated, disliked or duplicated, what it connects to, which bundles
  // repeat it, what people searched for and did not find, and, for any asset, the content closest to it in meaning.
  import { api } from "./client";
  import { FAMILIES } from "./graph-model";
  import {
    buildOverview,
    DAY,
    firstProblem,
    flatPlace,
    groupFacts,
    groupJoins,
    groupsOf,
    mindMap,
    OUTDATED_LINKS,
    type Overview,
    type OverviewPayload,
    type Pair,
    PROBLEMS,
    OLD_DAYS,
    RECENT_DAYS,
    relations,
    tally,
    unplaced,
    USE_CLASSES,
    VIEWS,
  } from "./library-overview";
  import { joinsOf, LEVEL_CAP, LEVEL_STYLES, reach } from "./link-levels";
  import { filesHref } from "./library-files-model";
  import { libraryRead, searchHref } from "./library-model";
  import MindMap, { type Segment } from "./MindMap.svelte";
  import SimilarityMap from "./SimilarityMap.svelte";
  import { workspace } from "./state/workspace.svelte";

  /** `?select=<ref>`: open the tag this asset is under. */
  let { select: wanted = "" }: { select?: string } = $props();

  type Similar = { ref: string; title: string; cosine: number };

  let o = $state.raw<Overview | null>(null);
  let error = $state("");
  let notice = $state("");
  let view = $state<View>(remembered.view);
  let bundle = $state(remembered.bundle);
  let selected = $state(remembered.selected);
  /** Words typed to narrow the map: an asset matches when its name and tags together contain every one. */
  let filter = $state("");
  /** The `?select=` asset already opened, so choosing anything else, or resetting, is not undone by it. */
  let opened = "";
  /** The drawing: the mind map of types and tags (SVG), or every asset as a point by meaning (three.js) in one plane
   * or in 3D; unchosen, the plane when the index has assets grouped by meaning: it is read faster than 3D, which is
   * one choice away. */
  let chosenDrawing = $state<"tags" | "2d" | "3d" | null>(remembered.drawing);
  $effect(() => {
    Object.assign(remembered, { view, bundle, chosenFinding, drawing: chosenDrawing, selected });
  });
  const drawing = $derived(chosenDrawing ?? (o?.groupCount ? "2d" : "tags"));
  const points = $derived(drawing !== "tags");
  const flat = $derived(drawing === "2d");
  const place = $derived(o ? (flat ? flatPlace(o) : o.place) : new Float32Array(0));
  const DRAWINGS = [
    ["tags", "Tags", "The asset types and the tags their assets carry most"],
    ["2d", "2D", "Every asset as a point, placed by meaning, in one plane"],
    ["3d", "3D", "Every asset as a point, placed by meaning, in 3D"],
  ] as const;
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
  }
  void load();

  /** The assets in the bundle chosen, or in all of them. */
  const bundleScope = $derived(o ? o.ref.map((_, i) => i).filter((i) => bundle < 0 || o!.bundle[i] === bundle) : []);
  const words = $derived(filter.toLowerCase().split(/\s+/).filter(Boolean));
  /** The assets of the bundle whose name or tags hold every word typed. */
  const found = $derived(
    o && words.length
      ? bundleScope.filter((i) => {
          const text = `${o!.ref[i]} ${(o!.tags[i] ?? []).map((t) => o!.tagNames[t]).join(" ")}`.toLowerCase();
          return words.every((w) => text.includes(w));
        })
      : bundleScope,
  );
  /** The assets whose name or tags hold every word typed, or null when nothing is typed. */
  const matching = $derived(o && words.length ? new Set(found) : null);
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
  /** The lists opened to their full length, by name. */
  let whole = $state<Record<string, boolean>>({});
  /** The panel beside the map: it shows its top again whenever what is chosen changes. */
  let side = $state<HTMLElement>();
  $effect(() => {
    void selected;
    void picked;
    void view;
    if (side) side.scrollTop = 0;
  });
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
  const top = (list: readonly number[], by: (i: number) => number) =>
    list.filter((i) => by(i) > 0).sort((a, b) => by(b) - by(a) || a - b);
  /** One of a view's filters: the assets (or pairs of assets) its question is asked to find, and what to say of each. */
  type Finding = {
    id: string;
    label: string;
    /** What a group's name says after how many of them it holds. */
    unit: string;
    /** The order of the list, and what to do with what is on it. */
    hint: string;
    assets: number[];
    note: (i: number) => string;
    pairs?: Pair[];
  };
  /** The view's filters over `pool`: the bundle, or the group chosen. */
  function findingsOf(pool: readonly number[]): Finding[] {
    if (!o) return [];
    const f = groupFacts(o, pool);
    const readsOf = (i: number) => (o!.useKnown ? plural(o!.shows[i]!, "read") : "");
    const mostReadFirst = (list: readonly number[]) => [...list].sort((a, b) => o!.shows[b]! - o!.shows[a]! || a - b);
    const ofPairs = (pairs: Pair[]) => [...new Set(pairs.flatMap((d) => [d.a, d.b]))];
    if (view === "use") {
      if (!o.useKnown) return [];
      return [
        {
          id: "retire",
          label: "Never read, untouched 6+ months",
          unit: "to retire",
          hint: "Longest untouched first. Open one to retire it.",
          assets: pool
            .filter((i) => o!.use[i] === "unread")
            .sort((a, b) => (o!.modified[a] ?? "").localeCompare(o!.modified[b] ?? "") || a - b),
          note: untouched,
        },
        ...(o.feedbackKnown
          ? [
              {
                id: "disliked",
                label: "Read but disliked",
                unit: "read but disliked",
                hint: "Most read first. Open one to fix what readers found wrong.",
                assets: top(f.disliked, (i) => o!.shows[i]!),
                note: (i: number) => `${readsOf(i)} · ${o!.negative[i]} down, ${o!.positive[i]} up`,
              },
            ]
          : []),
        {
          id: "most",
          label: "Most read",
          unit: "of the most read",
          hint: "What agents are given most. Open one to check it is still right.",
          assets: top(pool, (i) => o!.shows[i]!).slice(0, 30),
          note: readsOf,
        },
      ];
    }
    if (view === "problems") {
      const pairs = [...f.duplicatesInside, ...f.duplicatesOutside];
      return [
        {
          id: "outdatedRead",
          label: "Outdated, still read",
          unit: "outdated, still read",
          hint: "Agents are still given these. Most read first. Open one to retire it or fix its link.",
          assets: top(f.outdated, (i) => o!.shows[i]!),
          note: outdatedNote,
        },
        ...(o.duplicatesKnown
          ? [
              {
                id: "pairs",
                label: "Near-identical pairs",
                unit: "in near-identical pairs",
                hint: "Compare each pair and keep one.",
                assets: ofPairs(pairs),
                note: () => "",
                pairs,
              },
            ]
          : []),
        ...(o.feedbackKnown
          ? [
              {
                id: "disliked",
                label: "Disliked",
                unit: "disliked",
                hint: "More negative feedback than positive, most read first. Open one to fix it.",
                assets: mostReadFirst(f.disliked),
                note: (i: number) =>
                  `${o!.negative[i]} down, ${o!.positive[i]} up${readsOf(i) ? ` · ${readsOf(i)}` : ""}`,
              },
            ]
          : []),
        {
          id: "outdatedUnread",
          label: "Outdated, unread",
          unit: "outdated, unread",
          hint: "Nobody is given these. Retire them when convenient.",
          assets: f.outdated.filter((i) => !o!.shows[i]),
          note: outdatedNote,
        },
      ];
    }
    const across = [...f.duplicatesInside, ...f.duplicatesOutside].filter((d) => o!.bundle[d.a] !== o!.bundle[d.b]);
    return [
      ...FAMILIES.map((family, k) => ({
        id: `type:${k}`,
        label: family.label,
        unit: family.label.toLowerCase(),
        hint: "Most read first.",
        assets: mostReadFirst(pool.filter((i) => o!.family[i] === k)),
        note: readsOf,
      })).filter((x) => x.assets.length),
      {
        id: "unlinked",
        label: "Not linked to anything",
        unit: "unlinked",
        hint: "Most read first. Open one to link it to what it belongs with.",
        assets: mostReadFirst(pool.filter((i) => !o!.degree[i])),
        note: readsOf,
      },
      ...(o.bundles.length > 1 && o.duplicatesKnown
        ? [
            {
              id: "repeated",
              label: "Repeated across bundles",
              unit: "repeated in another bundle",
              hint: "Nearly the same content in two bundles. Compare and keep one.",
              assets: ofPairs(across),
              note: () => "",
              pairs: across,
            },
          ]
        : []),
    ];
  }
  /** The filters as the buttons show them: over the group chosen, or the bundle. */
  const findings = $derived(findingsOf(members));
  /** The filter chosen in each view ("" for none). Use and Problems open on their first filter that finds anything:
   * the work their question is asked for. Contents opens with none: the whole library, by group. */
  let chosenFinding = $state<Partial<Record<View, string>>>(remembered.chosenFinding);
  const finding = $derived(
    findings.find(
      (f) => f.id === (chosenFinding[view] ?? (view === "contents" ? "" : findings.find((x) => x.assets.length)?.id)),
    ) ?? null,
  );
  /** How many of what the filter finds each group holds, over the whole bundle: where to start. */
  const perGroup = $derived.by(() => {
    const found = new Set(finding ? (findingsOf(scope).find((f) => f.id === finding.id)?.assets ?? []) : []);
    return new Map(groups.map((g) => [g.key, g.members.filter((i) => found.has(i)).length]));
  });
  /** What a group's name says on the map after its size: how many of what the filter finds are in it. */
  const groupNote = (g: { key: string }) =>
    finding ? `${(perGroup.get(g.key) ?? 0).toLocaleString()} ${finding.unit}` : "";
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
  /** What is drawn in full: the pick and what it is joined to; or what the filter finds, among what is typed and
   * the group chosen; the rest fades and stays in place. */
  const lit = $derived(
    picked >= 0
      ? new Set([picked, ...(reached?.levels.flatMap((l) => l.nodes) ?? [])])
      : finding
        ? new Set(finding.assets)
        : part?.group
          ? new Set(members)
          : matching,
  );
  const lines = $derived.by(() => {
    if (!o) return [];
    if (picked >= 0)
      return (reached?.links ?? [])
        .filter((l) => drawn(l.a) && drawn(l.b))
        .map((l) => ({ from: l.a, to: l.b, weight: 1, level: l.level }));
    // A chosen group's joins to other groups are drawn where the panel lists them: not in Use.
    if (!part?.group || view === "use") return [];
    const strongest = Math.max(1, ...joined.map((r) => r.links + r.duplicates));
    return joined
      .slice(0, 12)
      .filter((r) => groups.some((g) => g.key === r.key))
      .map((r) => ({ from: selected, to: r.key, weight: (r.links + r.duplicates) / strongest }));
  });
  /** What a point's size stands for: links in Contents, so a large point is a hub, and reads in Use and Problems, so
   * a large point is one agents are given often. Only what the filter finds is drawn to size. */
  const size = $derived.by(() => {
    if (!o || (view !== "contents" && !o.useKnown)) return null;
    const values = view === "contents" ? o.degree : o.shows;
    return {
      label: view === "contents" ? "links" : "reads",
      values,
      largest: Math.max(0, ...bundleScope.map((i) => values[i]!)),
    };
  });
  /** What an asset's colour, depth and size stand for, in akm's recorded figures: said after its name on the map. */
  const ago = (iso: string) => {
    const days = Math.floor((o!.at - Date.parse(iso)) / DAY);
    return days < 1 ? "today" : `${plural(days, "day")} ago`;
  };
  /** The usage window in words: "the last 90 days". */
  const windowText = $derived(
    o?.useSince ? `the last ${Math.round((o.at - Date.parse(o.useSince)) / DAY)} days` : "the usage window",
  );
  const reads = (i: number) =>
    !o!.useKnown
      ? "reads unknown"
      : o!.shows[i]
        ? `read ${plural(o!.shows[i]!, "time")}${o!.lastShown[i] ? `, last ${ago(o!.lastShown[i]!)}` : ""}`
        : `not read in ${windowText}`;
  /** How long since an asset's file was changed, in words: "untouched 19 months". */
  const untouched = (i: number) => {
    if (!o!.modified[i]) return "";
    const days = Math.floor((o!.at - Date.parse(o!.modified[i]!)) / DAY);
    return `untouched ${days < 60 ? plural(days, "day") : days < 730 ? plural(Math.floor(days / 30), "month") : plural(Math.floor(days / 365), "year")}`;
  };
  const problem = (i: number) => PROBLEMS.find((p) => p.id === firstProblem(o!, i))?.label.toLowerCase();
  /** Why an outdated asset is outdated, and how much it is still read. */
  const outdatedNote = (i: number) =>
    [[...new Set(o!.outdatedWhy[i]!.map((x) => x.why))].join(", "), o!.shows[i] ? plural(o!.shows[i]!, "read") : ""]
      .filter(Boolean)
      .join(" · ");
  /** The near-duplicate pairs an asset is in. */
  const pairsOf = (i: number) => o!.duplicates.filter((d) => d.a === i || d.b === i);
  function describe(i: number): string {
    const colour =
      view === "use"
        ? reads(i)
        : view === "problems"
          ? (problem(i) ?? "no problem recorded")
          : (parts.get(`g:${o!.group[i]}`)?.name ?? "");
    const bySize = view === "contents" ? plural(o!.degree[i]!, "link") : reads(i);
    return [...new Set([colour, bySize])].filter(Boolean).join(" · ");
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

{#snippet assetList(list: number[], note: (i: number) => string = () => "", limit = 8, id = "")}
  {@const shown = whole[id] ? list.length : limit}
  <ul class="read">
    {#each list.slice(0, shown) as i}<li class="read-row">
        <a href={open(o!.ref[i]!)} title={o!.ref[i]}>{short(o!.ref[i]!)}</a>{#if note(i)}<span class="count"
            >{note(i)}</span
          >{/if}
      </li>{/each}
  </ul>
  {#if list.length > limit}{#if id}<button class="link more" onclick={() => (whole = { ...whole, [id]: !whole[id] })}
        >{whole[id] ? "Show fewer" : `Show all ${list.length.toLocaleString()}`}</button
      >{:else}<p class="more">and {(list.length - limit).toLocaleString()} more</p>{/if}{/if}
{/snippet}

{#snippet stat(n: number | string, text: string, token = "")}
  <li>
    <span class="swatch" style={token ? `background:var(${token})` : ""}></span><strong
      >{typeof n === "number" ? n.toLocaleString() : n}</strong
    ><span>{text}</span>
  </li>
{/snippet}

{#snippet pairList(list: Pair[], limit = 8)}
  <ul class="pairs">
    {#each list.slice(0, limit) as d}<li>
        <a href={open(o!.ref[d.a]!)} title={o!.ref[d.a]}>{short(o!.ref[d.a]!)}</a>
        <span class="pair-foot"
          ><a href={open(o!.ref[d.b]!)} title={o!.ref[d.b]}>{short(o!.ref[d.b]!)}</a><span class="muted"
            >{Math.round(d.cosine * 100)}% alike</span
          ><a href={compare(o!.ref[d.a]!, o!.ref[d.b]!)}>Compare</a></span
        >
      </li>{/each}
  </ul>
  {#if list.length > limit}<p class="more">and {(list.length - limit).toLocaleString()} more</p>{/if}
{/snippet}

<svelte:window onkeydown={onKey} />
<div class="map-head">
  <nav class="library-views" aria-label="Library views" data-sveltekit-reset="false">
    <a href="/library/search">Search</a>
    <a href={filesLink}>Files</a>
    <a href="/library/map" aria-current="page">Map</a>
  </nav>
  <h1 class="sr-only">Library map</h1>
  <div class="views" role="tablist" aria-label="Question">
    {#each VIEWS as v}<button
        role="tab"
        aria-selected={view === v.id}
        class="btn-quiet"
        title={v.question}
        onclick={() => (view = v.id)}>{v.label}</button
      >{/each}
  </div>
  {#if o && o.bundles.length > 1}<label class="bundle-pick"
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
<div class="map-page">
  {#if error}<div class="notice notice-warn" role="alert">
      {error}<button class="btn-secondary" onclick={load}>Retry</button>
    </div>{/if}
  {#if notice}<p class="notice" role="status">{notice}</p>{/if}
  {#if o === null && !error && !notice}<p class="muted" role="status">Reading the library…</p>{/if}
  {#if o && facts}
    {#if points}<p class="sr-only" role="status">
        {picked >= 0 && levelFigures
          ? `Selected ${o.ref[picked]}. ${levelFigures.map((l, k) => `${LEVEL_STYLES[k]!.label}: ${plural(l.shown.length, "asset")}`).join(". ")}.`
          : ""}
      </p>{/if}
    <div class="map-body">
      <div class="map-stage">
        <div class="stage-tools">
          <div class="views" role="group" aria-label="Drawing">
            {#each DRAWINGS as [id, name, title]}<button
                class="btn-quiet"
                aria-pressed={drawing === id}
                {title}
                onclick={() => (chosenDrawing = id)}>{name}</button
              >{/each}
          </div>
          <label class="map-filter"
            ><span class="sr-only">Filter</span><input
              type="search"
              bind:value={filter}
              placeholder="Find by name or tag"
              autocomplete="off"
            /></label
          >
          {#if matching}<span class="muted small" role="status"
              >{matching.size.toLocaleString()} of {plural(bundleScope.length, "asset")}</span
            >{/if}
          <div class="findings" role="group" aria-label="Show on the map">
            {#if part}<button
                class="finding scope"
                title="The filters count this group only. Choose to go back to the whole bundle."
                onclick={() => choose(selected)}>In {part.name} ✕</button
              >{/if}
            {#each findings as f (f.id)}<button
                class="finding"
                aria-pressed={finding?.id === f.id}
                disabled={!f.assets.length}
                title={f.hint}
                onclick={() => (chosenFinding = { ...chosenFinding, [view]: finding?.id === f.id ? "" : f.id })}
                >{f.label}<strong>{(f.pairs ?? f.assets).length.toLocaleString()}</strong></button
              >{/each}
          </div>
        </div>
        {#if points}{#if groups.length}<SimilarityMap
              {o}
              {place}
              {flat}
              {size}
              {describe}
              {groupNote}
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
              label={`${question} The ${plural(bundleScope.length - offMap, "asset")} of ${scopeName} that have a group by meaning, as points, in ${plural(groups.length, "group")} named by their tags, groups alike in meaning near each other.${offMap ? ` ${plural(offMap, "asset")} not shown.` : ""}`}
            >
              {#snippet legend()}
                {#if view !== "contents"}<ul class="colour-key">
                    {#if view === "use"}{#each USE_CLASSES as u}<li>
                          <span class="swatch" style={`background:var(${u.token})`}></span>{u.label}
                        </li>{/each}
                    {:else}{#each PROBLEMS as p}<li>
                          <span class="swatch" style={`background:var(${p.token})`}></span>{p.label}
                        </li>{/each}
                      <li><span class="swatch" style="background:var(--border)"></span>No problem recorded</li>{/if}
                  </ul>{/if}
                {#if picked >= 0 && levelFigures?.some((l) => l.shown.length)}<div class="levels">
                    <p class="small">
                      <strong>{short(o!.ref[picked]!)}</strong> and what it is joined to, up to three steps out.
                    </p>
                    <ul>
                      {#each LEVEL_STYLES as style, k}
                        {@const f = levelFigures[k]!}
                        {#if f.shown.length || f.off || f.cut}
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
                          </li>{/if}
                      {/each}
                    </ul>
                  </div>{/if}{/snippet}
            </SimilarityMap>
            {#if offMap}<p class="muted small map-note" role="status">
                {plural(offMap, "asset")}
                {offMap === 1 ? "has" : "have"} no group by meaning, so {offMap === 1 ? "is" : "are"} not shown (not embedded,
                or added since the last index build).
              </p>{/if}{:else}<p class="notice">
              No stored embeddings, so assets cannot be placed by meaning. Build the index with embeddings, or use Tags.
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
          />
          {#if view !== "contents"}<ul class="colour-key">
              {#if view === "use"}{#each USE_CLASSES as u}<li>
                    <span class="swatch" style={`background:var(${u.token})`}></span>{u.label}
                  </li>{/each}
              {:else}{#each PROBLEMS as p}<li>
                    <span class="swatch" style={`background:var(${p.token})`}></span>{p.label}
                  </li>{/each}
                <li><span class="swatch" style="background:var(--use-0)"></span>No problem recorded</li>{/if}
            </ul>{/if}{/if}
      </div>

      <aside class="map-side" aria-label="Figures" aria-live="polite" bind:this={side}>
        {#if picked >= 0}
          {@const i = picked}
          <header class="side-head">
            <div>
              <h2>{short(o.ref[i]!)}</h2>
              <p class="muted small">{o.types[o.type[i]!]} · {o.bundles[o.bundle[i]!]}</p>
            </div>
            <button class="btn-quiet" onclick={() => (picked = -1)} aria-label="Close">✕</button>
          </header>
          <section>
            <div class="actions">
              <a class="btn btn-secondary" href={open(o.ref[i]!)}>Open</a>
              <button
                class="btn-secondary"
                aria-expanded={near?.ref === o.ref[i]}
                onclick={() => similar(o!.ref[i]!)}
                title="The assets closest to this one in meaning, with their measured similarity">Most similar</button
              >
            </div>
            {#if o.problems[i]!.length}<ul class="wrong">
                {#if o.problems[i]!.includes("outdated")}<li>
                    <strong>Outdated:</strong>
                    {#each o.outdatedWhy[i]! as x, n}{n ? ", " : ""}{x.why}{#if x.by >= 0}{" by "}<a
                          href={open(o.ref[x.by]!)}
                          title={o.ref[x.by]}>{short(o.ref[x.by]!)}</a
                        >{/if}{/each}. Open it to retire it or fix the link.
                  </li>{/if}
                {#if o.problems[i]!.includes("negative")}<li>
                    <strong>Disliked:</strong>
                    {o.negative[i]} down, {o.positive[i]} up. Open it to fix what readers found wrong.
                  </li>{/if}
                {#each pairsOf(i) as d}{@const other = d.a === i ? d.b : d.a}
                  <li>
                    <strong>Nearly the same as</strong>
                    <button class="link" onclick={() => pick(other)} title={o.ref[other]}>{short(o.ref[other]!)}</button
                    >
                    ({Math.round(d.cosine * 100)}% alike).
                    <a href={compare(o.ref[i]!, o.ref[other]!)}>Compare</a> and keep one.
                  </li>{/each}
              </ul>{/if}
            <dl class="figures">
              <dt>Reads</dt>
              <dd>{reads(i)}</dd>
              <dt>Last edited</dt>
              <dd>
                {o.modified[i]
                  ? `${untouched(i).replace("untouched ", "")} ago (${new Date(o.modified[i]!).toLocaleDateString()})`
                  : "unknown"}
              </dd>
              {#if o.feedbackKnown && (o.positive[i] || o.negative[i])}<dt>Feedback</dt>
                <dd>{o.negative[i]} down, {o.positive[i]} up</dd>{/if}
            </dl>
            {#if near?.ref === o.ref[i]}<div class="near">
                {#if near.error}<p class="muted small">{near.error}</p>
                {:else if !near.matches}<p class="muted small">Finding the closest content…</p>
                {:else if !near.matches.length}<p class="muted small">No embedded content to compare.</p>
                {:else}<ul>
                    {#each near.matches as m}<li>
                        <a href={open(m.ref)} title={m.ref}>{short(m.ref)}</a><span class="muted small"
                          >{Math.round(m.cosine * 100)}% alike</span
                        ><a class="small" href={compare(o.ref[i]!, m.ref)}>Compare</a>
                      </li>{/each}
                  </ul>{/if}
              </div>{/if}
          </section>
          {#if pickedJoins.length}<section>
              <h3>Joined to</h3>
              <ul class="rows">
                {#each pickedJoins.slice(0, 12) as j}<li>
                    <button class="link" onclick={() => pick(j.i)} title={o.ref[j.i]}>{short(o.ref[j.i]!)}</button><span
                      class="count">{j.what}</span
                    >
                  </li>{/each}
              </ul>
            </section>{/if}
        {:else}
          {#if part}<header class="side-head">
              <div>
                <h2>{part.name}</h2>
                <p class="muted small">
                  {part.group ? "Group by meaning" : part.type ? `Tag in ${part.type}` : "Asset type"} ·
                  {plural(facts.count, "asset")}
                </p>
              </div>
              <button class="btn-quiet" onclick={() => choose(selected)} aria-label="Close">✕</button>
            </header>{/if}
          {#if finding}<section>
              <h3>
                {finding.label}<span class="count">{(finding.pairs ?? finding.assets).length.toLocaleString()}</span>
              </h3>
              <p class="muted small">{finding.hint}</p>
              {#if finding.pairs}{@render pairList(finding.pairs, 8)}{:else}{@render assetList(
                  finding.assets,
                  finding.note,
                  8,
                  `${view}:${finding.id}`,
                )}{/if}
            </section>
          {:else if part}<section>
              <h3>Its assets{size ? `, most ${size.label} first` : ""}</h3>
              {@render assetList(
                [...members].sort((a, b) => (size ? size.values[b]! - size.values[a]! : 0) || a - b),
                (i) =>
                  view === "contents" ? plural(o!.degree[i]!, "link") : o!.useKnown ? plural(o!.shows[i]!, "read") : "",
                14,
                "members",
              )}
            </section>{/if}
          {#if view === "use" && !o.useKnown}<section><p class="muted small">{o.note}</p></section>{/if}
          {#if view === "problems" && (!o.feedbackKnown || !o.duplicatesKnown)}<section>
              <p class="muted small">
                {o.feedbackKnown ? "" : "Disliked assets cannot be shown. "}{o.duplicatesKnown
                  ? ""
                  : "Near-identical pairs cannot be shown. "}{o.note}
              </p>
            </section>{/if}
          {#if selected && joined.length}<section>
              <h3>Linked to these {selected.startsWith("g:") ? "groups" : "types and tags"}</h3>
              <ul class="rows">
                {#each joined.slice(0, 8) as r}<li>
                    <button class="link" onclick={() => choose(r.key)}>{nameOf(r.key)}</button>
                    <span class="count"
                      >{r.links ? plural(r.links, "link") : ""}{r.links && r.duplicates ? " · " : ""}{r.duplicates
                        ? plural(r.duplicates, "near-identical pair")
                        : ""}</span
                    >
                  </li>{/each}
              </ul>
            </section>{/if}
          {#if points && !part && groups.length}<section>
              <h3>{finding ? "Where they are, by group" : "Groups by meaning"}</h3>
              <ul class="rows">
                {#each [...groups]
                  .filter((g) => !finding || perGroup.get(g.key))
                  .sort((a, b) => (finding ? perGroup.get(b.key)! - perGroup.get(a.key)! : 0)) as g (g.key)}<li>
                    <button class="link" onclick={() => choose(g.key)}>{g.label}</button><span class="count"
                      >{finding
                        ? `${perGroup.get(g.key)!.toLocaleString()} of ${g.members.length.toLocaleString()}`
                        : plural(g.members.length, "asset")}</span
                    >
                  </li>{/each}
              </ul>
            </section>{/if}
        {/if}
      </aside>
    </div>
  {/if}
</div>

<style>
  /* One row: where in the Library this is, which question the map answers, and whose assets. */
  .map-head {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 24px;
    align-items: center;
    padding: 0 12px;
    border-bottom: 1px solid var(--border);
  }
  .library-views {
    display: flex;
    gap: 24px;
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
    padding: 8px 12px;
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
  .map-filter input {
    inline-size: 12rem;
  }
  .map-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 21rem;
    gap: 8px;
    align-items: start;
  }
  .map-stage {
    position: relative;
    border: 1px solid var(--border);
    background: var(--surface);
    padding: 0;
    min-inline-size: 0;
    /* The map takes all the window has left under the app's header and the row above. */
    --stage-size: max(360px, calc(100vh - 152px));
  }
  /* The drawing and the finder sit on the map; over the tags, which have no spare corner, they sit above it. */
  .stage-tools {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin-block-end: 8px;
  }
  .map-stage:has(:global(.stage-3d)) .stage-tools {
    position: absolute;
    inset-block-start: 8px;
    inset-inline-start: 8px;
    z-index: 3;
    margin: 0;
    padding: 2px;
    background: color-mix(in srgb, var(--surface) 94%, transparent);
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  /* The view's filters: what its question is asked to find, each with how many it finds. One is on at a time. */
  .findings {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .finding {
    display: flex;
    gap: 6px;
    align-items: baseline;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: 14px;
    cursor: pointer;
  }
  .finding strong {
    font-variant-numeric: tabular-nums;
  }
  .finding[aria-pressed="true"] {
    color: var(--bg);
    background: var(--text);
    border-color: var(--text);
  }
  .finding:disabled {
    color: var(--muted);
    border-color: var(--border);
    cursor: default;
  }
  .finding.scope {
    border-style: dashed;
  }
  .colour-key {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 12px;
    margin: 0;
    padding: 4px 10px;
    list-style: none;
    font-size: var(--text-xs);
  }
  .colour-key li {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .map-note {
    margin: 0;
    padding: 4px 8px;
  }
  .stage-tools :global(button) {
    min-block-size: 28px;
    padding: 2px 10px;
    font-size: 13px;
  }
  .stage-tools input {
    block-size: 28px;
    font-size: 13px;
  }
  /* What the view found, one fact a line; a line with a colour is also the key to that colour on the map. */
  .swatch {
    flex: none;
    inline-size: 10px;
    block-size: 10px;
    border-radius: 2px;
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-block-end: 12px;
  }
  .map-side section > h3 {
    display: flex;
    gap: 8px;
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
    padding: 8px 12px;
    border-top: 1px solid var(--border);
  }
  .map-side section > h3 {
    margin: 0 0 4px;
  }
  .map-side p {
    margin: 0 0 4px;
  }
  .side-head {
    display: flex;
    gap: 8px;
    align-items: start;
    padding: 8px 12px;
  }
  .side-head div {
    flex: 1;
    min-inline-size: 0;
  }
  .side-head h2 {
    font-size: 15px;
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
  .count {
    flex: none;
    white-space: nowrap;
    margin-inline-start: auto;
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .rows li {
    display: flex;
    gap: 8px;
    align-items: baseline;
    font-size: 13px;
    padding: 2px 0;
    min-inline-size: 0;
  }
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
    gap: 8px;
    align-items: baseline;
    font-size: 12px;
  }
  .pair-foot a:first-child {
    flex: 1;
    font-size: 13px;
  }
  .more {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--muted);
  }
  .read li {
    padding: 2px 0;
  }
  /* A name and its figure on one line; a figure too long for that goes under the name. */
  .read-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0 8px;
    align-items: baseline;
    font-size: 13px;
    min-inline-size: 0;
  }
  /* A name has its line to itself and its figure the next, so every row reads the same way. */
  .read-row a {
    flex: 1 0 100%;
  }
  .read-row .count {
    flex: 0 1 auto;
    min-inline-size: 0;
    margin-inline-start: 0;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .actions a {
    display: inline-flex;
    align-items: center;
    text-decoration: none;
  }
  /* What is wrong with the chosen asset, each with what to do about it. */
  .wrong {
    display: grid;
    gap: 6px;
    margin: 0 0 12px;
    padding: 8px 10px;
    list-style: none;
    font-size: 13px;
    background: var(--warn-bg);
    border-radius: 6px;
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
  /* Beside the map the figures scroll on their own, so the map stays in view while they are read. */
  @media (min-width: 1401px) {
    .map-side {
      max-block-size: calc(max(360px, 100vh - 152px) + 2px);
      overflow-y: auto;
    }
  }
  @media (max-width: 1400px) {
    .map-body {
      grid-template-columns: 1fr;
    }
  }
</style>
