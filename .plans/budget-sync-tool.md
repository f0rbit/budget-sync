# Budget Sync Tool — Implementation Plan

## Executive Summary

A CLI tool (separate repo at `/Users/tom/dev/budget-sync`) that fetches transactions from bank APIs via a provider-agnostic interface, categorizes them through a local-mapping-first pipeline, and creates Obsidian markdown notes in `Budget/`. The first provider is Basiq (Australian CDR intermediary). The tool uses flat-file state (JSON) for sync tracking and duplicate prevention — no database. CLI built with Commander, merchant mappings in JSONC with JSON Schema for IDE autocomplete.

---

## Architecture Overview

```
CLI (bun run sync / accounts / mappings)
 │
 ├── SyncOrchestrator
 │    ├── BankProvider (interface)
 │    │    └── BasiqProvider (first impl)
 │    │         ├── Auth (API key → JWT)
 │    │         ├── Transactions (paginated fetch)
 │    │         └── Enrich (merchant lookup)
 │    │
 │    ├── TransactionFilter
 │    │    └── ExclusionRules (cc payments, savings, investments, etc.)
 │    │
 │    ├── Categorizer (pipeline)
 │    │    ├── 1. LocalMappingLookup (merchant-mappings.yaml)
 │    │    ├── 2. EnrichLookup (Basiq Enrich API, optional)
 │    │    └── 3. Fallback ("Other" + raw description in notes)
 │    │
 │    ├── RentHandler (special logic for rent calculation)
 │    │
 │    ├── DuplicateDetector
 │    │    ├── State file (imported tx IDs)
 │    │    └── Filesystem scan (existing notes by date+amount)
 │    │
 │    └── NoteWriter
 │         ├── Formats frontmatter YAML
 │         ├── Generates filenames with dedup suffixes
 │         └── Dry-run mode (print without writing)
 │
 └── StateManager (.budget-sync-state.json)
      ├── Last sync date per account
      └── Set of imported transaction IDs
```

## Provider Interface Design

```typescript
// src/providers/types.ts

type TransactionDirection = "debit" | "credit";

interface RawTransaction {
  id: string;                       // Provider-specific unique ID
  description: string;              // Raw bank description
  amount: number;                   // Always positive
  direction: TransactionDirection;  // debit = money out, credit = money in
  transactionDate: string;          // YYYY-MM-DD (when it happened)
  postDate: string;                 // YYYY-MM-DD (when it posted)
  accountId: string;                // Which account this came from
  enrichment?: {                    // Optional provider-side enrichment
    merchantName?: string;
    category?: string;
    location?: string;
  };
}

interface AccountInfo {
  id: string;
  name: string;
  institution: string;
  type: "credit" | "debit" | "savings" | "other";
  lastSynced?: string;             // ISO date
}

interface DateRange {
  from: string;  // YYYY-MM-DD
  to: string;    // YYYY-MM-DD
}

interface BankProvider {
  name: string;
  authenticate(): Promise<Result<void, AuthError>>;
  getAccounts(): Promise<Result<AccountInfo[], ProviderError>>;
  fetchTransactions(
    accountId: string,
    range: DateRange
  ): Promise<Result<RawTransaction[], ProviderError>>;
  enrichTransaction?(
    description: string
  ): Promise<Result<RawTransaction["enrichment"], ProviderError>>;
}
```

Key design decisions:
- `enrichTransaction` is optional on the interface — not all providers offer enrichment.
- `amount` is always positive; `direction` disambiguates. This matches Basiq's model and is easy to normalize from CSV.
- Provider returns raw data. All mapping/categorization/filtering happens outside the provider.

### In-Memory Provider (for testing)

```typescript
class InMemoryBankProvider implements BankProvider {
  name = "in-memory";
  transactions: RawTransaction[] = [];
  accounts: AccountInfo[] = [];

  // Pre-load test data
  addTransactions(...txs: RawTransaction[]) { ... }
  addAccounts(...accts: AccountInfo[]) { ... }

  async authenticate() { return ok(undefined); }
  async getAccounts() { return ok(this.accounts); }
  async fetchTransactions(accountId, range) {
    return ok(this.transactions.filter(tx =>
      tx.accountId === accountId &&
      tx.transactionDate >= range.from &&
      tx.transactionDate <= range.to
    ));
  }
}
```

---

## Categorization Pipeline Design

