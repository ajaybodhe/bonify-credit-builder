CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text,
	"type" text,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"current_balance" numeric(14, 2),
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_categories" (
	"version" integer NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"group" text NOT NULL,
	CONSTRAINT "merchant_categories_version_code_pk" PRIMARY KEY("version","code")
);
--> statement-breakpoint
CREATE TABLE "merchant_category_versions" (
	"version" integer PRIMARY KEY NOT NULL,
	"content_hash" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "score_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"window_start" date NOT NULL,
	"window_end" date NOT NULL,
	"model_version" integer NOT NULL,
	"reliability_index" integer NOT NULL,
	"score_band" text NOT NULL,
	"metrics" jsonb NOT NULL,
	"components" jsonb NOT NULL,
	"drivers" jsonb NOT NULL,
	"input_hash" text NOT NULL,
	"category_version" integer NOT NULL,
	"data_quality" jsonb NOT NULL,
	"sync_run_id" text,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"status" text NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"synced_from" date,
	"synced_accounts" integer DEFAULT 0 NOT NULL,
	"new_transactions" integer DEFAULT 0 NOT NULL,
	"duplicate_transactions" integer DEFAULT 0 NOT NULL,
	"amended_transactions" integer DEFAULT 0 NOT NULL,
	"pages_fetched" integer DEFAULT 0 NOT NULL,
	"accounts_completed" integer DEFAULT 0 NOT NULL,
	"accounts_failed" integer DEFAULT 0 NOT NULL,
	"covers_through" date,
	"covered_account_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trigger" text DEFAULT 'api' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "transaction_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"revision" integer NOT NULL,
	"content_hash" text NOT NULL,
	"previous" jsonb NOT NULL,
	"detected_by_sync_id" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"user_id" text NOT NULL,
	"booked_at" date NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"description" text,
	"merchant" text,
	"category" text,
	"is_credit" boolean NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"content_hash" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merchant_categories" ADD CONSTRAINT "merchant_categories_version_merchant_category_versions_version_fk" FOREIGN KEY ("version") REFERENCES "public"."merchant_category_versions"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "score_snapshots_user_computed_idx" ON "score_snapshots" USING btree ("user_id","computed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "score_snapshots_reproducibility_idx" ON "score_snapshots" USING btree ("user_id","window_end","model_version","input_hash");--> statement-breakpoint
CREATE INDEX "sync_runs_user_started_idx" ON "sync_runs" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_runs_one_running_per_user_idx" ON "sync_runs" USING btree ("user_id") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "transaction_revisions_txn_idx" ON "transaction_revisions" USING btree ("transaction_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_revisions_unique_idx" ON "transaction_revisions" USING btree ("transaction_id","revision");--> statement-breakpoint
CREATE INDEX "transactions_user_booked_idx" ON "transactions" USING btree ("user_id","booked_at");--> statement-breakpoint
CREATE INDEX "transactions_account_booked_idx" ON "transactions" USING btree ("account_id","booked_at");--> statement-breakpoint
CREATE INDEX "transactions_category_idx" ON "transactions" USING btree ("category");--> statement-breakpoint
CREATE INDEX "transactions_status_idx" ON "transactions" USING btree ("status");