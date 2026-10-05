import { env } from "next-runtime-env";

import type { dbClient } from "@kan/db/client";
import type { GoogleSyncKind } from "@kan/db/schema";
import * as googleConnectionRepo from "@kan/db/repository/googleConnection.repo";
import { createLogger } from "@kan/logger";

import type { CardSyncData } from "./calendar";
import {
  createKanCalendar,
  deleteCalendarEvent,
  isMissingCalendarError,
  upsertCalendarEvent,
} from "./calendar";
import { getAccessToken, GoogleApiError } from "./oauth";
import { createKanTaskList, deleteTask, upsertTask } from "./tasks";

const log = createLogger("google-sync");

type Connection = NonNullable<
  Awaited<ReturnType<typeof googleConnectionRepo.getById>>
>;
type SyncItem = Awaited<
  ReturnType<typeof googleConnectionRepo.getSyncItemsForCard>
>[number];

/** Cards due longer ago than this are left out of a first sync. */
export const INITIAL_SYNC_LOOKBACK_DAYS = 30;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Works out who should see a card in Google, and with what details. A card is
 * shown to its members while it has a due date and isn't archived or deleted
 * (nor its list or board).
 */
export const getCardSyncTarget = async (db: dbClient, cardId: number) => {
  const card = await googleConnectionRepo.getCardForSync(db, cardId);
  if (
    !card?.dueDate ||
    card.deletedAt ||
    card.list.deletedAt ||
    card.list.board.deletedAt
  ) {
    return { data: null, userIds: new Set<string>() };
  }

  const userIds = new Set<string>();
  for (const { member } of card.members) {
    if (member.userId && !member.deletedAt) userIds.add(member.userId);
  }

  const data: CardSyncData = {
    publicId: card.publicId,
    title: card.title,
    dueDate: card.dueDate,
    startDate: card.startDate,
    dueDateCompleted: card.dueDateCompleted,
    dueReminderMinutes: card.dueReminderMinutes,
    boardName: card.list.board.name,
    listName: card.list.name,
    cardUrl: `${env("NEXT_PUBLIC_BASE_URL")}/cards/${card.publicId}`,
  };

  return { data, userIds };
};

/**
 * Brings one person's calendar event and task for a card in line with the
 * card. Creates the "Kan" calendar or task list first if it's missing.
 */
const syncConnection = async (
  db: dbClient,
  connection: Connection,
  cardId: number,
  data: CardSyncData | null,
  items: SyncItem[],
) => {
  let accessToken: string | undefined;
  const token = async () =>
    (accessToken ??= await getAccessToken(db, connection));
  const itemOf = (kind: GoogleSyncKind) =>
    items.find((item) => item.kind === kind);

  // Calendar
  const event = itemOf("calendar");
  if (data && connection.calendarEnabled) {
    let calendarId = connection.calendarId;
    const ensureCalendar = async () => {
      calendarId = await createKanCalendar(await token(), connection.timeZone);
      await googleConnectionRepo.update(db, connection.id, { calendarId });
      connection.calendarId = calendarId;
      return calendarId;
    };
    calendarId ??= await ensureCalendar();

    let eventId: string;
    try {
      eventId = await upsertCalendarEvent(
        await token(),
        calendarId,
        event?.externalId ?? null,
        data,
      );
    } catch (error) {
      // The person deleted the Kan calendar in Google: make a new one
      if (!isMissingCalendarError(error)) throw error;
      eventId = await upsertCalendarEvent(
        await token(),
        await ensureCalendar(),
        null,
        data,
      );
    }
    if (eventId !== event?.externalId) {
      await googleConnectionRepo.saveSyncItem(db, {
        connectionId: connection.id,
        cardId,
        kind: "calendar",
        externalId: eventId,
      });
    }
  } else if (event) {
    if (connection.calendarId) {
      await deleteCalendarEvent(
        await token(),
        connection.calendarId,
        event.externalId,
      );
    }
    await googleConnectionRepo.deleteSyncItem(db, event.id);
  }

  // Tasks
  const task = itemOf("tasks");
  if (data && connection.tasksEnabled) {
    let taskListId = connection.taskListId;
    const ensureTaskList = async () => {
      taskListId = await createKanTaskList(await token());
      await googleConnectionRepo.update(db, connection.id, { taskListId });
      connection.taskListId = taskListId;
      return taskListId;
    };
    taskListId ??= await ensureTaskList();

    let taskId: string;
    try {
      taskId = await upsertTask(
        await token(),
        taskListId,
        task?.externalId ?? null,
        data,
        connection.timeZone,
      );
    } catch (error) {
      if (
        !(error instanceof GoogleApiError) ||
        (error.status !== 404 && error.status !== 410)
      ) {
        throw error;
      }
      taskId = await upsertTask(
        await token(),
        await ensureTaskList(),
        null,
        data,
        connection.timeZone,
      );
    }
    if (taskId !== task?.externalId) {
      await googleConnectionRepo.saveSyncItem(db, {
        connectionId: connection.id,
        cardId,
        kind: "tasks",
        externalId: taskId,
      });
    }
  } else if (task) {
    if (connection.taskListId) {
      await deleteTask(await token(), connection.taskListId, task.externalId);
    }
    await googleConnectionRepo.deleteSyncItem(db, task.id);
  }
};

