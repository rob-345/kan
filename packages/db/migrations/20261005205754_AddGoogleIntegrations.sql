CREATE TYPE "public"."google_connection_status" AS ENUM('active', 'error');--> statement-breakpoint
CREATE TYPE "public"."google_sync_kind" AS ENUM('calendar', 'tasks');--> statement-breakpoint
CREATE TYPE "public"."integration_job_status" AS ENUM('pending', 'running', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "google_chat_space" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"publicId" varchar(12) NOT NULL,
	"workspaceId" bigint NOT NULL,
	"boardId" bigint,
	"name" varchar(255) NOT NULL,
	"webhookUrl" text NOT NULL,
	"events" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"createdBy" uuid,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp,
	CONSTRAINT "google_chat_space_publicId_unique" UNIQUE("publicId")
);
--> statement-breakpoint
ALTER TABLE "google_chat_space" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "google_connection" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"userId" uuid NOT NULL,
	"googleEmail" varchar(255),
	"refreshToken" text NOT NULL,
	"accessToken" text,
	"accessTokenExpiresAt" timestamp,
	"scope" text,
	"timeZone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"calendarEnabled" boolean DEFAULT true NOT NULL,
	"calendarId" varchar(255),
	"tasksEnabled" boolean DEFAULT true NOT NULL,
	"taskListId" varchar(255),
	"status" "google_connection_status" DEFAULT 'active' NOT NULL,
	"lastError" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp,
	CONSTRAINT "google_connection_userId_unique" UNIQUE("userId")
);
--> statement-breakpoint
ALTER TABLE "google_connection" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "google_sync_item" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"connectionId" bigint NOT NULL,
	"cardId" bigint NOT NULL,
	"kind" "google_sync_kind" NOT NULL,
	"externalId" varchar(255) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp
);
--> statement-breakpoint
ALTER TABLE "google_sync_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "integration_job" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" varchar(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupeKey" varchar(255),
	"status" "integration_job_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"runAt" timestamp DEFAULT now() NOT NULL,
	"lockedAt" timestamp,
	"lastError" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_job" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "google_chat_space" ADD CONSTRAINT "google_chat_space_workspaceId_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "google_chat_space" ADD CONSTRAINT "google_chat_space_boardId_board_id_fk" FOREIGN KEY ("boardId") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "google_chat_space" ADD CONSTRAINT "google_chat_space_createdBy_user_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "google_connection" ADD CONSTRAINT "google_connection_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "google_sync_item" ADD CONSTRAINT "google_sync_item_connectionId_google_connection_id_fk" FOREIGN KEY ("connectionId") REFERENCES "public"."google_connection"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "google_sync_item" ADD CONSTRAINT "google_sync_item_cardId_card_id_fk" FOREIGN KEY ("cardId") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "google_chat_space_workspace_idx" ON "google_chat_space" USING btree ("workspaceId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "google_sync_item_unique_idx" ON "google_sync_item" USING btree ("connectionId","cardId","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "google_sync_item_card_idx" ON "google_sync_item" USING btree ("cardId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_job_due_idx" ON "integration_job" USING btree ("status","runAt");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integration_job_pending_dedupe_idx" ON "integration_job" USING btree ("dedupeKey") WHERE "integration_job"."status" = 'pending' AND "integration_job"."dedupeKey" IS NOT NULL;