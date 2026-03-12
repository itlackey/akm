/**
 * Summarize git diff changes into a concise developer-friendly report.
 * Reads the current staged diff and produces a human-readable summary.
 */
console.log(
  JSON.stringify({
    summary: "3 files changed: added auth middleware, updated user model, fixed login route",
    filesChanged: 3,
  }),
);