The pipeline processes each `RawTransaction` and produces a `CategorizedTransaction`:

```typescript
interface CategorizedTransaction {
  date: string;           // YYYY-MM-DD
  item: string;           // Human-readable name
  amount: number;         // Final amount (after rent adjustments etc.)
  category: Category;     // One of the 11 categories
  notes: string;          // Context or "" if clean match
  sourceId: string;       // Original provider transaction ID
  excluded: boolean;      // Whether to skip this transaction
  excludeReason?: string; // Why it was excluded
}
```

### Step 1: Exclusion Filter

Check transaction against exclusion rules FIRST:
- `direction === "credit"` → exclude (unless whitelisted pattern like debit rent)
- Description matches cc payment patterns (`To 460184...`)
- Description matches savings transfer patterns (`To 131007...`, `To 900021...`)
- Description matches investment patterns (`Betashares Direct`)
- Description matches roommate patterns (`Rent Mr Maxwell Wallace Bruce`)
- Description matches reimbursement patterns (Osko incoming, Beem incoming)

Exclusion rules are defined as a list of `ExclusionRule` objects:

```typescript
interface ExclusionRule {
  name: string;
  test: (tx: RawTransaction) => boolean;
}
```

### Step 2: Rent Special Handling

If the description matches rent patterns (`IPY*GRACZYKTHOMPSON`, `Internet Withdrawal ... Rent`):
- Check the date:
  - `>= 2026-03-01`: amount = 650, notes = ""
  - `< 2026-03-01` and Graczyk Thompson: amount = original - 450, notes = "Total $X minus $450 roommate contribution"
  - `< 2026-03-01` and debit rent: amount = face value
- Set item = "Rent", category = "Rent"
- Return early (skip remaining pipeline)

### Step 3: Local Mapping Lookup

Load `merchant-mappings.jsonc` — a list of rules with JSON Schema for autocomplete:

```jsonc
// merchant-mappings.jsonc
{
  "$schema": "./merchant-mappings.schema.json",
  "mappings": [
    // Alcohol
    { "match": "FIREFLY BRISBANE", "item": "Firefly Brisbane", "category": "Alcohol" },
    { "match": "DAN MURPHY", "item": "Dan Murphy's", "category": "Alcohol" },

    // Eating Out
    { "match": "MISO HUNGRY", "item": "Miso Hungry", "category": "Eating Out" },

    // Woolworths — extract location suffix from description
    { "match": "WOOLWORTHS/", "item": "Woolworths", "category": "Woolworths", "extractLocation": true }

    // ... 30+ more from AGENTS.md
  ]
}
```

Matching is case-insensitive substring match. First match wins. If `extractLocation` is true, attempt to pull a location suffix from the raw description.

The JSON Schema (`merchant-mappings.schema.json`) provides autocomplete for `category` values (enum of 11 categories), required fields, and descriptions.

### Step 4: Basiq Enrich Fallback

If no local mapping matched AND the provider implements `enrichTransaction`:
- Call enrich with the raw description
- Map the returned category to one of the 11 local categories (Basiq uses different category names)
- Use the merchant name as the `item`
- Add `notes: "Auto-categorized via Basiq Enrich"` for review

### Step 5: Final Fallback

If nothing matched:
- `category: "Other"`
- `item`: cleaned-up version of raw description (title-cased, trimmed)
- `notes: "Uncategorized: [raw description]"` for manual review

---

## File Structure

