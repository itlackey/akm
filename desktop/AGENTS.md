# Working on AKM Desktop

- Keep business logic in AKM. Import only the published `akm-cli/workspace`
  surface in application code; never copy domain logic or deep-import `dist/`.
- Use the existing public API semantics. New moves, deletions, retirement,
  schema changes or proposal behavior require a separate scoped design.
- Keep the renderer sandboxed and the server private to the app. Test
  authentication, source conflicts and credential redaction after changes.
- Test only against generated synthetic HOME/XDG/AKM paths. Do not run manual
  writes, provider requests or bundle operations against a developer's real data.
- Preserve user files and unrelated work. Do not clean live bundles or config.
- Before handoff: `npm run check`, `npm run build`, `npm test`,
  `npm run test:e2e`, and native/package checks where supported. Review actual
  screenshots; passing DOM tests alone are not a visual review.
- Record platform and unverified behavior honestly. Do not publish releases,
  mirror to GitHub, or add deployment secrets without authorization.
