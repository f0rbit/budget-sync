# budget-sync

Personal finance CLI. Ingests bank statements (PDF, CSV, image) using Claude to extract and
categorize transactions, tracks net worth across transaction/savings/credit/super accounts, and
exports categorized transactions to an Obsidian vault.

For architecture, conventions, and gotchas, see `AGENTS.md`. This file is a runnable usage guide.

## Use cases

### First-time setup

```sh
bun install
cp .env.example .env               # add your ANTHROPIC_API_KEY (only needed for AI parsing)
cp config.example.jsonc config.jsonc  # edit db_path, vault_path, rent config for yourself
bun run db:migrate
```

`config.jsonc` and `.env` are gitignored — they hold real personal data. `merchant-mappings.jsonc`
is committed and shared; start from the existing categorization rules or trim it for a fresh setup.

### Monthly routine

```sh
# download CSVs from each bank/account, then ingest one at a time
bun run dev -- ingest everyday.csv --account "Everyday Account" --account-type transaction --institution BankSA
bun run dev -- ingest savings.csv --account "Savings Account" --account-type savings --institution BankSA
bun run dev -- ingest credit-card.csv --account "Credit Card" --account-type credit --institution BankSA

# clean up anything AI/mappings missed
bun run dev -- mappings unmapped
bun run dev -- mappings apply

# review the month
bun run dev -- transactions monthly --from 2026-08-01 --to 2026-08-31
bun run dev -- transactions summary --from 2026-08-01 --to 2026-08-31
bun run dev -- transactions recurring
```

CSV files are auto-detected by extension and parsed structurally (no AI needed, no
`ANTHROPIC_API_KEY` required). `--account-type` has no default — if omitted, ingest uses AI
inference (or `.env`-less CSV parsing falls back to `"transaction"` only if nothing else applies).

### Ingesting PDFs or images via AI

```sh
bun run dev -- ingest statement.pdf --account "Everyday Account" --dry-run --verbose
bun run dev -- ingest statement.pdf --account "Everyday Account"
bun run dev -- ingest receipt.jpg --account "Credit Card"
```

Requires `ANTHROPIC_API_KEY` set (via `.env`, auto-loaded by Bun). Claude extracts transactions,
account info, and — if present on the statement — a closing balance, which becomes a balance
snapshot. `--model` overrides the configured model for a single run.

### Dry-run previewing

Any ingest or mutating command supports `--dry-run` — it runs the full pipeline (parse, filter,
categorize, dedup) but skips the SQLite write. **The printed counts (materialized/updated) are
legitimately 0 in dry-run mode** — that's not a bug, read the preview table/rows instead:

```sh
bun run dev -- ingest statement.csv --account "Everyday Account" --dry-run --verbose
bun run dev -- mappings apply --dry-run
bun run dev -- accounts merge acc_old acc_new --dry-run
```

### Forcing a CSV-only, non-AI run

Bun auto-loads `.env` at process start, so `env -u ANTHROPIC_API_KEY bun run dev -- ...` does
**not** disable AI — the var comes right back. Pass an explicit empty value instead:

```sh
ANTHROPIC_API_KEY="" bun run dev -- ingest statement.csv --account "Everyday Account"
```

### Fixing categorization

Find what needs attention, then fix it either broadly (mappings) or narrowly (one-off edits):

```sh
bun run dev -- mappings unmapped                 # rows categorized "Other" or an unmapped credit
bun run dev -- mappings search "uber"            # check existing rules before adding a duplicate
# add a new rule to merchant-mappings.jsonc: { "match": "UBER EATS", "item": "Uber Eats", "category": "Eating Out" }
bun run dev -- mappings apply --dry-run          # preview which existing "Other" rows it would fix
bun run dev -- mappings apply                    # apply for real
bun run dev -- mappings apply --force            # also recategorize rows NOT currently "Other"

# one-off manual fixes, no mapping rule needed
bun run dev -- transactions set tx_abc123 --category "Eating Out" --item "Uber Eats"
bun run dev -- transactions set --match "UBER EATS" --from 2026-01-01 --to 2026-08-31 --category "Eating Out"
```

