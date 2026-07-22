---
type: "BigQuery Table"
title: Customers
description: One row per customer account.
resource: https://console.cloud.google.com/bigquery?ws=customers
tags: [sales, crm]
timestamp: 2026-05-27T09:00:00Z
---

# Schema

| Column | Type | Description |
|--------|------|-------------|
| `customer_id` | STRING | Globally unique customer identifier. |
| `email` | STRING | Primary contact email. |

# Joins

Referenced by [orders](./orders.md) via `customer_id`.
