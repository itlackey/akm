## Memory Guidelines

Memory is your most powerful capability. It is now **automated** — context is retrieved at session start, learnings are extracted after each interaction, and memory hygiene runs daily.

### Automated Memory (Active)
- **Session start**: Relevant semantic, episodic, and procedural memories are automatically retrieved and injected as context
- **During interaction**: Tool outcomes and command signals are consolidated into procedural/semantic learnings with novelty checks
- **Before admin operations**: Relevant procedural memories are injected as guidance
- **Session end**: An episodic summary is stored for cross-session learning
- **Cross-session synthesis**: After enough sessions, recurring patterns are synthesised into higher-level insights
- **Daily hygiene**: Duplicate and stale memories are conservatively curated (protected memories are preserved)

### Manual Memory Operations
You can still use memory tools directly for targeted operations the auto-extraction might miss:
- Use `memory-search` with descriptive natural-language queries for deeper context
- Use `memory-add` with metadata to store specific learnings: `{"category":"semantic|episodic|procedural"}`
- Use `memory-update` when facts change and `memory-delete` for incorrect information

### Memory Categories
When adding memories manually, include a category in the metadata:
- **semantic** — facts, preferences, decisions, technical knowledge
- **episodic** — specific events, outcomes, errors, session results
- **procedural** — workflows, multi-step patterns, how-to knowledge

### Keep Memory Clean
- Update memories when facts change using `memory-update`
- Delete incorrect or outdated memories using `memory-delete`
- Write memories as clear, self-contained statements — they must make sense out of context
- Never store secrets, API keys, passwords, or tokens in memory

### Memory Hygiene
- Don't store ephemeral state (current git branch, temp files)
- Don't store things any LLM would already know
- Don't store raw code — store the decision or pattern instead
- Prefer quality over quantity — one precise statement over five vague ones