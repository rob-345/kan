import { and, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import type { GoogleConnectionStatus, GoogleSyncKind } from "@kan/db/schema";
import {
  cards,
  cardToWorkspaceMembers,
  googleConnections,
  googleSyncItems,
  lists,
  workspaceMembers,
} from "@kan/db/schema";

export const upsert = async (
  db: dbClient,
  input: {
    userId: string;
    googleEmail: string | null;
    refreshToken: string;
    accessToken: string;
    accessTokenExpiresAt: Date;
    scope: string | null;
    timeZone: string;
  },
) => {
  const [connection] = await db
    .insert(googleConnections)
    .values(input)
    .onConflictDoUpdate({
      target: googleConnections.userId,
      set: {
        googleEmail: input.googleEmail,
        refreshToken: input.refreshToken,
        accessToken: input.accessToken,
        accessTokenExpiresAt: input.accessTokenExpiresAt,
        scope: input.scope,
        timeZone: input.timeZone,
        status: "active",
        lastError: null,
        updatedAt: new Date(),
      },
    })
    .returning();

  return connection;
};

export const getByUserId = (db: dbClient, userId: string) =>
  db.query.googleConnections.findFirst({
    where: eq(googleConnections.userId, userId),
  });

export const getById = (db: dbClient, id: number) =>
  db.query.googleConnections.findFirst({
    where: eq(googleConnections.id, id),
  });

export const update = async (
  db: dbClient,
  id: number,
  input: Partial<{
    accessToken: string;
    accessTokenExpiresAt: Date;
    calendarEnabled: boolean;
    calendarId: string | null;
    tasksEnabled: boolean;
    taskListId: string | null;
    status: GoogleConnectionStatus;
    lastError: string | null;
  }>,
) => {
  const [connection] = await db
    .update(googleConnections)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(googleConnections.id, id))
    .returning();
  return connection;
};

export const deleteByUserId = async (db: dbClient, userId: string) => {
  await db
    .delete(googleConnections)
    .where(eq(googleConnections.userId, userId));
};

export const getSyncItems = (db: dbClient, connectionId: number) =>
  db.query.googleSyncItems.findMany({
    where: eq(googleSyncItems.connectionId, connectionId),
  });

export const getSyncItemsForCard = (db: dbClient, cardId: number) =>
  db.query.googleSyncItems.findMany({
    where: eq(googleSyncItems.cardId, cardId),
  });

export const saveSyncItem = async (
  db: dbClient,
  input: {
    connectionId: number;
    cardId: number;
    kind: GoogleSyncKind;
    externalId: string;
  },
) => {
  await db
    .insert(googleSyncItems)
    .values(input)
    .onConflictDoUpdate({
      target: [
        googleSyncItems.connectionId,
        googleSyncItems.cardId,
        googleSyncItems.kind,
      ],
      set: { externalId: input.externalId, updatedAt: new Date() },
    });
};

export const deleteSyncItem = async (db: dbClient, id: number) => {
  await db.delete(googleSyncItems).where(eq(googleSyncItems.id, id));
};

/**
 * Everything needed to decide what a card should look like in the Google
 * accounts of its members.
 */
export const getCardForSync = (db: dbClient, cardId: number) =>
  db.query.cards.findFirst({
    columns: {
      id: true,
      publicId: true,
      title: true,
      dueDate: true,
      startDate: true,
      dueDateCompleted: true,
      dueReminderMinutes: true,
      deletedAt: true,
    },
    where: eq(cards.id, cardId),
    with: {
      list: {
        columns: { name: true, deletedAt: true },
        with: {
          board: { columns: { name: true, deletedAt: true } },
        },
      },
      members: {
        with: {
          member: { columns: { userId: true, deletedAt: true } },
        },
      },
    },
  });

/** Active Google connections belonging to the given users. */
export const getActiveConnectionsForUsers = (
  db: dbClient,
  userIds: string[],
) =>
  userIds.length === 0
    ? Promise.resolve([])
    : db.query.googleConnections.findMany({
        where: and(
          inArray(googleConnections.userId, userIds),
          eq(googleConnections.status, "active"),
        ),
      });

/**
 * Cards a user is a member of that have a due date on or after `since`.
 */
export const getMemberCardIdsWithDueDate = async (
  db: dbClient,
  args: { userId: string; since: Date },
) => {
  const rows = await db
    .selectDistinct({ id: cards.id })
    .from(cards)
    .innerJoin(
      cardToWorkspaceMembers,
      eq(cardToWorkspaceMembers.cardId, cards.id),
    )
    .innerJoin(
      workspaceMembers,
      eq(workspaceMembers.id, cardToWorkspaceMembers.workspaceMemberId),
    )
    .where(
      and(
        eq(workspaceMembers.userId, args.userId),
        isNull(workspaceMembers.deletedAt),
        isNull(cards.deletedAt),
        isNotNull(cards.dueDate),
        gte(cards.dueDate, args.since),
      ),
    );
  return rows.map((row) => row.id);
};

export const getByIds = (db: dbClient, ids: number[]) =>
  ids.length === 0
    ? Promise.resolve([])
    : db.query.googleConnections.findMany({
        where: inArray(googleConnections.id, ids),
      });

/** Whether anyone has connected Google, so sync work can be skipped if not. */
export const hasActiveConnections = async (db: dbClient) => {
  const connection = await db.query.googleConnections.findFirst({
    columns: { id: true },
    where: eq(googleConnections.status, "active"),
  });
  return !!connection;
};

/** Cards with a due date in the given lists, including deleted ones. */
export const getCardIdsWithDueDateInLists = async (
  db: dbClient,
  listIds: number[],
) => {
  if (listIds.length === 0) return [];
  const rows = await db
    .select({ id: cards.id })
    .from(cards)
    .where(and(inArray(cards.listId, listIds), isNotNull(cards.dueDate)));
  return rows.map((row) => row.id);
};

/** Cards with a due date anywhere on a board, including deleted ones. */
export const getCardIdsWithDueDateInBoard = async (
  db: dbClient,
  boardId: number,
) => {
  const rows = await db
    .select({ id: cards.id })
    .from(cards)
    .innerJoin(lists, eq(lists.id, cards.listId))
    .where(and(eq(lists.boardId, boardId), isNotNull(cards.dueDate)));
  return rows.map((row) => row.id);
};

export const deleteSyncItemsOfKind = async (
  db: dbClient,
  connectionId: number,
  kind: GoogleSyncKind,
) => {
  await db
    .delete(googleSyncItems)
    .where(
      and(
        eq(googleSyncItems.connectionId, connectionId),
        eq(googleSyncItems.kind, kind),
      ),
    );
};