Exclusion rules (also in `merchant-mappings.jsonc`, under `exclusions`) always win over category
mappings — use them for transfers/payments that shouldn't be counted as spend or income at all:

```jsonc
{ "match": "To 460184", "reason": "Credit card payment" }
```

`exclusions[].match` is a **regex**; `mappings[].match` is a plain case-insensitive **substring** —
don't mix the two up when editing the file.

### Own-account transfers, credit card payments, investment transfers

These should be excluded, not categorized — add an `exclusions` rule for both directions of the
transfer. Bank CSV exports pad the account number inconsistently (`To 1310068128040` vs
`From    1310068128040`, 4 spaces) — use `From\\s+<acct>`, not a literal space, so it matches every
export variant:

```jsonc
{ "match": "To 1310068128040", "reason": "Savings → Everyday transfer" },
{ "match": "From\\s+1310068128040", "reason": "Own-account transfer (incoming)" }
```

### Rent / roommate config

Rent is handled by dedicated pipeline logic, not merchant mappings — do not add rent landlords to
`merchant-mappings.jsonc`. Configure in `config.jsonc`:

```jsonc
"rent": {
  "solo_start_date": "2026-03-01",       // date the solo->shared split (or vice versa) begins
  "solo_weekly_amount": 650,
  "shared_roommate_contribution": 450,    // optional
  "landlord_patterns": ["IPY*GRACZYKTHOMPSON"],
  "debit_rent_patterns": ["Internet Withdrawal.*Rent"]
}
```

A credit matching a landlord pattern is treated as a bond refund, not rent income — rent handling
is debit-only.

### Merging duplicate accounts

