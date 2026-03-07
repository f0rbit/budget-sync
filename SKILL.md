# budget-sync -- AI Agent Skill

## Project Overview

Personal finance CLI tool. SQLite (Drizzle ORM) is the source of truth for queries.
Corpus stores are the source of truth for raw document data, AI parse results, and sync results (versioned, with lineage).
Ingests bank documents (PDFs, CSVs, images) using Claude for extraction. Tracks: bank transactions, savings balances, super, investments, net worth.

## Tech Stack

- Runtime: Bun
- Database: SQLite + Drizzle ORM (`drizzle-orm/bun-sqlite`)
- Data stores: `@f0rbit/corpus` stores (`raw-transactions`, `raw-accounts`, `raw-balances`, `sync-results`, `raw-contributions`, `raw-documents`, `ai-parse-results`, `ai-categorization-results`, `computation-snapshots`)
- AI parsing: `@anthropic-ai/sdk` (Claude for document extraction)
- Error handling: `@f0rbit/corpus` `Result<T, E>` types -- never throw
  - `pipe()` for chaining, `flat_map()` for fallible steps
  - `try_catch` / `try_catch_async` for wrapping side effects
  - `parallel_map()` for concurrent operations
- CLI: Commander (`commander`)
- Config: JSONC (`jsonc-parser`) + JSON Schema
- Testing: `bun test`, in-memory SQLite, in-memory corpus, in-memory providers
- IDs: cuid2 (`@paralleldrive/cuid2`)
- Linter: Biome (`@biomejs/biome`)

## Project Structure

