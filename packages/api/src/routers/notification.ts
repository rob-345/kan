import { TRPCError } from "@trpc/server";
import { z } from "zod";

import * as notificationRepo from "@kan/db/repository/notification.repo";
import { notificationTypes } from "@kan/db/schema";

import { createTRPCRouter, protectedProcedure } from "../trpc";

const notificationSchema = z.object({
  publicId: z.string(),
  type: z.enum(notificationTypes),
  createdAt: z.date(),
  readAt: z.date().nullable(),
  actorName: z.string().nullable(),
  boardName: z.string().nullable(),
  fromListName: z.string().nullable(),
  toListName: z.string().nullable(),
  dueDate: z.string().nullable(),
  comment: z.string().nullable(),
  card: z
    .object({
      publicId: z.string(),
      title: z.string(),
      isAvailable: z.boolean(),
    })
    .nullable(),
});

const parseMetadata = (metadata: string | null) => {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
};

const asString = (value: unknown) => (typeof value === "string" ? value : null);

export const notificationRouter = createTRPCRouter({
  list: protectedProcedure
    .meta({
      openapi: {
        summary: "List my notifications",
        method: "GET",
        path: "/notifications",
        description: "Returns the current user's most recent notifications",
        tags: ["Notifications"],
        protect: true,
      },
    })
    .input(z.object({ limit: z.number().int().min(1).max(100).default(50) }))
    .output(z.array(notificationSchema))
    .query(async ({ ctx, input }) => {
      const userId = ctx.user?.id;

      if (!userId)
        throw new TRPCError({
          message: `User not authenticated`,
          code: "UNAUTHORIZED",
        });

      const notifications = await notificationRepo.getRecentByUserId(ctx.db, {
        userId,
        limit: input.limit,
      });

      return notifications.map((notification) => {
        const metadata = parseMetadata(notification.metadata);

        return {
          publicId: notification.publicId,
          type: notification.type,
          createdAt: notification.createdAt,
          readAt: notification.readAt,
          actorName: asString(metadata.actorName),
          boardName: asString(metadata.boardName),
          fromListName: asString(metadata.fromListName),
          toListName: asString(metadata.toListName),
          dueDate: asString(metadata.dueDate),
          comment: notification.comment?.comment ?? null,
          card: notification.card
            ? {
                publicId: notification.card.publicId,
                title: notification.card.title,
                isAvailable: !notification.card.deletedAt,
              }
            : null,
        };
      });
    }),
  unreadCount: protectedProcedure
    .meta({
      openapi: {
        summary: "Count my unread notifications",
        method: "GET",
        path: "/notifications/unread-count",
        description: "Returns how many unread notifications the user has",
        tags: ["Notifications"],
        protect: true,
      },
    })
    .input(z.void())
    .output(z.object({ count: z.number() }))
    .query(async ({ ctx }) => {
      const userId = ctx.user?.id;

      if (!userId)
        throw new TRPCError({
          message: `User not authenticated`,
          code: "UNAUTHORIZED",
        });

      const count = await notificationRepo.getUnreadCount(ctx.db, userId);

      return { count };
    }),
  markRead: protectedProcedure
    .meta({
      openapi: {
        summary: "Mark notifications as read",
        method: "POST",
        path: "/notifications/read",
        description:
          "Marks the given notifications as read, or all of them when no IDs are given",
        tags: ["Notifications"],
        protect: true,
      },
    })
    .input(z.object({ publicIds: z.array(z.string().min(12)).optional() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user?.id;

      if (!userId)
        throw new TRPCError({
          message: `User not authenticated`,
          code: "UNAUTHORIZED",
        });

      if (input.publicIds) {
        await notificationRepo.markAsReadByPublicIds(ctx.db, {
          userId,
          publicIds: input.publicIds,
        });
      } else {
        await notificationRepo.markAllAsRead(ctx.db, userId);
      }

      return { success: true };
    }),
});
