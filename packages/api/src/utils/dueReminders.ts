import { env } from "next-runtime-env";

import type { dbClient } from "@kan/db/client";
import type { NotificationType } from "@kan/db/schema";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as checklistRepo from "@kan/db/repository/checklist.repo";
import * as notificationRepo from "@kan/db/repository/notification.repo";
import * as userRepo from "@kan/db/repository/user.repo";
import * as watcherRepo from "@kan/db/repository/watcher.repo";
import { sendEmail } from "@kan/email";
import { createLogger } from "@kan/logger";
import { getDueReminderBase } from "@kan/shared/constants";

import {
  enqueueChatAppCardReminder,
  enqueueChatEvent,
} from "./integrationJobs";
import { isEmailEnabled } from "./notifications";

const log = createLogger("due-reminders");

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far away a due date is, for reminder messages. A date without a time is
 * described by its day ("today", "tomorrow") rather than a countdown.
 */
export const formatDueText = (dueDate: Date, hasTime: boolean, now: Date) => {
  if (!hasTime) {
    const days = Math.round(
      (getDueReminderBase(dueDate, false).getTime() - now.getTime()) / DAY_MS,
    );
    if (days <= 0) return "today";
    if (days === 1) return "tomorrow";
    return `in ${days} days`;
  }

  const minutes = Math.round((dueDate.getTime() - now.getTime()) / 60000);
  if (minutes <= 1) return "now";
  if (minutes < 60) return `in ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
};

/**
 * One reminder that has come due, for a card or for one of its checklist
 * items (sub-tasks). Every channel (in-app, email, Google Chat) is sent from
 * this shape, so a new channel only needs to handle it once.
 */
export interface DueReminder {
  card: {
    id: number;
    publicId: string;
    title: string;
    boardName: string;
    listName: string;
    workspaceId: number;
  };
  /** Set when the reminder is for a checklist item of the card. */
  checklistItem?: { id: number; publicId: string; title: string };
  dueDate: Date;
  dueDateHasTime: boolean;
  /** Users to remind. */
  userIds: string[];
}

/**
 * Who a checklist item reminds: the people it's assigned to, or, when it has
 * no assignees, everyone following its card.
 */
export const getChecklistItemAudienceUserIds = async (
  db: dbClient,
  checklistItemId: number,
  cardId: number,
) => {
  const assignees = await checklistRepo.getItemAssigneeUserIds(
    db,
    checklistItemId,
  );
  return assignees.length > 0
    ? assignees
    : watcherRepo.getCardAudienceUserIds(db, cardId);
};

/**
 * Sends one reminder: an in-app notification and, when email is configured,
 * an email to each person, plus a message to any Google Chat spaces that want
 * reminders and, through the Kan Chat app, to the people's direct messages and
 * the board's linked spaces. Never throws.
 */
export async function deliverDueReminder(
  db: dbClient,
  reminder: DueReminder,
  now = new Date(),
) {
  const { card, checklistItem } = reminder;
  try {
    const dueText = formatDueText(
      reminder.dueDate,
      reminder.dueDateHasTime,
      now,
    );

    void enqueueChatEvent(db, {
      event: "card.due.reminder",
      cardId: card.id,
      context: { dueText, itemTitle: checklistItem?.title },
    });

    void enqueueChatAppCardReminder(db, {
      cardId: card.id,
      userIds: reminder.userIds,
      dueText,
      itemTitle: checklistItem?.title,
    });

    if (reminder.userIds.length === 0) return;

    const type: NotificationType = checklistItem
      ? "checklist.item.due.reminder"
      : "card.due.reminder";
    await notificationRepo.bulkCreate(
      db,
      reminder.userIds.map((userId) => ({
        type,
        userId,
        cardId: card.id,
        workspaceId: card.workspaceId,
        metadata: JSON.stringify({
          boardName: card.boardName,
          dueDate: reminder.dueDate.toISOString(),
          dueDateHasTime: reminder.dueDateHasTime,
          itemTitle: checklistItem?.title,
        }),
      })),
    );

    if (!isEmailEnabled() || !process.env.SMTP_HOST) return;

    const cardUrl = `${env("NEXT_PUBLIC_BASE_URL")}/cards/${card.publicId}`;
    const subjectTitle = checklistItem?.title ?? card.title;
    await Promise.all(
      reminder.userIds.map(async (userId) => {
        const user = await userRepo.getById(db, userId);
        if (!user?.email) return;
        try {
          await sendEmail(
            user.email,
            `${subjectTitle} is due ${dueText}`,
            "DUE_REMINDER",
            {
              dueText,
              boardName: card.boardName,
              cardTitle: card.title,
              cardUrl,
              ...(checklistItem && { itemTitle: checklistItem.title }),
            },
          );
        } catch (error) {
          log.error(
            { err: error, cardPublicId: card.publicId },
            "Failed to send due reminder email",
          );
        }
      }),
    );
  } catch (error) {
    log.error(
      {
        err: error,
        cardPublicId: card.publicId,
        checklistItemPublicId: checklistItem?.publicId,
      },
      "Failed to send due reminder",
    );
  }
}

/**
 * Sends every due date reminder that has come due, for cards (to their
 * members and watchers) and for checklist items (to their assignees, or the
 * card's members and watchers when nobody is assigned).
 * Safe to run on several instances at once; each reminder is claimed once.
 */
export async function processDueReminders(db: dbClient, now = new Date()) {
  const [dueCards, dueItems] = await Promise.all([
    cardRepo.claimDueReminders(db, { now }),
    checklistRepo.claimDueReminders(db, { now }),
  ]);

  for (const card of dueCards) {
    if (!card.dueDate) continue;
    await deliverDueReminder(
      db,
      {
        card: {
          id: card.id,
          publicId: card.publicId,
          title: card.title,
          boardName: card.list.board.name,
          listName: card.list.name,
          workspaceId: card.list.board.workspaceId,
        },
        dueDate: card.dueDate,
        dueDateHasTime: card.dueDateHasTime,
        userIds: await watcherRepo.getCardAudienceUserIds(db, card.id),
      },
      now,
    );
  }

  for (const item of dueItems) {
    const card = item.checklist.card;
    if (!item.dueDate) continue;
    await deliverDueReminder(
      db,
      {
        card: {
          id: card.id,
          publicId: card.publicId,
          title: card.title,
          boardName: card.list.board.name,
          listName: card.list.name,
          workspaceId: card.list.board.workspaceId,
        },
        checklistItem: {
          id: item.id,
          publicId: item.publicId,
          title: item.title,
        },
        dueDate: item.dueDate,
        dueDateHasTime: item.dueDateHasTime,
        userIds: await getChecklistItemAudienceUserIds(db, item.id, card.id),
      },
      now,
    );
  }

  const count = dueCards.length + dueItems.length;
  if (count > 0) log.info({ count }, "Processed due reminders");
  return count;
}
