# budget-sync — Agent Reference

Personal finance CLI. Ingests bank documents (PDF/CSV/image) via Claude, categorizes transactions
against local merchant mappings, tracks net worth (transaction + savings + super − credit), and
exports to Obsidian. SQLite (Drizzle) is the source of truth for queries; `@f0rbit/corpus` stores
are the source of truth for raw document data, AI parse results, and sync lineage.

For a runnable usage guide (setup, monthly routine, recipes for every command), see `README.md`.
This file is the team/agent-facing source of truth: structure, conventions, gotchas.

## Tech stack

- Runtime: Bun
- Database: SQLite + Drizzle ORM (`drizzle-orm/bun-sqlite`)
- Data stores: `@f0rbit/corpus` — 9 stores (`raw-transactions`, `raw-accounts`, `raw-balances`,
  `sync-results`, `raw-contributions`, `raw-documents`, `ai-parse-results`,
  `ai-categorization-results`, `computation-snapshots`)
- AI parsing/categorization: `@anthropic-ai/sdk` (Claude)
- Error handling: `@f0rbit/corpus` `Result<T, E>` types — never throw
  - `pipe()` for chaining, `flat_map()` for fallible steps
  - `try_catch` / `try_catch_async` for wrapping side effects
  - `parallel_map()` for concurrent operations
- Validation: Zod schemas (config, corpus snapshot payloads, super import JSON)
- CLI: Commander (`commander`)
- Config: JSONC (`jsonc-parser`) + JSON Schema (`config.schema.json`, `merchant-mappings.schema.json`)
- Testing: `bun test` — in-memory SQLite (`createTestDb()`), in-memory corpus
  (`create_memory_backend()`), in-memory providers (Provider pattern, never mocks)
- IDs: cuid2 (`@paralleldrive/cuid2`)
- Linter/formatter: Biome (`@biomejs/biome`)

## Structure

```
src/
  index.ts              CLI entrypoint — Commander program, registers commands
  config.ts              Zod schemas + loadConfig() / getAnthropicApiKey()
  errors.ts               Discriminated union error types + constructor helpers
  commands/                One handler per top-level CLI command
    ingest.ts, accounts.ts, mappings.ts, export.ts, networth.ts, super.ts, transactions.ts
  corpus/                  buildCorpus(), 9 define_store() calls, Zod snapshot schemas
  db/                      Drizzle schema (6 tables), createDb()/createTestDb(), AppContext
  providers/               BankProvider / SuperProvider / DocumentParser / AiCategorizer
                           interfaces + production (ai/, csv/, manual-super/) + in-memory/
                           implementations, per the Provider pattern (design-philosophy #5)
  pipeline/                Pure categorization pipeline: filter -> rent -> local-mappings ->
                           AI batch categorization -> fallback; dedup.ts (cross-account)
  services/                Orchestrators: ingest-service (17-step), account-service,
                           transaction-service, mapping-apply-service, export-service,
                           snapshot-service, networth-service, contribution-service,
                           super-sync-service
  reporting/               Pure functions over ReportTransaction[] — no DB access, unit-tested
                           with hand-built rows (summary.ts, monthly.ts, recurring.ts)
__tests__/
  integration/             In-memory DB + corpus, exercises services/pipeline end-to-end
  unit/                    Pure function tests (dedup, reporting)
drizzle/                  Generated migrations — never hand-edit
config.example.jsonc      Committed example (config.jsonc itself is gitignored)
config.schema.json
merchant-mappings.jsonc   Categorization rules (committed) — mappings + exclusions
merchant-mappings.schema.json
```

## Corpus lineage

`Document -> raw-documents -> AI/CSV parser -> ai-parse-results -> AI categorizer ->
ai-categorization-results -> pipeline (pure) -> sync-results -> SQLite -> computation-snapshots`.

Each store references its parent via `parents: [{ store_id, version }]` on `put()`, enabling
deterministic replay from stored corpus snapshots. Production backend:
`create_file_backend({ base_path: config.corpus_dir })`; test backend: `create_memory_backend()`.

## Conventions

- **Result types everywhere** — services and pipeline functions return `Result<T, AppError>`;
  never throw. `errors.ts` holds discriminated unions (`ProviderError`, `ConfigError`, `DbError`,
  `PipelineError`, `ExportError`) with constructor helpers (`errors.dbError(msg, cause)`, etc).
- **Zod as source of truth** for config, corpus snapshot payloads, and super-import JSON — types
  are inferred, not hand-annotated.
- **Provider pattern** — every external boundary (bank documents, AI categorizer, super import) is
  an interface with a production implementation and an `InMemory*` implementation for tests.
