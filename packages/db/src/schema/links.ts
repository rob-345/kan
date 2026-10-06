import { relations } from "drizzle-orm";
import {
  bigint,
  bigserial,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { cards } from "./cards";
import { users } from "./users";

// A web link attached to a card. Kept generic (any http/https URL) so other
// link sources, such as Google Drive files, can sit alongside plain links.
export const cardLinks = pgTable(
  "card_link",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    publicId: varchar("publicId", { length: 12 }).notNull().unique(),
    cardId: bigint("cardId", { mode: "number" })
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    // Optional display name chosen by the user; the preview title is used
    // when this is empty.
    title: varchar("title", { length: 255 }),
    createdBy: uuid("createdBy").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    deletedAt: timestamp("deletedAt"),
  },
  (table) => [
    index("card_link_card_created_at_idx").on(table.cardId, table.createdAt),
  ],
).enableRLS();

export const cardLinksRelations = relations(cardLinks, ({ one }) => ({
  card: one(cards, {
    fields: [cardLinks.cardId],
    references: [cards.id],
    relationName: "cardLinksCard",
  }),
  createdBy: one(users, {
    fields: [cardLinks.createdBy],
    references: [users.id],
    relationName: "cardLinksCreatedByUser",
  }),
}));

export const linkPreviewStatuses = ["ok", "failed"] as const;
export type LinkPreviewStatus = (typeof linkPreviewStatuses)[number];
export const linkPreviewStatusEnum = pgEnum(
  "link_preview_status",
  linkPreviewStatuses,
);

// Cache of page metadata (Open Graph / Twitter card / HTML) keyed by URL,
// shared by card links and links inside descriptions and comments.
export const linkPreviews = pgTable("link_preview", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  url: text("url").notNull().unique(),
  status: linkPreviewStatusEnum("status").notNull(),
  finalUrl: text("finalUrl"),
  title: text("title"),
  description: text("description"),
  imageUrl: text("imageUrl"),
  siteName: varchar("siteName", { length: 255 }),
  faviconUrl: text("faviconUrl"),
  fetchedAt: timestamp("fetchedAt").defaultNow().notNull(),
}).enableRLS();
