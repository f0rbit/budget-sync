# Cross-Account Dedup

## Summary

When multiple account statements are ingested (credit card, savings, debit), the same real-world purchase can appear as transactions in multiple accounts — double-counting spending. This feature adds a post-categorization pipeline step that detects and excludes cross-account duplicates before materialization.

**Scope**: ~250 LOC production, ~300 LOC tests. Two phases, one day of work.

## Problem Analysis

Two patterns produce duplicates:

| Pattern | Example | Date Gap |
|---------|---------|----------|
| Savings → Credit Card | Savings debit mirrors CC purchase (same merchant, same amount) | 2-5 days |
| Everyday → Savings | Inter-account transfer appears as debit on both sides | 0-2 days |

Real data: 15 cross-account duplicates in 138 transactions. One false positive ($9.99 Uber One vs Amazon Prime — same amount, different items).

### Why existing dedup doesn't catch this

Current dedup (Step 12 in `ingest-service.ts`) uses `external_id` uniqueness — each provider generates different IDs for the same real-world transaction, so cross-account duplicates pass through.

### Why pattern-based exclusion isn't enough

The savings→CC transfers don't have a consistent prefix — they repeat the merchant name verbatim. You can't write a regex pattern to match "any merchant name that also appears on the credit card" because the merchant names are arbitrary.

## Design

### Core Algorithm

New pure function `detectCrossAccountDuplicates()` in `src/pipeline/dedup.ts`:

```
Input:  incoming CategorizedTransaction[], existing TransactionRow[]
Output: { kept: CategorizedTransaction[], duplicates: ExcludedTransaction[] }
```

For each incoming transaction:
1. Find candidates in existing transactions where:
   - `amount` matches exactly
   - `date` is within `maxDayGap` (default 5)
   - `accountId` differs (different accounts)
   - Both are debits
   - Neither is already excluded
2. Among candidates, check item similarity:
   - Exact match on `item` field (post-categorization normalized names)
   - This is the false-positive guard — $9.99 Uber One ≠ $9.99 Amazon Prime
3. If match found, apply priority rule:
   - Keep the transaction from the higher-priority account type
   - Priority: `credit` > `transaction` > `savings`
   - If the incoming tx is lower priority → exclude it
   - If the incoming tx is higher priority → exclude it, but flag a note (the existing one should have been excluded but it's already materialized — we can't un-materialize it here)

**Key insight**: Because we ingest one file at a time, the "existing" transactions are already in SQLite from previous ingests. The incoming batch is from the current ingest. We only need to mark *incoming* transactions as excluded — we never modify already-materialized transactions.

