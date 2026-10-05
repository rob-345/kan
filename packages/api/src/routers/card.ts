import { TRPCError } from "@trpc/server";
import { z } from "zod";

import * as boardRepo from "@kan/db/repository/board.repo";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as cardActivityRepo from "@kan/db/repository/cardActivity.repo";
import * as cardAttachmentRepo from "@kan/db/repository/cardAttachment.repo";
import * as cardCommentRepo from "@kan/db/repository/cardComment.repo";
import * as labelRepo from "@kan/db/repository/label.repo";
import * as listRepo from "@kan/db/repository/list.repo";
import * as watcherRepo from "@kan/db/repository/watcher.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";
import { cardCoverColours, dueReminderOptions } from "@kan/shared/constants";
import {
  generateAttachmentUrl,
  normalizeDescription,
} from "@kan/shared/utils";

import {
  activityItemSchema,
  archivedItemsSchema,
  cardCreateResponseSchema,
  cardDetailSchema,
  cardUpdateResponseSchema,
  commentDeleteResponseSchema,
  commentResponseSchema,
} from "../schemas";
import { createTRPCRouter, protectedProcedure, publicProcedure } from "../trpc";
import { mergeActivities } from "../utils/activities";
import { createAvatarUrlResolver } from "../utils/avatarUrls";
import { duplicateCard } from "../utils/duplicateCard";
import { notifyCardAudience, sendMentionEmails } from "../utils/notifications";
import {
  assertCanDelete,
  assertCanEdit,
  assertPermission,
} from "../utils/permissions";
import {
  createCardWebhookPayload,
  sendWebhooksForWorkspace,
} from "../utils/webhook";

