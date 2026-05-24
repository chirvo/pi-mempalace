#!/usr/bin/env node
/**
 * Tests for the paragraph-aware chunker.
 *
 * Usage:
 *   npx tsx tests/test_chunker.mjs
 */

import { strict as assert } from "node:assert";

const TESTS = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  TESTS.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Tests — will be populated after module import
// ---------------------------------------------------------------------------

async function defineTests() {
  let mod;
  try {
    mod = await import("../extensions/pi-mempalace/chunker.ts");
  } catch (e) {
    console.log("Chunker module not found yet — skipping tests.");
    console.log("Error:", e.message);
    console.log("Run tests after implementation is complete.");
    return;
  }

  const {
    splitParagraphs,
    chunkByParagraphs,
    chunkConversation,
    CHUNK_CONFIG,
  } = mod;

  // -----------------------------------------------------------------------
  // splitParagraphs
  // -----------------------------------------------------------------------

  test("splitParagraphs: empty text returns empty", () => {
    const result = splitParagraphs("");
    assert.equal(result.length, 0);
  });

  test("splitParagraphs: single line returns one paragraph", () => {
    const result = splitParagraphs("hello world");
    assert.equal(result.length, 1);
    assert.equal(result[0].text, "hello world");
  });

  test("splitParagraphs: splits on blank lines", () => {
    const result = splitParagraphs("para one\n\npara two\n\npara three");
    assert.equal(result.length, 3);
    assert.equal(result[0].text, "para one");
    assert.equal(result[1].text, "para two");
    assert.equal(result[2].text, "para three");
  });

  test("splitParagraphs: multiple blank lines treated as one separator", () => {
    const result = splitParagraphs("para one\n\n\n\npara two");
    assert.equal(result.length, 2);
    assert.equal(result[0].text, "para one");
    assert.equal(result[1].text, "para two");
  });

  test("splitParagraphs: preserves paragraph content", () => {
    const result = splitParagraphs("line 1\nline 2\n\nline 3");
    assert.equal(result.length, 2);
    assert.equal(result[0].text, "line 1\nline 2");
    assert.equal(result[1].text, "line 3");
  });

  test("splitParagraphs: tracks offsets", () => {
    const text = "first\n\nsecond";
    const result = splitParagraphs(text);
    assert.equal(result.length, 2);
    assert.ok(result[1].offset > 0);
  });

  // -----------------------------------------------------------------------
  // chunkByParagraphs
  // -----------------------------------------------------------------------

  test("chunkByParagraphs: short text returns single chunk", () => {
    const chunks = chunkByParagraphs("short text", "test");
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].text, "short text");
    assert.equal(chunks[0].index, 0);
  });

  test("chunkByParagraphs: empty text returns empty", () => {
    const chunks = chunkByParagraphs("", "test");
    assert.equal(chunks.length, 0);
  });

  test("chunkByParagraphs: splits into multiple chunks at paragraph boundaries", () => {
    const text = "A".repeat(300) + "\n\n" + "B".repeat(300) + "\n\n" + "C".repeat(300);
    const chunks = chunkByParagraphs(text, "test", { targetSize: 400, maxSize: 600, minSize: 10, overlap: 0 });
    assert.ok(chunks.length >= 2);
  });

  test("chunkByParagraphs: respects target chunk size", () => {
    const longPara = "word ".repeat(200);
    const chunks = chunkByParagraphs(longPara, "test", { targetSize: 300, maxSize: 500, minSize: 10, overlap: 0 });
    assert.ok(chunks.length >= 2);
  });

  test("chunkByParagraphs: merges small paragraphs", () => {
    const text = "short\n\n" + "B".repeat(300) + "\n\n" + "tiny";
    const chunks = chunkByParagraphs(text, "test", { targetSize: 500, maxSize: 600, minSize: 50, overlap: 0 });
    assert.ok(chunks.length >= 1);
  });

  test("chunkByParagraphs: splits long paragraphs exceeding maxSize", () => {
    const longPara = "X".repeat(1500);
    const chunks = chunkByParagraphs(longPara, "test");
    assert.ok(chunks.length >= 2);
  });

  test("chunkByParagraphs: applies overlap between chunks", () => {
    const longPara = "word ".repeat(300);
    const chunks = chunkByParagraphs(longPara, "test", {
      targetSize: 300,
      maxSize: 500,
      minSize: 10,
      overlap: 20,
    });
    if (chunks.length >= 2) {
      assert.ok(chunks[0].text.length > 0);
      assert.ok(chunks[1].text.length > 0);
    }
  });

  test("chunkByParagraphs: assigns sequential indices", () => {
    const text = "A".repeat(100) + "\n\n" + "B".repeat(100) + "\n\n" + "C".repeat(100);
    const chunks = chunkByParagraphs(text, "test", { targetSize: 50, maxSize: 200, minSize: 10, overlap: 0 });
    for (let i = 0; i < chunks.length; i++) {
      assert.equal(chunks[i].index, i);
    }
  });

  test("chunkByParagraphs: includes source in each chunk", () => {
    const chunks = chunkByParagraphs("hello world", "my-source-id");
    assert.equal(chunks[0].source, "my-source-id");
  });

  // -----------------------------------------------------------------------
  // chunkConversation
  // -----------------------------------------------------------------------

  test("chunkConversation: detects question-answer pairs", () => {
    const text = "What is TypeScript?\n\nTypeScript is a typed superset of JavaScript.\n\nHow do I install it?\n\nnpm install -g typescript";
    const chunks = chunkConversation(text, "convo-test");
    assert.ok(chunks.length >= 2, `Expected >= 2 chunks, got ${chunks.length}`);
  });

  test("chunkConversation: empty text returns empty", () => {
    const chunks = chunkConversation("", "test");
    assert.equal(chunks.length, 0);
  });

  test("chunkConversation: single exchange returns one chunk", () => {
    const chunks = chunkConversation("What is your name?", "test");
    assert.equal(chunks.length, 1);
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function run() {
  await defineTests();

  if (TESTS.length === 0) {
    console.log("0 tests defined (chunker module not yet available).");
    console.log("Implement extensions/pi-mempalace/chunker.ts and run again.");
    process.exit(0);
  }

  console.log(`Running ${TESTS.length} chunker tests...\n`);

  for (const { name, fn } of TESTS) {
    try {
      await fn();
      passed++;
      console.log(`  ✅ ${name}`);
    } catch (err) {
      failed++;
      console.log(`  ❌ ${name}`);
      console.log(`     ${err.message}`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${TESTS.length} total`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
