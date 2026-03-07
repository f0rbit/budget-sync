# M2: Super Integration — Detailed Implementation Plan

> **Dependencies**: M0 + M1 complete. All tables, providers, corpus stores, sync workflow, snapshots, and net worth exist.
> **Baseline**: 82 tests passing, 10 test files.

---

## Executive Summary

M2 adds superannuation tracking to `budget-sync`:

1. **ManualSuperProvider**: Implements the existing `SuperProvider` interface via JSON file import. Parses a user-provided JSON file containing balance and contribution data. This is the primary path — REST Super via Basiq is unlikely to be a supported connector, and a `BasiqSuperProvider` can be layered in later if needed.

2. **Contribution service**: CRUD operations for the `contributions` table (already exists in schema, empty). Stores employer, salary sacrifice, voluntary, FHSS, and government contributions.

3. **Super sync service**: Orchestrates the import flow: parse JSON → snapshot raw data to corpus → upsert account → upsert balance snapshot → insert contributions into SQLite.

4. **Net worth includes super**: Add `"super"` to `INCLUDED_TYPES` in `networth-service.ts`. Super balance is treated as positive (like savings), increasing net worth.

5. **CLI commands**: `budget-sync super balance`, `budget-sync super contributions`, `budget-sync super import <file>`.

**Estimated total**: ~800 LOC across 8 new files + 5 modified files.

---

## Integration Point Analysis

### Existing Code That Changes

| File | Change | Impact |
|------|--------|--------|
| `src/services/networth-service.ts` | Add `"super"` to `INCLUDED_TYPES`, add `super` component to `computeNetWorth()` and types | **BREAKING**: Test N4 currently asserts super is excluded — must update. Net worth values will increase for anyone with super snapshots. |
| `src/corpus/schemas.ts` | Add `rawContributionsSnapshotSchema` | Additive. No existing schemas change. |
| `src/corpus/stores.ts` | Add `rawContributionsStore` | Additive. No existing stores change. |
| `src/corpus/client.ts` | Register `rawContributionsStore` in `buildCorpus()` | Additive. Adds `.with_store()` call. |
| `src/corpus/index.ts` | Re-export new store and schema type | Additive barrel update. |
| `src/index.ts` | Register `superCommand` | Additive. 2 lines. |
| `__tests__/helpers.ts` | Add `makeSuperBalance()`, `makeContribution()`, `createTestSuperProvider()` helper factories | Additive. |

### New Files

| File | Purpose | LOC |
|------|---------|-----|
| `src/providers/manual-super/provider.ts` | `ManualSuperProvider` implementing `SuperProvider` — reads JSON file | ~80 |
| `src/providers/in-memory/super-provider.ts` | `InMemorySuperProvider` for testing | ~70 |
| `src/services/contribution-service.ts` | `insertContributions()`, `getContributions()` for `contributions` table | ~80 |
| `src/services/super-sync-service.ts` | Orchestrates: parse import → corpus → SQLite (account, snapshot, contributions) | ~120 |
| `src/commands/super.ts` | CLI: `super balance`, `super contributions`, `super import <file>` | ~130 |
| `__tests__/integration/super-import.test.ts` | Import flow + contribution service tests | ~120 |
| `__tests__/integration/super-networth.test.ts` | Net worth now includes super | ~80 |

### Files That Do NOT Change

- `src/db/schema.ts` — `contributions` table already defined with all needed columns
- `src/providers/types.ts` — `SuperProvider`, `SuperBalance`, `SuperContribution`, `ContributionType` already defined
- `src/services/snapshot-service.ts` — already handles any account type (including "super")
- `src/services/account-service.ts` — `upsertAccount()` already supports type "super"
- `src/config.ts` — no new config fields needed (import path comes from CLI argument)
- `src/errors.ts` — existing `ProviderError`, `DbError` types cover all M2 error cases

**BREAKING changes**:
- `NetWorthBreakdown.components` gains a `super` field — any code destructuring this type will need updating
- `NetWorthHistoryEntry` gains a `super` field
- `computeNetWorth()` formula changes from `transaction + savings - credit` to `transaction + savings + super - credit`
- Test N4 ("net worth ignores super/investment accounts") must be updated to assert super IS included
- **Net worth values will change** for any user who already has super-type account snapshots

