# Budget Sync — Comprehensive Implementation Plan

> **Supersedes** the previous budget-sync-tool.md plan (transaction import only).
> This plan covers the full personal finance CLI: budget transactions, savings snapshots, super, investments, and net worth.

---

## Executive Summary

`budget-sync` is a personal finance CLI tool that unifies bank transactions, savings balances, superannuation, and stock investments into a single SQLite database. It tracks net worth over time via point-in-time snapshots. Bank data comes primarily through Basiq (CDR intermediary), with manual CSV/JSON import as fallback for providers without APIs. The DB is the source of truth; Obsidian markdown export is optional. Built with Bun, Drizzle ORM, Commander, and `@f0rbit/corpus` — used both for `Result<T,E>` error handling (`pipe()`, `try_catch`, `fetch_result()`) and as a versioned data store (corpus stores for raw API snapshots and sync results).

### Architecture: Corpus-First Data Flow

```
Provider (Basiq/CSV/InMemory)
    │
    ├─→ corpus.stores["raw-transactions"].put(snapshot)  ── versioned, deduped
    ├─→ corpus.stores["raw-accounts"].put(snapshot)      ── versioned, deduped
    ├─→ corpus.stores["raw-balances"].put(snapshot)      ── versioned, deduped
    │
    ▼
Pure pipeline functions (compose snapshots → categorized results)
    │
    ├─→ corpus.stores["sync-results"].put(result, { parents: [raw snapshots] })
    │
    ▼
SQLite/Drizzle (materialize for querying)
```

Raw API data is snapshotted into corpus stores **before** any processing. The categorization pipeline operates on immutable snapshot data. Sync results are stored with lineage (`parents`) linking back to raw transaction snapshots. SQLite materialization happens **after** the sync-results snapshot is persisted.

---

## Table of Contents

