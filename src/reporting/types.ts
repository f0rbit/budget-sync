import type { TransactionRow } from "../services/transaction-service.js";

/**
 * The subset of a transaction row every report function needs. Callers pass
 * non-excluded rows (via getReportRows()); reports never touch the DB.
 */
export type ReportTransaction = Pick<TransactionRow, "date" | "amount" | "direction" | "category" | "item">;
