import { TRPCError } from "@trpc/server";
import { z } from "zod";

import * as cardRepo from "@kan/db/repository/card.repo";
import * as cardActivityRepo from "@kan/db/repository/cardActivity.repo";
import * as checklistRepo from "@kan/db/repository/checklist.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";
import { dueReminderOptions } from "@kan/shared/constants";
import { stripHtml } from "@kan/shared/utils";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { enqueueGoogleCardSync } from "../utils/integrationJobs";
import { notifyCardAudience } from "../utils/notifications";
import { assertPermission } from "../utils/permissions";

const checklistSchema = z.object({
  publicId: z.string().length(12),
  name: z.string().min(1).max(255),
});

const checklistItemSchema = z.object({
  publicId: z.string().length(12),
  title: z.string().min(1).max(500),
  completed: z.boolean(),
  startDate: z.date().nullable(),
  startDateHasTime: z.boolean(),
  dueDate: z.date().nullable(),
  dueDateHasTime: z.boolean(),
  dueReminderMinutes: z.number().nullable(),
});

const sameDate = (a: Date | null, b: Date | null) =>
  (a?.getTime() ?? null) === (b?.getTime() ?? null);

export const checklistRouter = createTRPCRouter({
  create: protectedProcedure
    .meta({
      openapi: {
        summary: "Add a checklist to a card",
        method: "POST",
        path: "/cards/{cardPublicId}/checklists",
        description: "Adds a checklist to a card",
        tags: ["Cards"],
        protect: true,
      },
    })
    .input(
      z.object({
        cardPublicId: z.string().length(12),
        name: z.string().min(1).max(255),
      }),
    )
    .output(checklistSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user?.id;

      if (!userId)
        throw new TRPCError({
          message: `User not authenticated`,
          code: "UNAUTHORIZED",
        });

      const card = await cardRepo.getWorkspaceAndCardIdByCardPublicId(
        ctx.db,
        input.cardPublicId,
      );

      if (!card)
        throw new TRPCError({
          message: `Card with public ID ${input.cardPublicId} not found`,
          code: "NOT_FOUND",
        });
      await assertPermission(ctx.db, userId, card.workspaceId, "card:edit");

      const newChecklist = await checklistRepo.create(ctx.db, {
        name: input.name,
        createdBy: userId,
        cardId: card.id,
      });

      if (!newChecklist?.id)
        throw new TRPCError({
          message: `Failed to create checklist`,
          code: "INTERNAL_SERVER_ERROR",
        });

      await cardActivityRepo.create(ctx.db, {
        type: "card.updated.checklist.added",
        cardId: card.id,
        toTitle: newChecklist.name,
        createdBy: userId,
      });

      return newChecklist;
    }),
  update: protectedProcedure
    .meta({
      openapi: {
        summary: "Update a checklist",
        method: "PUT",
        path: "/checklists/{checklistPublicId}",
        description: "Updates a checklist by its public ID",
        tags: ["Cards"],
        protect: true,
      },
    })
    .input(
      z.object({
        checklistPublicId: z.string().length(12),
        name: z.string().min(1).max(255),
      }),
    )
    .output(z.object({ publicId: z.string().length(12), name: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user?.id;
      if (!userId)
        throw new TRPCError({
          message: `User not authenticated`,
          code: "UNAUTHORIZED",
        });

      const checklist = await checklistRepo.getChecklistByPublicId(
        ctx.db,
        input.checklistPublicId,
      );
      if (!checklist)
        throw new TRPCError({
          message: `Checklist with public ID ${input.checklistPublicId} not found`,
          code: "NOT_FOUND",
        });
      await assertPermission(
        ctx.db,
        userId,
        checklist.card.list.board.workspace.id,
        "card:edit",
      );

      const previousName = checklist.name;

      const updated = await checklistRepo.updateChecklistById(ctx.db, {
        id: checklist.id,
        name: input.name,
      });

      if (!updated)
        throw new TRPCError({
          message: `Failed to update checklist`,
          code: "INTERNAL_SERVER_ERROR",
        });

      await cardActivityRepo.create(ctx.db, {
        type: "card.updated.checklist.renamed",
        cardId: checklist.cardId,
        fromTitle: previousName,
        toTitle: updated.name,
        createdBy: userId,
      });

      return updated;
    }),
  delete: protectedProcedure
    .meta({
      openapi: {
        summary: "Delete a checklist",
        method: "DELETE",
        path: "/checklists/{checklistPublicId}",
        description: "Deletes a checklist by its public ID",
        tags: ["Cards"],
        protect: true,
      },
    })
    .input(z.object({ checklistPublicId: z.string().length(12) }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user?.id;
      if (!userId)
        throw new TRPCError({
          message: `User not authenticated`,
          code: "UNAUTHORIZED",
        });

      const checklist = await checklistRepo.getChecklistByPublicId(
        ctx.db,
        input.checklistPublicId,
      );
      if (!checklist)
        throw new TRPCError({
          message: `Checklist with public ID ${input.checklistPublicId} not found`,
          code: "NOT_FOUND",
        });
      await assertPermission(
        ctx.db,
        userId,
        checklist.card.list.board.workspace.id,
        "card:edit",
      );

      await checklistRepo.softDeleteAllItemsByChecklistId(ctx.db, {
        checklistId: checklist.id,
        deletedAt: new Date(),
        deletedBy: userId,
      });

      const deleted = await checklistRepo.softDeleteById(ctx.db, {
        id: checklist.id,
        deletedAt: new Date(),
        deletedBy: userId,
      });

      if (!deleted)
        throw new TRPCError({
          message: `Failed to delete checklist`,
          code: "INTERNAL_SERVER_ERROR",
        });

      await cardActivityRepo.create(ctx.db, {
        type: "card.updated.checklist.deleted",
        cardId: checklist.cardId,
        fromTitle: checklist.name,
        createdBy: userId,
      });

      // Removes the deleted items' Google Calendar events and tasks
      void enqueueGoogleCardSync(ctx.db, [checklist.cardId]);

      return { success: true };
    }),
  createItem: protectedProcedure
    .meta({
      openapi: {
        summary: "Add an item to a checklist",
        method: "POST",
        path: "/checklists/{checklistPublicId}/items",
        description: "Adds an item to a checklist",
        tags: ["Cards"],
        protect: true,
      },
    })
    .input(
      z.object({
        checklistPublicId: z.string().length(12),
        title: z.string().min(1).max(500).transform(stripHtml),
      }),
    )
    .output(checklistItemSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user?.id;

      if (!userId)
        throw new TRPCError({
          message: `User not authenticated`,
          code: "UNAUTHORIZED",
        });

      const checklist = await checklistRepo.getChecklistByPublicId(
        ctx.db,
        input.checklistPublicId,
      );

      if (!checklist)
        throw new TRPCError({
          message: `Checklist with public ID ${input.checklistPublicId} not found`,
          code: "NOT_FOUND",
        });
      await assertPermission(
        ctx.db,
        userId,
        checklist.card.list.board.workspace.id,
        "card:edit",
      );

      const newChecklistItem = await checklistRepo.createItem(ctx.db, {
        title: input.title,
        createdBy: userId,
        checklistId: checklist.id,
      });

      if (!newChecklistItem?.id)
        throw new TRPCError({
          message: `Failed to create checklist item`,
          code: "INTERNAL_SERVER_ERROR",
        });

      await cardActivityRepo.create(ctx.db, {
        type: "card.updated.checklist.item.added",
        cardId: checklist.cardId,
        toTitle: newChecklistItem.title,
        createdBy: userId,
      });

      return newChecklistItem;
    }),
  updateItem: protectedProcedure
    .meta({
      openapi: {
        summary: "Update a checklist item",
        method: "PATCH",
        path: "/checklists/items/{checklistItemPublicId}",
        description:
          "Updates a checklist item: its title, completion, position, or its start date, due date and reminder as a sub-task",
        tags: ["Cards"],
        protect: true,
      },
    })
    .input(
      z.object({
        checklistItemPublicId: z.string().length(12),
        title: z.string().min(1).max(500).transform(stripHtml).optional(),
        completed: z.boolean().optional(),
        index: z.number().int().min(0).optional(),
        startDate: z.date().nullable().optional(),
        // Whether startDate carries a time of day; false means a whole day
        startDateHasTime: z.boolean().optional(),
        dueDate: z.date().nullable().optional(),
        dueDateHasTime: z.boolean().optional(),
        dueReminderMinutes: z
          .number()
          .int()
          .refine((value) =>
            (dueReminderOptions as readonly number[]).includes(value),
          )
          .nullable()
          .optional(),
      }),
    )
    .output(checklistItemSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user?.id;

      if (!userId)
        throw new TRPCError({
          message: `User not authenticated`,
          code: "UNAUTHORIZED",
        });

      const scheduleChanged =
        input.startDate !== undefined ||
        input.startDateHasTime !== undefined ||
        input.dueDate !== undefined ||
        input.dueDateHasTime !== undefined ||
        input.dueReminderMinutes !== undefined;

      if (
        input.title === undefined &&
        input.completed === undefined &&
        input.index === undefined &&
        !scheduleChanged
      )
        throw new TRPCError({
          message: `Nothing to update: provide a title, completion, index, dates or reminder`,
          code: "BAD_REQUEST",
        });

      const item = await checklistRepo.getChecklistItemByPublicIdWithChecklist(
        ctx.db,
        input.checklistItemPublicId,
      );

      if (!item)
        throw new TRPCError({
          message: `Checklist item with public ID ${input.checklistItemPublicId} not found`,
          code: "NOT_FOUND",
        });
      await assertPermission(
        ctx.db,
        userId,
        item.checklist.card.list.board.workspace.id,
        "card:edit",
      );

      const previousTitle = item.title;

      let updatedItem;

      if (
        input.title !== undefined ||
        input.completed !== undefined ||
        scheduleChanged
      ) {
        updatedItem = await checklistRepo.updateItemById(ctx.db, {
          id: item.id,
          title: input.title,
          completed: input.completed,
          startDate: input.startDate,
          // Clearing a date also clears its time
          startDateHasTime:
            input.startDate === null ? false : input.startDateHasTime,
          dueDate: input.dueDate,
          dueDateHasTime: input.dueDate === null ? false : input.dueDateHasTime,
          dueReminderMinutes: input.dueReminderMinutes,
        });
      }

      if (input.index !== undefined) {
        updatedItem = await checklistRepo.reorderItem(ctx.db, {
          itemId: item.id,
          newIndex: input.index,
        });
      }

      if (!updatedItem) {
        throw new TRPCError({
          message: `Failed to update checklist item`,
          code: "INTERNAL_SERVER_ERROR",
        });
      }

      // Log completion toggle
      if (input.completed !== undefined) {
        await cardActivityRepo.create(ctx.db, {
          type: input.completed
            ? "card.updated.checklist.item.completed"
            : "card.updated.checklist.item.uncompleted",
          cardId: item.checklist.cardId,
          toTitle: updatedItem.title,
          createdBy: userId,
        });
      }

      // Log title change
      if (input.title !== undefined && input.title !== previousTitle) {
        await cardActivityRepo.create(ctx.db, {
          type: "card.updated.checklist.item.updated",
          cardId: item.checklist.cardId,
          fromTitle: previousTitle,
          toTitle: updatedItem.title,
          createdBy: userId,
        });
      }

      const dueDateChanged =
        !sameDate(item.dueDate, updatedItem.dueDate) ||
        item.dueDateHasTime !== updatedItem.dueDateHasTime;
      const startDateChanged =
        !sameDate(item.startDate, updatedItem.startDate) ||
        item.startDateHasTime !== updatedItem.startDateHasTime;

      if (dueDateChanged) {
        await cardActivityRepo.create(ctx.db, {
          type: "card.updated.checklist.item.dueDate.updated",
          cardId: item.checklist.cardId,
          toTitle: updatedItem.title,
          fromDueDate: item.dueDate ?? undefined,
          toDueDate: updatedItem.dueDate ?? undefined,
          createdBy: userId,
        });
      }

      // Keep the item's Google Calendar event and task up to date
      const shownInGoogle = !!item.dueDate || !!updatedItem.dueDate;
      if (
        shownInGoogle &&
        (dueDateChanged ||
          startDateChanged ||
          item.dueReminderMinutes !== updatedItem.dueReminderMinutes ||
          item.completed !== updatedItem.completed ||
          item.title !== updatedItem.title)
      ) {
        void enqueueGoogleCardSync(ctx.db, [item.checklist.cardId]);
      }

      return updatedItem;
    }),
  deleteItem: protectedProcedure
    .meta({
      openapi: {
        summary: "Delete a checklist item",
        method: "DELETE",
        path: "/checklists/items/{checklistItemPublicId}",
        description: "Deletes a checklist item",
        tags: ["Cards"],
        protect: true,
      },
    })
    .input(z.object({ checklistItemPublicId: z.string().length(12) }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user?.id;
      if (!userId)
        throw new TRPCError({
          message: `User not authenticated`,
          code: "UNAUTHORIZED",
        });

      const item = await checklistRepo.getChecklistItemByPublicIdWithChecklist(
        ctx.db,
        input.checklistItemPublicId,
      );
      if (!item)
        throw new TRPCError({
          message: `Checklist item with public ID ${input.checklistItemPublicId} not found`,
          code: "NOT_FOUND",
        });
      await assertPermission(
        ctx.db,
        userId,
        item.checklist.card.list.board.workspace.id,
        "card:edit",
      );

      const deleted = await checklistRepo.softDeleteItemById(ctx.db, {
        id: item.id,
        deletedAt: new Date(),
        deletedBy: userId,
      });

      if (!deleted)
        throw new TRPCError({
          message: `Failed to delete item`,
          code: "INTERNAL_SERVER_ERROR",
        });

      await cardActivityRepo.create(ctx.db, {
        type: "card.updated.checklist.item.deleted",
        cardId: item.checklist.cardId,
        fromTitle: item.title,
        createdBy: userId,
      });

      if (item.dueDate) {
        void enqueueGoogleCardSync(ctx.db, [item.checklist.cardId]);
      }

      return { success: true };
    }),
  addOrRemoveItemMember: protectedProcedure
    .meta({
      openapi: {
        summary: "Assign or unassign a checklist item",
        method: "PUT",
        path: "/checklists/items/{checklistItemPublicId}/members/{workspaceMemberPublicId}",
        description:
          "Assigns a board member to a checklist item (sub-task), or removes them if already assigned",
        tags: ["Cards"],
        protect: true,
      },
    })
    .input(
      z.object({
        checklistItemPublicId: z.string().length(12),
        workspaceMemberPublicId: z.string().min(12),
      }),
    )
    .output(z.object({ newMember: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user?.id;
      if (!userId)
        throw new TRPCError({
          message: `User not authenticated`,
          code: "UNAUTHORIZED",
        });

      const item = await checklistRepo.getChecklistItemByPublicIdWithChecklist(
        ctx.db,
        input.checklistItemPublicId,
      );
      if (!item || item.checklist.deletedAt)
        throw new TRPCError({
          message: `Checklist item with public ID ${input.checklistItemPublicId} not found`,
          code: "NOT_FOUND",
        });

      const workspaceId = item.checklist.card.list.board.workspace.id;
      await assertPermission(ctx.db, userId, workspaceId, "card:edit");

      const member = await workspaceRepo.getMemberByPublicId(
        ctx.db,
        input.workspaceMemberPublicId,
        workspaceId,
      );
      if (!member)
        throw new TRPCError({
          message: `Member with public ID ${input.workspaceMemberPublicId} not found`,
          code: "NOT_FOUND",
        });

      const ids = { checklistItemId: item.id, workspaceMemberId: member.id };
      const cardId = item.checklist.cardId;
      const existing = await checklistRepo.getItemMember(ctx.db, ids);

      if (existing) {
        await checklistRepo.removeItemMember(ctx.db, ids);
        await cardActivityRepo.create(ctx.db, {
          type: "card.updated.checklist.item.member.removed",
          cardId,
          toTitle: item.title,
          workspaceMemberId: member.id,
          createdBy: userId,
        });
        if (item.dueDate) void enqueueGoogleCardSync(ctx.db, [cardId]);
        return { newMember: false };
      }

      await checklistRepo.addItemMember(ctx.db, ids);
      await cardActivityRepo.create(ctx.db, {
        type: "card.updated.checklist.item.member.added",
        cardId,
        toTitle: item.title,
        workspaceMemberId: member.id,
        createdBy: userId,
      });

      if (member.userId) {
        void notifyCardAudience({
          db: ctx.db,
          cardId,
          workspaceId,
          actorUserId: userId,
          type: "checklist.item.assigned",
          metadata: {
            boardName: item.checklist.card.list.board.name,
            itemTitle: item.title,
            dueDate: item.dueDate?.toISOString() ?? null,
            dueDateHasTime: item.dueDateHasTime,
          },
          onlyUserIds: [member.userId],
        });
      }
      if (item.dueDate) void enqueueGoogleCardSync(ctx.db, [cardId]);

      return { newMember: true };
    }),
});
