# Team Coding Standards

## TypeScript

- Use strict mode, ESM imports
- Prefer `const` over `let`; avoid `var`
- Use explicit return types on exported functions
- Keep functions under 30 lines where practical

## Testing

- Use `bun:test` for all tests
- Name test files `*.test.ts` next to source
- Each test should be independent — no shared mutable state

## Git

- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`
- One logical change per commit
- Run `bunx biome check` before committing