- **Pipeline functions are pure** — read from corpus snapshots / in-memory data, never call
  providers directly. SQLite materialization is always the LAST step, after `sync-results` are
  stored in corpus.
- **Canonical enums** live in `src/providers/types.ts` (`ACCOUNT_TYPES`, `CATEGORIES`,
  `TRANSACTION_DIRECTIONS`, `SYNC_STATUSES`, `CONTRIBUTION_TYPES`). `src/db/schema.ts` inlines a
  `satisfies readonly T[]`-asserted copy of the enums that feed `text({ enum })` columns
  (drizzle-kit CJS import limitation) — keep both in sync by hand when adding a category.
- **Amounts are always positive**; `direction` (`"debit"|"credit"`) disambiguates. Dates are
  `YYYY-MM-DD` text, not timestamps, in both SQLite and corpus snapshots.
- **`external_id` is the transaction dedup key** — never insert without checking.
  `createTransaction()` throws a sentinel object caught by `try_catch_async` to produce a
  `DUPLICATE` DbError.

## Verbs

- `bun run gate` — typecheck -> test -> lint, fail-fast. **There is no CI** — this repo has no
  GitHub Actions workflow. The convention is: run `gate` locally, then squash-merge the PR
  yourself once it's green. Don't wait on checks that don't exist.
- `bun run dev -- <command>` — run the CLI (`bun run src/index.ts <command>`)
- `bun run typecheck` / `bun run test` / `bun run lint` / `bun run lint:fix`
- `bun run db:generate` / `bun run db:migrate` / `bun run db:studio`

## Data and backups

- `data/` (gitignored) holds `budget-sync.db` (+ `-wal`/`-shm`) and `data/corpus/` (the corpus file
  backend). Both are the user's real financial data — never touch outside an explicit ask.
- Backup convention observed in this repo: manual copies as `budget-sync.db.backup-<YYYYMMDD>`
  (optionally `-HHMM`) before risky operations (schema migration, bulk `mappings apply --force`,
  account merges). There's no automated backup job — take a copy yourself before anything
  destructive.
- Removing WAL/SHM files from a SQLite WAL-mode database can lose uncommitted data — never delete
  them while the DB might have pending writes.
- `data/corpus` is append-only lineage (every corpus `put()` is a new version) — it's the audit
  trail for "what did the AI actually extract/categorize on ingest N", useful for debugging bad
  categorizations or replaying a pipeline change without re-parsing the source document. Rarely
  needs direct inspection; reach for it only when SQLite state doesn't explain what happened.

## How categorization works

The pipeline (`src/pipeline/categorizer.ts`, sequential if-return, not `pipe().flat_map()`):

1. **Filter** (`filterTransaction`) — pattern-matched exclusions from `merchant-mappings.jsonc`
   `exclusions` array, applied to both directions. The `err` case is not an error — it's a
   categorized exclusion (own-account transfers, credit card payments, investment purchases).
2. **Rent** (`isRentTransaction` + `handleRent`) — debit-only short-circuit for `config.jsonc`'s
   `rent.landlord_patterns` / `rent.debit_rent_patterns`. Solo vs. shared split via
   `rent.solo_start_date`. Do NOT add rent merchants to `merchant-mappings.jsonc` — this stage
   runs before mappings and owns rent exclusively.
3. **Local mapping** (`matchTransaction` + `applyMapping`) — case-insensitive substring match
   against `merchant-mappings.jsonc` `mappings` array. A credit hitting a spend-category mapping
   is routed to `Refund` (item preserved), never a spend category.
4. **AI batch categorization** — uncategorized transactions batched to Claude, which categorizes
   and suggests new mappings. Suggested mappings are auto-appended to `merchant-mappings.jsonc` via
   `appendMappings()` (preserves JSONC comments via `jsonc-parser` `modify()`/`applyEdits()`).
   Non-fatal: API failure degrades to fallback.
5. **Fallback** (`createFallback`) — debits -> `Other`; credits -> `Income` with
   `notes = UNMAPPED_CREDIT_NOTE`. Credits never fall back to a spend category.

`isUnmappedRow(row)` (`transaction-service.ts`) = `category === "Other" || notes ===
UNMAPPED_CREDIT_NOTE` — the one predicate `mappings unmapped` and `mappings apply` use for "needs
mapping". Adding a mapping later re-categorizes flagged rows and clears the note.

**Fixing categorization after the fact**: `mappings apply [--dry-run] [--force]` re-runs mappings
+ exclusions over existing SQLite rows (no re-ingest). Exclusion rules always win; recategorization
only touches rows currently `Other` unless `--force`. For one-off fixes, `transactions set <id...>
--category <c>` (or `--match <substring> --from <date> --to <date>` as an alternative selector).