```
budget-sync/
  src/
    index.ts                          -- CLI entrypoint (Commander program, registers commands)
    config.ts                         -- Zod schemas + loadConfig() / getAnthropicApiKey()
    errors.ts                         -- Discriminated union error types + constructor helpers
    commands/
      ingest.ts                       -- `budget ingest` command (AI document ingestion)
      accounts.ts                     -- `budget-sync accounts` command handler
      mappings.ts                     -- `budget-sync mappings` command handler
      export.ts                       -- `budget-sync export` command handler
      snapshot.ts                       -- `budget-sync snapshot` command handler
      networth.ts                       -- `budget-sync networth` command handler
      super.ts                          -- `budget-sync super` command handler (balance, contributions, import)
      transactions.ts                   -- `budget-sync transactions` command handler (list, summary, search)
    corpus/
      index.ts                        -- Barrel: re-exports AppCorpus, stores, snapshot types
      client.ts                       -- buildCorpus(), createCorpus(dataDir), createTestCorpus()
      stores.ts                       -- define_store() calls for all 9 stores
      schemas.ts                      -- Zod schemas for snapshot payloads
    db/
      schema.ts                       -- Drizzle table definitions (syncRuns, accounts, transactions, snapshots, holdings, contributions)
      client.ts                       -- createDb(path), createTestDb(), AppContext { db, corpus }
    providers/
      types.ts                        -- BankProvider interface, SuperProvider interface, DocumentParser interface, value types (RawTransaction, CategorizedTransaction, SuperBalance, SuperContribution, etc.), enum arrays (CATEGORIES, ACCOUNT_TYPES, CONTRIBUTION_TYPES, etc.), InvestmentProvider (forward-compat)
      index.ts                        -- createProvider(config) factory, re-exports all provider classes
      utils.ts                        -- generateExternalId() utility
      ai/
        parser.ts                     -- AnthropicDocumentParser: Claude API document parsing
        categorizer.ts                -- AnthropicAiCategorizer: Claude API batch categorization
      csv/
        provider.ts                   -- CsvBankProvider: parses DD/MM/YYYY CSV, generates sha256 external IDs
        document-parser.ts            -- CsvDocumentParser: CSV adapter for unified ingestDocument() pipeline
      in-memory/
        provider.ts                   -- InMemoryBankProvider: arrays + fail flags for testing
        super-provider.ts               -- InMemorySuperProvider for testing
        document-parser.ts             -- InMemoryDocumentParser for testing
        categorizer.ts                  -- InMemoryAiCategorizer: configurable results + fail flags for testing
      manual-super/
        provider.ts                   -- ManualSuperProvider: JSON file import
    pipeline/
      categorizer.ts                  -- categorizePipeline(tx, context), categorizeAll(txs, context) with AI batch step
      filter.ts                       -- filterTransaction(tx, exclusions) -> Result<RawTransaction, ExcludedTransaction>
      rent.ts                         -- isRentTransaction(), calculateRentAmount(), handleRent()
      local-mappings.ts               -- loadMappings(path?), matchTransaction(), applyMapping(), appendMappings()
      fallback.ts                     -- createFallback()
    services/
      ingest-service.ts               -- 14-step document ingestion orchestrator
      account-service.ts              -- upsertAccount(), listAccounts(), deactivateAccount(), findAccountByExternalId()
      transaction-service.ts          -- createTransaction(), getTransactions(filters), getUncategorized(), searchTransactions(), getCategorySummary()
      export-service.ts               -- exportToObsidian(db, vaultPath, budgetDir, options)
      snapshot-service.ts               -- upsertSnapshot(), getLatestSnapshots(), getSnapshotHistory()
      networth-service.ts               -- getCurrentNetWorth(), getNetWorthHistory() with carry-forward
      contribution-service.ts           -- insertContributions(), getContributions(), getContributionSummary()
      super-sync-service.ts             -- syncSuper() import orchestrator
  __tests__/
    integration/                      -- Integration tests (in-memory DB + corpus)
      ingest-workflow.test.ts           -- Ingest pipeline integration tests
      ai-categorization.test.ts         -- AI categorization pipeline integration tests
      transactions-cli.test.ts          -- Transactions CLI command tests
      snapshot.test.ts                  -- Snapshot service + sync integration (10 scenarios)
      networth.test.ts                  -- Net worth calculation tests (8 scenarios, includes super)
      super-import.test.ts              -- Super import integration tests (11 scenarios)
      super-networth.test.ts            -- Super net worth tests (5 scenarios)
    unit/                             -- Unit tests (pure functions)
  drizzle/                            -- Generated migrations (never hand-edit)
  config.example.jsonc                -- Example config (committed)
  config.schema.json                  -- JSON Schema for config.jsonc
  merchant-mappings.jsonc             -- Categorization rules (committed)
  merchant-mappings.schema.json       -- JSON Schema for merchant-mappings.jsonc
  drizzle.config.ts                   -- drizzle-kit config (dialect: sqlite, schema: ./src/db/schema.ts)
  biome.json                          -- Biome linter config
```

## Corpus Store Architecture

### Data Flow

```
Document (PDF/CSV/image) -> corpus raw-documents -> AI parser -> corpus ai-parse-results -> AI categorizer -> corpus ai-categorization-results -> pipeline (pure) -> corpus sync-results -> SQLite -> corpus computation-snapshots
```

### Stores

Defined in `src/corpus/stores.ts` using `define_store()` + `json_codec()`:

| Store | Type | Schema | Purpose |
|-------|------|--------|---------|
| `raw-transactions` | `RawTransactionsSnapshot` | `rawTransactionsSnapshotSchema` | Raw transaction arrays per account, per fetch |
| `raw-accounts` | `RawAccountsSnapshot` | `rawAccountsSnapshotSchema` | Raw account info per fetch |
| `raw-balances` | `RawBalancesSnapshot` | `rawBalancesSnapshotSchema` | Raw balance snapshots per fetch |
| `sync-results` | `SyncResultSnapshot` | `syncResultSnapshotSchema` | Categorized pipeline output with lineage |
| `raw-contributions` | `RawContributionsSnapshot` | `rawContributionsSnapshotSchema` | Raw super contribution data per import |
| `raw-documents` | `RawDocumentSnapshot` | `rawDocumentSnapshotSchema` | Full document content (base64 for binary, text for CSV) |
| `ai-parse-results` | `AiParseResultSnapshot` | `aiParseResultSnapshotSchema` | AI-extracted transactions and account info |
| `ai-categorization-results` | `AiCategorizationResultSnapshot` | `aiCategorizationResultSnapshotSchema` | AI categorization response data, suggested mappings, corpus lineage |
| `computation-snapshots` | `ComputationSnapshot` | `computationSnapshotSchema` | Net worth state after ingestion |

