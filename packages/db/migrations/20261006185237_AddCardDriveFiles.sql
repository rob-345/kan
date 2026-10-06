ALTER TYPE "public"."card_activity_type" ADD VALUE 'card.updated.driveFile.added';--> statement-breakpoint
ALTER TYPE "public"."card_activity_type" ADD VALUE 'card.updated.driveFile.removed';--> statement-breakpoint
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
CREATE INDEX IF NOT EXISTS "card_drive_file_card_created_at_idx" ON "card_drive_file" USING btree ("cardId","createdAt");