/**
 * chunker.ts — Text chunking with paragraph awareness.
 *
 * Ported and adapted from @sinamtz/pi-mempalace.
 *
 * Chunks text by paragraph boundaries while respecting configurable
 * size limits. Handles long paragraphs by splitting them. Merges
 * tiny paragraphs with neighbors. Supports configurable overlap.
 *
 * Used by both file mining and conversation mining.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default chunk configuration */
export const CHUNK_CONFIG = {
  /** Target number of characters per chunk */
  TARGET_CHUNK_SIZE: 512,
  /** Maximum characters per chunk (hard limit) */
  MAX_CHUNK_SIZE: 1024,
  /** Minimum characters for a valid chunk */
  MIN_CHUNK_SIZE: 10,
  /** Overlap between chunks in characters */
  CHUNK_OVERLAP: 64,
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A chunk of text with metadata */
export interface Chunk {
  /** The text content */
  text: string;
  /** Character offset in the original source */
  offset: number;
  /** Length of the chunk */
  length: number;
  /** Index of this chunk in the document */
  index: number;
  /** Source identifier */
  source: string;
}

/** Options for chunking operations */
export interface ChunkOptions {
  /** Target chunk size in characters */
  targetSize?: number;
  /** Maximum chunk size */
  maxSize?: number;
  /** Minimum chunk size */
  minSize?: number;
  /** Overlap between chunks */
  overlap?: number;
}

// ---------------------------------------------------------------------------
// Paragraph splitting
// ---------------------------------------------------------------------------

/**
 * Split text into paragraphs by blank line separation.
 *
 * A paragraph is a block of text separated by one or more blank lines
 * (lines containing only whitespace).
 *
 * @param text - The text to split into paragraphs.
 * @returns Array of paragraphs with their offsets.
 */
export function splitParagraphs(text: string): Array<{ text: string; offset: number }> {
  if (!text.trim()) return [];

  const paragraphs: Array<{ text: string; offset: number }> = [];
  const lines = text.split("\n");
  let currentParagraph = "";
  let currentOffset = 0;
  let inParagraph = false;
  let globalIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    if (trimmedLine === "") {
      // Blank line — end current paragraph if non-empty
      if (currentParagraph.length > 0) {
        paragraphs.push({
          text: currentParagraph.trim(),
          offset: currentOffset,
        });
        currentParagraph = "";
        inParagraph = false;
      }
      globalIndex += line.length + 1;
    } else {
      // Non-blank line — add to current paragraph
      if (!inParagraph) {
        currentOffset = globalIndex;
        inParagraph = true;
      }
      currentParagraph += (currentParagraph.length > 0 ? "\n" : "") + line;
      globalIndex += line.length + 1;
    }
  }

  // Don't forget the last paragraph
  if (currentParagraph.trim().length > 0) {
    paragraphs.push({
      text: currentParagraph.trim(),
      offset: currentOffset,
    });
  }

  return paragraphs;
}

// ---------------------------------------------------------------------------
// Small paragraph merging
// ---------------------------------------------------------------------------

/**
 * Merge small paragraphs into the next chunk to avoid trivial fragments.
 */
function mergeSmallParagraphs(
  paragraphs: Array<{ text: string; offset: number }>,
  minSize: number,
): Array<{ text: string; offset: number }> {
  if (paragraphs.length <= 1) return paragraphs;

  const merged: Array<{ text: string; offset: number }> = [];
  let current = { ...paragraphs[0] };

  for (let i = 1; i < paragraphs.length; i++) {
    const next = paragraphs[i];

    // If current is too small, merge with next
    if (current.text.length < minSize) {
      current = {
        text: `${current.text}\n${next.text}`,
        offset: current.offset,
      };
    } else {
      merged.push(current);
      current = { ...next };
    }
  }

  merged.push(current);
  return merged;
}

// ---------------------------------------------------------------------------
// Main chunking function
// ---------------------------------------------------------------------------

/**
 * Chunk text by paragraphs, respecting size limits.
 *
 * Groups paragraphs together until the target chunk size is reached,
 * then starts a new chunk. Handles edge cases:
 * - Very long paragraphs are split into sub-chunks
 * - Small paragraphs are merged with neighbors to avoid fragments
 *
 * @param text - The text to chunk.
 * @param source - Source identifier for the chunks.
 * @param options - Chunking options.
 * @returns Array of chunks with metadata.
 */
