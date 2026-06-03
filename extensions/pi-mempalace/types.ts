/**
 * types.ts — Shared type definitions for pi-mempalace.
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export interface MemoryMetadata {
  project: string;
  topic: string;
  source: string;
  timestamp: string;
  session_id: string;
}

export interface StoredMemory {
  id: string;
  content: string;
  metadata: MemoryMetadata;
  /** Base64-encoded Float32Array of the embedding vector */
  embedding: string;
}

export interface StoreInput {
  content: string;
  project?: string;
  topic?: string;
  source?: string;
  timestamp?: string;
  session_id?: string;
  importance?: number;
}

export interface SearchResult {
  id: string;
  text: string;
  project: string;
  topic: string;
  source: string;
  timestamp: string;
  similarity: number;
}

export interface StoreResult {
  status: "stored" | "duplicate";
  id: string;
}

export interface BatchStoreResult {
  stored: number;
  duplicates: number;
  results: StoreResult[];
}

export interface StatusResult {
  memory_dir: string;
  store_path: string;
  identity_exists: boolean;
  total_memories: number;
  projects: Record<string, number>;
  storage_size_kb: number;
}

export interface WakeupResult {
  text: string;
  token_estimate: number;
}

export interface MemoryStats {
  total: number;
  projects: Record<string, number>;
  topics: Record<string, number>;
  sources: Record<string, number>;
  sessions: number;
  oldest: string | null;
  newest: string | null;
  /** Memories per day, keyed by YYYY-MM-DD */
  timeline: Record<string, number>;
  avgContentLength: number;
  storageSizeKb: number;
}

// ---------------------------------------------------------------------------
// Palace Graph types
// ---------------------------------------------------------------------------

export interface TunnelInfo {
  topic: string;
  projects: [string, string];
  memoryCounts: [number, number];
}

export interface PalaceNode {
  name: string;
  memoryCount: number;
  topics: string[];
}

export interface PalaceEdge {
  topic: string;
  projectA: string;
  projectB: string;
  strength: number;
}

export interface PalaceGraph {
  nodes: PalaceNode[];
  edges: PalaceEdge[];
}

// ---------------------------------------------------------------------------
// Knowledge Graph types
// ---------------------------------------------------------------------------

export interface EntityInput {
  id?: string;
  name: string;
  entity_type?: string;
  properties?: Record<string, unknown>;
}

export interface EntityResult {
  status: "created" | "updated";
  id: string;
}

export interface TripleInput {
  subject: string;
  predicate: string;
  object: string;
  valid_from?: string;
  valid_to?: string;
  confidence?: number;
  source_memory_id?: string;
  project?: string;
}

export interface TripleResult {
  status: "created";
  id: number;
}

export interface Fact {
  subject: string;
  predicate: string;
  object: string;
  valid_from: string | null;
  valid_to: string | null;
  confidence: number;
  project: string;
  trust_score: number;
  trust_updates: number;
}

export interface TrustFeedbackInput {
  triple_id: number;
  positive: boolean;
}

export interface LowTrustFact {
  triple_id: number;
  subject: string;
  predicate: string;
  object: string;
  trust_score: number;
  trust_updates: number;
  project: string;
}

export interface DecayScanResult {
  archived: { id: string; reason: string }[];
  merged: { into: string; from: string[]; similarity: number }[];
  expired_facts: { subject: string; predicate: string; object: string; trust_score: number }[];
  summary: string;
}

export interface KnowledgeResult {
  entity: {
    id: string;
    name: string;
    type: string;
    properties: Record<string, unknown>;
  } | null;
  facts: Fact[];
}

export interface KnowledgeStats {
  entityCount: number;
  tripleCount: number;
  activeTriples: number;
  entityTypes: Record<string, number>;
  predicates: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Query/read types
// ---------------------------------------------------------------------------

export interface RoomInfo {
  topic: string;
  count: number;
  projects: string[];
}

export interface TaxonomyNode {
  project: string;
  topics: { topic: string; count: number }[];
  total: number;
}

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  hashMatch: boolean;
  semanticMatch: SearchResult | null;
}

export interface TimelineFact {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  valid_from: string | null;
  valid_to: string | null;
  confidence: number;
  trust_score: number;
  trust_updates: number;
  project: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Database row types (internal)
// ---------------------------------------------------------------------------

export interface MemoryRow {
  rowid: number;
  id: string;
  content: string;
  content_hash: string;
  project: string;
  topic: string;
  source: string;
  timestamp: string;
  session_id: string;
  importance: number;
  chunk_index: number;
  parent_id: string | null;
}

export interface VecSearchRow {
  rowid: number;
  distance: number;
}

export interface CountRow {
  project?: string;
  topic?: string;
  source?: string;
  session_id?: string;
  cnt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MEMORY_DIR = process.env.HOME || process.env.USERPROFILE || "~";

/** Embedding model identifier */
export const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";

/** Embedding dimension (all-MiniLM-L6-v2 output) */
export const EMBEDDING_DIM = 384;

/** Max characters per chunk */
export const CHUNK_SIZE = 800;

/** Overlap between chunks */
export const CHUNK_OVERLAP = 100;

/** Minimum chunk size to keep */
export const MIN_CHUNK_SIZE = 50;
