-- The template's D1 (SQLite) schema at v0.2.0, the last Cloudflare Workers release: the source side of import-d1's tests.
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `billing_customers` (
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`customer_ref` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`user_id`, `provider`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_customers_ref_uq` ON `billing_customers` (`provider`,`customer_ref`);--> statement-breakpoint
CREATE TABLE `credit_accounts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`debt` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	CONSTRAINT "credit_accounts_debt_nonneg" CHECK("credit_accounts"."debt" >= 0)
);
--> statement-breakpoint
CREATE TABLE `credit_allocations` (
	`ledger_id` text NOT NULL,
	`lot_id` text NOT NULL,
	`amount` integer NOT NULL,
	PRIMARY KEY(`ledger_id`, `lot_id`)
);
--> statement-breakpoint
CREATE TABLE `credit_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`delta` integer NOT NULL,
	`debt_delta` integer DEFAULT 0 NOT NULL,
	`idem_key` text NOT NULL,
	`ref` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_ledger_idem_uq` ON `credit_ledger` (`idem_key`);--> statement-breakpoint
CREATE INDEX `credit_ledger_user_idx` ON `credit_ledger` (`user_id`);--> statement-breakpoint
CREATE TABLE `credit_lots` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source` text NOT NULL,
	`source_ref` text,
	`amount` integer NOT NULL,
	`remaining` integer NOT NULL,
	`expires_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	CONSTRAINT "credit_lots_amount_pos" CHECK("credit_lots"."amount" > 0),
	CONSTRAINT "credit_lots_remaining_range" CHECK("credit_lots"."remaining" >= 0 and "credit_lots"."remaining" <= "credit_lots"."amount")
);
--> statement-breakpoint
CREATE INDEX `credit_lots_user_idx` ON `credit_lots` (`user_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`product_id` text NOT NULL,
	`provider` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`checkout_ref` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`paid_at` integer
);
--> statement-breakpoint
CREATE INDEX `orders_user_idx` ON `orders` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`payment_ref` text NOT NULL,
	`charge_ref` text,
	`user_id` text NOT NULL,
	`order_id` text,
	`subscription_ref` text,
	`product_id` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`amount_refunded` integer DEFAULT 0 NOT NULL,
	`dispute_status` text,
	`credits_granted` integer DEFAULT 0 NOT NULL,
	`credits_revoked` integer DEFAULT 0 NOT NULL,
	`adjust_seq` integer DEFAULT 0 NOT NULL,
	`period_start` integer,
	`period_end` integer,
	`fetched_at` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_ref_uq` ON `payments` (`provider`,`payment_ref`);--> statement-breakpoint
CREATE INDEX `payments_charge_idx` ON `payments` (`provider`,`charge_ref`);--> statement-breakpoint
CREATE INDEX `payments_user_idx` ON `payments` (`user_id`);--> statement-breakpoint
CREATE TABLE `quota_counters` (
	`key` text NOT NULL,
	`window` text NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`key`, `window`)
);
--> statement-breakpoint
CREATE TABLE `rate_limit` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limit_key_unique` ON `rate_limit` (`key`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`subscription_ref` text NOT NULL,
	`user_id` text NOT NULL,
	`product_id` text NOT NULL,
	`status` text NOT NULL,
	`current_period_start` integer,
	`current_period_end` integer,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`fetched_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_ref_uq` ON `subscriptions` (`provider`,`subscription_ref`);--> statement-breakpoint
CREATE INDEX `subscriptions_user_idx` ON `subscriptions` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `user_attribution` (
	`user_id` text PRIMARY KEY NOT NULL,
	`utm_source` text,
	`utm_medium` text,
	`utm_campaign` text,
	`referrer` text,
	`landing_path` text,
	`signup_ip` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`provider` text NOT NULL,
	`event_id` text NOT NULL,
	`type` text NOT NULL,
	`processed_at` integer NOT NULL,
	PRIMARY KEY(`provider`, `event_id`)
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`guest_id` text,
	`model_id` text NOT NULL,
	`kind` text NOT NULL,
	`prompt` text NOT NULL,
	`input_json` text NOT NULL,
	`cost_credits` integer DEFAULT 0 NOT NULL,
	`quota_json` text,
	`quota_released` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`upstream` text NOT NULL,
	`upstream_job_id` text,
	`error_code` text,
	`error_message` text,
	`outputs_json` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`submitted_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `jobs_user_idx` ON `jobs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_guest_idx` ON `jobs` (`guest_id`,`created_at`);
ALTER TABLE `jobs` ADD `upstream_cost_usd` text;