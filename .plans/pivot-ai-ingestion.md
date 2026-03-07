# Pivot: AI-Powered Document Ingestion

> **Supersedes** the Basiq-based sync flow from `budget-sync-tool.md`.
> This plan removes all Basiq integration and introduces an AI-powered document ingestion model
> where Claude parses bank statements (PDF, CSV, images) into the project's transaction model.

---

## Executive Summary

`budget-sync` pivots from a Basiq CDR API integration to an AI-powered document ingestion model. Instead of connecting to a bank API, users run `budget ingest <document>` and the CLI sends the document to the Anthropic API (Claude) with a structured prompt describing the expected transaction schema. Claude extracts transactions from PDFs, CSVs, images, and e-statements, returning structured JSON that the existing categorization pipeline processes.

The existing `BankProvider` interface and `sync-service.ts` orchestration are replaced with a simpler `DocumentParser` interface and `ingest-service.ts`. The categorization pipeline, SQLite schema, corpus stores, net worth tracking, super integration, and export functionality remain unchanged.

### Core Principle: Corpus is the Source of Truth for Everything

Every step of the ingestion pipeline snapshots its output into corpus stores. The **full document content** (binary or text) is stored in corpus — not just a reference. This enables:
- Complete replay without the original file
- Auditing of what the AI saw vs what it extracted
- Lineage from raw document → AI parse → categorized results → materialized state

### Architecture: New Data Flow

```
Document (PDF/CSV/image)
    │
    ├─→ corpus.stores["raw-documents"].put(fullContent)      ── full binary, versioned
    │
    ▼
AI Document Parser (Anthropic API)
    │
    ├─→ corpus.stores["ai-parse-results"].put(result)        ── versioned, parents: [raw-documents]
    │
    ▼
Existing Pipeline (filter → rent → local-mappings → fallback)
    │
    ├─→ corpus.stores["sync-results"].put(result)            ── versioned, parents: [ai-parse-results]
    │
    ▼
SQLite/Drizzle (materialize transactions, upsert balances)
    │
    ├─→ corpus.stores["computation-snapshots"].put(state)    ── versioned, parents: [sync-results]
    │
    ▼
Net Worth computed, balance snapshots materialized
```

---

## Table of Contents

