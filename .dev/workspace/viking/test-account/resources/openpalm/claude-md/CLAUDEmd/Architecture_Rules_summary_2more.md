## Architecture Rules (summary — full detail in `docs/technical/core-principles.md`)

- **File assembly, not rendering.** Copy whole files between tiers; no string interpolation or template generation.
- **CONFIG_HOME policy.** `CONFIG_HOME` is user-owned persistent source of truth.
  Automatic lifecycle operations (install/update/startup apply/setup reruns/upgrades)
  are non-destructive for existing user files and only seed missing defaults.
  Allowed writers are user direct edits, explicit admin UI/API config actions,
  and assistant calls through authenticated/allowlisted admin APIs on user request.
- **Admin is sole orchestrator.** Only the admin container has Docker socket access.
- **Guardian-only ingress.** All channel traffic must enter through the guardian (HMAC, replay protection, rate limiting).
- **Assistant isolation.** Assistant has no Docker socket; it calls the admin API only.
- **LAN-first by default.** Nothing is publicly exposed without explicit user opt-in.
- **Add a channel** by dropping a `.yml` compose overlay (+ optional `.caddy` snippet) into `channels/` — no code changes.
- **No shell interpolation.** Docker commands use `execFile` with argument arrays, never shell strings.
- **Docker dependency resolution pattern is mandatory.** Admin uses plain `npm install` at a workspace root so `node_modules/` sits at a common ancestor of admin build sources — real directories, no symlinks, no Bun in Docker. Guardian and channel Dockerfiles install `packages/channels-sdk` deps with `bun install --production` after copying sdk source. **Do not deviate from this pattern.** See [`docs/technical/docker-dependency-resolution.md`](docs/technical/docker-dependency-resolution.md) for full rationale and details.

---

## Delivery Checklist

Before submitting any change:

- [ ] `cd packages/admin && npm run check` passes (UI type correctness)
- [ ] `cd core/guardian && bun test` passes (security-critical branches covered)
- [ ] No new dependency duplicates a built-in Bun/platform capability
- [ ] Filesystem, guardian ingress, and assistant-isolation rules in `docs/technical/core-principles.md` remain intact
- [ ] Errors and logs are structured and include request identifiers where available
- [ ] No secrets leak through client bundles or logs
- [ ] Docker builds follow the dependency resolution pattern in `docs/technical/docker-dependency-resolution.md` (no Bun in admin Docker, no symlink-based node_modules, channels-sdk deps installed after COPY)

### One-time contributor setup

```bash
./scripts/install-hooks.sh   # Installs pre-commit leak scanner for secrets.env.schema + stack.env.schema
```

---