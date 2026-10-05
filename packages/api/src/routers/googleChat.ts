import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { dbClient } from "@kan/db/client";
import * as boardRepo from "@kan/db/repository/board.repo";
import * as googleChatRepo from "@kan/db/repository/googleChat.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";
import { googleChatEvents } from "@kan/db/schema";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { decryptToken, encryptToken } from "../utils/encryption";
import {
  googleChatWebhookUrlSchema,
  postChatMessage,
} from "../utils/google/chat";
import { assertPermission } from "../utils/permissions";

const googleChatEventSchema = z.enum(googleChatEvents);

const spaceSchema = z.object({
  publicId: z.string(),
  name: z.string(),
  board: z.object({ publicId: z.string(), name: z.string() }).nullable(),
  events: z.array(googleChatEventSchema),
  active: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date().nullable(),
});

const getManagedWorkspace = async (
  db: dbClient,
  userId: string | undefined,
  workspacePublicId: string,
) => {
  if (!userId)
    throw new TRPCError({
      message: "User not authenticated",
      code: "UNAUTHORIZED",
    });

  const workspace = await workspaceRepo.getByPublicId(db, workspacePublicId);

  if (!workspace)
    throw new TRPCError({
      message: "Workspace not found",
      code: "NOT_FOUND",
    });

  await assertPermission(db, userId, workspace.id, "workspace:manage");

  return { workspace, userId };
};

const getBoardIdInWorkspace = async (
  db: dbClient,
  boardPublicId: string,
  workspaceId: number,
) => {
  const board = await boardRepo.getWorkspaceAndBoardIdByBoardPublicId(
    db,
    boardPublicId,
  );

  if (!board || board.workspaceId !== workspaceId)
    throw new TRPCError({
      message: "Board not found",
      code: "NOT_FOUND",
    });

  return board.id;
};

const getSpaceInWorkspace = async (
  db: dbClient,
  spacePublicId: string,
  workspaceId: number,
) => {
  const space = await googleChatRepo.getByPublicId(db, spacePublicId);

  if (!space || space.workspaceId !== workspaceId)
    throw new TRPCError({
      message: "Google Chat space not found",
      code: "NOT_FOUND",
    });

  return space;
};

