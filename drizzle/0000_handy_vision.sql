CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` text,
	`provider` text NOT NULL,
	`name` text NOT NULL,
	`institution` text,
	`type` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `contributions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`date` text NOT NULL,
	`type` text NOT NULL,
	`amount` real NOT NULL,
	`description` text,
	`sync_run_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sync_run_id`) REFERENCES `sync_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `holdings` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`ticker` text NOT NULL,
	`name` text,
	`units` real NOT NULL,
	`purchase_price` real,
	`current_price` real,
	`current_value` real,
	`date` text NOT NULL,
	`sync_run_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sync_run_id`) REFERENCES `sync_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `holdings_ticker_date_idx` ON `holdings` (`ticker`,`date`);--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`date` text NOT NULL,
	`balance` real NOT NULL,
	`available` real,
	`sync_run_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sync_run_id`) REFERENCES `sync_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `snapshots_date_idx` ON `snapshots` (`date`);--> statement-breakpoint
CREATE UNIQUE INDEX `snapshots_account_date_idx` ON `snapshots` (`account_id`,`date`);--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text DEFAULT 'success' NOT NULL,
	`transactions_created` integer DEFAULT 0,
	`transactions_excluded` integer DEFAULT 0,
	`transactions_skipped` integer DEFAULT 0,
	`snapshots_created` integer DEFAULT 0,
	`error_message` text,
	`metadata` text
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`external_id` text,
	`date` text NOT NULL,
	`post_date` text,
	`raw_description` text NOT NULL,
	`item` text NOT NULL,
	`amount` real NOT NULL,
	`direction` text NOT NULL,
	`category` text NOT NULL,
	`notes` text DEFAULT '',
	`excluded` integer DEFAULT false NOT NULL,
	`exclude_reason` text,
	`sync_run_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sync_run_id`) REFERENCES `sync_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_external_id_idx` ON `transactions` (`external_id`);--> statement-breakpoint
CREATE INDEX `transactions_date_idx` ON `transactions` (`date`);--> statement-breakpoint
CREATE INDEX `transactions_category_idx` ON `transactions` (`category`);