#!/usr/bin/env node
/**
 * Tests for the modular refactor of MemoryStore.
 *
 * Validates:
 *   - MemoryStore still works after splitting into modules
 *   - Notification tracker for first-time auto-capture
 *
 * Usage:
 *   npx tsx tests/test_modular_refactor.mjs
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { strict as assert } from "node:assert";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const TESTS = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  TESTS.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Imports from production code
// ---------------------------------------------------------------------------

let CaptureNotifier;
let contentHash;

async function loadProductionCode() {
  const notifier = await import("../extensions/pi-mempalace/notifier.ts");
  const utils = await import("../extensions/pi-mempalace/utils.ts");
  CaptureNotifier = notifier.CaptureNotifier;
  contentHash = utils.contentHash;
}

// ---------------------------------------------------------------------------
// Tests: First-capture notification
// ---------------------------------------------------------------------------

test("CaptureNotifier: starts un-notified", () => {
  const n = new CaptureNotifier();
  assert.equal(n.hasNotified, false);
});

test("CaptureNotifier: first mark returns true", () => {
  const n = new CaptureNotifier();
  assert.equal(n.markNotified(), true);
  assert.equal(n.hasNotified, true);
});

test("CaptureNotifier: second mark returns false", () => {
  const n = new CaptureNotifier();
  n.markNotified();
  assert.equal(n.markNotified(), false);
  assert.equal(n.hasNotified, true);
});

test("CaptureNotifier: reset restores state", () => {
  const n = new CaptureNotifier();
  n.markNotified();
  assert.equal(n.hasNotified, true);
  n.reset();
  assert.equal(n.hasNotified, false);
  assert.equal(n.markNotified(), true); // First call after reset
});

test("CaptureNotifier: multiple marks idempotent", () => {
  const n = new CaptureNotifier();
  n.markNotified();
  n.markNotified();
  n.markNotified();
  assert.equal(n.hasNotified, true);
  assert.equal(n.markNotified(), false);
});

// ---------------------------------------------------------------------------
// Tests: Content hash consistency
// ---------------------------------------------------------------------------

test("contentHash: stable across calls", () => {
  const input = "The quick brown fox";
  const h1 = contentHash(input);
  const h2 = contentHash(input);
  assert.equal(h1, h2);
});

test("contentHash: different inputs produce different hashes", () => {
  const h1 = contentHash("hello world");
  const h2 = contentHash("hello world!");
  assert.notEqual(h1, h2);
});

test("contentHash: empty string", () => {
  const h = contentHash("");
  assert.equal(typeof h, "string");
  assert.equal(h.length, 16);
});

test("contentHash: unicode safe", () => {
  const h1 = contentHash("café");
  const h2 = contentHash("cafe");
  // They should differ because é ≠ e
  assert.notEqual(h1, h2);
});

// ---------------------------------------------------------------------------
// Tests: MemoryStore module split validation
// ---------------------------------------------------------------------------

/**
 * Verify that the required exports exist from the expected modules.
 * After modularization, memory_store.ts should re-export everything
 * so existing consumers (index.ts, tests) still work.
 */
test("MemoryStore: core exports exist after modularization", async () => {
  const mod = await import("../extensions/pi-mempalace/memory_store.ts");

  // Core class
  assert.equal(typeof mod.MemoryStore, "function", "MemoryStore class must exist");

  // Verify key method signatures exist (not exhaustive — existing tests cover behavior)
  const store = new mod.MemoryStore();
  assert.equal(typeof store.load, "function");
  assert.equal(typeof store.store, "function");
  assert.equal(typeof store.search, "function");
  assert.equal(typeof store.wakeup, "function");
  assert.equal(typeof store.status, "function");
  assert.equal(typeof store.delete, "function");
  assert.equal(typeof store.recall, "function");
  assert.equal(typeof store.addEntity, "function");
  assert.equal(typeof store.addTriple, "function");
  assert.equal(typeof store.queryEntity, "function");
  assert.equal(typeof store.getPalaceGraph, "function");
  assert.equal(typeof store.diaryWrite, "function");
  assert.equal(typeof store.diaryRead, "function");
  assert.equal(typeof store.computeStats, "function");
  assert.equal(typeof store.checkDuplicate, "function");

  // Type exports
  assert.equal(typeof mod.MemoryStore, "function");
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function run() {
  await loadProductionCode();

  console.log(`Running ${TESTS.length} modular refactor tests...\n`);

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
