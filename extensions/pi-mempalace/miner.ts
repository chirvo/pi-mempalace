/**
 * miner.ts — File and conversation mining for pi-mempalace.
 *
 * Ported and adapted from @sinamtz/pi-mempalace.
 *
 * Provides:
 *   - mineDirectory: scan a directory, chunk files, store as memories
 *   - mineConversation: parse conversation transcripts, store as memories
 *   - scanDirectory: recursive file traversal with filtering
 *   - loadIgnorePatterns: parse .gitignore into an Ignore instance
 *
 * All operations respect .gitignore, skip binary files, and handle
 * hidden files/directories. Designed to work with the MemoryStore API.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import ignore from "ignore";
import { chunkByParagraphs, chunkConversation } from "./chunker.js";
import type { Chunk } from "./chunker.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** File mining options */
export interface FileMinerOptions {
  /** Directory to mine */
  directory: string;
  /** Wing/project assignment */
  wing?: string;
  /** Source identifier for mined memories */
  source?: string;
  /** Maximum file size to process (bytes). Default: 1MB */
  maxFileSize?: number;
  /** File extensions to process. Default: common source extensions */
  extensions?: string[];
  /** Whether to follow symlinks. Default: false */
  followSymlinks?: boolean;
  /** Store callback: if provided, each chunk is stored. If null, returns chunks only. */
  store?: ((memories: Array<{
    content: string;
    project: string;
    topic: string;
    source: string;
  }>) => Promise<unknown>) | null;
}

/** File mining result */
export interface FileMiningResult {
  filesScanned: number;
  filesProcessed: number;
  filesSkipped: number;
  chunksCreated: number;
  memoriesStored: number;
  errors: Array<{ file: string; error: string }>;
  skippedFiles: Array<{ file: string; reason: string }>;
}

/** Conversation mining options */
export interface ConvoMinerOptions {
  /** The conversation text to mine */
  text: string;
  /** Wing/project assignment */
  wing?: string;
  /** Source identifier */
  source?: string;
  /** Minimum exchange length to consider valid */
  minExchangeLength?: number;
  /** Chunking mode: 'exchanges' (default) or 'paragraphs' */
  mode?: "exchanges" | "paragraphs";
  /** Store callback: if provided, each chunk is stored. If null, returns chunks only. */
  store?: ((memories: Array<{
    content: string;
    project: string;
    topic: string;
    source: string;
  }>) => Promise<unknown>) | null;
}

/** Conversation mining result */
export interface ConvoMiningResult {
  exchangesFound: number;
  chunksCreated: number;
  memoriesStored: number;
  detectedRoom: string;
  assignedWing: string;
  errors: Array<{ exchange: number; error: string }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default file extensions to process */
const DEFAULT_EXTENSIONS = [
  ".ts", ".js", ".jsx", ".tsx", ".mjs", ".cjs",
  ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".sh", ".bash", ".zsh", ".py", ".rs", ".go", ".java", ".kt", ".scala",
  ".c", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php", ".swift",
  ".css", ".scss", ".less", ".html", ".svelte", ".vue",
  ".graphql", ".proto", ".sql",
];

/** Default maximum file size (1MB) */
const DEFAULT_MAX_FILE_SIZE = 1024 * 1024;

/** Binary file magic byte signatures */
const BINARY_SIGNATURES: Array<{ magic: number[]; offset?: number }> = [
  { magic: [0x89, 0x50, 0x4e, 0x47] },        // PNG
  { magic: [0xff, 0xd8, 0xff] },               // JPEG
  { magic: [0x47, 0x49, 0x46] },               // GIF
  { magic: [0x50, 0x4b, 0x03, 0x04] },         // ZIP
  { magic: [0x50, 0x4b, 0x05, 0x06] },         // ZIP empty
  { magic: [0x50, 0x4b, 0x07, 0x08] },         // ZIP spanned
  { magic: [0xca, 0xfe, 0xba, 0xbe] },         // Java class
  { magic: [0x7f, 0x45, 0x4c, 0x46] },         // ELF
  { magic: [0x4d, 0x5a] },                      // PE/EXE
  { magic: [0x25, 0x50, 0x44, 0x46] },         // PDF
];

/** Directories always skipped */
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "target",
  ".next", ".nuxt", ".cache", "coverage",
  ".nyc_output", ".git", ".svn", ".hg",
  "vendor", ".bundle", "tmp",
]);

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

/**
 * Check if a file is binary by reading its first bytes.
 * Checks for null bytes (text file indicator) and magic byte signatures.
 */
function isBinaryFile(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(8192);
      const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0);

      // Check for null bytes
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0) {
          return true;
        }
      }

      // Check magic signatures
      for (const { magic, offset = 0 } of BINARY_SIGNATURES) {
        let match = true;
        for (let i = 0; i < magic.length; i++) {
          if (buffer[offset + i] !== magic[i]) {
            match = false;
            break;
          }
        }
        if (match) return true;
      }

      return false;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return true; // Assume binary if can't read
  }
}

