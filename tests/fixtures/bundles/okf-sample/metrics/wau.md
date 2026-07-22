---
type: Metric
title: Weekly Active Users
description: Distinct users active in a rolling 7-day window.
tags: [engagement, growth]
timestamp: 2026-05-26T18:15:00Z
---

# Definition

WAU counts distinct `customer_id`s with at least one row in [orders](/tables/orders.md)
during the trailing seven days.

# Notes

Deliberately excludes internal test accounts.
