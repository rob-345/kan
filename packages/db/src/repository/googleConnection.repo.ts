import {
  and,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import type { GoogleConnectionStatus, GoogleSyncKind } from "@kan/db/schema";
import {
  cards,
  cardToWorkspaceMembers,
  checklistItemMembers,
  checklistItems,
  checklists,
  googleConnections,
  googleSyncItems,
  lists,
  workspaceMembers,
} from "@kan/db/schema";

/** True for cards with a checklist item (sub-task) that has a due date. */
const hasDatedChecklistItem = () =>
  exists(
    sql`(SELECT 1 FROM ${checklistItems} JOIN ${checklists} ON ${checklists.id} = ${checklistItems.checklistId} WHERE ${checklists.cardId} = ${cards.id} AND ${checklistItems.dueDate} IS NOT NULL)`,
  );

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
    checklistItemId: number | null;
    kind: GoogleSyncKind;
    externalId: string;
  },
) => {
  const set = { externalId: input.externalId, updatedAt: new Date() };
  const insert = db.insert(googleSyncItems).values(input);

  // Each target matches one of the two partial unique indexes
  await (input.checklistItemId === null
    ? insert.onConflictDoUpdate({
        target: [
          googleSyncItems.connectionId,
          googleSyncItems.cardId,
          googleSyncItems.kind,
        ],
        targetWhere: sql`${googleSyncItems.checklistItemId} IS NULL`,
        set,
      })
    : insert.onConflictDoUpdate({
        target: [
          googleSyncItems.connectionId,
          googleSyncItems.checklistItemId,
          googleSyncItems.kind,
        ],
        targetWhere: sql`${googleSyncItems.checklistItemId} IS NOT NULL`,
        set,
      }));
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
      dueDateHasTime: true,
      startDate: true,
      startDateHasTime: true,
      dueDateCompleted: true,
      dueReminderMinutes: true,
      deletedAt: true,
    },
    where: eq(cards.id, cardId),
    with: {
      checklists: {
        columns: { deletedAt: true },
        with: {
          items: {
            columns: {
              id: true,
              publicId: true,
              title: true,
              completed: true,
              startDate: true,
              startDateHasTime: true,
              dueDate: true,
              dueDateHasTime: true,
              dueReminderMinutes: true,
              deletedAt: true,
            },
            with: {
              members: {
                columns: {},
                with: {
                  member: { columns: { userId: true, deletedAt: true } },
                },
              },
            },
          },
        },
      },
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
 * Cards with something dated on or after `since` that a user should see in
 * Google: cards they're a member of with a due date or a dated checklist
 * item, and cards with a dated checklist item assigned to them.
 */
export const getMemberCardIdsWithDueDate = async (
  db: dbClient,
  args: { userId: string; since: Date },
) => {
  const memberCards = await db
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
        or(
          gte(cards.dueDate, args.since),
          exists(
            sql`(SELECT 1 FROM ${checklistItems} JOIN ${checklists} ON ${checklists.id} = ${checklistItems.checklistId} WHERE ${checklists.cardId} = ${cards.id} AND ${checklistItems.dueDate} >= ${args.since} AND ${checklistItems.deletedAt} IS NULL)`,
          ),
        ),
      ),
    );

  const assignedCards = await db
    .selectDistinct({ id: checklists.cardId })
    .from(checklistItems)
    .innerJoin(checklists, eq(checklists.id, checklistItems.checklistId))
    .innerJoin(
      checklistItemMembers,
      eq(checklistItemMembers.checklistItemId, checklistItems.id),
    )
    .innerJoin(
      workspaceMembers,
      eq(workspaceMembers.id, checklistItemMembers.workspaceMemberId),
    )
    .where(
      and(
        eq(workspaceMembers.userId, args.userId),
        isNull(workspaceMembers.deletedAt),
        isNull(checklistItems.deletedAt),
        isNull(checklists.deletedAt),
        gte(checklistItems.dueDate, args.since),
      ),
    );

  return [
    ...new Set([
      ...memberCards.map((row) => row.id),
      ...assignedCards.map((row) => row.id),
    ]),
  ];
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

/**
 * Cards with a due date or a dated checklist item in the given lists,
 * including deleted ones.
 */
export const getCardIdsWithDueDateInLists = async (
  db: dbClient,
  listIds: number[],
) => {
  if (listIds.length === 0) return [];
  const rows = await db
    .select({ id: cards.id })
    .from(cards)
    .where(
      and(
        inArray(cards.listId, listIds),
        or(isNotNull(cards.dueDate), hasDatedChecklistItem()),
      ),
    );
  return rows.map((row) => row.id);
};

/**
 * Cards with a due date or a dated checklist item anywhere on a board,
 * including deleted ones.
 */
export const getCardIdsWithDueDateInBoard = async (
  db: dbClient,
  boardId: number,
) => {
  const rows = await db
    .select({ id: cards.id })
    .from(cards)
    .innerJoin(lists, eq(lists.id, cards.listId))
    .where(
      and(
        eq(lists.boardId, boardId),
        or(isNotNull(cards.dueDate), hasDatedChecklistItem()),
      ),
    );
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
