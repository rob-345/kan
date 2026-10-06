import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { dbClient } from "@kan/db/client";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as cardActivityRepo from "@kan/db/repository/cardActivity.repo";
import * as cardDriveFileRepo from "@kan/db/repository/cardDriveFile.repo";
import * as googleConnectionRepo from "@kan/db/repository/googleConnection.repo";
import { createLogger } from "@kan/logger";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { getDriveFile, isValidDriveFileId } from "../utils/google/drive";
import {
  getAccessToken,
  getGoogleProjectNumber,
  getGrantedFeatures,
  GoogleApiError,
  isGoogleIntegrationConfigured,
} from "../utils/google/oauth";
import { assertPermission } from "../utils/permissions";

const log = createLogger("drive-files");

const MAX_FILES_PER_LINK = 20;

const driveFileSchema = z.object({
  publicId: z.string(),
  driveFileId: z.string(),
  name: z.string(),
  mimeType: z.string(),
  url: z.string(),
  iconUrl: z.string().nullable(),
  createdAt: z.date(),
  createdByName: z.string().nullable(),
});

const requireUserId = (userId: string | undefined) => {
  if (!userId)
    throw new TRPCError({
      message: "User not authenticated",
      code: "UNAUTHORIZED",
    });
  return userId;
};

const getCard = async (db: dbClient, cardPublicId: string) => {
  const card = await cardRepo.getWorkspaceAndCardIdByCardPublicId(
    db,
    cardPublicId,
  );
  if (!card)
    throw new TRPCError({
      message: `Card with public ID ${cardPublicId} not found`,
      code: "NOT_FOUND",
    });
  return card;
};

/** The Picker needs a browser API key and the Cloud project number. */
const getPickerSettings = () => {
  const developerKey = process.env.GOOGLE_PICKER_API_KEY;
  const appId = getGoogleProjectNumber();
  if (!isGoogleIntegrationConfigured() || !developerKey || !appId) return null;
  return { developerKey, appId };
};

/**
 * Returns a fresh access token for the person's Google connection if it may
 * use Drive, or null if they need to connect (or reconnect) first. A token
 * Google has revoked marks the connection for reconnecting.
 */
const getDriveAccessToken = async (db: dbClient, userId: string) => {
  const connection = await googleConnectionRepo.getByUserId(db, userId);
  if (
    !connection ||
    connection.status !== "active" ||
    !getGrantedFeatures(connection.scope ?? undefined).drive
  ) {
    return null;
  }

  try {
    return await getAccessToken(db, connection);
  } catch (error) {
    if (error instanceof GoogleApiError && error.isAuthError) {
      await googleConnectionRepo.update(db, connection.id, {
        status: "error",
        lastError: "Google access was revoked. Reconnect to resume syncing.",
      });
      return null;
    }
    throw error;
  }
};

