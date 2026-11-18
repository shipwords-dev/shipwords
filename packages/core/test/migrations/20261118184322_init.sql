CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_customers" (
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"customer_ref" text NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "billing_customers_user_id_provider_pk" PRIMARY KEY("user_id","provider")
);
--> statement-breakpoint
CREATE TABLE "credit_accounts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"debt" integer DEFAULT 0 NOT NULL,
	"updated_at" bigint DEFAULT ((extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "credit_accounts_debt_nonneg" CHECK ("credit_accounts"."debt" >= 0)
);
--> statement-breakpoint
CREATE TABLE "credit_allocations" (
	"ledger_id" text NOT NULL,
	"lot_id" text NOT NULL,
	"amount" integer NOT NULL,
	CONSTRAINT "credit_allocations_ledger_id_lot_id_pk" PRIMARY KEY("ledger_id","lot_id")
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"delta" integer NOT NULL,
	"debt_delta" integer DEFAULT 0 NOT NULL,
	"idem_key" text NOT NULL,
	"ref" text,
	"created_at" bigint DEFAULT ((extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_lots" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"amount" integer NOT NULL,
	"remaining" integer NOT NULL,
	"expires_at" bigint,
	"created_at" bigint DEFAULT ((extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "credit_lots_amount_pos" CHECK ("credit_lots"."amount" > 0),
	CONSTRAINT "credit_lots_remaining_range" CHECK ("credit_lots"."remaining" >= 0 and "credit_lots"."remaining" <= "credit_lots"."amount")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"product_id" text NOT NULL,
	"provider" text NOT NULL,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"checkout_ref" text,
	"created_at" bigint DEFAULT ((extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL,
	"paid_at" bigint
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"payment_ref" text NOT NULL,
	"charge_ref" text,
	"user_id" text NOT NULL,
	"order_id" text,
	"subscription_ref" text,
	"product_id" text NOT NULL,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"amount_refunded" integer DEFAULT 0 NOT NULL,
	"dispute_status" text,
	"credits_granted" integer DEFAULT 0 NOT NULL,
	"credits_revoked" integer DEFAULT 0 NOT NULL,
	"adjust_seq" integer DEFAULT 0 NOT NULL,
	"period_start" bigint,
	"period_end" bigint,
	"fetched_at" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL,
	"updated_at" bigint DEFAULT ((extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quota_counters" (
	"key" text NOT NULL,
	"window" text NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "quota_counters_key_window_pk" PRIMARY KEY("key","window")
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"subscription_ref" text NOT NULL,
	"user_id" text NOT NULL,
	"product_id" text NOT NULL,
	"status" text NOT NULL,
	"current_period_start" bigint,
	"current_period_end" bigint,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"fetched_at" bigint NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "user_attribution" (
	"user_id" text PRIMARY KEY NOT NULL,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"referrer" text,
	"landing_path" text,
	"signup_ip" text,
	"created_at" bigint DEFAULT ((extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"processed_at" bigint NOT NULL,
	CONSTRAINT "webhook_events_provider_event_id_pk" PRIMARY KEY("provider","event_id")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_attribution" ADD CONSTRAINT "user_attribution_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customers_ref_uq" ON "billing_customers" USING btree ("provider","customer_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_idem_uq" ON "credit_ledger" USING btree ("idem_key");--> statement-breakpoint
CREATE INDEX "credit_ledger_user_idx" ON "credit_ledger" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "credit_lots_user_idx" ON "credit_lots" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "orders_user_idx" ON "orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_ref_uq" ON "payments" USING btree ("provider","payment_ref");--> statement-breakpoint
CREATE INDEX "payments_charge_idx" ON "payments" USING btree ("provider","charge_ref");--> statement-breakpoint
CREATE INDEX "payments_user_idx" ON "payments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_ref_uq" ON "subscriptions" USING btree ("provider","subscription_ref");--> statement-breakpoint
CREATE INDEX "subscriptions_user_idx" ON "subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");