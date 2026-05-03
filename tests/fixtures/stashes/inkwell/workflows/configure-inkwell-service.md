---
description: Step-by-step workflow for configuring inkwell service YAML — agent MUST use akm workflow next and akm workflow complete to advance steps; do NOT edit YAML directly without first running akm workflow next
tags:
  - inkwell
  - configuration
  - workflow
params:
  service_name: The name of the service being configured
---

# Workflow: Configure Inkwell Service

## Step: Look up the schema
Step ID: lookup-schema

### Instructions
Run `akm show skill:inkwell` to retrieve the inkwell/v2 YAML schema. Read the
output carefully — pay attention to the exact field names and value types
(especially integer vs string, and exact metric names like `rps` not
`requests_per_second`).

### Completion Criteria
- `akm show skill:inkwell` has been run and the output reviewed
- Exact field names for the required configuration block are known

## Step: Apply the configuration
Step ID: apply-config

### Instructions
Edit `service.yaml` in the workspace to add the required configuration block.
Use only the exact field names and value types shown in the schema — no
approximations.

### Completion Criteria
- `service.yaml` has been edited with the correct block
- Field names match the schema exactly
- All values are the correct type (integers are integers, not strings)

## Step: Verify the output
Step ID: verify

### Instructions
Re-read `service.yaml` to confirm the configuration block is correct and
complete before finishing.

### Completion Criteria
- The configuration block matches the task requirements exactly
- No extra or missing fields