```
/Users/tom/dev/budget-sync/
├── package.json
├── tsconfig.json
├── biome.json
├── .env                              # BASIQ_API_KEY (gitignored)
├── .gitignore
├── config.jsonc                      # User configuration (gitignored — contains user ID)
├── merchant-mappings.jsonc           # Merchant → category mappings
├── merchant-mappings.schema.json     # JSON Schema for autocomplete
├── .budget-sync-state.json           # Sync state (gitignored)
├── src/
│   ├── index.ts                      # CLI entry point (Commander)
│   ├── commands/
│   │   ├── sync.ts                   # sync command handler
│   │   ├── accounts.ts               # accounts command handler
│   │   └── mappings.ts               # mappings command handler
│   ├── config.ts                     # Config loading + Zod validation
│   ├── types.ts                      # Shared types + Zod schemas
│   ├── errors.ts                     # Error types for Result<T,E>
│   ├── providers/
│   │   ├── types.ts                  # BankProvider interface
│   │   ├── basiq.ts                  # Basiq API implementation
│   │   └── in-memory.ts             # In-memory test implementation
│   ├── pipeline/
│   │   ├── filter.ts                 # Exclusion rules
│   │   ├── categorizer.ts           # Categorization pipeline orchestrator
│   │   ├── rent.ts                   # Rent special handling
│   │   ├── local-mappings.ts        # JSONC mapping loader + matcher
│   │   └── enrich-mapper.ts         # Basiq category → local category mapping
│   ├── output/
│   │   ├── note-writer.ts           # Markdown file creation
│   │   ├── duplicate-detector.ts    # Existing note + state-based dedup
│   │   └── filename.ts              # Filename generation with suffixes
│   ├── state.ts                      # State file read/write
│   └── sync.ts                       # SyncOrchestrator — main workflow
└── __tests__/
    ├── helpers.ts                    # Test fixtures, factory functions
    ├── integration/
    │   ├── sync-workflow.test.ts     # End-to-end sync scenarios
    │   └── categorization.test.ts   # Full pipeline tests
    └── unit/
        ├── filter.test.ts            # Exclusion rule tests
        ├── rent.test.ts              # Rent calculation tests
        ├── filename.test.ts          # Filename generation tests
        └── local-mappings.test.ts   # Mapping match logic tests
```

### Configuration File

```jsonc
// config.jsonc
{
  "vault_path": "/Users/tom/Documents/Vaults/Personal",
  "budget_dir": "Budget",
  "provider": "basiq",

  "basiq": {
    // API key read from BASIQ_API_KEY env var — never stored here
    "user_id": "xxx",
    "accounts": [
      { "id": "account-id-1", "type": "credit" },
      { "id": "account-id-2", "type": "debit" }
    ]
  },

  "defaults": {
    "date_range_days": 30
  }
}
```

The API key is resolved from `BASIQ_API_KEY` env var — never stored in the config file. Use `bun --env-file .env` to load from `.env` during development.

### State File

```json
{
  "lastSync": {
    "account-id-1": "2026-03-01",
    "account-id-2": "2026-03-01"
  },
  "importedTransactionIds": [
    "basiq-tx-abc123",
    "basiq-tx-def456"
  ]
}
```

---

## Phased Implementation Plan

### Phase 0: Scaffold (sequential)

**Task 0.1: Project scaffold**
- Files: `package.json`, `tsconfig.json`, `biome.json`, `.gitignore`, `.env.example`
- Dependencies: `@f0rbit/corpus`, `zod`, `commander` (CLI framework), `jsonc-parser` (JSONC parsing)
- Scripts: `sync`, `accounts`, `mappings` in package.json (all via `bun run src/index.ts <command>`)
- LOC: ~80
- Touches: all config files + `merchant-mappings.schema.json`

**Task 0.2: Types, schemas, and errors**
- Files: `src/types.ts`, `src/errors.ts`, `src/providers/types.ts`
- Zod schemas for: Config, MerchantMapping, State, CategorizedTransaction, Category enum
- Error types: `AuthError`, `ProviderError`, `ConfigError`, `WriteError`
- LOC: ~150
- Touches: `src/types.ts`, `src/errors.ts`, `src/providers/types.ts`

**Task 0.3: Config loader**
- Files: `src/config.ts`
- Load `config.yaml`, validate with Zod, resolve env vars
- LOC: ~80
- Touches: `src/config.ts`
- Depends on: Task 0.2

> Phase 0 total: ~290 LOC
> Verify: typecheck passes

---

### Phase 1: Core Pipeline (parallel where marked)

**Task 1.1: Exclusion filter** (parallel-safe)
- Files: `src/pipeline/filter.ts`
- Implement `ExclusionRule[]` and `filterTransactions()` function
- Rules from AGENTS.md: cc payments, savings, investments, roommate, reimbursements, credits
- Returns `{ included: CategorizedTransaction[], excluded: { tx, reason }[] }`
- LOC: ~100
- Touches: `src/pipeline/filter.ts`

**Task 1.2: Rent handler** (parallel-safe)
- Files: `src/pipeline/rent.ts`
- `isRentTransaction(tx)` detector
- `handleRent(tx)` — date-aware amount calculation
- Cutoff date `2026-03-01` as a named constant (easy to update)
- LOC: ~70
- Touches: `src/pipeline/rent.ts`

