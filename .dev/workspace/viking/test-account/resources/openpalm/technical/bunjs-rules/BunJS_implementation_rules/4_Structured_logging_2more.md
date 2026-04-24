### 4) Structured logging

All Bun services must use `createLogger` from `packages/channels-sdk/src/logger.ts`
for structured JSON output. Do not use bare `console.log` for operational events.

```typescript
import { createLogger } from "@openpalm/channels-sdk/logger";
const logger = createLogger("guardian"); // or "channel-chat", etc.

logger.info("Request accepted", { requestId, actor });
logger.warn("Replay detected", { requestId });
logger.error("Signature invalid", { requestId, reason });
```

Each log entry is a JSON object with fields: `ts`, `level`, `service`, `msg`,
and an optional `extra` bag for structured context. `error` and `warn` entries
go to `stderr`; `info` and `debug` go to `stdout`.

### 5) Bun service checklist

* `bun test` passes for changed Bun modules.
* Security-sensitive branches (auth, replay/rate checks, malformed input) are covered.
* No new dependency duplicates built-in Bun/platform capabilities listed above.
* All operational log events use `createLogger` (not bare `console.log`).
* Errors and logs are structured and include request identifiers where available.
* No behavior violates `docs/technical/core-principles.md` security and architecture constraints.