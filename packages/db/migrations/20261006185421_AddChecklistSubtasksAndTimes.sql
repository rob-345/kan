ALTER TYPE "public"."card_activity_type" ADD VALUE 'card.updated.checklist.item.dueDate.updated' BEFORE 'card.updated.attachment.added';--> statement-breakpoint
ALTER TYPE "public"."card_activity_type" ADD VALUE 'card.updated.checklist.item.member.added' BEFORE 'card.updated.attachment.added';--> statement-breakpoint
ALTER TYPE "public"."card_activity_type" ADD VALUE 'card.updated.checklist.item.member.removed' BEFORE 'card.updated.attachment.added';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'checklist.item.assigned';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'checklist.item.due.reminder';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "card_checklist_item_member" (
	"checklistItemId" bigint NOT NULL,
	"workspaceMemberId" bigint NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "card_checklist_item_member_checklistItemId_workspaceMemberId_pk" PRIMARY KEY("checklistItemId","workspaceMemberId")
);
--> statement-breakpoint
ALTER TABLE "card_checklist_item_member" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP INDEX IF EXISTS "google_sync_item_unique_idx";--> statement-breakpoint
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
CREATE INDEX IF NOT EXISTS "card_checklist_item_member_member_idx" ON "card_checklist_item_member" USING btree ("workspaceMemberId");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "google_sync_item" ADD CONSTRAINT "google_sync_item_checklistItemId_card_checklist_item_id_fk" FOREIGN KEY ("checklistItemId") REFERENCES "public"."card_checklist_item"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "card_checklist_item_due_reminder_idx" ON "card_checklist_item" USING btree ("dueDate","dueReminderSentAt");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "google_sync_item_card_unique_idx" ON "google_sync_item" USING btree ("connectionId","cardId","kind") WHERE "google_sync_item"."checklistItemId" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "google_sync_item_checklist_item_unique_idx" ON "google_sync_item" USING btree ("connectionId","checklistItemId","kind") WHERE "google_sync_item"."checklistItemId" IS NOT NULL;