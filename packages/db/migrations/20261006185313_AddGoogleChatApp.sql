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
CREATE UNIQUE INDEX IF NOT EXISTS "google_chat_app_space_name_idx" ON "google_chat_app_space" USING btree ("spaceName");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "google_chat_app_space_user_idx" ON "google_chat_app_space" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "google_chat_app_space_board_idx" ON "google_chat_app_space" USING btree ("boardId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "google_chat_app_user_name_idx" ON "google_chat_app_user" USING btree ("chatUserName");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "google_chat_app_user_user_idx" ON "google_chat_app_user" USING btree ("userId");