import { env } from "next-runtime-env";

import type { dbClient } from "@kan/db/client";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as notificationRepo from "@kan/db/repository/notification.repo";
import * as userRepo from "@kan/db/repository/user.repo";
import * as watcherRepo from "@kan/db/repository/watcher.repo";
import { sendEmail } from "@kan/email";
import { createLogger } from "@kan/logger";

import {
  enqueueChatAppCardReminder,
  enqueueChatEvent,
} from "./integrationJobs";
import { isEmailEnabled } from "./notifications";

const log = createLogger("due-reminders");

const formatDueText = (dueDate: Date, now: Date) => {
  const minutes = Math.round((dueDate.getTime() - now.getTime()) / 60000);
  if (minutes <= 1) return "now";
  if (minutes < 60) return `in ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
};

/**
 * Sends every due date reminder that has come due: an in-app notification and,
 * when email is configured, an email to the card's members and watchers, plus
 * a message to any Google Chat spaces that want reminders and, through the
 * Kan Chat app, to the people's direct messages and the board's linked spaces.
 * Safe to run on several instances at once; each reminder is claimed once.
 */
export async function processDueReminders(db: dbClient, now = new Date()) {
  const dueCards = await cardRepo.claimDueReminders(db, { now });
  if (dueCards.length === 0) return 0;

  const baseUrl = env("NEXT_PUBLIC_BASE_URL");
  const emailEnabled = isEmailEnabled() && !!process.env.SMTP_HOST;

  for (const card of dueCards) {
    if (!card.dueDate) continue;

    try {
      const dueText = formatDueText(card.dueDate, now);

      void enqueueChatEvent(db, {
        event: "card.due.reminder",
        cardId: card.id,
        context: { dueText },
      });

      const userIds = await watcherRepo.getCardAudienceUserIds(db, card.id);

      void enqueueChatAppCardReminder(db, {
        cardId: card.id,
        userIds,
        dueText,
      });

      if (userIds.length === 0) continue;

      const boardName = card.list.board.name;

      await notificationRepo.bulkCreate(
        db,
        userIds.map((userId) => ({
          type: "card.due.reminder" as const,
          userId,
          cardId: card.id,
          workspaceId: card.list.board.workspaceId,
          metadata: JSON.stringify({
            boardName,
            dueDate: card.dueDate?.toISOString(),
          }),
        })),
      );

      if (!emailEnabled) continue;

      const cardUrl = `${baseUrl}/cards/${card.publicId}`;
      await Promise.all(
        userIds.map(async (userId) => {
          const user = await userRepo.getById(db, userId);
          if (!user?.email) return;
          try {
            await sendEmail(
              user.email,
              `${card.title} is due ${dueText}`,
              "DUE_REMINDER",
              { dueText, boardName, cardTitle: card.title, cardUrl },
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
        { err: error, cardPublicId: card.publicId },
        "Failed to send due reminder",
      );
    }
  }

  log.info({ count: dueCards.length }, "Processed due reminders");
  return dueCards.length;
}
