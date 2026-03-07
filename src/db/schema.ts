import { createId } from "@paralleldrive/cuid2";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { AccountType, Category, ContributionType, SyncStatus, TransactionDirection } from "../providers/types.js";

// Inlined enum arrays for drizzle-kit compatibility (drizzle-kit uses CJS and
// can't resolve .js extension imports). Type assertions ensure these stay in
// sync with the canonical arrays in providers/types.ts.
const ACCOUNT_TYPES = [
	"transaction",
	"savings",
	"credit",
	"super",
	"investment",
] as const satisfies readonly AccountType[];

const TRANSACTION_DIRECTIONS = ["debit", "credit"] as const satisfies readonly TransactionDirection[];

const CATEGORIES = [
	"Rent",
	"Woolworths",
	"Eating Out",
	"Alcohol",
	"Subscriptions",
	"Transport",
	"Bills",
	"Health",
	"Entertainment",
	"Shopping",
	"Other",
] as const satisfies readonly Category[];

const SYNC_STATUSES = ["success", "partial", "failed"] as const satisfies readonly SyncStatus[];

const CONTRIBUTION_TYPES = [
	"employer",
	"salary_sacrifice",
	"voluntary",
	"fhss",
	"government",
] as const satisfies readonly ContributionType[];

// === sync_runs (defined first since other tables reference it) ===

export const syncRuns = sqliteTable("sync_runs", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => createId()),
	provider: text("provider").notNull(),
	startedAt: integer("started_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
	finishedAt: integer("finished_at", { mode: "timestamp" }),
	status: text("status", { enum: SYNC_STATUSES }).notNull().default("success"),
	transactionsCreated: integer("transactions_created").default(0),
	transactionsExcluded: integer("transactions_excluded").default(0),
	transactionsSkipped: integer("transactions_skipped").default(0),
	snapshotsCreated: integer("snapshots_created").default(0),
	errorMessage: text("error_message"),
	metadata: text("metadata", { mode: "json" }),
});

// === accounts ===

export const accounts = sqliteTable("accounts", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => createId()),
	externalId: text("external_id"),
	provider: text("provider").notNull(),
	name: text("name").notNull(),
	institution: text("institution"),
	type: text("type", { enum: ACCOUNT_TYPES }).notNull(),
	isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
	metadata: text("metadata", { mode: "json" }),
	createdAt: integer("created_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});

// === transactions ===

export const transactions = sqliteTable(
	"transactions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createId()),
		accountId: text("account_id")
			.notNull()
			.references(() => accounts.id),
		externalId: text("external_id"),
		date: text("date").notNull(),
		postDate: text("post_date"),
		rawDescription: text("raw_description").notNull(),
		item: text("item").notNull(),
		amount: real("amount").notNull(),
		direction: text("direction", { enum: TRANSACTION_DIRECTIONS }).notNull(),
		category: text("category", { enum: CATEGORIES }).notNull(),
		notes: text("notes").default(""),
		excluded: integer("excluded", { mode: "boolean" }).notNull().default(false),
		excludeReason: text("exclude_reason"),
		syncRunId: text("sync_run_id").references(() => syncRuns.id),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [
		uniqueIndex("transactions_external_id_idx").on(table.externalId),
		index("transactions_date_idx").on(table.date),
		index("transactions_category_idx").on(table.category),
	],
);

// === snapshots (M1 — table created now, populated later) ===

export const snapshots = sqliteTable(
	"snapshots",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createId()),
		accountId: text("account_id")
			.notNull()
			.references(() => accounts.id),
		date: text("date").notNull(),
		balance: real("balance").notNull(),
		available: real("available"),
		syncRunId: text("sync_run_id").references(() => syncRuns.id),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [
		index("snapshots_date_idx").on(table.date),
		uniqueIndex("snapshots_account_date_idx").on(table.accountId, table.date),
	],
);

// === holdings (M3 — table created now, populated later) ===
// TODO: Populate in M3 Investment Tracking

export const holdings = sqliteTable(
	"holdings",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createId()),
		accountId: text("account_id")
			.notNull()
			.references(() => accounts.id),
		ticker: text("ticker").notNull(),
		name: text("name"),
		units: real("units").notNull(),
		purchasePrice: real("purchase_price"),
		currentPrice: real("current_price"),
		currentValue: real("current_value"),
		date: text("date").notNull(),
		syncRunId: text("sync_run_id").references(() => syncRuns.id),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [index("holdings_ticker_date_idx").on(table.ticker, table.date)],
);

// === contributions (M2 — table created now, populated later) ===
// TODO: Populate in M2 Super Integration

export const contributions = sqliteTable("contributions", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => createId()),
	accountId: text("account_id")
		.notNull()
		.references(() => accounts.id),
	date: text("date").notNull(),
	type: text("type", { enum: CONTRIBUTION_TYPES }).notNull(),
	amount: real("amount").notNull(),
	description: text("description"),
	syncRunId: text("sync_run_id").references(() => syncRuns.id),
	createdAt: integer("created_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});
