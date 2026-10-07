# Maintainer Docs

This is maintainer/contributor documentation, not user-facing. It covers how
to work on `akm` itself — running it from source, measuring whether changes
actually improve it, and the current state of the `curate` implementation.

- [Local Development](local-development.md) — the explicit launcher for each
  kind of contributor check (live source, built launcher, packed-package
  acceptance, global checkout install) and the verification commands to run
  before pushing.
- [Release Checklist](release-checklist.md) — local release validation, exact
  candidate-SHA semantic/Docker/native-scheduler gates, and the evidence links
  required before publication.
- [akm-eval](https://github.com/itlackey/akm-eval) — the evals and benchmarks
  that measure whether `akm improve` and retrieval changes are actually
  working. The old in-repo toolkit is retired: see [eval.md](eval.md).
- [Curate Workmap](curate-workmap.md) — the current `akm curate` contract,
  where its implementation diverges from intended behavior, and the
  highest-value next fixes.