// ---------------------------------------------------------------------------
// .gitignore loading
// ---------------------------------------------------------------------------

/**
 * Load and parse .gitignore patterns.
 * Returns an Ignore instance with both file patterns and default ignores.
 */
export function loadIgnorePatterns(directory: string): ReturnType<typeof ignore> {
  const ig = ignore();

  try {
    const gitignorePath = path.join(directory, ".gitignore");
    const content = fs.readFileSync(gitignorePath, "utf-8");
    const patterns = content
      .split("\n")
      .map(l => l.trim())
      .filter(line => line && !line.startsWith("#"));
    ig.add(patterns);
  } catch {
    // No .gitignore — proceed with defaults
  }

  // Always ignore these patterns
  ig.add([
    "node_modules", ".git", "dist", "build", "target",
    ".next", ".nuxt", ".cache", "coverage", ".nyc_output",
    ".svn", ".hg", "vendor", ".bundle", "tmp",
    "*.pyc", "*.pyo", "*.class", "*.o", "*.obj", "*.dll", "*.so", "*.dylib",
  ]);

  return ig;
}

// ---------------------------------------------------------------------------
// Directory scanning
// ---------------------------------------------------------------------------

/**
 * Scan directory recursively for files to process.
 * Returns absolute file paths that passed all filters.
 */
export function scanDirectory(
  rootDir: string,
  currentDir: string,
  ig: ReturnType<typeof ignore> | null,
  options: {
    extensions: string[];
    maxFileSize: number;
    followSymlinks: boolean;
  },
): string[] {
  const files: string[] = [];

  try {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);

      // Check ignore patterns
      const ignorePath = entry.isDirectory() ? relativePath + "/" : relativePath;
      if (ig && ig.ignores(ignorePath)) {
        continue;
      }

      // Handle directories
      if (entry.isDirectory()) {
        // Skip hidden directories
        if (entry.name.startsWith(".")) continue;
        // Skip common non-source directories
        if (SKIP_DIRS.has(entry.name)) continue;

        const subFiles = scanDirectory(rootDir, fullPath, ig, options);
        files.push(...subFiles);
        continue;
      }

      // Handle files
      if (!entry.isFile() && !(options.followSymlinks && entry.isSymbolicLink())) continue;

      // Skip hidden files
      if (entry.name.startsWith(".")) continue;

      // Check extension
      const ext = path.extname(entry.name).toLowerCase();
      if (options.extensions.length > 0 && !options.extensions.includes(ext)) continue;

      // Check file size
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > options.maxFileSize) continue;
      } catch {
        continue;
      }

      files.push(fullPath);
    }
  } catch {
    // Permission denied, etc. — skip this directory
  }

  return files;
}

// ---------------------------------------------------------------------------
// Topic detection (simple file-path-based)
// ---------------------------------------------------------------------------

/**
 * Detect a topic from file path and content.
 * Uses file extension + directory as a heuristic.
 */
function detectTopicFromPath(filePath: string, _content: string): string {
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  const dir = path.basename(path.dirname(filePath)).toLowerCase();

  // Map extensions to topics
  const topicMap: Record<string, string> = {
    ts: "typescript",
    tsx: "react",
    js: "javascript",
    jsx: "react",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    md: "documentation",
    sql: "database",
    css: "styling",
    scss: "styling",
    html: "markup",
    json: "configuration",
    yaml: "configuration",
    yml: "configuration",
    sh: "shell",
    graphql: "api",
    proto: "api",
  };

  const fromExt = topicMap[ext];
  if (fromExt) return fromExt;

  // Fall back to directory-based topic
  const dirTopicMap: Record<string, string> = {
    src: "source",
    lib: "source",
    test: "testing",
    tests: "testing",
    docs: "documentation",
    config: "configuration",
    api: "api",
    db: "database",
    components: "components",
    pages: "pages",
    styles: "styling",
  };

  return dirTopicMap[dir] || "code";
}

// ---------------------------------------------------------------------------
// mineDirectory
// ---------------------------------------------------------------------------

/**
 * Mine a directory recursively.
 *
 * Scans the directory, chunks files by paragraphs, generates topics,
 * and optionally stores memories via the provided store callback.
 *
 * @param options - Mining options.
 * @returns Mining result with statistics.
 */