Accounts resolve by name first, so this is rare going forward — but pre-existing duplicates (from
before that fix, or from a typo'd `--account` name) can be folded together:

```sh
bun run dev -- accounts                          # find the ids
bun run dev -- accounts merge acc_dup acc_keep --dry-run
bun run dev -- accounts merge acc_dup acc_keep
```

Moves every transaction/snapshot/holding/contribution from `acc_dup` into `acc_keep` in one DB
transaction, then removes `acc_dup`. Aborts with zero partial writes on a unique-index conflict.

### Net worth

```sh
bun run dev -- networth                           # current breakdown: transaction + savings + super - credit
bun run dev -- networth --history --format csv
```

Balance snapshots come from two places: the `Balance` column on a CSV ingest (if present) and any
`statementBalance` Claude extracts from a PDF/image statement. History uses carry-forward — an
account without a snapshot on a given date uses its last-known balance.

### Superannuation import

```sh
# build a JSON file: { "balances": [{ "account_name", "balance", "as_of" }],
#                       "contributions": [{ "date", "type", "amount", "description?" }] }
bun run dev -- super import super-2026-q2.json --account-name "My Super Fund"
bun run dev -- super balance
bun run dev -- super contributions --summary
```

`type` is one of `employer, salary_sacrifice, voluntary, fhss, government`.

### Export to Obsidian

```sh
bun run dev -- export --from 2026-08-01 --to 2026-08-31 --dry-run
bun run dev -- export --from 2026-08-01 --to 2026-08-31
```

Writes one Markdown note per transaction (YAML frontmatter) into `config.jsonc`'s `vault_path` /
`budget_dir`. `--force` overwrites existing notes; without it, re-exporting is safe to re-run.

### Searching

```sh
bun run dev -- transactions list --category "Eating Out" --from 2026-01-01 --limit 100
bun run dev -- transactions search "uber" --limit 20
```

### Backups and corpus lineage

`data/` (gitignored) holds the SQLite DB and `data/corpus/` (versioned raw documents + AI
parse/categorization results + sync results — the full lineage of every ingest). There's no
automated backup job: copy `data/budget-sync.db` (e.g. `budget-sync.db.backup-20260830`) before a
schema migration, `mappings apply --force`, or an account merge. Never delete `-wal`/`-shm` files
while the DB might have pending writes — that can lose uncommitted data.

`data/corpus` is append-only and rarely needs direct inspection — reach for it only to debug a bad
AI categorization or trace exactly what a specific ingest run extracted, since SQLite only holds
the final materialized state.

### Running tests / gate

```sh
bun run gate      # typecheck -> test -> lint, fail-fast
bun test          # tests only
```

There is no CI on this repo — `gate` is the whole verification story. Run it locally and merge
once it's green.

## Command reference

### `budget-sync ingest <file>`

Parse a bank document (PDF, CSV, image) and import transactions.

| Flag | Description |
|---|---|
| `--account <name>` | Account name (overrides AI inference) |
| `--account-type <type>` | `transaction`, `savings`, `credit` (no default — falls back to AI inference, then `"transaction"`) |
| `--institution <name>` | Institution name (e.g. BankSA) |
| `--from <date>` / `--to <date>` | Only import transactions in this range (`YYYY-MM-DD`) |
| `--dry-run` | Preview without writing to DB |
| `--verbose` | Show detailed output |
| `--model <model>` | Override AI model for this run |

### `budget-sync accounts`

| Subcommand | Description |
|---|---|
| `list` | List all active accounts |
| `deactivate <id>` | Mark account as inactive (excluded from sync) |
| `merge [--dry-run] <from-id> <into-id>` | Move all rows from one account into another, then remove `from-id` |

### `budget-sync mappings`

| Subcommand | Description |
|---|---|
| `list` | List all merchant mappings |
| `search <query>` | Search mappings by merchant name |
| `unmapped` | List transactions categorized `Other` (need mapping) |
| `apply [--dry-run] [--force]` | Re-run local mappings + exclusion rules over existing transactions (no re-ingest). `--force` recategorizes even if current category isn't `Other` |

### `budget-sync export`

| Flag | Description |
|---|---|
| `--from <date>` / `--to <date>` | Date range |
| `--dry-run` | Preview without writing files |
| `--force` | Overwrite existing notes |

### `budget-sync networth`

| Flag | Description |
|---|---|
| `--history` | Show net worth over time instead of current snapshot |
| `--from <date>` / `--to <date>` | Range for history |
| `--format <type>` | `table` (default), `csv`, `json` |

### `budget-sync super`

| Subcommand | Description |
|---|---|
| `balance [--format table\|json]` | Current super balance from snapshots |
| `contributions [--from] [--to] [--summary] [--format table\|csv\|json]` | Contribution history, optionally grouped |
| `import <file> [--account-name <name>] [--verbose]` | Import balances + contributions from a JSON file |

### `budget-sync transactions`

| Subcommand | Description |
|---|---|
| `list [--from] [--to] [--category] [--account] [--limit N] [--format table\|csv\|json]` | List with filters (default limit 50) |
| `summary [--from] [--to] [--account] [--format table\|csv\|json]` | Category breakdown + spend/refunds/income/net/savings-rate |
| `monthly [--from] [--to] [--account] [--format table\|csv\|json]` | Month x category pivot |
| `recurring [--min-months N] [--as-of date] [--format table\|csv\|json]` | Recurring-charge detection (cadence, typical amount, possibly lapsed) |
| `search <query> [--limit N] [--format table\|csv\|json]` | Search by item/description (default limit 20) |
| `set [ids...] [--category] [--item] [--notes] [--match] [--from] [--to]` | Update rows by id(s), or by `--match` substring + date range selector. Refuses to run with no selector |

## Config files

- **`config.jsonc`** (gitignored, copy from `config.example.jsonc`): `db_path`, `corpus_dir`,
  `vault_path`, `budget_dir`, `provider` (`"csv"` or `"manual"`), `sync.default_range_days`,
  `sync.auto_snapshot`, `anthropic.model`/`anthropic.max_tokens`, `rent.*`.
- **`merchant-mappings.jsonc`** (committed, shared): `mappings[]` (`match` substring, `item`,
  `category`, optional `extractLocation`) and `exclusions[]` (`match` regex, `reason`). AI
  categorization auto-appends suggested mappings here on ingest, preserving comments.

## Project layout

See `AGENTS.md` for the full source tree, corpus lineage model, and pipeline internals.
