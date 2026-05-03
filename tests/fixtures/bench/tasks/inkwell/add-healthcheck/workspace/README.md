# Task: add healthcheck

Edit `service.yaml` to add a healthcheck to the inkwell service.

Requirements:
- path: `/health`
- interval: `10` (plain integer seconds — no unit suffix)
- threshold: `3` (plain integer — no unit suffix)

Consult the inkwell skill for the correct YAML field names and value formats.