### Lineage

Ingestion creates a 5-store lineage chain: `raw-documents` → `ai-parse-results` → `ai-categorization-results` → `sync-results` → `computation-snapshots`.

Each store references its parents via the `parents` array on `put()`:

```ts
await ctx.corpus.stores["ai-parse-results"].put(parseResultSnapshot, {
  parents: [{ store_id: "raw-documents", version: docVersion }],
  tags: [`ingest-run:${ingestRunId}`],
});
```

This enables deterministic replay: re-run categorization from stored corpus snapshots.

### Backends

- Production: `create_file_backend({ base_path: config.corpus_dir })` (from `@f0rbit/corpus/file`)
- Testing: `create_memory_backend()` -- fast, isolated, no filesystem

Both go through `buildCorpus(backend)` which attaches all 9 stores via `.with_store()`.

## Key Patterns

### Error Handling

All error types are discriminated unions in `src/errors.ts`:

| Type | Codes |
|------|-------|
| `ProviderError` | `AUTH_FAILED`, `RATE_LIMITED`, `NOT_FOUND`, `API_ERROR`, `NETWORK_ERROR`, `PARSE_ERROR` |
| `ConfigError` | `CONFIG_NOT_FOUND`, `CONFIG_INVALID` |
| `DbError` | `DB_ERROR`, `DUPLICATE` |
| `PipelineError` | `MAPPING_LOAD_FAILED`, `CATEGORIZATION_FAILED`, `AI_CATEGORIZATION_FAILED` |
| `ExportError` | `WRITE_FAILED`, `VAULT_NOT_FOUND` |
| `AppError` | Union of all above |

Constructor helpers on the `errors` object: `errors.authFailed(msg)`, `errors.dbError(msg, cause)`, etc.

HTTP errors: `errors.fromFetchError(e: FetchError) -> ProviderError` maps status codes to error variants (401/403 -> `AUTH_FAILED`, 429 -> `RATE_LIMITED`, 404 -> `NOT_FOUND`, other -> `API_ERROR`).

### Provider Pattern

`BankProvider` interface in `src/providers/types.ts`:

```ts
interface BankProvider {
  readonly name: string;
  authenticate(): Promise<Result<void, ProviderError>>;
  getAccounts(): Promise<Result<AccountInfo[], ProviderError>>;
  fetchTransactions(accountId: string, range: DateRange): Promise<Result<RawTransaction[], ProviderError>>;
  getAccountBalances(): Promise<Result<AccountBalance[], ProviderError>>;
}
```

Implementations:

| Class | Module | Purpose |
|-------|--------|---------|
| `CsvBankProvider` | `src/providers/csv/provider.ts` | Manual CSV import (DD/MM/YYYY format, sha256 IDs) |
| `InMemoryBankProvider` | `src/providers/in-memory/provider.ts` | Testing: arrays + `failNextAuth`/`failNextFetch`/`failNextBalances` flags |

Factory: `createProvider(config, options?) -> Result<BankProvider, ConfigError>` in `src/providers/index.ts` switches on `config.provider` (`"csv"` | `"manual"`).

`SuperProvider` is now implemented (M2 complete). Forward-compatible interface: `InvestmentProvider` (M3).

### Super Provider

`SuperProvider` interface in `src/providers/types.ts`:

```ts
interface SuperProvider {
  readonly name: string;
  importBalances(): Promise<Result<SuperBalance[], ProviderError>>;
  importContributions(range: DateRange): Promise<Result<SuperContribution[], ProviderError>>;
}
```

Implementations:

| Class | Module | Purpose |
|-------|--------|---------|
| `ManualSuperProvider` | `src/providers/manual-super/provider.ts` | JSON file import (validates with Zod) |
| `InMemorySuperProvider` | `src/providers/in-memory/super-provider.ts` | Testing: arrays + fail flags |

