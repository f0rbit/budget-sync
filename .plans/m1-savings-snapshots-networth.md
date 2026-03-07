# M1: Savings Snapshots + Net Worth — Detailed Implementation Plan

> Replaces the high-level M1 scope in Section 8 of `budget-sync-tool.md`.
> **Dependencies**: M0 complete. All tables, providers, corpus stores, and sync workflow exist.

---

## Executive Summary

M1 adds two capabilities to `budget-sync`:

1. **Balance materialization**: The sync workflow already fetches balances and snapshots them to `corpus.stores["raw-balances"]` (sync-service.ts:142-153). M1 materializes those balances into the `snapshots` SQLite table (which already exists with schema + unique constraint on `(account_id, date)`). A standalone `snapshot` CLI command allows capturing balances without a full transaction sync.

2. **Net worth calculation**: A `networth-service.ts` computes `net_worth = sum(savings) + sum(transaction) - abs(sum(credit))` from the latest snapshots per account. A `networth` CLI command displays current net worth with `--history` and `--format` options.

**Estimated total**: ~550 LOC across 6 new files + 2 modified files.

---

## Integration Point Analysis

### Existing Code That Changes

| File | Change | Impact |
|------|--------|--------|
| `src/services/sync-service.ts` | Add Step 5.5: materialize balances to `snapshots` table after corpus snapshot | Adds ~30 LOC between existing Step 5 and Step 6. Non-breaking — new behavior gated by `config.sync.auto_snapshot`. |
| `src/index.ts` | Register `snapshotCommand` and `networthCommand` | 2 new import lines + 2 `addCommand()` calls. Non-breaking. |
| `__tests__/helpers.ts` | Add `makeBalance()` factory helper | ~10 LOC addition. Non-breaking. |

### New Files

| File | Purpose | LOC |
|------|---------|-----|
| `src/services/snapshot-service.ts` | Upsert snapshots, get latest per account, get history with date range | ~100 |
| `src/services/networth-service.ts` | Compute current net worth, compute history over date range | ~120 |
| `src/commands/snapshot.ts` | CLI: `budget-sync snapshot` — manual balance capture | ~60 |
| `src/commands/networth.ts` | CLI: `budget-sync networth [--history] [--format]` | ~80 |
| `__tests__/integration/snapshot.test.ts` | Snapshot service + sync integration tests | ~100 |
| `__tests__/integration/networth.test.ts` | Net worth calculation tests | ~80 |

### Files That Do NOT Change

- `src/db/schema.ts` — `snapshots` table already defined with correct schema
- `src/corpus/stores.ts` — `raw-balances` store already defined
- `src/corpus/schemas.ts` — `rawBalancesSnapshotSchema` already defined
- `src/config.ts` — `auto_snapshot` config field already exists (default `true`)
- `src/providers/types.ts` — `AccountBalance` type already defined
- `src/providers/in-memory/provider.ts` — `setBalances()` already implemented

**BREAKING changes**: None. All changes are additive.

---

## Phased Task Breakdown

### Phase 1.1: Snapshot Service + Sync Integration (Sequential)

Foundation phase — creates the service that later phases depend on.

#### Task 1.1.1: `snapshot-service.ts`

**File**: `src/services/snapshot-service.ts` (new)
**LOC**: ~100
**Dependencies**: None (uses existing schema, types, AppContext)
**Parallel**: No — foundational for all subsequent tasks

Creates the snapshot data access layer. All functions receive `AppDatabase` (matching account-service.ts / transaction-service.ts pattern).

**Functions to implement**:

```typescript
// Types
export type SnapshotRow = typeof snapshots.$inferSelect;

export interface SnapshotFilters {
  accountId?: string;
  dateFrom?: string;  // YYYY-MM-DD
  dateTo?: string;    // YYYY-MM-DD
}

// Upsert a balance snapshot (one per account per day)
// Uses INSERT ... ON CONFLICT (account_id, date) DO UPDATE
export async function upsertSnapshot(
  db: AppDatabase,
  data: { accountId: string; date: string; balance: number; available?: number; syncRunId?: string },
): Promise<Result<SnapshotRow, DbError>>

// Get the latest snapshot for each active account
// JOIN accounts WHERE is_active = true, GROUP BY account_id, MAX(date)
export async function getLatestSnapshots(
  db: AppDatabase,
): Promise<Result<(SnapshotRow & { accountName: string; accountType: AccountType })[], DbError>>

// Get snapshot history for a specific account or all accounts
export async function getSnapshotHistory(
  db: AppDatabase,
  filters?: SnapshotFilters,
): Promise<Result<(SnapshotRow & { accountName: string; accountType: AccountType })[], DbError>>
```

