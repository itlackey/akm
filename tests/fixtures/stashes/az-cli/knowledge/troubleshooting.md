---
description: First-line triage for az CLI failures and Azure-side errors
---
# Troubleshooting az CLI

## Authentication failed

1. `az account show` — is anyone logged in at all?
2. `az account get-access-token` — does the token request itself succeed?
3. Check the active subscription matches the resource you're hitting.
4. Conditional access policies sometimes block CI sign-ins. Run with `--use-device-code` to confirm.

## "ResourceNotFound" but the resource exists

Almost always wrong subscription. `az account show -o table` and verify. The Portal silently roams subscriptions; the CLI does not.

## "AuthorizationFailed"

The principal lacks RBAC on the scope. Check with:

```sh
az role assignment list --assignee <id> --scope <scope> -o table
```

Ensure the role *and* the scope cover the operation. A reader on the resource group cannot mutate resources inside it.

## Slow or hanging command

```sh
az --debug <command>
```

`--debug` prints the underlying HTTP requests and timings. Most "slow" commands are paginated list calls — add `--max-items 100` to bound the result set.

## Stale CLI

`az upgrade` once a quarter. Many "command not found" or "unknown argument" errors trace back to a CLI that's a year behind.
