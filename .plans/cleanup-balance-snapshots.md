# Cleanup + Balance Snapshot Extraction

## Executive Summary

Two-phase plan to (A) remove dead code left over from the bank-API pivot to document ingestion, and (B) wire balance extraction into the ingest pipeline so `networth` stops showing $0 after document imports.

Phase 1 is a net deletion of ~800 LOC (source + tests). Phase 2 adds ~120 LOC to extract balances from parsed documents and write them to the `snapshots` table during `ingestDocument()`.

---

## Current State

After the pivot from Basiq bank API to AI document ingestion, several modules exist that have zero production callers:

| Dead Code | LOC | Why Dead |
|-----------|-----|----------|
| `syncTransactions()` in `sync-service.ts` | 315 | Old bank-API sync. Replaced by `ingestDocument()` |
| `createProvider()` in `providers/index.ts` | 24 | Only called by dead commands |
| `CsvBankProvider` in `providers/csv/provider.ts` | 170 | Replaced by `CsvDocumentParser` |
| `accounts discover` subcommand | 38 | Calls dead `createProvider()` / `BankProvider.getAccounts()` |
| `snapshot` command in `commands/snapshot.ts` | 81 | Calls dead `createProvider()` / `BankProvider.getAccountBalances()` |
| `SyncSummary` type in `providers/types.ts` | 12 | Only used by `sync-service.ts` |
| `sync-workflow.test.ts` | 263 | Tests `syncTransactions()` directly |
| Tests using `syncTransactions()` for setup | ~50 | In `networth.test.ts`, `snapshot.test.ts`, `corpus-lineage.test.ts` |

The `snapshots` table has data only when `syncTransactions()` was used (via `materializeBalances()`). The new `ingestDocument()` pipeline writes `snapshotsUpserted: 0` — it never calls `upsertSnapshot()`. Net worth is always $0 after document ingestion.

## Target State

- All dead sync-era code removed
- `ParsedDocument` has optional `balance` field
- `CsvDocumentParser` extracts balance into structured `balance` field (not notes string)
- `AnthropicDocumentParser` prompt updated to request `statementBalance`
- `InMemoryDocumentParser` / test helpers support balance field
- `ingestDocument()` calls `upsertSnapshot()` when `parsed.balance` is present
- Tests migrated from `syncTransactions()` to either `ingestDocument()` or direct service calls
- Net worth reflects ingested document balances

---

## Phase 1: Dead Code Removal + Test Migration

### Task 1A: Delete dead source files and code (~-580 LOC)

**Files to delete entirely:**
- `src/services/sync-service.ts` (315 lines)
- `src/commands/snapshot.ts` (81 lines)
- `src/providers/csv/provider.ts` (170 lines)

**Files to edit:**

1. **`src/commands/accounts.ts`** — Remove `discover` subcommand (lines 43-80), remove `createProvider` import. Keep `list` and `deactivate`. Also update empty-state message on line 29 from `"Run 'accounts discover' to find accounts."` to `"Run 'budget-sync ingest' to add accounts."` (~-40 LOC)

2. **`src/providers/index.ts`** — Remove `createProvider()` function (lines 14-38), remove `CsvBankProvider` import (line 8), remove `CsvBankProvider` re-export (line 69). Keep `createDocumentParser()`, `createAiCategorizer()`, and all other exports. (~-30 LOC)

3. **`src/providers/types.ts`** — Remove `SyncSummary` interface (lines 186-197). Update `BankProvider` JSDoc (lines 118-124) to remove `"CsvBankProvider: Manual CSV import"` line. Keep `BankProvider` interface itself (used by `InMemoryBankProvider`). (~-15 LOC)

4. **`src/index.ts`** — Remove `snapshotCommand` import (line 8) and registration (line 21). (~-2 LOC)

5. **`src/commands/networth.ts`** — Change `NO_DATA_MSG` (line 7) from `"No snapshots found. Run 'budget-sync sync' or 'budget-sync snapshot' first."` to `"No snapshots found. Run 'budget-sync ingest' first."`. (~1 LOC change)

