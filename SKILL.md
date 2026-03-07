# budget-sync -- AI Agent Skill

## Project Overview

Personal finance CLI tool. SQLite (Drizzle ORM) is the source of truth for queries.
Corpus stores are the source of truth for raw API data and sync results (versioned, with lineage).
Tracks: bank transactions, savings balances, super, investments, net worth.

## Tech Stack

- Runtime: Bun
- Database: SQLite + Drizzle ORM (`drizzle-orm/bun-sqlite`)
- Data stores: `@f0rbit/corpus` stores (`raw-transactions`, `raw-accounts`, `raw-balances`, `sync-results`)
- Error handling: `@f0rbit/corpus` `Result<T, E>` types -- never throw
  - `pipe()` for chaining, `flat_map()` for fallible steps
  - `fetch_result()` for HTTP calls (never raw fetch)
  - `try_catch` / `try_catch_async` for wrapping side effects
  - `Semaphore` for rate limiting (used in `BasiqClient` with concurrency 10)
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
    config.ts                         -- Zod schemas + loadConfig() / getBasiqApiKey()
    errors.ts                         -- Discriminated union error types + constructor helpers
    commands/
      sync.ts                         -- `budget-sync sync` command handler
      accounts.ts                     -- `budget-sync accounts` command handler
      mappings.ts                     -- `budget-sync mappings` command handler
      export.ts                       -- `budget-sync export` command handler
      import.ts                       -- `budget-sync import` command handler
      snapshot.ts                       -- `budget-sync snapshot` command handler
      networth.ts                       -- `budget-sync networth` command handler
    corpus/
      index.ts                        -- Barrel: re-exports AppCorpus, stores, snapshot types
      client.ts                       -- buildCorpus(), createCorpus(dataDir), createTestCorpus()
      stores.ts                       -- define_store() calls for all 4 stores
      schemas.ts                      -- Zod schemas for snapshot payloads
    db/
      schema.ts                       -- Drizzle table definitions (syncRuns, accounts, transactions, snapshots, holdings, contributions)
      client.ts                       -- createDb(path), createTestDb(), AppContext { db, corpus }
    providers/
      types.ts                        -- BankProvider interface, value types (RawTransaction, CategorizedTransaction, etc.), enum arrays (CATEGORIES, ACCOUNT_TYPES, etc.), InvestmentProvider / SuperProvider (forward-compat)
      index.ts                        -- createProvider(config) factory, re-exports all provider classes
      basiq/
        client.ts                     -- BasiqClient: authenticate (JWT), get<T>(), getAllPages(), Semaphore rate limiter
        provider.ts                   -- BasiqBankProvider implements BankProvider
        types.ts                      -- Zod schemas for Basiq API responses (accounts, transactions, enrichment, token)
      csv/
        provider.ts                   -- CsvBankProvider: parses DD/MM/YYYY CSV, generates sha256 external IDs
      in-memory/
        provider.ts                   -- InMemoryBankProvider: arrays + fail flags for testing
    pipeline/
      categorizer.ts                  -- categorizePipeline(tx, context), categorizeAll(txs, context)
      filter.ts                       -- filterTransaction(tx, exclusions) -> Result<RawTransaction, ExcludedTransaction>
      rent.ts                         -- isRentTransaction(), calculateRentAmount(), handleRent()
      local-mappings.ts               -- loadMappings(path?), matchTransaction(), applyMapping()
      enrich-mapper.ts                -- mapEnrichmentCategory(), applyEnrichment(), createFallback()
    services/
      sync-service.ts                 -- syncTransactions(ctx, provider, config, options) -- 10-step orchestrator
      account-service.ts              -- upsertAccount(), listAccounts(), deactivateAccount(), findAccountByExternalId()
      transaction-service.ts          -- createTransaction(), getTransactions(filters), getUncategorized()
      export-service.ts               -- exportToObsidian(db, vaultPath, budgetDir, options)
      snapshot-service.ts               -- upsertSnapshot(), getLatestSnapshots(), getSnapshotHistory()
      networth-service.ts               -- getCurrentNetWorth(), getNetWorthHistory() with carry-forward
  __tests__/
    integration/                      -- Integration tests (in-memory DB + corpus)
      snapshot.test.ts                  -- Snapshot service + sync integration (10 scenarios)
      networth.test.ts                  -- Net worth calculation tests (8 scenarios)
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
BankProvider -> corpus raw stores -> pipeline (pure) -> corpus sync-results -> SQLite
```

### Stores

Defined in `src/corpus/stores.ts` using `define_store()` + `json_codec()`:

| Store | Type | Schema | Purpose |
|-------|------|--------|---------|
| `raw-transactions` | `RawTransactionsSnapshot` | `rawTransactionsSnapshotSchema` | Raw transaction arrays per account, per fetch |
| `raw-accounts` | `RawAccountsSnapshot` | `rawAccountsSnapshotSchema` | Raw account info per fetch |
| `raw-balances` | `RawBalancesSnapshot` | `rawBalancesSnapshotSchema` | Raw balance snapshots per fetch |
| `sync-results` | `SyncResultSnapshot` | `syncResultSnapshotSchema` | Categorized pipeline output with lineage |

### Lineage

`sync-results` snapshots reference their source `raw-transactions` via the `parents` array on `put()`:

```ts
await ctx.corpus.stores["sync-results"].put(syncResultSnapshot, {
  parents: rawSnapshotVersions.map((version) => ({
    store_id: "raw-transactions",
    version,
  })),
  tags: [`sync-run:${syncRunId}`, `provider:${provider.name}`],
});
```

This enables deterministic replay: re-run categorization from stored corpus snapshots.

### Backends

- Production: `create_file_backend({ base_path: config.corpus_dir })` (from `@f0rbit/corpus/file`)
- Testing: `create_memory_backend()` -- fast, isolated, no filesystem

Both go through `buildCorpus(backend)` which attaches all 4 stores via `.with_store()`.

## Key Patterns

### Error Handling

All error types are discriminated unions in `src/errors.ts`:

| Type | Codes |
|------|-------|
| `ProviderError` | `AUTH_FAILED`, `RATE_LIMITED`, `NOT_FOUND`, `API_ERROR`, `NETWORK_ERROR`, `PARSE_ERROR` |
| `ConfigError` | `CONFIG_NOT_FOUND`, `CONFIG_INVALID` |
| `DbError` | `DB_ERROR`, `DUPLICATE` |
| `PipelineError` | `MAPPING_LOAD_FAILED`, `CATEGORIZATION_FAILED` |
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
  enrichTransaction?(description: string): Promise<Result<EnrichmentData, ProviderError>>;
}
```

