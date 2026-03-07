import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { AppCorpus } from "../corpus/index.js";
import * as schema from "./schema.js";

export type AppDatabase = ReturnType<typeof createDb>;

export interface AppContext {
	db: AppDatabase;
	corpus: AppCorpus;
}

export function createDb(dbPath: string) {
	const sqlite = new Database(dbPath);
	sqlite.exec("PRAGMA journal_mode = WAL");
	sqlite.exec("PRAGMA foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return db;
}

export function createTestDb() {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return db;
}
