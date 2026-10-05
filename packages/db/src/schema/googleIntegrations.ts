import { relations, sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { boards } from "./boards";
import { cards } from "./cards";
import { users } from "./users";
import { workspaces } from "./workspaces";

/**
 * Card events that can be posted to a Google Chat space.
 */
export const googleChatEvents = [
  "card.created",
  "card.moved",
  "card.comment.added",
  "card.dueDate.changed",
  "card.completed",
  "card.archived",
  "card.member.added",
  "card.due.reminder",
] as const;
export type GoogleChatEvent = (typeof googleChatEvents)[number];

/**
 * A Google Chat space that receives card events through an incoming webhook.
 * The webhook URL carries its own key and token, so it is stored encrypted.
 */
export const googleChatSpaces = pgTable(
  "google_chat_space",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    publicId: varchar("publicId", { length: 12 }).notNull().unique(),
    workspaceId: bigint("workspaceId", { mode: "number" })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // null posts events from every board in the workspace
    boardId: bigint("boardId", { mode: "number" }).references(() => boards.id, {
      onDelete: "cascade",
    }),
    name: varchar("name", { length: 255 }).notNull(),
    webhookUrl: text("webhookUrl").notNull(),
    events: text("events").notNull(), // JSON array of GoogleChatEvent
    active: boolean("active").notNull().default(true),
    createdBy: uuid("createdBy").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt"),
  },
  (table) => [index("google_chat_space_workspace_idx").on(table.workspaceId)],
).enableRLS();

export const googleChatSpacesRelations = relations(
  googleChatSpaces,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [googleChatSpaces.workspaceId],
      references: [workspaces.id],
    }),
    board: one(boards, {
      fields: [googleChatSpaces.boardId],
      references: [boards.id],
    }),
  }),
);

export const googleConnectionStatuses = ["active", "error"] as const;
export type GoogleConnectionStatus = (typeof googleConnectionStatuses)[number];
export const googleConnectionStatusEnum = pgEnum(
  "google_connection_status",
  googleConnectionStatuses,
);

/**
 * A user's link to their Google account, used to keep a "Kan" calendar and a
 * "Kan" task list in sync with the cards they are a member of. Tokens are
 * stored encrypted.
 */
export const googleConnections = pgTable("google_connection", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: uuid("userId")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  googleEmail: varchar("googleEmail", { length: 255 }),
  refreshToken: text("refreshToken").notNull(),
  accessToken: text("accessToken"),
  accessTokenExpiresAt: timestamp("accessTokenExpiresAt"),
  scope: text("scope"),
  // IANA time zone from the browser that connected, e.g. "Africa/Accra"
  timeZone: varchar("timeZone", { length: 64 }).notNull().default("UTC"),
  calendarEnabled: boolean("calendarEnabled").notNull().default(true),
  calendarId: varchar("calendarId", { length: 255 }),
  tasksEnabled: boolean("tasksEnabled").notNull().default(true),
  taskListId: varchar("taskListId", { length: 255 }),
  status: googleConnectionStatusEnum("status").notNull().default("active"),
  lastError: text("lastError"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt"),
}).enableRLS();

export const googleConnectionsRelations = relations(
  googleConnections,
  ({ one, many }) => ({
    user: one(users, {
      fields: [googleConnections.userId],
      references: [users.id],
    }),
    syncItems: many(googleSyncItems),
  }),
);

export const googleSyncKinds = ["calendar", "tasks"] as const;
export type GoogleSyncKind = (typeof googleSyncKinds)[number];
export const googleSyncKindEnum = pgEnum("google_sync_kind", googleSyncKinds);

/**
 * Maps a card to the calendar event or task created for it in one user's
 * Google account.
 */
export const googleSyncItems = pgTable(
  "google_sync_item",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    connectionId: bigint("connectionId", { mode: "number" })
      .notNull()
      .references(() => googleConnections.id, { onDelete: "cascade" }),
    cardId: bigint("cardId", { mode: "number" })
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    kind: googleSyncKindEnum("kind").notNull(),
    externalId: varchar("externalId", { length: 255 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt"),
  },
  (table) => [
    uniqueIndex("google_sync_item_unique_idx").on(
      table.connectionId,
      table.cardId,
      table.kind,
    ),
    index("google_sync_item_card_idx").on(table.cardId),
  ],
).enableRLS();

export const googleSyncItemsRelations = relations(
  googleSyncItems,
  ({ one }) => ({
    connection: one(googleConnections, {
      fields: [googleSyncItems.connectionId],
      references: [googleConnections.id],
    }),
    card: one(cards, {
      fields: [googleSyncItems.cardId],
      references: [cards.id],
    }),
  }),
);

export const integrationJobKinds = [
  "google.chat.message",
  "google.sync.card",
  "google.sync.user",
] as const;
export type IntegrationJobKind = (typeof integrationJobKinds)[number];

export const integrationJobStatuses = ["pending", "running", "failed"] as const;
export type IntegrationJobStatus = (typeof integrationJobStatuses)[number];
export const integrationJobStatusEnum = pgEnum(
  "integration_job_status",
  integrationJobStatuses,
);

/**
 * Outbox for calls to external services. Jobs are written while handling a
 * request and sent in the background, so a slow or failing service never
 * breaks the action that caused it. Finished jobs are deleted.
 */
export const integrationJobs = pgTable(
  "integration_job",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: varchar("kind", { length: 64 }).$type<IntegrationJobKind>().notNull(),
    payload: jsonb("payload").notNull(),
    // Pending jobs with the same key are merged into one
    dedupeKey: varchar("dedupeKey", { length: 255 }),
    status: integrationJobStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    runAt: timestamp("runAt").defaultNow().notNull(),
    lockedAt: timestamp("lockedAt"),
    lastError: text("lastError"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    index("integration_job_due_idx").on(table.status, table.runAt),
    uniqueIndex("integration_job_pending_dedupe_idx")
      .on(table.dedupeKey)
      .where(
        sql`${table.status} = 'pending' AND ${table.dedupeKey} IS NOT NULL`,
      ),
  ],
).enableRLS();
