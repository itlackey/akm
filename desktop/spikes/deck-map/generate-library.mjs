// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Writes a large synthetic library for the map spike: Markdown assets in several bundles, each about one topic, with
// `xrefs:` links that mostly stay inside a topic, sometimes cross to a related topic, and sometimes cite the real
// akm-eval corpus. The text is built from each topic's own vocabulary so stored embeddings cluster by topic.
//
//   node generate-library.mjs <out-dir> [count=20000] [seed=7] [eval-refs.json]
//
// <out-dir>/<bundle>/ is one bundle per directory; add each with `akm bundle add`. eval-refs.json is a JSON array of
// akm-eval refs (from a graph dump) that some assets cite.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [out, countArg = "20000", seedArg = "7", evalRefsPath] = process.argv.slice(2);
if (!out) throw new Error("usage: node generate-library.mjs <out-dir> [count] [seed] [eval-refs.json]");
const COUNT = Number(countArg);
let seed = Number(seedArg) >>> 0 || 7;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const evalRefs = evalRefsPath ? JSON.parse(readFileSync(evalRefsPath, "utf8")) : [];

// Six domains of five topics; a topic's words are what its assets talk about.
const DOMAINS = {
  infrastructure: {
    kubernetes: "pod deployment helm chart namespace ingress kubelet replica node autoscaler manifest cluster",
    terraform: "module state provider plan apply backend workspace drift resource variable output lock",
    networking: "dns subnet firewall vpn route gateway latency packet tls certificate proxy loadbalancer",
    observability: "metric trace span alert dashboard prometheus grafana log retention cardinality slo",
    storage: "volume snapshot backup replica bucket object disk iops encryption tier archive restore",
  },
  backend: {
    postgres: "index query vacuum migration schema transaction lock replica partition explain table",
    queues: "kafka consumer producer topic offset partition retry deadletter backpressure ordering broker",
    auth: "oauth token session jwt scope refresh login password mfa sso identity permission",
    caching: "redis ttl eviction invalidation key hit miss warmup stampede memcached shard",
    apis: "endpoint rest graphql pagination versioning ratelimit schema contract webhook client status",
  },
  frontend: {
    react: "component hook state props render effect context suspense memo reducer jsx",
    css: "layout grid flexbox selector cascade token theme spacing typography responsive animation",
    accessibility: "aria focus keyboard screenreader contrast label landmark alt motion semantic",
    performance: "bundle lazy hydration paint vitals cache prefetch compression image font",
    testing: "playwright fixture snapshot assertion mock locator flaky selector visual coverage",
  },
  data: {
    pipelines: "etl airflow dag batch schedule backfill lineage transform ingest warehouse job",
    analytics: "dashboard funnel cohort retention metric segment experiment conversion report kpi",
    ml: "model training feature embedding inference dataset label evaluation drift checkpoint gpu",
    governance: "pii retention consent audit catalog classification lineage access policy masking",
    search: "ranking relevance bm25 vector embedding recall precision query rerank index synonym",
  },
  process: {
    incidents: "outage pager postmortem severity rollback mitigation timeline oncall escalation customer",
    releases: "changelog version tag branch rollout canary freeze hotfix semver pipeline artifact",
    reviews: "pullrequest reviewer comment approval diff nit style lint ownership merge",
    planning: "roadmap estimate milestone sprint priority scope dependency risk backlog goal",
    onboarding: "setup laptop access account mentor documentation checklist welcome tooling credential",
  },
  agents: {
    prompts: "prompt instruction system context token example fewshot role temperature output",
    tools: "tool call schema argument result function mcp server permission sandbox",
    memory: "memory recall summary note fact lesson consolidation retrieval context forget",
    evals: "eval benchmark judge rubric score baseline regression dataset pass fail",
    workflows: "workflow step plan task subagent handoff checkpoint retry parallel orchestration",
  },
};
const FILLER =
  "the we this when after before because should must never always prefer check make sure team service user change note".split(
    " ",
  );
