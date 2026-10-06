import { relations } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { cards } from "./cards";
import { users } from "./users";
import { workspaceMembers } from "./workspaces";

export const checklists = pgTable("card_checklist", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  publicId: varchar("publicId", { length: 12 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  index: integer("index").notNull(),
  cardId: bigint("cardId", { mode: "number" })
    .notNull()
    .references(() => cards.id, { onDelete: "cascade" }),
  createdBy: uuid("createdBy").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt"),
  deletedAt: timestamp("deletedAt"),
  deletedBy: uuid("deletedBy").references(() => users.id, {
    onDelete: "set null",
  }),
}, (table) => [
  index("card_checklist_card_index_idx").on(table.cardId, table.index),
]).enableRLS();

export const checklistsRelations = relations(checklists, ({ one, many }) => ({
  card: one(cards, {
    fields: [checklists.cardId],
    references: [cards.id],
    relationName: "checklistsCard",
  }),
  createdBy: one(users, {
    fields: [checklists.createdBy],
    references: [users.id],
    relationName: "checklistsCreatedByUser",
  }),
  deletedBy: one(users, {
    fields: [checklists.deletedBy],
    references: [users.id],
    relationName: "checklistsDeletedByUser",
  }),
  items: many(checklistItems),
}));

export const checklistItems = pgTable("card_checklist_item", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  publicId: varchar("publicId", { length: 12 }).notNull().unique(),
  title: varchar("title", { length: 500 }).notNull(),
  completed: boolean("completed").notNull().default(false),
  index: integer("index").notNull(),
  // Checklist items double as sub-tasks, with their own dates and reminder.
  // A date without a time is stored as the start of that day.
  startDate: timestamp("startDate"),
  startDateHasTime: boolean("startDateHasTime").notNull().default(false),
  dueDate: timestamp("dueDate"),
  dueDateHasTime: boolean("dueDateHasTime").notNull().default(false),
  // Minutes before the due date to send a reminder; null means no reminder
  dueReminderMinutes: integer("dueReminderMinutes"),
  dueReminderSentAt: timestamp("dueReminderSentAt"),
  checklistId: bigint("checklistId", { mode: "number" })
    .notNull()
    .references(() => checklists.id, { onDelete: "cascade" }),
  createdBy: uuid("createdBy").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt"),
  deletedAt: timestamp("deletedAt"),
  deletedBy: uuid("deletedBy").references(() => users.id, {
    onDelete: "set null",
  }),
}, (table) => [
  index("card_checklist_item_checklist_index_idx").on(
    table.checklistId,
    table.index,
  ),
  index("card_checklist_item_due_reminder_idx").on(
    table.dueDate,
    table.dueReminderSentAt,
  ),
]).enableRLS();

export const checklistItemsRelations = relations(checklistItems, ({ one, many }) => ({
  checklist: one(checklists, {
    fields: [checklistItems.checklistId],
    references: [checklists.id],
    relationName: "checklistItemsChecklist",
  }),
  createdBy: one(users, {
    fields: [checklistItems.createdBy],
    references: [users.id],
    relationName: "checklistItemsCreatedByUser",
  }),
  deletedBy: one(users, {
    fields: [checklistItems.deletedBy],
    references: [users.id],
    relationName: "checklistItemsDeletedByUser",
  }),
  members: many(checklistItemMembers),
}));

/** Board members a checklist item (sub-task) is assigned to. */
export const checklistItemMembers = pgTable(
  "card_checklist_item_member",
  {
    checklistItemId: bigint("checklistItemId", { mode: "number" })
      .notNull()
      .references(() => checklistItems.id, { onDelete: "cascade" }),
    workspaceMemberId: bigint("workspaceMemberId", { mode: "number" })
      .notNull()
      .references(() => workspaceMembers.id, { onDelete: "cascade" }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.checklistItemId, t.workspaceMemberId] }),
    index("card_checklist_item_member_member_idx").on(t.workspaceMemberId),
  ],
).enableRLS();

export const checklistItemMembersRelations = relations(
  checklistItemMembers,
  ({ one }) => ({
    checklistItem: one(checklistItems, {
      fields: [checklistItemMembers.checklistItemId],
      references: [checklistItems.id],
      relationName: "checklistItemMembersItem",
    }),
    member: one(workspaceMembers, {
      fields: [checklistItemMembers.workspaceMemberId],
      references: [workspaceMembers.id],
      relationName: "checklistItemMembersMember",
    }),
  }),
);