export const cardRouter = createTRPCRouter({
  create: protectedProcedure
    .meta({
      openapi: {
        summary: "Create a card",
        method: "POST",
        path: "/cards",
        description: "Creates a new card for a given list",
        tags: ["Cards"],
        protect: true,
      },
    })
    .input(
      z.object({
        title: z.string().min(1).max(2000),
        description: z.string().max(10000),
        listPublicId: z.string().min(12),
        labelPublicIds: z.array(z.string().min(12)),
        memberPublicIds: z.array(z.string().min(12)),
        position: z.enum(["start", "end"]),
        dueDate: z.date().nullable().optional(),
      }),
    )
    .output(cardCreateResponseSchema)
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

      await assertPermission(ctx.db, userId, list.workspaceId, "card:create");

      const members = input.memberPublicIds.length
        ? await workspaceRepo.getAllMembersByPublicIds(
            ctx.db,
            input.memberPublicIds,
            list.workspaceId,
          )
        : [];

      if (members.length !== new Set(input.memberPublicIds).size)
        throw new TRPCError({
          message: `Members with public IDs (${input.memberPublicIds.join(", ")}) not found`,
          code: "NOT_FOUND",
        });

      const newCard = await cardRepo.create(ctx.db, {
        title: input.title,
        description: normalizeDescription(input.description),
        createdBy: userId,
        listId: list.id,
        workspaceId: list.workspaceId,
        position: input.position,
        dueDate: input.dueDate ?? null,
      });

      const newCardId = newCard.id;

      if (!newCardId)
        throw new TRPCError({
          message: `Failed to create card`,
          code: "INTERNAL_SERVER_ERROR",
        });

      if (newCardId && input.labelPublicIds.length) {
        const labels = await labelRepo.getAllByPublicIds(
          ctx.db,
          input.labelPublicIds,
        );

        if (!labels.length)
          throw new TRPCError({
            message: `Labels with public IDs (${input.labelPublicIds.join(", ")}) not found`,
            code: "NOT_FOUND",
          });

        const labelsInsert = labels.map((label) => ({
          cardId: newCardId,
          labelId: label.id,
        }));

        const cardLabels = await cardRepo.bulkCreateCardLabelRelationships(
          ctx.db,
          labelsInsert,
        );

        if (!cardLabels.length)
          throw new TRPCError({
            message: `Failed to create card label relationships`,
            code: "INTERNAL_SERVER_ERROR",
          });

        const cardActivitesInsert = cardLabels.map((cardLabel) => ({
          type: "card.updated.label.added" as const,
          cardId: cardLabel.cardId,
          labelId: cardLabel.labelId,
          createdBy: userId,
        }));

        await cardActivityRepo.bulkCreate(ctx.db, cardActivitesInsert);
      }

      if (newCardId && members.length) {
        const membersInsert = members.map((member) => ({
          cardId: newCardId,
          workspaceMemberId: member.id,
        }));

        const cardMembers =
          await cardRepo.bulkCreateCardWorkspaceMemberRelationships(
            ctx.db,
            membersInsert,
          );

        if (!cardMembers.length)
          throw new TRPCError({
            message: `Failed to create card member relationships`,
            code: "INTERNAL_SERVER_ERROR",
          });

        const cardActivitesInsert = cardMembers.map((cardMember) => ({
          type: "card.updated.member.added" as const,
          cardId: cardMember.cardId,
          workspaceMemberId: cardMember.workspaceMemberId,
          createdBy: userId,
        }));

        await cardActivityRepo.bulkCreate(ctx.db, cardActivitesInsert);
      }

      if (input.description) {
        void sendMentionEmails({
          db: ctx.db,
          cardPublicId: newCard.publicId,
          previousHtml: null,
          nextHtml: input.description,
          commenterUserId: userId,
        });
      }

      // Fire webhooks (non-blocking)
      sendWebhooksForWorkspace(
        ctx.db,
        list.workspaceId,
        createCardWebhookPayload(
          "card.created",
          {
            id: String(newCard.id),
            publicId: newCard.publicId,
            title: input.title,
            description: input.description,
            dueDate: input.dueDate ?? null,
            listId: list.publicId,
          },
          {
            boardId: list.boardPublicId,
            boardName: list.boardName,
            listName: list.name,
            user: ctx.user
              ? { id: ctx.user.id, name: ctx.user.name }
              : undefined,
          },
        ),
      ).catch((error) => {
        console.error("Webhook delivery failed:", error);
      });

      return newCard;
    }),
  addComment: protectedProcedure
    .meta({
      openapi: {
        summary: "Add a comment to a card",
        method: "POST",
        path: "/cards/{cardPublicId}/comments",
        description: "Adds a comment to a card",
        tags: ["Cards"],
        protect: true,
      },
    })
    .input(
      z.object({
        cardPublicId: z.string().min(12),
        comment: z.string().min(1),
      }),
    )
    .output(commentResponseSchema)
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

      await assertPermission(
        ctx.db,
        userId,
        card.workspaceId,
        "comment:create",
      );

      const newComment = await cardCommentRepo.create(ctx.db, {
        comment: input.comment,
        createdBy: userId,
        cardId: card.id,
      });

      if (!newComment?.id)
        throw new TRPCError({
          message: `Failed to create comment`,
          code: "INTERNAL_SERVER_ERROR",
        });

      await cardActivityRepo.create(ctx.db, {
        type: "card.updated.comment.added" as const,
        cardId: card.id,
        commentId: newComment.id,
        toComment: newComment.comment,
        createdBy: userId,
      });

      void sendMentionEmails({
        db: ctx.db,
        cardPublicId: input.cardPublicId,
        previousHtml: null,
        nextHtml: input.comment,
        commenterUserId: userId,
        commentId: newComment.id,
      });

      void notifyCardAudience({
        db: ctx.db,
        cardId: card.id,
        workspaceId: card.workspaceId,
        actorUserId: userId,
        type: "card.comment.added",
        commentId: newComment.id,
        metadata: { boardName: card.boardName },
      });

      return newComment;
    }),
  updateComment: protectedProcedure
    .meta({
      openapi: {
        summary: "Update a comment",
        method: "PUT",
        path: "/cards/{cardPublicId}/comments/{commentPublicId}",
        description: "Updates a comment",
        tags: ["Cards"],
        protect: true,
      },
    })
    .input(
      z.object({
        cardPublicId: z.string().min(12),
        commentPublicId: z.string().min(12),
        comment: z.string().min(1),
      }),
    )
    .output(commentResponseSchema)
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

      const existingComment = await cardCommentRepo.getByPublicId(
        ctx.db,
        input.commentPublicId,
      );

      if (!existingComment || existingComment.cardId !== card.id)
        throw new TRPCError({
          message: `Comment with public ID ${input.commentPublicId} not found`,
          code: "NOT_FOUND",
        });

      await assertCanEdit(
        ctx.db,
        userId,
        card.workspaceId,
        "comment:edit",
        existingComment.createdBy,
      );

      const updatedComment = await cardCommentRepo.update(ctx.db, {
        id: existingComment.id,
        comment: input.comment,
      });

      if (!updatedComment?.id)
        throw new TRPCError({
          message: `Failed to update comment`,
          code: "INTERNAL_SERVER_ERROR",
        });

      await cardActivityRepo.create(ctx.db, {
        type: "card.updated.comment.updated" as const,
        cardId: card.id,
        commentId: updatedComment.id,
        fromComment: existingComment.comment,
        toComment: updatedComment.comment,
        createdBy: userId,
      });

      void sendMentionEmails({
        db: ctx.db,
        cardPublicId: input.cardPublicId,
        previousHtml: existingComment.comment,
        nextHtml: input.comment,
        commenterUserId: userId,
        commentId: updatedComment.id,
      });

      return updatedComment;
    }),
  deleteComment: protectedProcedure
    .meta({
      openapi: {
        summary: "Delete a comment",
        method: "DELETE",
        path: "/cards/{cardPublicId}/comments/{commentPublicId}",
        description: "Deletes a comment",
        tags: ["Cards"],
      },
    })
    .input(
      z.object({
        cardPublicId: z.string().min(12),
        commentPublicId: z.string().min(12),
      }),
    )
    .output(commentDeleteResponseSchema)
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

      const existingComment = await cardCommentRepo.getByPublicId(
        ctx.db,
        input.commentPublicId,
      );

      if (!existingComment || existingComment.cardId !== card.id)
        throw new TRPCError({
          message: `Comment with public ID ${input.commentPublicId} not found`,
          code: "NOT_FOUND",
        });

      await assertCanDelete(
        ctx.db,
        userId,
        card.workspaceId,
        "comment:delete",
        existingComment.createdBy,
      );

      const deletedComment = await cardCommentRepo.softDelete(ctx.db, {
        commentId: existingComment.id,
        deletedAt: new Date(),
        deletedBy: userId,
      });

      if (!deletedComment)
        throw new TRPCError({
          message: `Failed to delete comment`,
          code: "INTERNAL_SERVER_ERROR",
        });

      await cardActivityRepo.create(ctx.db, {
        type: "card.updated.comment.deleted" as const,
        cardId: card.id,
        commentId: existingComment.id,
        createdBy: userId,
      });

      return { publicId: input.commentPublicId };
    }),
  addOrRemoveLabel: protectedProcedure
    .meta({
      openapi: {
        summary: "Add or remove a label from a card",
        method: "PUT",
        path: "/cards/{cardPublicId}/labels/{labelPublicId}",
        description: "Adds or removes a label from a card",
        tags: ["Cards"],
        protect: true,
      },
    })
    .input(
      z.object({
        cardPublicId: z.string().min(12),
        labelPublicId: z.string().min(12),
      }),
    )
    .output(z.object({ newLabel: z.boolean() }))
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

      const label = await labelRepo.getByPublicId(ctx.db, input.labelPublicId);

      if (!label)
        throw new TRPCError({
          message: `Label with public ID ${input.labelPublicId} not found`,
          code: "NOT_FOUND",
        });

      const cardLabelIds = { cardId: card.id, labelId: label.id };

      const existingLabel = await cardRepo.getCardLabelRelationship(
        ctx.db,
        cardLabelIds,
      );

      if (existingLabel) {
        const deletedCardLabelRelationship =
          await cardRepo.hardDeleteCardLabelRelationship(ctx.db, cardLabelIds);

        if (!deletedCardLabelRelationship)
          throw new TRPCError({
            message: `Failed to remove label from card`,
            code: "INTERNAL_SERVER_ERROR",
          });

        await cardActivityRepo.create(ctx.db, {
          type: "card.updated.label.removed" as const,
          cardId: card.id,
          labelId: label.id,
          createdBy: userId,
        });

        return { newLabel: false };
      }

      const newCardLabelRelationship =
        await cardRepo.createCardLabelRelationship(ctx.db, cardLabelIds);

      if (!newCardLabelRelationship)
        throw new TRPCError({
          message: `Failed to add label to card`,
          code: "INTERNAL_SERVER_ERROR",
        });

      await cardActivityRepo.create(ctx.db, {
        type: "card.updated.label.added" as const,
        cardId: card.id,
        labelId: label.id,
        createdBy: userId,
      });

      return { newLabel: true };
    }),
  addOrRemoveMember: protectedProcedure
    .meta({
      openapi: {
        summary: "Add or remove a member from a card",
        method: "PUT",
        path: "/cards/{cardPublicId}/members/{workspaceMemberPublicId}",
        description: "Adds or removes a member from a card",
        tags: ["Cards"],
      },
    })
    .input(
      z.object({
        cardPublicId: z.string().min(12),
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

      const member = await workspaceRepo.getMemberByPublicId(
        ctx.db,
        input.workspaceMemberPublicId,
        card.workspaceId,
      );

      if (!member)
        throw new TRPCError({
          message: `Member with public ID ${input.workspaceMemberPublicId} not found`,
          code: "NOT_FOUND",
        });

      const cardMemberIds = { cardId: card.id, memberId: member.id };

      const existingMember = await cardRepo.getCardMemberRelationship(
        ctx.db,
        cardMemberIds,
      );

      if (existingMember) {
        const deletedCardMemberRelationship =
          await cardRepo.hardDeleteCardMemberRelationship(
            ctx.db,
            cardMemberIds,
          );

        if (!deletedCardMemberRelationship.success)
          throw new TRPCError({
            message: `Failed to remove member from card`,
            code: "INTERNAL_SERVER_ERROR",
          });

        await cardActivityRepo.create(ctx.db, {
          type: "card.updated.member.removed" as const,
          cardId: card.id,
          workspaceMemberId: member.id,
          createdBy: userId,
        });

        return { newMember: false };
      }

      const newCardMemberRelationship =
        await cardRepo.createCardMemberRelationship(ctx.db, cardMemberIds);

      if (!newCardMemberRelationship.success)
        throw new TRPCError({
          message: `Failed to add member to card`,
          code: "INTERNAL_SERVER_ERROR",
        });

      await cardActivityRepo.create(ctx.db, {
        type: "card.updated.member.added" as const,
        cardId: card.id,
        workspaceMemberId: member.id,
        createdBy: userId,
      });

      if (member.userId) {
        void notifyCardAudience({
          db: ctx.db,
          cardId: card.id,
          workspaceId: card.workspaceId,
          actorUserId: userId,
          type: "card.member.added",
          metadata: { boardName: card.boardName },
          onlyUserIds: [member.userId],
        });
      }

      return { newMember: true };
    }),
  byId: publicProcedure
    .meta({
      openapi: {
        summary: "Get a card by public ID",
        method: "GET",
        path: "/cards/{cardPublicId}",
        description: "Retrieves a card by its public ID",
        tags: ["Cards"],
      },
    })
    .input(z.object({ cardPublicId: z.string().min(12) }))
    .output(cardDetailSchema)
    .query(async ({ ctx, input }) => {
      const card = await cardRepo.getWorkspaceAndCardIdByCardPublicId(
        ctx.db,
        input.cardPublicId,
      );

      if (!card)
        throw new TRPCError({
          message: `Card with public ID ${input.cardPublicId} not found`,
          code: "NOT_FOUND",
        });

      if (card.workspaceVisibility === "private") {
        const userId = ctx.user?.id;

        if (!userId)
          throw new TRPCError({
            message: `User not authenticated`,
            code: "UNAUTHORIZED",
          });

        await assertPermission(ctx.db, userId, card.workspaceId, "card:view");
      }

      const result = await cardRepo.getWithListAndMembersByPublicId(
        ctx.db,
        input.cardPublicId,
      );

      if (!result)
        throw new TRPCError({
          message: `Card with public ID ${input.cardPublicId} not found`,
          code: "NOT_FOUND",
        });

      // Generate URLs for all attachments
      const attachmentsWithUrls = await Promise.all(
        result.attachments.map(async (attachment) => {
          const url = await generateAttachmentUrl(attachment.s3Key);
          return {
            publicId: attachment.publicId,
            contentType: attachment.contentType,
            s3Key: attachment.s3Key,
            originalFilename: attachment.originalFilename,
            size: attachment.size,
            url,
          };
        }),
      );

      // Generate presigned URLs for workspace member avatars
      const resolveAvatarUrl = createAvatarUrlResolver();
      const workspaceWithAvatarUrls = result.list.board.workspace
        ? {
            ...result.list.board.workspace,
            members: await Promise.all(
              result.list.board.workspace.members.map(async (member) => {
                if (!member.user?.image) {
                  return member;
                }

                const avatarUrl = await resolveAvatarUrl(member.user.image);
                return {
                  ...member,
                  user: {
                    ...member.user,
                    image: avatarUrl,
                  },
                };
              }),
            ),
          }
        : result.list.board.workspace;

      const isWatching = ctx.user?.id
        ? await watcherRepo.isWatchingCard(ctx.db, {
            cardId: card.id,
            userId: ctx.user.id,
          })
        : false;

      const { coverAttachment, ...cardFields } = result;

      return {
        ...cardFields,
        coverAttachmentPublicId:
          coverAttachment && !coverAttachment.deletedAt
            ? coverAttachment.publicId
            : null,
        isWatching,
        attachments: attachmentsWithUrls,
        list: {
          ...result.list,
          board: {
            ...result.list.board,
            workspace: workspaceWithAvatarUrls,
          },
        },
      };
    }),
  getActivities: publicProcedure
    .meta({
      openapi: {
        summary: "Get paginated card activities",
        method: "GET",
        path: "/cards/{cardPublicId}/activities",
        description:
          "Retrieves paginated activities for a card with merged frequent changes",
        tags: ["Cards"],
      },
    })
    .input(
      z.object({
        cardPublicId: z.string().min(12),
        limit: z.number().min(1).max(100).optional().default(10),
        cursor: z.string().datetime().optional(), // ISO datetime string
      }),
    )
    .output(
      z.object({
        activities: z.array(activityItemSchema),
        hasMore: z.boolean(),
        nextCursor: z.string().datetime().nullable(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const card = await cardRepo.getWorkspaceAndCardIdByCardPublicId(
        ctx.db,
        input.cardPublicId,
      );

      if (!card)
        throw new TRPCError({
          message: `Card with public ID ${input.cardPublicId} not found`,
          code: "NOT_FOUND",
        });

      if (card.workspaceVisibility === "private") {
        const userId = ctx.user?.id;

        if (!userId)
          throw new TRPCError({
            message: `User not authenticated`,
            code: "UNAUTHORIZED",
          });

        await assertPermission(ctx.db, userId, card.workspaceId, "card:view");
      }

      const cursor = input.cursor ? new Date(input.cursor) : undefined;
      const result = await cardActivityRepo.getPaginatedActivities(
        ctx.db,
        card.id,
        {
          limit: input.limit,
          cursor,
        },
      );

      // Generate presigned URLs for user avatars in activities
      const resolveAvatarUrl = createAvatarUrlResolver();
      const activitiesWithAvatarUrls = await Promise.all(
        result.activities.map(async (activity) => {
          const updatedActivity = { ...activity };

          // Generate presigned URL for activity user avatar
          if (activity.user?.image) {
            const userAvatarUrl = await resolveAvatarUrl(activity.user.image);
            updatedActivity.user = {
              ...activity.user,
              image: userAvatarUrl,
            };
          }

          // Generate presigned URL for member user avatar (if exists)
          if (activity.member?.user?.image) {
            const memberAvatarUrl = await resolveAvatarUrl(
              activity.member.user.image,
            );
            updatedActivity.member = {
              ...activity.member,
              user: {
                ...activity.member.user,
                image: memberAvatarUrl,
              },
            };
          }

          return updatedActivity;
        }),
      );

      const mergedActivities = mergeActivities(activitiesWithAvatarUrls);

      return {
        activities: mergedActivities,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor?.toISOString() ?? null,
      };
    }),
  update: protectedProcedure
    .meta({
      openapi: {
        summary: "Update a card",
        method: "PUT",
        path: "/cards/{cardPublicId}",
        description: "Updates a card by its public ID",
        tags: ["Cards"],
        protect: true,
      },
    })
    .input(
      z.object({
        cardPublicId: z.string().min(12),
        title: z.string().min(1).max(2000).optional(),
        description: z.string().optional(),
        index: z.number().optional(),
        listPublicId: z.string().min(12).optional(),
        dueDate: z.date().nullable().optional(),
        startDate: z.date().nullable().optional(),
        dueDateCompleted: z.boolean().optional(),
        dueReminderMinutes: z
          .number()
          .int()
          .refine((value) =>
            (dueReminderOptions as readonly number[]).includes(value),
          )
          .nullable()
          .optional(),
        coverColour: z.enum(cardCoverColours).nullable().optional(),
        coverAttachmentPublicId: z.string().min(12).nullable().optional(),
      }),
    )
    .output(cardUpdateResponseSchema)
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

      await assertCanEdit(
        ctx.db,
        userId,
        card.workspaceId,
        "card:edit",
        card.createdBy,
      );

      const existingCard = await cardRepo.getByPublicId(
        ctx.db,
        input.cardPublicId,
      );

      let newListId: number | undefined;
      let newList:
        | {
            id: number;
            publicId: string;
            name: string;
            boardId: number;
            index: number;
          }
        | undefined;

      if (input.listPublicId) {
        newList = await listRepo.getByPublicId(ctx.db, input.listPublicId);

        if (!newList)
          throw new TRPCError({
            message: `List with public ID ${input.listPublicId} not found`,
            code: "NOT_FOUND",
          });

        newListId = newList.id;
      }

      if (!existingCard) {
        throw new TRPCError({
          message: `Card with public ID ${input.cardPublicId} not found`,
          code: "NOT_FOUND",
        });
      }

      let result:
        | {
            id: number;
            title: string;
            description: string | null;
            publicId: string;
            dueDate: Date | null;
          }
        | undefined;

      const previousDueDate = existingCard.dueDate;
      const normalizedDescription =
        input.description !== undefined
          ? normalizeDescription(input.description)
          : undefined;
      const descriptionChanged =
        normalizedDescription !== undefined &&
        existingCard.description !== normalizedDescription;

      let coverAttachmentId: number | null | undefined;
      if (input.coverAttachmentPublicId !== undefined) {
        if (input.coverAttachmentPublicId === null) {
          coverAttachmentId = null;
        } else {
          const attachment = await cardAttachmentRepo.getByPublicId(
            ctx.db,
            input.coverAttachmentPublicId,
          );
          if (
            !attachment ||
            attachment.deletedAt ||
            attachment.cardId !== existingCard.id ||
            !attachment.contentType.startsWith("image/")
          )
            throw new TRPCError({
              message: `Cover must be an image attached to this card`,
              code: "BAD_REQUEST",
            });
          coverAttachmentId = attachment.id;
        }
      }

      const previousStartDate = existingCard.startDate;
      const dueDateCompletedChanged =
        input.dueDateCompleted !== undefined &&
        input.dueDateCompleted !== existingCard.dueDateCompleted;

      if (
        input.title ||
        normalizedDescription !== undefined ||
        input.dueDate !== undefined ||
        input.startDate !== undefined ||
        input.dueDateCompleted !== undefined ||
        input.dueReminderMinutes !== undefined ||
        input.coverColour !== undefined ||
        coverAttachmentId !== undefined
      ) {
        result = await cardRepo.update(
          ctx.db,
          {
            ...(input.title && { title: input.title }),
            ...(normalizedDescription !== undefined && {
              description: normalizedDescription,
            }),
            ...(input.dueDate !== undefined && { dueDate: input.dueDate }),
            ...(input.startDate !== undefined && {
              startDate: input.startDate,
            }),
            ...(input.dueDateCompleted !== undefined && {
              dueDateCompleted: input.dueDateCompleted,
            }),
            ...(input.dueReminderMinutes !== undefined && {
              dueReminderMinutes: input.dueReminderMinutes,
            }),
            // Colour and image covers are mutually exclusive
            ...(input.coverColour !== undefined && {
              coverColour: input.coverColour,
              ...(input.coverColour && { coverAttachmentId: null }),
            }),
            ...(coverAttachmentId !== undefined && {
              coverAttachmentId,
              ...(coverAttachmentId && { coverColour: null }),
            }),
          },
          { cardPublicId: input.cardPublicId },
        );
      }

      if (input.index !== undefined || newListId !== undefined) {
        result = await cardRepo.reorder(ctx.db, {
          cardId: existingCard.id,
          newIndex: input.index,
          newListId: newListId,
        });
      }

      if (!result)
        throw new TRPCError({
          message: `Failed to update card`,
          code: "INTERNAL_SERVER_ERROR",
        });

      const activities = [];

      if (input.title && existingCard.title !== input.title) {
        activities.push({
          type: "card.updated.title" as const,
          cardId: result.id,
          createdBy: userId,
          fromTitle: existingCard.title,
          toTitle: input.title,
        });
      }

      if (descriptionChanged) {
        activities.push({
          type: "card.updated.description" as const,
          cardId: result.id,
          createdBy: userId,
          fromDescription: existingCard.description ?? undefined,
          toDescription: normalizedDescription ?? undefined,
        });

        if (normalizedDescription) {
          void sendMentionEmails({
            db: ctx.db,
            cardPublicId: input.cardPublicId,
            previousHtml: existingCard.description,
            nextHtml: normalizedDescription,
            commenterUserId: userId,
          });
        }
      }

      if (
        input.dueDate !== undefined &&
        previousDueDate?.getTime() !== input.dueDate?.getTime()
      ) {
        let activityType:
          | "card.updated.dueDate.added"
          | "card.updated.dueDate.updated"
          | "card.updated.dueDate.removed";

        if (!previousDueDate) {
          activityType = "card.updated.dueDate.added";
        } else if (!input.dueDate) {
          activityType = "card.updated.dueDate.removed";
        } else {
          activityType = "card.updated.dueDate.updated";
        }

        activities.push({
          type: activityType,
          cardId: result.id,
          createdBy: userId,
          fromDueDate: previousDueDate ?? undefined,
          toDueDate: input.dueDate ?? undefined,
        });
      }

      if (
        input.startDate !== undefined &&
        previousStartDate?.getTime() !== input.startDate?.getTime()
      ) {
        activities.push({
          type: !previousStartDate
            ? ("card.updated.startDate.added" as const)
            : !input.startDate
              ? ("card.updated.startDate.removed" as const)
              : ("card.updated.startDate.updated" as const),
          cardId: result.id,
          createdBy: userId,
          fromStartDate: previousStartDate ?? undefined,
          toStartDate: input.startDate ?? undefined,
        });
      }

      if (dueDateCompletedChanged) {
        activities.push({
          type: input.dueDateCompleted
            ? ("card.updated.dueDate.completed" as const)
            : ("card.updated.dueDate.uncompleted" as const),
          cardId: result.id,
          createdBy: userId,
        });
      }

      if (newListId && existingCard.listId !== newListId) {
        activities.push({
          type: "card.updated.list" as const,
          cardId: result.id,
          createdBy: userId,
          fromListId: existingCard.listId,
          toListId: newListId,
        });
      }

      if (activities.length > 0) {
        await cardActivityRepo.bulkCreate(ctx.db, activities);
      }

      if (newListId && existingCard.listId !== newListId) {
        void notifyCardAudience({
          db: ctx.db,
          cardId: result.id,
          workspaceId: card.workspaceId,
          actorUserId: userId,
          type: "card.moved",
          metadata: {
            boardName: card.boardName,
            fromListName: existingCard.list.name,
            toListName: newList?.name,
          },
        });
      }

      if (
        input.dueDate !== undefined &&
        previousDueDate?.getTime() !== input.dueDate?.getTime()
      ) {
        void notifyCardAudience({
          db: ctx.db,
          cardId: result.id,
          workspaceId: card.workspaceId,
          actorUserId: userId,
          type: "card.dueDate.changed",
          metadata: {
            boardName: card.boardName,
            dueDate: input.dueDate?.toISOString() ?? null,
          },
        });
      }

      // Build changes object for webhook
      const webhookChanges: Record<string, { from: unknown; to: unknown }> = {};
      if (input.title && existingCard.title !== input.title) {
        webhookChanges.title = { from: existingCard.title, to: input.title };
      }
      if (descriptionChanged) {
        webhookChanges.description = {
          from: existingCard.description,
          to: normalizedDescription,
        };
      }
      if (
        input.dueDate !== undefined &&
        previousDueDate?.getTime() !== input.dueDate?.getTime()
      ) {
        webhookChanges.dueDate = { from: previousDueDate, to: input.dueDate };
      }
      const movedToNewList = Boolean(
        newListId && existingCard.listId !== newListId,
      );
      const currentWebhookListPublicId = movedToNewList
        ? input.listPublicId!
        : existingCard.list.publicId;
      const currentWebhookListName = movedToNewList
        ? (newList?.name ?? card.listName)
        : existingCard.list.name;

      if (movedToNewList) {
        webhookChanges.listId = {
          from: existingCard.list.publicId,
          to: input.listPublicId!,
        };
      }

      // Fire webhooks (non-blocking)
      sendWebhooksForWorkspace(
        ctx.db,
        card.workspaceId,
        createCardWebhookPayload(
          movedToNewList ? "card.moved" : "card.updated",
          {
            id: String(result.id),
            publicId: result.publicId,
            title: result.title,
            description: result.description,
            dueDate: result.dueDate,
            listId: currentWebhookListPublicId,
          },
          {
            boardId: card.boardPublicId,
            boardName: card.boardName,
            listName: currentWebhookListName,
            user: ctx.user
              ? { id: ctx.user.id, name: ctx.user.name }
              : undefined,
            changes:
              Object.keys(webhookChanges).length > 0
                ? webhookChanges
                : undefined,
          },
        ),
      ).catch((error) => {
        console.error("Webhook delivery failed:", error);
      });

      return result;
    }),
  delete: protectedProcedure
    .meta({
      openapi: {
        summary: "Delete a card",
        method: "DELETE",
        path: "/cards/{cardPublicId}",
        description: "Deletes a card by its public ID",
        tags: ["Cards"],
        protect: true,
      },
    })
    .input(
      z.object({
        cardPublicId: z.string().min(12),
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

      const card = await cardRepo.getWorkspaceAndCardIdByCardPublicId(
        ctx.db,
        input.cardPublicId,
      );

      if (!card)
        throw new TRPCError({
          message: `Card with public ID ${input.cardPublicId} not found`,
          code: "NOT_FOUND",
        });

      await assertCanDelete(
        ctx.db,
        userId,
        card.workspaceId,
        "card:delete",
        card.createdBy,
      );

      // Fetch full card data before delete for webhook
      const fullCard = await cardRepo.getByPublicId(ctx.db, input.cardPublicId);

      const deletedAt = new Date();

      await cardRepo.softDelete(ctx.db, {
        cardId: card.id,
        deletedAt,
        deletedBy: userId,
      });

      await cardActivityRepo.create(ctx.db, {
        type: "card.archived",
        cardId: card.id,
        createdBy: userId,
      });

      // Fire webhooks (non-blocking)
      if (fullCard) {
        sendWebhooksForWorkspace(
          ctx.db,
          card.workspaceId,
          createCardWebhookPayload(
            "card.deleted",
            {
              id: String(fullCard.id),
              publicId: fullCard.publicId,
              title: fullCard.title,
              description: fullCard.description,
              dueDate: fullCard.dueDate,
              listId: fullCard.list.publicId,
            },
            {
              boardId: card.boardPublicId,
              boardName: card.boardName,
              listName: fullCard.list.name,
              user: ctx.user
                ? { id: ctx.user.id, name: ctx.user.name }
                : undefined,
            },
          ),
        ).catch((error) => {
          console.error("Webhook delivery failed:", error);
        });
      }

      return { success: true };
    }),
  archive: protectedProcedure
    .meta({
      openapi: {
        summary: "Archive a card",
        method: "POST",
        path: "/cards/{cardPublicId}/archive",
        description:
          "Archives a card. Archived cards are hidden from the board and can be restored",
        tags: ["Cards"],
        protect: true,
      },
    })
    .input(z.object({ cardPublicId: z.string().min(12) }))
    .output(z.object({ success: z.boolean() }))
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

      await assertCanEdit(
        ctx.db,
        userId,
        card.workspaceId,
        "card:edit",
        card.createdBy,
      );

      await cardRepo.softDelete(ctx.db, {
        cardId: card.id,
        deletedAt: new Date(),
        deletedBy: userId,
        archive: true,
      });

      await cardActivityRepo.create(ctx.db, {
        type: "card.archived",
        cardId: card.id,
        createdBy: userId,
      });

      void notifyCardAudience({
        db: ctx.db,
        cardId: card.id,
        workspaceId: card.workspaceId,
        actorUserId: userId,
        type: "card.archived",
        metadata: { boardName: card.boardName },
      });

      return { success: true };
    }),
  restore: protectedProcedure
    .meta({
      openapi: {
        summary: "Restore an archived card",
        method: "POST",
        path: "/cards/{cardPublicId}/restore",
        description:
          "Restores an archived card to the end of its list, or to the board's first list if its list is gone",
        tags: ["Cards"],
        protect: true,
      },
    })
    .input(z.object({ cardPublicId: z.string().min(12) }))
    .output(z.object({ success: z.boolean() }))
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
        { archived: true },
      );

      if (!card)
        throw new TRPCError({
          message: `Archived card with public ID ${input.cardPublicId} not found`,
          code: "NOT_FOUND",
        });

      await assertCanEdit(
        ctx.db,
        userId,
        card.workspaceId,
        "card:edit",
        card.createdBy,
      );

      const board = await boardRepo.getWorkspaceAndBoardIdByBoardPublicId(
        ctx.db,
        card.boardPublicId,
      );

      const restored = board
        ? await cardRepo.restore(ctx.db, { cardId: card.id, boardId: board.id })
        : null;

      if (!restored)
        throw new TRPCError({
          message: `Add a list to the board before restoring this card`,
          code: "BAD_REQUEST",
        });

      await cardActivityRepo.create(ctx.db, {
        type: "card.restored",
        cardId: card.id,
        createdBy: userId,
      });

      return { success: true };
    }),
  deleteArchived: protectedProcedure
    .meta({
      openapi: {
        summary: "Delete an archived card",
        method: "DELETE",
        path: "/cards/{cardPublicId}/archive",
        description:
          "Permanently removes an archived card so it can no longer be restored",
        tags: ["Cards"],
        protect: true,
      },
    })
    .input(z.object({ cardPublicId: z.string().min(12) }))
    .output(z.object({ success: z.boolean() }))
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
        { archived: true },
      );

      if (!card)
        throw new TRPCError({
          message: `Archived card with public ID ${input.cardPublicId} not found`,
          code: "NOT_FOUND",
        });

      await assertCanDelete(
        ctx.db,
        userId,
        card.workspaceId,
        "card:delete",
        card.createdBy,
      );

      await cardRepo.discardArchived(ctx.db, card.id);

      return { success: true };
    }),
  archived: protectedProcedure
    .meta({
      openapi: {
        summary: "List a board's archived cards and lists",
        method: "GET",
        path: "/boards/{boardPublicId}/archived",
        description: "Returns the archived cards and lists of a board",
        tags: ["Boards"],
        protect: true,
      },
    })
    .input(z.object({ boardPublicId: z.string().min(12) }))
    .output(archivedItemsSchema)
    .query(async ({ ctx, input }) => {
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

      await assertPermission(ctx.db, userId, board.workspaceId, "card:view");

      const [archivedCards, archivedLists] = await Promise.all([
        cardRepo.getArchivedByBoardId(ctx.db, board.id),
        listRepo.getArchivedByBoardId(ctx.db, board.id),
      ]);

      return { cards: archivedCards, lists: archivedLists };
    }),
  setWatching: protectedProcedure
    .meta({
      openapi: {
        summary: "Watch or unwatch a card",
        method: "PUT",
        path: "/cards/{cardPublicId}/watching",
        description:
          "Starts or stops notifications to the current user for activity on a card",
        tags: ["Cards"],
        protect: true,
      },
    })
    .input(
      z.object({ cardPublicId: z.string().min(12), watching: z.boolean() }),
    )
    .output(z.object({ watching: z.boolean() }))
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

      await assertPermission(ctx.db, userId, card.workspaceId, "card:view");

      if (input.watching) {
        await watcherRepo.watchCard(ctx.db, { cardId: card.id, userId });
      } else {
        await watcherRepo.unwatchCard(ctx.db, { cardId: card.id, userId });
      }

      return { watching: input.watching };
    }),
  duplicate: protectedProcedure
    .meta({
      openapi: {
        summary: "Duplicate a card",
        method: "POST",
        path: "/cards/{cardPublicId}/duplicate",
        description: "Duplicates a card to a target list with optional options",
        tags: ["Cards"],
        protect: true,
      },
    })
    .input(
      z.object({
        cardPublicId: z.string().min(12),
        listPublicId: z.string().min(12),
        index: z.number().int().min(0).optional(),
        title: z.string().min(1).max(2000).optional(),
        copyLabels: z.boolean(),
        copyMembers: z.boolean(),
        copyChecklists: z.boolean(),
      }),
    )
    .output(
      z.object({
        publicId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user?.id;

      if (!userId)
        throw new TRPCError({
          message: `User not authenticated`,
          code: "UNAUTHORIZED",
        });

      const sourceCardMeta = await cardRepo.getWorkspaceAndCardIdByCardPublicId(
        ctx.db,
        input.cardPublicId,
      );

      if (!sourceCardMeta)
        throw new TRPCError({
          message: `Card with public ID ${input.cardPublicId} not found`,
          code: "NOT_FOUND",
        });

      await assertPermission(
        ctx.db,
        userId,
        sourceCardMeta.workspaceId,
        "card:create",
      );

      const targetList = await listRepo.getWorkspaceAndListIdByListPublicId(
        ctx.db,
        input.listPublicId,
      );

      if (!targetList)
        throw new TRPCError({
          message: `List with public ID ${input.listPublicId} not found`,
          code: "NOT_FOUND",
        });

      if (targetList.workspaceId !== sourceCardMeta.workspaceId)
        throw new TRPCError({
          message: `Target list must be in the same workspace`,
          code: "BAD_REQUEST",
        });

      const sourceCard = await cardRepo.getWithListAndMembersByPublicId(
        ctx.db,
        input.cardPublicId,
      );

      if (!sourceCard)
        throw new TRPCError({
          message: `Card with public ID ${input.cardPublicId} not found`,
          code: "NOT_FOUND",
        });

      const newCard = await duplicateCard({
        db: ctx.db,
        sourceCard,
        targetList: { id: targetList.id, workspaceId: targetList.workspaceId },
        userId,
        index: input.index,
        title: input.title,
        copyLabels: input.copyLabels,
        copyMembers: input.copyMembers,
        copyChecklists: input.copyChecklists,
      });

      return { publicId: newCard.publicId };
    }),
});