**Task 1.3: Local mapping loader + matcher** (parallel-safe)
- Files: `src/pipeline/local-mappings.ts`
- Load `merchant-mappings.jsonc` via `jsonc-parser`, validate with Zod
- `matchTransaction(tx, mappings)` — case-insensitive substring, first match wins
- Handle `extractLocation` flag
- LOC: ~90
- Touches: `src/pipeline/local-mappings.ts`

**Task 1.4: Enrich category mapper** (parallel-safe)
- Files: `src/pipeline/enrich-mapper.ts`
- Map Basiq Enrich categories to local 11 categories
- Static mapping table (Basiq uses ~20 categories like "Groceries", "Entertainment", etc.)
- LOC: ~60
- Touches: `src/pipeline/enrich-mapper.ts`

**Task 1.5: Categorizer orchestrator** (depends on 1.1-1.4)
- Files: `src/pipeline/categorizer.ts`
- `categorizePipeline(tx, mappings, provider?)` — runs the full pipeline in order
- Composes: filter → rent → local mapping → enrich → fallback
- LOC: ~80
- Touches: `src/pipeline/categorizer.ts`
- **Cannot run in parallel** with 1.1-1.4 (imports them)

> Phase 1 tasks 1.1-1.4 can run in parallel (no shared files).
> Task 1.5 runs after 1.1-1.4 complete.
> Phase 1 total: ~400 LOC
> Verify: typecheck + unit tests for filter, rent, mappings

---

### Phase 2: State & Output (parallel where marked)

**Task 2.1: State manager** (parallel-safe)
- Files: `src/state.ts`
- `loadState()`, `saveState()`, `markImported(txId)`, `isImported(txId)`, `updateLastSync(accountId, date)`
- JSON read/write with Zod validation
- LOC: ~80
- Touches: `src/state.ts`

**Task 2.2: Filename generator** (parallel-safe)
- Files: `src/output/filename.ts`
- `generateFilename(date, item, existingFiles)` → `YYYY-MM-DD-short-description.md`
- Slug generation (lowercase, hyphens, strip special chars)
- Duplicate suffix logic (`-2`, `-3`, etc.)
- LOC: ~60
- Touches: `src/output/filename.ts`

**Task 2.3: Duplicate detector** (parallel-safe)
- Files: `src/output/duplicate-detector.ts`
- `isDuplicate(tx, stateIds, existingNotes)` — checks both state file and filesystem
- Scan existing notes by date+amount+item fuzzy match
- LOC: ~80
- Touches: `src/output/duplicate-detector.ts`

**Task 2.4: Note writer** (depends on 2.2, 2.3)
- Files: `src/output/note-writer.ts`
- `writeNote(tx, budgetDir, dryRun)` → creates markdown file
- Formats YAML frontmatter exactly matching existing format
- Dry-run mode prints to stdout instead of writing
- LOC: ~90
- Touches: `src/output/note-writer.ts`

> Tasks 2.1, 2.2, 2.3 can run in parallel.
> Task 2.4 runs after 2.2 + 2.3.
> Phase 2 total: ~310 LOC
> Verify: typecheck + unit tests for filename, duplicate detection

---

### Phase 3: Basiq Provider (sequential)

**Task 3.1: Basiq provider implementation**
- Files: `src/providers/basiq.ts`
- HTTP client using `fetch` (built into Bun)
- Auth: `POST /token` with API key → cache JWT
- `getAccounts()`: `GET /users/{userId}/connections` then `GET /users/{userId}/accounts`
- `fetchTransactions()`: `GET /users/{userId}/transactions?filter=...` with pagination
- `enrichTransaction()`: `GET /enrich?q={description}`
- All methods return `Result<T, ProviderError>`
- LOC: ~200
- Touches: `src/providers/basiq.ts`

**Task 3.2: In-memory provider**
- Files: `src/providers/in-memory.ts`
- Implements `BankProvider` with arrays for test data
- Factory functions for creating realistic test transactions
- LOC: ~80
- Touches: `src/providers/in-memory.ts`