Implementations:

| Class | Module | Purpose |
|-------|--------|---------|
| `BasiqBankProvider` | `src/providers/basiq/provider.ts` | Production: Basiq CDR API via `BasiqClient` |
| `CsvBankProvider` | `src/providers/csv/provider.ts` | Manual CSV import (DD/MM/YYYY format, sha256 IDs) |
| `InMemoryBankProvider` | `src/providers/in-memory/provider.ts` | Testing: arrays + `failNextAuth`/`failNextFetch`/`failNextBalances` flags |

Factory: `createProvider(config, options?) -> Result<BankProvider, ConfigError>` in `src/providers/index.ts` switches on `config.provider` (`"basiq"` | `"csv"` | `"manual"`).

Forward-compatible interfaces also defined: `InvestmentProvider` (M3), `SuperProvider` (M2).

### Transaction Pipeline

Orchestrated by `categorizePipeline()` in `src/pipeline/categorizer.ts`.

```
PipelineContext = { mappings: MerchantMappings, rentConfig: RentConfig, enrichTransaction?: fn }
```

Steps (sequential if-return, NOT pipe().flat_map()):

1. **Filter** (`filterTransaction`): Exclude credits and pattern-matched exclusions. Returns `Result<RawTransaction, ExcludedTransaction>`.
2. **Rent** (`isRentTransaction` + `handleRent`): Short-circuit if landlord or debit rent pattern matches. `calculateRentAmount()` handles solo vs. shared logic based on `solo_start_date`.
3. **Local mapping** (`matchTransaction` + `applyMapping`): Case-insensitive substring match against `merchant-mappings.jsonc` rules. `extractLocation` option extracts location suffix from description.
4. **Inline enrichment** (`mapEnrichmentCategory` + `applyEnrichment`): Use enrichment data already on the transaction (from Basiq). Static `ENRICHMENT_CATEGORY_MAP` maps Basiq categories to local categories.
5. **API enrichment**: Call `context.enrichTransaction(description)` if available. Non-fatal on failure.
6. **Fallback** (`createFallback`): Category "Other", item = raw description.

Batch function: `categorizeAll(transactions, context)` returns `{ categorized: CategorizedTransaction[], excluded: ExcludedTransaction[] }`.

### Sync Orchestration

`syncTransactions()` in `src/services/sync-service.ts` -- 10-step process:

1. Create `sync_runs` row (cuid2 ID)
2. Authenticate provider
3. Discover accounts -> snapshot to `raw-accounts` corpus store -> upsert into SQLite
4. Fetch transactions per account -> snapshot each to `raw-transactions` corpus store
5. Fetch balances -> snapshot to `raw-balances` corpus store (non-fatal)
5.5. Materialize balances to snapshots SQLite table (gated by `auto_snapshot`, non-fatal)
6. Run categorization pipeline (`categorizeAll`)
7. Snapshot sync results to `sync-results` corpus store (with `parents` linking to raw-transactions versions)
8. Materialize categorized transactions into SQLite (skip in dry-run, dedup by external_id)
9. Update `sync_runs` row with final counts
10. Return `SyncSummary`

