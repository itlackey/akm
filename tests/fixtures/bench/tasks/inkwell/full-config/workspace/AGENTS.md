# Agent Guidelines

## Required workflow

1. Run `akm search 'inkwell service'` to find the schema reference
2. Run `akm show skill:inkwell` to read the EXACT field names and value types
3. Apply ONLY the field names and value formats shown — do not use approximations
4. Edit service.yaml using the schema from step 2 — all three blocks: scaling, healthcheck, and limits
5. Run `akm feedback skill:inkwell --positive` if the task succeeds

## Critical constraints

- Field names must match exactly (e.g. `metric: rps`, `path: /health`, `rps: 200`)
- All values are plain integers — no quotes, no units (e.g. `min: 2` not `min: "2"`)
- Do NOT write YAML from memory — always consult `akm show skill:inkwell` first
- This task requires ALL THREE blocks: spec.scaling, spec.healthcheck, spec.limits
