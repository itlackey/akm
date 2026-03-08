import type { EmbeddingConnectionConfig } from "./config"

// ── Types ───────────────────────────────────────────────────────────────────

export type EmbeddingVector = number[]

// ── Singleton local embedder ────────────────────────────────────────────────

let localEmbedder: any

async function getLocalEmbedder(): Promise<any> {
  if (!localEmbedder) {
    let pipeline: any
    try {
      const mod = await import("@xenova/transformers")
      pipeline = mod.pipeline
    } catch {
      throw new Error(
        "Semantic search requires @xenova/transformers. Install it with: npm install @xenova/transformers",
      )
    }
    localEmbedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")
  }
  return localEmbedder
}

async function embedLocal(text: string): Promise<EmbeddingVector> {
  const model = await getLocalEmbedder()
  const result = await model(text, { pooling: "mean", normalize: true })
  return Array.from(result.data) as number[]
}

// ── OpenAI-compatible remote embedder ───────────────────────────────────────

async function embedRemote(
  text: string,
  config: EmbeddingConnectionConfig,
): Promise<EmbeddingVector> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`
  }

  const response = await fetch(config.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      input: text,
      model: config.model,
      ...(config.dimension ? { dimensions: config.dimension } : {}),
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Embedding request failed (${response.status}): ${body}`)
  }

  const json = (await response.json()) as {
    data: Array<{ embedding: number[] }>
  }

  if (!json.data?.[0]?.embedding) {
    throw new Error("Unexpected embedding response format: missing data[0].embedding")
  }

  return json.data[0].embedding
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate an embedding for the given text.
 * If embeddingConfig is provided, uses the configured OpenAI-compatible endpoint.
 * Otherwise falls back to local @xenova/transformers.
 */
export async function embed(
  text: string,
  embeddingConfig?: EmbeddingConnectionConfig,
): Promise<EmbeddingVector> {
  if (embeddingConfig) {
    return embedRemote(text, embeddingConfig)
  }
  return embedLocal(text)
}

// ── Similarity ──────────────────────────────────────────────────────────────

export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  const len = Math.min(a.length, b.length)
  if (len === 0) return 0
  let dot = 0
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
  }
  return dot
}

// ── Availability check ──────────────────────────────────────────────────────

export async function isEmbeddingAvailable(
  embeddingConfig?: EmbeddingConnectionConfig,
): Promise<boolean> {
  if (embeddingConfig) {
    try {
      await embedRemote("test", embeddingConfig)
      return true
    } catch {
      return false
    }
  }
  try {
    await getLocalEmbedder()
    return true
  } catch {
    return false
  }
}