### Database

- Schema: `src/db/schema.ts` -- 6 tables: `syncRuns`, `accounts`, `transactions`, `snapshots`, `holdings`, `contributions`
- Client: `src/db/client.ts` -- `createDb(path)` (WAL mode + foreign keys), `createTestDb()` (in-memory)
- `AppContext = { db: AppDatabase, corpus: AppCorpus }` -- passed to all service functions
- `AppDatabase = ReturnType<typeof createDb>` (Drizzle instance with schema)
- Migrations: `drizzle/` directory (generated by `bunx drizzle-kit generate`)
- IDs: cuid2 via `$defaultFn(() => createId())`
- Tables reference each other: `transactions.accountId -> accounts.id`, `transactions.syncRunId -> syncRuns.id`, etc.
- Indexes: `transactions_external_id_idx` (unique), `transactions_date_idx`, `transactions_category_idx`, `snapshots_account_date_idx` (unique)

### Configuration

- `config.jsonc` -- user settings (gitignored), validated by `configSchema` (Zod)
  - `db_path`, `corpus_dir`, `vault_path`, `budget_dir`, `provider`, `basiq?`, `sync`, `rent`
  - `rent` config: `solo_start_date`, `solo_weekly_amount`, `shared_roommate_contribution`, `landlord_patterns`, `debit_rent_patterns`
- `config.example.jsonc` -- committed example
- `merchant-mappings.jsonc` -- categorization rules (committed)
  - Contains `mappings: MerchantMapping[]` and `exclusions: ExclusionRule[]`
  - Loaded by `loadMappings()` in `src/pipeline/local-mappings.ts`
- `BASIQ_API_KEY` -- environment variable, read by `getBasiqApiKey()`
- Rent config is in `config.jsonc`, NOT in merchant mappings

### Export

`exportToObsidian()` in `src/services/export-service.ts` writes Markdown notes with YAML frontmatter to an Obsidian vault. One file per transaction, slugified filenames with date prefix, dedup counter for collisions.

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
bun run dev -- sync
bun run dev -- accounts
bun run dev -- export
bun run dev -- import
bun run dev -- mappings
bun run dev -- snapshot
bun run dev -- networth
bun run dev -- networth --history --format csv
```

## Gotchas

- Dates are stored as `YYYY-MM-DD` text in both SQLite and corpus snapshots, not timestamps
- Transaction amounts are always positive; `direction` field (`"debit"` | `"credit"`) disambiguates
- `external_id` is the dedup key for transactions -- never insert without checking; `createTransaction()` throws a sentinel `{ __duplicate: true }` object caught by the `try_catch_async` error mapper to produce a `DUPLICATE` DbError
- Rent has special logic in the pipeline -- do NOT categorize via merchant mappings; it is handled by `isRentTransaction()` before mappings are checked
- Basiq JWT expires -- `BasiqClient.authenticate()` caches token and refreshes 60s before expiry
- `config.jsonc` is gitignored (contains user ID) -- `config.example.jsonc` is committed
- Corpus stores are async -- all `put`/`get` operations return Promises
- Pipeline functions are PURE -- they read from corpus snapshots, never call providers directly (except optional `enrichTransaction` callback)
- SQLite materialization is the LAST step -- after corpus `sync-results` are stored
- drizzle-kit CJS limitation: `src/db/schema.ts` inlines enum arrays with `satisfies` assertions to avoid cross-module `.js` extension import issues
- Corpus `create_file_backend` uses `base_path` (not `base_dir`) as the config key
- Pipeline categorizer does NOT use `pipe().flat_map()` for short-circuit -- uses sequential if-return pattern instead
- Biome enforces `noNonNullAssertion` -- use type predicate filters instead of `!`
- `BasiqClient.get()` uses a `Semaphore(10)` for rate limiting -- the `try/finally` in that method is the ONE place a try block is acceptable (for semaphore release)
- CSV provider generates deterministic external IDs via sha256 hash of `date|description|amount|direction`, truncated to 16 hex chars
- `InMemoryBankProvider` requires `authenticate()` before any other method -- returns `AUTH_FAILED` otherwise (matches real provider behavior)
- `filterTransaction()` returns `Result<RawTransaction, ExcludedTransaction>` -- the err case is NOT an error, it is a categorized exclusion (credits, matched exclusion rules)
- `AppDatabase` is a type alias for `ReturnType<typeof createDb>`, not a class -- do not `new` it

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
