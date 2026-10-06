import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import type { GoogleChatAppSpaceType } from "@kan/db/schema";
import {
  boards,
  cards,
  cardToWorkspaceMembers,
  googleChatAppSpaces,
  googleChatAppUsers,
  lists,
  users,
  workspaceMembers,
  workspaces,
} from "@kan/db/schema";
import { generateUID } from "@kan/shared/utils";

/**
 * Records a space or direct message the app was added to, or refreshes its
 * name. A direct message is tied to the Kan user talking to the app.
 */
export const upsertSpace = async (
  db: dbClient,
  input: {
    spaceName: string;
    spaceType: GoogleChatAppSpaceType;
    displayName: string | null;
    userId: string | null;
  },
) => {
  await db
    .insert(googleChatAppSpaces)
    .values({
      publicId: generateUID(),
      spaceName: input.spaceName,
      spaceType: input.spaceType,
      displayName: input.displayName,
      userId: input.spaceType === "DM" ? input.userId : null,
    })
    .onConflictDoUpdate({
      target: googleChatAppSpaces.spaceName,
      set: {
        displayName: input.displayName,
        // Only set the owner of a direct message, never clear it
        ...(input.spaceType === "DM" && input.userId
          ? { userId: input.userId }
          : {}),
        updatedAt: new Date(),
      },
    });

  return getSpaceByName(db, input.spaceName);
};

export const getSpaceByName = (db: dbClient, spaceName: string) =>
  db.query.googleChatAppSpaces.findFirst({
    where: eq(googleChatAppSpaces.spaceName, spaceName),
    with: {
      board: {
        columns: {
          id: true,
          publicId: true,
          name: true,
          workspaceId: true,
          deletedAt: true,
        },
      },
      list: {
        columns: { id: true, publicId: true, name: true, deletedAt: true },
      },
    },
  });

export const linkSpace = async (
  db: dbClient,
  spaceName: string,
  input: {
    workspaceId: number;
    boardId: number;
    listId: number | null;
    linkedBy: string;
  },
) => {
  await db
    .update(googleChatAppSpaces)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(googleChatAppSpaces.spaceName, spaceName));
};

export const unlinkSpace = async (db: dbClient, spaceName: string) => {
  await db
    .update(googleChatAppSpaces)
    .set({
      workspaceId: null,
      boardId: null,
      listId: null,
      updatedAt: new Date(),
    })
    .where(eq(googleChatAppSpaces.spaceName, spaceName));
};

export const setRemindersEnabled = async (
  db: dbClient,
  spaceName: string,
  enabled: boolean,
) => {
  await db
    .update(googleChatAppSpaces)
    .set({ remindersEnabled: enabled, updatedAt: new Date() })
    .where(eq(googleChatAppSpaces.spaceName, spaceName));
};

export const deleteSpace = async (db: dbClient, spaceName: string) => {
  await db
    .delete(googleChatAppSpaces)
    .where(eq(googleChatAppSpaces.spaceName, spaceName));
};

export const upsertChatUser = async (
  db: dbClient,
  chatUserName: string,
  userId: string,
) => {
  await db
    .insert(googleChatAppUsers)
    .values({ chatUserName, userId })
    .onConflictDoUpdate({
      target: googleChatAppUsers.chatUserName,
      set: { userId, updatedAt: new Date() },
      where: sql`${googleChatAppUsers.userId} <> ${userId}`,
    });
};

/** Kan user ids for the Chat users Kan has seen before, by Chat user name. */
export const getUserIdsByChatUserNames = async (
  db: dbClient,
  chatUserNames: string[],
) => {
  if (chatUserNames.length === 0) return new Map<string, string>();
  const rows = await db.query.googleChatAppUsers.findMany({
    columns: { chatUserName: true, userId: true },
    where: inArray(googleChatAppUsers.chatUserName, chatUserNames),
  });
  return new Map(rows.map((row) => [row.chatUserName, row.userId]));
};

/**
 * Where to post a reminder: the direct messages of the people it is for, and
 * the spaces linked to the card's board. Only those with reminders on.
 */
