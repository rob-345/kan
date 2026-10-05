import { and, eq, isNotNull, isNull } from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import {
  boardWatchers,
  cards,
  cardToWorkspaceMembers,
  cardWatchers,
  lists,
  workspaceMembers,
} from "@kan/db/schema";

export const watchCard = async (
  db: dbClient,
  args: { cardId: number; userId: string },
) => {
  await db.insert(cardWatchers).values(args).onConflictDoNothing();
};

export const unwatchCard = async (
  db: dbClient,
  args: { cardId: number; userId: string },
) => {
  await db
    .delete(cardWatchers)
    .where(
      and(
        eq(cardWatchers.cardId, args.cardId),
        eq(cardWatchers.userId, args.userId),
      ),
    );
};

export const isWatchingCard = async (
  db: dbClient,
  args: { cardId: number; userId: string },
) => {
  const result = await db.query.cardWatchers.findFirst({
    columns: { cardId: true },
    where: and(
      eq(cardWatchers.cardId, args.cardId),
      eq(cardWatchers.userId, args.userId),
    ),
  });

  return !!result;
};

export const watchBoard = async (
  db: dbClient,
  args: { boardId: number; userId: string },
) => {
  await db.insert(boardWatchers).values(args).onConflictDoNothing();
};

export const unwatchBoard = async (
  db: dbClient,
  args: { boardId: number; userId: string },
) => {
  await db
    .delete(boardWatchers)
    .where(
      and(
        eq(boardWatchers.boardId, args.boardId),
        eq(boardWatchers.userId, args.userId),
      ),
    );
};

export const isWatchingBoard = async (
  db: dbClient,
  args: { boardId: number; userId: string },
) => {
  const result = await db.query.boardWatchers.findFirst({
    columns: { boardId: true },
    where: and(
      eq(boardWatchers.boardId, args.boardId),
      eq(boardWatchers.userId, args.userId),
    ),
  });

  return !!result;
};

/**
 * Users who should hear about activity on a card: people watching the card,
 * people watching its board, and the card's members.
 */
export const getCardAudienceUserIds = async (db: dbClient, cardId: number) => {
  const [cardWatcherRows, boardWatcherRows, memberRows] = await Promise.all([
    db
      .select({ userId: cardWatchers.userId })
      .from(cardWatchers)
      .where(eq(cardWatchers.cardId, cardId)),
    db
      .select({ userId: boardWatchers.userId })
      .from(boardWatchers)
      .innerJoin(lists, eq(lists.boardId, boardWatchers.boardId))
      .innerJoin(cards, eq(cards.listId, lists.id))
      .where(eq(cards.id, cardId)),
    db
      .select({ userId: workspaceMembers.userId })
      .from(cardToWorkspaceMembers)
      .innerJoin(
        workspaceMembers,
        eq(cardToWorkspaceMembers.workspaceMemberId, workspaceMembers.id),
      )
      .where(
        and(
          eq(cardToWorkspaceMembers.cardId, cardId),
          isNull(workspaceMembers.deletedAt),
          isNotNull(workspaceMembers.userId),
        ),
      ),
  ]);

  const userIds = new Set<string>();
  for (const row of [...cardWatcherRows, ...boardWatcherRows, ...memberRows]) {
    if (row.userId) userIds.add(row.userId);
  }

  return [...userIds];
};