---

## Phased Task Breakdown

### Phase 2.1: Foundation — Corpus Store + Contribution Service + Providers (Sequential)

Foundation phase. Creates the data layer and providers that all subsequent phases depend on.

#### Task 2.1.1: `raw-contributions` Corpus Store

**Files**: `src/corpus/schemas.ts`, `src/corpus/stores.ts`, `src/corpus/client.ts`, `src/corpus/index.ts` (all modify)
**LOC**: ~30 total
**Dependencies**: None
**Parallel**: No — foundational

Add a new corpus store for raw contribution data from imports. The `raw-balances` store can be reused for super balance snapshots (it's already generic — just `{ accountId, balance, available?, asOf }` per entry). But contributions are a new data shape requiring their own store.

**Schema** (add to `src/corpus/schemas.ts`):

```typescript
export const rawContributionSchema = z.object({
  id: z.string(),
  date: z.string(),
  type: z.enum(CONTRIBUTION_TYPES),
  amount: z.number(),
  description: z.string().optional(),
});

export const rawContributionsSnapshotSchema = z.object({
  accountId: z.string(),
  provider: z.string(),
  fetchedAt: z.string(),
  balance: z.object({
    amount: z.number(),
    asOf: z.string(),
  }),
  contributions: z.array(rawContributionSchema),
});

export type RawContributionsSnapshot = z.infer<typeof rawContributionsSnapshotSchema>;
```

**Store** (add to `src/corpus/stores.ts`):

```typescript
export const rawContributionsStore = define_store<"raw-contributions", RawContributionsSnapshot>(
  "raw-contributions",
  json_codec(rawContributionsSnapshotSchema),
  { description: "Raw super balance + contribution data from manual import or API" },
);
```

**Client** (modify `src/corpus/client.ts`): Add `.with_store(rawContributionsStore)` to `buildCorpus()`.

**Barrel** (modify `src/corpus/index.ts`): Add re-exports for new store and type.

#### Task 2.1.2: `contribution-service.ts`

**File**: `src/services/contribution-service.ts` (new)
**LOC**: ~80
**Dependencies**: None (uses existing schema, types)
**Parallel**: Yes — with Task 2.1.3 and 2.1.4 (different files)

Creates the contribution data access layer. Receives `AppDatabase` (matching existing service pattern).

**Functions to implement**:

```typescript
import type { Result } from "@f0rbit/corpus";
import type { AppDatabase } from "../db/client.js";
import type { DbError } from "../errors.js";
import type { ContributionType } from "../providers/types.js";

export type ContributionRow = typeof contributions.$inferSelect;

export interface ContributionFilters {
  accountId?: string;
  dateFrom?: string;  // YYYY-MM-DD
  dateTo?: string;    // YYYY-MM-DD
  type?: ContributionType;
}

// Insert multiple contributions (batch insert, skip duplicates by matching accountId+date+type+amount)
export async function insertContributions(
  db: AppDatabase,
  accountId: string,
  items: { date: string; type: ContributionType; amount: number; description?: string; syncRunId?: string }[],
): Promise<Result<{ inserted: number; skipped: number }, DbError>>

// Get contributions with filters
export async function getContributions(
  db: AppDatabase,
  filters?: ContributionFilters,
): Promise<Result<ContributionRow[], DbError>>

// Get contribution summary (total by type for a given account/date range)
export async function getContributionSummary(
  db: AppDatabase,
  filters?: ContributionFilters,
): Promise<Result<{ type: ContributionType; total: number; count: number }[], DbError>>
```

**Implementation notes**:
- `insertContributions`: Use `try_catch_async`. Loop over items, insert each. For dedup: check if a contribution with same `(accountId, date, type, amount)` already exists before inserting. Return `{ inserted, skipped }` counts.
- `getContributions`: JOIN with `accounts` for context if needed. Filter by `accountId`, `dateFrom`, `dateTo`, `type`. ORDER BY `date DESC`.
- `getContributionSummary`: Use Drizzle's `sql` helper for `SUM(amount)` and `COUNT(*)` grouped by `type`.

#### Task 2.1.3: `ManualSuperProvider`

**File**: `src/providers/manual-super/provider.ts` (new)
**LOC**: ~80
**Dependencies**: None (uses existing `SuperProvider` interface)
**Parallel**: Yes — with Task 2.1.2 and 2.1.4 (different files)

Implements `SuperProvider` by reading a JSON file. The file path is provided at construction time.

```typescript
import { type Result, ok, err, try_catch } from "@f0rbit/corpus";
import { z } from "zod";
import type { ProviderError } from "../../errors.js";
import { errors } from "../../errors.js";
import type { SuperProvider, SuperBalance, SuperContribution, DateRange, ContributionType } from "../types.js";

// Zod schema for the import file format
const superImportSchema = z.object({
  balance: z.object({
    amount: z.number(),
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  contributions: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    type: z.enum(["employer", "salary_sacrifice", "voluntary", "fhss", "government"]),
    amount: z.number().positive(),
    description: z.string().optional(),
  })).default([]),
});

export type SuperImportData = z.infer<typeof superImportSchema>;

export class ManualSuperProvider implements SuperProvider {
  readonly name = "manual-super";
  private data: SuperImportData | null = null;
  private accountId: string;

  constructor(options: { filePath: string; accountId?: string }) {
    this.filePath = options.filePath;
    this.accountId = options.accountId ?? "manual-super";
  }

  async authenticate(): Promise<Result<void, ProviderError>> {
    // Read and validate JSON file during "auth" step
    // This matches the pattern where authenticate() is the first step
    const readResult = try_catch(
      () => {
        const content = readFileSync(this.filePath, "utf-8");
        return JSON.parse(content);
      },
      (e) => errors.parseError(`Failed to read super import file: ${e}`),
    );
    if (!readResult.ok) return readResult;

    const parsed = superImportSchema.safeParse(readResult.value);
    if (!parsed.success) {
      return err(errors.parseError(`Invalid super import format: ${parsed.error.message}`));
    }

    this.data = parsed.data;
    return ok(undefined);
  }

  async getBalance(): Promise<Result<SuperBalance, ProviderError>> {
    if (!this.data) return err(errors.authFailed("Not authenticated"));
    return ok({
      accountId: this.accountId,
      balance: this.data.balance.amount,
      asOf: this.data.balance.asOf,
    });
  }

  async getContributions(range: DateRange): Promise<Result<SuperContribution[], ProviderError>> {
    if (!this.data) return err(errors.authFailed("Not authenticated"));
    const filtered = this.data.contributions
      .filter(c => c.date >= range.from && c.date <= range.to)
      .map((c, i) => ({
        id: `manual-${c.date}-${c.type}-${i}`,
        date: c.date,
        type: c.type as ContributionType,
        amount: c.amount,
        description: c.description,
      }));
    return ok(filtered);
  }
}
```

**Import file format** (documented in the plan, user creates this):

```json
{
  "balance": { "amount": 85000.00, "asOf": "2026-03-01" },
  "contributions": [
    { "date": "2026-02-28", "type": "employer", "amount": 1200.00, "description": "Monthly employer" },
    { "date": "2026-02-28", "type": "salary_sacrifice", "amount": 500.00 }
  ]
}
```

#### Task 2.1.4: `InMemorySuperProvider`

**File**: `src/providers/in-memory/super-provider.ts` (new)
**LOC**: ~70
**Dependencies**: None (uses existing `SuperProvider` interface)
**Parallel**: Yes — with Task 2.1.2 and 2.1.3 (different files)

In-memory implementation for testing. Follows the same pattern as `InMemoryBankProvider`.

```typescript
export class InMemorySuperProvider implements SuperProvider {
  readonly name = "in-memory-super";

  private _balance: SuperBalance | null = null;
  private _contributions: SuperContribution[] = [];
  private _authenticated = false;

  failNextAuth = false;
  failNextBalance = false;
  failNextContributions = false;

  // --- Data loading helpers ---
  setBalance(balance: SuperBalance): void
  addContributions(...contributions: SuperContribution[]): void

  // --- SuperProvider interface ---
  async authenticate(): Promise<Result<void, ProviderError>>
  async getBalance(): Promise<Result<SuperBalance, ProviderError>>
  async getContributions(range: DateRange): Promise<Result<SuperContribution[], ProviderError>>
}
```

**Fail flags**: `failNextAuth`, `failNextBalance`, `failNextContributions` — reset after one failure (same pattern as `InMemoryBankProvider`).

**Filtering**: `getContributions` filters by `range.from <= date <= range.to`.

#### Task 2.1.5: Test Helper Factories

**File**: `__tests__/helpers.ts` (modify)
**LOC**: ~35
**Dependencies**: Task 2.1.4 (uses `InMemorySuperProvider`)
**Parallel**: No — must follow 2.1.4

```typescript
import { InMemorySuperProvider } from "../src/providers/in-memory/super-provider.js";
import type { SuperBalance, SuperContribution, ContributionType } from "../src/providers/types.js";

export function makeSuperBalance(overrides?: Partial<SuperBalance>): SuperBalance {
  return {
    accountId: overrides?.accountId ?? "super-account",
    balance: 85000.00,
    asOf: "2026-03-01",
    ...overrides,
  };
}

export function makeContribution(overrides?: Partial<SuperContribution>): SuperContribution {
  return {
    id: overrides?.id ?? createId(),
    date: "2026-03-01",
    type: "employer" as ContributionType,
    amount: 1200.00,
    description: "Monthly employer contribution",
    ...overrides,
  };
}

export function createTestSuperProvider(options?: {
  balance?: SuperBalance;
  contributions?: SuperContribution[];
}): InMemorySuperProvider {
  const provider = new InMemorySuperProvider();
  if (options?.balance) provider.setBalance(options.balance);
  if (options?.contributions) provider.addContributions(...options.contributions);
  return provider;
}
```

**Verification**: typecheck, commit.

---

### Phase 2.2: Super Sync Service (Sequential)

Depends on Phase 2.1 — uses contribution service, providers, and corpus store.

#### Task 2.2.1: `super-sync-service.ts`

**File**: `src/services/super-sync-service.ts` (new)
**LOC**: ~120
**Dependencies**: Phase 2.1 (contribution service, corpus store, providers)
**Parallel**: No — depends on Phase 2.1

Orchestrates the super import/sync flow. Analogous to `sync-service.ts` for bank transactions but simpler (no pipeline, no categorization).

```typescript
import type { Result } from "@f0rbit/corpus";
import type { AppContext } from "../db/client.js";
import type { SuperProvider } from "../providers/types.js";
import type { DbError, ProviderError } from "../errors.js";

export interface SuperSyncOptions {
  dateFrom?: string;
  dateTo?: string;
  accountName?: string;
  verbose?: boolean;
}

export interface SuperSyncSummary {
  accountId: string;
  accountName: string;
  balance: number;
  balanceDate: string;
  contributionsInserted: number;
  contributionsSkipped: number;
}

type SuperSyncError = ProviderError | DbError;

export async function syncSuper(
  ctx: AppContext,
  provider: SuperProvider,
  options?: SuperSyncOptions,
): Promise<Result<SuperSyncSummary, SuperSyncError>>
```

**Steps** (modeled after `syncTransactions` but lighter):

1. **Authenticate** provider
2. **Get balance** from provider
3. **Get contributions** from provider (use `dateFrom`/`dateTo` if provided, else full range `"1970-01-01"` to today)
4. **Snapshot to corpus**: Put raw data into `corpus.stores["raw-contributions"]` with tags `[provider:${name}, date:${today}]`
5. **Upsert account**: Use `upsertAccount(db, provider.name, { id: provider accountId, name: options.accountName ?? "Super Fund", institution: "Super", type: "super" })`
6. **Upsert balance snapshot**: Use existing `upsertSnapshot(db, { accountId: internalId, date: balance.asOf, balance: balance.balance })`
7. **Insert contributions**: Use `insertContributions(db, internalId, contributions)`
8. **Return summary**

**Key design**: This service does NOT create a `sync_runs` record. Super imports are lightweight and don't go through the transaction pipeline. The `syncRunId` field on contributions is left null for manual imports. If we add `BasiqSuperProvider` later, it can optionally create a sync run.

**Verbose output**: If `options.verbose`, log each step's result.

**Verification**: typecheck, commit.

---

### Phase 2.3: Net Worth Modification (Sequential)

#### Task 2.3.1: Add `"super"` to Net Worth Calculation

**File**: `src/services/networth-service.ts` (modify)
**LOC**: ~25 changes
**Dependencies**: Phase 2.1 (needs super snapshots in DB for the flow to work end-to-end)
**Parallel**: No — modifies shared types

**Changes**:

1. **`INCLUDED_TYPES`**: Add `"super"` to the set:
   ```typescript
   const INCLUDED_TYPES: ReadonlySet<string> = new Set(["transaction", "savings", "credit", "super"]);
   ```

2. **`NetWorthBreakdown.components`**: Add `super` field:
   ```typescript
   components: {
     transaction: number;
     savings: number;
     credit: number;
     super: number;
   };
   ```

3. **`NetWorthHistoryEntry`**: Add `super` field:
   ```typescript
   export interface NetWorthHistoryEntry {
     date: string;
     netWorth: number;
     transaction: number;
     savings: number;
     credit: number;
     super: number;
   }
   ```

4. **`computeNetWorth`**: Add `super` accumulator:
   ```typescript
   function computeNetWorth(balances: Map<string, AccountState>): {
     transaction: number;
     savings: number;
     credit: number;
     super: number;
     netWorth: number;
   } {
     let transaction = 0;
     let savings = 0;
     let credit = 0;
     let superBal = 0;  // "super" is a reserved-ish word in strict contexts

     for (const state of balances.values()) {
       if (!INCLUDED_TYPES.has(state.type)) continue;
       if (state.type === "transaction") transaction += state.balance;
       else if (state.type === "savings") savings += state.balance;
       else if (state.type === "credit") credit += state.balance;
       else if (state.type === "super") superBal += state.balance;
     }

     return { transaction, savings, credit, super: superBal, netWorth: transaction + savings + superBal - credit };
   }
   ```

5. **`ZERO_BREAKDOWN`**: Add `super: 0` to components.

6. **`getCurrentNetWorth`**: Pass through the `super` component.

7. **`getNetWorthHistory`**: Pass through the `super` field.

#### Task 2.3.2: Update `networth` CLI Command

**File**: `src/commands/networth.ts` (modify)
**LOC**: ~15 changes
**Dependencies**: Task 2.3.1
**Parallel**: No — depends on 2.3.1

**Changes**:

1. **`printHistoryTable`**: Add `Super` column header and value.
2. **`printHistoryCsv`**: Add `super` column.
3. **`printBreakdownCsv`**: No change needed (iterates accounts dynamically).
4. **`printBreakdownTable`**: No change needed (iterates accounts dynamically).

**Verification**: typecheck, commit.

---

### Phase 2.4: CLI Commands (Sequential)

#### Task 2.4.1: `super` CLI Command

**File**: `src/commands/super.ts` (new)
**LOC**: ~130
**Dependencies**: Phases 2.1, 2.2 (super sync service, contribution service)
**Parallel**: No — single file

Creates the `budget-sync super` command group with three subcommands.

```
budget-sync super balance                           — Show current super balance
budget-sync super contributions [--from] [--to]     — Show contribution history
budget-sync super import <file> [--account-name]    — Import from JSON file
```

**`super balance`**:
1. Load config, create DB
2. Get latest snapshots for super-type accounts (use `getLatestSnapshots()` filtered by type)
3. Print balance table (or "No super balance found" message)

```typescript
const superCommand = new Command("super")
  .description("Track superannuation balance and contributions");

superCommand
  .command("balance")
  .description("Show current super balance")
  .option("--format <type>", "Output format: table, json", "table")
  .action(async (options) => { ... });
```

**`super contributions`**:
1. Load config, create DB
2. Call `getContributions(db, { dateFrom, dateTo })`
3. Optionally call `getContributionSummary()` for totals
4. Print contribution table with type, date, amount, description

```typescript
superCommand
  .command("contributions")
  .description("Show contribution history")
  .option("--from <date>", "Start date (YYYY-MM-DD)")
  .option("--to <date>", "End date (YYYY-MM-DD)")
  .option("--summary", "Show summary by contribution type")
  .option("--format <type>", "Output format: table, csv, json", "table")
  .action(async (options) => { ... });
```

**`super import`**:
1. Load config, create DB + corpus
2. Create `ManualSuperProvider({ filePath: file })`
3. Call `syncSuper(ctx, provider, { accountName, verbose })`
4. Print summary

```typescript
superCommand
  .command("import")
  .argument("<file>", "Path to JSON import file")
  .option("--account-name <name>", "Super account name", "Super Fund")
  .option("--verbose", "Show detailed output")
  .action(async (file: string, options) => { ... });
```

#### Task 2.4.2: Register `super` Command in `index.ts`

**File**: `src/index.ts` (modify)
**LOC**: ~3
**Dependencies**: Task 2.4.1
**Parallel**: No — must follow 2.4.1

```typescript
import { superCommand } from "./commands/super.js";
program.addCommand(superCommand);
```

**Verification**: typecheck, commit.

---

### Phase 2.5: Tests (Parallel)

Both test files are independent — different files, no shared mutable state.

#### Task 2.5.1: Super Import Integration Tests

**File**: `__tests__/integration/super-import.test.ts` (new)
**LOC**: ~120
**Dependencies**: Phases 2.1-2.4
**Parallel**: Yes — with Task 2.5.2

**Test scenarios**:

| # | Scenario | What it validates |
|---|----------|-------------------|
| S1 | `ManualSuperProvider` parses valid JSON | Provider reads file, returns balance + contributions |
| S2 | `ManualSuperProvider` rejects invalid JSON | Missing required fields → `PARSE_ERROR` |
| S3 | `ManualSuperProvider` filters contributions by date range | Date range filtering works |
| S4 | `InMemorySuperProvider` auth + balance + contributions | In-memory provider works end-to-end |
| S5 | `InMemorySuperProvider` fail flags | `failNextBalance`, `failNextContributions` work |
| S6 | `syncSuper()` full flow: provider → corpus → SQLite | Creates account, snapshot, contributions |
| S7 | `syncSuper()` re-import updates balance, deduplicates contributions | Idempotent behavior |
| S8 | `insertContributions()` deduplication | Same (accountId, date, type, amount) not duplicated |
| S9 | `getContributions()` with date range filter | Filtering works |
| S10 | `getContributionSummary()` aggregates by type | Correct sums and counts |
| S11 | Corpus snapshot created on import | `raw-contributions` store has data after sync |

**Test setup**: Use `createTestContext()` + `createTestSuperProvider()`. For S1-S3, write a temporary JSON file and use `ManualSuperProvider` directly. For S4-S5, use `InMemorySuperProvider`. For S6-S11, use `syncSuper()` with in-memory provider.

#### Task 2.5.2: Super + Net Worth Integration Tests

**File**: `__tests__/integration/super-networth.test.ts` (new)
**LOC**: ~80
**Dependencies**: Phase 2.3
**Parallel**: Yes — with Task 2.5.1

**Test scenarios**:

| # | Scenario | What it validates |
|---|----------|-------------------|
| SN1 | Net worth includes super balance | Super added to net worth (positive) |
| SN2 | Net worth with all account types | `transaction + savings + super - credit` |
| SN3 | Net worth history includes super component | History entries have `super` field |
| SN4 | Net worth history carry-forward with super | Super balance carries forward correctly |
| SN5 | Super import → net worth reflects balance | End-to-end: `syncSuper()` → `getCurrentNetWorth()` |

#### Task 2.5.3: Update Existing Net Worth Test N4

**File**: `__tests__/integration/networth.test.ts` (modify)
**LOC**: ~10 changes
**Dependencies**: Phase 2.3
**Parallel**: Yes — with 2.5.1 and 2.5.2 (different file)

Test N4 currently asserts: "net worth ignores super/investment accounts". After M2, super IS included. Update:

```typescript
it("N4: net worth includes super but ignores investment accounts", async () => {
  const savingsId = await seedAccount({ id: "ext-sav", type: "savings", name: "Savings" });
  const superId = await seedAccount({ id: "ext-super", type: "super", name: "Super Fund" });
  const investId = await seedAccount({ id: "ext-inv", type: "investment", name: "Shares" });

  await upsertSnapshot(ctx.db, { accountId: savingsId, date: "2026-03-01", balance: 10000 });
  await upsertSnapshot(ctx.db, { accountId: superId, date: "2026-03-01", balance: 50000 });
  await upsertSnapshot(ctx.db, { accountId: investId, date: "2026-03-01", balance: 20000 });

  const result = await getCurrentNetWorth(ctx.db);
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  expect(result.value.netWorth).toBe(60000);  // 10000 savings + 50000 super (investment excluded)
  expect(result.value.accounts).toHaveLength(2);
  expect(result.value.components.super).toBe(50000);
});
```

**Verification**: full test suite (`bun test`), typecheck, commit.

---

## Phase Execution Summary

```
Phase 2.1: Foundation — Corpus + Services + Providers (mixed parallelism)
├── Task 2.1.1: raw-contributions corpus store         ~30 LOC  (sequential — foundational)
├── [PARALLEL] Task 2.1.2: contribution-service.ts     ~80 LOC
├── [PARALLEL] Task 2.1.3: ManualSuperProvider         ~80 LOC
├── [PARALLEL] Task 2.1.4: InMemorySuperProvider       ~70 LOC
├── Task 2.1.5: test helper factories                  ~35 LOC  (after 2.1.4)
→ Verification: typecheck, COMMIT

Phase 2.2: Super Sync Service (sequential)
├── Task 2.2.1: super-sync-service.ts                 ~120 LOC
→ Verification: typecheck, COMMIT

Phase 2.3: Net Worth Modification (sequential)
├── Task 2.3.1: networth-service.ts modifications      ~25 LOC
├── Task 2.3.2: networth command updates               ~15 LOC  (after 2.3.1)
→ Verification: typecheck, COMMIT

Phase 2.4: CLI Commands (sequential)
├── Task 2.4.1: super CLI command                     ~130 LOC
├── Task 2.4.2: index.ts registration                   ~3 LOC  (after 2.4.1)
→ Verification: typecheck, COMMIT

Phase 2.5: Tests (parallel)
├── [PARALLEL] Task 2.5.1: super-import.test.ts       ~120 LOC
├── [PARALLEL] Task 2.5.2: super-networth.test.ts      ~80 LOC
├── [PARALLEL] Task 2.5.3: update networth.test.ts N4  ~10 LOC
→ Verification: full test suite, typecheck, COMMIT
```

**Total**: ~798 LOC across 8 new files + 5 modified files

---

## File Ownership Matrix (Parallel Safety)

| File | Phase 2.1 | Phase 2.2 | Phase 2.3 | Phase 2.4 | Phase 2.5 |
|------|-----------|-----------|-----------|-----------|-----------|
| `src/corpus/schemas.ts` | 2.1.1 ✏️ | — | — | — | — |
| `src/corpus/stores.ts` | 2.1.1 ✏️ | — | — | — | — |
| `src/corpus/client.ts` | 2.1.1 ✏️ | — | — | — | — |
| `src/corpus/index.ts` | 2.1.1 ✏️ | — | — | — | — |
| `src/services/contribution-service.ts` | 2.1.2 ✏️ | 2.2.1 📖 | — | 2.4.1 📖 | 2.5.1 📖 |
| `src/providers/manual-super/provider.ts` | 2.1.3 ✏️ | — | — | 2.4.1 📖 | 2.5.1 📖 |
| `src/providers/in-memory/super-provider.ts` | 2.1.4 ✏️ | — | — | — | 2.5.1 📖 |
| `__tests__/helpers.ts` | 2.1.5 ✏️ | — | — | — | 📖 |
| `src/services/super-sync-service.ts` | — | 2.2.1 ✏️ | — | 2.4.1 📖 | 2.5.1 📖 |
| `src/services/networth-service.ts` | — | — | 2.3.1 ✏️ | — | 📖 |
| `src/commands/networth.ts` | — | — | 2.3.2 ✏️ | — | — |
| `src/commands/super.ts` | — | — | — | 2.4.1 ✏️ | — |
| `src/index.ts` | — | — | — | 2.4.2 ✏️ | — |
| `__tests__/integration/super-import.test.ts` | — | — | — | — | 2.5.1 ✏️ |
| `__tests__/integration/super-networth.test.ts` | — | — | — | — | 2.5.2 ✏️ |
| `__tests__/integration/networth.test.ts` | — | — | — | — | 2.5.3 ✏️ |

✏️ = writes, 📖 = reads only

Within Phase 2.1, tasks 2.1.2/2.1.3/2.1.4 are parallel-safe (all write to different files). Task 2.1.1 must run before the parallel batch (corpus store must exist for imports). Task 2.1.5 must follow 2.1.4 (needs `InMemorySuperProvider` import).

Within Phase 2.5, all three test tasks write to different files — fully parallel-safe.

---

## Key Design Decisions

### 1. ManualSuperProvider as primary path

REST Super is unlikely to be a Basiq connector. The `ManualSuperProvider` (JSON import) is the default and fully functional implementation. If Basiq later supports super, a `BasiqSuperProvider` can implement the same `SuperProvider` interface without changing any downstream code.

### 2. JSON import format

Simple flat structure with balance + contributions array. Zod-validated on "authenticate" step. The `asOf` date on balance is mandatory — we need to know what date the balance represents. Contributions are optional (balance-only import is valid).

### 3. Corpus store: `raw-contributions` (not reusing `raw-balances`)

The super import contains both balance AND contributions in a single snapshot. Creating a dedicated `raw-contributions` store keeps the data shape clean and allows lineage tracking specific to super imports. The balance from the import is included in the `raw-contributions` snapshot as context, AND separately materialized to the `snapshots` table via `upsertSnapshot()`.

### 4. No `sync_runs` record for manual imports

Super imports are lightweight single-account operations. Adding `sync_runs` overhead adds complexity without value. The `syncRunId` field on contributions is nullable. If `BasiqSuperProvider` is added later, it can optionally create a sync run.

### 5. Net worth formula

Super is treated as positive (like savings): `netWorth = transaction + savings + super - credit`. This is the standard personal finance convention — super is an asset.

### 6. Contribution deduplication

Dedup by `(accountId, date, type, amount)` — check-before-insert pattern. This handles re-importing the same JSON file without creating duplicate rows. It's intentionally loose (no unique constraint in schema) because the same person could genuinely have two contributions of the same type and amount on the same day (e.g., two employer contributions from different employers). The check-before-insert approach gives us control without over-constraining the schema.

### 7. `super` keyword handling

TypeScript allows `super` as a property name in object literals and interfaces (`{ super: number }`). The `computeNetWorth` function uses `superBal` as the local variable name to avoid any ambiguity, but the return type and interface fields use `super` directly.

---

## Suggested SKILL.md Updates

After M2 implementation, add the following section:

```markdown
## M2: Super Integration

- `bun run dev -- super balance` — show current super balance
- `bun run dev -- super contributions [--from] [--to]` — contribution history
- `bun run dev -- super import <file>` — import from JSON file
- Import file format: `{ "balance": { "amount": 85000, "asOf": "2026-03-01" }, "contributions": [...] }`
- Net worth formula updated: `savings + transaction + super - credit` (was `savings + transaction - credit`)
- `ManualSuperProvider` reads JSON, validates with Zod, implements `SuperProvider` interface
- `InMemorySuperProvider` for testing — same pattern as `InMemoryBankProvider` (fail flags, data loading helpers)
- Corpus store `raw-contributions` snapshots raw import data with balance + contributions
- Contribution dedup: check-before-insert on `(accountId, date, type, amount)` — no unique constraint
- Super imports do NOT create `sync_runs` records (lightweight, no pipeline)
- Providers: `SuperProvider` is separate from `BankProvider` — different interface, different providers index
- `super` is now in `INCLUDED_TYPES` for net worth calculation

### Adding a Super Provider

1. Implement `SuperProvider` interface from `src/providers/types.ts`
2. Create in `src/providers/<name>/provider.ts`
3. Add in-memory variant for testing (or use `InMemorySuperProvider`)
4. Wire into `super import` command or create a new subcommand
```
