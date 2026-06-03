/**
 * memory_store.ts — SQLite + sqlite-vec memory backend.
 *
 * MemoryStore class: persistent storage, vector search, knowledge graph,
 * palace graph, diary, and related operations.
 *
 * Previously a single monolithic file; now imports shared types and helpers
 * from types.ts and utils.ts.
 *
 * All operations are in-process — no subprocess spawning.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// @ts-ignore — better-sqlite3 types may not be perfect
import Database from "better-sqlite3";
// @ts-ignore — sqlite-vec has no type declarations
import * as sqliteVec from "sqlite-vec";

import {
  EMBEDDING_DIM,
} from "./types.js";

// ---------------------------------------------------------------------------
// Default memory directory (home-dir-relative)
// ---------------------------------------------------------------------------

/** Default memory directory path. Export so index.ts can share it. */
export const DEFAULT_MEMORY_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".pi",
  "agent",
  "memory"
);
import type {
  MemoryRow,
  VecSearchRow,
  CountRow,
  StoreInput,
  StoreResult,
  BatchStoreResult,
  SearchResult,
  WakeupResult,
  StatusResult,
  MemoryStats,
  TunnelInfo,
  PalaceNode,
  PalaceEdge,
  PalaceGraph,
  EntityInput,
  EntityResult,
  TripleInput,
  TripleResult,
  Fact,
  KnowledgeResult,
  KnowledgeStats,
  LowTrustFact,
  DecayScanResult,
  RoomInfo,
  TaxonomyNode,
  DuplicateCheckResult,
  TimelineFact,
} from "./types.js";

import {
  contentHash,
  embed,
  base64ToEmbedding,
  chunkText,
  distanceToSimilarity,
  memoryId,
  jaccardSimilarity,
} from "./utils.js";

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

export class MemoryStore {
  private db: any = null;
  private loaded = false;
  private memoryDir: string;
  private cachedL1: string | null = null;

  // Prepared statements (initialized in load)
  private stmtInsertMemory: any = null;
  private stmtInsertVec: any = null;
  private stmtFindByHash: any = null;
  private stmtFindById: any = null;
  private stmtDeleteMemory: any = null;
  private stmtDeleteVec: any = null;
  private stmtCountAll: any = null;
  private stmtHasId: any = null;

  constructor(memoryDir: string = DEFAULT_MEMORY_DIR) {
    this.memoryDir = memoryDir;
  }

  get dbPath(): string {
    return path.join(this.memoryDir, "memories.db");
  }

  /** Legacy JSONL path — used for migration detection */
  get storePath(): string {
    return path.join(this.memoryDir, "memories.jsonl");
  }

  get identityPath(): string {
    return path.join(this.memoryDir, "identity.txt");
  }

  // -----------------------------------------------------------------------
  // Database Lifecycle
  // -----------------------------------------------------------------------