6. **`src/providers/csv/document-parser.ts`** — Remove stale comment on line 60 `"=== Shared CSV parsing (extracted from CsvBankProvider) ==="` → `"=== CSV line parsing ==="`. (~1 LOC change)

**Dependencies:** None — this is foundation work.
**Estimated LOC:** -580 deleted, ~10 modified
**Files touched:** 9 files (3 deleted, 6 edited)

### Task 1B: Delete and migrate test files (~-350 LOC deleted, ~100 LOC added)

**Delete entirely:**
- `__tests__/integration/sync-workflow.test.ts` (263 lines) — tests `syncTransactions()` directly. The ingest pipeline is already covered by `ingest-workflow.test.ts`.

**Migrate tests:**

1. **`__tests__/integration/networth.test.ts`** — Only test `N8` (line 139-156) uses `syncTransactions()`. This test verifies that sync materializes balances and net worth reflects them. **Replace** with direct `upsertSnapshot()` + `getCurrentNetWorth()` test (the sync→balance flow will be tested in Phase 2 via ingest). Remove `syncTransactions` import, `createTestProvider` import. (~20 LOC changed)

2. **`__tests__/integration/snapshot.test.ts`** — Tests at lines 119-191 (5 tests) use `syncTransactions()` to test balance materialization via sync. These tests validate `materializeBalances()` behavior during sync. Since we're deleting the sync path, **replace with direct `materializeBalances()` calls** using `upsertAccount()` + `materializeBalances()`:
   - "sync materializes balances" → "materializeBalances writes to snapshots table"
   - "sync with auto_snapshot: false" → delete (config flag was sync-specific)
   - "sync with balance fetch failure" → delete (sync-specific failure path)
   - "multiple syncs on same day update existing snapshots" → "multiple materializeBalances calls on same day update existing snapshots"
   Remove `syncTransactions` import, `createTestProvider` import, `AppConfig` import if unused. (~60 LOC changed)

3. **`__tests__/integration/corpus-lineage.test.ts`** — All 4 tests use `syncTransactions()` to verify corpus lineage. The ingest pipeline has its own lineage chain (tested in `ingest-workflow.test.ts` I2 and I9). **Rewrite all 4 tests to use `ingestDocument()`** instead, verifying the ingest lineage chain: `raw-documents` → `ai-parse-results` → `sync-results` → `computation-snapshots`. This tests the same concept (corpus lineage) with the current pipeline. (~100 LOC rewrite)

4. **`__tests__/helpers.ts`** — `createTestProvider()` (lines 27-41) is still needed by some tests? Let me check... After migration, no test file will import `syncTransactions` or call `createTestProvider`. However, `InMemoryBankProvider` import and `createTestProvider` may still be used if any remaining tests use it. **Check after Task 1A**: grep for `createTestProvider` in remaining test files. If unused, remove it. Keep `InMemoryBankProvider` import since it's used by `createTestProvider`. If `createTestProvider` survives nowhere, remove it and the `InMemoryBankProvider` import from helpers. (~-15 LOC)

**Dependencies:** Task 1A must complete first (dead source files removed before fixing test imports).
**Estimated LOC:** -350 deleted, ~100 added (net -250)
**Files touched:** 4 test files (1 deleted, 3 edited), possibly helpers.ts

