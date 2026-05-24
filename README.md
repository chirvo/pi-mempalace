# 🧠 pi-mempalace

**Your AI forgot everything again. How delightful.**

Every conversation you've ever had with an AI — every architectural decision, every late-night debugging eureka, every "let's use Postgres because..." — *poof*. Gone the moment you close the tab.

**pi-mempalace fixes that.** It gives [pi](https://github.com/badlogic/pi-mono) agents persistent, cross-session memory. Save important context, search it later, and stop re-explaining your life choices to a machine.

---

## 🧬 Fork & Credits

This repository merges two independent pi-native implementations of the [MemPalace](https://github.com/MemPalace/mempalace) concept:

| Source | Author | Contribution |
|--------|--------|-------------|
| [🚀 **Jabbslad/pi-mempalace**](https://github.com/Jabbslad/pi-mempalace) | **Jamie Slade** | Original pi-native implementation — SQLite + sqlite-vec backend, auto-capture, knowledge graph, palace graph, agent diary, wake-up context, TUI stats, and the 4-layer memory stack. This repo is forked from Jabbslad's work. |
| [🧠 **@sinamtz/pi-mempalace**](https://github.com/sinamtz/pi-mempalace) | **Sina Montazeri** | Paragraph-aware chunking with overlap, file directory mining (`.gitignore` awareness, binary detection, 30+ source extensions), conversation transcript import. |
| [🏰 **MemPalace**](https://github.com/MemPalace/mempalace) | **Milla Jovovich & Ben Sigman** | The original palace metaphor and verbatim-storage philosophy that inspired both pi-native forks. |

**Co-authored by [DeepSeek V4 Flash](https://deepseek.com)** — security audit, modular refactor, TDD test suite (106 tests), batch embedding performance, AbortSignal cancellation, multi-language chunking (ES/PT/RU/DE), and issue triage.

---

## ✨ Features

**From Jabbslad** —
- Auto-capture on each conversation turn
- Wake-up context (L0 identity + L1 essential story injected at session start)
- Semantic vector search via sqlite-vec
- Project/topic memory tagging
- Knowledge graph with temporal triples (`valid_from` / `valid_to`)
- Palace graph with cross-project tunnels
- Agent diary (write/read across sessions)
- TUI stats overlay (sparklines, bar charts)
- SHA-256 deduplication
- Local topic inference via flan-t5-small
- All original tools: search, save, recall, status, graph, tunnel, knowledge, diary

**From sinamtz** —
- Paragraph-aware chunking with configurable target/max size and overlap
- File directory mining (`.gitignore` awareness, 30+ source extensions, 1MB limit)
- Binary file detection (null byte check + 10 magic byte signatures)
- Conversation transcript import (Q+A exchange detection and paragraph modes)

**Ours** —
- Modular codebase (types.ts, utils.ts, chunker.ts, miner.ts, notifier.ts)
- `batchStore` with 3-phase algorithm (dedup → batch embed → single-transaction insert)
- AbortSignal cancellation for long-running mines
- Multi-language conversation chunking (Spanish, Portuguese, Russian, German)
- Content-aware topic detection (checks for test patterns, React imports, SQL, API decorators)
- 106 tests (up from 51), all passing
- Security audit findings resolved (no server, no subprocess, no credentials, parameterized SQL)
- Bug fixes: infinite loop in long-paragraph split, `fs.readSync` return type, duplicate `ConvoMiningResult` interface, `MEMORY_DIR` duplication

---

## 🚀 Install

```bash
pi install git:github.com/chirvo/pi-mempalace
```

Dependencies: `@huggingface/transformers` (embeddings + topic labels), `better-sqlite3` (SQLite), `sqlite-vec` (vector search). No Python, no Docker, no external servers.

---

## 🎮 Quick Start

```bash
/skill:memory-setup                                    # set up identity
memory_save("We chose PostgreSQL for concurrent writes", project: "myapp", topic: "database")
memory_search("why did we pick that database?")         # semantic search
memory_recall(project: "myapp")                         # browse by project
memory_mine_directory(directory: "~/code/myapp")        # scan codebase into memory
memory_mine_conversation(text: "Q: What DB? A: PG")     # import chat transcripts
memory_status()                                          # overview
```

---

## 🧰 Tools (18 total)

| Tool | Purpose |
|------|---------|
| `memory_search` | Semantic vector search |
| `memory_save` | Explicit save |
| `memory_recall` | Browse by project/topic |
| `memory_status` | Overview |
| `memory_graph` | Palace graph (cross-project tunnels) |
| `memory_tunnel` | Traverse shared topic between projects |
| `memory_list_rooms` / `memory_taxonomy` | Browse organization |
| `memory_delete` / `memory_check_duplicate` | Manage memories |
| `knowledge_add` / `query` / `status` / `invalidate` / `timeline` | Knowledge graph CRUD |
| `memory_diary_write` / `diary_read` | Agent diary |
| **`memory_mine_directory`** | Recursive codebase scan (.gitignore, binary detection, 30+ extensions) |
| **`memory_mine_conversation`** | Import chat transcripts (exchanges or paragraphs) |

## ⌨️ Commands

`/memory status` `/memory stats` `/memory project <name>` `/memory search <query>` `/memory graph` `/memory knowledge <entity>` `/memory mine` `/memory import` `/memory on` `/memory off`

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│  L0: IDENTITY (~100 tokens) — always loaded from file  │
│  L1: ESSENTIAL STORY (~500-800t) — top 15 by importance│
│  L2: ON-DEMAND PROJECT CONTEXT — filtered by SQL index │
│  L3: DEEP SEMANTIC SEARCH — sqlite-vec ANN index       │
└─────────────────────────────────────────────────────────┘

index.ts ─── MemoryStore ─── SQLite + sqlite-vec ─── memories.db
              (in-process, no subprocesses, no network)
```

**Performance** (Apple Silicon): store 1ms, search 100 memories 1ms, wakeup <1ms, model load ~200ms (one-time).

**Storage:** `~/.pi/agent/memory/memories.db` (SQLite, WAL mode). Auto-migration from legacy JSONL.

---

## 📊 LongMemEval Benchmark

Results reproduced from [Jabbslad/pi-mempalace](https://github.com/Jabbslad/pi-mempalace) (identical values — same codebase):

| Metric | Result | MemPalace (ref) | Delta |
|--------|--------|-----------------|-------|
| **Recall@5** | **95.8%** (479/500) | 96.6% | -0.8pp |
| **Recall@10** | **98.2%** (491/500) | 98.2% | **identical** |
| **NDCG@10** | **0.884** | 0.889 | -0.005 |

Per-type: knowledge-update 100%, multi-session 97.7%, temporal-reasoning 94.7%, single-session-assistant 94.6%, single-session-user 92.9%, single-session-preference 90.0%.

```bash
# Full 500-question benchmark (~7 min)
npx tsx benchmarks/longmemeval_bench.mjs

# Quick smoke test (10 questions)
npx tsx benchmarks/longmemeval_bench.mjs --limit 10
```

---

## 📜 License

MIT

---

<p align="center">
🔧 Forked from <a href="https://github.com/Jabbslad/pi-mempalace">Jabbslad/pi-mempalace</a> by Jamie Slade &bull;
🧬 Merged with ideas from <a href="https://github.com/sinamtz/pi-mempalace">sinamtz/pi-mempalace</a> by Sina Montazeri &bull;
🏰 Inspired by <a href="https://github.com/MemPalace/mempalace">MemPalace</a> by Milla Jovovich & Ben Sigman &bull;
✨ Co-authored by <a href="https://deepseek.com">DeepSeek V4 Flash</a>
</p>
