import { env } from "next-runtime-env";

import type { dbClient } from "@kan/db/client";
import type { NotificationType } from "@kan/db/schema";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as memberRepo from "@kan/db/repository/member.repo";
import * as notificationRepo from "@kan/db/repository/notification.repo";
import * as userRepo from "@kan/db/repository/user.repo";
import * as watcherRepo from "@kan/db/repository/watcher.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";
import { sendEmail } from "@kan/email";
import { createLogger } from "@kan/logger";

import { getNewMentionPublicIds } from "./mention-notifications";

const log = createLogger("notifications");

export const isEmailEnabled = () =>
  env("NEXT_PUBLIC_DISABLE_EMAIL")?.toLowerCase() !== "true";

export interface CardNotificationMetadata {
  actorName?: string;
  boardName?: string;
  fromListName?: string;
  toListName?: string;
  dueDate?: string | null;
}

/**
 * Records an in-app notification for everyone following a card (its watchers,
 * its board's watchers and its members), except the person who acted.
 * Never throws: notifications must not break the action that caused them.
 */
export async function notifyCardAudience({
  db,
  cardId,
  workspaceId,
  actorUserId,
  type,
  commentId,
  metadata,
  onlyUserIds,
}: {
  db: dbClient;
  cardId: number;
  workspaceId: number;
  actorUserId: string;
  type: NotificationType;
  commentId?: number;
  metadata?: CardNotificationMetadata;
  /** Notify exactly these users instead of the card's audience. */
  onlyUserIds?: string[];
}) {
  try {
    const audience =
      onlyUserIds ?? (await watcherRepo.getCardAudienceUserIds(db, cardId));
    const recipients = audience.filter((userId) => userId !== actorUserId);
    if (recipients.length === 0) return;

    let actorName = metadata?.actorName;
    if (!actorName) {
      const actor = await userRepo.getById(db, actorUserId);
      actorName = actor?.name?.trim() || actor?.email;
    }

    await notificationRepo.bulkCreate(
      db,
      recipients.map((userId) => ({
        type,
        userId,
        cardId,
        commentId,
        workspaceId,
        metadata: JSON.stringify({ ...metadata, actorName }),
      })),
    );
  } catch (error) {
    log.error({ err: error, cardId, type }, "Failed to notify card audience");
  }
}

/**
 * Sends mention notification emails to members newly mentioned in the content.
 */
export async function sendMentionEmails({
  db,
  cardPublicId,
  previousHtml,
  nextHtml,
  commenterUserId,
  commentId,
}: {
  db: dbClient;
  cardPublicId: string;
  previousHtml: string | null;
  nextHtml: string;
  commenterUserId: string;
  commentId?: number;
}) {
  try {
    const mentionPublicIds = getNewMentionPublicIds(previousHtml, nextHtml);
    if (mentionPublicIds.length === 0) return;

    // Get card with board information
    const card = await cardRepo.getWithListAndMembersByPublicId(
      db,
      cardPublicId,
    );
    if (!card?.list.board) return;

    const board = card.list.board;
    const boardName = board.name;
    const cardTitle = card.title;
    const cardId = card.id;

    // Get workspace ID from workspace publicId
    const workspace = await workspaceRepo.getByPublicId(
      db,
      board.workspace.publicId,
    );
    if (!workspace?.id) return;

    const workspaceId = workspace.id;

    // Get commenter information
    const commenter = await userRepo.getById(db, commenterUserId);
    if (!commenter) return;

    const trimmedCommenterName = commenter.name?.trim();
    const commenterName = trimmedCommenterName?.length
      ? trimmedCommenterName
      : commenter.email;

    // Get mentioned members with full details (filtered by workspace)
    const membersWithDetails = await memberRepo.getByPublicIdsWithUsers(
      db,
      mentionPublicIds,
      workspaceId,
    );

    // Filter out the commenter
    const membersToNotify = membersWithDetails.filter(
      (member) => member.user?.id !== commenterUserId,
    );

    if (membersToNotify.length === 0) return;

    const baseUrl = env("NEXT_PUBLIC_BASE_URL");
    const cardUrl = `${baseUrl}/cards/${cardPublicId}`;

    log.info(
      {
        cardPublicId,
        mentionCount: membersToNotify.length,
        commenterUserId,
      },
      "Sending mention emails",
    );

    await Promise.all(
      membersToNotify.map(async (member) => {
        const userId = member.user?.id;
        const email = member.user?.email ?? member.email;

        // Skip pending members (no userId) - they can be mentioned but won't receive emails
        if (!userId || !email) return;

        const recordNotification = async () => {
          try {
            await notificationRepo.create(db, {
              type: "mention",
              userId,
              cardId,
              commentId,
              metadata: JSON.stringify({
                actorName: commenterName,
                boardName,
              }),
            });
          } catch (error) {
            log.error(
              { err: error, email, cardPublicId },
              "Failed to record mention notification",
            );
          }
        };

        // With email turned off, the in-app notification is the only signal
        if (!isEmailEnabled()) {
          await recordNotification();
          return;
        }

        try {
          await sendEmail(
            email,
            `${commenterName} mentioned you in a comment on ${cardTitle}`,
            "MENTION",
            {
              commenterName,
              boardName,
              cardTitle,
              cardUrl,
            },
          );
          log.info({ email, cardPublicId }, "Mention email sent");
        } catch (error) {
          log.error(
            { err: error, email, cardPublicId },
            "Failed to send mention email",
          );
          return;
        }

        await recordNotification();
      }),
    );
  } catch (error) {
    log.error({ err: error, cardPublicId }, "Error sending mention emails");
  }
}
