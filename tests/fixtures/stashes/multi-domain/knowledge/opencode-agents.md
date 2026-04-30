---
description: Defining custom opencode agents
---
# opencode Agents

Custom agents live under `.opencode/agent/<name>.md` with frontmatter declaring `model`, `tools`, and a system prompt. Invoke with `opencode run --agent <name>`. Agents can override the default model and tool set per task.
