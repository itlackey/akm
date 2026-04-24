## External service calls

The memory service makes outbound HTTP calls to two types of external providers. **The specific provider depends entirely on operator configuration:**

### LLM provider (fact extraction)

When a memory is added with `infer: true` (the default), the conversation text is sent to the configured LLM provider for fact extraction. The LLM also receives existing related memories to decide whether to add, update, or delete.

- **Ollama (local):** Calls `POST /api/chat` on the configured Ollama instance. If Ollama runs on the same host, this stays on the local network.
- **OpenAI-compatible (remote):** Calls `POST /chat/completions` on the configured base URL (e.g., `https://api.openai.com/v1`). The conversation text leaves your network.

### Embedding provider (vector generation)

Every time a fact is stored or a search query is executed, the text is sent to the configured embedding provider to generate a vector representation.

- **Ollama (local):** Calls `POST /api/embed` on the configured Ollama instance.
- **OpenAI-compatible (remote):** Calls `POST /embeddings` on the configured base URL.

**To keep all data on your local network**, configure both the LLM and embedding providers to use a local Ollama instance. When using remote providers (OpenAI, Anthropic, etc.), the fact text and search queries are sent to those external APIs.

### Assistant model (chat completions)

The assistant service (OpenCode) sends conversation messages to the configured chat model for inference. Which model is used depends entirely on operator configuration during setup:

- **Local provider (Ollama):** All inference stays on the local network. No data leaves the host.
- **Remote provider (OpenAI, Anthropic, Groq, etc.):** Conversation content is sent to that provider's API. Each provider has its own data retention and usage policies. Consult the provider's terms of service and privacy policy for details.

OpenPalm does not default to any specific model. The setup wizard requires the operator to choose a provider and model before the stack starts. This ensures the operator makes a conscious decision about where their data is processed.