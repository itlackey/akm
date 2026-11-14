// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Gives the synthetic library what a library in use has, for the configured HOME/XDG paths (a synthetic one only):
//   files  near-duplicate copies of some assets in another bundle, superseded and contradicted assets, and
//          modification times spread over two years;
//   events reads, search hits, feedback and searches that found nothing, uneven across topics: some topics are read
//          a lot, some only long ago, some never.
//
//   bun seed-signals.ts files <bundles-dir> <graph.json>     then `akm index`
//   bun seed-signals.ts events <graph.json>                  with a graph.json read after that index; replaces
//                                                            every usage event in that (synthetic) state.db
import fs from "node:fs";
import path from "node:path";
import { openStateDatabase } from "../../../src/core/state-db";

const [step, a, b] = process.argv.slice(2);
let seed = 11;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)]!;
const DAY = 86_400_000;

// Synthetic bundles only: the real akm-eval corpus is left as it is.
const SYNTHETIC = ["team-memory", "eng-wiki", "ops-runbooks", "agent-kit"];
const fileOf = (bundles: string, ref: string) => {
  const [bundle, concept] = ref.split("//");
  return path.join(bundles, bundle!, `${concept}.md`);
};

if (step === "files") {
  const bundles = a!;
  const g = JSON.parse(fs.readFileSync(b!, "utf8"));
  const refs: string[] = g.nodes.ref;
  const synthetic = refs.map((r, i) => [r, i] as const).filter(([r]) => SYNTHETIC.includes(r.split("//")[0]!));
  const byTopic = new Map<number, string[]>();
  for (const [r, i] of synthetic) byTopic.set(g.nodes.topic[i], [...(byTopic.get(g.nodes.topic[i]) ?? []), r]);

  // Near-duplicates: 150 assets copied into another bundle with one sentence changed, the way two teams write the
  // same note.
  let copies = 0;
  for (let n = 0; n < 150; n++) {
    const [ref] = pick(synthetic);
    const [bundle, concept] = ref.split("//");
    const into = pick(SYNTHETIC.filter((x) => x !== bundle));
    const target = path.join(bundles, into, `${concept}-copy.md`);
    if (fs.existsSync(target)) continue;
    const text = fs.readFileSync(fileOf(bundles, ref), "utf8").replace(/\nxrefs:[\s\S]*?(?=\n---)/, "");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text.replace(/\.\s*$/, ". we wrote this down again so it is not lost.\n"));
    copies++;
  }

  // Superseded and contradicted: in a few topics, older notes replaced by a newer one of the same topic.
  const edit = (ref: string, key: string, by: string, state: string) => {
    const file = fileOf(bundles, ref);
    const text = fs.readFileSync(file, "utf8");
    if (text.includes("beliefState:")) return false;
    fs.writeFileSync(file, text.replace(/^---\n/, `---\nbeliefState: ${state}\n${key}:\n  - ${by.split("//")[1]}\n`));
    return true;
  };
  let superseded = 0;
  let contradicted = 0;
  const topics = [...byTopic.keys()];
  for (const t of topics.slice(0, 6)) {
    const list = byTopic.get(t)!.filter((r) => fs.existsSync(fileOf(bundles, r)));
    for (let n = 0; n < 30; n++) {
      const old = pick(list);
      const by = pick(list.filter((r) => r.split("//")[0] === old.split("//")[0] && r !== old));
      if (by && edit(old, "supersededBy", by, "superseded")) superseded++;
    }
  }
  for (const t of topics.slice(10, 13)) {
    const list = byTopic.get(t)!;
    for (let n = 0; n < 12; n++) {
      const old = pick(list);
      const by = pick(list.filter((r) => r.split("//")[0] === old.split("//")[0] && r !== old));
      if (by && edit(old, "contradictedBy", by, "contradicted")) contradicted++;
    }
  }

  // Modification times: each topic has an age; its assets were last edited around then.
  const age = new Map(topics.map((t) => [t, random() < 0.25 ? 400 + random() * 300 : random() * 200]));
  for (const [r, i] of synthetic) {
    const file = fileOf(bundles, r);
    if (!fs.existsSync(file)) continue;
    const days = Math.max(0, age.get(g.nodes.topic[i])! + (random() - 0.5) * 120);
    const when = new Date(Date.now() - days * DAY);
    fs.utimesSync(file, when, when);
  }
  console.log({ copies, superseded, contradicted });
}

if (step === "events") {
  const g = JSON.parse(fs.readFileSync(a!, "utf8"));
  const refs: string[] = g.nodes.ref;
  const topicCount = g.topics.length;
  // Each topic gets a use profile: busy, steady, faded (read only early in the window), or never read.
  const profile = Array.from({ length: topicCount }, (_, t) =>
    t % 9 === 4 ? "never" : t % 7 === 3 ? "faded" : t % 5 === 0 ? "busy" : "steady",
  );
  const state = openStateDatabase();
  const insert = state.prepare(
    "INSERT INTO usage_events (event_type, query, entry_ref, signal, metadata, source, created_at) VALUES (?, ?, ?, ?, ?, 'user', ?)",
  );
  const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 19).replace("T", " ");
  const counts = { show: 0, search: 0, feedback: 0, miss: 0 };
  state.exec("BEGIN");
  // Seeding again replaces what the last run seeded.
  state.exec("DELETE FROM usage_events");
  try {
    for (let i = 0; i < refs.length; i++) {
      const p = profile[g.nodes.topic[i]] ?? "steady";
      if (p === "never") continue;
      // Within a topic, use is heavy-tailed: most assets are read rarely or never, a few a lot.
      const chance = p === "busy" ? 0.7 : p === "faded" ? 0.4 : 0.35;
      if (random() > chance) continue;
      const shows = Math.floor(1 / (random() ** 1.4 + 0.02) / (p === "busy" ? 1 : 3));
      for (let n = 0; n < shows; n++) {
        const daysAgo = p === "faded" ? 60 + random() * 29 : random() * 89;
        insert.run("show", null, refs[i], null, null, at(daysAgo));
        counts.show++;
        if (random() < 0.6) {
          // A search writes a summary row (no ref, with its result count) and one row per hit, as akm does.
          const query = g.topics[g.nodes.topic[i]]?.terms?.[0] ?? "notes";
          insert.run("search", query, null, null, JSON.stringify({ resultCount: 5 }), at(daysAgo));
          insert.run("search", query, refs[i], null, null, at(daysAgo));
          counts.search++;
        }
      }
      // Feedback: mostly positive; negative concentrated in two topics.
      if (shows > 2 && random() < 0.15) {
        const negative = g.nodes.topic[i] % 11 === 2 ? random() < 0.7 : random() < 0.08;
        insert.run("feedback", null, refs[i], negative ? "negative" : "positive", null, at(random() * 60));
        counts.feedback++;
      }
    }
    // Searches that found nothing: things people look for that the library does not have.
    const misses = [
      "kafka exactly once semantics",
      "gpu quota request",
      "soc2 evidence collection",
      "mobile push notifications",
      "ios release signing",
      "data residency eu",
      "cost allocation tags",
      "feature flag cleanup",
      "localization workflow",
      "vendor security review",
    ];
    for (const [k, q] of misses.entries())
      for (let n = 0; n < 12 - k; n++) {
        insert.run("search", q, null, null, JSON.stringify({ resultCount: 0 }), at(random() * 29));
        counts.miss++;
      }
    state.exec("COMMIT");
  } catch (error) {
    state.exec("ROLLBACK");
    throw error;
  } finally {
    state.close();
  }
  console.log(counts, profile);
}
