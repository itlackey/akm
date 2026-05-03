# Agent Guidelines

## Required workflow

1. Run `akm search 'inkwell service'` to find the schema reference
2. Run `akm show skill:inkwell` to read the EXACT field names and value types
3. Apply ONLY the field names and value formats shown — do not use approximations
4. Edit the workspace file using the schema from step 2
5. Run `akm feedback skill:inkwell --positive` if the task succeeds

## Critical constraints

- Field names must match the schema exactly (e.g. `metric: rps` not `metric: requests_per_second`)
- Integer values must be plain integers (e.g. `target: 100` not `target: "100"`)
- Do NOT write YAML from memory — always consult `akm show skill:inkwell` first

## IMPORTANT: schema vs. values

The skill shows field names and value types as a schema reference — its examples use placeholder values. Always use the SPECIFIC VALUES from this workspace's README.md. Do not copy values from the skill's examples verbatim.
