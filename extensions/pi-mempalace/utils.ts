/**
 * utils.ts — Pure helper functions for pi-mempalace.
 *
 * Contains embedding generation, content hashing, chunking,
 * and math utilities extracted from memory_store.ts.
 */

import { EMBEDDING_DIM, CHUNK_SIZE, CHUNK_OVERLAP, MIN_CHUNK_SIZE, MODEL_NAME } from "./types.js";
import * as crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Content Hash (SHA-256, truncated to 16 hex chars)
// ---------------------------------------------------------------------------

export function contentHash(content: string): string {
  return crypto
    .createHash("sha256")
    .update(content, "utf-8")
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Embeddings (lazy-loaded)
// ---------------------------------------------------------------------------

let embedder: any = null;
let embedderLoading: Promise<any> | null = null;

async function getEmbedder(): Promise<any> {
  if (embedder) return embedder;
  if (embedderLoading) return embedderLoading;

  embedderLoading = (async () => {
    const { pipeline } = await import("@huggingface/transformers");
    embedder = await pipeline("feature-extraction", MODEL_NAME, {
      dtype: "fp32" as any,
    });
    return embedder;
  })();

  return embedderLoading;
}

/** Generate an embedding vector for the given text. */
export async function embed(text: string): Promise<Float32Array> {
  const extractor = await getEmbedder();
  const result = await extractor(text, { pooling: "mean", normalize: true });
  return new Float32Array(result.data);
}

/** Decode a base64-encoded embedding back to Float32Array. */
export function base64ToEmbedding(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * Split text into chunks of CHUNK_SIZE with CHUNK_OVERLAP overlap.
 * Tries to break on paragraph boundaries.
 */
export function chunkText(content: string): string[] {
  if (content.length <= CHUNK_SIZE) return [content];

  const chunks: string[] = [];
  let offset = 0;

  while (offset < content.length) {
    let end = Math.min(offset + CHUNK_SIZE, content.length);

    // Try to break on paragraph boundary
    if (end < content.length) {
      const paraBreak = content.lastIndexOf("\n\n", end);
      if (paraBreak > offset + CHUNK_SIZE / 2) end = paraBreak;
      else {
        const lineBreak = content.lastIndexOf("\n", end);
        if (lineBreak > offset + CHUNK_SIZE / 2) end = lineBreak;
      }
    }

    const chunk = content.slice(offset, end).trim();
    if (chunk.length >= MIN_CHUNK_SIZE) chunks.push(chunk);

    offset = end - CHUNK_OVERLAP;
    if (offset >= content.length) break;
    // Prevent infinite loop
    if (end === offset + CHUNK_OVERLAP) offset = end;
  }

  return chunks.length > 0 ? chunks : [content];
}

// ---------------------------------------------------------------------------
// Distance ↔ Similarity Conversion
// ---------------------------------------------------------------------------

/**
 * Convert sqlite-vec L2 distance to cosine similarity.
 * For L2-normalized vectors: similarity = 1 - (distance² / 2)
 * sqlite-vec returns the actual L2 distance (not squared).
 */
export function distanceToSimilarity(distance: number): number {
  return 1 - (distance * distance) / 2;
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a memory document ID from a content hash.
 */
export function memoryId(contentHash: string): string {
  return `mem_${contentHash}`;
}

// ---------------------------------------------------------------------------
// Text Similarity (for semantic dedup)
// ---------------------------------------------------------------------------

/**
 * Compute Jaccard similarity between two texts using word-level tokens.
 * Lowercases, removes punctuation, filters short words (< 3 chars).
 * Returns 0.0 (completely different) to 1.0 (identical token sets).
 */
export function jaccardSimilarity(a: string, b: string): number {
  const tokenize = (text: string): Set<string> =>
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2)
    );

  const wordsA = tokenize(a);
  const wordsB = tokenize(b);

  if (wordsA.size === 0 && wordsB.size === 0) return 1.0;
  if (wordsA.size === 0 || wordsB.size === 0) return 0.0;

  // Intersection
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0.0 : intersection / union;
}
