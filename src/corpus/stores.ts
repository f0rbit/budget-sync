import { define_store, json_codec } from "@f0rbit/corpus";
import {
	rawAccountsSnapshotSchema,
	rawBalancesSnapshotSchema,
	rawTransactionsSnapshotSchema,
	syncResultSnapshotSchema,
} from "./schemas.js";
import type {
	RawAccountsSnapshot,
	RawBalancesSnapshot,
	RawTransactionsSnapshot,
	SyncResultSnapshot,
} from "./schemas.js";

export const rawTransactionsStore = define_store<"raw-transactions", RawTransactionsSnapshot>(
	"raw-transactions",
	json_codec(rawTransactionsSnapshotSchema),
	{ description: "Raw transaction data from bank providers (Basiq, CSV)" },
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