**Implementation notes**:
- Use `try_catch_async` wrapping each function (same pattern as `account-service.ts`)
- `upsertSnapshot`: Use Drizzle's `.onConflictDoUpdate()` targeting the `snapshots_account_date_idx` unique index
- `getLatestSnapshots`: Use a subquery or `sql` helper to get `MAX(date)` per `account_id`, then join with `accounts` table for name/type
- `getSnapshotHistory`: JOIN with `accounts`, filter by date range and optional accountId, ORDER BY `date DESC`
- Import `AccountType` from `../providers/types.js` for the enriched return type

#### Task 1.1.2: Modify `sync-service.ts` to materialize balances

**File**: `src/services/sync-service.ts` (modify)
**LOC**: ~30 additions
**Dependencies**: Task 1.1.1 (uses `upsertSnapshot`)
**Parallel**: No — must follow 1.1.1

Add a new Step 5.5 between the existing Step 5 (corpus balance snapshot) and Step 6 (categorization pipeline). This step materializes the corpus-snapshotted balances into the `snapshots` SQLite table.

**Changes**:

1. Add import: `import { upsertSnapshot } from "./snapshot-service.js";`
2. After the existing `raw-balances` corpus snapshot (line 153), add:

```typescript
// Step 5.5: Materialize balances to snapshots table (non-fatal, gated by auto_snapshot)
if (config.sync.auto_snapshot && balancesResult.ok) {
  let snapshotsMaterialized = 0;
  for (const bal of balancesResult.value) {
    // Resolve internal account ID from external provider ID
    const accountResult = await findAccountByExternalId(ctx.db, provider.name, bal.accountId);
    if (!accountResult.ok || !accountResult.value) continue;

    const snapshotResult = await upsertSnapshot(ctx.db, {
      accountId: accountResult.value.id,
      date: bal.asOf,
      balance: bal.balance,
      available: bal.available,
      syncRunId,
    });
    if (snapshotResult.ok) snapshotsMaterialized++;
  }
  // Update the summary's snapshotsCreated count
}
```

3. Update the `snapshotsCreated` field in the return summary to include materialized snapshots count.

**Key consideration**: The balance `accountId` from the provider is an external ID (e.g., Basiq account ID). Must resolve to internal DB account ID using `findAccountByExternalId()` before inserting into `snapshots` table (which has a FK to `accounts.id`). This function is already imported in sync-service.ts.

**Non-fatal**: If any individual snapshot upsert fails, log warning (if verbose) and continue. Don't fail the entire sync for a snapshot issue.

#### Task 1.1.3: Add `makeBalance()` test helper

**File**: `__tests__/helpers.ts` (modify)
**LOC**: ~10
**Dependencies**: None
**Parallel**: Can run parallel with 1.1.1 (different file)

Add a factory function for creating test `AccountBalance` objects:

```typescript
export function makeBalance(overrides?: Partial<AccountBalance>): AccountBalance {
  return {
    accountId: overrides?.accountId ?? createId(),
    balance: 1500.00,
    available: 1400.00,
    asOf: "2026-03-01",
    ...overrides,
  };
}
```

**Verification**: typecheck, commit.

---

### Phase 1.2: Net Worth Service (Sequential)

#### Task 1.2.1: `networth-service.ts`

**File**: `src/services/networth-service.ts` (new)
**LOC**: ~120
**Dependencies**: Task 1.1.1 (`getLatestSnapshots`, `getSnapshotHistory`)
**Parallel**: No — depends on Phase 1.1

Creates the net worth computation layer. Receives `AppDatabase`.

**Types to define**:

```typescript
export interface NetWorthBreakdown {
  date: string;           // YYYY-MM-DD (date of calculation)
  netWorth: number;       // Final net worth figure
  components: {
    transaction: number;  // Sum of transaction account balances
    savings: number;      // Sum of savings account balances
    credit: number;       // Sum of credit card balances (negative = debt)
  };
  accounts: {
    id: string;
    name: string;
    type: AccountType;
    balance: number;
  }[];
}

export interface NetWorthHistoryEntry {
  date: string;
  netWorth: number;
  transaction: number;
  savings: number;
  credit: number;
}
```

**Functions to implement**:

```typescript
// Get current net worth from latest snapshots
// net_worth = sum(savings) + sum(transaction) - abs(sum(credit))
// Credit card balances are typically positive in the DB (representing debt),
// so we SUBTRACT them.
export async function getCurrentNetWorth(
  db: AppDatabase,
): Promise<Result<NetWorthBreakdown, DbError>>

// Get net worth over time
// For each unique date in snapshot history, compute net worth
// Returns one entry per date, sorted ascending
export async function getNetWorthHistory(
  db: AppDatabase,
  filters?: { dateFrom?: string; dateTo?: string },
): Promise<Result<NetWorthHistoryEntry[], DbError>>
```

**Implementation notes for `getCurrentNetWorth`**:
1. Call `getLatestSnapshots(db)` to get latest balance per account
2. Group by `accountType`: `transaction`, `savings`, `credit`
3. Sum each group
4. `netWorth = savings + transaction - credit` (credit balances represent debt)
5. Only include `transaction`, `savings`, `credit` types for now (super/investment added in M2/M3)
6. Return the breakdown with individual account details

**Implementation notes for `getNetWorthHistory`**:
1. Call `getSnapshotHistory(db, filters)` to get all snapshots in range
2. Group snapshots by date
3. For each date, compute net worth using latest-known balance per account as of that date
4. This means for dates where only some accounts have snapshots, carry forward the most recent known balance for the others
5. Return sorted ascending by date

**Carry-forward logic**: For each date `D` in the result:
- For each active account, use the snapshot on date `D` if it exists, otherwise use the most recent snapshot before `D`
- This ensures net worth is always computed against all accounts, not just the ones snapshotted on that specific day
- Implementation: iterate dates in order, maintain a `Map<accountId, lastKnownBalance>` that updates as we process each date's snapshots

**Verification**: typecheck, commit.

---

### Phase 1.3: CLI Commands (Parallel)

Both commands are independent — they share no files and can be implemented in parallel.

#### Task 1.3.1: `snapshot` CLI command

**File**: `src/commands/snapshot.ts` (new)
**LOC**: ~60
**Dependencies**: Phase 1.1 (snapshot-service), sync-service (for provider access)
**Parallel**: Yes — with Task 1.3.2

Standalone command to capture current balances without running a full transaction sync.

```
budget-sync snapshot [--provider <name>] [--verbose]
```

**Behavior**:
1. Load config, create AppContext `{ db, corpus }`
2. Create + authenticate provider
3. Call `provider.getAccountBalances()`
4. Snapshot to `corpus.stores["raw-balances"]` (same as sync does)
5. For each balance, resolve internal account ID via `findAccountByExternalId()`
6. Call `upsertSnapshot()` for each
7. Print summary: accounts snapshotted, date

**Pattern**: Follow `src/commands/accounts.ts` for config loading / error handling boilerplate. Construct `AppContext` from config same as `sync.ts`.

#### Task 1.3.2: `networth` CLI command

**File**: `src/commands/networth.ts` (new)
**LOC**: ~80
**Dependencies**: Phase 1.2 (networth-service)
**Parallel**: Yes — with Task 1.3.1

```
budget-sync networth [--history] [--from <date>] [--to <date>] [--format table|csv|json]
```

**Default behavior** (no flags): Show current net worth breakdown as a table:

```
Net Worth: $12,450.00

  Everyday Account     transaction    $3,200.00
  Savings Account      savings        $10,500.00
  Credit Card          credit        -$1,250.00
  ─────────────────────────────────────────────
  Total                               $12,450.00
```

**`--history` behavior**: Show net worth over time:

```
Date         Net Worth    Savings    Transaction  Credit
2026-03-01   $12,450.00   $10,500    $3,200       -$1,250
2026-03-02   $12,380.00   $10,500    $3,130       -$1,250
```