export const driveFileRouter = createTRPCRouter({
  list: protectedProcedure
    .meta({
      openapi: {
        summary: "List the Google Drive files linked to a card",
        method: "GET",
        path: "/cards/{cardPublicId}/drive-files",
        description:
          "Returns the Drive files linked to a card, and whether linking is available on this server",
        tags: ["Attachments"],
        protect: true,
      },
    })
    .input(z.object({ cardPublicId: z.string().min(12) }))
    .output(
      z.object({
        available: z.boolean(),
        files: z.array(driveFileSchema),
      }),
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.user?.id);
      const card = await getCard(ctx.db, input.cardPublicId);
      await assertPermission(ctx.db, userId, card.workspaceId, "card:view");

      const files = await cardDriveFileRepo.getAllByCardId(ctx.db, card.id);

      return {
        available: !!getPickerSettings(),
        files: files.map(({ createdBy, ...file }) => ({
          ...file,
          createdByName: createdBy?.name ?? null,
        })),
      };
    }),

  pickerConfig: protectedProcedure
    .meta({
      openapi: {
        summary: "Get Google Picker settings",
        method: "POST",
        path: "/integration/google/drive/picker",
        description:
          "Returns what the browser needs to open the Google Picker for the current user, or says they must connect Google Drive first",
        tags: ["Integration"],
        protect: true,
      },
    })
    .input(z.void())
    .output(
      z.object({
        status: z.enum(["ready", "connect"]),
        accessToken: z.string().nullable(),
        developerKey: z.string().nullable(),
        appId: z.string().nullable(),
      }),
    )
    .mutation(async ({ ctx }) => {
      const userId = requireUserId(ctx.user?.id);
      const settings = getPickerSettings();
      if (!settings)
        throw new TRPCError({
          message:
            "Google Drive isn't set up on this server. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_PICKER_API_KEY.",
          code: "PRECONDITION_FAILED",
        });

      const accessToken = await getDriveAccessToken(ctx.db, userId);
      if (!accessToken)
        return {
          status: "connect" as const,
          accessToken: null,
          developerKey: null,
          appId: null,
        };

      return { status: "ready" as const, accessToken, ...settings };
    }),

  link: protectedProcedure
    .meta({
      openapi: {
        summary: "Link Google Drive files to a card",
        method: "POST",
        path: "/cards/{cardPublicId}/drive-files",
        description:
          "Links files picked in the Google Picker to a card. Kan reads each file's name and link from Drive with the current user's access.",
        tags: ["Attachments"],
        protect: true,
      },
    })
    .input(
      z.object({
        cardPublicId: z.string().min(12),
        fileIds: z
          .array(z.string().refine(isValidDriveFileId, "Invalid Drive file id"))
          .min(1)
          .max(MAX_FILES_PER_LINK),
      }),
    )
    .output(z.object({ linked: z.number(), failed: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.user?.id);
      const card = await getCard(ctx.db, input.cardPublicId);
      await assertPermission(ctx.db, userId, card.workspaceId, "card:edit");

      const accessToken = await getDriveAccessToken(ctx.db, userId);
      if (!accessToken)
        throw new TRPCError({
          message: "Connect Google Drive to link files.",
          code: "PRECONDITION_FAILED",
        });

      let linked = 0;
      let failed = 0;
      for (const fileId of new Set(input.fileIds)) {
        const existing = await cardDriveFileRepo.getByCardAndDriveFileId(
          ctx.db,
          card.id,
          fileId,
        );
        if (existing) {
          linked++;
          continue;
        }

        let file;
        try {
          file = await getDriveFile(accessToken, fileId);
        } catch (error) {
          log.warn({ err: error, fileId }, "Could not read Drive file");
          failed++;
          continue;
        }

        const created = await cardDriveFileRepo.create(ctx.db, {
          cardId: card.id,
          driveFileId: file.id,
          name: file.name,
          mimeType: file.mimeType,
          url: file.url,
          iconUrl: file.iconUrl,
          createdBy: userId,
        });
        if (!created) {
          failed++;
          continue;
        }

        await cardActivityRepo.create(ctx.db, {
          type: "card.updated.driveFile.added",
          cardId: card.id,
          toTitle: file.name.slice(0, 255),
          createdBy: userId,
        });
        linked++;
      }

      if (linked === 0)
        throw new TRPCError({
          message:
            "Kan couldn't read the files you picked from Google Drive. Please try again.",
          code: "BAD_REQUEST",
        });

      return { linked, failed };
    }),

  unlink: protectedProcedure
    .meta({
      openapi: {
        summary: "Remove a Google Drive file from a card",
        method: "DELETE",
        path: "/drive-files/{driveFilePublicId}",
        description:
          "Removes the link from the card. The file stays in Google Drive.",
        tags: ["Attachments"],
        protect: true,
      },
    })
    .input(z.object({ driveFilePublicId: z.string().min(12) }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.user?.id);
      const driveFile = await cardDriveFileRepo.getByPublicId(
        ctx.db,
        input.driveFilePublicId,
      );
      if (!driveFile)
        throw new TRPCError({
          message: `Drive file with public ID ${input.driveFilePublicId} not found`,
          code: "NOT_FOUND",
        });

      await assertPermission(
        ctx.db,
        userId,
        driveFile.card.list.board.workspaceId,
        "card:edit",
      );

      await cardDriveFileRepo.softDelete(ctx.db, {
        id: driveFile.id,
        deletedAt: new Date(),
      });

      await cardActivityRepo.create(ctx.db, {
        type: "card.updated.driveFile.removed",
        cardId: driveFile.cardId,
        fromTitle: driveFile.name.slice(0, 255),
        createdBy: userId,
      });

      return { success: true };
    }),
});
