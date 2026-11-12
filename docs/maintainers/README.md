# Maintainer Docs

This is maintainer/contributor documentation, not user-facing. It covers how
to work on `akm` itself: running it from source, releasing it, and measuring
whether changes actually improve it.

- [Local Development](local-development.md) — the explicit launcher for each
  kind of contributor check (live source, built launcher, packed-package
  acceptance, global checkout install) and the verification commands to run
  before pushing.
- [Release Checklist](release-checklist.md) — the branch model and the steps to
  cut, release and install akm and its plugins.
- [Implementation details](implementation-details.md) — repository tooling and
  runtime/test signals kept outside the public stability statuses.
- [akm-eval](https://github.com/itlackey/akm-eval) — the evals and benchmarks
  that measure whether `akm improve` and retrieval changes are actually
  working.