**`--format csv`**: Output as CSV (headers + rows), suitable for piping
**`--format json`**: Output as JSON array
**`--format table`** (default): Human-readable table as shown above

**Pattern**: Follow existing command patterns. Format helpers can be inline — no need for a separate formatter module at this scale.

#### Task 1.3.3: Register commands in `index.ts`

**File**: `src/index.ts` (modify)
**LOC**: ~4
**Dependencies**: Tasks 1.3.1 and 1.3.2
**Parallel**: No — must follow 1.3.1 and 1.3.2

Add:
```typescript
import { snapshotCommand } from "./commands/snapshot.js";
import { networthCommand } from "./commands/networth.js";

program.addCommand(snapshotCommand);
program.addCommand(networthCommand);
```

**Verification**: typecheck, commit.

---

### Phase 1.4: Tests (Parallel)

Both test files are independent — different files, no shared mutable state.

#### Task 1.4.1: Snapshot integration tests

**File**: `__tests__/integration/snapshot.test.ts` (new)
**LOC**: ~100
**Dependencies**: Phases 1.1, 1.2, 1.3
**Parallel**: Yes — with Task 1.4.2

**Test scenarios**:

| # | Scenario | What it validates |
|---|----------|-------------------|
| S1 | `upsertSnapshot` creates new snapshot | Basic insert works, returns SnapshotRow |
| S2 | `upsertSnapshot` updates on same (account, date) | Upsert behavior — balance updated, no duplicate |
| S3 | `getLatestSnapshots` returns one per account | Multiple dates → only latest per account returned |
| S4 | `getLatestSnapshots` joins account name/type | Enriched return type has account metadata |
| S5 | `getSnapshotHistory` with date range filter | Only snapshots within range returned |
| S6 | Sync materializes balances to snapshots table | Full `syncTransactions()` → snapshots table has rows |
| S7 | Sync with `auto_snapshot: false` skips materialization | Config flag respected |
| S8 | Sync with balance fetch failure doesn't fail sync | Non-fatal behavior preserved |
| S9 | Multiple syncs on same day update existing snapshots | Upsert via unique constraint |
| S10 | Snapshot command flow (service layer only) | Manual balance capture without sync |

**Test setup pattern** (follow sync-workflow.test.ts):
```typescript
let ctx: AppContext;
let config: AppConfig;

beforeEach(() => {
  ctx = createTestContext();
  config = makeConfig();
});
```

For S6-S9, use `createTestProvider()` with balances and run `syncTransactions()`.
For S1-S5 and S10, call service functions directly against `ctx.db` after seeding accounts with `upsertAccount()`.

#### Task 1.4.2: Net worth integration tests

**File**: `__tests__/integration/networth.test.ts` (new)
**LOC**: ~80
**Dependencies**: Phases 1.1, 1.2
**Parallel**: Yes — with Task 1.4.1

**Test scenarios**:

| # | Scenario | What it validates |
|---|----------|-------------------|
| N1 | Net worth with savings + transaction accounts | `sum(savings) + sum(transaction)` |
| N2 | Net worth with credit card debt | Credit balance subtracted from total |
| N3 | Net worth with no snapshots | Returns zero/empty breakdown, not error |
| N4 | Net worth ignores super/investment accounts | Only transaction/savings/credit included |
| N5 | Net worth history returns entries per date | Multiple dates → one entry each, sorted ascending |
| N6 | Net worth history carry-forward | Account without snapshot on date X uses last known balance |
| N7 | Net worth history with date range filter | Only dates within range returned |
| N8 | Full sync → net worth reflects balances | End-to-end: sync with balances → `getCurrentNetWorth()` matches |

**Test setup**: Seed accounts with `upsertAccount()`, then seed snapshots with `upsertSnapshot()` for precise control over test data. For N8, use full `syncTransactions()` flow.

**Verification**: full test suite (`bun test`), typecheck, commit.

---

## Phase Execution Summary

