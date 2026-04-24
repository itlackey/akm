### 3) Built-in APIs to use first (before adding dependencies)

#### A) HTTP server and routing

* `Bun.serve(...)` for HTTP service entrypoints and request handling.
* Web standard `Request`, `Response`, `Headers`, `URL`, and `URLPattern` for transport concerns.
* Built-in upgrade flow in `Bun.serve` for WebSockets when needed.

Use these instead of adding Express/Fastify/Koa-style frameworks unless there is a demonstrated requirement.

#### B) HTTP client, JSON, and payload handling

* `fetch(...)` for outbound HTTP calls.
* `JSON.parse(...)` / `JSON.stringify(...)` for JSON serialization.
* `Request.json()`, `Request.text()`, and `Request.formData()` for request payload parsing.

Use these before adding axios/superagent/request-style client dependencies or extra JSON utility packages.

#### C) YAML and config parsing

* `Bun.YAML.parse(...)` and `Bun.YAML.stringify(...)` for YAML read/write operations.

Use this before adding separate YAML parser/stringifier dependencies when basic YAML support is sufficient.

#### D) Filesystem and streams

* `Bun.file(path)` for efficient file reads.
* `Bun.write(path, data)` for file writes.
* Web Streams APIs (`ReadableStream`, `WritableStream`, `TransformStream`) for stream transforms.

Use these before adding fs wrapper libraries for common read/write/streaming operations.

#### E) Globbing and path discovery

* `new Bun.Glob(pattern)` for file matching and directory traversal patterns.

Use this before adding globbing dependencies for straightforward file discovery.

#### F) Process and shell execution

* `Bun.spawn(...)` for subprocess control.
* `Bun.$\`...\`` for concise shell scripting in trusted/internal tooling.

Use these before adding execa/shelljs-like wrappers unless advanced behavior is required.

#### G) Cryptography and security primitives

* Web Crypto (`crypto.subtle`, `crypto.getRandomValues`, `crypto.randomUUID`).
* `Bun.password.hash(...)` / `Bun.password.verify(...)` for password hashing flows.

Use these before adding crypto helper packages for hashing, random IDs, or password verification.

#### H) SQLite and persistence utilities

* `bun:sqlite` (`Database`) for local SQLite-backed metadata/utility storage.

Use this before introducing ORM/query-builder dependencies for simple local persistence needs.

#### I) Testing and mocks

* `bun:test` (`test`, `describe`, `expect`, `mock`, lifecycle hooks) for unit/integration tests.

Use this before adding parallel test frameworks unless a missing feature is proven.