### Document Parser

`DocumentParser` interface in `src/providers/types.ts`:

```ts
interface DocumentParser {
  readonly name: string;
  parseDocument(content: string, mimeType: string, accountHint?: string): Promise<Result<ParsedDocument, ProviderError>>;
}
```

Implementations:

| Class | Module | Purpose |
|-------|--------|---------|
| `AnthropicDocumentParser` | `src/providers/ai/parser.ts` | Production: Claude API for PDF, image, CSV, text extraction |
| `CsvDocumentParser` | `src/providers/csv/document-parser.ts` | CSV adapter: auto-detected by extension, structured parse without AI |
| `InMemoryDocumentParser` | `src/providers/in-memory/document-parser.ts` | Testing: canned responses + fail flags |

### AI Categorizer

`AiCategorizer` interface in `src/providers/types.ts`:

```ts
interface AiCategorizer {
  readonly name: string;
  categorize(request: AiCategorizationRequest): Promise<Result<AiCategorizationResult, ProviderError>>;
}
```

Implementations:

| Class | Module | Purpose |
|-------|--------|---------|
| `AnthropicAiCategorizer` | `src/providers/ai/categorizer.ts` | Production: Claude API for batch categorization |
| `InMemoryAiCategorizer` | `src/providers/in-memory/categorizer.ts` | Testing: configurable results + fail flags |

### Transaction Pipeline

Orchestrated by `categorizePipeline()` in `src/pipeline/categorizer.ts`.

```
PipelineContext = { mappings: MerchantMappings, rentConfig: RentConfig, aiCategorizer?: AiCategorizer }
```

Steps (sequential if-return, NOT pipe().flat_map()):

1. **Filter** (`filterTransaction`): Exclude credits and pattern-matched exclusions. Returns `Result<RawTransaction, ExcludedTransaction>`.
2. **Rent** (`isRentTransaction` + `handleRent`): Short-circuit if landlord or debit rent pattern matches. `calculateRentAmount()` handles solo vs. shared logic based on `solo_start_date`.
3. **Local mapping** (`matchTransaction` + `applyMapping`): Case-insensitive substring match against `merchant-mappings.jsonc` rules. `extractLocation` option extracts location suffix from description.
4. **AI batch categorization**: Batch all uncategorized transactions → Claude API → categorize + suggest mappings. Auto-appends suggested mappings to `merchant-mappings.jsonc` via `appendMappings()`. Non-fatal: if API fails, transactions proceed to fallback.
5. **Fallback** (`createFallback`): Category "Other", item = raw description. Only reached if AI absent or fails.

Batch function: `categorizeAll(transactions, context)` returns `{ categorized: CategorizedTransaction[], excluded: ExcludedTransaction[], aiCategorizationResult?: AiCategorizationResult }`.

Auto-mapping: AI categorization suggests merchant mappings which are auto-appended to `merchant-mappings.jsonc` via `appendMappings()` using `jsonc-parser` `modify()`/`applyEdits()`. This preserves JSONC comments and makes the system self-improving over time.

### Ingest Orchestration

`ingestDocument()` in `src/services/ingest-service.ts` -- 14-step process:

1. Create `sync_runs` row (cuid2 ID)
2. Read document from filesystem (PDF, CSV, image, text)
3. Compute content hash for dedup (skip if already ingested)
4. Snapshot document to `raw-documents` corpus store (base64 for binary, raw text for CSV)
5. Route to parser: CSV files auto-detected by extension → `CsvDocumentParser`, otherwise AI parser
6. Parser: send document to Claude API for extraction (or CSV parser: structured parse)
7. Snapshot parse results to `ai-parse-results` corpus store (with parent → raw-documents)
8. Resolve account (from `--account` flag or AI-extracted account info) → upsert into SQLite
9. Snapshot raw transactions to `raw-transactions` corpus store
10. Run categorization pipeline (`categorizeAll`) — includes AI batch categorization step
11. Snapshot AI categorization results to `ai-categorization-results` corpus store (if AI was used)
12. Snapshot sync results to `sync-results` corpus store (with parent → ai-categorization-results or ai-parse-results)
13. Materialize categorized transactions into SQLite (skip in dry-run, dedup by external_id)
14. Compute net worth → snapshot to `computation-snapshots` corpus store (with parent → sync-results)
15. Update `sync_runs` row with final counts, return `IngestSummary`

