import { TRPCError } from "@trpc/server";
import { z } from "zod";

import * as googleConnectionRepo from "@kan/db/repository/googleConnection.repo";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import {
  disconnectGoogle,
  updateGoogleSyncSettings,
} from "../utils/google/connection";
import {
  buildAuthorizationUrl,
  getGrantedFeatures,
  isGoogleIntegrationConfigured,
  normalizeTimeZone,
} from "../utils/google/oauth";

const statusSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  googleEmail: z.string().nullable(),
  needsReconnect: z.boolean(),
  calendarEnabled: z.boolean(),
  tasksEnabled: z.boolean(),
  calendarGranted: z.boolean(),
  tasksGranted: z.boolean(),
  driveGranted: z.boolean(),
});

const requireUserId = (userId: string | undefined) => {
  if (!userId)
    throw new TRPCError({
      message: "User not authenticated",
      code: "UNAUTHORIZED",
    });
  return userId;
};

export const googleIntegrationRouter = createTRPCRouter({
  status: protectedProcedure
    .meta({
      openapi: {
        summary: "Get Google Calendar and Tasks status",
        method: "GET",
        path: "/integration/google",
        description:
          "Whether the current user has connected Google, and which syncs are on",
        tags: ["Integration"],
        protect: true,
      },
    })
    .input(z.void())
    .output(statusSchema)
    .query(async ({ ctx }) => {
      const userId = requireUserId(ctx.user?.id);
      const connection = await googleConnectionRepo.getByUserId(ctx.db, userId);
      const granted = getGrantedFeatures(connection?.scope ?? undefined);

      return {
        configured: isGoogleIntegrationConfigured(),
        connected: !!connection,
        googleEmail: connection?.googleEmail ?? null,
        needsReconnect: connection?.status === "error",
        calendarEnabled: connection?.calendarEnabled ?? false,
        tasksEnabled: connection?.tasksEnabled ?? false,
        calendarGranted: granted.calendar,
        tasksGranted: granted.tasks,
        driveGranted: granted.drive,
      };
    }),

  getAuthorizationUrl: protectedProcedure
    .meta({
      openapi: {
        summary: "Get the Google authorization URL",
        method: "GET",
        path: "/integration/google/authorize",
        description:
          "Returns the Google consent page URL for connecting Calendar and Tasks, or Drive file linking",
        tags: ["Integration"],
        protect: true,
      },
    })
    .input(
      z.object({
        timeZone: z.string().max(64).optional(),
        purpose: z.enum(["sync", "drive"]).optional(),
        // A path on this site to return to, e.g. the card being edited
        returnTo: z.string().max(512).optional(),
      }),
    )
    .output(z.object({ url: z.string() }))
    .mutation(({ ctx, input }) => {
      const userId = requireUserId(ctx.user?.id);
      const url = buildAuthorizationUrl(
        userId,
        normalizeTimeZone(input.timeZone),
        { purpose: input.purpose, returnTo: input.returnTo },
      );

      if (!url)
        throw new TRPCError({
          message:
            "Google isn't set up on this server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
          code: "PRECONDITION_FAILED",
        });

      return { url };
    }),

  update: protectedProcedure
    .meta({
      openapi: {
        summary: "Turn Google Calendar or Tasks sync on or off",
        method: "PUT",
        path: "/integration/google",
        description:
          "Turning a sync off deletes the Kan calendar or task list from the user's Google account",
        tags: ["Integration"],
        protect: true,
      },
    })
    .input(
      z.object({
        calendarEnabled: z.boolean().optional(),
        tasksEnabled: z.boolean().optional(),
      }),
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.user?.id);
      const updated = await updateGoogleSyncSettings(ctx.db, userId, input);

      if (!updated)
        throw new TRPCError({
          message: "Google isn't connected",
          code: "NOT_FOUND",
        });

      return { success: true };
    }),

  disconnect: protectedProcedure
    .meta({
      openapi: {
        summary: "Disconnect Google",
        method: "DELETE",
        path: "/integration/google",
        description:
          "Deletes the Kan calendar and task list from Google and revokes access",
        tags: ["Integration"],
        protect: true,
      },
    })
    .input(z.void())
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx }) => {
      const userId = requireUserId(ctx.user?.id);
      await disconnectGoogle(ctx.db, userId);
      return { success: true };
    }),
});