1. [Project Overview & Milestones](#1-project-overview--milestones)
2. [Data Model (Drizzle Schema)](#2-data-model-drizzle-schema)
3. [Provider Architecture](#3-provider-architecture)
4. [CLI Commands](#4-cli-commands)
5. [Configuration & Merchant Mappings](#5-configuration--merchant-mappings)
6. [SKILL.md Outline](#6-skillmd-outline)
7. [Milestone 0: Detailed Implementation Plan](#7-milestone-0-detailed-implementation-plan)
8. [Milestones 1–3: High-Level Scoping](#8-milestones-13-high-level-scoping)
9. [Testing Strategy](#9-testing-strategy)
10. [Suggested AGENTS.md Updates](#10-suggested-agentsmd-updates)

---

## 1. Project Overview & Milestones

### Vision

A single CLI tool that answers: *"What is my net worth today, and how has it changed?"*

It does this by:
- Importing **bank transactions** (spending) from Basiq and categorizing them
- Capturing **balance snapshots** of all accounts on every sync
- Tracking **superannuation** balance and contributions (REST Super)
- Tracking **investment holdings** (Betashares Direct — ETFs)
- Computing **net worth** = savings + investments + super − credit card debt
- **Corpus stores** snapshot all raw API data and sync results for versioning, lineage, and deterministic replay

### Milestones

| Milestone | Scope | Status |
|-----------|-------|--------|
| **M0: Budget Sync + DB** | Schema, corpus stores, providers, pipeline, Basiq transactions, Obsidian export, merchant mappings, SKILL.md | **Phases 0–0.5 COMPLETE; Phases 0.6–0.10 in progress** |
| **M1: Savings Snapshots + Net Worth** | Balance snapshots on sync, `snapshot` command, `networth` command (bank-only) | Scoped |
| **M2: Super Integration** | REST Super via Basiq or manual import, contributions tracking | Scoped |
| **M3: Investment Tracking** | Betashares Direct holdings, ASX price lookup, investment transactions | Scoped |
| **M4: TUI + Charts** | OpenTUI dashboard, net worth chart, spending trends | Future (not scoped) |

### Key Differences from Previous Plan

| Aspect | Previous | This Plan |
|--------|----------|-----------|
| Data store | Flat JSON state file | SQLite + Drizzle ORM + Corpus stores |
| Source of truth | Obsidian markdown notes | Database (corpus stores for raw data lineage) |
| Obsidian | Primary output | Optional export |
| Scope | Budget transactions only | Full personal finance |
| Duplicate detection | State file + filesystem scan | DB-level (transaction source IDs) |
| Accounts | Configured in JSONC | Discovered via provider, stored in DB |
| Net worth | Not tracked | Core feature (M1+) |
| Raw data archival | Not tracked | Corpus stores snapshot every API response |
| Error handling | Basic try/catch | `pipe()` chains, `fetch_result()`, `try_catch_async()` |

---

## 2. Data Model (Drizzle Schema)

### Entity Relationship Overview

```
accounts ──┬── transactions (budget spending)
            ├── snapshots (point-in-time balances)
            ├── holdings (investment positions, M3)
            └── contributions (super contributions, M2)

sync_runs ──── sync_run_results (per-account sync outcomes)

corpus stores:
  raw-transactions ──→ sync-results (parents linkage)
  raw-accounts
  raw-balances
```

### Schema Definition

All tables defined in `src/db/schema.ts`. Using SQLite with `drizzle-orm/sqlite-core`.

```typescript
// === ENUMS (as const arrays for Zod + Drizzle) ===

const accountTypes = ["transaction", "savings", "credit", "super", "investment"] as const;
const transactionDirections = ["debit", "credit"] as const;
const categories = [
  "Rent", "Woolworths", "Eating Out", "Alcohol", "Subscriptions",
  "Transport", "Bills", "Health", "Entertainment", "Shopping", "Other"
] as const;
const syncStatuses = ["success", "partial", "failed"] as const;
const contributionTypes = ["employer", "salary_sacrifice", "voluntary", "fhss", "government"] as const;

// === TABLES ===

// accounts — all financial accounts (bank, super, investment)
accounts = sqliteTable("accounts", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  external_id: text("external_id"),           // Provider-specific ID (Basiq account ID)
  provider: text("provider").notNull(),        // "basiq", "csv", "manual"
  name: text("name").notNull(),                // "BankSA Amplify Platinum"
  institution: text("institution"),            // "BankSA"
  type: text("type", { enum: accountTypes }).notNull(),
  is_active: integer("is_active", { mode: "boolean" }).notNull().default(true),
  metadata: text("metadata", { mode: "json" }), // Provider-specific extra data
  created_at: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updated_at: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// transactions — budget spending (debit transactions from bank accounts)
transactions = sqliteTable("transactions", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  account_id: text("account_id").notNull().references(() => accounts.id),
  external_id: text("external_id"),            // Provider transaction ID (for dedup)
  date: text("date").notNull(),                // YYYY-MM-DD (transaction date)
  post_date: text("post_date"),                // YYYY-MM-DD (post date)
  raw_description: text("raw_description").notNull(),
  item: text("item").notNull(),                // Human-readable name
  amount: real("amount").notNull(),            // Always positive
  direction: text("direction", { enum: transactionDirections }).notNull(),
  category: text("category", { enum: categories }).notNull(),
  notes: text("notes").default(""),
  excluded: integer("excluded", { mode: "boolean" }).notNull().default(false),
  exclude_reason: text("exclude_reason"),
  sync_run_id: text("sync_run_id").references(() => syncRuns.id),
  created_at: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  externalIdIdx: uniqueIndex("transactions_external_id_idx").on(table.external_id),
  dateIdx: index("transactions_date_idx").on(table.date),
  categoryIdx: index("transactions_category_idx").on(table.category),
}));

// snapshots — point-in-time balance snapshots (M1)
snapshots = sqliteTable("snapshots", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  account_id: text("account_id").notNull().references(() => accounts.id),
  date: text("date").notNull(),                // YYYY-MM-DD
  balance: real("balance").notNull(),          // Current balance
  available: real("available"),                // Available balance (may differ for credit)
  sync_run_id: text("sync_run_id").references(() => syncRuns.id),
  created_at: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  dateIdx: index("snapshots_date_idx").on(table.date),
  accountDateIdx: uniqueIndex("snapshots_account_date_idx").on(table.account_id, table.date),
}));

// holdings — investment positions (M3)
holdings = sqliteTable("holdings", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  account_id: text("account_id").notNull().references(() => accounts.id),
  ticker: text("ticker").notNull(),            // ASX ticker e.g. "DHHF"
  name: text("name"),                          // "Betashares Diversified All Growth"
  units: real("units").notNull(),
  purchase_price: real("purchase_price"),       // Average cost basis per unit
  current_price: real("current_price"),         // Last known price per unit
  current_value: real("current_value"),         // units * current_price
  date: text("date").notNull(),                // Snapshot date
  sync_run_id: text("sync_run_id").references(() => syncRuns.id),
  created_at: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  tickerDateIdx: index("holdings_ticker_date_idx").on(table.ticker, table.date),
}));

// contributions — super contributions (M2)
contributions = sqliteTable("contributions", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  account_id: text("account_id").notNull().references(() => accounts.id),
  date: text("date").notNull(),
  type: text("type", { enum: contributionTypes }).notNull(),
  amount: real("amount").notNull(),
  description: text("description"),
  sync_run_id: text("sync_run_id").references(() => syncRuns.id),
  created_at: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// sync_runs — tracks each sync execution
syncRuns = sqliteTable("sync_runs", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  provider: text("provider").notNull(),
  started_at: integer("started_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  finished_at: integer("finished_at", { mode: "timestamp" }),
  status: text("status", { enum: syncStatuses }).notNull().default("success"),
  transactions_created: integer("transactions_created").default(0),
  transactions_excluded: integer("transactions_excluded").default(0),
  transactions_skipped: integer("transactions_skipped").default(0),  // duplicates
  snapshots_created: integer("snapshots_created").default(0),
  error_message: text("error_message"),
  metadata: text("metadata", { mode: "json" }),
});
```

### Design Notes

- **`external_id`** on transactions is the deduplication key. Before inserting, check if an `external_id` already exists. This replaces the previous state-file approach.
- **`snapshots`** table has a unique constraint on `(account_id, date)` — one snapshot per account per day. Upserting on sync.
- **`holdings`** and **`contributions`** are designed for M2/M3 but the tables are created in M0's schema so migrations don't need to alter structure later. They'll be empty until those milestones.
- **`metadata`** JSON columns store provider-specific data we might need but don't want to schema-ify (e.g., Basiq connection IDs, institution logos).
- All IDs use `cuid2` for sortable, collision-resistant identifiers.
- Dates stored as `text` in `YYYY-MM-DD` format for readability and timezone-free comparisons.

---

## 3. Provider Architecture

### Provider Interfaces

Three separate interfaces for three data domains. A single provider (like Basiq) may implement multiple interfaces.

```typescript
// src/providers/types.ts

interface DateRange {
  from: string;  // YYYY-MM-DD
  to: string;    // YYYY-MM-DD
}

// --- Bank / Transaction Provider ---

interface RawTransaction {
  id: string;                       // Provider-specific unique ID
  description: string;              // Raw bank description
  amount: number;                   // Always positive
  direction: "debit" | "credit";
  transactionDate: string;          // YYYY-MM-DD
  postDate: string;                 // YYYY-MM-DD
  accountId: string;                // Provider account ID
  enrichment?: {
    merchantName?: string;
    category?: string;
    location?: string;
  };
}

interface AccountInfo {
  id: string;
  name: string;
  institution: string;
  type: "transaction" | "savings" | "credit" | "super" | "investment";
  balance?: number;
  availableBalance?: number;
}

interface BankProvider {
  name: string;
  authenticate(): Promise<Result<void, ProviderError>>;
  getAccounts(): Promise<Result<AccountInfo[], ProviderError>>;
  fetchTransactions(accountId: string, range: DateRange): Promise<Result<RawTransaction[], ProviderError>>;
  getAccountBalances(): Promise<Result<AccountBalance[], ProviderError>>;
  enrichTransaction?(description: string): Promise<Result<EnrichmentData, ProviderError>>;
}

interface AccountBalance {
  accountId: string;
  balance: number;
  available?: number;
  asOf: string;  // YYYY-MM-DD
}

interface EnrichmentData {
  merchantName?: string;
  category?: string;
  location?: string;
}

// --- Investment Provider (M3) ---

interface InvestmentProvider {
  name: string;
  authenticate(): Promise<Result<void, ProviderError>>;
  getHoldings(): Promise<Result<Holding[], ProviderError>>;
  getTransactions(range: DateRange): Promise<Result<InvestmentTransaction[], ProviderError>>;
}

interface Holding {
  ticker: string;
  name: string;
  units: number;
  purchasePrice?: number;
  currentPrice?: number;
  currentValue: number;
}

interface InvestmentTransaction {
  id: string;
  ticker: string;
  type: "buy" | "sell" | "dividend" | "distribution";
  units: number;
  pricePerUnit: number;
  totalValue: number;
  date: string;
}

// --- Super Provider (M2) ---

interface SuperProvider {
  name: string;
  authenticate(): Promise<Result<void, ProviderError>>;
  getBalance(): Promise<Result<SuperBalance, ProviderError>>;
  getContributions(range: DateRange): Promise<Result<SuperContribution[], ProviderError>>;
}

interface SuperBalance {
  accountId: string;
  balance: number;
  asOf: string;
}

interface SuperContribution {
  id: string;
  date: string;
  type: "employer" | "salary_sacrifice" | "voluntary" | "fhss" | "government";
  amount: number;
  description?: string;
}
```

### Provider Implementations (M0)

| Provider | Interface | Purpose |
|----------|-----------|---------|
| `BasiqBankProvider` | `BankProvider` | Production — fetches from Basiq API |
| `CsvBankProvider` | `BankProvider` | Manual import from bank CSV exports |
| `InMemoryBankProvider` | `BankProvider` | Testing — in-memory arrays |

### Error Types

```typescript
// src/errors.ts

type ProviderError =
  | { code: "AUTH_FAILED"; message: string }
  | { code: "RATE_LIMITED"; message: string; retryAfter?: number }
  | { code: "NOT_FOUND"; message: string; resource: string }
  | { code: "API_ERROR"; message: string; status: number }
  | { code: "NETWORK_ERROR"; message: string }
  | { code: "PARSE_ERROR"; message: string; raw?: string };

type ConfigError =
  | { code: "CONFIG_NOT_FOUND"; path: string }
  | { code: "CONFIG_INVALID"; message: string; errors: ZodError };

type DbError =
  | { code: "DB_ERROR"; message: string; cause?: unknown }
  | { code: "DUPLICATE"; message: string; externalId: string };

type PipelineError =
  | { code: "MAPPING_LOAD_FAILED"; message: string }
  | { code: "CATEGORIZATION_FAILED"; message: string; transactionId: string };

type ExportError =
  | { code: "WRITE_FAILED"; path: string; message: string }
  | { code: "VAULT_NOT_FOUND"; path: string };
```

### Basiq API Surface (M0)

Endpoints used:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `POST /token` | POST | API key → JWT (server scope) |
| `GET /users/{id}/accounts` | GET | List connected accounts + balances |
| `GET /users/{id}/transactions` | GET | Paginated transaction list with filters |
| `GET /enrich` | GET | Merchant name/category enrichment |

Auth flow:
1. `POST /token` with `Authorization: Basic base64(apiKey:)` and `basiq-version: 3.0`
2. Response includes `access_token` (JWT) and `expires_in`
3. Cache token, refresh when expired
4. All subsequent requests use `Authorization: Bearer {token}`

Pagination: Basiq uses cursor-based pagination via `links.next` in response body.

Rate limits: 10 requests/second (production). Use `Semaphore` from corpus for rate limiting.

---

## 4. CLI Commands

Built with Commander. Entry point: `src/index.ts`. Binary name: `budget-sync`.

### M0 Commands

```
budget-sync sync [options]
  Fetch transactions from provider, categorize, and store in DB.
  Creates corpus snapshots of raw data and sync results.

  Options:
    --from <date>        Start date (YYYY-MM-DD). Default: last sync date or 30 days ago
    --to <date>          End date (YYYY-MM-DD). Default: today
    --dry-run            Preview without writing to DB (still creates corpus snapshots)
    --provider <name>    Override provider (default: from config)
    --account <id>       Sync specific account only
    --verbose            Show detailed output

budget-sync accounts [options]
  List and manage connected accounts.

  Subcommands:
    list                 List all accounts in DB
    discover             Fetch accounts from provider and add new ones to DB
    deactivate <id>      Mark account as inactive (excluded from sync)

budget-sync mappings [options]
  Manage merchant categorization mappings.

  Subcommands:
    list                 List all mappings
    search <query>       Search mappings by merchant name
    unmapped             List transactions categorized as "Other" (need mapping)

budget-sync export [options]
  Export transactions to Obsidian markdown notes.

  Options:
    --from <date>        Start date
    --to <date>          End date
    --dry-run            Preview without writing files
    --force              Overwrite existing notes

budget-sync import <file> [options]
  Import transactions from a CSV/JSON file.

  Options:
    --format <type>      "csv" or "json" (auto-detected from extension)
    --account <name>     Account name to associate with
    --type <type>        Account type (credit, debit, savings)
```

### M1 Commands (added later)

```
budget-sync snapshot [options]
  Capture balance snapshots for all active accounts.

  Options:
    --date <date>        Snapshot date (default: today)

budget-sync networth [options]
  Show current net worth and history.

  Options:
    --history            Show net worth over time
    --from <date>        History start date
    --format <type>      "table" (default), "csv", "json"
```

---

## 5. Configuration & Merchant Mappings

### config.jsonc

```jsonc
{
  "$schema": "./config.schema.json",

  // Where the SQLite database lives
  "db_path": "./data/budget-sync.db",

  // Where corpus stores live (versioned snapshots)
  "corpus_dir": "./data/corpus",

  // Obsidian vault (for export command only)
  "vault_path": "/Users/tom/Documents/Vaults/Personal",
  "budget_dir": "Budget",

  // Default provider for sync
  "provider": "basiq",

  // Basiq configuration
  "basiq": {
    // API key resolved from BASIQ_API_KEY env var — never stored here
    "user_id": "xxx-xxx-xxx",
    "api_url": "https://au-api.basiq.io"
  },

  // Sync defaults
  "sync": {
    "default_range_days": 30,
    "auto_snapshot": true  // Capture balance snapshots on every sync
  },

  // Rent configuration
  "rent": {
    "solo_start_date": "2026-03-01",
    "solo_weekly_amount": 650,
    "shared_roommate_contribution": 450,
    "landlord_patterns": ["IPY*GRACZYKTHOMPSON", "GRACZYKTHOMPSON"],
    "debit_rent_patterns": ["Internet Withdrawal.*Rent"]
  }
}
```

### Config Zod Schema

```typescript
const configSchema = z.object({
  db_path: z.string().default("./data/budget-sync.db"),
  corpus_dir: z.string().default("./data/corpus"),
  vault_path: z.string(),
  budget_dir: z.string().default("Budget"),
  provider: z.enum(["basiq", "csv", "manual"]).default("basiq"),
  basiq: z.object({
    user_id: z.string(),
    api_url: z.string().url().default("https://au-api.basiq.io"),
  }).optional(),
  sync: z.object({
    default_range_days: z.number().int().positive().default(30),
    auto_snapshot: z.boolean().default(true),
  }).default({}),
  rent: z.object({
    solo_start_date: z.string().regex(/\d{4}-\d{2}-\d{2}/),
    solo_weekly_amount: z.number().positive(),
    shared_roommate_contribution: z.number().nonnegative(),
    landlord_patterns: z.array(z.string()),
    debit_rent_patterns: z.array(z.string()),
  }),
});
```

### merchant-mappings.jsonc

Same format as previous plan. File: `merchant-mappings.jsonc`, schema: `merchant-mappings.schema.json`.

```jsonc
{
  "$schema": "./merchant-mappings.schema.json",
  "mappings": [
    // --- Rent ---
    // Handled specially by rent pipeline step, not by generic mapping

    // --- Alcohol ---
    { "match": "FIREFLY BRISBANE", "item": "Firefly Brisbane", "category": "Alcohol" },
    { "match": "DAN MURPHY", "item": "Dan Murphy's", "category": "Alcohol" },
    { "match": "BWS", "item": "BWS", "category": "Alcohol" },
    { "match": "MALT TRADERS", "item": "Malt Traders", "category": "Alcohol" },

    // --- Eating Out ---
    { "match": "MISO HUNGRY", "item": "Miso Hungry", "category": "Eating Out" },
    { "match": "PBH CULTURE", "item": "PBH Culture", "category": "Eating Out" },
    { "match": "GZ BLUE", "item": "GZ Blue", "category": "Eating Out" },
    { "match": "MCDONALDS", "item": "McDonald's", "category": "Eating Out" },
    { "match": "SUBWAY", "item": "Subway", "category": "Eating Out" },
    { "match": "KFC", "item": "KFC", "category": "Eating Out" },
    { "match": "LS ANITA GELATO", "item": "LS Anita Gelato", "category": "Eating Out" },
    { "match": "CLEMENTINE", "item": "Clementine's", "category": "Eating Out" },

    // --- Woolworths ---
    { "match": "WOOLWORTHS/", "item": "Woolworths", "category": "Woolworths", "extractLocation": true },

    // --- Subscriptions ---
    { "match": "ADOBE SYDNEY", "item": "Adobe", "category": "Subscriptions" },
    { "match": "APPLE.COM/BILL", "item": "Apple", "category": "Subscriptions" },
    { "match": "UBER *ONE MEMBERSHIP", "item": "Uber One", "category": "Subscriptions" },
    { "match": "EVERYDAY EXTRA", "item": "Woolworths Everyday Extra", "category": "Subscriptions" },
    { "match": "AMZNPRIMEA", "item": "Amazon Prime", "category": "Subscriptions" },
    { "match": "AMAZON WEB SERVICES", "item": "AWS", "category": "Subscriptions" },

    // --- Transport ---
    { "match": "ZLR*", "item": "Go Card", "category": "Transport" },
    { "match": "MYKI", "item": "Myki", "category": "Transport" },
    { "match": "TRANSLINK", "item": "Translink Go Card", "category": "Transport" },
    { "match": "NEURONAU", "item": "E-scooter", "category": "Transport" },

    // --- Bills ---
    { "match": "EZI*GIGACOMM", "item": "Gigacomm Internet", "category": "Bills" },
    { "match": "WOOLIESMOBILE", "item": "Woolies Mobile", "category": "Bills" },

    // --- Health ---
    { "match": "CHEMIST WAREHOUSE", "item": "Chemist Warehouse", "category": "Health" },
    { "match": "GU HEALTH", "item": "GU Health", "category": "Health" },

    // --- Shopping ---
    { "match": "JB HI FI", "item": "JB Hi-Fi", "category": "Shopping" },
    { "match": "DIGIDIRECT", "item": "Digidirect", "category": "Shopping" },
    { "match": "CK UNDERWEAR", "item": "CK Underwear", "category": "Shopping" },
    { "match": "DAVID JONES", "item": "David Jones", "category": "Shopping" },
    { "match": "WHITE CLOSET", "item": "White Closet", "category": "Shopping" },
    { "match": "OFFICEWORKS", "item": "Officeworks", "category": "Shopping" },

    // --- Entertainment ---
    { "match": "QPAC", "item": "QPAC", "category": "Entertainment" },
    { "match": "FORUM MELBOURNE", "item": "Forum Melbourne", "category": "Entertainment" },
    { "match": "SEA LIFE", "item": "Sea Life", "category": "Entertainment" },
    { "match": "NGV", "item": "NGV", "category": "Entertainment" },
    { "match": "AUST CNT FOR CONT AR", "item": "ACCA", "category": "Entertainment" }
  ],

  "exclusions": [
    { "match": "^To 460184", "reason": "Credit card payment" },
    { "match": "^To 131007", "reason": "Savings transfer" },
    { "match": "^To 900021", "reason": "Savings transfer" },
    { "match": "BETASHARES DIRECT", "reason": "Investment purchase" },
    { "match": "RENT MR MAXWELL", "reason": "Roommate rent deposit" }
  ]
}
```

### merchant-mappings.schema.json

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["mappings"],
  "properties": {
    "mappings": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["match", "item", "category"],
        "properties": {
          "match": { "type": "string", "description": "Case-insensitive substring to match against bank description" },
          "item": { "type": "string", "description": "Human-readable transaction name" },
          "category": {
            "type": "string",
            "enum": ["Rent", "Woolworths", "Eating Out", "Alcohol", "Subscriptions", "Transport", "Bills", "Health", "Entertainment", "Shopping", "Other"]
          },
          "extractLocation": { "type": "boolean", "description": "Extract location suffix from description", "default": false }
        }
      }
    },
    "exclusions": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["match", "reason"],
        "properties": {
          "match": { "type": "string", "description": "Regex pattern to match for exclusion" },
          "reason": { "type": "string", "description": "Why this transaction is excluded" }
        }
      }
    }
  }
}
```

### Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `BASIQ_API_KEY` | Yes (for Basiq provider) | Basiq API key for authentication |

---

## 6. SKILL.md Outline

The `SKILL.md` at the repo root provides AI agents with project context. Content outline:

```markdown
# budget-sync — AI Agent Skill

## Project Overview
Personal finance CLI tool. SQLite (Drizzle ORM) is the source of truth for queries.
Corpus stores are the source of truth for raw API data and sync results (versioned, with lineage).
Tracks: bank transactions, savings balances, super, investments, net worth.

## Tech Stack
- Runtime: Bun
- Database: SQLite + Drizzle ORM (drizzle-orm/bun-sqlite)
- Data stores: @f0rbit/corpus stores (raw-transactions, raw-accounts, raw-balances, sync-results)
- Error handling: @f0rbit/corpus Result<T, E> types — never throw
  - pipe() for chaining, flat_map() for fallible steps
  - fetch_result() for HTTP calls (never raw fetch)
  - try_catch / try_catch_async for wrapping side effects
  - Semaphore for rate limiting
  - parallel_map() for concurrent operations
- CLI: Commander
- Config: JSONC + JSON Schema
- Testing: bun test, in-memory SQLite, in-memory corpus, in-memory providers

## Project Structure
[directory tree with purpose annotations]

## Corpus Store Architecture

### Data Flow
Provider → corpus raw stores → pipeline (pure) → corpus sync-results → SQLite

### Stores
- `raw-transactions` — raw transaction arrays per account, per fetch
- `raw-accounts` — raw account info per fetch
- `raw-balances` — raw balance snapshots per fetch
- `sync-results` — categorized pipeline output, with `parents` linking to raw-transactions

### Lineage
sync-results snapshots reference their source raw-transactions via `parents` array.
This enables deterministic replay: re-run categorization from stored corpus snapshots.

### Backends
- Production: `create_file_backend({ base_path: config.corpus_dir })`
- Testing: `create_memory_backend()` — fast, isolated, no filesystem

## Key Patterns

### Error Handling
- All fallible functions return Result<T, E>
- Never throw, never try/catch (use corpus wrappers)
- Use pipe() for chaining fallible operations
- Use pipe().flat_map() for composing pipeline steps
- Error types defined in src/errors.ts
- HTTP errors: use fetch_result() + errors.fromFetchError as mapper

### Provider Pattern
- BankProvider interface in src/providers/types.ts
- Production: BasiqBankProvider (HTTP via fetch_result())
- Testing: InMemoryBankProvider (arrays)
- Manual: CsvBankProvider (file import via pipe() + try_catch)
- Providers return raw data — categorization happens in pipeline/

### Transaction Pipeline
1. Fetch raw transactions from provider
2. Snapshot raw data into corpus stores (raw-transactions, raw-accounts, raw-balances)
3. Filter exclusions (src/pipeline/filter.ts) — pure function, pipe() chain
4. Handle rent specially (src/pipeline/rent.ts) — pure function
5. Match merchant mappings (src/pipeline/local-mappings.ts) — pure function
6. Enrich fallback via provider (src/pipeline/enrich-mapper.ts)
7. Fallback: category "Other"
8. Snapshot sync results into corpus (sync-results, with parents)
9. Materialize into SQLite

### Database
- Schema: src/db/schema.ts
- Client: src/db/client.ts (exports AppContext { db, corpus })
- Migrations: drizzle/ (generated, never hand-edited)
- Test helper: createTestDb() returns in-memory SQLite
- Test helper: createTestCorpus() returns in-memory corpus

### Configuration
- config.jsonc — user settings (gitignored), includes corpus_dir
- merchant-mappings.jsonc — categorization rules (committed)
- Rent config is in config.jsonc, not merchant mappings

## Categories
[list of 11 categories with descriptions]

## Common Tasks

### Adding a new merchant mapping
1. Add entry to merchant-mappings.jsonc
2. Run tests to verify: bun test

### Adding a new provider
1. Implement BankProvider interface in src/providers/<name>/
2. Add in-memory variant for testing
3. Register in provider factory (src/providers/index.ts)

### Adding a new CLI command
1. Create handler in src/commands/<name>.ts
2. Construct AppContext { db, corpus } from config
3. Register in src/index.ts

### Adding a new corpus store
1. Define Zod schema in src/corpus/schemas.ts
2. Define store in src/corpus/stores.ts using define_store()
3. Register in buildCorpus() in src/corpus/client.ts
4. Export from src/corpus/index.ts

### Running migrations
bunx drizzle-kit generate && bunx drizzle-kit migrate

## Gotchas
- Dates are stored as YYYY-MM-DD text, not timestamps
- Transaction amounts are always positive; direction field disambiguates
- external_id is the dedup key — never insert without checking
- Rent has special logic — don't categorize via merchant mappings
- Basiq JWT expires — client must handle token refresh
- Config file is gitignored (contains user ID) — config.example.jsonc is committed
- Corpus stores are async — all put/get operations return Promises
- Pipeline functions are PURE — they read from corpus snapshots, never call providers
- SQLite materialization is the LAST step — after corpus sync-results are stored
```

---

## 7. Milestone 0: Detailed Implementation Plan

### File Structure (M0)

```
budget-sync/
├── package.json
├── tsconfig.json
├── biome.json
├── drizzle.config.ts
├── .gitignore
├── .env.example
├── config.example.jsonc                # Committed template
├── config.jsonc                        # User config (gitignored)
├── config.schema.json                  # JSON Schema for config
├── merchant-mappings.jsonc             # Categorization rules
├── merchant-mappings.schema.json       # JSON Schema for mappings
├── SKILL.md                            # AI agent instructions
├── data/                               # SQLite DB + corpus stores (gitignored)
│   ├── budget-sync.db
│   └── corpus/
│       ├── raw-transactions/
│       ├── raw-accounts/
│       ├── raw-balances/
│       └── sync-results/
├── drizzle/                            # Generated migrations
├── src/
│   ├── index.ts                        # Commander CLI entry
│   ├── config.ts                       # Config loading + validation
│   ├── errors.ts                       # Error type definitions
│   ├── corpus/
│   │   ├── index.ts                   # Re-exports
│   │   ├── schemas.ts                 # Zod schemas for corpus snapshot data
│   │   ├── stores.ts                  # Store definitions (define_store)
│   │   └── client.ts                  # createCorpus() + createTestCorpus()
│   ├── db/
│   │   ├── schema.ts                   # Drizzle schema (all tables)
│   │   └── client.ts                   # DB connection factory + AppContext
│   ├── providers/
│   │   ├── types.ts                    # BankProvider interface + data types
│   │   ├── index.ts                    # Provider factory
│   │   ├── basiq/
│   │   │   ├── client.ts              # HTTP client + JWT auth (fetch_result)
│   │   │   ├── provider.ts            # BankProvider implementation
│   │   │   └── types.ts               # Basiq API response types
│   │   ├── csv/
│   │   │   └── provider.ts            # CSV import BankProvider
│   │   └── in-memory/
│   │       └── provider.ts            # Test BankProvider
│   ├── pipeline/
│   │   ├── categorizer.ts             # Pipeline orchestrator (pipe().flat_map() chain)
│   │   ├── filter.ts                  # Exclusion rules (pure function)
│   │   ├── rent.ts                    # Rent special handling (pure function)
│   │   ├── local-mappings.ts          # JSONC mapping loader + matcher
│   │   └── enrich-mapper.ts           # Basiq category → local category
│   ├── services/
│   │   ├── sync-service.ts            # Main sync workflow (corpus → pipeline → materialize)
│   │   ├── transaction-service.ts     # Transaction CRUD (pipe + try_catch_async)
│   │   ├── account-service.ts         # Account CRUD (pipe + try_catch_async)
│   │   └── export-service.ts          # Obsidian markdown export (pipe + try_catch)
│   └── commands/
│       ├── sync.ts                    # sync command handler
│       ├── accounts.ts                # accounts command handler
│       ├── mappings.ts                # mappings command handler
│       ├── export.ts                  # export command handler
│       └── import.ts                  # import command handler
└── __tests__/
    ├── helpers.ts                     # createTestContext(), factory functions
    ├── integration/
    │   ├── sync-workflow.test.ts       # End-to-end sync + corpus snapshot scenarios
    │   ├── categorization.test.ts     # Full pipeline tests
    │   ├── corpus-lineage.test.ts     # Lineage + deterministic replay tests
    │   └── export.test.ts             # Obsidian export tests
    └── unit/
        ├── filter.test.ts             # Exclusion rule tests
        ├── rent.test.ts               # Rent calculation tests
        ├── local-mappings.test.ts     # Mapping match tests
        ├── pipeline-steps.test.ts     # pipe() assertion tests per step
        └── filename.test.ts           # Note filename generation
```

---

### Phase 0: Scaffold (sequential) — COMPLETE

All tasks sequential — each depends on the previous.

**Task 0.1: Project scaffold** ✅ COMPLETE
- Files: `package.json`, `tsconfig.json`, `biome.json`, `drizzle.config.ts`, `.gitignore`, `.env.example`
- Dependencies: `@f0rbit/corpus`, `zod`, `commander`, `jsonc-parser`, `drizzle-orm`, `@paralleldrive/cuid2`
- Dev dependencies: `drizzle-kit`, `@types/bun`
- LOC: ~100
- Touches: root config files

**Task 0.2: Error types + provider interface + shared types** ✅ COMPLETE
- Files: `src/errors.ts`, `src/providers/types.ts`
- All error types, all provider interfaces, `RawTransaction`, `AccountInfo`, `AccountBalance`, etc.
- Includes `errors.fromFetchError()` for mapping corpus `FetchError` to `ProviderError`
- LOC: ~340
- Touches: `src/errors.ts`, `src/providers/types.ts`

**Task 0.3: Drizzle schema + DB client** ✅ COMPLETE
- Files: `src/db/schema.ts`, `src/db/client.ts`
- All tables (accounts, transactions, snapshots, holdings, contributions, sync_runs)
- `createDb(path)` and `createTestDb()` factory functions
- `AppContext { db, corpus }` interface
- LOC: ~220
- Touches: `src/db/schema.ts`, `src/db/client.ts`, `drizzle/`

**Task 0.4: Config loader** ✅ COMPLETE
- Files: `src/config.ts`, `config.example.jsonc`, `config.schema.json`
- Load `config.jsonc` via `jsonc-parser`, validate with Zod
- Includes `corpus_dir` field
- LOC: ~82
- Touches: `src/config.ts`, `config.example.jsonc`, `config.schema.json`

> **Phase 0 total: ~740 LOC** ✅ COMPLETE

---

### Phase 0.5: Corpus Store Integration (sequential) — COMPLETE

**Task 0.5.1: Corpus Zod schemas** ✅ COMPLETE
- Files: `src/corpus/schemas.ts`
- Zod schemas for `RawTransactionsSnapshot`, `RawAccountsSnapshot`, `RawBalancesSnapshot`, `SyncResultSnapshot`
- Re-uses enums from `src/providers/types.ts`
- LOC: ~111
- Touches: `src/corpus/schemas.ts`

**Task 0.5.2: Corpus store definitions** ✅ COMPLETE
- Files: `src/corpus/stores.ts`
- 4 stores: `raw-transactions`, `raw-accounts`, `raw-balances`, `sync-results`
- Uses `define_store()` with `json_codec()` and Zod schemas
- LOC: ~37
- Touches: `src/corpus/stores.ts`

**Task 0.5.3: Corpus client + re-exports** ✅ COMPLETE
- Files: `src/corpus/client.ts`, `src/corpus/index.ts`
- `createCorpus(dataDir)` — file backend for production
- `createTestCorpus()` — memory backend for tests
- `AppCorpus` type exported
- LOC: ~33
- Touches: `src/corpus/client.ts`, `src/corpus/index.ts`

> **Phase 0.5 total: ~181 LOC** ✅ COMPLETE

---

### Phase 0.6: Pipeline + In-Memory Provider (parallel where marked)

> **Replaces original Phase 1.** Same pipeline steps but now composed with `pipe().flat_map()` chains. Each step is a pure function: `(RawTransaction, context) → Result<CategorizedTransaction | ExcludedTransaction, PipelineError>`.

**Task 0.6.1: Exclusion filter** *(parallel-safe)*
- Files: `src/pipeline/filter.ts`
- Load exclusion patterns from `merchant-mappings.jsonc`
- `filterTransaction(tx, exclusions)` → `Result<RawTransaction, ExcludedTransaction>`
- Exclusion rules: credit direction, cc payments, savings, investments, roommate, reimbursements
- Pure function — takes `RawTransaction` and `ExclusionRule[]`, returns `Result`
- LOC: ~110
- Touches: `src/pipeline/filter.ts`

**Task 0.6.2: Rent handler** *(parallel-safe)*
- Files: `src/pipeline/rent.ts`
- `isRentTransaction(tx, config)` — pattern match against landlord + debit rent patterns
- `handleRent(tx, config)` → `Result<CategorizedTransaction, PipelineError>` — date-aware amount calculation (pre/post solo_start_date)
- Returns a `CategorizedTransaction` with category "Rent"
- Pure function over `RawTransaction` + `RentConfig`
- LOC: ~100
- Touches: `src/pipeline/rent.ts`

**Task 0.6.3: Local mapping loader + matcher** *(parallel-safe)*
- Files: `src/pipeline/local-mappings.ts`
- `loadMappings(path)` → `Result<MerchantMappings, PipelineError>` using `pipe()` + `try_catch` for file read + JSONC parse
- `matchTransaction(description, mappings)` → `MerchantMapping | null`
- Case-insensitive substring match, first match wins
- Handle `extractLocation` flag
- LOC: ~110
- Touches: `src/pipeline/local-mappings.ts`

**Task 0.6.4: Enrich category mapper** *(parallel-safe)*
- Files: `src/pipeline/enrich-mapper.ts`
- Static mapping table: Basiq category names → local categories
- `mapEnrichment(enrichment)` → `{ item, category, notes }`
- Pure function, no I/O
- LOC: ~70
- Touches: `src/pipeline/enrich-mapper.ts`

**Task 0.6.5: In-memory provider** *(parallel-safe)*
- Files: `src/providers/in-memory/provider.ts`
- `InMemoryBankProvider` implementing `BankProvider`
- Pre-loadable arrays for accounts, transactions, balances
- `addTransactions()`, `addAccounts()`, `setBalances()` helpers
- Error simulation: `failNextAuth`, `failNextFetch` flags
- All methods return `Result` — uses `ok()` / `err()`
- LOC: ~110
- Touches: `src/providers/in-memory/provider.ts`

**Task 0.6.6: Categorizer orchestrator** *(depends on 0.6.1–0.6.4)*
- Files: `src/pipeline/categorizer.ts`
- `categorizePipeline(tx, context)` → `Result<CategorizedTransaction, PipelineError>`
- Composes: filter → rent → local mapping → enrich → fallback
- Uses `pipe().flat_map().flat_map()...` chain to compose all steps
- `context` includes: `MerchantMappings`, `RentConfig`, optional enrichment function
- Each step is a `flat_map` — if any step produces a final `CategorizedTransaction`, short-circuit
- LOC: ~120
- Touches: `src/pipeline/categorizer.ts`

> Tasks 0.6.1–0.6.5 can run in **parallel** (no shared files).
> Task 0.6.6 runs **after** 0.6.1–0.6.4.
> **Phase 0.6 total: ~620 LOC**
> Verification: typecheck, COMMIT

---

### Phase 0.7: Services with Corpus Integration (parallel where marked)

> **Replaces original Phase 2.** Services now receive `AppContext { db, corpus }`. The sync service snapshots raw data into corpus stores before categorization, and stores sync results with lineage. DB operations use `pipe()` + `try_catch_async`.

**Task 0.7.1: Transaction service** *(parallel-safe)*
- Files: `src/services/transaction-service.ts`
- `createTransaction(ctx, data)` — insert with external_id dedup check
- `getTransactions(ctx, filters)` — query with date range, category, account filters
- `getUncategorized(ctx)` — transactions with category "Other"
- All DB operations wrapped in `try_catch_async()` returning `Result<T, DbError>`
- Uses `pipe()` for composing query → transform → return
- Receives `AppContext` (uses `ctx.db`)
- LOC: ~140
- Touches: `src/services/transaction-service.ts`

**Task 0.7.2: Account service** *(parallel-safe)*
- Files: `src/services/account-service.ts`
- `upsertAccount(ctx, accountInfo)` — create or update from provider data
- `listAccounts(ctx)` — list active accounts
- `deactivateAccount(ctx, id)` — soft-delete
- All operations return `Result<T, DbError>` via `try_catch_async`
- Uses `pipe()` for composing lookup → upsert → return
- Receives `AppContext` (uses `ctx.db`)
- LOC: ~110
- Touches: `src/services/account-service.ts`

**Task 0.7.3: Export service** *(parallel-safe)*
- Files: `src/services/export-service.ts`
- `exportToObsidian(ctx, vaultPath, budgetDir, options)` — query transactions, write markdown notes
- Markdown format matches existing `Budget/AGENTS.md` spec (YAML frontmatter)
- Filename generation: `YYYY-MM-DD-slug.md` with `-2`, `-3` suffixes
- Uses `pipe()` + `try_catch` for file write operations
- Dry-run mode
- Receives `AppContext` (uses `ctx.db`)
- LOC: ~160
- Touches: `src/services/export-service.ts`

**Task 0.7.4: Sync service** *(depends on 0.7.1, 0.7.2, and Phase 0.6)*
- Files: `src/services/sync-service.ts`
- `syncTransactions(ctx, provider, config, options)` — the main workflow:
  1. Create sync_run record
  2. Authenticate provider
  3. Discover/upsert accounts → snapshot to `corpus.stores["raw-accounts"]`
  4. For each account: fetch transactions in date range
  5. **Snapshot raw transactions** to `corpus.stores["raw-transactions"]` per account
  6. **Snapshot raw balances** to `corpus.stores["raw-balances"]`
  7. Run each transaction through categorization pipeline (reads from snapshot, pure)
  8. **Snapshot sync results** to `corpus.stores["sync-results"]` with `{ parents: [raw tx snapshot IDs] }`
  9. **Materialize** categorized transactions into SQLite (insert non-duplicates)
  10. Update sync_run with counts
  11. Return summary
- All corpus `put()` calls are awaited before proceeding to next step
- LOC: ~250
- Touches: `src/services/sync-service.ts`

> Tasks 0.7.1–0.7.3 can run in **parallel**.
> Task 0.7.4 runs **after** 0.7.1 + 0.7.2 + Phase 0.6.
> **Phase 0.7 total: ~660 LOC**
> Verification: typecheck, COMMIT

---

### Phase 0.8: Providers with Corpus Utilities (parallel where marked)

> **Replaces original Phase 3.** Basiq HTTP client uses `fetch_result()` from corpus for all HTTP calls (never raw `fetch`). `Semaphore` for rate limiting. `parallel_map()` for concurrent account fetching. CSV provider uses `pipe()` + `try_catch`.

**Task 0.8.1: Basiq HTTP client** *(parallel-safe)*
- Files: `src/providers/basiq/client.ts`, `src/providers/basiq/types.ts`
- JWT auth with token caching and refresh — composed via `pipe()` chain:
  - `pipe(getToken).flat_map(validateExpiry).flat_map(refreshIfNeeded)`
- **All HTTP calls use `fetch_result()`** from corpus — never raw `fetch`
- **`errors.fromFetchError`** is the error mapper for all `fetch_result()` calls
- Paginated fetch helper using `pipe()` to compose page-fetching loop
- **`Semaphore`** from corpus for rate limiting (10 req/sec production)
- Basiq API response Zod schemas for type-safe parsing
- LOC: ~240
- Touches: `src/providers/basiq/client.ts`, `src/providers/basiq/types.ts`

**Task 0.8.2: Basiq BankProvider** *(depends on 0.8.1)*
- Files: `src/providers/basiq/provider.ts`
- Maps Basiq responses to `RawTransaction`, `AccountInfo`, `AccountBalance`
- Implements `getAccounts()`, `fetchTransactions()`, `getAccountBalances()`, `enrichTransaction()`
- Uses **`parallel_map()`** from corpus for fetching transactions across multiple accounts concurrently
- Each method returns `Result<T, ProviderError>`
- LOC: ~170
- Touches: `src/providers/basiq/provider.ts`

**Task 0.8.3: CSV BankProvider** *(parallel-safe, parallel with 0.8.1)*
- Files: `src/providers/csv/provider.ts`
- Reads BankSA CSV format (Date, Description, Debit, Credit, Balance)
- Uses **`pipe()` + `try_catch`** for file reading and parsing
- Generates stable external_ids from hash of (date, description, amount)
- All methods return `Result<T, ProviderError>`
- LOC: ~130
- Touches: `src/providers/csv/provider.ts`

**Task 0.8.4: Provider factory** *(depends on 0.8.2, 0.8.3)*
- Files: `src/providers/index.ts`
- `createProvider(config)` → `BankProvider` based on config.provider
- LOC: ~40
- Touches: `src/providers/index.ts`

> Tasks 0.8.1 + 0.8.3 can run in **parallel**.
> Task 0.8.2 after 0.8.1. Task 0.8.4 after 0.8.2 + 0.8.3.
> **Phase 0.8 total: ~580 LOC**
> Verification: typecheck, COMMIT

---

### Phase 0.9: CLI Commands with AppContext (parallel where marked)

> **Replaces original Phase 4.** Commands construct `AppContext { db, corpus }` from config and pass to services. Commands use `pipe()` for composing config loading → service calls → output formatting.

**Task 0.9.1: CLI entry point + sync command**
- Files: `src/index.ts`, `src/commands/sync.ts`
- Commander program definition
- `sync` command:
  - Uses `pipe()` to compose: load config → create DB + corpus → create provider → sync → format output
  - Constructs `AppContext { db: createDb(config.db_path), corpus: createCorpus(config.corpus_dir) }`
  - Passes `AppContext` to sync service
- Flags: `--from`, `--to`, `--dry-run`, `--provider`, `--account`, `--verbose`
- LOC: ~160
- Touches: `src/index.ts`, `src/commands/sync.ts`

**Task 0.9.2: accounts command** *(parallel-safe)*
- Files: `src/commands/accounts.ts`
- `accounts list` — table output of all accounts
- `accounts discover` — call provider, upsert new accounts (snapshots to corpus)
- `accounts deactivate <id>` — mark inactive
- Uses `pipe()` for config → AppContext → service call → output
- LOC: ~110
- Touches: `src/commands/accounts.ts`

**Task 0.9.3: mappings command** *(parallel-safe)*
- Files: `src/commands/mappings.ts`
- `mappings list` — table output of all mappings
- `mappings search <query>` — filter by match string
- `mappings unmapped` — query DB for "Other" category transactions
- Uses `pipe()` for config → AppContext → service call → output
- LOC: ~90
- Touches: `src/commands/mappings.ts`

**Task 0.9.4: export + import commands** *(parallel-safe)*
- Files: `src/commands/export.ts`, `src/commands/import.ts`
- `export` — call export service with `AppContext`
- `import <file>` — load CSV, create provider, call sync service with `AppContext`
- Uses `pipe()` for composing: load config → create context → service → output
- LOC: ~130
- Touches: `src/commands/export.ts`, `src/commands/import.ts`

> Run 0.9.2–0.9.4 in parallel first (they export registration functions).
> Then 0.9.1 last (creates index.ts, imports and wires all commands).
> **Phase 0.9 total: ~490 LOC**
> Verification: typecheck, COMMIT

---

### Phase 0.10: Tests + Mappings + SKILL.md (parallel)

> **Replaces original Phase 5.** Test helpers provide `createTestContext()` returning `AppContext` with in-memory DB + in-memory corpus. Integration tests verify corpus snapshots, lineage, and deterministic replay alongside DB records.

**Task 0.10.1: Seed merchant-mappings.jsonc + schemas** *(parallel-safe)*
- Files: `merchant-mappings.jsonc`, `merchant-mappings.schema.json`, `config.schema.json`
- Port all mappings from Budget/AGENTS.md (30+ rules)
- JSON Schema with category enum, field descriptions
- Config JSON Schema (includes `corpus_dir` field)
- LOC: ~250 (JSONC + schema)
- Touches: `merchant-mappings.jsonc`, `merchant-mappings.schema.json`, `config.schema.json`

**Task 0.10.2: SKILL.md** *(parallel-safe)*
- Files: `SKILL.md`
- Full AI agent skill file per Section 6 outline
- Includes corpus store architecture, data flow, lineage patterns
- Documents `pipe()`, `fetch_result()`, `try_catch_async`, `Semaphore`, `parallel_map()` usage
- LOC: ~250
- Touches: `SKILL.md`

**Task 0.10.3: Test helpers + fixtures** *(parallel-safe)*
- Files: `__tests__/helpers.ts`
- `createTestContext()` → `AppContext` with in-memory SQLite + in-memory corpus:
  ```typescript
  export function createTestContext(): AppContext {
    return { db: createTestDb(), corpus: createTestCorpus() };
  }
  ```
- `createTestProvider()` — pre-loaded `InMemoryBankProvider`
- Factory functions: `makeTransaction()`, `makeAccount()`, `makeConfig()`
- Realistic test data matching AGENTS.md descriptions
- LOC: ~170
- Touches: `__tests__/helpers.ts`

**Task 0.10.4: Unit tests** *(parallel-safe)*
- Files: `__tests__/unit/filter.test.ts`, `__tests__/unit/rent.test.ts`, `__tests__/unit/local-mappings.test.ts`, `__tests__/unit/pipeline-steps.test.ts`
- Pure function tests: happy path + edge case per function
- Filter: credit excluded, cc payment excluded, debit spending included
- Rent: pre-March 2026, post-March 2026, debit rent
- Mappings: exact match, substring, case-insensitive, extractLocation, no match
- **Pipeline step tests**: verify each step returns correct `Result` via `pipe()` assertions
  - `expect(result.ok).toBe(true)` / `expect(result.ok).toBe(false)`
  - Verify `pipe()` chain composition produces expected final result
- LOC: ~250
- Touches: `__tests__/unit/*.test.ts`

**Task 0.10.5: Integration tests** *(parallel-safe)*
- Files: `__tests__/integration/sync-workflow.test.ts`, `__tests__/integration/categorization.test.ts`, `__tests__/integration/corpus-lineage.test.ts`, `__tests__/integration/export.test.ts`
- All tests use `createTestContext()` for `AppContext { db, corpus }`
- Scenarios:
  - Full sync creates correct DB records
  - **Full sync creates corpus snapshots** (raw-transactions, raw-accounts, raw-balances, sync-results)
  - Exclusion rules filter correctly
  - Rent calculation works for pre/post March 2026
  - Duplicate prevention via external_id
  - Dry-run produces no DB changes (but still creates corpus snapshots)
  - Date range filtering works
  - Unknown merchants → "Other"
  - Sync run record created with correct counts
  - Export creates correct markdown files
  - Export handles duplicate filenames with suffixes
  - **Corpus lineage**: sync-results snapshot `parents` array contains raw-transactions snapshot IDs
  - **Deterministic replay**: extract raw transactions from corpus snapshot, re-run pipeline, get identical results
  - **Corpus deduplication**: re-syncing same data doesn't create duplicate snapshots
- LOC: ~450
- Touches: `__tests__/integration/*.test.ts`

> Tasks 0.10.1–0.10.5 can all run in **parallel** (no shared files).
> **Phase 0.10 total: ~1,370 LOC**
> Verification: full test suite, lint, COMMIT

---

### M0 Total Estimate

| Phase | LOC | Tasks | Parallelizable | Status |
|-------|-----|-------|----------------|--------|
| 0: Scaffold | ~740 | 4 | Sequential | ✅ COMPLETE |
| 0.5: Corpus Stores | ~181 | 3 | Sequential | ✅ COMPLETE |
| 0.6: Pipeline + In-Memory | ~620 | 6 | 5 parallel + 1 sequential | Pending |
| 0.7: Services + Corpus | ~660 | 4 | 3 parallel + 1 sequential | Pending |
| 0.8: Providers + Corpus Utilities | ~580 | 4 | 2 parallel + 2 sequential | Pending |
| 0.9: CLI Commands + AppContext | ~490 | 4 | 3 parallel + 1 sequential | Pending |
| 0.10: Tests + Mappings + SKILL | ~1,370 | 5 | All parallel | Pending |
| **Total** | **~4,641** | **30** | | |

### Execution Plan

```
Phase 0: Scaffold (sequential) ✅ COMPLETE
├── Task 0.1: Project scaffold (package.json, tsconfig, biome, drizzle.config)
├── Task 0.2: Error types + provider interfaces + shared types + fromFetchError
├── Task 0.3: Drizzle schema + DB client + AppContext + generate migration
├── Task 0.4: Config loader + corpus_dir + example config
→ COMMITTED

Phase 0.5: Corpus Store Integration (sequential) ✅ COMPLETE
├── Task 0.5.1: Corpus Zod schemas (raw snapshots + sync results)
├── Task 0.5.2: Corpus store definitions (define_store + json_codec)
├── Task 0.5.3: Corpus client (createCorpus + createTestCorpus) + re-exports
→ COMMITTED

Phase 0.6: Pipeline + In-Memory Provider
├── [PARALLEL] Task 0.6.1: filter.ts (pure exclusion function)
├── [PARALLEL] Task 0.6.2: rent.ts (pure rent handler)
├── [PARALLEL] Task 0.6.3: local-mappings.ts (pipe + try_catch for file load)
├── [PARALLEL] Task 0.6.4: enrich-mapper.ts (pure mapping function)
├── [PARALLEL] Task 0.6.5: in-memory provider
├── [SEQUENTIAL] Task 0.6.6: categorizer.ts — pipe().flat_map() chain (depends on 0.6.1–0.6.4)
→ Verification: typecheck, COMMIT

Phase 0.7: Services + Corpus
├── [PARALLEL] Task 0.7.1: transaction-service.ts (pipe + try_catch_async)
├── [PARALLEL] Task 0.7.2: account-service.ts (pipe + try_catch_async)
├── [PARALLEL] Task 0.7.3: export-service.ts (pipe + try_catch for file I/O)
├── [SEQUENTIAL] Task 0.7.4: sync-service.ts — corpus snapshot → pipeline → materialize (depends on 0.7.1, 0.7.2, Phase 0.6)
→ Verification: typecheck, COMMIT

Phase 0.8: Providers + Corpus Utilities
├── [PARALLEL] Task 0.8.1: Basiq HTTP client (fetch_result + Semaphore + pipe)
├── [PARALLEL] Task 0.8.3: CSV provider (pipe + try_catch)
├── [SEQUENTIAL] Task 0.8.2: Basiq BankProvider + parallel_map (depends on 0.8.1)
├── [SEQUENTIAL] Task 0.8.4: Provider factory (depends on 0.8.2, 0.8.3)
→ Verification: typecheck, COMMIT

Phase 0.9: CLI Commands + AppContext
├── [PARALLEL] Task 0.9.2: accounts command (AppContext + pipe)
├── [PARALLEL] Task 0.9.3: mappings command (AppContext + pipe)
├── [PARALLEL] Task 0.9.4: export + import commands (AppContext + pipe)
├── [SEQUENTIAL] Task 0.9.1: CLI entry point + sync command (wires all commands)
→ Verification: typecheck, COMMIT

Phase 0.10: Tests + Mappings + SKILL.md
├── [PARALLEL] Task 0.10.1: merchant-mappings.jsonc + JSON schemas
├── [PARALLEL] Task 0.10.2: SKILL.md (includes corpus architecture)
├── [PARALLEL] Task 0.10.3: Test helpers + createTestContext()
├── [PARALLEL] Task 0.10.4: Unit tests (filter, rent, mappings, pipeline pipe() assertions)
├── [PARALLEL] Task 0.10.5: Integration tests (sync, corpus snapshots, lineage, replay, export)
→ Verification: full test suite, lint, COMMIT
```

---

## 8. Milestones 1–3: High-Level Scoping

### Milestone 1: Savings Snapshots + Net Worth Foundation

**Goal**: On every sync, capture account balances. Introduce `networth` command.

**Scope**:
- Modify `sync-service.ts` to call `provider.getAccountBalances()` after transaction sync
- Upsert into `snapshots` table (one per account per day)
- Raw balances already snapshotted to `corpus.stores["raw-balances"]` in M0 sync workflow
- Add `snapshot` CLI command for manual trigger (calls `getAccountBalances()` without syncing transactions)
  - Constructs `AppContext { db, corpus }` from config
- Add `snapshot-service.ts` — get latest snapshot per account, get history
  - Receives `AppContext`, uses `pipe()` + `try_catch_async` for DB queries
- Add `networth-service.ts` — sum latest balance snapshots by account type:
  - `net_worth = sum(savings) + sum(transaction) - abs(sum(credit))`
  - (Super and investments not included yet — added in M2/M3)
  - Uses `pipe()` for composing: fetch snapshots → group by type → calculate
- Add `networth` CLI command:
  - Default: show current net worth breakdown
  - `--history`: table of net worth over time
  - `--format csv|json|table`
  - Constructs `AppContext` from config
- Add `config.sync.auto_snapshot` flag (default true)

**Estimated LOC**: ~650
**Dependencies**: M0 complete
**Key files**: `src/services/snapshot-service.ts`, `src/services/networth-service.ts`, `src/commands/snapshot.ts`, `src/commands/networth.ts`

### Milestone 2: Super Integration

**Goal**: Track REST Super balance and contributions.

**Scope**:
- Investigate REST Super via Basiq `GET /connectors` endpoint
  - If supported: implement `BasiqSuperProvider` using Basiq accounts/transactions for super accounts
    - Uses `fetch_result()` + `errors.fromFetchError` for HTTP calls
  - If not: implement `ManualSuperProvider` (JSON/CSV import)
    - Uses `pipe()` + `try_catch` for file I/O
- `SuperProvider` interface (already defined in types)
- Store balance in `snapshots` table (account type = "super")
- Store contributions in `contributions` table
- **Snapshot raw super data** to corpus stores (raw-accounts, raw-balances for super)
- Services receive `AppContext { db, corpus }`
- Super commands:
  - `budget-sync super balance` — current super balance
  - `budget-sync super contributions [--from] [--to]` — contribution history
  - `budget-sync super import <file>` — manual import fallback
  - All construct `AppContext` from config
- Net worth now includes super balance

**Estimated LOC**: ~850
**Dependencies**: M1 complete (networth service exists)
**DECISION NEEDED**: Basiq connector availability for REST Super — can only determine at runtime with a Basiq account. Plan should have both paths ready.

### Milestone 3: Investment Tracking

**Goal**: Track Betashares Direct ETF holdings and performance.

**Scope**:
- `InvestmentProvider` interface (already defined in types)
- Investigate data sources:
  1. CDR/Basiq — check if Betashares Direct is a Basiq connector
  2. Manual CSV/JSON import — most likely first implementation
  3. ASX price API — for current valuations (free options: ASX API, Yahoo Finance, Alpha Vantage)
- `ManualInvestmentProvider` — import from JSON/CSV with schema:
  ```json
  { "ticker": "DHHF", "units": 100, "purchasePrice": 28.50 }
  ```
  - Uses `pipe()` + `try_catch` for file operations
- `PriceLookupService` — fetch current ASX prices for tickers
  - Uses `fetch_result()` + `errors.fromFetchError` for HTTP calls
  - Uses `Semaphore` for rate limiting API calls
- **Snapshot raw holdings** to corpus stores
- Store in `holdings` table (snapshot per date)
- Services receive `AppContext { db, corpus }`
- Investment commands:
  - `budget-sync investments list` — current holdings with market value
  - `budget-sync investments import <file>` — import holdings
  - `budget-sync investments performance [--from] [--to]` — unrealized P&L
  - All construct `AppContext` from config
- Net worth now includes investment values

**Estimated LOC**: ~1,050
**Dependencies**: M1 complete
**DECISION NEEDED**: Price data source — free ASX API vs Yahoo Finance vs Alpha Vantage. Recommend starting with manual price entry and adding API later.

---

## 9. Testing Strategy

### Principles

1. **In-memory SQLite** — every test gets a fresh `:memory:` database with migrations applied
2. **In-memory corpus** — every test gets a fresh `create_memory_backend()` corpus. No filesystem.
3. **In-memory providers** — `InMemoryBankProvider` with pre-loaded test data. No HTTP mocking.
4. **`AppContext` per test** — `createTestContext()` returns `{ db, corpus }` with both in-memory
5. **Integration-first** — test user workflows end-to-end through the service layer
6. **No mocks** — use Provider pattern instead. If you need to spy, the interface is wrong.
7. **Temp filesystem** — export tests write to a temp directory, verify contents, clean up
8. **Corpus snapshot verification** — integration tests assert that corpus stores contain expected snapshots
9. **Lineage verification** — tests assert `parents` arrays link sync-results to raw-transactions
10. **Deterministic replay** — tests extract raw data from corpus, re-run pipeline, verify identical output

### Test Architecture

```
InMemoryBankProvider          In-memory SQLite     In-memory Corpus
  (pre-loaded test data)       (fresh per test)     (fresh per test)
         │                          │                     │
         └──── Sync Service ────────┤─────────────────────┘
                    │               │                     │
              Assertions on:        │                     │
              - DB records          │   - Corpus snapshots
              - Export files        │   - Lineage (parents)
              - Result types        │   - Replay consistency
```

### Test Helper

```typescript
// __tests__/helpers.ts

import { createTestDb } from "../src/db/client";
import { createTestCorpus } from "../src/corpus/client";
import type { AppContext } from "../src/db/client";
import { InMemoryBankProvider } from "../src/providers/in-memory/provider";

export function createTestContext(): AppContext {
  return {
    db: createTestDb(),
    corpus: createTestCorpus(),
  };
}

export function createTestProvider(options?: {
  transactions?: RawTransaction[];
  accounts?: AccountInfo[];
  balances?: AccountBalance[];
}) {
  const provider = new InMemoryBankProvider();
  if (options?.accounts) provider.addAccounts(...options.accounts);
  if (options?.transactions) provider.addTransactions(...options.transactions);
  if (options?.balances) provider.setBalances(options.balances);
  return provider;
}

export function makeTransaction(overrides?: Partial<RawTransaction>): RawTransaction {
  return {
    id: `test-tx-${createId()}`,
    description: "WOOLWORTHS/1234 BRISBANE",
    amount: 42.50,
    direction: "debit",
    transactionDate: "2026-03-01",
    postDate: "2026-03-02",
    accountId: "test-account-1",
    ...overrides,
  };
}

export function makeAccount(overrides?: Partial<AccountInfo>): AccountInfo {
  return {
    id: "test-account-1",
    name: "Everyday Account",
    institution: "BankSA",
    type: "transaction",
    ...overrides,
  };
}

export function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    db_path: ":memory:",
    corpus_dir: ":memory:",
    vault_path: "/tmp/test-vault",
    budget_dir: "Budget",
    provider: "manual",
    sync: { default_range_days: 30, auto_snapshot: true },
    rent: {
      solo_start_date: "2026-03-01",
      solo_weekly_amount: 650,
      shared_roommate_contribution: 450,
      landlord_patterns: ["IPY*GRACZYKTHOMPSON"],
      debit_rent_patterns: ["Internet Withdrawal.*Rent"],
    },
    ...overrides,
  };
}
```

### Key Test Scenarios

| # | Scenario | Type | What it validates |
|---|----------|------|-------------------|
| 1 | Full sync creates correct DB records | Integration | End-to-end pipeline |
| 2 | Full sync creates corpus snapshots | Integration | raw-transactions, raw-accounts, raw-balances, sync-results stores populated |
| 3 | Exclusion rules filter correctly | Unit | Credit, cc payments, savings, investments excluded |
| 4 | Rent pre-March 2026 | Unit | Amount = charge − 450 |
| 5 | Rent post-March 2026 | Unit | Amount = 650 fixed |
| 6 | Duplicate prevention (external_id) | Integration | Same tx ID not re-imported |
| 7 | Dry-run produces no DB changes | Integration | DB unchanged after dry-run |
| 8 | Dry-run still creates corpus snapshots | Integration | Corpus stores populated even in dry-run |
| 9 | Unknown merchant → "Other" | Integration | Fallback categorization |
| 10 | Sync run record with counts | Integration | sync_runs table populated correctly |
| 11 | Export creates correct markdown | Integration | Frontmatter format, filename, content |
| 12 | Export handles filename collisions | Integration | `-2`, `-3` suffixes |
| 13 | Woolworths location extraction | Unit | "WOOLWORTHS/1234 BRISBANE" → item "Woolworths BRISBANE" |
| 14 | Local mapping case-insensitive | Unit | "firefly brisbane" matches "FIREFLY BRISBANE" |
| 15 | Provider auth failure propagates | Integration | Result.err returned, no crash |
| 16 | CSV import creates correct records | Integration | CSV → DB via CsvBankProvider |
| 17 | Account discovery + upsert | Integration | New accounts created, existing updated |
| 18 | Corpus lineage: parents linkage | Integration | sync-results `parents` contains raw-transactions snapshot IDs |
| 19 | Deterministic replay from corpus | Integration | Re-run pipeline from stored corpus snapshot → identical categorized output |
| 20 | Pipeline pipe() chain composition | Unit | Each step returns correct Result, chain short-circuits on match |

### What We Don't Test

- Basiq HTTP responses (tested manually with real credentials)
- SQLite engine behavior (that's SQLite's problem)
- Corpus file backend behavior (that's corpus's problem — we test via memory backend)
- Commander CLI parsing (framework responsibility)
- File system permissions

---

## 10. Suggested AGENTS.md Updates

After M0 implementation, the following should be added to `Budget/AGENTS.md` in the Obsidian vault:

```markdown
## Automated Budget Sync Tool

Separate repo at `/Users/tom/dev/budget-sync` — CLI tool for automated transaction import and personal finance tracking.

### Quick Start
- `bun run src/index.ts sync` — import new transactions from Basiq
- `bun run src/index.ts sync --dry-run` — preview without writing to DB
- `bun run src/index.ts export --from 2026-03-01` — export to Obsidian markdown
- `bun run src/index.ts accounts discover` — discover connected bank accounts
- `bun run src/index.ts mappings unmapped` — see uncategorized transactions

### Architecture
- **Source of truth (queries)**: SQLite database at `data/budget-sync.db`
- **Source of truth (raw data)**: Corpus stores at `data/corpus/`
- **Data flow**: Provider → corpus raw stores → pipeline → corpus sync-results → SQLite
- **Obsidian export**: Optional — transactions can be exported as markdown notes
- **Merchant mappings**: `merchant-mappings.jsonc` (human-edited, committed to repo)
- **Config**: `config.jsonc` (gitignored — contains Basiq user ID)
- **API key**: `BASIQ_API_KEY` env var

### Key Files
- `SKILL.md` — full AI agent reference for the project
- `src/db/schema.ts` — Drizzle ORM schema (all tables)
- `src/db/client.ts` — `AppContext { db, corpus }` interface
- `src/corpus/` — corpus store definitions, Zod schemas, client factory
- `src/providers/types.ts` — BankProvider interface
- `src/pipeline/categorizer.ts` — transaction categorization pipeline (pipe().flat_map() chain)
- `merchant-mappings.jsonc` — merchant → category rules
```

Additionally, `SKILL.md` in the budget-sync repo itself will serve as the primary AI agent reference for that project (see Section 6).