All files go through the unified `ingestDocument()` pipeline. CSV files are auto-detected by extension and use `CsvDocumentParser`; no `--parser csv` flag needed.

### Database

- Schema: `src/db/schema.ts` -- 6 tables: `syncRuns`, `accounts`, `transactions`, `snapshots`, `holdings`, `contributions` (id, accountId, date, type, amount, description)
- Client: `src/db/client.ts` -- `createDb(path)` (WAL mode + foreign keys), `createTestDb()` (in-memory)
- `AppContext = { db: AppDatabase, corpus: AppCorpus }` -- passed to all service functions
- `AppDatabase = ReturnType<typeof createDb>` (Drizzle instance with schema)
- Migrations: `drizzle/` directory (generated by `bunx drizzle-kit generate`)
- IDs: cuid2 via `$defaultFn(() => createId())`
- Tables reference each other: `transactions.accountId -> accounts.id`, `transactions.syncRunId -> syncRuns.id`, etc.
- Indexes: `transactions_external_id_idx` (unique), `transactions_date_idx`, `transactions_category_idx`, `snapshots_account_date_idx` (unique)

### Configuration

- `config.jsonc` -- user settings (gitignored), validated by `configSchema` (Zod)
  - `db_path`, `corpus_dir`, `vault_path`, `budget_dir`, `provider`, `anthropic?`, `sync`, `rent`
  - `anthropic` config: `model` (default `claude-sonnet-4-20250514`), `max_tokens` (default 4096)
  - `rent` config: `solo_start_date`, `solo_weekly_amount`, `shared_roommate_contribution`, `landlord_patterns`, `debit_rent_patterns`
- `config.example.jsonc` -- committed example
- `merchant-mappings.jsonc` -- categorization rules (committed)
  - Contains `mappings: MerchantMapping[]` and `exclusions: ExclusionRule[]`
  - Loaded by `loadMappings()` in `src/pipeline/local-mappings.ts`
- `ANTHROPIC_API_KEY` -- environment variable, read by `getAnthropicApiKey()`
- Rent config is in `config.jsonc`, NOT in merchant mappings

### Export

`exportToObsidian()` in `src/services/export-service.ts` writes Markdown notes with YAML frontmatter to an Obsidian vault. One file per transaction, slugified filenames with date prefix, dedup counter for collisions.

### Transaction Queries

Service functions in `src/services/transaction-service.ts`:

- `searchTransactions(db, query, limit?)` — LIKE search on `item` and `rawDescription` fields
- `getCategorySummary(db, filters?)` — category aggregation with totals and counts

## Value Types

Canonical enum arrays defined in `src/providers/types.ts`:

```ts
ACCOUNT_TYPES = ["transaction", "savings", "credit", "super", "investment"]
TRANSACTION_DIRECTIONS = ["debit", "credit"]
CATEGORIES = ["Rent", "Woolworths", "Eating Out", "Alcohol", "Subscriptions", "Transport", "Bills", "Health", "Entertainment", "Shopping", "Other"]
SYNC_STATUSES = ["success", "partial", "failed"]
CONTRIBUTION_TYPES = ["employer", "salary_sacrifice", "voluntary", "fhss", "government"]
```

## Categories

| Category | Description |
|----------|-------------|
| Rent | Housing rent payments (special pipeline logic, solo vs. shared calculation) |
| Woolworths | Grocery purchases (also mapped from Basiq "Groceries"/"Supermarkets") |
| Eating Out | Restaurants, fast food, coffee shops |
| Alcohol | Bars and alcohol purchases |
| Subscriptions | Recurring subscription and streaming services |
| Transport | Public transport, ride sharing, taxis |
| Bills | Utilities, internet, phone |
| Health | Pharmacy, doctor, health insurance, fitness |
| Entertainment | Movies, music, arts |
| Shopping | Clothing, electronics, home goods |
| Other | Fallback for uncategorized transactions |