> Phase 3 total: ~280 LOC
> Verify: typecheck passes (Basiq can't be integration-tested without real credentials)

---

### Phase 4: Sync Orchestrator + CLI (sequential)

**Task 4.1: Sync orchestrator**
- Files: `src/sync.ts`
- `syncTransactions(config, options)` — the main workflow:
  1. Load config + state + mappings
  2. Authenticate provider
  3. Get accounts (filter to configured ones)
  4. For each account: fetch transactions in date range
  5. Run each through categorization pipeline
  6. Deduplicate against state + existing notes
  7. Write notes (or dry-run)
  8. Update state
- Returns a summary: `{ created: number, skipped: number, excluded: number, errors: Error[] }`
- LOC: ~150
- Touches: `src/sync.ts`

**Task 4.2: CLI entry point**
- Files: `src/index.ts`, `src/commands/sync.ts`, `src/commands/accounts.ts`, `src/commands/mappings.ts`
- Commander program with 3 subcommands
- `sync` flags: `--from`, `--to`, `--dry-run`, `--provider`
- `accounts` flags: none (list connected accounts)
- `mappings` flags: `--list`, `--add`, `--search`
- LOC: ~160
- Touches: `src/index.ts`, `src/commands/*.ts`

> Phase 4 total: ~270 LOC
> Verify: typecheck + integration tests (full sync workflow with in-memory provider)

---

### Phase 5: Merchant Mappings Seed + Integration Tests

**Task 5.1: Seed merchant-mappings.jsonc + schema**
- Files: `merchant-mappings.jsonc`, `merchant-mappings.schema.json`
- Port all 30+ mappings from Budget/AGENTS.md
- JSON Schema with category enum, field descriptions, required fields
- Include exclusion patterns as a separate section
- LOC: ~180 (JSONC + schema)
- Touches: `merchant-mappings.jsonc`, `merchant-mappings.schema.json`

**Task 5.2: Test helpers + fixtures**
- Files: `__tests__/helpers.ts`
- Factory functions: `makeTransaction()`, `makeAccount()`, `makeConfig()`
- Fixture data: realistic Basiq-style transaction descriptions
- Temp directory management for test output
- LOC: ~100
- Touches: `__tests__/helpers.ts`

**Task 5.3: Integration tests**
- Files: `__tests__/integration/sync-workflow.test.ts`, `__tests__/integration/categorization.test.ts`
- Scenarios:
  - Full sync creates correct markdown files
  - Exclusion rules filter correctly
  - Rent calculation works for pre/post March 2026
  - Duplicate detection prevents re-imports
  - Dry-run produces no files
  - Date range filtering works
  - Unknown merchants fall through to "Other"
  - State file updates after sync
- LOC: ~250
- Touches: `__tests__/integration/*.test.ts`

**Task 5.4: Unit tests**
- Files: `__tests__/unit/filter.test.ts`, `__tests__/unit/rent.test.ts`, `__tests__/unit/filename.test.ts`, `__tests__/unit/local-mappings.test.ts`
- Pure function tests: 2 per function (happy + edge case)
- LOC: ~150
- Touches: `__tests__/unit/*.test.ts`

> Tasks 5.1-5.4 can all run in parallel (no shared files).
> Phase 5 total: ~620 LOC
> Verify: full test suite passes, lint clean

---

## Total Estimate

| Phase | LOC | Tasks | Parallelizable |
|-------|-----|-------|----------------|
| 0: Scaffold | ~290 | 3 | No (sequential) |
| 1: Pipeline | ~400 | 5 | 4 parallel + 1 sequential |
| 2: Output | ~310 | 4 | 3 parallel + 1 sequential |
| 3: Providers | ~280 | 2 | Yes (parallel) |
| 4: Orchestrator + CLI | ~270 | 2 | No (sequential) |
| 5: Mappings + Tests | ~620 | 4 | Yes (parallel) |
| **Total** | **~2,170** | **20** | |

---

## Testing Strategy

### Guiding Principles

1. **In-memory BankProvider** — no HTTP mocking. The `InMemoryBankProvider` holds arrays of transactions/accounts. Tests push data in, then verify what comes out.
2. **Temp filesystem for output** — integration tests write to a temp directory, verify file contents, clean up.
3. **No Basiq credentials needed** — all tests use the in-memory provider. Manual smoke-testing against real Basiq API is a separate concern.

### Test Architecture

```
InMemoryBankProvider (pre-loaded test data)
         │
    SyncOrchestrator
         │
    Temp directory (verified after sync)
```

### Key Test Scenarios

| Scenario | Type | What it validates |
|----------|------|-------------------|
| Basic sync creates correct files | Integration | End-to-end pipeline |
| Woolworths mapped correctly | Unit | Local mapping substring match |
| Credit card payment excluded | Unit | Exclusion filter |
| Rent pre-March 2026 | Unit | Amount = charge - 450 |
| Rent post-March 2026 | Unit | Amount = 650 fixed |
| Duplicate prevention (state) | Integration | Same tx ID not re-imported |
| Duplicate prevention (filesystem) | Integration | Same date+amount+item detected |
| Dry-run creates no files | Integration | Output dir unchanged |
| Unknown merchant → Other | Integration | Fallback categorization |
| Filename collision handled | Unit | `-2`, `-3` suffixes |
| State persists after sync | Integration | JSON file updated |

### What We Don't Test

- Basiq HTTP responses (that's Basiq's problem; we test the interface contract)
- YAML parsing edge cases (that's the `yaml` library's problem)
- File system permissions (that's OS-level)

---

## Decisions (Confirmed)

1. **Tool location**: Separate repo at `/Users/tom/dev/budget-sync` (already init'd). The vault path is configured in `config.jsonc`.
2. **CLI framework**: Commander (or yargs) for proper help text, validation, and subcommands.
3. **API key management**: Environment variable `BASIQ_API_KEY`. Use `bun --env-file .env` for convenience during dev.
4. **Merchant mappings format**: JSONC (JSON with comments) + a JSON Schema for IDE autocomplete. File: `merchant-mappings.jsonc`, schema: `merchant-mappings.schema.json`.

---

## Execution Plan

```
Phase 0: Scaffold (sequential)
├── Task 0.1: package.json, tsconfig, biome, schema
├── Task 0.2: types.ts, errors.ts, providers/types.ts
├── Task 0.3: config.ts (depends on 0.2)
→ Verification: typecheck, commit

Phase 1: Core Pipeline
├── [PARALLEL] Task 1.1: filter.ts
├── [PARALLEL] Task 1.2: rent.ts
├── [PARALLEL] Task 1.3: local-mappings.ts
├── [PARALLEL] Task 1.4: enrich-mapper.ts
├── [SEQUENTIAL] Task 1.5: categorizer.ts (depends on 1.1-1.4)
→ Verification: typecheck, commit

Phase 2: State & Output
├── [PARALLEL] Task 2.1: state.ts
├── [PARALLEL] Task 2.2: filename.ts
├── [PARALLEL] Task 2.3: duplicate-detector.ts
├── [SEQUENTIAL] Task 2.4: note-writer.ts (depends on 2.2, 2.3)
→ Verification: typecheck, commit

Phase 3: Providers (parallel)
├── [PARALLEL] Task 3.1: basiq.ts
├── [PARALLEL] Task 3.2: in-memory.ts
→ Verification: typecheck, commit

Phase 4: Orchestrator + CLI (sequential)
├── Task 4.1: sync.ts
├── Task 4.2: index.ts + commands/*.ts (depends on 4.1)
→ Verification: typecheck, commit

Phase 5: Mappings + Tests (parallel)
├── [PARALLEL] Task 5.1: merchant-mappings.jsonc + schema
├── [PARALLEL] Task 5.2: test helpers
├── [PARALLEL] Task 5.3: integration tests
├── [PARALLEL] Task 5.4: unit tests
→ Verification: full test suite, lint, commit
```

---

## Future Extensions (not in scope, but the architecture supports them)

- **CSV provider** — implement `BankProvider` reading CSV files. Straightforward addition.
- **Interactive categorization** — when a merchant is "Other", prompt the user to categorize and save the mapping. Would extend `mappings` CLI command.
- **Scheduled sync** — run via cron/launchd. The state file already tracks last sync per account.
- **Multi-vault support** — config already takes `vault_path`, could be extended to an array.

---

## Suggested AGENTS.md Updates

After implementation, the following should be added to `Budget/AGENTS.md`:

```markdown
## Automated Import Tool

Separate repo at `/Users/tom/dev/budget-sync` — CLI tool for automated transaction import.

- Run `bun run sync` to import new transactions
- Run `bun run sync --dry-run` to preview without creating files
- Merchant mappings are in `merchant-mappings.jsonc` (with JSON Schema for autocomplete)
- State (last sync, imported IDs) is in `.budget-sync-state.json`
- The tool uses the Basiq API (CDR) by default. Set `BASIQ_API_KEY` env var before running.
- Config in `config.jsonc` — set vault path and Basiq user ID.
```
