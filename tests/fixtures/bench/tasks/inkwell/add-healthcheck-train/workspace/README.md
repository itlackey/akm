# Task: add healthcheck

Edit `service.yaml` to add a healthcheck to the inkwell service.

Requirements:
- path: `/readyz`
- interval: 15 seconds
- threshold: 2 consecutive checks

Consult the inkwell skill for the correct YAML field names and value formats.
