import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import type { NotificationType } from "@kan/db/schema";
import { notifications } from "@kan/db/schema";
import { generateUID } from "@kan/shared/utils";

export const create = async (
  db: dbClient,
  notificationInput: {
    type: NotificationType;
    userId: string;
    cardId?: number;
    commentId?: number;
    workspaceId?: number;
    metadata?: string;
  },
) => {
  const [result] = await db
    .insert(notifications)
    .values({
      publicId: generateUID(),
      type: notificationInput.type,
      userId: notificationInput.userId,
      cardId: notificationInput.cardId,
      commentId: notificationInput.commentId,
      workspaceId: notificationInput.workspaceId,
      metadata: notificationInput.metadata,
    })
    .returning();

  return result;
};

export const exists = async (
  db: dbClient,
  args: {
    userId: string;
    type: NotificationType;
    cardId?: number;
    workspaceId?: number;
    commentId?: number;
  },
) => {
  const result = await db.query.notifications.findFirst({
    where: (notifications, { eq, and, isNull: isNullFn }) => {
      const conditions = [
        eq(notifications.userId, args.userId),
        eq(notifications.type, args.type),
        isNullFn(notifications.deletedAt),
      ];

      if (args.cardId) {
        conditions.push(eq(notifications.cardId, args.cardId));
      }

      if (args.workspaceId) {
        conditions.push(eq(notifications.workspaceId, args.workspaceId));
      }

      return and(...conditions);
    },
  });

  return !!result;
};

export const markAsRead = async (
  db: dbClient,
  notificationId: number,
) => {
  const [result] = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(eq(notifications.id, notificationId))
    .returning();

  return result;
};

export const getUnreadCount = async (
  db: dbClient,
  userId: string,
) => {
  const result = await db
    .select({ count: count() })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        isNull(notifications.deletedAt),
      ),
    );

  return result[0]?.count ?? 0;
};

export const bulkCreate = async (
  db: dbClient,
  notificationInputs: {
    type: NotificationType;
    userId: string;
    cardId?: number;
    commentId?: number;
    workspaceId?: number;
    metadata?: string;
  }[],
) => {
  if (notificationInputs.length === 0) return [];

  return db
    .insert(notifications)
    .values(
      notificationInputs.map((input) => ({
        ...input,
        publicId: generateUID(),
      })),
    )
    .returning({ id: notifications.id });
};

export const getRecentByUserId = async (
  db: dbClient,
  args: { userId: string; limit: number },
) => {
  return db.query.notifications.findMany({
    columns: {
      publicId: true,
      type: true,
      metadata: true,
      readAt: true,
      createdAt: true,
    },
    with: {
      card: {
        columns: { publicId: true, title: true, deletedAt: true },
      },
      comment: {
        columns: { comment: true },
      },
    },
    where: and(
      eq(notifications.userId, args.userId),
      isNull(notifications.deletedAt),
    ),
    orderBy: [desc(notifications.createdAt)],
    limit: args.limit,
  });
};

export const markAsReadByPublicIds = async (
  db: dbClient,
  args: { userId: string; publicIds: string[] },
) => {
  if (args.publicIds.length === 0) return;

  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.userId, args.userId),
        inArray(notifications.publicId, args.publicIds),
        isNull(notifications.readAt),
      ),
    );
};

export const markAllAsRead = async (db: dbClient, userId: string) => {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
};