  /** Open the database, create tables, and run migration if needed. */
  load(): void {
    if (this.loaded) return;

    fs.mkdirSync(this.memoryDir, { recursive: true });

    this.db = new Database(this.dbPath);
    sqliteVec.load(this.db);

    // WAL mode for better concurrent read performance
    this.db.pragma("journal_mode = WAL");

    // Create schema
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        project TEXT NOT NULL DEFAULT 'general',
        topic TEXT NOT NULL DEFAULT 'general',
        source TEXT NOT NULL DEFAULT 'auto-capture',
        timestamp TEXT NOT NULL,
        session_id TEXT NOT NULL DEFAULT '',
        importance REAL DEFAULT 0.5,
        chunk_index INTEGER DEFAULT 0,
        parent_id TEXT DEFAULT NULL,
        archived INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
      CREATE INDEX IF NOT EXISTS idx_memories_topic ON memories(topic);
      CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
      CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash);
    `);

    // Migrate existing databases: add chunk_index and parent_id columns
    try {
      this.db.exec(
        `ALTER TABLE memories ADD COLUMN chunk_index INTEGER DEFAULT 0`
      );
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(
        `ALTER TABLE memories ADD COLUMN parent_id TEXT DEFAULT NULL`
      );
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(
        `ALTER TABLE memories ADD COLUMN archived INTEGER DEFAULT 0`
      );
    } catch {
      /* column already exists */
    }

    // Migrate existing triples tables: add trust_score, trust_updates, last_feedback
    try {
      this.db.exec(
        `ALTER TABLE triples ADD COLUMN trust_score REAL DEFAULT 0.5`
      );
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(
        `ALTER TABLE triples ADD COLUMN trust_updates INTEGER DEFAULT 0`
      );
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(
        `ALTER TABLE triples ADD COLUMN last_feedback TEXT`
      );
    } catch {
      /* column already exists */
    }

    // Knowledge Graph tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        entity_type TEXT DEFAULT 'unknown',
        properties TEXT DEFAULT '{}',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);

      CREATE TABLE IF NOT EXISTS triples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        valid_from TEXT,
        valid_to TEXT,
        confidence REAL DEFAULT 1.0,
        trust_score REAL DEFAULT 0.5,
        trust_updates INTEGER DEFAULT 0,
        last_feedback TEXT,
        source_memory_id TEXT,
        project TEXT DEFAULT 'general',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (subject) REFERENCES entities(id),
        FOREIGN KEY (object) REFERENCES entities(id)
      );
      CREATE INDEX IF NOT EXISTS idx_triples_subject ON triples(subject);
      CREATE INDEX IF NOT EXISTS idx_triples_object ON triples(object);
      CREATE INDEX IF NOT EXISTS idx_triples_predicate ON triples(predicate);
      CREATE INDEX IF NOT EXISTS idx_triples_valid ON triples(valid_from, valid_to);
      CREATE INDEX IF NOT EXISTS idx_triples_project ON triples(project);
    `);

    // sqlite-vec virtual table — created separately since CREATE VIRTUAL TABLE
    // doesn't support IF NOT EXISTS in all versions; catch the error if it exists.
    try {
      this.db.exec(
        `CREATE VIRTUAL TABLE vec_memories USING vec0(embedding float[${EMBEDDING_DIM}])`
      );
    } catch (e: any) {
      // Table already exists — that's fine
      if (!String(e.message).includes("already exists")) {
        throw e;
      }
    }

    // Prepare statements
    this.stmtInsertMemory = this.db.prepare(`
      INSERT INTO memories (id, content, content_hash, project, topic, source, timestamp, session_id, importance, chunk_index, parent_id)
      VALUES (@id, @content, @content_hash, @project, @topic, @source, @timestamp, @session_id, @importance, @chunk_index, @parent_id)
    `);

    this.stmtInsertVec = this.db.prepare(`
      INSERT INTO vec_memories (rowid, embedding) VALUES (?, ?)
    `);

    this.stmtFindByHash = this.db.prepare(
      `SELECT id FROM memories WHERE content_hash = ?`
    );

    this.stmtFindById = this.db.prepare(
      `SELECT * FROM memories WHERE id = ?`
    );

    this.stmtDeleteMemory = this.db.prepare(
      `DELETE FROM memories WHERE id = ?`
    );

    this.stmtDeleteVec = this.db.prepare(
      `DELETE FROM vec_memories WHERE rowid = ?`
    );

    this.stmtCountAll = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM memories`
    );

    this.stmtHasId = this.db.prepare(
      `SELECT 1 FROM memories WHERE id = ? LIMIT 1`
    );

    // Run migration from JSONL if old file exists and DB is empty
    if (fs.existsSync(this.storePath) && this.countAll() === 0) {
      this.migrateFromJsonl();
    }

    this.loaded = true;
  }

  /** Ensure the store is loaded. */
  private ensureLoaded(): void {
    if (!this.loaded) this.load();
  }

  // -----------------------------------------------------------------------
  // Internal Helpers
  // -----------------------------------------------------------------------

  private countAll(): number {
    return (this.stmtCountAll.get() as CountRow).cnt;
  }

  /**
   * Insert a memory + its embedding in a single transaction.
   * Returns the rowid of the inserted memory.
   */
  private insertMemoryAndVec(
    id: string,
    content: string,
    cHash: string,
    project: string,
    topic: string,
    source: string,
    timestamp: string,
    sessionId: string,
    importance: number,
    embedding: Float32Array,
    chunkIndex: number = 0,
    parentId: string | null = null
  ): number {
    const insertBoth = this.db.transaction(() => {
      const info = this.stmtInsertMemory.run({
        id,
        content,
        content_hash: cHash,
        project,
        topic,
        source,
        timestamp,
        session_id: sessionId,
        importance,
        chunk_index: chunkIndex,
        parent_id: parentId,
      });
      const rowid = Number(info.lastInsertRowid);
      this.stmtInsertVec.run(BigInt(rowid), embedding);
      return rowid;
    });
    return insertBoth();
  }

  // -----------------------------------------------------------------------
  // Migration
  // -----------------------------------------------------------------------

  /** Migrate memories from legacy JSONL file to SQLite. */
  migrateFromJsonl(): void {
    const jsonlPath = this.storePath;
    if (!fs.existsSync(jsonlPath)) return;

    const lines = fs
      .readFileSync(jsonlPath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);

    if (lines.length === 0) return;

    const migrate = this.db.transaction(() => {
      for (const line of lines) {
        let mem: any;
        try {
          mem = JSON.parse(line);
        } catch {
          continue; // Skip corrupt lines
        }

        const cHash = contentHash(mem.content);

        // Skip if already migrated
        if (this.stmtFindByHash.get(cHash)) continue;

        // Decode existing embedding from base64
        let embedding: Float32Array;
        try {
          embedding = base64ToEmbedding(mem.embedding);
          if (embedding.length !== EMBEDDING_DIM) continue; // Skip bad embeddings
        } catch {
          continue;
        }

        try {
          this.insertMemoryAndVec(
            mem.id,
            mem.content,
            cHash,
            mem.metadata?.project || "general",
            mem.metadata?.topic || "general",
            mem.metadata?.source || "auto-capture",
            mem.metadata?.timestamp || new Date().toISOString(),
            mem.metadata?.session_id || "",
            0.5, // Default importance for migrated memories
            embedding
          );
        } catch {
          // Skip duplicates or other insertion errors
        }
      }
    });

    migrate();

    // Rename old file to backup
    const bakPath = jsonlPath + ".bak";
    try {
      fs.renameSync(jsonlPath, bakPath);
    } catch {
      // If rename fails, leave it — migration is still done
    }
  }

  // -----------------------------------------------------------------------
  // Commands
  // -----------------------------------------------------------------------

  async store(input: StoreInput): Promise<StoreResult> {
    this.ensureLoaded();

    const content = (input.content || "").trim();
    if (!content) {
      throw new Error("Empty content");
    }

    const project = input.project || "general";
    const topic = input.topic || "general";
    const source = input.source || "auto-capture";
    const timestamp = input.timestamp || new Date().toISOString();
    const sessionId = input.session_id || "";
    const importance = input.importance ?? 0.5;

    const chunks = chunkText(content);

    // Short content: behave exactly as before (no chunking)
    if (chunks.length === 1) {
      const cHash = contentHash(content);
      const docId = `mem_${cHash}`;

      // Check for duplicate
      if (this.stmtFindByHash.get(cHash)) {
        return { status: "duplicate", id: docId };
      }

      const vec = await embed(content);

      this.insertMemoryAndVec(
        docId,
        content,
        cHash,
        project,
        topic,
        source,
        timestamp,
        sessionId,
        importance,
        vec,
        0,    // chunk_index
        null  // parent_id
      );

      // Invalidate L1 cache when new memory is stored
      this.cachedL1 = null;

      return { status: "stored", id: docId };
    }

    // Multi-chunk: each chunk gets its own id, embedding, and row
    const baseHash = contentHash(content);
    const parentId = `mem_${baseHash}_c0`;
    let storedAny = false;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkHash = contentHash(chunk);
      const chunkId = `mem_${baseHash}_c${i}`;

      // Skip duplicate chunks
      if (this.stmtFindByHash.get(chunkHash)) continue;

      const vec = await embed(chunk);

      try {
        this.insertMemoryAndVec(
          chunkId,
          chunk,
          chunkHash,
          project,
          topic,
          source,
          timestamp,
          sessionId,
          importance,
          vec,
          i,
          i === 0 ? null : parentId
        );
        storedAny = true;
      } catch {
        // Skip duplicates or other insertion errors
      }
    }

    // Invalidate L1 cache when new memory is stored
    this.cachedL1 = null;

    return {
      status: storedAny ? "stored" : "duplicate",
      id: parentId,
    };
  }

  async batchStore(items: StoreInput[]): Promise<BatchStoreResult> {
    if (!items || items.length === 0) {
      throw new Error("No items provided");
    }

    this.ensureLoaded();

    // Phase 1: Validate inputs and check for duplicates.
    // Items are assumed to be pre-chunked (no re-chunking).
    // Track input order: batchIndex -> resultIndex mapping
    const batch: Array<{
      content: string;
      cHash: string;
      docId: string;
      project: string;
      topic: string;
      source: string;
      timestamp: string;
      sessionId: string;
      importance: number;
      resultIndex: number;
    }> = [];

    // results[i] corresponds to items[i] (preserving input order)
    const results: StoreResult[] = [];

    for (const item of items) {
      const content = (item.content || "").trim();
      if (!content) {
        results.push({ status: "duplicate", id: "skipped" });
        continue;
      }

      const project = item.project || "general";
      const topic = item.topic || "general";
      const source = item.source || "batch-store";
      const timestamp = item.timestamp || new Date().toISOString();
      const sessionId = item.session_id || "";
      const importance = item.importance ?? 0.5;

      const cHash = contentHash(content);
      const docId = `mem_${cHash}`;

      // Check for duplicate by content hash
      if (this.stmtFindByHash.get(cHash)) {
        results.push({ status: "duplicate", id: docId });
        continue;
      }

      batch.push({ content, cHash, docId, project, topic, source, timestamp, sessionId, importance, resultIndex: results.length });
      results.push({ status: "stored", id: docId }); // placeholder
    }

    if (batch.length === 0) {
      return { stored: 0, duplicates: results.filter(r => r.status !== "stored").length, results };
    }

    // Phase 2: Generate all embeddings sequentially.
    // The embedder pipeline is cached after the first call,
    // so subsequent calls are just inference (no load overhead).
    const embeddings: Float32Array[] = [];
    for (const item of batch) {
      const vec = await embed(item.content);
      embeddings.push(vec);
    }

    // Phase 3: Insert all in a single SQLite transaction.
    const insertBatch = this.db.transaction(() => {
      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        const vec = embeddings[i];

        const info = this.stmtInsertMemory.run({
          id: item.docId,
          content: item.content,
          content_hash: item.cHash,
          project: item.project,
          topic: item.topic,
          source: item.source,
          timestamp: item.timestamp,
          session_id: item.sessionId,
          importance: item.importance,
          chunk_index: 0,
          parent_id: null,
        });
        const rowid = Number(info.lastInsertRowid);
        this.stmtInsertVec.run(BigInt(rowid), vec);
      }
    });
    insertBatch();

    const stored = batch.length;

    // Invalidate L1 cache
    this.cachedL1 = null;

    return { stored, duplicates: results.length - stored, results };
  }

  /**
   * L3: Deep Semantic Search via sqlite-vec.
   *
   * When project/topic filters are specified, performs vector search on a
   * larger candidate set and post-filters by metadata in JS.
   */
  async search(
    query: string,
    options?: { project?: string; topic?: string; n_results?: number }
  ): Promise<{
    query: string;
    filters: Record<string, string | null>;
    results: SearchResult[];
  }> {
    this.ensureLoaded();

    if (!query || !query.trim()) {
      throw new Error("Empty query");
    }

    const project = options?.project || null;
    const topic = options?.topic || null;
    const nResults = Math.min(options?.n_results || 5, 20);

    const queryVec = await embed(query.trim());

    // If filtering, search a wider set and post-filter
    const hasFilters = project || topic;
    const searchLimit = hasFilters ? Math.max(nResults * 10, 50) : nResults;

    const vecRows = this.db
      .prepare(
        `SELECT rowid, distance FROM vec_memories
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?`
      )
      .all(queryVec, searchLimit) as VecSearchRow[];

    if (vecRows.length === 0) {
      return { query, filters: { project, topic }, results: [] };
    }

    // Fetch metadata for matched rowids
    const rowids = vecRows.map((r) => r.rowid);
    const distanceMap = new Map(vecRows.map((r) => [r.rowid, r.distance]));

    // Build IN clause — parameterized via individual placeholders
    const placeholders = rowids.map(() => "?").join(",");
    const memRows = this.db
      .prepare(
        `SELECT rowid, id, content, project, topic, source, timestamp
         FROM memories WHERE rowid IN (${placeholders}) AND archived = 0`
      )
      .all(...rowids) as MemoryRow[];

    // Apply post-filters and build results
    let results: SearchResult[] = [];
    for (const row of memRows) {
      if (project && row.project !== project) continue;
      if (topic && row.topic !== topic) continue;

      const distance = distanceMap.get(row.rowid) ?? Infinity;
      const similarity = distanceToSimilarity(distance);

      results.push({
        id: row.id,
        text: row.content,
        project: row.project,
        topic: row.topic,
        source: row.source,
        timestamp: row.timestamp,
        similarity: Math.round(similarity * 10000) / 10000,
      });
    }

    // Sort by similarity descending, take top N
    results.sort((a, b) => b.similarity - a.similarity);
    results = results.slice(0, nResults);

    return { query, filters: { project, topic }, results };
  }

  /**
   * Wakeup: L0 Identity + L1 Essential Story.
   *
   * L0: Read from identity.txt (always loaded, static).
   * L1: Top 15 memories by importance + recency, grouped by project.
   *     Generated once per session and cached.
   */
  wakeup(options?: { project?: string; max_tokens?: number }): WakeupResult {
    this.ensureLoaded();

    const project = options?.project || null;
    const maxTokens = options?.max_tokens || 800;
    const maxChars = maxTokens * 4;
    const parts: string[] = [];

    // L0: Identity
    if (fs.existsSync(this.identityPath)) {
      const identity = fs.readFileSync(this.identityPath, "utf-8").trim();
      parts.push(`## Memory — Identity\n${identity}`);
    } else {
      parts.push(
        "## Memory — Identity\nNo identity configured. Use /skill:memory-setup to set up."
      );
    }

    // L1: Essential Story (cached)
    if (this.cachedL1 === null) {
      this.cachedL1 = this.generateL1(project, maxChars);
    }
    parts.push(this.cachedL1);

    const text = parts.join("\n");
    return { text, token_estimate: Math.ceil(text.length / 4) };
  }

  /**
   * Generate L1 Essential Story: top 15 memories by importance + recency,
   * grouped by project with compact formatting.
   */
  private generateL1(project: string | null, maxChars: number): string {
    if (this.countAll() === 0) {
      return "\n## Memory — Recent Context\nNo memories stored yet.";
    }

    const whereClause = project ? "WHERE project = ? AND archived = 0" : "WHERE archived = 0";
    const params = project ? [project] : [];
    const rows = this.db
      .prepare(
        `SELECT content, project, topic, timestamp, importance
         FROM memories ${whereClause}
         ORDER BY importance DESC, timestamp DESC
         LIMIT 15`
      )
      .all(...params) as MemoryRow[];

    if (rows.length === 0) {
      return "\n## Memory — Recent Context\nNo memories stored yet.";
    }

    // Group by project
    const byProject: Record<string, MemoryRow[]> = {};
    for (const row of rows) {
      const proj = row.project || "general";
      if (!byProject[proj]) byProject[proj] = [];
      byProject[proj].push(row);
    }

    const lines: string[] = ["\n## Memory — Recent Context"];
    let totalChars = 0;

    for (const [proj, entries] of Object.entries(byProject).sort()) {
      if (totalChars > maxChars) break;
      lines.push(`\n[${proj}]`);
      for (const row of entries.slice(0, 5)) {
        let snippet = row.content.trim().replace(/\n/g, " ");
        if (snippet.length > 200) snippet = snippet.slice(0, 197) + "...";
        const line =
          row.topic && row.topic !== "general"
            ? `  - [${row.topic}] ${snippet}`
            : `  - ${snippet}`;
        totalChars += line.length;
        if (totalChars > maxChars) {
          lines.push("  ... (use memory_search for more)");
          break;
        }
        lines.push(line);
      }
    }

    return lines.join("\n");
  }

  status(): StatusResult {
    this.ensureLoaded();

    const projects = this.countByProject();
    const total = this.countAll();

    return {
      memory_dir: this.memoryDir,
      store_path: this.dbPath,
      identity_exists: fs.existsSync(this.identityPath),
      total_memories: total,
      projects,
      storage_size_kb: this.getStorageSizeKb(),
    };
  }

  delete(id: string): { status: string; id: string } {
    this.ensureLoaded();

    if (!id || !id.trim()) {
      throw new Error("No id provided");
    }

    const row = this.stmtFindById.get(id) as MemoryRow | undefined;
    if (!row) {
      throw new Error(`Memory not found: ${id}`);
    }

    // Delete from both tables in a transaction
    const deleteTransaction = this.db.transaction(() => {
      this.stmtDeleteVec.run(BigInt(row.rowid));
      this.stmtDeleteMemory.run(id);
    });
    deleteTransaction();

    // Invalidate L1 cache
    this.cachedL1 = null;

    return { status: "deleted", id };
  }

  listProjects(): { projects: Record<string, number>; total: number } {
    const { projects, total_memories: total } = this.status();
    return { projects, total };
  }

  /**
   * L2: On-Demand Project Context.
   * Filtered retrieval by project/topic, ordered by timestamp descending.
   */
  recall(options?: {
    project?: string;
    topic?: string;
    n_results?: number;
  }): {
    filters: Record<string, string | null>;
    count: number;
    results: SearchResult[];
  } {
    this.ensureLoaded();

    const project = options?.project || null;
    const topic = options?.topic || null;
    const nResults = Math.min(options?.n_results || 10, 50);

    // Build dynamic query
    const conditions: string[] = ["archived = 0"];
    const params: any[] = [];

    if (project) {
      conditions.push("project = ?");
      params.push(project);
    }
    if (topic) {
      conditions.push("topic = ?");
      params.push(topic);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = this.db
      .prepare(
        `SELECT id, content, project, topic, source, timestamp
         FROM memories ${whereClause}
         ORDER BY timestamp DESC
         LIMIT ?`
      )
      .all(...params, nResults) as MemoryRow[];

    const results: SearchResult[] = rows.map((row) => ({
      id: row.id,
      text: row.content,
      project: row.project,
      topic: row.topic,
      source: row.source,
      timestamp: row.timestamp,
      similarity: 0, // Not applicable for recall
    }));

    return { filters: { project, topic }, count: results.length, results };
  }

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------

  computeStats(): MemoryStats {
    this.ensureLoaded();

    const total = this.countAll();

    if (total === 0) {
      return {
        total: 0,
        projects: {},
        topics: {},
        sources: {},
        sessions: 0,
        oldest: null,
        newest: null,
        timeline: {},
        avgContentLength: 0,
        storageSizeKb: 0,
      };
    }

    const projects = this.groupedCounts("project");
    const topics = this.groupedCounts("topic");
    const sources = this.groupedCounts("source");

    // Session count
    const sessionCount = (
      this.db
        .prepare(
          `SELECT COUNT(DISTINCT session_id) as cnt FROM memories WHERE session_id != '' AND archived = 0`
        )
        .get() as CountRow
    ).cnt;

    // Oldest/newest timestamps
    const oldest = (
      this.db.prepare(`SELECT MIN(timestamp) as val FROM memories WHERE archived = 0`).get() as {
        val: string | null;
      }
    ).val;
    const newest = (
      this.db.prepare(`SELECT MAX(timestamp) as val FROM memories WHERE archived = 0`).get() as {
        val: string | null;
      }
    ).val;

    // Timeline: memories per day
    const timeline: Record<string, number> = {};
    const timelineRows = this.db
      .prepare(
        `SELECT SUBSTR(timestamp, 1, 10) as day, COUNT(*) as cnt
         FROM memories WHERE archived = 0 GROUP BY day ORDER BY day`
      )
      .all() as { day: string; cnt: number }[];
    for (const r of timelineRows) {
      timeline[r.day] = r.cnt;
    }

    // Average content length
    const avgLen = (
      this.db
        .prepare(`SELECT AVG(LENGTH(content)) as val FROM memories WHERE archived = 0`)
        .get() as { val: number }
    ).val;

    return {
      total,
      projects,
      topics,
      sources,
      sessions: sessionCount,
      oldest,
      newest,
      timeline,
      avgContentLength: Math.round(avgLen || 0),
      storageSizeKb: this.getStorageSizeKb(),
    };
  }

  // -----------------------------------------------------------------------
  // Palace Graph / Tunnels
  // -----------------------------------------------------------------------

  /**
   * Discover tunnels: topics that appear in multiple projects.
   * A tunnel connects two projects that share the same topic.
   */
  discoverTunnels(): TunnelInfo[] {
    this.ensureLoaded();

    // Find topics shared across 2+ projects
    const rows = this.db
      .prepare(
        `SELECT topic, project, COUNT(*) as cnt
         FROM memories
         WHERE topic != 'general' AND archived = 0
         GROUP BY topic, project
         HAVING cnt >= 1`
      )
      .all() as { topic: string; project: string; cnt: number }[];

    // Group by topic
    const topicProjects: Record<
      string,
      { project: string; count: number }[]
    > = {};
    for (const row of rows) {
      if (!topicProjects[row.topic]) topicProjects[row.topic] = [];
      topicProjects[row.topic].push({ project: row.project, count: row.cnt });
    }

    // Build tunnel list (topics with 2+ projects)
    const tunnels: TunnelInfo[] = [];
    for (const [topic, projects] of Object.entries(topicProjects)) {
      if (projects.length < 2) continue;

      // Create pairwise tunnels
      for (let i = 0; i < projects.length; i++) {
        for (let j = i + 1; j < projects.length; j++) {
          const [a, b] = [projects[i], projects[j]].sort((x, y) =>
            x.project.localeCompare(y.project)
          );
          tunnels.push({
            topic,
            projects: [a.project, b.project],
            memoryCounts: [a.count, b.count],
          });
        }
      }
    }

    return tunnels;
  }

  /**
   * Get the palace graph: projects as nodes, tunnels as edges.
   */
  getPalaceGraph(): PalaceGraph {
    this.ensureLoaded();

    const projects = this.countByProject();
    const tunnels = this.discoverTunnels();

    const nodes: PalaceNode[] = Object.entries(projects).map(
      ([name, count]) => ({
        name,
        memoryCount: count,
        topics: this.getProjectTopics(name),
      })
    );

    const edges: PalaceEdge[] = tunnels.map((t) => ({
      topic: t.topic,
      projectA: t.projects[0],
      projectB: t.projects[1],
      strength: t.memoryCounts[0] + t.memoryCounts[1],
    }));

    return { nodes, edges };
  }

  /**
   * Traverse a tunnel: find memories in both projects for a shared topic.
   */
  traverseTunnel(
    topic: string,
    projectA: string,
    projectB: string,
    n_results?: number
  ): SearchResult[] {
    this.ensureLoaded();
    const limit = Math.min(n_results || 10, 50);

    const rows = this.db
      .prepare(
        `SELECT id, content, project, topic, source, timestamp
         FROM memories
         WHERE topic = ? AND project IN (?, ?) AND archived = 0
         ORDER BY timestamp DESC
         LIMIT ?`
      )
      .all(topic, projectA, projectB, limit) as MemoryRow[];

    return rows.map((row) => ({
      id: row.id,
      text: row.content,
      project: row.project,
      topic: row.topic,
      source: row.source,
      timestamp: row.timestamp,
      similarity: 0,
    }));
  }

  /** Helper: get distinct non-general topics for a project. */
  private getProjectTopics(project: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT topic FROM memories WHERE project = ? AND topic != 'general' AND archived = 0`
      )
      .all(project) as { topic: string }[];
    return rows.map((r) => r.topic);
  }

  // -----------------------------------------------------------------------
  // Knowledge Graph
  // -----------------------------------------------------------------------

  /**
   * Add or update an entity in the knowledge graph.
   */
  addEntity(input: EntityInput): EntityResult {
    this.ensureLoaded();

    const id =
      input.id || `ent_${contentHash(input.name.toLowerCase())}`;
    const existing = this.db
      .prepare("SELECT id FROM entities WHERE id = ?")
      .get(id) as { id: string } | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE entities SET name = ?, entity_type = ?, properties = ? WHERE id = ?`
        )
        .run(
          input.name,
          input.entity_type || "unknown",
          JSON.stringify(input.properties || {}),
          id
        );
      return { status: "updated", id };
    }

    this.db
      .prepare(
        `INSERT INTO entities (id, name, entity_type, properties, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.entity_type || "unknown",
        JSON.stringify(input.properties || {}),
        new Date().toISOString()
      );

    return { status: "created", id };
  }

  /**
   * Add a temporal triple (fact) to the knowledge graph.
   */
  addTriple(input: TripleInput): TripleResult {
    this.ensureLoaded();

    // Auto-create entities if they don't exist
    this.addEntity({
      name: input.subject,
      id: `ent_${contentHash(input.subject.toLowerCase())}`,
    });
    this.addEntity({
      name: input.object,
      id: `ent_${contentHash(input.object.toLowerCase())}`,
    });

    const subjectId = `ent_${contentHash(input.subject.toLowerCase())}`;
    const objectId = `ent_${contentHash(input.object.toLowerCase())}`;

    const info = this.db
      .prepare(
        `INSERT INTO triples (subject, predicate, object, valid_from, valid_to, confidence, trust_score, source_memory_id, project, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        subjectId,
        input.predicate,
        objectId,
        input.valid_from || null,
        input.valid_to || null,
        input.confidence ?? 1.0,
        0.5, // Default trust_score for new facts
        input.source_memory_id || null,
        input.project || "general",
        new Date().toISOString()
      );

    return { status: "created", id: Number(info.lastInsertRowid) };
  }

  /**
   * Query the knowledge graph for facts about an entity.
   * Supports temporal filtering: only returns facts valid at a given point in time.
   */
  queryEntity(
    name: string,
    options?: { at_time?: string; project?: string }
  ): KnowledgeResult {
    this.ensureLoaded();

    const entityId = `ent_${contentHash(name.toLowerCase())}`;
    const entity = this.db
      .prepare("SELECT * FROM entities WHERE id = ?")
      .get(entityId) as any;

    if (!entity) return { entity: null, facts: [] };

    let query = `
      SELECT t.*,
        s.name as subject_name, s.entity_type as subject_type,
        o.name as object_name, o.entity_type as object_type
      FROM triples t
      JOIN entities s ON t.subject = s.id
      JOIN entities o ON t.object = o.id
      WHERE (t.subject = ? OR t.object = ?)
    `;
    const params: any[] = [entityId, entityId];

    if (options?.at_time) {
      query += ` AND (t.valid_from IS NULL OR t.valid_from <= ?)
                 AND (t.valid_to IS NULL OR t.valid_to >= ?)`;
      params.push(options.at_time, options.at_time);
    }

    if (options?.project) {
      query += ` AND t.project = ?`;
      params.push(options.project);
    }

    query += ` ORDER BY t.trust_score DESC, t.created_at DESC`;

    const rows = this.db.prepare(query).all(...params) as any[];

    const facts: Fact[] = rows.map((r) => ({
      subject: r.subject_name,
      predicate: r.predicate,
      object: r.object_name,
      valid_from: r.valid_from,
      valid_to: r.valid_to,
      confidence: r.confidence,
      trust_score: r.trust_score ?? 0.5,
      trust_updates: r.trust_updates ?? 0,
      project: r.project,
    }));

    return {
      entity: {
        id: entity.id,
        name: entity.name,
        type: entity.entity_type,
        properties: JSON.parse(entity.properties || "{}"),
      },
      facts,
    };
  }

  /**
   * Query triples by predicate (e.g., "uses", "depends_on", "decided").
   */
  queryByPredicate(
    predicate: string,
    options?: { project?: string; at_time?: string }
  ): Fact[] {
    this.ensureLoaded();

    let query = `
      SELECT t.*,
        s.name as subject_name,
        o.name as object_name
      FROM triples t
      JOIN entities s ON t.subject = s.id
      JOIN entities o ON t.object = o.id
      WHERE t.predicate = ?
    `;
    const params: any[] = [predicate];

    if (options?.at_time) {
      query += ` AND (t.valid_from IS NULL OR t.valid_from <= ?)
                 AND (t.valid_to IS NULL OR t.valid_to >= ?)`;
      params.push(options.at_time, options.at_time);
    }

    if (options?.project) {
      query += ` AND t.project = ?`;
      params.push(options.project);
    }

    query += ` ORDER BY t.trust_score DESC, t.created_at DESC`;

    const rows = this.db.prepare(query).all(...params) as any[];

    return rows.map((r) => ({
      subject: r.subject_name,
      predicate: r.predicate,
      object: r.object_name,
      valid_from: r.valid_from,
      valid_to: r.valid_to,
      confidence: r.confidence,
      trust_score: r.trust_score ?? 0.5,
      trust_updates: r.trust_updates ?? 0,
      project: r.project,
    }));
  }

  /**
   * Update the trust score of a fact (triple).
   * Delta is added to the current trust_score, capped at [0.0, 1.0].
   * Increments trust_updates counter and records the feedback timestamp.
   */
  updateTrust(tripleId: number, delta: number): void {
    this.ensureLoaded();
    const row = this.db
      .prepare("SELECT trust_score, trust_updates FROM triples WHERE id = ?")
      .get(tripleId) as { trust_score: number; trust_updates: number } | undefined;

    if (!row) {
      throw new Error(`Triple not found: ${tripleId}`);
    }

    const newScore = Math.round(Math.max(0.0, Math.min(1.0, (row.trust_score ?? 0.5) + delta)) * 100) / 100;
    this.db
      .prepare(
        `UPDATE triples SET trust_score = ?, trust_updates = ?, last_feedback = ? WHERE id = ?`
      )
      .run(newScore, (row.trust_updates ?? 0) + 1, new Date().toISOString(), tripleId);
  }

  /**
   * Get all facts with trust_score below 0.3 (unverified).
   */
  getLowTrustFacts(): LowTrustFact[] {
    this.ensureLoaded();

    const rows = this.db
      .prepare(
        `SELECT t.id, s.name as subject_name, t.predicate, o.name as object_name,
                t.trust_score, t.trust_updates, t.project
         FROM triples t
         JOIN entities s ON t.subject = s.id
         JOIN entities o ON t.object = o.id
         WHERE t.trust_score < 0.3 AND t.valid_to IS NULL
         ORDER BY t.trust_score ASC`
      )
      .all() as any[];

    return rows.map((r) => ({
      triple_id: r.id,
      subject: r.subject_name,
      predicate: r.predicate,
      object: r.object_name,
      trust_score: r.trust_score ?? 0.5,
      trust_updates: r.trust_updates ?? 0,
      project: r.project,
    }));
  }

  /**
   * Record feedback on a fact's correctness.
   * Positive feedback (+0.1 trust), negative feedback (-0.15 trust).
   */
  knowledgeFeedback(tripleId: number, positive: boolean): void {
    this.ensureLoaded();
    const delta = positive ? 0.1 : -0.15;
    this.updateTrust(tripleId, delta);
  }

  /**
   * Run decay scan on the memory store.
   *
   * Phase 1: Archive memories that are old (maxAgeDays) AND low importance (minImportance).
   * Phase 2: Semantic dedup — merge near-duplicate memories using Jaccard text similarity.
   * Phase 3: Find expired facts (trust_score < 0.1 with trust_updates > 5).
   *
   * This is a soft archive — memories are marked archived=1 and hidden from
   * normal search/recall, but still exist in the database and can be restored.
   */
  decayScan(options?: {
    maxAgeDays?: number;
    minImportance?: number;
    semanticDedupThreshold?: number;
    lowTrustThreshold?: number;
    minTrustUpdates?: number;
  }): DecayScanResult {
    this.ensureLoaded();

    const maxAgeDays = options?.maxAgeDays ?? 180;
    const minImportance = options?.minImportance ?? 0.5;
    const semanticDedupThreshold = options?.semanticDedupThreshold ?? 0.92;
    const lowTrustThreshold = options?.lowTrustThreshold ?? 0.1;
    const minTrustUpdates = options?.minTrustUpdates ?? 5;

    const archived: { id: string; reason: string }[] = [];
    const merged: { into: string; from: string[]; similarity: number }[] = [];
    const expired_facts: { subject: string; predicate: string; object: string; trust_score: number }[] = [];

    // Phase 1: Archive old + low-importance memories
    const cutoffDate = new Date(
      Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    ).toISOString();

    const staleRows = this.db
      .prepare(
        `SELECT id, content, project, topic, importance, timestamp
         FROM memories
         WHERE archived = 0 AND importance < ? AND timestamp < ?
         ORDER BY timestamp ASC`
      )
      .all(minImportance, cutoffDate) as any[];

    const archiveTransaction = this.db.transaction(() => {
      for (const row of staleRows) {
        this.db
          .prepare(`UPDATE memories SET archived = 1 WHERE id = ?`)
          .run(row.id);
        archived.push({
          id: row.id,
          reason: `stale (${(row.timestamp || "").slice(0, 10)}) + low importance (${row.importance})`,
        });
      }
    });
    archiveTransaction();

    // Phase 2: Semantic dedup — merge near-duplicate memories
    // Uses Jaccard similarity on word tokens (fast, no model inference needed).
    // Groups by project to avoid cross-project comparisons.
    const dedupCandidates = this.db
      .prepare(
        `SELECT id, content, importance, project
         FROM memories
         WHERE archived = 0 AND LENGTH(content) > 50
         ORDER BY project, importance DESC`
      )
      .all() as { id: string; content: string; importance: number; project: string }[];

    // Group by project
    const byProject: Record<string, typeof dedupCandidates> = {};
    for (const row of dedupCandidates) {
      if (!byProject[row.project]) byProject[row.project] = [];
      byProject[row.project].push(row);
    }

    const alreadyMerged = new Set<string>();
    for (const [project, rows] of Object.entries(byProject)) {
      if (rows.length < 2) continue;

      // Compare each row with rows that follow it (importance-descending, so
      // earlier rows are the "keepers" with higher importance)
      for (let i = 0; i < rows.length - 1; i++) {
        if (alreadyMerged.has(rows[i].id)) continue;

        const a = rows[i];
        const mergedFrom: string[] = [];

        for (let j = i + 1; j < rows.length; j++) {
          if (alreadyMerged.has(rows[j].id)) continue;

          const b = rows[j];

          // Quick length check: if lengths differ by >2x, skip (unlikely to be similar)
          const lenRatio = Math.max(a.content.length, b.content.length) /
            Math.min(a.content.length, b.content.length);
          if (lenRatio > 2.0) continue;

          const similarity = jaccardSimilarity(a.content, b.content);
          if (similarity >= semanticDedupThreshold) {
            // Archive the lower-importance one
            this.db
              .prepare(`UPDATE memories SET archived = 1 WHERE id = ?`)
              .run(b.id);
            alreadyMerged.add(b.id);
            mergedFrom.push(b.id);
          }
        }

        if (mergedFrom.length > 0) {
          for (const mergedId of mergedFrom) {
            archived.push({
              id: mergedId,
              reason: `merged into ${a.id} (semantic dedup > ${semanticDedupThreshold})`,
            });
          }
          merged.push({
            into: a.id,
            from: mergedFrom,
            similarity: semanticDedupThreshold,
          });
        }
      }
    }

    // Phase 3: Find expired facts (low trust + many refutations)
    const expiredRows = this.db
      .prepare(
        `SELECT s.name as subject_name, t.predicate, o.name as object_name,
                t.trust_score
         FROM triples t
         JOIN entities s ON t.subject = s.id
         JOIN entities o ON t.object = o.id
         WHERE t.valid_to IS NULL
           AND t.trust_score < ?
           AND t.trust_updates > ?
         ORDER BY t.trust_score ASC`
      )
      .all(lowTrustThreshold, minTrustUpdates) as any[];

    for (const r of expiredRows) {
      expired_facts.push({
        subject: r.subject_name,
        predicate: r.predicate,
        object: r.object_name,
        trust_score: r.trust_score ?? 0.5,
      });
    }

    // Build summary
    // Count archived items that came from age-based archiving vs semantic dedup
    const mergeCount = merged.reduce((sum, m) => sum + m.from.length, 0);
    const staleCount = archived.length - mergeCount;

    const summaryLines: string[] = [`Decay scan complete.`];
    if (staleCount > 0) {
      summaryLines.push(`  Archived ${staleCount} stale memory(s) (older than ${maxAgeDays}d, importance < ${minImportance}).`);
    }
    if (mergeCount > 0) {
      summaryLines.push(`  Merged ${mergeCount} near-duplicate(s) into ${merged.length} cluster(s) (Jaccard > ${semanticDedupThreshold}).`);
    }
    if (staleCount === 0 && mergeCount === 0) {
      summaryLines.push(`  No stale memories found.`);
    }
    if (expired_facts.length > 0) {
      summaryLines.push(`  Flagged ${expired_facts.length} expired fact(s) (trust < ${lowTrustThreshold}, updates > ${minTrustUpdates}).`);
    } else {
      summaryLines.push(`  No expired facts found.`);
    }
    const summary = summaryLines.join("\n");

    return { archived, merged, expired_facts, summary };
  }

  /**
   * Invalidate a fact by setting valid_to.
   */
  invalidateTriple(tripleId: number, valid_to?: string): void {
    this.ensureLoaded();
    this.db
      .prepare(`UPDATE triples SET valid_to = ? WHERE id = ?`)
      .run(valid_to || new Date().toISOString(), tripleId);
  }

  /**
   * Get knowledge graph stats.
   */
  knowledgeStats(): KnowledgeStats {
    this.ensureLoaded();

    const entityCount = (
      this.db.prepare("SELECT COUNT(*) as cnt FROM entities").get() as any
    ).cnt;
    const tripleCount = (
      this.db.prepare("SELECT COUNT(*) as cnt FROM triples").get() as any
    ).cnt;
    const activeTriples = (
      this.db
        .prepare(
          "SELECT COUNT(*) as cnt FROM triples WHERE valid_to IS NULL"
        )
        .get() as any
    ).cnt;

    const entityTypes: Record<string, number> = {};
    const typeRows = this.db
      .prepare(
        "SELECT entity_type, COUNT(*) as cnt FROM entities GROUP BY entity_type"
      )
      .all() as any[];
    for (const r of typeRows) entityTypes[r.entity_type] = r.cnt;

    const predicates: Record<string, number> = {};
    const predRows = this.db
      .prepare(
        "SELECT predicate, COUNT(*) as cnt FROM triples GROUP BY predicate ORDER BY cnt DESC LIMIT 20"
      )
      .all() as any[];
    for (const r of predRows) predicates[r.predicate] = r.cnt;

    return {
      entityCount,
      tripleCount,
      activeTriples,
      entityTypes,
      predicates,
    };
  }

  // -----------------------------------------------------------------------
  // Utility
  // -----------------------------------------------------------------------

  private getStorageSizeKb(): number {
    try {
      if (fs.existsSync(this.dbPath)) {
        return Math.round((fs.statSync(this.dbPath).size / 1024) * 10) / 10;
      }
    } catch { /* ignore */ }
    return 0;
  }

  private countByProject(): Record<string, number> {
    return this.groupedCounts("project");
  }

  private groupedCounts(column: string): Record<string, number> {
    const result: Record<string, number> = {};
    const rows = this.db
      .prepare(`SELECT ${column}, COUNT(*) as cnt FROM memories WHERE archived = 0 GROUP BY ${column}`)
      .all() as Record<string, any>[];
    for (const r of rows) {
      result[r[column] || "general"] = r.cnt;
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // List Rooms / Taxonomy / Duplicate Check / Diary / KG Timeline
  // -----------------------------------------------------------------------

  /**
   * List topics (rooms) with counts, optionally filtered by project.
   */
  listRooms(project?: string): RoomInfo[] {
    this.ensureLoaded();

    let query: string;
    let params: any[];

    if (project) {
      query = `SELECT topic, COUNT(*) as cnt FROM memories
               WHERE project = ? AND archived = 0 GROUP BY topic ORDER BY cnt DESC`;
      params = [project];
    } else {
      query = `SELECT topic, COUNT(*) as cnt FROM memories
               WHERE archived = 0 GROUP BY topic ORDER BY cnt DESC`;
      params = [];
    }

    const rows = this.db.prepare(query).all(...params) as { topic: string; cnt: number }[];

    return rows.map((r) => {
      // Find which projects use this topic
      const projectRows = this.db
        .prepare(
          `SELECT DISTINCT project FROM memories WHERE topic = ? AND archived = 0`
        )
        .all(r.topic) as { project: string }[];

      return {
        topic: r.topic,
        count: r.cnt,
        projects: projectRows.map((p) => p.project),
      };
    });
  }

  /**
   * Full taxonomy: project → topics → counts.
   */
  getTaxonomy(): TaxonomyNode[] {
    this.ensureLoaded();

    const rows = this.db
      .prepare(
        `SELECT project, topic, COUNT(*) as cnt FROM memories
         WHERE archived = 0 GROUP BY project, topic ORDER BY project, cnt DESC`
      )
      .all() as { project: string; topic: string; cnt: number }[];

    const byProject: Record<string, { topic: string; count: number }[]> = {};
    const projectTotals: Record<string, number> = {};

    for (const r of rows) {
      if (!byProject[r.project]) {
        byProject[r.project] = [];
        projectTotals[r.project] = 0;
      }
      byProject[r.project].push({ topic: r.topic, count: r.cnt });
      projectTotals[r.project] += r.cnt;
    }

    return Object.entries(byProject)
      .sort(([, a], [, b]) => {
        const totalA = a.reduce((s, t) => s + t.count, 0);
        const totalB = b.reduce((s, t) => s + t.count, 0);
        return totalB - totalA;
      })
      .map(([project, topics]) => ({
        project,
        topics,
        total: projectTotals[project],
      }));
  }

  /**
   * Check if content already exists (by hash or semantic similarity).
   */
  async checkDuplicate(
    content: string,
    threshold: number = 0.9
  ): Promise<DuplicateCheckResult> {
    this.ensureLoaded();

    // 1. Exact hash match
    const cHash = contentHash(content);
    const hashRow = this.stmtFindByHash.get(cHash);
    if (hashRow) {
      return { isDuplicate: true, hashMatch: true, semanticMatch: null };
    }

    // 2. Semantic similarity check
    const searchResult = await this.search(content, { n_results: 1 });
    if (
      searchResult.results.length > 0 &&
      searchResult.results[0].similarity >= threshold
    ) {
      return {
        isDuplicate: true,
        hashMatch: false,
        semanticMatch: searchResult.results[0],
      };
    }

    return { isDuplicate: false, hashMatch: false, semanticMatch: null };
  }

  /**
   * Write a diary entry. Stored as a memory with topic="diary" and source="diary".
   */
  async diaryWrite(input: {
    agent_name: string;
    entry: string;
    topic?: string;
    project?: string;
  }): Promise<StoreResult> {
    return this.store({
      content: input.entry,
      project: input.project || `diary-${input.agent_name.toLowerCase().replace(/\s+/g, "_")}`,
      topic: input.topic || "diary",
      source: "diary",
      importance: 0.7,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Read recent diary entries for an agent, in chronological order.
   */
  diaryRead(input: {
    agent_name: string;
    last_n?: number;
    project?: string;
  }): SearchResult[] {
    this.ensureLoaded();

    const project = input.project || `diary-${input.agent_name.toLowerCase().replace(/\s+/g, "_")}`;
    const limit = Math.min(input.last_n || 10, 100);

    const rows = this.db
      .prepare(
        `SELECT id, content, project, topic, source, timestamp
         FROM memories
         WHERE project = ? AND source = 'diary' AND archived = 0
         ORDER BY timestamp ASC
         LIMIT ?`
      )
      .all(project, limit) as MemoryRow[];

    return rows.map((row) => ({
      id: row.id,
      text: row.content,
      project: row.project,
      topic: row.topic,
      source: row.source,
      timestamp: row.timestamp,
      similarity: 0,
    }));
  }

  /**
   * Knowledge graph timeline: chronological list of facts for an entity (or all).
   */
  kgTimeline(entity?: string): TimelineFact[] {
    this.ensureLoaded();

    let query: string;
    let params: any[];

    const selectTrust = `t.id, t.predicate, t.valid_from, t.valid_to, t.confidence,
               t.trust_score, t.trust_updates, t.project, t.created_at,
               s.name as subject_name, o.name as object_name`;

    if (entity) {
      const entityId = `ent_${contentHash(entity.toLowerCase())}`;
      query = `
        SELECT ${selectTrust}
        FROM triples t
        JOIN entities s ON t.subject = s.id
        JOIN entities o ON t.object = o.id
        WHERE t.subject = ? OR t.object = ?
        ORDER BY COALESCE(t.valid_from, t.created_at) ASC`;
      params = [entityId, entityId];
    } else {
      query = `
        SELECT ${selectTrust}
        FROM triples t
        JOIN entities s ON t.subject = s.id
        JOIN entities o ON t.object = o.id
        ORDER BY COALESCE(t.valid_from, t.created_at) ASC`;
      params = [];
    }

    const rows = this.db.prepare(query).all(...params) as any[];

    return rows.map((r) => ({
      id: r.id,
      subject: r.subject_name,
      predicate: r.predicate,
      object: r.object_name,
      valid_from: r.valid_from,
      valid_to: r.valid_to,
      confidence: r.confidence,
      trust_score: r.trust_score ?? 0.5,
      trust_updates: r.trust_updates ?? 0,
      project: r.project,
      created_at: r.created_at,
    }));
  }

  /**
   * Find a triple by subject/predicate/object names (for invalidation by name).
   */
  findTriple(subject: string, predicate: string, object: string): number | null {
    this.ensureLoaded();

    const subjectId = `ent_${contentHash(subject.toLowerCase())}`;
    const objectId = `ent_${contentHash(object.toLowerCase())}`;

    const row = this.db
      .prepare(
        `SELECT id FROM triples
         WHERE subject = ? AND predicate = ? AND object = ?
         AND valid_to IS NULL
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(subjectId, predicate, objectId) as { id: number } | undefined;

    return row ? row.id : null;
  }

  /** Get total memory count. */
  get size(): number {
    this.ensureLoaded();
    return this.countAll();
  }

  /** Check if a memory exists by ID. */
  has(id: string): boolean {
    this.ensureLoaded();
    return !!this.stmtHasId.get(id);
  }
}
