CREATE TYPE "public"."link_preview_status" AS ENUM('ok', 'failed');--> statement-breakpoint
ALTER TYPE "public"."card_activity_type" ADD VALUE 'card.updated.link.added';--> statement-breakpoint
ALTER TYPE "public"."card_activity_type" ADD VALUE 'card.updated.link.removed';--> statement-breakpoint
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
CREATE INDEX IF NOT EXISTS "card_link_card_created_at_idx" ON "card_link" USING btree ("cardId","createdAt");