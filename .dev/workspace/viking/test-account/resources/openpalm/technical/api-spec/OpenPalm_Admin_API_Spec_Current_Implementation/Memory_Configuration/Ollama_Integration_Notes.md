### Ollama Integration Notes

When using Ollama as the LLM or embedding provider with Memory:

1. **Config key**: The Ollama provider expects `ollama_base_url` (not `base_url`)
   in the mem0 config. The admin UI handles this automatically.

2. **Docker networking**: On Linux hosts, containers need
   `extra_hosts: ["host.docker.internal:host-gateway"]` in docker-compose.yml
   to reach `http://host.docker.internal:11434`. Docker Desktop (Mac/Windows)
   adds this automatically.

3. **Embedding dimensions**: The Qdrant collection must be created with
   `embedding_model_dims` matching the embedding model's output dimensions
   (e.g., 1024 for `qwen3-embedding:0.6b`, 768 for `nomic-embed-text`).
   A dimension mismatch causes silent insert failures.

4. **Model compatibility**: Models that use `<think>` tags (e.g., qwen3:4b)
   can break mem0's JSON fact extraction parser. Use models without thinking
   mode (e.g., `qwen2.5:14b`) for the LLM provider. Embedding models are
   unaffected.