## Common Tasks

### Adding a new merchant mapping

1. Add entry to `merchant-mappings.jsonc` under `mappings` array
2. Fields: `match` (substring), `item` (display name), `category` (from CATEGORIES), `extractLocation?` (boolean)
3. Run tests to verify: `bun test`

### Adding a new provider

1. Implement `BankProvider` interface in `src/providers/<name>/provider.ts`
2. Add in-memory variant for testing (or use `InMemoryBankProvider`)
3. Add case to `createProvider()` switch in `src/providers/index.ts`
4. Add provider name to `configSchema.provider` enum in `src/config.ts`
5. Re-export from `src/providers/index.ts`

### Adding a new CLI command

1. Create handler in `src/commands/<name>.ts`
2. Construct `AppContext { db, corpus }` from config via `createDb()` and `createCorpus()`
3. Register with `program.addCommand()` in `src/index.ts`

### Adding a new corpus store

1. Define Zod schema in `src/corpus/schemas.ts`
2. Define store in `src/corpus/stores.ts` using `define_store(name, json_codec(schema), { description })`
3. Register in `buildCorpus()` in `src/corpus/client.ts` with `.with_store()`
4. Export from `src/corpus/index.ts`

### Importing super contributions

1. Create a JSON file with `balances` (array of `{account_name, balance, as_of}`) and `contributions` (array of `{date, type, amount, description?}`)
2. Run `bun run dev -- super import <file.json>` with `--account-name` and `--account-type super`
3. ManualSuperProvider validates JSON with Zod, filters by date range
4. syncSuper orchestrates: upsert account → import balances → import contributions → corpus snapshot

### Adding a new DB table

1. Define table in `src/db/schema.ts` using `sqliteTable()`
2. Inline enum arrays if they come from `providers/types.ts` (drizzle-kit CJS limitation)
3. Use `satisfies readonly T[]` assertion to keep inlined arrays in sync with canonical types
4. Run `bun run db:generate && bun run db:migrate`

### Running migrations

```sh
bun run db:generate   # bunx drizzle-kit generate
bun run db:migrate    # bunx drizzle-kit migrate
```

### Running the CLI

```sh
bun run dev -- ingest statement.pdf --account "Everyday Account"
bun run dev -- ingest transactions.csv                          # CSV auto-detected by extension
bun run dev -- ingest bank-statement.pdf --dry-run --verbose
bun run dev -- accounts
bun run dev -- export
bun run dev -- mappings
bun run dev -- snapshot
bun run dev -- networth
bun run dev -- networth --history --format csv
bun run dev -- super balance
bun run dev -- super contributions
bun run dev -- super import data.json --account-name "My Super Fund"
bun run dev -- transactions list [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--category CAT] [--account ID] [--limit N]
bun run dev -- transactions summary [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--account ID]
bun run dev -- transactions search <query> [--limit N]
```

## Gotchas

