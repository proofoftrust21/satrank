// Phase 12.2 (2026-05-05) — BM25 in-process scorer.
//
// Per audit semantic-rank-layer 2026-05-05 (lens L4, finding "no-bm25-only-
// baseline-measured", impact 5). Audit verdict was WRONG on the original
// plan because dense embeddings were specced without measuring BM25 first.
// On short structured intents over a 192-row catalogue with category +
// modality filters, BM25 routinely hits 95%+ retrieval quality (BEIR :
// BM25 beats dense on FiQA, SciFact, ArguAna). This service is the
// baseline that gates whether dense embeddings are worth shipping.
//
// Implementation : Okapi BM25 with k1=1.5, b=0.75 (standard defaults).
// Inverted index in-memory ; tokenizer = lowercase + non-alphanumeric
// split + English stopwords. ~30MB RAM at 100k endpoints, sub-ms query
// latency at 192. No external dependency, fully deterministic.

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;

// Conservative English stopword list. Drop these so common verbs don't
// dominate the IDF distribution. Borrowed from Lucene's
// EnglishAnalyzer.ENGLISH_STOP_WORDS_SET (subset, the high-frequency core).
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if',
  'in', 'into', 'is', 'it', 'no', 'not', 'of', 'on', 'or', 'such', 'that',
  'the', 'their', 'then', 'there', 'these', 'they', 'this', 'to', 'was',
  'will', 'with', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him',
  'his', 'she', 'her', 'them', 'do', 'does', 'did', 'has', 'have', 'had',
  'can', 'could', 'should', 'would', 'may', 'might', 'must', 'need',
]);

export interface Bm25Document {
  id: number;
  text: string;
}

export interface Bm25Score {
  id: number;
  score: number;
}

interface PostingList {
  /** doc_id → term frequency in that doc. */
  postings: Map<number, number>;
  /** number of docs containing the term. */
  df: number;
}

/** Pure tokenizer : lowercase, split on non-alphanumeric, drop stopwords +
 *  too-short tokens. Exported for tests. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

export class Bm25Service {
  private invertedIndex: Map<string, PostingList> = new Map();
  private docLengths: Map<number, number> = new Map();
  private avgDocLength = 0;
  private docCount = 0;
  private k1: number;
  private b: number;

  constructor(opts: { k1?: number; b?: number } = {}) {
    this.k1 = opts.k1 ?? DEFAULT_K1;
    this.b = opts.b ?? DEFAULT_B;
  }

  /** Build the inverted index from scratch. Call when the catalogue
   *  changes ; for SatRank's 192-row catalog this takes ~1ms. */
  buildIndex(docs: ReadonlyArray<Bm25Document>): void {
    this.invertedIndex = new Map();
    this.docLengths = new Map();
    this.docCount = docs.length;
    let totalLen = 0;
    for (const doc of docs) {
      const tokens = tokenize(doc.text);
      this.docLengths.set(doc.id, tokens.length);
      totalLen += tokens.length;
      const termFreqs = new Map<string, number>();
      for (const t of tokens) {
        termFreqs.set(t, (termFreqs.get(t) ?? 0) + 1);
      }
      for (const [term, tf] of termFreqs) {
        let pl = this.invertedIndex.get(term);
        if (!pl) {
          pl = { postings: new Map(), df: 0 };
          this.invertedIndex.set(term, pl);
        }
        pl.postings.set(doc.id, tf);
        pl.df += 1;
      }
    }
    this.avgDocLength = this.docCount > 0 ? totalLen / this.docCount : 0;
  }

  /** Score a single doc against a query. Returns 0 if the doc is unknown
   *  (caller passed an id that wasn't in buildIndex). */
  score(docId: number, query: string): number {
    if (this.docCount === 0) return 0;
    const docLen = this.docLengths.get(docId);
    if (docLen === undefined) return 0;
    const queryTerms = new Set(tokenize(query));
    if (queryTerms.size === 0) return 0;
    let score = 0;
    for (const term of queryTerms) {
      const pl = this.invertedIndex.get(term);
      if (!pl) continue;
      const tf = pl.postings.get(docId);
      if (tf === undefined || tf === 0) continue;
      // Okapi BM25 IDF : log((N - df + 0.5) / (df + 0.5) + 1).
      // The +1 inside the log is the BM25Plus / Lucene variant : keeps
      // IDF non-negative even when df > N/2.
      const idf = Math.log(((this.docCount - pl.df + 0.5) / (pl.df + 0.5)) + 1);
      const norm = 1 - this.b + this.b * (docLen / (this.avgDocLength || 1));
      const tfTerm = (tf * (this.k1 + 1)) / (tf + this.k1 * norm);
      score += idf * tfTerm;
    }
    return score;
  }

  /** Top-K matching docs for a query. O(|query terms| * avg posting len)
   *  — for SatRank scale that's microseconds. */
  topK(query: string, k: number): Bm25Score[] {
    const queryTerms = new Set(tokenize(query));
    if (queryTerms.size === 0 || this.docCount === 0) return [];
    // Aggregate scores across terms in a single pass over the matching
    // posting lists, instead of scoring every doc individually.
    const scores = new Map<number, number>();
    for (const term of queryTerms) {
      const pl = this.invertedIndex.get(term);
      if (!pl) continue;
      const idf = Math.log(((this.docCount - pl.df + 0.5) / (pl.df + 0.5)) + 1);
      for (const [docId, tf] of pl.postings) {
        const docLen = this.docLengths.get(docId) ?? 0;
        const norm = 1 - this.b + this.b * (docLen / (this.avgDocLength || 1));
        const tfTerm = (tf * (this.k1 + 1)) / (tf + this.k1 * norm);
        scores.set(docId, (scores.get(docId) ?? 0) + idf * tfTerm);
      }
    }
    return Array.from(scores.entries())
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /** Diagnostics for the explain mode (audit L5 + L6). Returns per-term
   *  contribution to the score so agents can audit the ranking decision
   *  without an LLM-in-loop. */
  explain(docId: number, query: string): Array<{ term: string; tf: number; idf: number; contribution: number }> {
    const result: Array<{ term: string; tf: number; idf: number; contribution: number }> = [];
    if (this.docCount === 0) return result;
    const docLen = this.docLengths.get(docId);
    if (docLen === undefined) return result;
    const queryTerms = new Set(tokenize(query));
    for (const term of queryTerms) {
      const pl = this.invertedIndex.get(term);
      if (!pl) continue;
      const tf = pl.postings.get(docId);
      if (tf === undefined || tf === 0) continue;
      const idf = Math.log(((this.docCount - pl.df + 0.5) / (pl.df + 0.5)) + 1);
      const norm = 1 - this.b + this.b * (docLen / (this.avgDocLength || 1));
      const tfTerm = (tf * (this.k1 + 1)) / (tf + this.k1 * norm);
      result.push({ term, tf, idf, contribution: idf * tfTerm });
    }
    return result.sort((a, b) => b.contribution - a.contribution);
  }

  stats(): { docCount: number; avgDocLength: number; vocabSize: number } {
    return {
      docCount: this.docCount,
      avgDocLength: this.avgDocLength,
      vocabSize: this.invertedIndex.size,
    };
  }
}
