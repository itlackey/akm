---
name: Data_Analysis
description: Summarize a CSV and produce basic charts. Use for quick tabular exploration.
---

# Data analysis

## Instructions

Load the CSV, describe the columns, and plot the two most-correlated numeric
columns.

<!--
HARD-RULE VIOLATION (fixture, intentional): the skill `name` is "Data_Analysis"
— it contains uppercase letters and an underscore, so it fails the Agent Skills
name charset rule ^[a-z0-9]+(-[a-z0-9]+)*$. The directory name matches the
frontmatter name (both "Data_Analysis"), so the name==dir rule holds; only the
charset rule is violated. This exercises the agent-skills lint golden.
-->
