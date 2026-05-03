# Task: configure autoscaling

Edit `service.yaml` to configure autoscaling on the inkwell service.

Requirements:
- `min: 2` (minimum replicas)
- `max: 20` (maximum replicas)
- `metric: rps` (scale on requests per second — use exactly `rps`, not `requests_per_second`)
- `target: 100` (integer, no unit suffix — use exactly `100`, not `"100"` or `100rps`)

Use `akm show skill:inkwell` for the complete field reference and a copy-paste example block.