**Cross-account dedup** (`src/pipeline/dedup.ts`) — same purchase appearing in multiple account
statements (credit card charge + savings repayment): matches on exact amount + exact item
(case-insensitive) + date within 5 days + different accounts; priority credit(3) > transaction(2)
> savings(1), lower-priority duplicate excluded. Runs on ALL existing DB transactions, not just the
current ingest batch, so adding a new account and re-ingesting catches dupes retroactively.

## Gotchas

- **Bun auto-loads `.env`** — `env -u ANTHROPIC_API_KEY bun run dev -- ...` does NOT disable AI;
  Bun repopulates the var from `.env` regardless of what the parent shell unset. To force a
  CSV-only, non-AI run: `ANTHROPIC_API_KEY="" bun run dev -- ingest ...` (an explicit empty value
  is not overridden by `.env`).
- **Accounts resolve by name**, not by provider/institution. `upsertAccount()` matches by name
  (case-insensitive, active accounts only) first — re-ingesting the same account under a different
  provider/institution/type/parser reuses the existing row and refreshes its metadata. Legacy
  `(external_id, provider)` matching is a fallback only. Duplicate account rows predating this fix
  can be folded together with `accounts merge <from-id> <into-id> [--dry-run]` (moves every
  referencing row across 4 tables inside one transaction, aborts wholesale on a unique-index
  conflict).
- **Content-hash dedup does NOT skip re-ingest.** The document hash is stored on the corpus doc for
  audit only — nothing checks it before re-parsing. Re-running `ingest` on an already-ingested file
  re-parses and re-categorizes, but `createTransaction()` still dedups by `external_id` per
  transaction and reports skipped counts, so it's idempotent for rows that already exist and only
  materializes genuinely new ones. It is NOT a cheap no-op — it costs a full AI parse + categorize
  pass if `ANTHROPIC_API_KEY` is set.
- **CSV `From\s+<acct>` padding varies by bank export** — the whitespace between a transfer label
  and the account number is inconsistent (`To 1310068128040` vs `From    1310068128040`, 4 spaces).
  Write exclusion `match` patterns as `From\\s+<acct>`, not a literal single space, or the rule
  silently won't match some files. Exclusion `match` is a regex; mapping `match` is a plain
  substring — don't mix the two mental models up when editing `merchant-mappings.jsonc`.
- **Dry-run reports 0 counts, by design** — `ingest --dry-run` and `mappings apply --dry-run` skip
  the SQLite write step entirely, so the summary's materialized/updated counts are legitimately 0;
  read the preview table/rows, not the count line, to judge what would happen.
- **`--account-type` has no default on `ingest`** — when omitted, the AI-inferred type is used,
  falling back to `"transaction"` only if AI doesn't infer one. Don't assume a bare `ingest` call
  defaults to `transaction`.
- Rent and cross-account dedup are debit-only — a credit matching a landlord pattern is a bond
  refund, not rent.
- `AppDatabase` is `ReturnType<typeof createDb>`, a type alias, not a class — don't `new` it.
- Biome enforces `noNonNullAssertion` — use type predicate filters instead of `!`.
- `config.jsonc` is gitignored (contains real personal data); `config.example.jsonc` is the
  committed template — copy it, don't edit it in place expecting it to stay generic.

## Categories

`Rent, Woolworths, Eating Out, Alcohol, Subscriptions, Transport, Bills, Health, Entertainment,
Shopping, Travel, Income, Refund, Other`. Credits may only land in `Income`, `Refund`, or excluded
— never a spend category. Adding a category requires touching three places: `CATEGORIES` in
`providers/types.ts`, the inlined copy in `db/schema.ts`, and `merchant-mappings.schema.json`; the
typecheck fails until `CATEGORY_DESCRIPTIONS` is extended too, which is what forces every touch
point.

## Testing

In-memory everywhere: `createTestDb()` (in-memory SQLite), `create_memory_backend()` (in-memory
corpus), `InMemoryBankProvider` / `InMemorySuperProvider` / `InMemoryDocumentParser` /
`InMemoryAiCategorizer` (arrays + `failNext*` flags for testing error paths). Integration tests
(`__tests__/integration/`) exercise services/pipeline end-to-end against these fakes; unit tests
(`__tests__/unit/`) cover pure functions (dedup, reporting math) with hand-built rows — no DB or
corpus needed. Real `merchant-mappings.jsonc` on disk may be mutated by AI auto-mapping, so tests
that touch mappings use isolated temp files or injected mapping objects, never the real file.