export function chunkByParagraphs(text: string, source: string, options: ChunkOptions = {}): Chunk[] {
  const {
    targetSize = CHUNK_CONFIG.TARGET_CHUNK_SIZE,
    maxSize = CHUNK_CONFIG.MAX_CHUNK_SIZE,
    minSize = CHUNK_CONFIG.MIN_CHUNK_SIZE,
    overlap = CHUNK_CONFIG.CHUNK_OVERLAP,
  } = options;

  if (!text || !text.trim()) return [];

  // Split into paragraphs
  let paragraphs = splitParagraphs(text);

  // Merge tiny paragraphs
  paragraphs = mergeSmallParagraphs(paragraphs, minSize);

  if (paragraphs.length === 0) {
    return [];
  }

  const chunks: Chunk[] = [];
  let currentChunk = "";
  let currentOffset = 0;
  let currentIndex = 0;

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    const paraLen = para.text.length;

    // Handle very long paragraphs (exceeding maxSize)
    if (paraLen > maxSize) {
      // Save current chunk if non-empty
      if (currentChunk.length >= minSize) {
        chunks.push({
          text: currentChunk.trim(),
          offset: currentOffset,
          length: currentChunk.trim().length,
          index: currentIndex++,
          source,
        });

        // Apply overlap
        if (chunks.length > 0 && overlap > 0) {
          const lastChunk = chunks[chunks.length - 1].text;
          const overlapText = lastChunk.slice(-Math.min(overlap, lastChunk.length));
          currentChunk = `${overlapText}\n${para.text.slice(0, Math.floor(overlap / 2))}`;
          currentOffset = para.offset;
        } else {
          currentChunk = "";
          currentOffset = 0;
        }
      }

      // Split long paragraph into sub-chunks
      let start = 0;
      while (start < paraLen) {
        const end = Math.min(start + targetSize, paraLen);
        const subText = para.text.slice(start, end).trim();

        if (subText.length >= minSize) {
          chunks.push({
            text: subText,
            offset: para.offset + start,
            length: subText.length,
            index: currentIndex++,
            source,
          });
        }

        // Break if we've reached the end
        if (end >= paraLen) break;

        start = end - overlap;
        if (start <= end - targetSize) start = end; // Prevent going backwards
        if (start < 0) start = end;
      }

      currentChunk = "";
      currentOffset = 0;
      continue;
    }

    // Check if adding this paragraph exceeds target
    if (currentChunk.length + paraLen > targetSize && currentChunk.length >= minSize) {
      // Save current chunk
      chunks.push({
        text: currentChunk.trim(),
        offset: currentOffset,
        length: currentChunk.trim().length,
        index: currentIndex++,
        source,
      });

      // Apply overlap
      if (overlap > 0 && currentChunk.length > overlap) {
        const overlapText = currentChunk.slice(-overlap);
        currentChunk = `${overlapText}\n${para.text}`;
        currentOffset = currentOffset + currentChunk.length - paraLen - overlap;
      } else {
        currentChunk = para.text;
        currentOffset = para.offset;
      }
    } else {
      // Add to current chunk
      if (currentChunk.length === 0) {
        currentChunk = para.text;
        currentOffset = para.offset;
      } else {
        currentChunk += `\n${para.text}`;
      }
    }
  }

  // Don't forget the last chunk
  if (currentChunk.trim().length >= minSize) {
    chunks.push({
      text: currentChunk.trim(),
      offset: currentOffset,
      length: currentChunk.trim().length,
      index: currentIndex,
      source,
    });
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Conversation chunking
// ---------------------------------------------------------------------------

/** A parsed conversation pair */
interface ConversationPair {
  text: string;
  offset: number;
}

/**
 * Detect if a line marks the start of a new exchange.
 */
function detectExchangeStart(line: string, prevLine: string): boolean {
  if (line.length === 0) return false;

  // Empty previous line often indicates a new exchange
  if (prevLine.length === 0) return true;

  // Question indicators
  const questionPatterns = [
    /^[A-Z][^.!?]*[?]$/,
    /^(what|who|where|when|why|how|which|can|could|would|should|is|are|do|does|did)\s/i,
    /^(user|human|me|my|i)\s*:/i,
  ];

  for (const pattern of questionPatterns) {
    if (pattern.test(line)) return true;
  }

  // Message separator patterns
  const separatorPatterns = [
    /^\d{1,2}:\d{2}/,
    /^\[\d{1,2}:\d{2}/,
    /^(human|user|assistant|bot|agent|system):\s*/i,
    /^---+$/,
  ];

  for (const pattern of separatorPatterns) {
    if (pattern.test(line)) return true;
  }

  // If previous line was long and this is short, might be a new exchange
  if (prevLine.length > 80 && line.length < 80 && line.length > 0) {
    const responsePatterns = [
      /^[A-Z]/,
      /^(yes|no|sure|okay|ok|indeed|certainly|absolutely|definitely)/i,
      /^(here|there|this|that|the|to|and|in|on|with|for|of|a|an)/i,
    ];

    for (const pattern of responsePatterns) {
      if (pattern.test(line)) return true;
    }
  }

  return false;
}

/**
 * Parse conversation text into question-answer pairs.
 */
function parseConversationPairs(text: string): ConversationPair[] {
  const pairs: ConversationPair[] = [];
  const lines = text.split("\n");

  let currentPair = "";
  let currentOffset = 0;
  let inExchange = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    const prevLine = i > 0 ? lines[i - 1].trim() : "";
    const isNewExchange = detectExchangeStart(trimmed, prevLine);

    if (isNewExchange && inExchange && currentPair.trim().length > 0) {
      // Save previous pair
      pairs.push({
        text: currentPair.trim(),
        offset: currentOffset,
      });

      // Start new pair
      currentPair = trimmed;
      currentOffset = text.indexOf(line);
      inExchange = true;
    } else if (isNewExchange && !inExchange) {
      // First exchange
      currentPair = trimmed;
      currentOffset = text.indexOf(line);
      inExchange = true;
    } else if (inExchange) {
      // Continue current pair
      currentPair += `\n${trimmed}`;
    }
  }

  // Don't forget the last pair
  if (currentPair.trim().length > 0) {
    pairs.push({
      text: currentPair.trim(),
      offset: currentOffset,
    });
  }

  return pairs;
}

/**
 * Split conversation text into Q+A exchange pairs.
 *
 * Identifies question-answer pairs by looking for common question
 * indicators and response patterns. Returns each pair as a single chunk.
 *
 * @param text - The conversation text to split.
 * @param source - Source identifier.
 * @returns Array of conversation chunks.
 */
export function chunkConversation(text: string, source: string): Chunk[] {
  if (!text || !text.trim()) return [];

  const exchanges = parseConversationPairs(text);

  return exchanges.map((exchange, index) => ({
    text: exchange.text.trim(),
    offset: exchange.offset,
    length: exchange.text.trim().length,
    index,
    source,
  }));
}
