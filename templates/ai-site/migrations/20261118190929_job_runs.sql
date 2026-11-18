CREATE TABLE "job_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_after" bigint DEFAULT ((extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL,
	"locked_by" text,
	"locked_until" bigint,
	"pickups" integer DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL,
	"finished_at" bigint
);
--> statement-breakpoint
CREATE TABLE "job_steps" (
	"run_id" text NOT NULL,
	"name" text NOT NULL,
	"result" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"done_at" bigint,
	CONSTRAINT "job_steps_run_id_name_pk" PRIMARY KEY("run_id","name")
);
--> statement-breakpoint
CREATE INDEX "job_runs_pending_idx" ON "job_runs" USING btree ("status","run_after");