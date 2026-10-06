import { TRPCError } from "@trpc/server";
import { z } from "zod";

import * as boardRepo from "@kan/db/repository/board.repo";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as activityRepo from "@kan/db/repository/cardActivity.repo";
import * as listRepo from "@kan/db/repository/list.repo";

import { listCreateResponseSchema, listUpdateResponseSchema } from "../schemas";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { duplicateCard } from "../utils/duplicateCard";
import { enqueueGoogleListSync } from "../utils/integrationJobs";
import {
  assertCanDelete,
  assertCanEdit,
  assertPermission,
} from "../utils/permissions";

export const listRouter = createTRPCRouter({
  create: protectedProcedure
    .meta({
      openapi: {
        summary: "Create a list",
        method: "POST",
        path: "/lists",
        description: "Creates a new list for a given board",
        tags: ["Lists"],
        protect: true,
      },
    })
    .input(
      z.object({
        name: z.string().min(1),
        boardPublicId: z.string().min(12),
      }),
    )
    .output(listCreateResponseSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user?.id;

      if (!userId)
        throw new TRPCError({
          message: `User not authenticated`,
          code: "UNAUTHORIZED",
        });

      const board = await boardRepo.getWorkspaceAndBoardIdByBoardPublicId(
        ctx.db,
        input.boardPublicId,
      );

      if (!board)
        throw new TRPCError({
          message: `Board with public ID ${input.boardPublicId} not found`,
          code: "NOT_FOUND",
        });

      await assertPermission(ctx.db, userId, board.workspaceId, "list:create");

      const result = await listRepo.create(ctx.db, {
        name: input.name,
        createdBy: userId,
        boardId: board.id,
      });

      if (!result)
        throw new TRPCError({
          message: `Failed to create list`,
          code: "INTERNAL_SERVER_ERROR",
        });

      return result;
    }),
  delete: protectedProcedure
    .meta({
      openapi: {
        summary: "Delete a list",
        method: "DELETE",
        path: "/lists/{listPublicId}",
        description: "Deletes a list by its public ID",
        tags: ["Lists"],
        protect: true,
      },
    })
    .input(
      z.object({
        listPublicId: z.string().min(12),
      }),
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user?.id;

      if (!userId)
        throw new TRPCError({
          message: `User not authenticated`,
          code: "UNAUTHORIZED",
        });

      const list = await listRepo.getWorkspaceAndListIdByListPublicId(
        ctx.db,
        input.listPublicId,
      );

      if (!list)
        throw new TRPCError({
          message: `List with public ID ${input.listPublicId} not found`,
          code: "NOT_FOUND",
        });

      await assertCanDelete(
        ctx.db,
        userId,
        list.workspaceId,
        "list:delete",
        list.createdBy,
      );

      const deletedAt = new Date();

      const deletedList = await listRepo.softDeleteById(ctx.db, {
        listId: list.id,
        deletedAt,
        deletedBy: userId,
      });

      if (!deletedList)
        throw new TRPCError({
          message: `Failed to delete list`,
          code: "INTERNAL_SERVER_ERROR",
        });

      const deletedCards = await cardRepo.softDeleteAllByListIds(ctx.db, {
        listIds: [list.id],
        deletedAt,
        deletedBy: userId,
      });

      if (!Array.isArray(deletedCards))
        throw new TRPCError({
          message: `Failed to delete cards`,
          code: "INTERNAL_SERVER_ERROR",
        });

      const activities = deletedCards.map((card) => ({
        type: "card.archived" as const,
        createdBy: userId,
        cardId: card.id,
      }));

      if (activities.length) await activityRepo.bulkCreate(ctx.db, activities);

      void enqueueGoogleListSync(ctx.db, [list.id]);

      return { success: true };
    }),
  update: protectedProcedure
    .meta({
      openapi: {
        summary: "Update a list",
        method: "PUT",
        path: "/lists/{listPublicId}",
        description: "Updates a list by its public ID",
        tags: ["Lists"],
        protect: true,
      },
    })
    .input(
      z.object({
        listPublicId: z.string().min(12),
        name: z.string().min(1).optional(),
        index: z.number().optional(),
      }),
    )
    .output(listUpdateResponseSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user?.id;

      if (!userId)
        throw new TRPCError({
          message: `User not authenticated`,
          code: "UNAUTHORIZED",
        });

      const list = await listRepo.getWorkspaceAndListIdByListPublicId(
        ctx.db,
        input.listPublicId,
      );

      if (!list)
        throw new TRPCError({
          message: `List with public ID ${input.listPublicId} not found`,
          code: "NOT_FOUND",
        });

      await assertCanEdit(
        ctx.db,
        userId,
        list.workspaceId,
        "list:edit",
        list.createdBy,
      );

      let result: { name: string; publicId: string } | undefined;

      if (input.name) {
        result = await listRepo.update(
          ctx.db,
          { name: input.name },
          { listPublicId: input.listPublicId },
        );
      }

      if (input.index !== undefined) {
        result = await listRepo.reorder(ctx.db, {
          listPublicId: input.listPublicId,
          newIndex: input.index,
        });
      }

      if (!result)
        throw new TRPCError({
          message: `Failed to update list`,
          code: "INTERNAL_SERVER_ERROR",
        });

      return result;
    }),
  archive: protectedProcedure
    .meta({
      openapi: {
        summary: "Archive a list",
        method: "POST",
        path: "/lists/{listPublicId}/archive",
        description:
          "Archives a list. It is hidden from the board with its cards and can be restored",
        tags: ["Lists"],
        protect: true,
      },
    })
    .input(z.object({ listPublicId: z.string().min(12) }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user?.id;

      if (!userId)
        throw new TRPCError({
          message: `User not authenticated`,
          code: "UNAUTHORIZED",
        });

      const list = await listRepo.getWorkspaceAndListIdByListPublicId(
        ctx.db,
        input.listPublicId,
      );

      if (!list)
        throw new TRPCError({
          message: `List with public ID ${input.listPublicId} not found`,
          code: "NOT_FOUND",
        });

      await assertCanEdit(
        ctx.db,
        userId,
        list.workspaceId,
        "list:edit",
        list.createdBy,
      );

      await listRepo.softDeleteById(ctx.db, {
        listId: list.id,
        deletedAt: new Date(),
        deletedBy: userId,
        archive: true,
      });

      void enqueueGoogleListSync(ctx.db, [list.id]);

      return { success: true };
    }),
  restore: protectedProcedure
    .meta({
      openapi: {
        summary: "Restore an archived list",
        method: "POST",
        path: "/lists/{listPublicId}/restore",
        description: "Restores an archived list as the last list on its board",
        tags: ["Lists"],
        protect: true,
      },
    })
    .input(z.object({ listPublicId: z.string().min(12) }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user?.id;

      if (!userId)
        throw new TRPCError({
          message: `User not authenticated`,
          code: "UNAUTHORIZED",
        });

      const list = await listRepo.getWorkspaceAndListIdByListPublicId(
        ctx.db,
        input.listPublicId,
        { archived: true },
      );

      if (!list)
        throw new TRPCError({
          message: `Archived list with public ID ${input.listPublicId} not found`,
          code: "NOT_FOUND",
        });

      await assertCanEdit(
        ctx.db,
        userId,
        list.workspaceId,
        "list:edit",
        list.createdBy,
      );

      await listRepo.restore(ctx.db, list.id);

      void enqueueGoogleListSync(ctx.db, [list.id]);

      return { success: true };
    }),
  deleteArchived: protectedProcedure
    .meta({
      openapi: {
        summary: "Delete an archived list",
        method: "DELETE",
        path: "/lists/{listPublicId}/archive",
        description:
          "Permanently removes an archived list and its cards so they can no longer be restored",
        tags: ["Lists"],
        protect: true,
      },
    })
    .input(z.object({ listPublicId: z.string().min(12) }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user?.id;

      if (!userId)
        throw new TRPCError({
          message: `User not authenticated`,
          code: "UNAUTHORIZED",
        });

      const list = await listRepo.getWorkspaceAndListIdByListPublicId(
        ctx.db,
        input.listPublicId,
        { archived: true },
      );

      if (!list)
        throw new TRPCError({
          message: `Archived list with public ID ${input.listPublicId} not found`,
          code: "NOT_FOUND",
        });

      await assertCanDelete(
        ctx.db,
        userId,
        list.workspaceId,
        "list:delete",
        list.createdBy,
      );

      await listRepo.discardArchived(ctx.db, list.id);

      const deletedCards = await cardRepo.softDeleteAllByListIds(ctx.db, {
        listIds: [list.id],
        deletedAt: new Date(),
        deletedBy: userId,
      });

      if (deletedCards.length)
        await activityRepo.bulkCreate(
          ctx.db,
          deletedCards.map((card) => ({
            type: "card.archived" as const,
            createdBy: userId,
            cardId: card.id,
          })),
        );

      return { success: true };
    }),
  copy: protectedProcedure
    .meta({
      openapi: {
        summary: "Copy a list",
        method: "POST",
        path: "/lists/{listPublicId}/copy",
        description:
          "Creates a copy of a list and its cards directly after the original",
        tags: ["Lists"],
        protect: true,
      },
    })
    .input(
      z.object({
        listPublicId: z.string().min(12),
        name: z.string().min(1).max(255),
      }),
    )
    .output(listCreateResponseSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user?.id;

      if (!userId)
        throw new TRPCError({
          message: `User not authenticated`,
          code: "UNAUTHORIZED",
        });

      const list = await listRepo.getWorkspaceAndListIdByListPublicId(
        ctx.db,
        input.listPublicId,
      );

      if (!list)
        throw new TRPCError({
          message: `List with public ID ${input.listPublicId} not found`,
          code: "NOT_FOUND",
        });

      await assertPermission(ctx.db, userId, list.workspaceId, "list:create");
      await assertPermission(ctx.db, userId, list.workspaceId, "card:create");

      const newList = await listRepo.createAt(ctx.db, {
        name: input.name,
        boardId: list.boardId,
        index: list.index + 1,
        createdBy: userId,
      });

      const cardIds = await listRepo.getOpenCardIds(ctx.db, list.id);

      for (const cardId of cardIds) {
        const sourceCard = await cardRepo.getWithListAndMembersById(
          ctx.db,
          cardId,
        );
        if (!sourceCard) continue;

        await duplicateCard({
          db: ctx.db,
          sourceCard,
          targetList: { id: newList.id, workspaceId: list.workspaceId },
          userId,
          copyLabels: true,
          copyMembers: true,
          copyChecklists: true,
        });
      }

      void enqueueGoogleListSync(ctx.db, [newList.id]);

      return { publicId: newList.publicId, name: newList.name };
    }),
  move: protectedProcedure
    .meta({
      openapi: {
        summary: "Move a list to another board",
        method: "POST",
        path: "/lists/{listPublicId}/move",
        description:
          "Moves a list and its cards to the end of another board in the same workspace",
        tags: ["Lists"],
        protect: true,
      },
    })
    .input(
      z.object({
        listPublicId: z.string().min(12),
        boardPublicId: z.string().min(12),
      }),
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user?.id;

      if (!userId)
        throw new TRPCError({
          message: `User not authenticated`,
          code: "UNAUTHORIZED",
        });

      const list = await listRepo.getWorkspaceAndListIdByListPublicId(
        ctx.db,
        input.listPublicId,
      );

      if (!list)
        throw new TRPCError({
          message: `List with public ID ${input.listPublicId} not found`,
          code: "NOT_FOUND",
        });

      const targetBoard = await boardRepo.getBoardForMove(
        ctx.db,
        input.boardPublicId,
      );

      if (
        !targetBoard ||
        targetBoard.workspaceId !== list.workspaceId ||
        targetBoard.type !== "regular"
      )
        throw new TRPCError({
          message: `Board with public ID ${input.boardPublicId} not found in this workspace`,
          code: "NOT_FOUND",
        });

      await assertCanEdit(
        ctx.db,
        userId,
        list.workspaceId,
        "list:edit",
        list.createdBy,
      );

      await listRepo.moveToBoard(ctx.db, {
        listId: list.id,
        targetBoardId: targetBoard.id,
        userId,
      });

      void enqueueGoogleListSync(ctx.db, [list.id]);

      return { success: true };
    }),
});
