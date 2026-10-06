import { TRPCError } from "@trpc/server";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { z } from "zod";

import * as cardRepo from "@kan/db/repository/card.repo";
import * as cardActivityRepo from "@kan/db/repository/cardActivity.repo";
import * as cardLinkRepo from "@kan/db/repository/cardLink.repo";

import { createTRPCRouter, protectedProcedure, publicProcedure } from "../trpc";
import { getLinkPreview, normalizeLinkUrl } from "../utils/linkPreview";
import { assertPermission } from "../utils/permissions";

const linkPreviewSchema = z.object({
  url: z.string(),
  status: z.enum(["ok", "failed"]),
  finalUrl: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  imageUrl: z.string().nullable(),
  siteName: z.string().nullable(),
  faviconUrl: z.string().nullable(),
});

const cardLinkSchema = z.object({
  publicId: z.string(),
  url: z.string(),
  title: z.string().nullable(),
  preview: linkPreviewSchema.nullable(),
});

// Each signed-in user can trigger a limited number of uncached page fetches;
// cached previews are always served.
const previewFetchLimiter = new RateLimiterMemory({
  points: 60,
  duration: 600,
});

const canFetchFor = (userId: string) => async () => {
  try {
    await previewFetchLimiter.consume(userId);
    return true;
  } catch {
    return false;
  }
};

const getEditableLink = async (
  ctx: { db: Parameters<typeof cardLinkRepo.getByPublicId>[0] },
  userId: string,
  linkPublicId: string,
) => {
  const link = await cardLinkRepo.getByPublicId(ctx.db, linkPublicId);
  if (!link)
    throw new TRPCError({
      message: `Link with public ID ${linkPublicId} not found`,
      code: "NOT_FOUND",
    });
  await assertPermission(
    ctx.db,
    userId,
    link.card.list.board.workspaceId,
    "card:edit",
  );
  return link;
};

export const linkRouter = createTRPCRouter({
  preview: publicProcedure
    .meta({
      openapi: {
        summary: "Get a link preview",
        method: "GET",
        path: "/links/preview",
        description:
          "Returns the title, description and image of a web page, read from its Open Graph and Twitter card metadata",
        tags: ["Links"],
      },
    })
    .input(z.object({ url: z.string().min(1).max(2048) }))
    .output(linkPreviewSchema.nullable())
    .query(async ({ ctx, input }) => {
      const url = normalizeLinkUrl(input.url);
      if (!url) return null;

      const userId = ctx.user?.id;
      // Anonymous viewers (public boards) only see previews already cached.
      if (!userId) return getLinkPreview(ctx.db, url, { cachedOnly: true });

      return getLinkPreview(ctx.db, url, { canFetch: canFetchFor(userId) });
    }),
  add: protectedProcedure
    .meta({
      openapi: {
        summary: "Add a link to a card",
        method: "POST",
        path: "/cards/{cardPublicId}/links",
        description: "Attaches a web link to a card and fetches its preview",
        tags: ["Links"],
        protect: true,
      },
    })
    .input(
      z.object({
        cardPublicId: z.string().min(12),
        url: z.string().min(1).max(2048),
        title: z.string().max(255).optional(),
      }),
    )
    .output(cardLinkSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user?.id;

      if (!userId)
        throw new TRPCError({
          message: `User not authenticated`,
          code: "UNAUTHORIZED",
        });

      const url = normalizeLinkUrl(input.url);
      if (!url)
        throw new TRPCError({
          message: `Enter a valid web address starting with http:// or https://`,
          code: "BAD_REQUEST",
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

      const title = input.title?.trim() ? input.title.trim() : null;

      const link = await cardLinkRepo.create(ctx.db, {
        cardId: card.id,
        url,
        title,
        createdBy: userId,
      });

      if (!link)
        throw new TRPCError({
          message: "Failed to add link",
          code: "INTERNAL_SERVER_ERROR",
        });

      await cardActivityRepo.create(ctx.db, {
        type: "card.updated.link.added",
        cardId: card.id,
        toTitle: title ?? url,
        createdBy: userId,
      });

      const preview = await getLinkPreview(ctx.db, url, {
        canFetch: canFetchFor(userId),
      });

      return {
        publicId: link.publicId,
        url: link.url,
        title: link.title,
        preview,
      };
    }),
  refresh: protectedProcedure
    .meta({
      openapi: {
        summary: "Refresh a card link preview",
        method: "POST",
        path: "/links/{linkPublicId}/refresh",
        description: "Fetches the link's page again to update its preview",
        tags: ["Links"],
        protect: true,
      },
    })
    .input(z.object({ linkPublicId: z.string().min(12) }))
    .output(linkPreviewSchema.nullable())
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user?.id;

      if (!userId)
        throw new TRPCError({
          message: `User not authenticated`,
          code: "UNAUTHORIZED",
        });

      const link = await getEditableLink(ctx, userId, input.linkPublicId);

      return getLinkPreview(ctx.db, link.url, {
        force: true,
        canFetch: canFetchFor(userId),
      });
    }),
  delete: protectedProcedure
    .meta({
      openapi: {
        summary: "Remove a link from a card",
        method: "DELETE",
        path: "/links/{linkPublicId}",
        description: "Soft deletes a card link",
        tags: ["Links"],
        protect: true,
      },
    })
    .input(z.object({ linkPublicId: z.string().min(12) }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user?.id;

      if (!userId)
        throw new TRPCError({
          message: `User not authenticated`,
          code: "UNAUTHORIZED",
        });

      const link = await getEditableLink(ctx, userId, input.linkPublicId);

      await cardLinkRepo.softDelete(ctx.db, {
        linkId: link.id,
        deletedAt: new Date(),
      });

      await cardActivityRepo.create(ctx.db, {
        type: "card.updated.link.removed",
        cardId: link.cardId,
        fromTitle: link.title ?? link.url,
        createdBy: userId,
      });

      return { success: true };
    }),
});