export const googleChatRouter = createTRPCRouter({
  list: protectedProcedure
    .meta({
      openapi: {
        summary: "Get Google Chat spaces",
        method: "GET",
        path: "/workspaces/{workspacePublicId}/google-chat-spaces",
        description:
          "Retrieves the Google Chat spaces that receive card events from a workspace",
        tags: ["Google Chat"],
        protect: true,
      },
    })
    .input(z.object({ workspacePublicId: z.string().min(12) }))
    .output(z.array(spaceSchema))
    .query(async ({ ctx, input }) => {
      const { workspace } = await getManagedWorkspace(
        ctx.db,
        ctx.user?.id,
        input.workspacePublicId,
      );

      return googleChatRepo.getAllByWorkspaceId(ctx.db, workspace.id);
    }),

  create: protectedProcedure
    .meta({
      openapi: {
        summary: "Add a Google Chat space",
        method: "POST",
        path: "/workspaces/{workspacePublicId}/google-chat-spaces",
        description:
          "Posts card events from a workspace, or one of its boards, to a Google Chat space through its incoming webhook",
        tags: ["Google Chat"],
        protect: true,
      },
    })
    .input(
      z.object({
        workspacePublicId: z.string().min(12),
        name: z.string().trim().min(1).max(255),
        webhookUrl: googleChatWebhookUrlSchema,
        boardPublicId: z.string().min(12).nullable(),
        events: z.array(googleChatEventSchema).min(1),
      }),
    )
    .output(spaceSchema)
    .mutation(async ({ ctx, input }) => {
      const { workspace, userId } = await getManagedWorkspace(
        ctx.db,
        ctx.user?.id,
        input.workspacePublicId,
      );

      const boardId = input.boardPublicId
        ? await getBoardIdInWorkspace(ctx.db, input.boardPublicId, workspace.id)
        : null;

      const space = await googleChatRepo.create(ctx.db, {
        workspaceId: workspace.id,
        boardId,
        name: input.name,
        webhookUrl: encryptToken(input.webhookUrl),
        events: [...new Set(input.events)],
        createdBy: userId,
      });

      if (!space)
        throw new TRPCError({
          message: "Unable to add Google Chat space",
          code: "INTERNAL_SERVER_ERROR",
        });

      return space;
    }),

  update: protectedProcedure
    .meta({
      openapi: {
        summary: "Update a Google Chat space",
        method: "PUT",
        path: "/workspaces/{workspacePublicId}/google-chat-spaces/{spacePublicId}",
        description:
          "Updates a Google Chat space. Leave out webhookUrl to keep the current one",
        tags: ["Google Chat"],
        protect: true,
      },
    })
    .input(
      z.object({
        workspacePublicId: z.string().min(12),
        spacePublicId: z.string().min(12),
        name: z.string().trim().min(1).max(255).optional(),
        webhookUrl: googleChatWebhookUrlSchema.optional(),
        boardPublicId: z.string().min(12).nullable().optional(),
        events: z.array(googleChatEventSchema).min(1).optional(),
        active: z.boolean().optional(),
      }),
    )
    .output(spaceSchema)
    .mutation(async ({ ctx, input }) => {
      const { workspace } = await getManagedWorkspace(
        ctx.db,
        ctx.user?.id,
        input.workspacePublicId,
      );

      await getSpaceInWorkspace(ctx.db, input.spacePublicId, workspace.id);

      const boardId =
        input.boardPublicId === undefined
          ? undefined
          : input.boardPublicId === null
            ? null
            : await getBoardIdInWorkspace(
                ctx.db,
                input.boardPublicId,
                workspace.id,
              );

      const space = await googleChatRepo.update(ctx.db, input.spacePublicId, {
        boardId,
        name: input.name,
        webhookUrl: input.webhookUrl
          ? encryptToken(input.webhookUrl)
          : undefined,
        events: input.events ? [...new Set(input.events)] : undefined,
        active: input.active,
      });

      if (!space)
        throw new TRPCError({
          message: "Unable to update Google Chat space",
          code: "INTERNAL_SERVER_ERROR",
        });

      return space;
    }),

  delete: protectedProcedure
    .meta({
      openapi: {
        summary: "Remove a Google Chat space",
        method: "DELETE",
        path: "/workspaces/{workspacePublicId}/google-chat-spaces/{spacePublicId}",
        description: "Stops posting card events to a Google Chat space",
        tags: ["Google Chat"],
        protect: true,
      },
    })
    .input(
      z.object({
        workspacePublicId: z.string().min(12),
        spacePublicId: z.string().min(12),
      }),
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const { workspace } = await getManagedWorkspace(
        ctx.db,
        ctx.user?.id,
        input.workspacePublicId,
      );

      await getSpaceInWorkspace(ctx.db, input.spacePublicId, workspace.id);
      await googleChatRepo.hardDelete(ctx.db, input.spacePublicId);

      return { success: true };
    }),

  test: protectedProcedure
    .meta({
      openapi: {
        summary: "Send a test message to a Google Chat space",
        method: "POST",
        path: "/workspaces/{workspacePublicId}/google-chat-spaces/{spacePublicId}/test",
        description: "Posts a test message to check the space's webhook works",
        tags: ["Google Chat"],
        protect: true,
      },
    })
    .input(
      z.object({
        workspacePublicId: z.string().min(12),
        spacePublicId: z.string().min(12),
      }),
    )
    .output(z.object({ success: z.boolean(), error: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const { workspace } = await getManagedWorkspace(
        ctx.db,
        ctx.user?.id,
        input.workspacePublicId,
      );

      const space = await getSpaceInWorkspace(
        ctx.db,
        input.spacePublicId,
        workspace.id,
      );

      try {
        await postChatMessage(
          decryptToken(space.webhookUrl),
          `👋 Kan is connected. Card updates from ${
            workspace.name
          } will be posted here.`,
        );
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
});