This means the dedup is directional: mark the incoming duplicate as excluded. If the user ingests in the "wrong" order (savings first, credit card second), the savings transaction is already materialized and the credit card one will NOT be excluded (it's higher priority). This is correct behavior — the credit card transaction is the canonical one and should be kept.

**Edge case**: If the user ingests credit card first (correct), then savings second, the savings duplicate gets excluded. If they ingest savings first, then credit card, the credit card transaction is kept (not excluded) and the savings one remains. The user ends up with both, but only the savings one is "wrong" — they can re-ingest from scratch to fix this. This is acceptable for a personal finance tool.

### Integration Point

Between categorization and materialization in `ingestDocument()` — new Step 10.7:

```
Step 10:   categorizeAll() → { categorized, excluded }
Step 10.5: AI categorization corpus snapshot
Step 10.7: detectCrossAccountDuplicates(categorized, existingTxs) → { kept, duplicates }  ← NEW
Step 11:   corpus sync-results snapshot
Step 12:   materialize into SQLite
```

The dedup step needs to query existing transactions from SQLite, so it needs `db` access. But the function itself is pure — it takes arrays in, returns arrays out. The DB query happens in `ingestDocument()`.

### Config

No config changes needed. The algorithm is deterministic with sensible defaults:
- `maxDayGap`: 5 days (hardcoded constant, not config)
- Item matching: exact string equality on `item` field
- Account priority: hardcoded `credit > transaction > savings`

If we later need to tune these, we can add a `dedup` config key. But YAGNI for now.

### What About `IngestSummary`?

Add a `transactionsDeduplicated` field to track how many cross-account duplicates were detected. This appears in the CLI output alongside `transactionsCreated`, `transactionsExcluded`, `transactionsSkipped`.

## Affected Files

| File | Change | Type |
|------|--------|------|
| `src/pipeline/dedup.ts` | **NEW** — cross-account dedup function | Core logic |
| `src/services/ingest-service.ts` | Add dedup step between categorization and materialization | Integration |
| `src/services/transaction-service.ts` | Add `getDebitTransactions()` query for existing txs | Query helper |
| `__tests__/unit/dedup.test.ts` | **NEW** — unit tests for dedup algorithm | Tests |
| `__tests__/integration/ingest-workflow.test.ts` | Add cross-account dedup integration test | Tests |
| `__tests__/helpers.ts` | Add `makeCategorizedTransaction()` helper | Test helper |

## Task Breakdown

### Phase 1: Core dedup logic + unit tests (sequential)

#### Task 1.1: Create `src/pipeline/dedup.ts` (~80 LOC)

```ts
// Types
interface DedupResult {
  kept: CategorizedTransaction[];
  duplicates: ExcludedTransaction[];
}

// Account type priority (higher = keep)
const ACCOUNT_TYPE_PRIORITY: Record<AccountType, number> = {
  credit: 3,
  transaction: 2,
  savings: 1,
  super: 0,
  investment: 0,
};

const MAX_DAY_GAP = 5;

// Pure function — no DB access
function detectCrossAccountDuplicates(
  incoming: CategorizedTransaction[],
  existing: TransactionRow[],
  incomingAccountType: AccountType,
): DedupResult
```

Implementation:
- For each incoming debit transaction, scan existing non-excluded debit transactions
- Match criteria: exact amount, date within MAX_DAY_GAP, exact item match, different accountId
- If match found and incoming account has equal or lower priority → exclude incoming
- If match found and incoming account has higher priority → keep incoming (can't un-materialize existing)
- Also deduplicate within the incoming batch itself (two transactions in same file matching each other won't happen — they'd have same accountId)

The function also needs the account types of existing transactions. We'll join account type when querying existing transactions.

**Files**: `src/pipeline/dedup.ts`
**Dependencies**: None
**Estimated LOC**: 80

#### Task 1.2: Add query helper in `transaction-service.ts` (~25 LOC)

Add `getExistingDebitsForDedup()` — returns non-excluded debit transactions with their account type joined:

```ts
interface DedupCandidate {
  id: string;
  accountId: string;
  accountType: AccountType;
  date: string;
  item: string;
  amount: number;
  excluded: boolean;
}

function getExistingDebitsForDedup(
  db: AppDatabase,
  dateFrom: string,
  dateTo: string,
): Promise<Result<DedupCandidate[], DbError>>
```

Uses a Drizzle join on `transactions` + `accounts` to get account type. Filters to:
- `direction = 'debit'`
- `excluded = false`
- `date` within range (expanded by MAX_DAY_GAP on both sides)

**Files**: `src/services/transaction-service.ts`
**Dependencies**: None
**Parallel with**: Task 1.1 (different files)

#### Task 1.3: Unit tests for dedup (~150 LOC)

`__tests__/unit/dedup.test.ts`:

1. **Exact match detected**: Same amount, same item, dates 2 days apart, different accounts → lower-priority excluded
2. **Amount mismatch**: Same item, different amount → no dedup
3. **Item mismatch**: Same amount, different item → no dedup (the $9.99 false positive case)
4. **Date too far apart**: Same amount, same item, 10 days apart → no dedup
5. **Same account**: Same amount, same item, same account → no dedup (that's same-account dedup, handled by external_id)
6. **Priority: credit > savings**: CC tx kept, savings excluded
7. **Priority: incoming is higher**: Incoming credit tx matches existing savings → incoming kept (not excluded)
8. **Credit transactions ignored**: Only debits are checked
9. **Already excluded transactions ignored**: Don't dedup against already-excluded existing txs
10. **Multiple matches**: Pick the closest date match

Also add `makeCategorizedTransaction()` helper to `__tests__/helpers.ts`.

**Files**: `__tests__/unit/dedup.test.ts`, `__tests__/helpers.ts`
**Dependencies**: Task 1.1
**Estimated LOC**: 150

#### Task 1.4: Verification

- `bun test`
- `bunx biome check`
- Commit

### Phase 2: Pipeline integration + integration tests (sequential)

#### Task 2.1: Integrate dedup into `ingest-service.ts` (~40 LOC)

After Step 10.5 (AI categorization), before Step 11 (corpus sync-results):

1. Compute date range from incoming categorized transactions
2. Call `getExistingDebitsForDedup(db, dateFrom, dateTo)` 
3. Call `detectCrossAccountDuplicates(categorized, existingDebits, accountType)`
4. Replace `categorized` with `kept`, append `duplicates` to `excluded`
5. Update `IngestSummary` with `transactionsDeduplicated` count

Changes to `IngestSummary`:
- Add `transactionsDeduplicated: number` field

Changes to `syncResultSnapshot.stats`:
- Add `crossAccountDuplicates: number`

**Files**: `src/services/ingest-service.ts`
**Dependencies**: Task 1.1, Task 1.2
**Estimated LOC**: 40

#### Task 2.2: Integration tests (~150 LOC)

Add to `__tests__/integration/ingest-workflow.test.ts`:

**I11: Cross-account dedup excludes savings duplicate**
1. Ingest credit card statement (Officeworks $42.50 on Feb 28)
2. Ingest savings statement (Officeworks $42.50 on Mar 2)
3. Assert: savings transaction materialized with `excluded: true`, `excludeReason: "Cross-account duplicate"`
4. Assert: `IngestSummary.transactionsDeduplicated === 1`

**I12: Cross-account dedup respects item mismatch**
1. Ingest credit card statement (Uber One $9.99 on Feb 28)
2. Ingest savings statement (Amazon Prime $9.99 on Mar 2)
3. Assert: both materialized, neither excluded

**I13: Cross-account dedup ignores same-account transactions**
1. Ingest two transactions from same account with same amount/item
2. Assert: both kept (same-account dedup is handled by external_id, not this feature)

Setup for these tests requires:
- Two separate ingests with different parsers/accounts
- First ingest creates the "existing" transactions
- Second ingest triggers the dedup

**Files**: `__tests__/integration/ingest-workflow.test.ts`
**Dependencies**: Task 2.1
**Estimated LOC**: 150

#### Task 2.3: Verification

- `bun test` (full suite)
- `bunx biome check`
- Commit

## Phase Summary

```
Phase 1: Core Logic (2 parallel + 1 sequential)
├── Task 1.1: src/pipeline/dedup.ts (80 LOC)
├── Task 1.2: src/services/transaction-service.ts (25 LOC)  [parallel with 1.1]
├── Task 1.3: __tests__/unit/dedup.test.ts + helpers.ts (150 LOC) [after 1.1]
→ Verification: typecheck, test, lint, commit

Phase 2: Integration (sequential)
├── Task 2.1: src/services/ingest-service.ts (40 LOC) [after Phase 1]
├── Task 2.2: __tests__/integration/ingest-workflow.test.ts (150 LOC) [after 2.1]
→ Verification: full test suite, lint, commit
```

**Total**: ~445 LOC across 6 files (2 new, 4 modified)

## Decisions Made (no user input needed)

1. **No config** — hardcoded MAX_DAY_GAP=5 and priority order. Can add config later if needed.
2. **Exact item match** — not fuzzy. Post-categorization item names are already normalized by merchant mappings, so "Officeworks" on CC matches "Officeworks" on savings. If they don't match after categorization, they're probably different purchases.
3. **Directional dedup** — only marks incoming transactions as excluded, never modifies existing materialized rows. This means ingest order matters, but re-ingest from scratch fixes any ordering issues.
4. **No schema changes** — uses existing `excluded`/`excludeReason` columns on transactions table. No migration needed.
5. **Dedup step excluded from dry-run** — since dry-run doesn't materialize, there are no "existing" transactions to match against. The dedup step still runs but will find zero matches (which is correct).

## Suggested AGENTS.md Updates

After implementation, add to the "Key Patterns" or "Gotchas" section:

```
### Cross-Account Dedup

- `detectCrossAccountDuplicates()` in `src/pipeline/dedup.ts` — pure function, runs after categorization
- Matches: exact amount + exact item + date within 5 days + different accounts + both debits
- Account priority: credit > transaction > savings (keep higher-priority account's transaction)
- Directional: only excludes incoming transactions, never modifies already-materialized rows
- Ingest order matters: ingest credit card first, then savings, for optimal dedup
- No config needed — hardcoded constants
```
