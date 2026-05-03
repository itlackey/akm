# Task: configure CPU-based autoscaling

Edit `service.yaml` to configure CPU-based autoscaling.

Requirements:
- `min: 1` (minimum replicas)
- `max: 8` (maximum replicas)
- `metric: cpu` (scale on CPU utilization — use exactly `cpu`, not `cpu_utilization`)
- `target: 65` (integer, no percent sign — use exactly `65`, not `65%` or `"65%"`)

Use `akm show skill:inkwell` for the complete field reference and a copy-paste example block.
