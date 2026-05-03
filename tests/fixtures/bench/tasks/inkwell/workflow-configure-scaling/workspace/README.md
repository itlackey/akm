# Task: configure autoscaling via workflow

Edit `service.yaml` to configure autoscaling on the inkwell service.

Requirements:
- `min: 2`
- `max: 20`
- `metric: rps`
- `target: 100`

Use `akm workflow next 'workflow:configure-inkwell-service'` to follow the step-by-step process.
