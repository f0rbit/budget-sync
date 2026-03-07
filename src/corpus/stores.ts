import { define_store, json_codec } from "@f0rbit/corpus";
import {
	aiCategorizationResultSnapshotSchema,
	aiParseResultSnapshotSchema,
	computationSnapshotSchema,
	rawAccountsSnapshotSchema,
	rawBalancesSnapshotSchema,
	rawContributionsSnapshotSchema,
	rawDocumentSnapshotSchema,
	rawTransactionsSnapshotSchema,
	syncResultSnapshotSchema,
} from "./schemas.js";
import type {
	AiCategorizationResultSnapshot,
	AiParseResultSnapshot,
	ComputationSnapshot,
	RawAccountsSnapshot,
	RawBalancesSnapshot,
	RawContributionsSnapshot,
	RawDocumentSnapshot,
	RawTransactionsSnapshot,
	SyncResultSnapshot,
} from "./schemas.js";

export const rawTransactionsStore = define_store<"raw-transactions", RawTransactionsSnapshot>(
	"raw-transactions",
	json_codec(rawTransactionsSnapshotSchema),
	{ description: "Raw transaction data from bank providers" },
);

export const rawAccountsStore = define_store<"raw-accounts", RawAccountsSnapshot>(
	"raw-accounts",
	json_codec(rawAccountsSnapshotSchema),
	{ description: "Raw account info from bank providers" },
);

export const rawBalancesStore = define_store<"raw-balances", RawBalancesSnapshot>(
	"raw-balances",
	json_codec(rawBalancesSnapshotSchema),
	{ description: "Raw balance snapshots from bank providers" },
);

export const syncResultsStore = define_store<"sync-results", SyncResultSnapshot>(
	"sync-results",
	json_codec(syncResultSnapshotSchema),
	{ description: "Categorized sync results (pipeline output)" },
);

export const rawContributionsStore = define_store<"raw-contributions", RawContributionsSnapshot>(
	"raw-contributions",
	json_codec(rawContributionsSnapshotSchema),
	{ description: "Raw super balance + contribution data from manual import or API" },
);

export const rawDocumentsStore = define_store<"raw-documents", RawDocumentSnapshot>(
	"raw-documents",
	json_codec(rawDocumentSnapshotSchema),
	{ description: "Full document content ingested for transaction extraction" },
);

export const aiParseResultsStore = define_store<"ai-parse-results", AiParseResultSnapshot>(
	"ai-parse-results",
	json_codec(aiParseResultSnapshotSchema),
	{ description: "AI-extracted transaction data from ingested documents" },
);

export const computationSnapshotsStore = define_store<"computation-snapshots", ComputationSnapshot>(
	"computation-snapshots",
	json_codec(computationSnapshotSchema),
	{ description: "Net worth and balance state after each ingestion" },
);

export const aiCategorizationResultsStore = define_store<"ai-categorization-results", AiCategorizationResultSnapshot>(
	"ai-categorization-results",
	json_codec(aiCategorizationResultSnapshotSchema),
	{ description: "AI-assigned categories for transactions not matched by local mappings" },
);
