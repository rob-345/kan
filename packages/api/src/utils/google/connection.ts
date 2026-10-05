import type { dbClient } from "@kan/db/client";
import * as googleConnectionRepo from "@kan/db/repository/googleConnection.repo";
import { createLogger } from "@kan/logger";

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

export type ConnectGoogleResult =
  | { ok: true }
  | {
      ok: false;
      reason: "invalid_state" | "denied" | "no_refresh_token" | "failed";
    };

/**
 * Finishes the OAuth flow started from the account settings: stores the
 * tokens and queues a sync of the person's cards.
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
  if (!verified) return { ok: false, reason: "invalid_state" };
  if (args.error || !args.code) return { ok: false, reason: "denied" };

  try {
    const tokens = await exchangeCodeForTokens(args.code);
    if (!tokens.refresh_token) return { ok: false, reason: "no_refresh_token" };

    const granted = getGrantedFeatures(tokens.scope);
    if (!granted.calendar && !granted.tasks) {
      await revokeToken(tokens.refresh_token);
      return { ok: false, reason: "denied" };
    }

    const googleEmail = await getGoogleEmail(tokens.access_token);

    // Reconnecting with a different Google account starts afresh; the old
    // account keeps its Kan calendar, which the person can delete
    const existing = await googleConnectionRepo.getByUserId(db, args.userId);
    if (existing && existing.googleEmail !== googleEmail) {
      await googleConnectionRepo.deleteByUserId(db, args.userId);
    }

    const connection = await googleConnectionRepo.upsert(db, {
      userId: args.userId,
      googleEmail,
      refreshToken: encryptToken(tokens.refresh_token),
      accessToken: encryptToken(tokens.access_token),
      accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      scope: tokens.scope ?? null,
      timeZone: verified.timeZone,
    });
    if (!connection) return { ok: false, reason: "failed" };

    // Only sync what Google actually let Kan do
    if (!granted.calendar || !granted.tasks) {
      await googleConnectionRepo.update(db, connection.id, {
        calendarEnabled: connection.calendarEnabled && granted.calendar,
        tasksEnabled: connection.tasksEnabled && granted.tasks,
      });
    }

    await enqueueGoogleUserSync(db, args.userId);
    return { ok: true };
  } catch (error) {
    log.error({ err: error, userId: args.userId }, "Google connect failed");
    return { ok: false, reason: "failed" };
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