```
Phase 1.1: Snapshot Service + Sync Integration (sequential)
├── Task 1.1.1: snapshot-service.ts (new)           ~100 LOC
├── Task 1.1.2: sync-service.ts modification         ~30 LOC  (depends on 1.1.1)
├── Task 1.1.3: makeBalance() test helper             ~10 LOC  (parallel with 1.1.1)
→ Verification: typecheck, COMMIT

Phase 1.2: Net Worth Service (sequential)
├── Task 1.2.1: networth-service.ts (new)           ~120 LOC
→ Verification: typecheck, COMMIT

Phase 1.3: CLI Commands (parallel)
├── [PARALLEL] Task 1.3.1: snapshot command (new)     ~60 LOC
├── [PARALLEL] Task 1.3.2: networth command (new)     ~80 LOC
├── [SEQUENTIAL] Task 1.3.3: index.ts registration     ~4 LOC  (depends on 1.3.1 + 1.3.2)
→ Verification: typecheck, COMMIT

Phase 1.4: Tests (parallel)
├── [PARALLEL] Task 1.4.1: snapshot tests (new)      ~100 LOC
├── [PARALLEL] Task 1.4.2: networth tests (new)       ~80 LOC
→ Verification: full test suite, typecheck, COMMIT
```

**Total**: ~584 LOC across 6 new files + 3 modified files

---

## File Ownership Matrix (Parallel Safety)

| File | Phase 1.1 | Phase 1.2 | Phase 1.3 | Phase 1.4 |
|------|-----------|-----------|-----------|-----------|
| `src/services/snapshot-service.ts` | 1.1.1 ✏️ | 1.2.1 📖 | 1.3.1 📖 | 1.4.1 📖 |
| `src/services/sync-service.ts` | 1.1.2 ✏️ | — | — | 1.4.1 📖 |
| `src/services/networth-service.ts` | — | 1.2.1 ✏️ | 1.3.2 📖 | 1.4.2 📖 |
| `src/commands/snapshot.ts` | — | — | 1.3.1 ✏️ | — |
| `src/commands/networth.ts` | — | — | 1.3.2 ✏️ | — |
| `src/index.ts` | — | — | 1.3.3 ✏️ | — |
| `__tests__/helpers.ts` | 1.1.3 ✏️ | — | — | 📖 |
| `__tests__/integration/snapshot.test.ts` | — | — | — | 1.4.1 ✏️ |
| `__tests__/integration/networth.test.ts` | — | — | — | 1.4.2 ✏️ |

✏️ = writes, 📖 = reads only

No two parallel tasks within a phase write to the same file. Safe for concurrent agents.

---

## Key Design Decisions

### 1. Credit card balance sign convention

Credit card `balance` from providers is typically positive (representing debt owed). The net worth formula treats it as debt:

```
netWorth = sum(transaction balances) + sum(savings balances) - sum(credit balances)
```

If a credit card has a balance of `$1,250`, it reduces net worth by `$1,250`. This is the standard convention and matches what Basiq returns.

### 2. History carry-forward

When computing net worth history, not all accounts may have a snapshot on every date. The carry-forward approach uses the most recent known balance for each account. This is necessary because:
- Different accounts may be snapshotted at different frequencies
- A manual `snapshot` command might only capture one provider's accounts
- Missing a day shouldn't create a gap in the net worth history

### 3. No separate snapshot corpus store

Balance materialization reads from the provider response that's already been snapshotted to `corpus.stores["raw-balances"]`. The `snapshots` SQLite table is the materialized view. No new corpus store needed.

### 4. Service functions receive `AppDatabase`, not `AppContext`

Following the established pattern in `account-service.ts` and `transaction-service.ts`, service functions receive `AppDatabase` directly. Only the CLI commands and the top-level `syncTransactions()` function deal with `AppContext`. The snapshot and networth services don't need corpus access — they only read/write SQLite.

---

## Suggested AGENTS.md Updates

After M1 implementation, add:

```markdown
### M1: Snapshots + Net Worth
- `bun run src/index.ts snapshot` — capture current balances without full sync
- `bun run src/index.ts networth` — show current net worth breakdown
- `bun run src/index.ts networth --history --format csv` — net worth over time
- Snapshots table: unique constraint on (account_id, date) — upserts on conflict
- Net worth formula: `savings + transaction - credit` (super/investments added in M2/M3)
- `config.sync.auto_snapshot` (default true) controls whether sync materializes balances
```
