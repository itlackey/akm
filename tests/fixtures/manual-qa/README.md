# Manual QA Fixtures

These fixtures support manual testing of the CLI.

- `bundle/` supplements the fixed 18-entry ranking baseline with workflow,
  task, agent, command, `.meta`, and fragment-addressing cases.
- `dangerous-bundle/` and `suppressed-dangerous-bundle/` exercise source
  installation and dangerous environment-key policy without real secrets.
- `fake-agent.ts` is a deterministic executable for agent success, failure,
  timeout, signal, capture, and redaction checks.
- `fake-services.ts` exposes loopback OpenAI enrichment/proposal
  chat-completion, embedding, static-registry, and website fixtures. Loopback
  website tests cover provider protocol only; production SSRF policy must be
  tested against controlled public HTTPS infrastructure.
- `seed-proposals.ts` creates fixed proposal queue cases in an already-isolated
  configured bundle.

Never run the mutating fixtures against a real bundle; use an isolated sandbox.