/**
 * Updates a card's calendar events and tasks for everyone who has connected
 * Google: adds them for current members, updates them, and removes them for
 * people who are no longer members or when the card is gone.
 *
 * A connection whose Google access was revoked is marked as needing to be
 * reconnected. Any other failure is thrown after every connection was tried,
 * so the job is retried (each step is safe to repeat).
 */
export const syncCardToGoogle = async (db: dbClient, cardId: number) => {
  const [{ data, userIds }, items] = await Promise.all([
    getCardSyncTarget(db, cardId),
    googleConnectionRepo.getSyncItemsForCard(db, cardId),
  ]);

  const connections = new Map<number, Connection>();
  for (const connection of [
    ...(await googleConnectionRepo.getActiveConnectionsForUsers(db, [
      ...userIds,
    ])),
    ...(await googleConnectionRepo.getByIds(db, [
      ...new Set(items.map((item) => item.connectionId)),
    ])),
  ]) {
    if (connection.status === "active") {
      connections.set(connection.id, connection);
    }
  }

  const failures: unknown[] = [];

  for (const connection of connections.values()) {
    try {
      await syncConnection(
        db,
        connection,
        cardId,
        userIds.has(connection.userId) ? data : null,
        items.filter((item) => item.connectionId === connection.id),
      );
    } catch (error) {
      if (error instanceof GoogleApiError && error.isAuthError) {
        log.warn(
          { userId: connection.userId, err: error },
          "Google access revoked; marking connection for reconnect",
        );
        await googleConnectionRepo.update(db, connection.id, {
          status: "error",
          lastError: "Google access was revoked. Reconnect to resume syncing.",
        });
        continue;
      }
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    const [first] = failures;
    if (failures.length === 1) throw first;
    throw new Error(
      `Google sync failed for ${failures.length} people: ${errorMessage(first)}`,
      { cause: first },
    );
  }
};

/**
 * Card ids to sync after a person connects or turns a sync back on: cards
 * they're a member of with a recent or future due date, plus any card that
 * still has an event or task in their account.
 */
export const getCardIdsToSyncForUser = async (
  db: dbClient,
  userId: string,
  now = new Date(),
) => {
  const connection = await googleConnectionRepo.getByUserId(db, userId);
  if (connection?.status !== "active") return [];

  const since = new Date(
    now.getTime() - INITIAL_SYNC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );
  const [memberCardIds, items] = await Promise.all([
    googleConnectionRepo.getMemberCardIdsWithDueDate(db, { userId, since }),
    googleConnectionRepo.getSyncItems(db, connection.id),
  ]);
  return [...new Set([...memberCardIds, ...items.map((item) => item.cardId)])];
};
