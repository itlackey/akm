---
description: Operate Azure resources from the command line using the az CLI
---
# az CLI

Skill for everyday Azure operations from a shell. Covers login and subscription selection, resource group lifecycle, identity, and the small handful of commands that recur across most workflows.

## Login

`az login` opens a device-code or browser flow. In CI use `az login --service-principal -u <appId> -p <secret> --tenant <tenant>` or, preferably, federated workload-identity. Always run `az account show` afterwards to verify the active subscription.

## Subscription discipline

Most account incidents trace back to running a command against the wrong subscription. `az account set --subscription <name-or-id>` before any mutating command, and prefer `--subscription` on the command itself in scripts.

## Resource groups

A resource group is the unit of cleanup. Create one per environment (`rg-app-prod`, `rg-app-dev`); when the environment is gone, `az group delete -n <name>` reclaims everything inside it.

## Output

`-o table` for humans, `-o json` for scripts, `--query "..."` to project fields with JMESPath. `-o tsv` is the right choice when piping a single value into another command.
