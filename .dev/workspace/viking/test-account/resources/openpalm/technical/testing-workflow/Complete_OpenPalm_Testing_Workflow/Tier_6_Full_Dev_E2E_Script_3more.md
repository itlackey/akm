## Tier 6: Full Dev E2E Script

**Time:** 20-60min | **Prerequisites:** Docker, internet (for GGUF downloads on first run)

```bash
./scripts/dev-e2e-test.sh            # Full build + fresh environment
./scripts/dev-e2e-test.sh --skip-build  # Reuse existing admin image
```

This is the "nuclear option" — tests everything from a completely clean slate. It runs 30 verification steps:

1. Stops all containers, cleans `.dev/` state completely
2. Seeds fresh config via `dev-setup.sh --seed-env --force`
3. Downloads & packages GGUF models into Docker Model Runner
4. Builds admin image from source
5. Starts compose stack
6. Verifies fresh state (setup NOT complete)
7. Runs setup wizard via API (POST `/admin/setup`)
8. Waits for all 6 services to become healthy
9. Validates `secrets.env` values, container env vars, file ownership
10. Verifies OpenMemory user provisioned
11. Tests assistant memory tools end-to-end (add + search)
12. Reports pass/fail summary

---

## Quick Reference

| Speed | Command | Coverage |
|-------|---------|----------|
| Fastest (~30s) | `bun run check && bun run test && bun run admin:test:unit` | Types + all unit tests |
| Medium (~5min) | Above + `bun run admin:test` | + integration Playwright tests |
| Thorough (~1min extra) | Above + stack tests (Tier 4) | + live service integration |
| Full (~1min extra) | Above + LLM tests (Tier 5) | + real LLM inference |
| Mocked UI contracts (~2min) | `bun run admin:test:e2e:mocked` | Browser route-mocked wizard/UI contracts |
| No-skip integration E2E (~1min) | `bun run admin:test:e2e` | Full integration Playwright suite with no mocked browser routes |
| Nuclear (~60min) | `./scripts/dev-e2e-test.sh` | Everything from clean slate |

## Recommended Local Workflow

```bash
# 1. Quick validation (always run before committing)
bun run check && bun run test && bun run admin:test:unit

# 2. Full offline tests (run before pushing)
bun run admin:test    # includes build + unit + integration e2e

# Optional: mocked browser contract coverage
bun run admin:test:e2e:mocked

# 3. Integration validation (run for stack-touching changes)
bun run dev:build
bun run admin:test:e2e

# 4. Full pipeline validation (run for LLM/memory changes)
bun run admin:test:e2e

# Optional: one-command consolidated Tier 1-5 pass (halts on first failure)
bun run check && bun run test && bun run admin:test:unit && bun run admin:test:e2e

# 5. Clean-slate validation (run before releases)
./scripts/dev-e2e-test.sh
```