- Dates are stored as `YYYY-MM-DD` text in both SQLite and corpus snapshots, not timestamps
- Transaction amounts are always positive; `direction` field (`"debit"` | `"credit"`) disambiguates
- `external_id` is the dedup key for transactions -- never insert without checking; `createTransaction()` throws a sentinel `{ __duplicate: true }` object caught by the `try_catch_async` error mapper to produce a `DUPLICATE` DbError
- Rent has special logic in the pipeline -- do NOT categorize via merchant mappings; it is handled by `isRentTransaction()` before mappings are checked
- `config.jsonc` is gitignored (contains user ID) -- `config.example.jsonc` is committed
- Corpus stores are async -- all `put`/`get` operations return Promises
- Pipeline functions are PURE -- they read from corpus snapshots, never call providers directly
- SQLite materialization is the LAST step -- after corpus `sync-results` are stored
- drizzle-kit CJS limitation: `src/db/schema.ts` inlines enum arrays with `satisfies` assertions to avoid cross-module `.js` extension import issues
- Corpus `create_file_backend` uses `base_path` (not `base_dir`) as the config key
- Pipeline categorizer does NOT use `pipe().flat_map()` for short-circuit -- uses sequential if-return pattern instead
- Biome enforces `noNonNullAssertion` -- use type predicate filters instead of `!`
- CSV provider generates deterministic external IDs via sha256 hash of `date|description|amount|direction`, truncated to 16 hex chars
- `InMemoryBankProvider` requires `authenticate()` before any other method -- returns `AUTH_FAILED` otherwise (matches real provider behavior)
- `filterTransaction()` returns `Result<RawTransaction, ExcludedTransaction>` -- the err case is NOT an error, it is a categorized exclusion (credits, matched exclusion rules)
- `AppDatabase` is a type alias for `ReturnType<typeof createDb>`, not a class -- do not `new` it
- AI-generated external IDs use `ai-${sha256(date|description|amount|direction)}` prefix
- Document dedup uses content hash -- re-ingesting same file detected before AI call
- AI parsing is non-deterministic -- same document may produce slightly different results across runs
- ANTHROPIC_API_KEY env var required for AI parsing and AI categorization, not needed for CSV-only ingestion
- Full document binary stored in corpus (base64 for PDFs/images, raw text for CSVs)
- AI categorization is non-fatal — API failure degrades gracefully to "Other" category
- `appendMappings()` preserves JSONC comments via `jsonc-parser` `modify()`/`applyEdits()`
- CSV fast path removed — all files go through unified `ingestDocument()` pipeline; CSV auto-detected by extension
- `InMemoryAiCategorizer` auto-generates suggested mappings from categorization results if none explicitly configured
- Real `merchant-mappings.jsonc` on disk may be modified by AI auto-mapping — tests should use isolated temp files or injected mappings

## M1: Snapshots + Net Worth

- `bun run dev -- snapshot` — capture current balances without full sync
- `bun run dev -- networth` — show current net worth breakdown
- `bun run dev -- networth --history --format csv` — net worth over time
- Snapshots table: unique constraint on (account_id, date) — upserts on conflict
- Net worth formula: `savings + transaction - credit` (super/investments added in M2/M3)
- `config.sync.auto_snapshot` (default true) controls whether sync materializes balances
- Carry-forward: net worth history uses last-known balance for accounts without a snapshot on a given date
- Service functions receive `AppDatabase`, not `AppContext` (they don't need corpus access)
- 82 tests passing across 10 files after M1

## M2: Superannuation Integration

- `bun run dev -- super balance` — show current super balance from snapshots
- `bun run dev -- super contributions` — list contribution history with summary
- `bun run dev -- super import <file>` — import from JSON file
- ManualSuperProvider validates JSON input with Zod schema
- Dedicated `raw-contributions` corpus store for imported data
- No `sync_runs` for super imports (lightweight flow)
- Contribution dedup: check-before-insert on (accountId, date, type, amount) — no unique constraint
- `computeNetWorth` includes super balances; `NetWorthBreakdown.components` has `super` field
- `super` keyword is valid as a TS property name in object literals and interfaces
- Services use `computeNetWorth()` which sums: savings + transaction - credit + super
- 98 tests passing across 12 files after M2
- 190 tests across ~20 files after AI Categorization + CLI feature

## Pivot: Basiq → AI Ingestion

- Basiq integration removed entirely (no bank API dependency)
- `budget ingest <file>` replaces both `budget sync` and `budget import`
- AI parser (AnthropicDocumentParser) handles PDFs, images, CSVs, any text
- CSV files auto-detected by extension, use `CsvDocumentParser` adapter (no `--parser csv` flag)
- Full ingestion pipeline: read → corpus store → AI parse → corpus → AI categorize → corpus → categorize → corpus → materialize → net worth → corpus
- 9 corpus stores total, 5-store lineage chain per ingestion
- Pipeline: filter → rent → local-mappings → AI batch categorization → fallback
- AI categorization auto-appends suggested merchant mappings to `merchant-mappings.jsonc`
- `transactions` CLI: list, summary, search commands for querying ingested data