export const getReminderSpaceNames = async (
  db: dbClient,
  args: { userIds: string[]; boardId: number },
) => {
  const rows = await db.query.googleChatAppSpaces.findMany({
    columns: { spaceName: true },
    where: and(
      eq(googleChatAppSpaces.remindersEnabled, true),
      or(
        args.userIds.length
          ? and(
              eq(googleChatAppSpaces.spaceType, "DM"),
              inArray(googleChatAppSpaces.userId, args.userIds),
            )
          : undefined,
        and(
          eq(googleChatAppSpaces.spaceType, "SPACE"),
          eq(googleChatAppSpaces.boardId, args.boardId),
        ),
      ),
    ),
  });
  return rows.map((row) => row.spaceName);
};

/** Open boards in every workspace the person is an active member of. */
export const getBoardsForUser = (db: dbClient, userId: string) =>
  db
    .select({
      id: boards.id,
      publicId: boards.publicId,
      name: boards.name,
      workspaceId: boards.workspaceId,
      workspaceName: workspaces.name,
    })
    .from(boards)
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, boards.workspaceId),
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.status, "active"),
        isNull(workspaceMembers.deletedAt),
      ),
    )
    .where(
      and(
        isNull(boards.deletedAt),
        isNull(workspaces.deletedAt),
        eq(boards.type, "regular"),
        eq(boards.isArchived, false),
      ),
    )
    .orderBy(asc(workspaces.name), asc(boards.name));

export const getOpenLists = (db: dbClient, boardId: number) =>
  db.query.lists.findMany({
    columns: { id: true, publicId: true, name: true },
    where: and(eq(lists.boardId, boardId), isNull(lists.deletedAt)),
    orderBy: [asc(lists.index)],
  });

/** Workspace member public ids for the given people, if they are members. */
export const getWorkspaceMemberPublicIds = async (
  db: dbClient,
  workspaceId: number,
  userIds: string[],
) => {
  if (userIds.length === 0) return [];
  const rows = await db.query.workspaceMembers.findMany({
    columns: { publicId: true },
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      inArray(workspaceMembers.userId, userIds),
      eq(workspaceMembers.status, "active"),
      isNull(workspaceMembers.deletedAt),
    ),
  });
  return rows.map((row) => row.publicId);
};

/** Open cards the person is a member of that are due before `until`. */
export const getDueCardsForUser = (
  db: dbClient,
  args: { userId: string; until: Date; limit?: number },
) =>
  db
    .select({
      publicId: cards.publicId,
      title: cards.title,
      dueDate: cards.dueDate,
      listName: lists.name,
      boardName: boards.name,
    })
    .from(cards)
    .innerJoin(
      cardToWorkspaceMembers,
      eq(cardToWorkspaceMembers.cardId, cards.id),
    )
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.id, cardToWorkspaceMembers.workspaceMemberId),
        eq(workspaceMembers.userId, args.userId),
        isNull(workspaceMembers.deletedAt),
      ),
    )
    .innerJoin(lists, eq(lists.id, cards.listId))
    .innerJoin(boards, eq(boards.id, lists.boardId))
    .where(
      and(
        isNull(cards.deletedAt),
        isNull(lists.deletedAt),
        isNull(boards.deletedAt),
        eq(cards.dueDateCompleted, false),
        lte(cards.dueDate, args.until),
      ),
    )
    .orderBy(asc(cards.dueDate))
    .limit(args.limit ?? 10);

/** The Kan user with this email address, ignoring case. */
export const getUserByEmail = (db: dbClient, email: string) =>
  db.query.users.findFirst({
    columns: {
      id: true,
      name: true,
      email: true,
      emailVerified: true,
      image: true,
      createdAt: true,
      updatedAt: true,
    },
    where: sql`lower(${users.email}) = ${email.trim().toLowerCase()}`,
  });

export const getUserById = (db: dbClient, userId: string) =>
  db.query.users.findFirst({
    columns: {
      id: true,
      name: true,
      email: true,
      emailVerified: true,
      image: true,
      createdAt: true,
      updatedAt: true,
    },
    where: eq(users.id, userId),
  });
