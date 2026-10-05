import { and, eq, isNull, or } from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import type { GoogleChatEvent } from "@kan/db/schema";
import { cards, comments, googleChatSpaces } from "@kan/db/schema";
import { generateUID } from "@kan/shared/utils";

const parseEvents = (raw: string) => JSON.parse(raw) as GoogleChatEvent[];

const listColumns = {
  publicId: true,
  name: true,
  events: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} as const;

const withBoard = {
  board: { columns: { publicId: true, name: true } },
} as const;

export const create = async (
  db: dbClient,
  input: {
    workspaceId: number;
    boardId: number | null;
    name: string;
    webhookUrl: string;
    events: GoogleChatEvent[];
    createdBy: string;
  },
) => {
  const [space] = await db
    .insert(googleChatSpaces)
    .values({
      publicId: generateUID(),
      workspaceId: input.workspaceId,
      boardId: input.boardId,
      name: input.name,
      webhookUrl: input.webhookUrl,
      events: JSON.stringify(input.events),
      createdBy: input.createdBy,
    })
    .returning({ publicId: googleChatSpaces.publicId });

  return space ? getByPublicIdForDisplay(db, space.publicId) : null;
};

export const update = async (
  db: dbClient,
  publicId: string,
  input: {
    boardId?: number | null;
    name?: string;
    webhookUrl?: string;
    events?: GoogleChatEvent[];
    active?: boolean;
  },
) => {
  await db
    .update(googleChatSpaces)
    .set({
      boardId: input.boardId,
      name: input.name,
      webhookUrl: input.webhookUrl,
      events: input.events ? JSON.stringify(input.events) : undefined,
      active: input.active,
      updatedAt: new Date(),
    })
    .where(eq(googleChatSpaces.publicId, publicId));

  return getByPublicIdForDisplay(db, publicId);
};

const getByPublicIdForDisplay = async (db: dbClient, publicId: string) => {
  const space = await db.query.googleChatSpaces.findFirst({
    columns: listColumns,
    with: withBoard,
    where: eq(googleChatSpaces.publicId, publicId),
  });
  return space ? { ...space, events: parseEvents(space.events) } : null;
};

/**
 * Includes the encrypted webhook URL. For server-side use only.
 */
export const getByPublicId = async (db: dbClient, publicId: string) => {
  const space = await db.query.googleChatSpaces.findFirst({
    where: eq(googleChatSpaces.publicId, publicId),
  });
  return space ? { ...space, events: parseEvents(space.events) } : null;
};

export const getById = async (db: dbClient, id: number) => {
  const space = await db.query.googleChatSpaces.findFirst({
    where: eq(googleChatSpaces.id, id),
  });
  return space ? { ...space, events: parseEvents(space.events) } : null;
};

export const getAllByWorkspaceId = async (
  db: dbClient,
  workspaceId: number,
) => {
  const spaces = await db.query.googleChatSpaces.findMany({
    columns: listColumns,
    with: withBoard,
    where: eq(googleChatSpaces.workspaceId, workspaceId),
    orderBy: (spaces, { asc }) => [asc(spaces.createdAt)],
  });
  return spaces.map((space) => ({
    ...space,
    events: parseEvents(space.events),
  }));
};

/**
 * Active spaces that want an event from a board: those set to the board and
 * those set to every board in the workspace.
 */
export const getActiveForEvent = async (
  db: dbClient,
  args: { workspaceId: number; boardId: number; event: GoogleChatEvent },
) => {
  const spaces = await db.query.googleChatSpaces.findMany({
    columns: { id: true, events: true },
    where: and(
      eq(googleChatSpaces.workspaceId, args.workspaceId),
      eq(googleChatSpaces.active, true),
      or(
        isNull(googleChatSpaces.boardId),
        eq(googleChatSpaces.boardId, args.boardId),
      ),
    ),
  });
  return spaces
    .filter((space) => parseEvents(space.events).includes(args.event))
    .map((space) => space.id);
};

export const hardDelete = async (db: dbClient, publicId: string) => {
  await db
    .delete(googleChatSpaces)
    .where(eq(googleChatSpaces.publicId, publicId));
};

/** What a Chat message needs to describe a card, archived or not. */
export const getCardForChat = (db: dbClient, cardId: number) =>
  db.query.cards.findFirst({
    columns: { id: true, publicId: true, title: true },
    where: eq(cards.id, cardId),
    with: {
      list: {
        columns: { name: true },
        with: {
          board: { columns: { id: true, name: true, workspaceId: true } },
        },
      },
    },
  });

export const getCommentHtml = async (db: dbClient, commentId: number) => {
  const comment = await db.query.comments.findFirst({
    columns: { comment: true },
    where: eq(comments.id, commentId),
  });
  return comment?.comment ?? null;
};