export function mineDirectory(options: FileMinerOptions): FileMiningResult {
  const {
    directory,
    wing: explicitWing,
    source,
    maxFileSize = DEFAULT_MAX_FILE_SIZE,
    extensions = DEFAULT_EXTENSIONS,
    followSymlinks = false,
    store,
  } = options;

  const result: FileMiningResult = {
    filesScanned: 0,
    filesProcessed: 0,
    filesSkipped: 0,
    chunksCreated: 0,
    memoriesStored: 0,
    errors: [],
    skippedFiles: [],
  };

  const resolvedDir = path.resolve(directory);

  // Load gitignore
  let ig: ReturnType<typeof ignore> | null = null;
  try {
    ig = loadIgnorePatterns(resolvedDir);
  } catch {
    ig = null;
  }

  // Determine project/wing
  const project = explicitWing || path.basename(resolvedDir);

  // Scan directory
  const rawFiles = scanDirectory(resolvedDir, resolvedDir, ig, {
    extensions,
    maxFileSize,
    followSymlinks,
  });

  result.filesScanned = rawFiles.length;

  // Process files
  const allMemories: Array<{ content: string; project: string; topic: string; source: string }> = [];

  for (const filePath of rawFiles) {
    const relativePath = path.relative(resolvedDir, filePath);
    const fileSource = source
      ? `${source}:${relativePath}`
      : `file-mining:${relativePath}`;

    try {
      // Check if binary (before reading full content)
      if (isBinaryFile(filePath)) {
        result.filesSkipped++;
        result.skippedFiles.push({ file: relativePath, reason: "binary file" });
        continue;
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const topic = detectTopicFromPath(filePath, content);

      // Chunk the file
      const chunks = chunkByParagraphs(content, fileSource);

      if (chunks.length === 0) {
        result.filesSkipped++;
        result.skippedFiles.push({ file: relativePath, reason: "no chunks produced" });
        continue;
      }

      // Add each chunk
      for (const chunk of chunks) {
        allMemories.push({
          content: chunk.text,
          project,
          topic,
          source: fileSource,
        });
      }

      result.filesProcessed++;
      result.chunksCreated += chunks.length;
    } catch (err) {
      result.errors.push({
        file: relativePath,
        error: String(err),
      });
      result.filesSkipped++;
      result.skippedFiles.push({ file: relativePath, reason: `error: ${String(err)}` });
    }
  }

  // Store via callback if provided
  if (store && allMemories.length > 0) {
    // Process in batches of 10 to avoid overwhelming the store
    const BATCH_SIZE = 10;
    for (let i = 0; i < allMemories.length; i += BATCH_SIZE) {
      const batch = allMemories.slice(i, i + BATCH_SIZE);
      store(batch).catch((err) => {
        result.errors.push({
          file: "batch",
          error: `Store batch failed: ${String(err)}`,
        });
      });
    }
    result.memoriesStored = allMemories.length;
  }

  return result;
}

// ---------------------------------------------------------------------------
// mineConversation
// ---------------------------------------------------------------------------

/**
 * Mine a conversation transcript.
 *
 * Parses the conversation into Q+A exchange pairs (or paragraphs),
 * detects the appropriate room, and optionally stores memories.
 *
 * @param options - Mining options.
 * @returns Mining result with statistics.
 */
export async function mineConversation(options: ConvoMinerOptions): Promise<ConvoMiningResult> {
  const {
    text,
    wing: explicitWing,
    source = "conversation",
    minExchangeLength = 10,
    mode = "exchanges",
    store,
  } = options;

  if (!text || !text.trim()) {
    return {
      exchangesFound: 0,
      chunksCreated: 0,
      memoriesStored: 0,
      detectedRoom: "general",
      assignedWing: explicitWing || "general",
      errors: [],
    };
  }

  // Chunk based on mode
  let chunks: Chunk[];
  if (mode === "exchanges") {
    chunks = chunkConversation(text, source);
  } else {
    chunks = chunkByParagraphs(text, source);
  }

  // Filter by minimum length
  chunks = chunks.filter(c => c.text.length >= minExchangeLength);

  if (chunks.length === 0) {
    return {
      exchangesFound: 0,
      chunksCreated: 0,
      memoriesStored: 0,
      detectedRoom: "general",
      assignedWing: explicitWing || "general",
      errors: [],
    };
  }

  const wing = explicitWing || "general";
  const room = "general";

  // Build memory inputs
  const memories = chunks.map((chunk) => ({
    content: chunk.text,
    project: wing,
    topic: room,
    source: `${source}:exchange:${chunk.index}`,
  }));

  // Store via callback if provided
  let memoriesStored = 0;
  const errors: Array<{ exchange: number; error: string }> = [];

  if (store && memories.length > 0) {
    try {
      await store(memories);
      memoriesStored = memories.length;
    } catch (err) {
      errors.push({ exchange: -1, error: String(err) });
    }
  }

  return {
    exchangesFound: chunks.length,
    chunksCreated: chunks.length,
    memoriesStored,
    detectedRoom: room,
    assignedWing: wing,
    errors,
  };
}
