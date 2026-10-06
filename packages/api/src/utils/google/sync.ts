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
 * One thing shown in Google: the card itself (checklistItemId null) or one of
 * its checklist items. `data` is null when it should no longer be shown.
 */
export interface SyncTarget {
  checklistItemId: number | null;
  data: CardSyncData | null;
  userIds: Set<string>;
}

const activeUserIds = (
  rows: { member: { userId: string | null; deletedAt: Date | null } }[],
) => {
  const userIds = new Set<string>();
  for (const { member } of rows) {
    if (member.userId && !member.deletedAt) userIds.add(member.userId);
  }
  return userIds;
};

/**
 * Works out what of a card should be in Google, for whom, and with what
 * details. While the card isn't archived or deleted (nor its list or board):
 * - the card is shown to its members when it has a due date
 * - each checklist item with a due date is shown to the people it's assigned
 *   to, or to the card's members when nobody is assigned.
 *
 * Checklist items listed in `knownItemIds` (they're in someone's Google) are
 * always returned, with null data when they should be removed.
 */
export const getCardSyncTargets = async (
  db: dbClient,
  cardId: number,
  knownItemIds: number[] = [],
): Promise<SyncTarget[]> => {
  const card = await googleConnectionRepo.getCardForSync(db, cardId);
  const active =
    !!card &&
    !card.deletedAt &&
    !card.list.deletedAt &&
    !card.list.board.deletedAt;

  const targets: SyncTarget[] = [];
  const removed = (checklistItemId: number | null): SyncTarget => ({
    checklistItemId,
    data: null,
    userIds: new Set(),
  });

  if (!card || !active) {
    targets.push(removed(null), ...knownItemIds.map(removed));
    return targets;
  }

  const cardMembers = activeUserIds(card.members);
  const cardUrl = `${env("NEXT_PUBLIC_BASE_URL")}/cards/${card.publicId}`;
  const shared = {
    publicId: card.publicId,
    boardName: card.list.board.name,
    listName: card.list.name,
    cardUrl,
  };

  targets.push(
    card.dueDate
      ? {
          checklistItemId: null,
          userIds: cardMembers,
          data: {
            ...shared,
            title: card.title,
            dueDate: card.dueDate,
            dueDateHasTime: card.dueDateHasTime,
            startDate: card.startDate,
            startDateHasTime: card.startDateHasTime,
            dueDateCompleted: card.dueDateCompleted,
            dueReminderMinutes: card.dueReminderMinutes,
          },
        }
      : removed(null),
  );

  const seen = new Set<number>();
  for (const checklist of card.checklists) {
    for (const item of checklist.items) {
      seen.add(item.id);
      if (!item.dueDate || item.deletedAt || checklist.deletedAt) {
        targets.push(removed(item.id));
        continue;
      }
      const assignees = activeUserIds(item.members);
      targets.push({
        checklistItemId: item.id,
        userIds: assignees.size > 0 ? assignees : cardMembers,
        data: {
          ...shared,
          checklistItemPublicId: item.publicId,
          title: `${item.title} (${card.title})`,
          dueDate: item.dueDate,
          dueDateHasTime: item.dueDateHasTime,
          startDate: item.startDate,
          startDateHasTime: item.startDateHasTime,
          dueDateCompleted: item.completed,
          dueReminderMinutes: item.dueReminderMinutes,
        },
      });
    }
  }
  for (const itemId of knownItemIds) {
    if (!seen.has(itemId)) targets.push(removed(itemId));
  }

  return targets;
};

/**
 * Brings one person's calendar event and task for a card in line with the
 * card. Creates the "Kan" calendar or task list first if it's missing.
 */
const syncConnection = async (
  db: dbClient,
  connection: Connection,
  cardId: number,
  checklistItemId: number | null,
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
        connection.timeZone,
      );
    } catch (error) {
      // The person deleted the Kan calendar in Google: make a new one
      if (!isMissingCalendarError(error)) throw error;
      eventId = await upsertCalendarEvent(
        await token(),
        await ensureCalendar(),
        null,
        data,
        connection.timeZone,
      );
    }
    if (eventId !== event?.externalId) {
      await googleConnectionRepo.saveSyncItem(db, {
        connectionId: connection.id,
        cardId,
        checklistItemId,
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
        checklistItemId,
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
 * Updates the calendar events and tasks of a card and its checklist items for
 * everyone who has connected Google: adds them for the people who should see
 * them, updates them, and removes them for people who no longer should or
 * when the card or item is gone.
 *
 * A connection whose Google access was revoked is marked as needing to be
 * reconnected. Any other failure is thrown after every connection was tried,
 * so the job is retried (each step is safe to repeat).
 */
export const syncCardToGoogle = async (db: dbClient, cardId: number) => {
  const items = await googleConnectionRepo.getSyncItemsForCard(db, cardId);
  const targets = await getCardSyncTargets(db, cardId, [
    ...new Set(
      items.flatMap((item) =>
        item.checklistItemId === null ? [] : [item.checklistItemId],
      ),
    ),
  ]);
  const allUserIds = new Set(targets.flatMap(({ userIds }) => [...userIds]));

  const connections = new Map<number, Connection>();
  for (const connection of [
    ...(await googleConnectionRepo.getActiveConnectionsForUsers(db, [
      ...allUserIds,
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
      for (const target of targets) {
        const own = items.filter(
          (item) =>
            item.connectionId === connection.id &&
            item.checklistItemId === target.checklistItemId,
        );
        const data = target.userIds.has(connection.userId) ? target.data : null;
        // Nothing to add and nothing to remove
        if (!data && own.length === 0) continue;
        await syncConnection(
          db,
          connection,
          cardId,
          target.checklistItemId,
          data,
          own,
        );
      }
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
