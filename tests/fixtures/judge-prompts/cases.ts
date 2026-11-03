/**
 * Inputs for the judge-prompt golden test (tests/judges/judge-prompts.test.ts), in the shape
 * `akm judge <name>` reads. `goldens.json` holds the messages the pipeline sent for each of
 * them before the judges moved behind the registry (#1306), captured from that code.
 */

const long = (unit: string, chars: number): string => unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);

export const REFLECT_NEGATIVE = {
  source: `---\nname: deploy\ndescription: Deploys the\n---\n\n# Deploy\n\nRun \`make deploy\` after the checks pass.\n\n${long("Step detail line.\n", 7000)}`,
  candidate: `---\nname: deploy\ndescription: Deploys the app after the checks pass.\n---\n\n# Deploy\n\nRun \`make deploy\` after the checks pass.\n\n${long("Step detail line.\n", 7000)}`,
  feedback: ["[negative] description is truncated", "[positive] steps were right"],
  ref: "skill:deploy",
};

export const REFLECT_MAINTENANCE = {
  source: "---\ndescription: Notes\n---\n\nBody.\n",
  candidate: "---\ndescription: Notes on the body.\n---\n\nBody.\n",
};

export const LESSON_NEW = {
  lesson: "# Lesson\n\nPin the runner version: an unpinned runner changed the cache key and doubled build time.",
  source: long("The build got slower after the runner image changed. ", 3400).trim(),
  feedback: ["[negative] too vague", "[negative] no cause given"],
  related: [
    { ref: "lesson:runner-cache", content: long("Cache keys include the runner image. ", 700) },
    { ref: "knowledge:ci-notes", content: "CI notes." },
  ],
};

export const LESSON_UPDATE = {
  lesson: "# Lesson\n\nPin the runner version.\n\nIt also changes the cache key.",
  source: "The runner image changed and the cache key changed with it.",
  feedback: ["[negative] missing the cache effect"],
  extending: "# Lesson\n\nPin the runner version.",
};

const note = (name: string, created: string, updated: string, content: string) => ({
  ref: `memory:${name}`,
  type: "memory",
  created,
  updated,
  content,
});

export const PAIR_DATED = {
  a: note(
    "old",
    "2026-01-01T00:00:00.000Z",
    "2026-01-02T00:00:00.000Z",
    "---\ndescription: Port notes\nupdated: 2026-01-02T00:00:00.000Z\n---\n\nThe service listens on port 8080.\n",
  ),
  b: note(
    "new",
    "2026-03-01T00:00:00.000Z",
    "2026-03-01T00:00:00.000Z",
    "---\ndescription: Service port\n---\n\nThe service listens on port 9000 since March.\n",
  ),
};

export const PAIR_TIED = {
  a: note("one", "2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z", "No frontmatter here, only a body.\n"),
  b: note(
    "two",
    "2026-02-01T00:00:00.000Z",
    "2026-02-01T00:00:00.000Z",
    "---\ndescription: Same facts\n---\n\nNo frontmatter here, only a body, reworded.\n",
  ),
};

export const JUDGMENT_PROMOTION = {
  proposal: {
    ref: "knowledge:runner-pinning",
    source: "consolidate",
    content: "---\ndescription: Pin the runner\n---\n\nPin the runner image: an unpinned image doubled build time.\n",
  },
  reason: "needs-judgment",
  siblings: [{ id: "p-2", source: "distill", content: "A ```` fenced\n```\nnote\n" }],
  neighbours: [{ ref: "knowledge:ci-notes", description: "CI notes", excerpt: "Excerpt with ``` inside" }],
};

export const JUDGMENT_UPDATE = {
  proposal: { ref: "lesson:runner", source: "distill", content: "---\ndescription: Runner\n---\n\nNew body.\n" },
  reason: "proactive-needs-review",
  liveAsset: "---\ndescription: Runner\n---\n\nOld body.\n",
  siblings: [],
};
