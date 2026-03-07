import type { StashEntry } from "./metadata"

// ── Adapter Interface ───────────────────────────────────────────────────────

export interface ScoredEntry {
  id: string
  text: string
  entry: StashEntry
  path: string
}

export interface ScoredResult {
  entry: StashEntry
  path: string
  score: number
}

export interface SearchAdapter {
  buildIndex(entries: ScoredEntry[]): void
  search(query: string, limit: number, typeFilter?: string): ScoredResult[]
}

// ── TF-IDF Implementation ───────────────────────────────────────────────────

interface TfIdfDocument {
  entry: ScoredEntry
  termFreqs: Map<string, number>
  magnitude: number
}

interface SerializedTfIdf {
  idf: Record<string, number>
  docs: Array<{
    id: string
    termFreqs: Record<string, number>
    magnitude: number
  }>
}

export class TfIdfAdapter implements SearchAdapter {
  private documents: TfIdfDocument[] = []
  private idf: Map<string, number> = new Map()
  private entries: ScoredEntry[] = []

  buildIndex(entries: ScoredEntry[]): void {
    this.entries = entries
    const docCount = entries.length
    if (docCount === 0) return

    // Compute term frequencies per document
    const docFreqs = new Map<string, number>()
    this.documents = entries.map((entry) => {
      const tokens = tokenize(entry.text)
      const termFreqs = new Map<string, number>()

      for (const token of tokens) {
        termFreqs.set(token, (termFreqs.get(token) || 0) + 1)
      }

      // Track document frequency for IDF
      for (const term of termFreqs.keys()) {
        docFreqs.set(term, (docFreqs.get(term) || 0) + 1)
      }

      return { entry, termFreqs, magnitude: 0 }
    })

    // Compute IDF: log(N / df)
    this.idf = new Map()
    for (const [term, df] of docFreqs) {
      this.idf.set(term, Math.log(docCount / df))
    }

    // Compute document magnitudes for cosine similarity
    for (const doc of this.documents) {
      let sumSq = 0
      for (const [term, tf] of doc.termFreqs) {
        const idf = this.idf.get(term) || 0
        const tfidf = tf * idf
        sumSq += tfidf * tfidf
      }
      doc.magnitude = Math.sqrt(sumSq)
    }
  }

  search(query: string, limit: number, typeFilter?: string): ScoredResult[] {
    if (this.documents.length === 0) return []

    const queryTokens = tokenize(query.toLowerCase())
    if (queryTokens.length === 0) {
      // Empty query: return all, sorted by type
      return this.documents
        .filter((d) => !typeFilter || typeFilter === "any" || d.entry.entry.type === typeFilter)
        .slice(0, limit)
        .map((d) => ({
          entry: d.entry.entry,
          path: d.entry.path,
          score: 1,
        }))
    }

    // Build query TF-IDF vector
    const queryTermFreqs = new Map<string, number>()
    for (const token of queryTokens) {
      queryTermFreqs.set(token, (queryTermFreqs.get(token) || 0) + 1)
    }

    let queryMagnitude = 0
    const queryVector = new Map<string, number>()
    for (const [term, tf] of queryTermFreqs) {
      const idf = this.idf.get(term) || 0
      const tfidf = tf * idf
      queryVector.set(term, tfidf)
      queryMagnitude += tfidf * tfidf
    }
    queryMagnitude = Math.sqrt(queryMagnitude)

    if (queryMagnitude === 0) {
      // All query terms are unknown — fallback to substring match
      return this.substringFallback(query, limit, typeFilter)
    }

    const results: ScoredResult[] = []
    const querySet = new Set(queryTokens)

    for (const doc of this.documents) {
      if (typeFilter && typeFilter !== "any" && doc.entry.entry.type !== typeFilter) continue

      // Cosine similarity
      let dotProduct = 0
      for (const [term, queryTfidf] of queryVector) {
        const docTf = doc.termFreqs.get(term) || 0
        if (docTf === 0) continue
        const docIdf = this.idf.get(term) || 0
        dotProduct += queryTfidf * (docTf * docIdf)
      }

      let score = doc.magnitude > 0 && queryMagnitude > 0
        ? dotProduct / (doc.magnitude * queryMagnitude)
        : 0

      // Boost: tag exact match
      const tags = doc.entry.entry.tags || []
      for (const tag of tags) {
        if (querySet.has(tag.toLowerCase())) {
          score += 0.15
        }
      }

      // Boost: name contains query token
      const nameLower = doc.entry.entry.name.toLowerCase().replace(/[-_]/g, " ")
      for (const token of queryTokens) {
        if (nameLower.includes(token)) {
          score += 0.1
          break
        }
      }

      if (score > 0) {
        results.push({
          entry: doc.entry.entry,
          path: doc.entry.path,
          score: Math.round(score * 1000) / 1000,
        })
      }
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }

  serialize(): SerializedTfIdf {
    const idf: Record<string, number> = {}
    for (const [term, val] of this.idf) {
      idf[term] = val
    }
    const docs = this.documents.map((d) => {
      const termFreqs: Record<string, number> = {}
      for (const [term, tf] of d.termFreqs) {
        termFreqs[term] = tf
      }
      return { id: d.entry.id, termFreqs, magnitude: d.magnitude }
    })
    return { idf, docs }
  }

  static deserialize(data: SerializedTfIdf, entries: ScoredEntry[]): TfIdfAdapter {
    const adapter = new TfIdfAdapter()
    adapter.entries = entries

    adapter.idf = new Map(Object.entries(data.idf))

    const entryMap = new Map(entries.map((e) => [e.id, e]))
    adapter.documents = data.docs
      .map((d) => {
        const entry = entryMap.get(d.id)
        if (!entry) return null
        return {
          entry,
          termFreqs: new Map(Object.entries(d.termFreqs)),
          magnitude: d.magnitude,
        }
      })
      .filter((d): d is TfIdfDocument => d !== null)

    return adapter
  }

  private substringFallback(query: string, limit: number, typeFilter?: string): ScoredResult[] {
    const q = query.toLowerCase()
    return this.documents
      .filter((d) => {
        if (typeFilter && typeFilter !== "any" && d.entry.entry.type !== typeFilter) return false
        return d.entry.text.includes(q) || d.entry.entry.name.toLowerCase().includes(q)
      })
      .slice(0, limit)
      .map((d) => ({
        entry: d.entry.entry,
        path: d.entry.path,
        score: 0.5,
      }))
  }
}

// ── Tokenization ────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "during", "before", "after", "above", "below",
  "and", "but", "or", "nor", "not", "so", "yet", "both", "either",
  "neither", "each", "every", "all", "any", "few", "more", "most",
  "other", "some", "such", "no", "only", "own", "same", "than",
  "too", "very", "just", "because", "if", "when", "where", "how",
  "what", "which", "who", "whom", "this", "that", "these", "those",
  "it", "its",
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
}
