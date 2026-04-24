## Configuration Flow Summary

```
Install                              Runtime
───────                              ───────
ensureXdgDirs()                      Container starts
  creates DATA_HOME/assistant/         │
  creates CONFIG_HOME/assistant/       ├── OPENCODE_CONFIG_DIR=/etc/opencode
  creates STATE_HOME/opencode/         │     reads opencode.jsonc (model + plugins)
  creates DATA_HOME/opencode/          │     reads AGENTS.md (persona)
                                       │
ensureOpenCodeSystemConfig()           ├── ~/.config/opencode/ (user extensions)
  writes DATA_HOME/assistant/          │     merges tools/, plugins/, skills/
    opencode.jsonc                     │
    AGENTS.md                          ├── auto-installs plugins via bun
                                       │     → ~/.cache/opencode/node_modules/
ensureOpenCodeConfig()                 │
  writes CONFIG_HOME/assistant/        ├── logs → ~/.local/state/opencode/
    opencode.json (schema ref)         │     (STATE_HOME/opencode on host)
    tools/ plugins/ skills/            │
                                       ├── data → ~/.local/share/opencode/
docker compose up                      │     (DATA_HOME/opencode on host)
                                       │
                                       └── opencode web --port 4096 --print-logs
```