> **Note:** `createTestProvider` is also used in `super-import.test.ts` and `super-networth.test.ts` — wait, no, those use `createTestSuperProvider`. Let me check:
> - `super-import.test.ts` imports `syncSuper` from super-sync-service — NOT from sync-service. It uses `createTestSuperProvider`. Safe.
> - `super-networth.test.ts` same — uses super provider. Safe.
> 
> So after Phase 1, `createTestProvider` usage: `networth.test.ts` N8 (migrated away), `snapshot.test.ts` (migrated away), `corpus-lineage.test.ts` (migrated away), `sync-workflow.test.ts` (deleted). **Result: `createTestProvider` becomes dead — remove from helpers.ts.** Also remove `makeBalance` if only used by snapshot.test.ts sync tests (check: it's also used directly in snapshot.test.ts non-sync tests? No — `makeBalance` is only used in the sync-based snapshot tests. The pure snapshot tests use `upsertSnapshot` directly.) Remove `makeBalance` too.

### Phase 1 Parallel Execution Plan

```
Phase 1 (sequential — file overlap):
  Task 1A: Delete dead source files, edit providers/index.ts, edit commands, edit types
  Task 1B: Delete sync-workflow.test.ts, migrate 3 test files, clean helpers.ts
  → These share no files but 1B depends on 1A (test imports must resolve)
  → Run sequentially: 1A then 1B

Verification: typecheck + full test suite + lint + commit
```

Actually, 1A and 1B don't share any files — 1A edits `src/` files, 1B edits `__tests__/` files. They CAN run in parallel as long as the verification step handles any import resolution issues. But since 1B's test edits remove imports from files that 1A deletes, the tests won't compile until both complete. **Run in parallel, verify together.**

---

## Phase 2: Balance Extraction During Ingest

### Task 2A: Add `balance` field to `ParsedDocument` and update parsers (~50 LOC)

**Files to edit:**

1. **`src/providers/types.ts`** — Add optional `balance` field to `ParsedDocument`:
   ```ts
   export interface ParsedDocument {
     transactions: RawTransaction[];
     account?: { name?: string; institution?: string; type?: AccountType };
     balance?: { amount: number; asOf: string };  // NEW
     notes?: string[];
     rawResponse?: string;
   }
   ```
   (~3 LOC)

2. **`src/providers/csv/document-parser.ts`** — Instead of putting balance in `notes`, populate the new `balance` field. Use the latest transaction date as `asOf` (or today if no transactions):
   ```ts
   // After parsing all transactions, before the return:
   const latestDate = transactions.length > 0
     ? transactions.map(t => t.transactionDate).sort().pop()!
     : new Date().toISOString().slice(0, 10);

   return ok({
     transactions,
     account: { name: accountName, institution: "CSV Import", type: accountType },
     balance: latestBalance !== undefined
       ? { amount: latestBalance, asOf: latestDate }
       : undefined,
     notes: [],
   });
   ```
   Remove the old `notes: latestBalance !== undefined ? [...]  : []` line. (~10 LOC)

3. **`src/providers/ai/parser.ts`** — Add optional `statementBalance` to the AI response schema and prompt:
   - Add to `DOCUMENT_PARSE_PROMPT`: `Also extract the statement closing balance or latest balance if shown.`
   - Add to the JSON schema in the prompt: `"statementBalance": { "amount": 123.45, "asOf": "YYYY-MM-DD" }` (optional)
   - Add to `aiResponseSchema`: `statementBalance: z.object({ amount: z.number(), asOf: z.string() }).optional()`
   - Map to `ParsedDocument.balance` in the return:
     ```ts
     balance: data.statementBalance
       ? { amount: data.statementBalance.amount, asOf: data.statementBalance.asOf }
       : undefined,
     ```
   (~20 LOC)

4. **`src/providers/in-memory/document-parser.ts`** — No changes needed. `InMemoryDocumentParser` returns `ParsedDocument` which already allows any fields. The `balance` field will just be included in the canned response if set.

5. **`__tests__/helpers.ts`** — Update `makeParsedDocument()` to optionally include `balance`:
   ```ts
   export function makeParsedDocument(overrides?: Partial<ParsedDocument>): ParsedDocument {
     return {
       // ... existing fields ...
       balance: overrides?.balance,  // NEW — undefined by default
     };
   }
   ```
   (~2 LOC)

6. **`src/corpus/schemas.ts`** — Add optional `balance` to `aiParseResultSnapshotSchema`:
   ```ts
   balance: z.object({
     amount: z.number(),
     asOf: z.string(),
   }).optional(),
   ```
   (~4 LOC)

**Dependencies:** None.
**Estimated LOC:** ~50 added
**Files touched:** 5 files

### Task 2B: Wire balance into `ingestDocument()` pipeline (~30 LOC)

**Files to edit:**

1. **`src/services/ingest-service.ts`** — After Step 8 (account creation, line 238), add balance snapshot step:
   ```ts
   // Step 8.5: Upsert balance snapshot (if parser extracted balance data)
   let snapshotsUpserted = 0;
   if (parsed.balance && !options?.dryRun) {
     const snapResult = await upsertSnapshot(ctx.db, {
       accountId: account.id,
       date: parsed.balance.asOf,
       balance: parsed.balance.amount,
       syncRunId,
     });
     if (snapResult.ok) snapshotsUpserted = 1;
   }
   ```
   Also:
   - Add import: `import { upsertSnapshot } from "./snapshot-service.js";`
   - Update `snapshotsUpserted` in the return value (line 439: `snapshotsUpserted: 0` → `snapshotsUpserted`)
   - Update `computation-snapshots` materialization block (line 419: `snapshotsUpserted: 0` → `snapshotsUpserted`)
   - Update the sync_runs update (line 383: `snapshotsCreated: 0` → `snapshotsCreated: snapshotsUpserted`)
   (~15 LOC)

2. **`src/services/ingest-service.ts`** — Also add balance info to summary notes:
   ```ts
   if (parsed.balance) {
     summaryNotes.push(`Balance snapshot: $${parsed.balance.amount.toFixed(2)} as of ${parsed.balance.asOf}`);
   }
   ```
   (~3 LOC)

**Dependencies:** Task 2A must complete first (ParsedDocument.balance field must exist).
**Estimated LOC:** ~20 added
**Files touched:** 1 file (`ingest-service.ts`)

### Task 2C: Add integration tests for balance extraction (~60 LOC)

**Files to edit:**

1. **`__tests__/integration/ingest-workflow.test.ts`** — Add 2-3 new test cases:

   ```ts
   it("I14: ingest with balance creates snapshot", async () => {
     const doc = makeParsedDocument({
       balance: { amount: 1941.55, asOf: "2026-03-01" },
     });
     parser.setDefaultResult(doc);

     const result = await ingestDocument(ctx, parser, filePath, config);
     expect(result.ok).toBe(true);
     if (!result.ok) return;

     expect(result.value.snapshotsUpserted).toBe(1);

     const snapRows = ctx.db.select().from(snapshots).all();
     expect(snapRows.length).toBe(1);
     expect(snapRows[0]?.balance).toBe(1941.55);
   });

   it("I15: ingest with balance updates net worth", async () => {
     const doc = makeParsedDocument({
       account: { name: "Savings", institution: "BankSA", type: "savings" },
       balance: { amount: 5000, asOf: "2026-03-01" },
     });
     parser.setDefaultResult(doc);

     const result = await ingestDocument(ctx, parser, filePath, config);
     expect(result.ok).toBe(true);

     const nw = await getCurrentNetWorth(ctx.db);
     expect(nw.ok).toBe(true);
     if (!nw.ok) return;
     expect(nw.value.netWorth).toBe(5000);
     expect(nw.value.components.savings).toBe(5000);
   });

   it("I16: dry-run with balance does not create snapshot", async () => {
     const doc = makeParsedDocument({
       balance: { amount: 1000, asOf: "2026-03-01" },
     });
     parser.setDefaultResult(doc);

     const result = await ingestDocument(ctx, parser, filePath, config, { dryRun: true });
     expect(result.ok).toBe(true);
     if (!result.ok) return;

     expect(result.value.snapshotsUpserted).toBe(0);
     const snapRows = ctx.db.select().from(snapshots).all();
     expect(snapRows.length).toBe(0);
   });
   ```

   Also add imports: `snapshots` from schema, `getCurrentNetWorth` from networth-service. (~60 LOC)

**Dependencies:** Tasks 2A and 2B must complete first.
**Estimated LOC:** ~60 added
**Files touched:** 1 file (`ingest-workflow.test.ts`)

### Phase 2 Parallel Execution Plan

```
Phase 2a (parallel):
  Task 2A: ParsedDocument.balance field + parser updates (types.ts, csv/document-parser.ts, ai/parser.ts, corpus/schemas.ts, helpers.ts)
  Task 2B: Wire into ingest-service.ts
  → These share no files but 2B references types from 2A
  → 2A and 2B can run in parallel since 2B only uses the type, not imports from 2A's files
  → Actually 2B imports ParsedDocument from types.ts which 2A edits — but 2B doesn't change that import
  → They CAN run in parallel: 2A adds the field to the type, 2B reads it. No file overlap.

Phase 2b (sequential after 2a):
  Task 2C: Add integration tests
  → Depends on both 2A and 2B being complete

Verification: typecheck + full test suite + lint + commit
```

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| AI prompt change affects existing parsing | Medium | The `statementBalance` field is optional; if AI doesn't return it, no harm. Existing tests use `InMemoryDocumentParser`. |
| Removing `createProvider()` breaks something unexpected | Low | Grep confirms only dead commands use it. |
| Test migration misses a scenario | Medium | The migrated tests cover the same service-layer scenarios; ingest pipeline tests already cover the end-to-end flow. |
| Credit card balance sign confusion | Low | Store closing balance as positive; `computeNetWorth()` already subtracts credit type. Documented in design section. |

## BREAKING Changes

- **CLI**: `budget-sync snapshot` command removed. Users must use `budget-sync ingest` instead (balances auto-extracted).
- **CLI**: `budget-sync accounts discover` subcommand removed. Accounts are auto-created during `ingest`.
- **API**: `createProvider()` function removed from `src/providers/index.ts`. Any external code importing it will break.
- **API**: `SyncSummary` type removed from `src/providers/types.ts`.
- **API**: `syncTransactions()` function removed from `src/services/sync-service.ts`.
- **Type**: `ParsedDocument` gains optional `balance` field (non-breaking — additive).

---

## Full Execution Order

```
Phase 1: Dead Code Removal (parallel agents)
├── Agent A (Task 1A): Delete sync-service.ts, snapshot.ts cmd, csv/provider.ts,
│   edit providers/index.ts, types.ts, accounts.ts, networth.ts, index.ts,
│   csv/document-parser.ts
├── Agent B (Task 1B): Delete sync-workflow.test.ts, migrate networth.test.ts,
│   snapshot.test.ts, corpus-lineage.test.ts, clean helpers.ts
→ Verification: typecheck, full test suite, lint, commit

Phase 2a: Balance Feature (parallel agents)
├── Agent A (Task 2A): types.ts, csv/document-parser.ts, ai/parser.ts,
│   corpus/schemas.ts, helpers.ts
├── Agent B (Task 2B): ingest-service.ts
→ No commit yet — wait for 2C

Phase 2b: Tests (sequential)
├── Agent (Task 2C): ingest-workflow.test.ts
→ Verification: typecheck, full test suite, lint, commit
```

---

## LOC Summary

| Task | Added | Deleted | Net |
|------|-------|---------|-----|
| 1A: Dead source removal | ~10 | ~580 | -570 |
| 1B: Test migration | ~100 | ~350 | -250 |
| 2A: ParsedDocument + parsers | ~50 | ~5 | +45 |
| 2B: Ingest wiring | ~20 | ~0 | +20 |
| 2C: Integration tests | ~60 | ~0 | +60 |
| **Total** | **~240** | **~935** | **-695** |

---

## Suggested AGENTS.md / SKILL.md Updates

After this plan is implemented:

1. **Remove** from SKILL.md: `sync-service.ts` from project structure, `CsvBankProvider` from provider table, `createProvider()` from factory docs, `SyncSummary` from types, `snapshot.ts` from commands, `sync-workflow.test.ts` from test listing
2. **Update** SKILL.md: `snapshot.test.ts` description (remove "sync integration" wording), `networth.test.ts` description, `corpus-lineage.test.ts` description (now tests ingest lineage)
3. **Add** to SKILL.md: `ParsedDocument.balance` field documentation, balance extraction in ingest pipeline steps (new Step 8.5), note that net worth is populated via ingest balance extraction
4. **Remove** from "Common Tasks": "Adding a new provider" section that references `createProvider()` switch
5. **Update** CLI examples: remove `snapshot` command, update `accounts` to remove `discover`
