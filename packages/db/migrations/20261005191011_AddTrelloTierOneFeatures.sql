ALTER TYPE "public"."card_activity_type" ADD VALUE 'card.restored';--> statement-breakpoint
ALTER TYPE "public"."card_activity_type" ADD VALUE 'card.updated.startDate.added';--> statement-breakpoint
ALTER TYPE "public"."card_activity_type" ADD VALUE 'card.updated.startDate.updated';--> statement-breakpoint
ALTER TYPE "public"."card_activity_type" ADD VALUE 'card.updated.startDate.removed';--> statement-breakpoint
ALTER TYPE "public"."card_activity_type" ADD VALUE 'card.updated.dueDate.completed';--> statement-breakpoint
ALTER TYPE "public"."card_activity_type" ADD VALUE 'card.updated.dueDate.uncompleted';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'card.comment.added';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'card.moved';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'card.dueDate.changed';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'card.archived';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'card.member.added';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'card.due.reminder';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "board_watcher" (
	"boardId" bigint NOT NULL,
	"userId" uuid NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "board_watcher_boardId_userId_pk" PRIMARY KEY("boardId","userId")
);
--> statement-breakpoint
ALTER TABLE "board_watcher" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "card_watcher" (
	"cardId" bigint NOT NULL,
	"userId" uuid NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "card_watcher_cardId_userId_pk" PRIMARY KEY("cardId","userId")
);
--> statement-breakpoint
ALTER TABLE "card_watcher" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "card_activity" ADD COLUMN "fromStartDate" timestamp;--> statement-breakpoint
ALTER TABLE "card_activity" ADD COLUMN "toStartDate" timestamp;--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN "startDate" timestamp;--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN "dueDateCompleted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN "dueReminderMinutes" integer;--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN "dueReminderSentAt" timestamp;--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN "coverColour" varchar(12);--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN "coverAttachmentId" bigint;--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN "archivedAt" timestamp;--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN "archivedBy" uuid;--> statement-breakpoint
ALTER TABLE "list" ADD COLUMN "archivedAt" timestamp;--> statement-breakpoint
ALTER TABLE "list" ADD COLUMN "archivedBy" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "board_watcher" ADD CONSTRAINT "board_watcher_boardId_board_id_fk" FOREIGN KEY ("boardId") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "board_watcher" ADD CONSTRAINT "board_watcher_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "card_watcher" ADD CONSTRAINT "card_watcher_cardId_card_id_fk" FOREIGN KEY ("cardId") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "card_watcher" ADD CONSTRAINT "card_watcher_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "board_watcher_user_idx" ON "board_watcher" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "card_watcher_user_idx" ON "card_watcher" USING btree ("userId");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "card" ADD CONSTRAINT "card_coverAttachmentId_card_attachment_id_fk" FOREIGN KEY ("coverAttachmentId") REFERENCES "public"."card_attachment"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "card" ADD CONSTRAINT "card_archivedBy_user_id_fk" FOREIGN KEY ("archivedBy") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "list" ADD CONSTRAINT "list_archivedBy_user_id_fk" FOREIGN KEY ("archivedBy") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "card_due_reminder_idx" ON "card" USING btree ("dueDate","dueReminderSentAt");