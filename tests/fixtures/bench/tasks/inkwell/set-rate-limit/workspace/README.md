# Task: configure rate limiting

Edit `service.yaml` to add a `limits` block to the inkwell service.

Requirements:
- `rps: 500` (steady-state max — use exactly `rps`, not `rate` or `maxRPS`)
- `burst: 1000` (burst capacity — use exactly `burst`, not `burstCapacity`)

Use `akm show skill:inkwell` for the complete field reference and a copy-paste example block.
