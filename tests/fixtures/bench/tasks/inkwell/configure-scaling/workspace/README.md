# Task: configure autoscaling

Edit `service.yaml` to configure autoscaling on the inkwell service.

Requirements:
- `min: 2`
- `max: 20`
- `metric: rps`
- `target: 100`

Use `akm show skill:inkwell` for the exact field names and value format.
