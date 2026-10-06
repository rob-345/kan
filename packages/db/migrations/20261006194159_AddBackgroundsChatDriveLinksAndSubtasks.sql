CREATE TYPE "public"."link_preview_status" AS ENUM('ok', 'failed');--> statement-breakpoint
ALTER TYPE "public"."card_activity_type" ADD VALUE 'card.updated.checklist.item.dueDate.updated' BEFORE 'card.updated.attachment.added';--> statement-breakpoint
ALTER TYPE "public"."card_activity_type" ADD VALUE 'card.updated.checklist.item.member.added' BEFORE 'card.updated.attachment.added';--> statement-breakpoint
ALTER TYPE "public"."card_activity_type" ADD VALUE 'card.updated.checklist.item.member.removed' BEFORE 'card.updated.attachment.added';--> statement-breakpoint
ALTER TYPE "public"."card_activity_type" ADD VALUE 'card.updated.driveFile.added';--> statement-breakpoint
ALTER TYPE "public"."card_activity_type" ADD VALUE 'card.updated.driveFile.removed';--> statement-breakpoint
ALTER TYPE "public"."card_activity_type" ADD VALUE 'card.updated.link.added';--> statement-breakpoint
ALTER TYPE "public"."card_activity_type" ADD VALUE 'card.updated.link.removed';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'checklist.item.assigned';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'checklist.item.due.reminder';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "card_drive_file" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"publicId" varchar(12) NOT NULL,
	"cardId" bigint NOT NULL,
	"driveFileId" varchar(255) NOT NULL,
	"name" varchar(1024) NOT NULL,
	"mimeType" varchar(255) NOT NULL,
	"url" text NOT NULL,
	"iconUrl" text,
	"createdBy" uuid,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "card_drive_file_publicId_unique" UNIQUE("publicId")
);
--> statement-breakpoint
ALTER TABLE "card_drive_file" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "card_checklist_item_member" (
	"checklistItemId" bigint NOT NULL,
	"workspaceMemberId" bigint NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "card_checklist_item_member_checklistItemId_workspaceMemberId_pk" PRIMARY KEY("checklistItemId","workspaceMemberId")
);
--> statement-breakpoint
ALTER TABLE "card_checklist_item_member" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "google_chat_app_space" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"publicId" varchar(12) NOT NULL,
	"spaceName" varchar(255) NOT NULL,
	"spaceType" varchar(16) NOT NULL,
	"displayName" varchar(255),
	"userId" uuid,
	"workspaceId" bigint,
	"boardId" bigint,
	"listId" bigint,
	"remindersEnabled" boolean DEFAULT true NOT NULL,
	"linkedBy" uuid,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp,
	CONSTRAINT "google_chat_app_space_publicId_unique" UNIQUE("publicId")
);
--> statement-breakpoint
ALTER TABLE "google_chat_app_space" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "google_chat_app_user" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chatUserName" varchar(255) NOT NULL,
	"userId" uuid NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp
);
--> statement-breakpoint
ALTER TABLE "google_chat_app_user" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "card_link" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"publicId" varchar(12) NOT NULL,
	"cardId" bigint NOT NULL,
	"url" text NOT NULL,
	"title" varchar(255),
	"createdBy" uuid,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "card_link_publicId_unique" UNIQUE("publicId")
);
--> statement-breakpoint
ALTER TABLE "card_link" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "link_preview" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"status" "link_preview_status" NOT NULL,
	"finalUrl" text,
	"title" text,
	"description" text,
	"imageUrl" text,
	"siteName" varchar(255),
	"faviconUrl" text,
	"fetchedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "link_preview_url_unique" UNIQUE("url")
);
--> statement-breakpoint
ALTER TABLE "link_preview" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP INDEX IF EXISTS "google_sync_item_unique_idx";--> statement-breakpoint
ALTER TABLE "board" ADD COLUMN "backgroundColour" varchar(32);--> statement-breakpoint
ALTER TABLE "board" ADD COLUMN "backgroundImage" text;--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN "dueDateHasTime" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN "startDateHasTime" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "card_checklist_item" ADD COLUMN "startDate" timestamp;--> statement-breakpoint
ALTER TABLE "card_checklist_item" ADD COLUMN "startDateHasTime" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "card_checklist_item" ADD COLUMN "dueDate" timestamp;--> statement-breakpoint
ALTER TABLE "card_checklist_item" ADD COLUMN "dueDateHasTime" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "card_checklist_item" ADD COLUMN "dueReminderMinutes" integer;--> statement-breakpoint
ALTER TABLE "card_checklist_item" ADD COLUMN "dueReminderSentAt" timestamp;--> statement-breakpoint
ALTER TABLE "google_sync_item" ADD COLUMN "checklistItemId" bigint;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "card_drive_file" ADD CONSTRAINT "card_drive_file_cardId_card_id_fk" FOREIGN KEY ("cardId") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "card_drive_file" ADD CONSTRAINT "card_drive_file_createdBy_user_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "card_checklist_item_member" ADD CONSTRAINT "card_checklist_item_member_checklistItemId_card_checklist_item_id_fk" FOREIGN KEY ("checklistItemId") REFERENCES "public"."card_checklist_item"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "card_checklist_item_member" ADD CONSTRAINT "card_checklist_item_member_workspaceMemberId_workspace_members_id_fk" FOREIGN KEY ("workspaceMemberId") REFERENCES "public"."workspace_members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "google_chat_app_space" ADD CONSTRAINT "google_chat_app_space_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "google_chat_app_space" ADD CONSTRAINT "google_chat_app_space_workspaceId_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."workspace"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "google_chat_app_space" ADD CONSTRAINT "google_chat_app_space_boardId_board_id_fk" FOREIGN KEY ("boardId") REFERENCES "public"."board"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "google_chat_app_space" ADD CONSTRAINT "google_chat_app_space_listId_list_id_fk" FOREIGN KEY ("listId") REFERENCES "public"."list"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "google_chat_app_space" ADD CONSTRAINT "google_chat_app_space_linkedBy_user_id_fk" FOREIGN KEY ("linkedBy") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "google_chat_app_user" ADD CONSTRAINT "google_chat_app_user_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "card_link" ADD CONSTRAINT "card_link_cardId_card_id_fk" FOREIGN KEY ("cardId") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "card_link" ADD CONSTRAINT "card_link_createdBy_user_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "card_drive_file_card_created_at_idx" ON "card_drive_file" USING btree ("cardId","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "card_checklist_item_member_member_idx" ON "card_checklist_item_member" USING btree ("workspaceMemberId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "google_chat_app_space_name_idx" ON "google_chat_app_space" USING btree ("spaceName");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "google_chat_app_space_user_idx" ON "google_chat_app_space" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "google_chat_app_space_board_idx" ON "google_chat_app_space" USING btree ("boardId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "google_chat_app_user_name_idx" ON "google_chat_app_user" USING btree ("chatUserName");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "google_chat_app_user_user_idx" ON "google_chat_app_user" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "card_link_card_created_at_idx" ON "card_link" USING btree ("cardId","createdAt");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "google_sync_item" ADD CONSTRAINT "google_sync_item_checklistItemId_card_checklist_item_id_fk" FOREIGN KEY ("checklistItemId") REFERENCES "public"."card_checklist_item"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "card_checklist_item_due_reminder_idx" ON "card_checklist_item" USING btree ("dueDate","dueReminderSentAt");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "google_sync_item_card_unique_idx" ON "google_sync_item" USING btree ("connectionId","cardId","kind") WHERE "google_sync_item"."checklistItemId" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "google_sync_item_checklist_item_unique_idx" ON "google_sync_item" USING btree ("connectionId","checklistItemId","kind") WHERE "google_sync_item"."checklistItemId" IS NOT NULL;