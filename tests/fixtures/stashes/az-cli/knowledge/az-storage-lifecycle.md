---
description: Azure storage lifecycle management policies via az CLI
tags: [az-cli, storage, lifecycle, management-policy]
---
# Azure Storage Lifecycle Management Policies

## Management policy create command

```sh
az storage account management-policy create \
  --account-name <storage-account-name> \
  --resource-group <resource-group-name> \
  --policy @lifecycle-policy.json
```

All three flags are required:

| Flag | Description |
|------|-------------|
| `--account-name` | Name of the storage account |
| `--resource-group` | Resource group that contains the storage account |
| `--policy` | Path to a JSON file (prefixed with `@`) containing the lifecycle policy definition |

To view the current policy on an account:

```sh
az storage account management-policy show \
  --account-name <storage-account-name> \
  --resource-group <resource-group-name>
```

To delete the policy:

```sh
az storage account management-policy delete \
  --account-name <storage-account-name> \
  --resource-group <resource-group-name>
```

## Lifecycle policy JSON schema

The policy file has a top-level `rules` array. Each rule has an `enabled` flag, a `name`, a `type` (always `"Lifecycle"`), and a `definition` object with `filters` and `actions`.

```json
{
  "rules": [
    {
      "enabled": true,
      "name": "<rule-name>",
      "type": "Lifecycle",
      "definition": {
        "filters": {
          "blobTypes": ["blockBlob"],
          "prefixMatch": ["container/prefix"]
        },
        "actions": {
          "baseBlob": {
            "tierToCool": {
              "daysAfterModificationGreaterThan": <days>
            },
            "tierToArchive": {
              "daysAfterModificationGreaterThan": <days>
            },
            "delete": {
              "daysAfterModificationGreaterThan": <days>
            }
          },
          "snapshot": {
            "delete": {
              "daysAfterCreationGreaterThan": <days>
            }
          }
        }
      }
    }
  ]
}
```

Key schema notes:

- `filters.blobTypes` — required; valid values are `"blockBlob"` and `"appendBlob"`. Page blobs are not supported.
- `filters.prefixMatch` — optional array of blob name prefixes (e.g. `"logs/"`, `"backups/2024"`). Omit to apply the rule to all blobs.
- `actions.baseBlob.tierToCool.daysAfterModificationGreaterThan` — integer number of days since the blob was last modified before moving to Cool tier.
- `actions.baseBlob.tierToArchive.daysAfterModificationGreaterThan` — integer number of days since last modification before moving to Archive tier.
- `actions.baseBlob.delete.daysAfterModificationGreaterThan` — integer number of days since last modification before deleting the blob.
- Days values must be integers >= 0. Tier thresholds must be monotonically increasing (Cool < Archive < Delete).

## Complete example policy

Save this as `lifecycle-policy.json` and pass it to the create command above.

```json
{
  "rules": [
    {
      "enabled": true,
      "name": "blob-tiering-policy",
      "type": "Lifecycle",
      "definition": {
        "filters": {
          "blobTypes": ["blockBlob"]
        },
        "actions": {
          "baseBlob": {
            "tierToCool": {
              "daysAfterModificationGreaterThan": 30
            },
            "tierToArchive": {
              "daysAfterModificationGreaterThan": 90
            },
            "delete": {
              "daysAfterModificationGreaterThan": 365
            }
          }
        }
      }
    }
  ]
}
```

This policy applies to all block blobs in the storage account:

- **Day 30+**: moves blobs to Cool tier (lower storage cost, higher access cost)
- **Day 90+**: moves blobs to Archive tier (lowest storage cost, requires rehydration to access)
- **Day 365+**: permanently deletes blobs

Full apply example:

```sh
az storage account management-policy create \
  --account-name stappprod \
  --resource-group rg-app-prod \
  --policy @lifecycle-policy.json
```
