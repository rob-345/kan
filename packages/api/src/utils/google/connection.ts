import type { dbClient } from "@kan/db/client";
import * as googleConnectionRepo from "@kan/db/repository/googleConnection.repo";
import { createLogger } from "@kan/logger";

import type { GoogleConnectPurpose } from "./oauth";
import { decryptToken, encryptToken } from "../encryption";
import { enqueueGoogleUserSync } from "../integrationJobs";
import { deleteKanCalendar } from "./calendar";
import {
  exchangeCodeForTokens,
  getAccessToken,
  getGoogleEmail,
  getGrantedFeatures,
  revokeToken,
  verifyOAuthState,
} from "./oauth";
import { deleteKanTaskList } from "./tasks";

const log = createLogger("google-connection");

type Connection = NonNullable<
  Awaited<ReturnType<typeof googleConnectionRepo.getById>>
>;

export type ConnectGoogleResult = {
  purpose: GoogleConnectPurpose;
  returnTo: string | null;
} & (
  | { ok: true }
  | {
      ok: false;
      reason: "invalid_state" | "denied" | "no_refresh_token" | "failed";
    }
);

/**
 * Finishes the OAuth flow started from the account settings (Calendar and
 * Tasks) or from a card (Drive): stores the tokens and queues a sync of the
 * person's cards.
 */
export const completeGoogleConnection = async (
  db: dbClient,
  args: {
    userId: string;
    code: string | undefined;
    state: string | undefined;
    error: string | undefined;
  },
): Promise<ConnectGoogleResult> => {
  const verified = args.state
    ? verifyOAuthState(args.state, args.userId)
    : null;
  if (!verified)
    return {
      ok: false,
      reason: "invalid_state",
      purpose: "sync",
      returnTo: null,
    };
  const { purpose, returnTo } = verified;
  const fail = (reason: "denied" | "no_refresh_token" | "failed") => ({
    ok: false as const,
    reason,
    purpose,
    returnTo,
  });
  if (args.error || !args.code) return fail("denied");

  try {
    const tokens = await exchangeCodeForTokens(args.code);
    if (!tokens.refresh_token) return fail("no_refresh_token");

    const granted = getGrantedFeatures(tokens.scope);
    const grantedWhatWasAsked =
      purpose === "drive" ? granted.drive : granted.calendar || granted.tasks;
    if (!grantedWhatWasAsked) {
      // Keep an existing connection working; only drop a token nothing uses
      if (!granted.calendar && !granted.tasks && !granted.drive) {
        await revokeToken(tokens.refresh_token);
      }
      return fail("denied");
    }

    const googleEmail = await getGoogleEmail(tokens.access_token);

    // Reconnecting with a different Google account starts afresh; the old
    // account keeps its Kan calendar, which the person can delete
    let existing = await googleConnectionRepo.getByUserId(db, args.userId);
    if (existing && existing.googleEmail !== googleEmail) {
      await googleConnectionRepo.deleteByUserId(db, args.userId);
      existing = undefined;
    }
    const previouslyGranted = getGrantedFeatures(existing?.scope ?? undefined);

    const connection = await googleConnectionRepo.upsert(db, {
      userId: args.userId,
      googleEmail,
      refreshToken: encryptToken(tokens.refresh_token),
      accessToken: encryptToken(tokens.access_token),
      accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      scope: tokens.scope ?? null,
      timeZone: verified.timeZone,
    });
    if (!connection) return fail("failed");

    // Only sync what Google actually let Kan do. A sync that was already
    // granted keeps the person's on/off choice; a newly granted one turns on
    // when they connected for Calendar and Tasks, but not when they only
    // connected to link a Drive file.
    const syncEnabled = (
      feature: "calendar" | "tasks",
      currentlyEnabled: boolean,
    ) =>
      granted[feature] &&
      (previouslyGranted[feature] ? currentlyEnabled : purpose === "sync");
    const calendarEnabled = syncEnabled("calendar", connection.calendarEnabled);
    const tasksEnabled = syncEnabled("tasks", connection.tasksEnabled);
    if (
      calendarEnabled !== connection.calendarEnabled ||
      tasksEnabled !== connection.tasksEnabled
    ) {
      await googleConnectionRepo.update(db, connection.id, {
        calendarEnabled,
        tasksEnabled,
      });
    }

    if (calendarEnabled || tasksEnabled) {
      await enqueueGoogleUserSync(db, args.userId);
    }
    return { ok: true, purpose, returnTo };
  } catch (error) {
    log.error({ err: error, userId: args.userId }, "Google connect failed");
    return fail("failed");
  }
};

/**
 * Deletes the Kan calendar or task list from the person's Google account and
 * forgets the events or tasks that were in it. Google failures are logged and
 * ignored: the person can always delete the calendar themselves.
 */
const removeFromGoogle = async (
  db: dbClient,
  connection: Connection,
  kind: "calendar" | "tasks",
) => {
  const externalId =
    kind === "calendar" ? connection.calendarId : connection.taskListId;

  if (externalId && connection.status === "active") {
    try {
      const token = await getAccessToken(db, connection);
      if (kind === "calendar") await deleteKanCalendar(token, externalId);
      else await deleteKanTaskList(token, externalId);
    } catch (error) {
      log.warn(
        { err: error, userId: connection.userId, kind },
        "Could not delete Kan data from Google",
      );
    }
  }

  await googleConnectionRepo.deleteSyncItemsOfKind(db, connection.id, kind);
};

export const updateGoogleSyncSettings = async (
  db: dbClient,
  userId: string,
  input: { calendarEnabled?: boolean; tasksEnabled?: boolean },
) => {
  const connection = await googleConnectionRepo.getByUserId(db, userId);
  if (!connection) return null;

  const granted = getGrantedFeatures(connection.scope ?? undefined);
  const calendarEnabled =
    input.calendarEnabled === undefined
      ? connection.calendarEnabled
      : input.calendarEnabled && granted.calendar;
  const tasksEnabled =
    input.tasksEnabled === undefined
      ? connection.tasksEnabled
      : input.tasksEnabled && granted.tasks;

  if (connection.calendarEnabled && !calendarEnabled) {
    await removeFromGoogle(db, connection, "calendar");
  }
  if (connection.tasksEnabled && !tasksEnabled) {
    await removeFromGoogle(db, connection, "tasks");
  }

  const updated = await googleConnectionRepo.update(db, connection.id, {
    calendarEnabled,
    tasksEnabled,
    ...(connection.calendarEnabled && !calendarEnabled && { calendarId: null }),
    ...(connection.tasksEnabled && !tasksEnabled && { taskListId: null }),
  });

  if (
    (!connection.calendarEnabled && calendarEnabled) ||
    (!connection.tasksEnabled && tasksEnabled)
  ) {
    await enqueueGoogleUserSync(db, userId);
  }

  return updated;
};

/**
 * Removes the Kan calendar and task list from Google, revokes Kan's access
 * and forgets the connection.
 */
export const disconnectGoogle = async (db: dbClient, userId: string) => {
  const connection = await googleConnectionRepo.getByUserId(db, userId);
  if (!connection) return;

  await removeFromGoogle(db, connection, "calendar");
  await removeFromGoogle(db, connection, "tasks");

  try {
    await revokeToken(decryptToken(connection.refreshToken));
  } catch (error) {
    log.warn({ err: error, userId }, "Could not revoke Google token");
  }

  await googleConnectionRepo.deleteByUserId(db, userId);
};
