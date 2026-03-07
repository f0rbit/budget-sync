# AI Categorization + Transactions CLI

## Executive Summary

Three interconnected changes to eliminate the 43% "Other" categorization rate and give visibility into stored transactions:

1. **AI categorization pipeline step** — When local mappings don't match, batch uncategorized transactions to Claude for categorization using category descriptions, surrounding context, and existing mappings as reference.
2. **Auto-update merchant-mappings.jsonc** — AI returns both a categorization and a suggested mapping pattern. The system writes new rules to disk, making itself smarter over time.
3. **Transactions CLI command** — `budget-sync transactions list`, `transactions summary`, `transactions search`.

Bonus fixes: exclusion pattern anchoring, CSV fast path removal.

---

## Architecture Decisions

### D1: Where does AI categorization live?

**New pipeline step 3.5** inserted into `categorizePipeline()` between local-mappings and fallback.

The pipeline becomes:
1. Filter (exclude credits + exclusion patterns)
2. Rent (short-circuit)
3. Local mappings (substring match)
4. **AI categorization** (batch uncategorized → Claude → categorize + suggest mapping)
5. Fallback to "Other" (only if AI also fails, e.g. API error with `--offline` flag)

But the pipeline currently processes **one transaction at a time** (`categorizePipeline(tx, context)`). AI categorization needs batching for efficiency and context. So the architecture is:

- `categorizePipeline()` stays synchronous for steps 1-3. Step 4 (fallback) still exists as the final fallback.
- **`categorizeAll()` gains an AI batch pass** between the per-transaction loop and the final return. After the loop, any transaction that landed in "Other" gets collected and sent to the AI categorizer in a single batch call. AI results overwrite the "Other" categorizations.

This keeps the per-transaction pipeline pure and testable, while the batch AI step is a separate async operation.

### D2: Batching strategy

**Single batch call per `categorizeAll()` invocation.** All "Other" transactions from one ingest run are batched into one Claude API call. This:
- Reduces API calls (one call instead of N)
- Gives Claude context of surrounding transactions (what else was bought that day)
- Is simpler to implement and test

The AI prompt includes:
- The list of uncategorized transactions (description, amount, date)
- Up to 10 surrounding categorized transactions for context
- The full category list with descriptions
- Existing merchant mappings as reference (so AI knows what patterns already exist)

### D3: Auto-update merchant-mappings.jsonc

The AI response includes a `suggestedMappings` array. Each entry has:
- `match`: substring pattern to catch future similar transactions
- `item`: human-readable name
- `category`: one of the valid categories

After AI categorization, we:
1. Apply the AI categorizations to the transactions
2. Write the suggested mappings to `merchant-mappings.jsonc` (append to the mappings array)
3. The file is JSONC — we use `jsonc-parser`'s `modify()` + `applyEdits()` to preserve comments and formatting

No concurrency concern — CLI is single-user, single-process.

### D4: CSV fast path removal

**BREAKING: The `--parser csv` flag is removed.** CSV files now go through the unified ingest pipeline:

1. CSV is still parsed by `CsvBankProvider` for structured extraction (it's good at DD/MM/YYYY → ISO dates, debit/credit splitting, sha256 IDs)
2. But instead of `syncTransactions()`, CSV parsing produces `RawTransaction[]` that feeds into `ingestDocument()`'s pipeline
3. The pipeline runs local mappings → AI categorization → auto-add mappings

Implementation: The `ingest` command detects `.csv` files and uses a new `CsvDocumentParser` that wraps `CsvBankProvider`'s parsing logic behind the `DocumentParser` interface. This way CSV goes through the same `ingestDocument()` 14-step flow.

### D5: Corpus integration

**Yes — store AI categorization responses in a new corpus store.** Add `ai-categorization-results` store to capture:
- Which transactions were categorized by AI
- What categories/items the AI assigned
- What mappings were suggested
- The raw AI response

This links into the existing lineage chain: `raw-documents → ai-parse-results → **ai-categorization-results** → sync-results`.

### D6: Transactions CLI

Three subcommands under `budget-sync transactions`:
- `list` — paginated transaction list with filters (`--from`, `--to`, `--category`, `--account`, `--limit`)
- `summary` — category breakdown with totals and percentages for a date range
- `search <query>` — full-text search across `item` and `rawDescription`

---

## Impact Analysis

### Files Modified

| File | Change | Risk |
|------|--------|------|
| `src/pipeline/categorizer.ts` | Add AI batch step to `categorizeAll()`, expand `PipelineContext` | **HIGH** — core pipeline, many tests depend on it |
| `src/pipeline/local-mappings.ts` | Add `writeMappings()` function for auto-update | Medium |
| `src/pipeline/filter.ts` | No change needed — exclusion fix is in mappings file | Low |
| `src/providers/types.ts` | Add `AiCategorizer` interface, `AiCategorizationResult` type | Medium — types flow everywhere |
| `src/providers/ai/categorizer.ts` | **NEW** — `AnthropicAiCategorizer` implementation | N/A |
| `src/providers/in-memory/categorizer.ts` | **NEW** — `InMemoryAiCategorizer` for testing | N/A |
| `src/commands/ingest.ts` | Remove CSV fast path, unified flow | **HIGH** — BREAKING |
| `src/commands/transactions.ts` | **NEW** — `list`, `summary`, `search` subcommands | N/A |
| `src/services/transaction-service.ts` | Add `searchTransactions()`, `getCategorySummary()` | Low |
| `src/services/ingest-service.ts` | Accept `AiCategorizer` in context, pass to pipeline | Medium |
| `src/services/sync-service.ts` | Accept `AiCategorizer` in context, pass to pipeline | Medium |
| `src/index.ts` | Register `transactionsCommand` | Low |
| `merchant-mappings.jsonc` | Fix exclusion patterns | Low |
| `src/corpus/schemas.ts` | Add `AiCategorizationResultSnapshot` schema | Low |
| `src/corpus/stores.ts` | Add `ai-categorization-results` store | Low |
| `src/corpus/client.ts` | Register new store in `buildCorpus()` | Low |
| `src/corpus/index.ts` | Re-export new store | Low |
| `src/errors.ts` | Add `AI_CATEGORIZATION_FAILED` to `PipelineError` | Low |
| `__tests__/helpers.ts` | Add `makeAiCategorizer()`, update `createTestContext` | Medium |
| `__tests__/integration/categorization.test.ts` | Update for new pipeline step (needs AI categorizer in context or mock) | Medium |
| `__tests__/unit/filter.test.ts` | May need updates if exclusion patterns change | Low |
| `SKILL.md` | Update pipeline docs, new store, new commands | Low |

### Breaking Changes

1. **`--parser csv` CLI flag removed** — CSVs now always go through unified ingest pipeline. Users who relied on `bun run dev -- ingest foo.csv --parser csv` must drop `--parser csv` (it auto-detects `.csv` and uses the CSV parser internally).

2. **`PipelineContext` type expanded** — Now optionally includes `aiCategorizer`. All callers of `categorizeAll()` must provide the expanded context. Existing tests that don't provide it will still work (AI step is optional, falls back to "Other").

3. **`categorizeAll()` becomes async-aware of AI** — Already async, but now may make API calls when AI categorizer is provided. Tests using `categorizeAll()` with `InMemoryAiCategorizer` are unaffected.

---

## Task Breakdown

### Phase 1: Foundation Types + Exclusion Fix (sequential)

All foundation work that other phases depend on. Must be done first.

#### Task 1.1: AI Categorizer Interface + Types
**Files:** `src/providers/types.ts`
**LOC:** ~40
**Dependencies:** None

Add to `src/providers/types.ts`:
```ts
// AI Categorization types
interface AiCategorizationRequest {
  uncategorized: Array<{
    externalId: string;
    description: string;
    amount: number;
    date: string;
  }>;
  context: {
    categorizedTransactions: Array<{ item: string; category: Category; amount: number; date: string }>;
    categories: Array<{ name: Category; description: string }>;
    existingMappings: MerchantMapping[];
  };
}

interface AiCategorizationResult {
  categorizations: Array<{
    externalId: string;
    item: string;
    category: Category;
    notes: string;
  }>;
  suggestedMappings: Array<{
    match: string;
    item: string;
    category: Category;
  }>;
  rawResponse?: string;
}

interface AiCategorizer {
  readonly name: string;
  categorize(request: AiCategorizationRequest): Promise<Result<AiCategorizationResult, ProviderError>>;
}
```

#### Task 1.2: Error Type Extension
**Files:** `src/errors.ts`
**LOC:** ~10
**Dependencies:** None
**Parallel with:** 1.1, 1.3

Add `AI_CATEGORIZATION_FAILED` variant to `PipelineError`:
```ts
| { code: "AI_CATEGORIZATION_FAILED"; message: string }
```

Add constructor helper:
```ts
aiCategorizationFailed: (message: string): PipelineError => ({
  code: "AI_CATEGORIZATION_FAILED",
  message,
})
```

#### Task 1.3: Fix Exclusion Patterns
**Files:** `merchant-mappings.jsonc`
**LOC:** ~5
**Dependencies:** None
**Parallel with:** 1.1, 1.2

The exclusion patterns `^To 460184`, `^To 131007`, `^To 900021` are regex-anchored to start of string. But debit CSV descriptions look like `"Internet Withdrawal 04Mar09:39 To 460184 Credit Card Payment"`. The `^` anchor fails to match.

Fix: Remove the `^` anchor from these three patterns. They become:
- `To 460184` → matches anywhere in description
- `To 131007` → matches anywhere in description
- `To 900021` → matches anywhere in description

The `BETASHARES DIRECT` and `RENT MR MAXWELL` patterns don't use `^` and are fine.

Also update the test in `categorization.test.ts` — the existing test uses `"To 460184 Credit Card Payment"` which starts with "To" so `^To` matches. But real CSV descriptions have a prefix. Add a test case that uses the real CSV format: `"Internet Withdrawal 04Mar09:39 To 460184 Credit Card Payment"`.

#### Task 1.4: Category Descriptions Constant
**Files:** `src/providers/types.ts`
**LOC:** ~20
**Dependencies:** None
**Parallel with:** 1.1, 1.2, 1.3

Add category descriptions as a constant (used in AI prompts):
```ts
export const CATEGORY_DESCRIPTIONS: Record<Category, string> = {
  "Rent": "Housing rent payments",
  "Woolworths": "Woolworths grocery runs",
  "Eating Out": "Restaurants, takeaway, cafes, coffee, food delivery, paying mates back for food",
  "Alcohol": "Bars, bottle shops, pub drinks",
  "Subscriptions": "Recurring digital services",
  "Transport": "Fuel, parking, public transit, Uber rides, e-scooters",
  "Bills": "Utilities, internet, phone plan, insurance",
  "Health": "Medical, pharmacy, gym, health insurance",
  "Entertainment": "Events, concerts, museums, galleries, games, badminton, cinema",
  "Shopping": "Clothing, electronics, homewares, gifts, accessories",
  "Other": "Anything that doesn't fit above",
};
```

**Phase 1 verification:** typecheck, run existing tests, commit.

---

### Phase 2: AI Categorizer Implementations (parallel)

#### Task 2.1: In-Memory AI Categorizer
**Files:** `src/providers/in-memory/categorizer.ts` (NEW)
**LOC:** ~60
**Dependencies:** Phase 1

Create `InMemoryAiCategorizer` implementing `AiCategorizer`:
- Stores pre-configured results keyed by externalId
- Has `failNext` flag for error testing
- Has `setResult(externalId, item, category)` for per-transaction configuration
- Has `setDefaultCategory(category)` for blanket categorization
- Tracks all `categorize()` calls for assertion (stores requests received)
- Returns canned `suggestedMappings` if configured

```ts
export class InMemoryAiCategorizer implements AiCategorizer {
  readonly name = "in-memory-categorizer";
  private _results: Map<string, { item: string; category: Category }> = new Map();
  private _defaultCategory: Category = "Shopping";
  private _suggestedMappings: Array<{ match: string; item: string; category: Category }> = [];
  calls: AiCategorizationRequest[] = [];
  failNext = false;

  setResult(externalId: string, item: string, category: Category): void { ... }
  setDefaultCategory(category: Category): void { ... }
  setSuggestedMappings(mappings: ...): void { ... }

  async categorize(request: AiCategorizationRequest): Promise<Result<AiCategorizationResult, ProviderError>> {
    this.calls.push(request);
    if (this.failNext) { this.failNext = false; return err(errors.apiError(500, "Simulated AI failure")); }
    // Map each uncategorized tx to configured result or default
    ...
  }
}
```

#### Task 2.2: Anthropic AI Categorizer
**Files:** `src/providers/ai/categorizer.ts` (NEW)
**LOC:** ~130
**Dependencies:** Phase 1

Create `AnthropicAiCategorizer` implementing `AiCategorizer`:
- Takes Anthropic client config (apiKey, model, maxTokens)
- Builds a prompt with:
  - The uncategorized transactions
  - Surrounding categorized transactions for context
  - Full category list with descriptions
  - Existing merchant mappings
- Validates response with Zod schema
- Returns `AiCategorizationResult` with categorizations + suggested mappings

Prompt structure:
```
You are a financial transaction categorizer. Categorize the following transactions.

## Valid Categories
<table of categories with descriptions>

## Known Merchant Mappings (for reference)
<existing mappings from merchant-mappings.jsonc>

## Recently Categorized Transactions (for context)
<up to 10 nearby categorized transactions>

## Transactions to Categorize
<list of uncategorized transactions>

For each transaction, return:
1. A category from the valid list
2. A clean item name (e.g., "Water bill" instead of "Osko Withdrawal 04Mar09:39 Water Max Bruce")
3. A suggested mapping pattern (substring) that would catch similar transactions in future

Return JSON: {
  "categorizations": [{ "externalId": "...", "item": "...", "category": "...", "notes": "..." }],
  "suggestedMappings": [{ "match": "...", "item": "...", "category": "..." }]
}
```

#### Task 2.3: Update Provider Index + Factory
**Files:** `src/providers/index.ts`
**LOC:** ~20
**Dependencies:** Tasks 2.1, 2.2

Add `createAiCategorizer(config)` factory function and re-exports:
```ts
export function createAiCategorizer(config: AppConfig): Result<AiCategorizer, ConfigError> {
  const apiKeyResult = getAnthropicApiKey();
  if (!apiKeyResult.ok) return apiKeyResult;
  return ok(new AnthropicAiCategorizer({
    apiKey: apiKeyResult.value,
    model: config.anthropic.model,
    maxTokens: config.anthropic.max_tokens,
  }));
}
```

#### Task 2.4: Corpus Store for AI Categorization
**Files:** `src/corpus/schemas.ts`, `src/corpus/stores.ts`, `src/corpus/client.ts`, `src/corpus/index.ts`
**LOC:** ~40
**Dependencies:** Phase 1
**Parallel with:** Tasks 2.1, 2.2

Add `ai-categorization-results` store:

Schema (`src/corpus/schemas.ts`):
```ts
export const aiCategorizationResultSnapshotSchema = z.object({
  categorizer: z.string(),
  categorizedAt: z.string(),
  request: z.object({
    uncategorizedCount: z.number(),
    contextTransactionCount: z.number(),
  }),
  result: z.object({
    categorizations: z.array(z.object({
      externalId: z.string(),
      item: z.string(),
      category: z.enum(CATEGORIES),
      notes: z.string(),
    })),
    suggestedMappings: z.array(z.object({
      match: z.string(),
      item: z.string(),
      category: z.enum(CATEGORIES),
    })),
  }),
  rawResponse: z.string().optional(),
});
```

Store + registration following existing pattern.

#### Task 2.5: Test Helpers Update
**Files:** `__tests__/helpers.ts`
**LOC:** ~25
**Dependencies:** Task 2.1
**Parallel with:** Tasks 2.2, 2.3, 2.4

Add:
- `createTestAiCategorizer()` — factory for `InMemoryAiCategorizer`
- `makeAiCategorizationResult()` — fixture builder
- Update `createTestContext()` if needed

**Phase 2 verification:** typecheck, run existing tests (should all pass — no behavior changes yet), commit.

---

### Phase 3: Pipeline Integration (sequential)

This is the critical phase — modifying the core pipeline. Sequential because all tasks touch interconnected files.

#### Task 3.1: Expand PipelineContext + categorizeAll
**Files:** `src/pipeline/categorizer.ts`
**LOC:** ~60
**Dependencies:** Phase 2

Expand `PipelineContext`:
```ts
export interface PipelineContext {
  mappings: MerchantMappings;
  rentConfig: RentConfig;
  aiCategorizer?: AiCategorizer;  // Optional — when absent, falls back to "Other"
}
```

Modify `categorizeAll()` to add a post-loop AI batch step:

```ts
export async function categorizeAll(
  transactions: RawTransaction[],
  context: PipelineContext,
): Promise<{
  categorized: CategorizedTransaction[];
  excluded: ExcludedTransaction[];
  aiCategorizationResult?: AiCategorizationResult;
}> {
  const categorized: CategorizedTransaction[] = [];
  const excluded: ExcludedTransaction[] = [];

  // Step 1-4: Per-transaction pipeline (filter → rent → mapping → fallback)
  for (const tx of transactions) {
    const result = await categorizePipeline(tx, context);
    if (result.type === "categorized") {
      categorized.push(result.transaction);
    } else {
      excluded.push(result.transaction);
    }
  }

  // Step 5: AI batch categorization for "Other" transactions
  if (context.aiCategorizer) {
    const uncategorized = categorized.filter(tx => tx.category === "Other");
    if (uncategorized.length > 0) {
      const alreadyCategorized = categorized.filter(tx => tx.category !== "Other");
      const request: AiCategorizationRequest = {
        uncategorized: uncategorized.map(tx => ({
          externalId: tx.externalId,
          description: tx.rawDescription,
          amount: tx.amount,
          date: tx.date,
        })),
        context: {
          categorizedTransactions: alreadyCategorized.slice(0, 10).map(tx => ({
            item: tx.item,
            category: tx.category,
            amount: tx.amount,
            date: tx.date,
          })),
          categories: Object.entries(CATEGORY_DESCRIPTIONS).map(([name, description]) => ({
            name: name as Category,
            description,
          })),
          existingMappings: context.mappings.mappings,
        },
      };

      const aiResult = await context.aiCategorizer.categorize(request);
      if (aiResult.ok) {
        // Apply AI categorizations to the "Other" transactions
        for (const cat of aiResult.value.categorizations) {
          const tx = categorized.find(t => t.externalId === cat.externalId);
          if (tx) {
            tx.category = cat.category;
            tx.item = cat.item;
            tx.notes = cat.notes || tx.notes;
          }
        }
        return { categorized, excluded, aiCategorizationResult: aiResult.value };
      }
      // AI failure is non-fatal — transactions stay as "Other"
    }
  }

  return { categorized, excluded };
}
```

**Key: AI failure is non-fatal.** If the API call fails, transactions remain categorized as "Other". This is the same behavior as before — no regression.

**Key: Return type expanded.** `categorizeAll()` now optionally returns `aiCategorizationResult` so callers can snapshot it to corpus and trigger mapping writes.

#### Task 3.2: Auto-write Merchant Mappings
**Files:** `src/pipeline/local-mappings.ts`
**LOC:** ~50
**Dependencies:** Task 3.1

Add `appendMappings()` function:

```ts
export function appendMappings(
  newMappings: Array<{ match: string; item: string; category: Category }>,
  mappingsPath?: string,
): Result<number, PipelineError> {
  const resolvedPath = resolve(mappingsPath ?? DEFAULT_MAPPINGS_PATH);

  // Read existing file content
  const readResult = try_catch(
    () => readFileSync(resolvedPath, "utf-8"),
    (e) => errors.mappingLoadFailed(`Failed to read mappings file: ${e}`),
  );
  if (!readResult.ok) return readResult;

  let content = readResult.value;
  let added = 0;

  // Use jsonc-parser modify() to append each mapping to the "mappings" array
  for (const mapping of newMappings) {
    const edits = modify(content, ["mappings", -1], mapping, {
      isArrayInsertion: true,
      formattingOptions: { tabSize: 1, insertSpaces: false },
    });
    content = applyEdits(content, edits);
    added++;
  }

  // Write back
  const writeResult = try_catch(
    () => writeFileSync(resolvedPath, content, "utf-8"),
    (e) => errors.mappingLoadFailed(`Failed to write mappings file: ${e}`),
  );
  if (!writeResult.ok) return writeResult;

  return ok(added);
}
```

This preserves JSONC comments and formatting. Uses `jsonc-parser`'s `modify()` which is already a dependency.

#### Task 3.3: Wire AI into Ingest + Sync Services
**Files:** `src/services/ingest-service.ts`, `src/services/sync-service.ts`
**LOC:** ~80 (40 per file)
**Dependencies:** Tasks 3.1, 3.2

In both services, after `categorizeAll()`:

1. If `aiCategorizationResult` is returned, snapshot it to corpus `ai-categorization-results` store
2. If `suggestedMappings` is returned and not dry-run, call `appendMappings()`
3. Log the number of AI-categorized transactions and new mappings added

The `PipelineContext` construction in both services now includes `aiCategorizer` (passed via options or constructed from config).

Update `IngestOptions` and `SyncOptions`:
```ts
aiCategorizer?: AiCategorizer;
```

#### Task 3.4: Update Existing Tests
**Files:** `__tests__/integration/categorization.test.ts`, `__tests__/integration/sync-workflow.test.ts`, `__tests__/integration/ingest-workflow.test.ts`
**LOC:** ~40
**Dependencies:** Tasks 3.1, 3.2, 3.3

Existing tests pass an `aiCategorizer: undefined` context (since it's optional), so they should pass without changes. But verify and add:

- One test in `categorization.test.ts`: AI categorization upgrades "Other" to correct category
- One test: AI failure is non-fatal, transactions stay as "Other"
- One test in `categorization.test.ts`: with the fixed exclusion pattern matching real CSV format
- Update the `categorizeAll()` return type assertions in existing tests (now has optional `aiCategorizationResult`)

**Phase 3 verification:** typecheck, full test suite, commit.

---

### Phase 4: CSV Unification + CLI (parallel)

#### Task 4.1: Unify CSV Ingest Path
**Files:** `src/commands/ingest.ts`
**LOC:** ~60
**Dependencies:** Phase 3

Remove the CSV fast path branch. The new flow:

```ts
// Detect CSV and create appropriate parser
let parser: DocumentParser;
if (file.endsWith(".csv")) {
  // CSV files use the CSV parser for structured extraction,
  // then go through the same pipeline
  parser = new CsvDocumentParser({ filePath: file, ... });
} else {
  const parserResult = createDocumentParser(config);
  if (!parserResult.ok) { ... }
  parser = parserResult.value;
}

// Create AI categorizer (optional — fails gracefully if no API key)
let aiCategorizer: AiCategorizer | undefined;
const catResult = createAiCategorizer(config);
if (catResult.ok) aiCategorizer = catResult.value;

// Unified ingest
const result = await ingestDocument(ctx, parser, file, config, {
  ...options,
  aiCategorizer,
});
```

**BREAKING:** `--parser csv` flag removed. CSV auto-detection by file extension is preserved.

#### Task 4.2: CSV Document Parser Adapter
**Files:** `src/providers/csv/document-parser.ts` (NEW)
**LOC:** ~50
**Dependencies:** Phase 3
**Parallel with:** Tasks 4.1, 4.3

Create `CsvDocumentParser` that wraps `CsvBankProvider`'s parsing logic as a `DocumentParser`:

```ts
export class CsvDocumentParser implements DocumentParser {
  readonly name = "csv";
  private config: { accountName: string; accountType: AccountType };

  constructor(config: { accountName: string; accountType?: AccountType }) { ... }

  async parse(content: string, mimeType: string, accountHint?: ...): Promise<Result<ParsedDocument, ProviderError>> {
    // Reuse CSV parsing logic from CsvBankProvider
    // But wrapped in DocumentParser interface
    // Returns ParsedDocument with transactions + account info
  }
}
```

Extract the CSV parsing logic from `CsvBankProvider.parseCSV()` and `CsvBankProvider.parseLine()` into shared utility functions that both `CsvBankProvider` and `CsvDocumentParser` can use. This avoids code duplication.

#### Task 4.3: Transactions CLI Command
**Files:** `src/commands/transactions.ts` (NEW), `src/index.ts`, `src/services/transaction-service.ts`
**LOC:** ~150 (100 command + 50 service)
**Dependencies:** Phase 1 (types only)
**Parallel with:** Tasks 4.1, 4.2

**New file: `src/commands/transactions.ts`**

```
budget-sync transactions list [--from <date>] [--to <date>] [--category <cat>] [--account <id>] [--limit <n>]
budget-sync transactions summary [--from <date>] [--to <date>] [--account <id>]
budget-sync transactions search <query> [--limit <n>]
```

`list` output:
```
Date        Amount    Category       Item
─────────────────────────────────────────────────
2026-03-05  $42.50    Woolworths     Woolworths (Brisbane)
2026-03-05  $15.00    Eating Out     McDonald's
2026-03-04  $8.50     Transport      Go Card
...
42 transactions | $1,234.50 total
```

`summary` output:
```
Category Breakdown (2026-03-01 to 2026-03-31)
─────────────────────────────────────────────────
Eating Out       $345.00   28%  ████████████
Woolworths       $280.00   23%  █████████
Shopping         $190.00   15%  ██████
Transport        $120.00   10%  ████
...
Total:           $1,234.50
```

`search` — query against `item` and `rawDescription` columns:

**Add to `src/services/transaction-service.ts`:**

```ts
export async function searchTransactions(
  db: AppDatabase,
  query: string,
  limit?: number,
): Promise<Result<TransactionRow[], DbError>> {
  return try_catch_async(async () => {
    const pattern = `%${query}%`;
    return db.select().from(transactions)
      .where(or(
        like(transactions.item, pattern),
        like(transactions.rawDescription, pattern),
      ))
      .orderBy(desc(transactions.date))
      .limit(limit ?? 50)
      .all();
  }, (e) => errors.dbError(`Failed to search transactions: ${e}`, e));
}

export async function getCategorySummary(
  db: AppDatabase,
  filters?: { dateFrom?: string; dateTo?: string; accountId?: string },
): Promise<Result<Array<{ category: Category; total: number; count: number }>, DbError>> {
  return try_catch_async(async () => {
    const conditions = [];
    conditions.push(eq(transactions.direction, "debit"));
    conditions.push(eq(transactions.excluded, false));
    if (filters?.dateFrom) conditions.push(gte(transactions.date, filters.dateFrom));
    if (filters?.dateTo) conditions.push(lte(transactions.date, filters.dateTo));
    if (filters?.accountId) conditions.push(eq(transactions.accountId, filters.accountId));

    return db.select({
      category: transactions.category,
      total: sql<number>`sum(${transactions.amount})`,
      count: sql<number>`count(*)`,
    })
    .from(transactions)
    .where(and(...conditions))
    .groupBy(transactions.category)
    .orderBy(desc(sql`sum(${transactions.amount})`))
    .all();
  }, (e) => errors.dbError(`Failed to get category summary: ${e}`, e));
}
```

Register in `src/index.ts`:
```ts
import { transactionsCommand } from "./commands/transactions.js";
program.addCommand(transactionsCommand);
```

**Phase 4 verification:** typecheck, full test suite, lint, commit.

---

### Phase 5: Integration Tests (sequential)

#### Task 5.1: AI Categorization Integration Tests
**Files:** `__tests__/integration/ai-categorization.test.ts` (NEW)
**LOC:** ~200
**Dependencies:** Phase 4

Test workflows:

1. **Full pipeline with AI** — Transactions that don't match local mappings get AI-categorized
2. **AI suggests mappings → mappings written** — After AI categorization, new mappings appear in merchant-mappings.jsonc (use temp file)
3. **Second ingest hits new mapping** — After AI adds a mapping, re-ingesting same description hits local mapping (no AI call)
4. **AI failure is non-fatal** — When `failNext` is set, transactions stay as "Other"
5. **CSV through unified pipeline** — CSV file goes through ingest pipeline with AI categorization
6. **Corpus lineage** — AI categorization results stored in corpus with correct parent lineage
7. **Dry run skips mapping writes** — AI categorizes but doesn't write to merchant-mappings.jsonc
8. **Batch context** — AI receives surrounding categorized transactions in context
9. **Fixed exclusion patterns** — Real CSV descriptions with "Internet Withdrawal" prefix are excluded

#### Task 5.2: Transactions CLI Integration Tests
**Files:** `__tests__/integration/transactions-cli.test.ts` (NEW)
**LOC:** ~120
**Dependencies:** Phase 4

Test workflows:

1. **List with filters** — `getTransactions()` with dateFrom/dateTo/category/limit
2. **Summary aggregation** — `getCategorySummary()` returns correct totals and percentages
3. **Search** — `searchTransactions()` matches item and rawDescription
4. **Empty results** — All queries return empty arrays when no data
5. **Category filter** — Filtering by specific category returns only matching transactions

**Phase 5 verification:** typecheck, full test suite, lint, commit.

---

### Phase 6: Documentation (sequential)

#### Task 6.1: Update SKILL.md
**Files:** `SKILL.md`
**LOC:** ~50
**Dependencies:** Phase 5

Update:
- Pipeline description (5 steps now, not 4)
- New corpus store
- New CLI commands
- CSV fast path removal
- AI categorizer provider pattern

**Phase 6 verification:** lint, commit.

---

## Phase Summary

| Phase | Tasks | Parallel? | Est. LOC | Key Risk |
|-------|-------|-----------|----------|----------|
| 1: Foundation | 1.1, 1.2, 1.3, 1.4 | 1.1-1.4 all parallel | ~75 | Low |
| 2: AI Implementations | 2.1, 2.2, 2.3, 2.4, 2.5 | 2.1, 2.2, 2.4 parallel; 2.3 after 2.1+2.2; 2.5 after 2.1 | ~275 | Medium (prompt engineering) |
| 3: Pipeline Integration | 3.1, 3.2, 3.3, 3.4 | Sequential | ~230 | **HIGH** (core pipeline change) |
| 4: CSV + CLI | 4.1, 4.2, 4.3 | 4.1, 4.2, 4.3 parallel | ~260 | Medium (breaking change) |
| 5: Integration Tests | 5.1, 5.2 | Parallel | ~320 | Low |
| 6: Documentation | 6.1 | Sequential | ~50 | Low |
| **Total** | | | **~1,210** | |

---

## Test Plan

### Unit Tests (pure functions)
- `appendMappings()` — writes correct JSONC, preserves comments
- `searchTransactions()` / `getCategorySummary()` — correct SQL queries
- Category descriptions constant completeness

### Integration Tests (in-memory DB + corpus + InMemoryAiCategorizer)
- Full ingest with AI categorization (CSV and non-CSV paths)
- AI mapping suggestion → auto-write → subsequent match
- AI failure non-fatal fallback
- Corpus lineage chain with new store
- Transaction list/summary/search queries
- Exclusion pattern fix with real CSV descriptions

### Manual Testing (with real API key)
- `bun run dev -- ingest real-statement.csv` — verify AI categorizes "Other" transactions
- `bun run dev -- transactions list --from 2026-03-01`
- `bun run dev -- transactions summary`
- Check `merchant-mappings.jsonc` for new auto-added rules
- Re-run same CSV — verify new mappings catch transactions without AI

---

## Open Questions

None — all design decisions resolved above. The plan is ready for implementation.

---

## Suggested AGENTS.md Updates

After implementation, add to SKILL.md (this project uses SKILL.md instead of AGENTS.md):

1. **Pipeline section** — Update from 4-step to 5-step pipeline, document `AiCategorizer` optional context
2. **AI Categorizer** — Document the `AiCategorizer` interface and `InMemoryAiCategorizer` test pattern
3. **CSV unification** — Note that `--parser csv` is removed, CSV auto-detects via extension
4. **New corpus store** — `ai-categorization-results` with lineage
5. **New CLI commands** — `transactions list`, `transactions summary`, `transactions search`
6. **Auto-mapping** — Document that AI categorization auto-appends to `merchant-mappings.jsonc`