1. [What Gets Removed](#1-what-gets-removed)
2. [What Stays](#2-what-stays)
3. [What Changes](#3-what-changes)
4. [The New Ingest Command](#4-the-new-ingest-command)
5. [AI Document Parsing Architecture](#5-ai-document-parsing-architecture)
6. [Deduplication Strategy](#6-deduplication-strategy)
7. [Decisions (All Resolved)](#7-decisions-all-resolved)
8. [Migration Phases](#8-migration-phases)
9. [Updated SKILL.md Sections](#9-updated-skillmd-sections)

---

## 1. What Gets Removed

### Files Deleted

| File | Reason |
|------|--------|
| `src/providers/basiq/client.ts` | Basiq HTTP client + JWT auth |
| `src/providers/basiq/provider.ts` | BasiqBankProvider implementation |
| `src/providers/basiq/types.ts` | Basiq API response Zod schemas |
| `src/providers/basiq/` (directory) | Entire Basiq provider directory |

### Code Removed (in files that stay)

| File | What's Removed |
|------|---------------|
| `src/config.ts` | `basiqConfigSchema`, `BasiqConfig` type, `getBasiqApiKey()` function, `basiq` field from `configSchema` |
| `src/config.ts` | `"basiq"` from `provider` enum in `configSchema` |
| `src/providers/index.ts` | `BasiqBankProvider` import, `case "basiq"` in `createProvider()`, `getBasiqApiKey()` import, `BasiqBankProvider` re-export |
| `src/commands/sync.ts` | **Entire file deleted** — replaced by `ingest.ts` |
| `src/index.ts` | `syncCommand` import and `program.addCommand(syncCommand)` |
| `src/services/sync-service.ts` | **Entire file replaced** — becomes `ingest-service.ts` |
| `src/pipeline/enrich-mapper.ts` | `ENRICHMENT_CATEGORY_MAP` (Basiq category names), `mapEnrichmentCategory()`, `applyEnrichment()` — these map Basiq-specific enrichment categories. `createFallback()` stays. |
| `src/pipeline/categorizer.ts` | Enrichment steps (4a: inline enrichment, 4b: API enrichment) removed from pipeline. The `enrichTransaction` callback in `PipelineContext` is removed. |
| `src/providers/types.ts` | `EnrichmentData` interface, `enrichTransaction?` method from `BankProvider` interface, `enrichment?` field from `RawTransaction` |
| `.env.example` | `BASIQ_API_KEY` reference |
| `config.example.jsonc` | `basiq` config section, `"basiq"` as default provider |
| `config.schema.json` | `basiq` schema section |

### DB Schema: `sync_runs` table

**RESOLVED** (Decision 2): Keep `sync_runs` table name as-is. The column semantics are identical — `provider` field stores `"ai"` or `"csv"` instead of `"basiq"`. No destructive migration needed.

### Tests Affected

| Test File | Impact |
|-----------|--------|
| `__tests__/integration/sync-workflow.test.ts` | **Rewrite** — becomes `ingest-workflow.test.ts`. Same patterns but uses AI parser instead of BankProvider. |
| `__tests__/integration/corpus-lineage.test.ts` | **Modify** — update to reference new stores (`raw-documents`, `ai-parse-results`, `computation-snapshots`) and new parent linkage. |
| `__tests__/integration/categorization.test.ts` | **Minor changes** — remove enrichment-related test cases. Pipeline tests stay. |
| `__tests__/unit/pipeline-steps.test.ts` | **Minor changes** — remove enrichment step tests. |
| `__tests__/helpers.ts` | **Modify** — add `InMemoryDocumentParser` helper, `makeParsedDocument()`, etc. |

### Dependencies Removed

None — Basiq didn't add any npm dependencies. It used corpus's `fetch_result()` and `Semaphore`.

---

## 2. What Stays

These remain **completely unchanged**:

| Module | Files |
|--------|-------|
| DB schema (all tables) | `src/db/schema.ts` — `syncRuns`, `accounts`, `transactions`, `snapshots`, `holdings`, `contributions` |
| DB client | `src/db/client.ts` — `AppContext`, `createDb()`, `createTestDb()` |
| Transaction service | `src/services/transaction-service.ts` |
| Account service | `src/services/account-service.ts` |
| Export service | `src/services/export-service.ts` |
| Snapshot service | `src/services/snapshot-service.ts` |
| Net worth service | `src/services/networth-service.ts` |
| Contribution service | `src/services/contribution-service.ts` |
| Super sync service | `src/services/super-sync-service.ts` |
| Pipeline: filter | `src/pipeline/filter.ts` |
| Pipeline: rent | `src/pipeline/rent.ts` |
| Pipeline: local-mappings | `src/pipeline/local-mappings.ts` |
| Pipeline: fallback | `src/pipeline/enrich-mapper.ts` → `createFallback()` only |
| In-memory bank provider | `src/providers/in-memory/provider.ts` |
| In-memory super provider | `src/providers/in-memory/super-provider.ts` |
| Manual super provider | `src/providers/manual-super/provider.ts` |
| Commands: accounts | `src/commands/accounts.ts` |
| Commands: mappings | `src/commands/mappings.ts` |
| Commands: export | `src/commands/export.ts` |
| Commands: snapshot | `src/commands/snapshot.ts` |
| Commands: networth | `src/commands/networth.ts` |
| Commands: super | `src/commands/super.ts` |
| Existing corpus stores | `raw-transactions`, `raw-accounts`, `raw-balances`, `sync-results`, `raw-contributions` — all stay |
| Merchant mappings | `merchant-mappings.jsonc`, `merchant-mappings.schema.json` |
| Unit tests | `filter.test.ts`, `rent.test.ts`, `local-mappings.test.ts` |
| Integration tests | `snapshot.test.ts`, `networth.test.ts`, `super-import.test.ts`, `super-networth.test.ts`, `export.test.ts` |

---

## 3. What Changes

### 3.1 BankProvider Interface → Simplified

The `BankProvider` interface stays but is **simplified**:

```typescript
// BEFORE
interface BankProvider {
  readonly name: string;
  authenticate(): Promise<Result<void, ProviderError>>;
  getAccounts(): Promise<Result<AccountInfo[], ProviderError>>;
  fetchTransactions(accountId: string, range: DateRange): Promise<Result<RawTransaction[], ProviderError>>;
  getAccountBalances(): Promise<Result<AccountBalance[], ProviderError>>;
  enrichTransaction?(description: string): Promise<Result<EnrichmentData, ProviderError>>;
}

// AFTER
interface BankProvider {
  readonly name: string;
  authenticate(): Promise<Result<void, ProviderError>>;
  getAccounts(): Promise<Result<AccountInfo[], ProviderError>>;
  fetchTransactions(accountId: string, range: DateRange): Promise<Result<RawTransaction[], ProviderError>>;
  getAccountBalances(): Promise<Result<AccountBalance[], ProviderError>>;
  // enrichTransaction removed — AI parsing replaces enrichment
}
```

Remove:
- `enrichTransaction?` method
- `EnrichmentData` interface
- `enrichment?` field from `RawTransaction`

### 3.2 New Interface: `DocumentParser`

```typescript
// src/providers/types.ts (added)

interface ParsedDocument {
  /** The transactions extracted from the document */
  transactions: RawTransaction[];
  /** Account info inferred from the document (if identifiable) */
  account?: {
    name?: string;
    institution?: string;
    type?: AccountType;
  };
  /** Confidence scores or notes from the AI about ambiguous entries */
  notes?: string[];
  /** Raw AI response for debugging/auditing */
  rawResponse?: string;
}

interface DocumentParser {
  readonly name: string;
  /**
   * Parse a document into transactions.
   * @param content - Document content (base64 for binary, raw text for CSV/text)
   * @param mimeType - MIME type of the document
   * @param accountHint - Optional user-provided account identification
   */
  parse(
    content: string,
    mimeType: string,
    accountHint?: { accountName?: string; accountType?: AccountType },
  ): Promise<Result<ParsedDocument, ProviderError>>;
}
```

Implementations:
| Class | Purpose |
|-------|---------|
| `AnthropicDocumentParser` | Production — sends document to Claude API |
| `InMemoryDocumentParser` | Testing — returns pre-loaded parse results |

### 3.3 New Corpus Stores

Corpus natively supports binary data via `binary_codec()` (pass-through `Uint8Array` codec). However, we need metadata alongside the binary content (filename, mime type, size). Two-store approach:

| Store | Codec | Type | Purpose |
|-------|-------|------|---------|
| `raw-documents` | `json_codec` | `RawDocumentSnapshot` | Full document content (base64-encoded for binary, raw text for text) + metadata (filename, mime type, size, content hash) |
| `ai-parse-results` | `json_codec` | `AiParseResultSnapshot` | AI's parsed output (extracted transactions, account inference, notes, raw AI response) |
| `computation-snapshots` | `json_codec` | `ComputationSnapshot` | Post-materialization state (net worth breakdown, account balances at time of ingestion) |

**Why base64 in JSON instead of `binary_codec()`**: We need to store metadata (filename, mime type, original path) alongside the document content. Using `json_codec` lets us embed the content as a base64 string in the same snapshot object. This trades ~33% storage overhead for simpler lineage — one store, one snapshot, all the context together. The corpus content hash still deduplicates identical documents.

**Why not two stores (binary + metadata)**: Adds complexity to the lineage graph and requires cross-store coordination. A single JSON store with base64 content is simpler and aligns with how we send documents to the Anthropic API (base64 content blocks).

```typescript
// New Zod schemas

const rawDocumentSnapshotSchema = z.object({
  /** Original filename */
  filename: z.string(),
  /** MIME type of the document */
  mimeType: z.string(),
  /** Size in bytes of the original file */
  sizeBytes: z.number(),
  /** SHA-256 hash of the original file content (for dedup) */
  contentHash: z.string(),
  /** Full document content — base64 for binary (PDF, images), raw text for text (CSV, TXT) */
  content: z.string(),
  /** Whether content field is base64-encoded (true for binary) or raw text (false) */
  isBase64: z.boolean(),
  /** When the document was ingested */
  ingestedAt: z.string(),
});
type RawDocumentSnapshot = z.infer<typeof rawDocumentSnapshotSchema>;

const aiParseResultSnapshotSchema = z.object({
  /** Parser that produced this result */
  parser: z.string(),
  /** AI model used (e.g., "claude-sonnet-4-20250514") */
  model: z.string().optional(),
  /** When parsing was performed */
  parsedAt: z.string(),
  /** Extracted transactions */
  transactions: z.array(rawTransactionSchema),
  /** Account info inferred from document */
  account: z.object({
    name: z.string().optional(),
    institution: z.string().optional(),
    type: z.enum(ACCOUNT_TYPES).optional(),
  }).optional(),
  /** AI notes about ambiguities */
  notes: z.array(z.string()).optional(),
  /** Raw AI response text for auditing */
  rawResponse: z.string().optional(),
});
type AiParseResultSnapshot = z.infer<typeof aiParseResultSnapshotSchema>;

const computationSnapshotSchema = z.object({
  /** ID of the ingest run that triggered this computation */
  ingestRunId: z.string(),
  /** When computation was performed */
  computedAt: z.string(),
  /** Net worth breakdown at time of computation */
  netWorth: z.object({
    total: z.number(),
    transaction: z.number(),
    savings: z.number(),
    credit: z.number(),
    super: z.number(),
  }),
  /** Per-account balances at time of computation */
  accountBalances: z.array(z.object({
    accountId: z.string(),
    accountName: z.string(),
    accountType: z.enum(ACCOUNT_TYPES),
    balance: z.number(),
  })),
  /** Summary of what was materialized */
  materialization: z.object({
    transactionsCreated: z.number(),
    transactionsExcluded: z.number(),
    transactionsSkipped: z.number(),
    snapshotsUpserted: z.number(),
  }),
});
type ComputationSnapshot = z.infer<typeof computationSnapshotSchema>;
```

Existing stores (`raw-transactions`, `raw-accounts`, `raw-balances`, `sync-results`, `raw-contributions`) are **unchanged**.

### 3.4 Pipeline Changes

The categorization pipeline drops enrichment steps:

```
BEFORE: filter → rent → local-mappings → inline enrichment → API enrichment → fallback
AFTER:  filter → rent → local-mappings → fallback
```

The AI already extracts merchant names and sometimes categories. But instead of mapping through the enrichment pathway, the AI's output is already in `RawTransaction` format, and the existing local-mappings pipeline handles categorization. If the AI provides a category suggestion, it can be stored in the transaction's `notes` field — but the pipeline's local-mappings remain authoritative.

`PipelineContext` loses the `enrichTransaction` callback:

```typescript
// BEFORE
interface PipelineContext {
  mappings: MerchantMappings;
  rentConfig: RentConfig;
  enrichTransaction?: (description: string) => Promise<Result<EnrichmentData, unknown>>;
}

// AFTER
interface PipelineContext {
  mappings: MerchantMappings;
  rentConfig: RentConfig;
}
```

### 3.5 Config Changes

```typescript
// BEFORE
const configSchema = z.object({
  // ...
  provider: z.enum(["basiq", "csv", "manual"]).default("basiq"),
  basiq: basiqConfigSchema.optional(),
  // ...
});

// AFTER
const configSchema = z.object({
  // ...
  provider: z.enum(["csv", "manual"]).default("manual"),  // basiq removed
  // basiq section removed entirely
  anthropic: z.object({
    model: z.string().default("claude-sonnet-4-20250514"),
    max_tokens: z.number().int().positive().default(8192),
  }).default({}),
  // ...
});
```

Environment variable: `BASIQ_API_KEY` → `ANTHROPIC_API_KEY`

### 3.6 CSV Provider: Keep as Fast Path

The `CsvBankProvider` stays as a **non-AI fast path** for known CSV formats. Rationale:
- CSV parsing is deterministic and free — no API call needed
- The existing CSV provider already handles BankSA format
- Users can choose: `budget ingest --parser csv <file.csv>` for known formats, or `budget ingest <file.csv>` for AI parsing of unknown formats
- The AI parser can also handle CSVs, but it's slower and costs money

**The `import` command gets merged into `ingest`** — they're conceptually the same operation now.

### 3.7 Sync Command → Ingest Command

| Before | After |
|--------|-------|
| `budget sync` | **Removed** — no more API polling |
| `budget import <file>` | **Merged into** `budget ingest <file>` |
| — | `budget ingest <file>` — new primary command |

---

## 4. The New Ingest Command

### CLI Interface

```
budget ingest <file> [options]
  Parse a bank document and import transactions into the DB.

  Arguments:
    file                 Path to document (PDF, CSV, image, text)

  Options:
    --account <name>     Account name to associate transactions with (overrides AI inference)
    --account-type <t>   Account type (transaction, savings, credit). Default: transaction
    --institution <name> Institution name (e.g., "BankSA", "CommBank")
    --parser <type>      Parser to use: "ai" (default), "csv" (fast path for known CSVs)
    --from <date>        Only import transactions after this date (YYYY-MM-DD)
    --to <date>          Only import transactions before this date (YYYY-MM-DD)
    --dry-run            Preview without writing to DB (still creates corpus snapshots)
    --verbose            Show detailed output including AI response
    --model <model>      Override AI model (default: from config)
```

### Complete Workflow

The ingest workflow is a 14-step process. Every step that produces data snapshots it into corpus before proceeding.

```
Step 1:  Read document from disk, detect MIME type
Step 2:  Compute content hash for document-level dedup
Step 3:  Store FULL document content into corpus ["raw-documents"]
            ├── binary files: base64-encode into JSON snapshot
            └── text files: store raw text in JSON snapshot
            └── includes: filename, mimeType, sizeBytes, contentHash, ingestedAt
Step 4:  Route to parser:
            ├── --parser csv or .csv extension: CsvBankProvider fast path (skip to Step 8)
            └── default (AI): send document to Anthropic API
Step 5:  AI extracts transactions → ParsedDocument
Step 6:  Store AI parse result into corpus ["ai-parse-results"]
            └── parents: [raw-documents version]
            └── includes: parser, model, transactions[], account inference, notes, rawResponse
Step 7:  Generate external IDs for each transaction (sha256 hash)
Step 8:  Create/find account in DB
            ├── from --account flag if provided
            ├── from AI inference (account name/institution from document)
            └── fallback: "Unknown Import"
Step 9:  Run categorization pipeline on extracted transactions
            └── filter → rent → local-mappings → fallback
Step 10: Store categorized results into corpus ["sync-results"]
            └── parents: [ai-parse-results version]
Step 11: Materialize into SQLite (skip in dry-run):
            ├── Insert categorized transactions (dedup by external_id)
            ├── Upsert balance snapshots if balances available
            └── Create sync_runs record with counts
Step 12: Compute current net worth (via getCurrentNetWorth())
Step 13: Store computation snapshot into corpus ["computation-snapshots"]
            └── parents: [sync-results version]
            └── includes: net worth breakdown, account balances, materialization stats
Step 14: Return IngestSummary to CLI for display
```

### CSV Fast Path

When using `--parser csv` or auto-detected `.csv` files:

```
Step 1-3: Same (read, hash, store full content in corpus)
Step 4:   CsvBankProvider.authenticate() + fetchTransactions()
          (the CSV content is already read; the provider parses it)
Step 5-6: Skip (no AI involved)
Step 7:   CSV provider already generates external IDs (csv-{hash})
Step 8-14: Same as AI path
```

The CSV fast path stores the raw document in corpus just like the AI path — the CSV text content is preserved for replay.

---

## 5. AI Document Parsing Architecture

### Approach: Direct Anthropic API

The CLI calls the Anthropic API directly using `@anthropic-ai/sdk`. This is the most practical approach because:

1. **Self-contained** — no dependency on opencode running, no stdout parsing hacks
2. **Structured output** — use tool_use/JSON mode to get typed responses
3. **Multi-modal** — Claude can read PDFs and images natively
4. **Deterministic replay** — corpus stores the AI response for auditing

Alternative approaches considered and rejected:
- **opencode integration**: Would require the CLI to be run inside opencode, creating a tight coupling. The CLI should be independently usable.
- **stdout relay**: User pastes document to AI manually. Too much friction, no structured output, no automation.

### System Prompt Design

```typescript
const DOCUMENT_PARSE_PROMPT = `You are a financial document parser. Extract all transactions from the provided bank document.

For each transaction, extract:
- date: Transaction date in YYYY-MM-DD format
- description: The raw bank description exactly as shown
- amount: The transaction amount as a positive number (no currency symbols)
- direction: "debit" for money going out, "credit" for money coming in

Also identify if possible:
- The account name (e.g., "Everyday Account", "Platinum Visa")
- The institution (e.g., "BankSA", "CommBank", "Westpac")
- The account type: "transaction", "savings", or "credit"

Return your response as a JSON object matching this schema:
{
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "description": "raw bank description",
      "amount": 42.50,
      "direction": "debit" | "credit"
    }
  ],
  "account": {
    "name": "account name if identifiable",
    "institution": "bank name if identifiable",
    "type": "transaction" | "savings" | "credit"
  },
  "notes": ["any ambiguities or issues noted"]
}

Rules:
- Amounts are ALWAYS positive. Use direction to indicate debit/credit.
- Dates must be YYYY-MM-DD format. Convert from any source format.
- Include ALL transactions visible in the document, even pending ones.
- If a transaction is ambiguous, include it with a note.
- Do NOT infer categories — just extract the raw data.
- Preserve the exact bank description text.`;
```

### AnthropicDocumentParser Implementation

```typescript
// src/providers/ai/parser.ts

import Anthropic from "@anthropic-ai/sdk";

export class AnthropicDocumentParser implements DocumentParser {
  readonly name = "ai";
  private client: Anthropic;
  private model: string;

  constructor(config: { apiKey: string; model?: string }) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model ?? "claude-sonnet-4-20250514";
  }

  async parse(
    content: string,
    mimeType: string,
    accountHint?: { accountName?: string; accountType?: AccountType },
  ): Promise<Result<ParsedDocument, ProviderError>> {
    // Build message with document content
    // For PDFs/images: use base64 content block (content is already base64)
    // For text/CSV: use text content block
    // Parse response JSON into ParsedDocument
    // Generate stable external IDs from hash of (date, description, amount, direction)
    // Validate with Zod schema
    // Map errors to ProviderError
  }
}
```

The parser receives the content string as it was stored in corpus — base64 for binary documents, raw text for text documents. This means the AI receives the document via the corpus store, not directly from disk.

### InMemoryDocumentParser for Testing

```typescript
// src/providers/in-memory/document-parser.ts

export class InMemoryDocumentParser implements DocumentParser {
  readonly name = "in-memory-parser";
  private _results: Map<string, ParsedDocument> = new Map();
  private _defaultResult: ParsedDocument | null = null;

  failNextParse = false;

  setResult(contentHash: string, result: ParsedDocument): void { ... }
  setDefaultResult(result: ParsedDocument): void { ... }

  async parse(content, mimeType, accountHint): Promise<Result<ParsedDocument, ProviderError>> {
    if (this.failNextParse) { ... }
    // Return pre-loaded result matching content hash, or default
  }
}
```

### External ID Generation

The AI doesn't produce provider-specific IDs like Basiq did. External IDs for deduplication are generated from a hash of the transaction content:

```typescript
function generateExternalId(tx: { date: string; description: string; amount: number; direction: string }): string {
  const hash = createHash("sha256")
    .update(`${tx.date}|${tx.description}|${tx.amount}|${tx.direction}`)
    .digest("hex")
    .substring(0, 16);
  return `ai-${hash}`;
}
```

This matches the pattern already used by `CsvBankProvider`.

---

## 6. Deduplication Strategy

### Problem

Without Basiq's unique transaction IDs, we need robust dedup to avoid re-importing transactions from the same document or overlapping date ranges across documents.

### Strategy

1. **Document-level dedup**: Hash the document content (`contentHash` in `RawDocumentSnapshot`). Before parsing, check if we've already ingested a document with the same hash. Corpus's built-in `content_hash` on snapshots handles this — `find_by_hash()` on the metadata client. If found, warn the user and skip (or allow with `--force`).

2. **Transaction-level dedup**: Same as current — `external_id` unique index on transactions table.
   - External ID = `ai-${sha256(date|description|amount|direction)}` (truncated to 16 hex chars)
   - Same formula as CSV provider uses (but with `ai-` prefix instead of `csv-`)

3. **Date range overlap**: When ingesting a new document, transactions that overlap with existing ones (same external_id) are silently skipped — same behavior as current sync dedup.

### Edge Cases

- **Same transaction, different description**: Banks sometimes format descriptions differently across documents. This would create a different hash → duplicate insertion. Mitigation: the user can manually delete duplicates, or we add a fuzzy-match dedup pass in a later phase.
- **Pending vs posted**: Same transaction may appear as "pending" in one document and "posted" in another with a different date. The different dates produce different hashes. Mitigation: accept this as a known limitation for now.

---

## 7. Decisions (All Resolved)

### DECISION 1: `ANTHROPIC_API_KEY` management — **RESOLVED: Environment variable**

`ANTHROPIC_API_KEY` env var. Same pattern as the old `BASIQ_API_KEY`. Add `getAnthropicApiKey()` to `config.ts`.

### DECISION 2: Rename `sync_runs` → `ingest_runs`? — **RESOLVED: Keep `sync_runs`**

Keep `sync_runs` table name as-is. It's an internal table name and the column semantics are identical. The `provider` field stores `"ai"` or `"csv"` instead of `"basiq"`. Avoids a destructive migration for zero functional benefit.

### DECISION 3: Keep `CsvBankProvider`? — **RESOLVED: Keep as fast path**

Keep `CsvBankProvider` as a non-AI fast path. `budget ingest --parser csv <file.csv>` uses the existing CSV provider. `budget ingest <file>` uses AI by default. CSV is free, fast, and deterministic — perfect for recurring imports of the same CSV format.

### DECISION 4: Store full document content in corpus? — **RESOLVED: Store FULL content**

Store the **full binary content** in corpus. The corpus is the source of truth for everything, including the original documents. Binary files (PDF, images) are base64-encoded into the `content` field of the `RawDocumentSnapshot` JSON object. Text files (CSV, TXT) are stored as raw text. The `isBase64` boolean flag distinguishes the encoding.

This enables complete replay without the original file and aligns with the project's corpus-first philosophy.

### DECISION 5: Account identification UX — **RESOLVED: AI inference + flag override**

AI infers account info from the document. `--account` flag overrides. If neither provides account info, fall back to `"Unknown Import"`. The `--institution` and `--account-type` flags provide additional override granularity.

### DECISION 6: Keep `BankProvider` interface? — **RESOLVED: Keep (minus enrichment)**

Keep `BankProvider` interface with `enrichTransaction?` removed. CSV provider and `InMemoryBankProvider` still implement it. The CSV fast path through the ingest service uses it internally. `InMemoryBankProvider` continues to serve tests for the sync pipeline.

### DECISION 7: Merge `import` into `ingest`? — **RESOLVED: Merge**

Merge `import` command into `ingest`. One command handles everything. `--parser csv` selects the CSV fast path. Default is `ai`. For `.csv` files, auto-detect CSV parser unless `--parser ai` explicitly overrides.

---

## 8. Migration Phases

### Phase 1: Remove Basiq (clean deletion)

**Goal**: Delete all Basiq code and references. No new functionality yet. Tests must pass.

**Task 1.1: Delete Basiq provider directory** *(parallel-safe)*
- Delete `src/providers/basiq/client.ts`
- Delete `src/providers/basiq/provider.ts`
- Delete `src/providers/basiq/types.ts`
- Delete `src/providers/basiq/` directory
- LOC delta: **−374** (103 + 152 + 119)
- Touches: `src/providers/basiq/*`

**Task 1.2: Remove Basiq from config** *(parallel-safe)*
- `src/config.ts`: Remove `basiqConfigSchema`, `BasiqConfig` type, `getBasiqApiKey()`, `basiq` field from `configSchema`, `"basiq"` from provider enum
- `config.example.jsonc`: Remove `basiq` section, change default provider to `"manual"`
- `config.schema.json`: Remove `basiq` schema section
- `.env.example`: Remove `BASIQ_API_KEY`
- LOC delta: **~−25**
- Touches: `src/config.ts`, `config.example.jsonc`, `config.schema.json`, `.env.example`

**Task 1.3: Remove Basiq from provider factory + types** *(parallel-safe)*
- `src/providers/index.ts`: Remove `BasiqBankProvider` import, `case "basiq"`, `getBasiqApiKey()` import, `BasiqBankProvider` re-export
- `src/providers/types.ts`: Remove `enrichTransaction?` from `BankProvider`, remove `EnrichmentData` interface, remove `enrichment?` from `RawTransaction`
- LOC delta: **~−30**
- Touches: `src/providers/index.ts`, `src/providers/types.ts`

**Task 1.4: Remove enrichment from pipeline** *(depends on 1.3)*
- `src/pipeline/enrich-mapper.ts`: Remove `ENRICHMENT_CATEGORY_MAP`, `mapEnrichmentCategory()`, `applyEnrichment()`. Keep only `createFallback()`.
- `src/pipeline/categorizer.ts`: Remove enrichment steps (4a, 4b), remove `enrichTransaction` from `PipelineContext`
- LOC delta: **~−55**
- Touches: `src/pipeline/enrich-mapper.ts`, `src/pipeline/categorizer.ts`

**Task 1.5: Remove sync command** *(parallel-safe)*
- Delete `src/commands/sync.ts`
- `src/index.ts`: Remove `syncCommand` import and registration
- LOC delta: **~−86**
- Touches: `src/commands/sync.ts` (deleted), `src/index.ts`

**Task 1.6: Update tests** *(depends on 1.3, 1.4)*
- `__tests__/unit/pipeline-steps.test.ts`: Remove enrichment step tests if any
- `__tests__/integration/categorization.test.ts`: Remove enrichment-related test cases
- `__tests__/integration/sync-workflow.test.ts`: Update — this file tests `syncTransactions()` which still exists (used by CSV fast path). Remove Basiq-specific test patterns. Tests should pass with `InMemoryBankProvider` (no enrichment).
- `__tests__/helpers.ts`: No Basiq references to remove currently.
- `src/corpus/schemas.ts`: Remove `enrichment` from `rawTransactionSchema`
- LOC delta: **~−20**
- Touches: `__tests__/**`, `src/corpus/schemas.ts`

> **Phase 1 total: ~−590 LOC (net deletion)**
> Tasks 1.1, 1.2, 1.3, 1.5 can run in parallel.
> Task 1.4 depends on 1.3.
> Task 1.6 depends on 1.3 and 1.4.
> Verification: typecheck, full test suite, lint, COMMIT

---

### Phase 2: Build AI Document Parser + Corpus Stores

**Goal**: Create the `DocumentParser` interface, `AnthropicDocumentParser`, `InMemoryDocumentParser`, and all new corpus stores. No CLI wiring yet.

**Task 2.1: Add DocumentParser interface + ParsedDocument types** *(sequential — foundation)*
- `src/providers/types.ts`: Add `DocumentParser` interface, `ParsedDocument` interface, `generateExternalId()` utility
- LOC: **~50**
- Touches: `src/providers/types.ts`

**Task 2.2: Add `@anthropic-ai/sdk` dependency** *(parallel-safe)*
- `package.json`: Add `"@anthropic-ai/sdk": "latest"` to dependencies
- Run `bun install`
- LOC: **~2**
- Touches: `package.json`

**Task 2.3: Add Anthropic config to config.ts** *(parallel-safe)*
- `src/config.ts`: Add `anthropicConfigSchema`, `getAnthropicApiKey()`, `anthropic` field to `configSchema`
- `config.example.jsonc`: Add `anthropic` section
- `config.schema.json`: Add `anthropic` schema
- `.env.example`: Add `ANTHROPIC_API_KEY`
- LOC: **~25**
- Touches: `src/config.ts`, `config.example.jsonc`, `config.schema.json`, `.env.example`

**Task 2.4: Create AnthropicDocumentParser** *(depends on 2.1, 2.2)*
- `src/providers/ai/parser.ts`: Implementation
  - System prompt with transaction schema
  - Multi-modal content blocks (PDF as base64 content block, CSV as text content block)
  - Receives content string (base64 or raw text) — same format as stored in corpus
  - Zod schema for validating AI response
  - `generateExternalId()` for each extracted transaction
  - Error mapping to `ProviderError` variants
  - Uses `try_catch_async` for API call wrapping
- `src/providers/ai/types.ts`: Zod schema for AI response validation
- LOC: **~220**
- Touches: `src/providers/ai/parser.ts`, `src/providers/ai/types.ts`

**Task 2.5: Create InMemoryDocumentParser** *(depends on 2.1)*
- `src/providers/in-memory/document-parser.ts`
- Pre-loadable results, `failNextParse` flag, default result support
- Content-hash-based result lookup for deterministic testing
- LOC: **~60**
- Touches: `src/providers/in-memory/document-parser.ts`

**Task 2.6: Add new corpus stores** *(parallel-safe)*
- `src/corpus/schemas.ts`: Add `RawDocumentSnapshot`, `AiParseResultSnapshot`, `ComputationSnapshot` Zod schemas
  - `RawDocumentSnapshot`: filename, mimeType, sizeBytes, contentHash, content (base64 or raw text), isBase64, ingestedAt
  - `AiParseResultSnapshot`: parser, model, parsedAt, transactions[], account inference, notes, rawResponse
  - `ComputationSnapshot`: ingestRunId, computedAt, netWorth breakdown, accountBalances[], materialization stats
- `src/corpus/stores.ts`: Add `raw-documents`, `ai-parse-results`, `computation-snapshots` store definitions using `json_codec()`
- `src/corpus/client.ts`: Register 3 new stores in `buildCorpus()`
- `src/corpus/index.ts`: Re-export new types
- LOC: **~120**
- Touches: `src/corpus/schemas.ts`, `src/corpus/stores.ts`, `src/corpus/client.ts`, `src/corpus/index.ts`

> **Phase 2 total: ~477 LOC**
> Tasks 2.2, 2.3, 2.6 can run in parallel.
> Task 2.1 is sequential (foundation).
> Tasks 2.4 and 2.5 depend on 2.1.
> Verification: typecheck, COMMIT

---

### Phase 3: Build Ingest Service + Command

**Goal**: Create the `ingest-service.ts` orchestrator and `ingest` CLI command. Wire everything together. This is the core of the pivot.

**Task 3.1: Create ingest-service.ts** *(depends on Phase 2)*
- `src/services/ingest-service.ts`: The new orchestration function
  - `ingestDocument(ctx, parser, config, options)` → `Result<IngestSummary, IngestError>`
  - Full 14-step workflow:
    1. Read document from disk, detect MIME type
    2. Compute content hash for document-level dedup
    3. **Store FULL document** in `corpus.stores["raw-documents"]` (base64 for binary, raw text for text)
    4. Route to parser (AI or CSV fast path)
    5. AI: call `parser.parse()` with content from corpus snapshot
    6. **Store AI parse result** in `corpus.stores["ai-parse-results"]` with `parents: [raw-documents]`
    7. Generate external IDs for extracted transactions
    8. Create/find account in DB (from options, AI inference, or fallback)
    9. Run categorization pipeline (filter → rent → local-mappings → fallback)
    10. **Store sync results** in `corpus.stores["sync-results"]` with `parents: [ai-parse-results]`
    11. Materialize into SQLite (skip in dry-run): insert transactions (dedup), upsert balance snapshots, create sync_run record
    12. Compute current net worth via `getCurrentNetWorth()`
    13. **Store computation snapshot** in `corpus.stores["computation-snapshots"]` with `parents: [sync-results]`
    14. Return `IngestSummary`
  - `IngestSummary` type: extends `SyncSummary` with document info + net worth snapshot
  - `ingestDocumentViaCsv()` — internal helper for CSV fast path (reuses existing sync pipeline structure but stores document in corpus first)
  - Uses `try_catch_async` for file I/O and API calls
- LOC: **~350**
- Touches: `src/services/ingest-service.ts`

**Task 3.2: Create ingest command** *(depends on 3.1)*
- `src/commands/ingest.ts`: Commander command definition
  - Arguments: `<file>`
  - Options: `--account`, `--account-type`, `--institution`, `--parser`, `--from`, `--to`, `--dry-run`, `--verbose`, `--model`
  - Constructs `AppContext`, creates appropriate parser (AI or CSV)
  - For CSV: auto-detect `.csv` extension, override with `--parser ai`
  - Calls `ingestDocument()` which handles both paths
  - Displays summary including net worth update
- LOC: **~130**
- Touches: `src/commands/ingest.ts`

**Task 3.3: Update CLI entry point** *(depends on 3.2)*
- `src/index.ts`: Add `ingestCommand`, remove `importCommand`
- `src/commands/import.ts`: Delete (merged into ingest)
- LOC delta: **~−45**
- Touches: `src/index.ts`, `src/commands/import.ts` (deleted)

**Task 3.4: Update provider factory** *(depends on Phase 2)*
- `src/providers/index.ts`: Add `createDocumentParser(config)` factory function
  - Returns `AnthropicDocumentParser` when API key available
  - Returns error if no API key and AI parsing requested
  - Re-export `DocumentParser`, `ParsedDocument`, `AnthropicDocumentParser`, `InMemoryDocumentParser`
- LOC: **~35**
- Touches: `src/providers/index.ts`

> **Phase 3 total: ~470 LOC**
> Tasks 3.1 and 3.4 can run in parallel.
> Task 3.2 depends on 3.1.
> Task 3.3 depends on 3.2.
> Verification: typecheck, COMMIT

---

### Phase 4: Tests + Polish

**Goal**: Full test coverage for the new ingest flow. Update SKILL.md. Clean up sync-service for CSV path.

**Task 4.1: Test helpers for ingest** *(parallel-safe)*
- `__tests__/helpers.ts`: Add:
  - `createTestDocumentParser(options?)` — pre-loaded `InMemoryDocumentParser`
  - `makeParsedDocument(overrides?)` — factory for `ParsedDocument`
  - `makeIngestConfig(overrides?)` — factory for config with `anthropic` section
  - `makeRawDocumentSnapshot(overrides?)` — factory for corpus test data
- LOC: **~55**
- Touches: `__tests__/helpers.ts`

**Task 4.2: Integration tests for ingest** *(parallel-safe)*
- `__tests__/integration/ingest-workflow.test.ts`: New test file
  - Full ingest creates correct DB records (accounts, transactions)
  - Full ingest creates ALL corpus snapshots:
    - `raw-documents` (full document content stored)
    - `ai-parse-results` (AI extraction with parent ref to raw-documents)
    - `sync-results` (pipeline output with parent ref to ai-parse-results)
    - `computation-snapshots` (net worth state with parent ref to sync-results)
  - Duplicate prevention via external_id (transaction-level)
  - Document-level dedup (same content hash → skip)
  - Dry-run creates corpus snapshots but no DB transactions
  - Dry-run still computes net worth snapshot
  - Ingest run record has correct counts (sync_runs table)
  - Parser failure returns Result.err without crash
  - Date range filtering works (--from, --to)
  - CSV fast path works through ingest (--parser csv)
  - Account inference from AI response
  - Account override with --account flag
  - Net worth computed and stored in computation-snapshots
- LOC: **~420**
- Touches: `__tests__/integration/ingest-workflow.test.ts`

**Task 4.3: Update corpus lineage tests** *(parallel-safe)*
- `__tests__/integration/corpus-lineage.test.ts`: Add/update tests for new lineage chain:
  - `raw-documents` → `ai-parse-results` → `sync-results` → `computation-snapshots` full parent chain
  - Verify each snapshot's `parents` array points to the correct store and version
  - Deterministic replay: extract transactions from `ai-parse-results` corpus, re-run pipeline, verify identical output
  - Document content preservation: verify `raw-documents` snapshot contains full file content
  - Computation snapshot contains valid net worth breakdown
- LOC delta: **~+100**
- Touches: `__tests__/integration/corpus-lineage.test.ts`

**Task 4.4: Update SKILL.md** *(parallel-safe)*
- Update project overview (no more Basiq, AI-powered ingestion)
- Update data flow diagram (5-step corpus chain)
- Update provider pattern section (add `DocumentParser`, remove `BasiqBankProvider`, remove `enrichTransaction?`)
- Update pipeline section (no enrichment steps)
- Update corpus stores section (add `raw-documents`, `ai-parse-results`, `computation-snapshots` — now 8 stores total)
- Update config section (remove `basiq`, add `anthropic`)
- Update CLI commands (`sync` → `ingest`, `import` merged into `ingest`)
- Update gotchas (remove Basiq JWT/Semaphore, add AI parsing notes)
- Update common tasks ("Adding a new provider" updated, "Ingesting a document" added)
- Update environment variables (`ANTHROPIC_API_KEY`)
- LOC delta: **~+60 net**
- Touches: `SKILL.md`

**Task 4.5: Clean up sync-service.ts for CSV path** *(parallel-safe)*
- `src/services/sync-service.ts`: Simplify — remove enrichment references from `PipelineContext` construction, remove the `enrichTransaction` callback wiring. The function is now only used internally by the ingest service for the CSV fast path.
- Remove `SyncOptions.provider` references to `"basiq"`
- LOC delta: **~−30**
- Touches: `src/services/sync-service.ts`

> **Phase 4 total: ~605 LOC**
> Tasks 4.1–4.5 can all run in parallel.
> Verification: full test suite, lint, COMMIT

---

### Phase Summary

| Phase | Goal | LOC | Tasks | Parallelizable |
|-------|------|-----|-------|----------------|
| 1: Remove Basiq | Clean deletion of all Basiq code | −590 (deletion) | 6 | 4 parallel + 2 sequential |
| 2: Build AI Parser + Stores | DocumentParser interface, implementations, 3 new corpus stores | +477 | 6 | 3 parallel + 3 sequential |
| 3: Ingest Service + Command | 14-step orchestration, CLI command, provider factory | +470 | 4 | 2 parallel + 2 sequential |
| 4: Tests + Polish | Full test coverage, SKILL.md, sync-service cleanup | +605 | 5 | All parallel |
| **Total** | | **~+962 net** | **21 tasks** | |

---

## 9. Updated SKILL.md Sections

After this pivot, the following SKILL.md sections should be updated:

### Data Flow (replace)
```
Document (PDF/CSV/image)
  → corpus["raw-documents"]        (full binary/text content)
  → AI parser / CSV parser
  → corpus["ai-parse-results"]     (extracted transactions, parents: raw-documents)
  → pipeline (pure)
  → corpus["sync-results"]         (categorized output, parents: ai-parse-results)
  → SQLite materialization
  → corpus["computation-snapshots"] (net worth + balances, parents: sync-results)
```

### Corpus Stores (update — now 8 stores)

| Store | Codec | Purpose |
|-------|-------|---------|
| `raw-documents` | `json_codec` | Full ingested document content (base64 for binary, raw text for text) + metadata |
| `ai-parse-results` | `json_codec` | AI's parsed output (transactions, account inference, raw response) |
| `raw-transactions` | `json_codec` | Raw transaction arrays per account (CSV provider path) |
| `raw-accounts` | `json_codec` | Raw account info per fetch |
| `raw-balances` | `json_codec` | Raw balance snapshots per fetch |
| `sync-results` | `json_codec` | Categorized pipeline output with lineage |
| `raw-contributions` | `json_codec` | Raw super contribution data |
| `computation-snapshots` | `json_codec` | Post-materialization state (net worth, balances, stats) |

### Provider Pattern (update)
- Remove `BasiqBankProvider` from implementations table
- Add `DocumentParser` interface documentation
- Add `AnthropicDocumentParser` and `InMemoryDocumentParser`
- Remove `enrichTransaction?` from `BankProvider` interface

### Pipeline (simplify)
```
Steps: filter → rent → local-mappings → fallback
(enrichment steps removed — AI parsing replaces enrichment)
```

### Config (update)
- Remove `basiq` section
- Add `anthropic` section with `model` and `max_tokens`
- `ANTHROPIC_API_KEY` env var (required for AI parsing, not needed for CSV fast path)

### CLI Commands (update)
- Remove `sync`
- Remove `import` (merged into `ingest`)
- Add `ingest <file>` with `--parser`, `--account`, `--account-type`, `--institution`, `--dry-run`, `--verbose`, `--model`

### Gotchas (update)
- Remove: "Basiq JWT expires — BasiqClient.authenticate() caches token and refreshes 60s before expiry"
- Remove: "BasiqClient.get() uses a Semaphore(10) for rate limiting"
- Add: "AI-generated external IDs use `ai-${sha256(date|description|amount|direction)}` prefix — same pattern as CSV but with `ai-` prefix"
- Add: "Document dedup uses content hash stored in raw-documents corpus snapshot — re-ingesting the same file is detected before calling the AI"
- Add: "AI parsing is non-deterministic — the same document may produce slightly different descriptions across runs. Dedup handles this via the hash, but exact text matching may differ."
- Add: "ANTHROPIC_API_KEY env var required for AI parsing. Not needed for CSV fast path."
- Add: "Raw documents are stored as full content in corpus — base64 for binary (PDF/images), raw text for CSV/text. The `isBase64` flag on `RawDocumentSnapshot` distinguishes encoding."
- Add: "Computation snapshots capture net worth state at ingestion time — enables tracking how each document ingestion affected net worth."
- Add: "The ingest workflow stores to 4 corpus stores sequentially: raw-documents → ai-parse-results → sync-results → computation-snapshots. Each has parent linkage to the previous."

---

## Suggested AGENTS.md Updates

After completing the pivot:

1. Replace all references to Basiq with AI ingestion model
2. Update "Quick Start" section to show `budget ingest` instead of `budget sync`
3. Update "Architecture" section to show new 5-step corpus chain data flow
4. Remove `BASIQ_API_KEY` reference, add `ANTHROPIC_API_KEY`
5. Add note: "CSV provider kept as fast path for known formats. AI parsing for everything else."
6. Add note: "Every ingestion stores the FULL document in corpus. Corpus is the source of truth for raw data, not the filesystem."
7. Add note: "Each ingest captures a computation snapshot with net worth state — enables tracking financial impact of each document."