const topics = Object.entries(DOMAINS).flatMap(([domain, list]) =>
  Object.entries(list).map(([name, words]) => ({ domain, name, words: words.split(" ") })),
);
const BUNDLES = [
  { name: "team-memory", types: ["memories"], weight: 0.45 },
  { name: "eng-wiki", types: ["knowledge"], weight: 0.3 },
  { name: "ops-runbooks", types: ["knowledge", "commands"], weight: 0.15 },
  { name: "agent-kit", types: ["knowledge", "memories"], weight: 0.1 },
];

// Topics are uneven in size, like a real library.
const topicWeight = topics.map(() => 0.3 + rnd() ** 2 * 3);
const totalWeight = topicWeight.reduce((a, b) => a + b, 0);
const pickTopic = () => {
  let r = rnd() * totalWeight;
  for (let t = 0; t < topics.length; t++) {
    r -= topicWeight[t];
    if (r <= 0) return t;
  }
  return topics.length - 1;
};
const pickBundle = () => {
  let r = rnd();
  for (const b of BUNDLES) {
    r -= b.weight;
    if (r <= 0) return b;
  }
  return BUNDLES[0];
};

const assets = [];
const byTopic = topics.map(() => []);
for (let i = 0; i < COUNT; i++) {
  const t = pickTopic();
  const bundle = pickBundle();
  const type = pick(bundle.types);
  const topic = topics[t];
  const words = Array.from({ length: 3 }, () => pick(topic.words));
  const slug = `${topic.name}/${words.join("-")}-${i.toString(36)}`;
  const asset = {
    i,
    t,
    bundle: bundle.name,
    type,
    id: `${type}/${slug}`,
    title: `${topic.name}: ${words.join(" ")}`,
    links: [],
  };
  assets.push(asset);
  byTopic[t].push(asset);
}

// Links: preferential attachment inside the topic (a few hubs collect many), a related topic in the same domain
// sometimes, anywhere rarely. About a third of assets link nothing.
const degree = new Float64Array(COUNT).fill(1);
const pickWeighted = (pool) => {
  // Sample a few and keep the best connected: cheap preferential attachment.
  let best = pick(pool);
  for (let k = 0; k < 3; k++) {
    const c = pick(pool);
    if (degree[c.i] > degree[best.i]) best = c;
  }
  return best;
};
for (const a of assets) {
  const r = rnd();
  const n = r < 0.33 ? 0 : r < 0.75 ? 1 + Math.floor(rnd() * 2) : 2 + Math.floor(rnd() * 5);
  for (let k = 0; k < n; k++) {
    const roll = rnd();
    let target;
    if (roll < 0.75) target = pickWeighted(byTopic[a.t]);
    else if (roll < 0.93) {
      const same = topics.map((_, j) => j).filter((j) => topics[j].domain === topics[a.t].domain);
      target = pickWeighted(byTopic[pick(same)]);
    } else target = pick(assets);
    if (!target || target === a) continue;
    degree[target.i]++;
    a.links.push(target.bundle === a.bundle ? target.id : `${target.bundle}//${target.id}`);
  }
  if (evalRefs.length && rnd() < 0.03) a.links.push(pick(evalRefs));
}

const sentence = (topic) => {
  const n = 8 + Math.floor(rnd() * 8);
  const out = [];
  for (let k = 0; k < n; k++) out.push(rnd() < 0.6 ? pick(topic.words) : pick(FILLER));
  return `${out.join(" ")}.`;
};
for (const a of assets) {
  const topic = topics[a.t];
  const body = Array.from({ length: 4 + Math.floor(rnd() * 5) }, () => sentence(topic)).join(" ");
  const front = [`description: ${sentence(topic)}`, `tags: [${topic.domain}, ${topic.name}]`];
  if (a.links.length) front.push(`xrefs:\n${[...new Set(a.links)].map((l) => `  - ${l}`).join("\n")}`);
  const file = join(out, a.bundle, `${a.id}.md`);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `---\n${front.join("\n")}\n---\n\n# ${a.title}\n\n${body}\n`);
}
const links = assets.reduce((s, a) => s + a.links.length, 0);
console.log(
  `${COUNT} assets, ${links} xrefs, ${topics.length} topics, bundles: ${BUNDLES.map((b) => b.name).join(", ")}`,
);
