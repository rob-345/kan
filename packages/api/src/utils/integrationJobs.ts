import { env } from "next-runtime-env";

import type { dbClient } from "@kan/db/client";
import type { GoogleChatEvent } from "@kan/db/schema";
import * as googleChatRepo from "@kan/db/repository/googleChat.repo";
import * as googleChatAppRepo from "@kan/db/repository/googleChatApp.repo";
import * as googleConnectionRepo from "@kan/db/repository/googleConnection.repo";
import * as integrationJobRepo from "@kan/db/repository/integrationJob.repo";
import * as userRepo from "@kan/db/repository/user.repo";
import { createLogger } from "@kan/logger";

import type { ChatCardContext } from "./google/chat";
import { decryptToken } from "./encryption";
import {
  buildChatMessageText,
  chatThreadKey,
  GoogleChatError,
  postChatMessage,
} from "./google/chat";
import {
  canChatAppSendMessages,
  sendChatAppMessage,
} from "./google/chatApp/auth";
import { GoogleApiError, isGoogleIntegrationConfigured } from "./google/oauth";
import { getCardIdsToSyncForUser, syncCardToGoogle } from "./google/sync";

const log = createLogger("integration-jobs");

/** Minutes to wait before each retry; a job fails after the last one. */
const RETRY_DELAYS_MINUTES = [1, 5, 30, 120];

declare global {
  // Set by the server's job scheduler so new jobs run right away instead of
  // waiting for its next tick. Lives on globalThis because the API routes and
  // the scheduler can be bundled as separate module instances.
  var __kanRunIntegrationJobsSoon: (() => void) | undefined;
}

const runSoon = () => globalThis.__kanRunIntegrationJobsSoon?.();

/**
 * Queues a Calendar and Tasks sync for each card. Skipped entirely when Google
 * isn't set up or nobody has connected it. Never throws.
 */
export async function enqueueGoogleCardSync(db: dbClient, cardIds: number[]) {
  try {
    if (cardIds.length === 0 || !isGoogleIntegrationConfigured()) return;
    if (!(await googleConnectionRepo.hasActiveConnections(db))) return;

    await integrationJobRepo.enqueue(
      db,
      [...new Set(cardIds)].map((cardId) => ({
        kind: "google.sync.card" as const,
        payload: { cardId },
        dedupeKey: `google.sync.card:${cardId}`,
      })),
    );
    runSoon();
  } catch (error) {
    log.error({ err: error, cardIds }, "Failed to queue Google card sync");
  }
}

/** Queues a full sync of one person's cards, e.g. right after connecting. */
export async function enqueueGoogleUserSync(db: dbClient, userId: string) {
  try {
    await integrationJobRepo.enqueue(db, [
      {
        kind: "google.sync.user",
        payload: { userId },
        dedupeKey: `google.sync.user:${userId}`,
      },
    ]);
    runSoon();
  } catch (error) {
    log.error({ err: error, userId }, "Failed to queue Google user sync");
  }
}

export async function enqueueGoogleListSync(db: dbClient, listIds: number[]) {
  try {
    if (!isGoogleIntegrationConfigured()) return;
    const cardIds = await googleConnectionRepo.getCardIdsWithDueDateInLists(
      db,
      listIds,
    );
    await enqueueGoogleCardSync(db, cardIds);
  } catch (error) {
    log.error({ err: error, listIds }, "Failed to queue Google list sync");
  }
}

export async function enqueueGoogleBoardSync(db: dbClient, boardId: number) {
  try {
    if (!isGoogleIntegrationConfigured()) return;
    const cardIds = await googleConnectionRepo.getCardIdsWithDueDateInBoard(
      db,
      boardId,
    );
    await enqueueGoogleCardSync(db, cardIds);
  } catch (error) {
    log.error({ err: error, boardId }, "Failed to queue Google board sync");
  }
}

/**
 * Queues a message to every Google Chat space that wants this event from the
 * card's board. Never throws.
 */
export async function enqueueChatEvent(
  db: dbClient,
  args: {
    event: GoogleChatEvent;
    cardId: number;
    actorUserId?: string;
    actorName?: string | null;
    commentId?: number;
    memberUserId?: string;
    context?: Partial<ChatCardContext>;
  },
) {
  try {
    const card = await googleChatRepo.getCardForChat(db, args.cardId);
    if (!card) return;

    const spaceIds = await googleChatRepo.getActiveForEvent(db, {
      workspaceId: card.list.board.workspaceId,
      boardId: card.list.board.id,
      event: args.event,
    });
    if (spaceIds.length === 0) return;

    let actorName = args.actorName;
    if (!actorName && args.actorUserId) {
      const actor = await userRepo.getById(db, args.actorUserId);
      actorName = actor?.name?.trim() ? actor.name.trim() : actor?.email;
    }

    let memberName: string | null | undefined;
    if (args.memberUserId) {
      const member = await userRepo.getById(db, args.memberUserId);
      memberName = member?.name?.trim() ? member.name.trim() : member?.email;
    }

    const text = buildChatMessageText(args.event, {
      cardTitle: card.title,
      cardUrl: `${env("NEXT_PUBLIC_BASE_URL")}/cards/${card.publicId}`,
      boardName: card.list.board.name,
      listName: card.list.name,
      actorName,
      memberName,
      commentHtml: args.commentId
        ? await googleChatRepo.getCommentHtml(db, args.commentId)
        : undefined,
      ...args.context,
    });

    await integrationJobRepo.enqueue(
      db,
      spaceIds.map((spaceId) => ({
        kind: "google.chat.message" as const,
        payload: { spaceId, text, threadKey: chatThreadKey(card.publicId) },
      })),
    );
    runSoon();
  } catch (error) {
    log.error(
      { err: error, cardId: args.cardId, event: args.event },
      "Failed to queue Google Chat message",
    );
  }
}

/**
 * Queues a message from the Kan Chat app to the direct messages of the given
 * people and to the spaces linked to the board, wherever reminders are on.
 * Used for due reminders; anything that reminds people can call it. Skipped
 * when the Chat app can't post on its own. Never throws.
 */
export async function enqueueChatAppReminder(
  db: dbClient,
  args: {
    userIds: string[];
    boardId: number;
    text: string;
    threadKey?: string;
  },
) {
  try {
    if (!canChatAppSendMessages()) return;
    const spaceNames = await googleChatAppRepo.getReminderSpaceNames(db, {
      userIds: args.userIds,
      boardId: args.boardId,
    });
    if (spaceNames.length === 0) return;

    await integrationJobRepo.enqueue(
      db,
      spaceNames.map((spaceName) => ({
        kind: "google.chat.app.message" as const,
        payload: { spaceName, text: args.text, threadKey: args.threadKey },
      })),
    );
    runSoon();
  } catch (error) {
    log.error(
      { err: error, boardId: args.boardId },
      "Failed to queue Google Chat app reminder",
    );
  }
}

/** Queues the Chat app's due reminder for a card. Never throws. */
export async function enqueueChatAppCardReminder(
  db: dbClient,
  args: { cardId: number; userIds: string[]; dueText: string },
) {
  try {
    if (!canChatAppSendMessages()) return;
    const card = await googleChatRepo.getCardForChat(db, args.cardId);
    if (!card) return;

    await enqueueChatAppReminder(db, {
      userIds: args.userIds,
      boardId: card.list.board.id,
      text: buildChatMessageText("card.due.reminder", {
        cardTitle: card.title,
        cardUrl: `${env("NEXT_PUBLIC_BASE_URL")}/cards/${card.publicId}`,
        boardName: card.list.board.name,
        listName: card.list.name,
        dueText: args.dueText,
      }),
      threadKey: chatThreadKey(card.publicId),
    });
  } catch (error) {
    log.error(
      { err: error, cardId: args.cardId },
      "Failed to queue Google Chat app reminder",
    );
  }
}

type Job = Awaited<ReturnType<typeof integrationJobRepo.claim>>[number];

const runJob = async (db: dbClient, job: Job) => {
  const payload = job.payload as Record<string, unknown>;

  switch (job.kind) {
    case "google.chat.message": {
      const space = await googleChatRepo.getById(db, Number(payload.spaceId));
      // The space was removed or paused after the message was queued
      if (!space?.active) return;
      await postChatMessage(
        decryptToken(space.webhookUrl),
        String(payload.text),
        typeof payload.threadKey === "string" ? payload.threadKey : undefined,
      );
      return;
    }
    case "google.chat.app.message": {
      const spaceName = String(payload.spaceName);
      try {
        await sendChatAppMessage(
          spaceName,
          String(payload.text),
          typeof payload.threadKey === "string" ? payload.threadKey : undefined,
        );
      } catch (error) {
        // The app was removed from the space or the space was deleted
        if (error instanceof GoogleChatError && error.status === 404) {
          await googleChatAppRepo.deleteSpace(db, spaceName);
        }
        throw error;
      }
      return;
    }
    case "google.sync.card":
      await syncCardToGoogle(db, Number(payload.cardId));
      return;
    case "google.sync.user": {
      const cardIds = await getCardIdsToSyncForUser(db, String(payload.userId));
      await enqueueGoogleCardSync(db, cardIds);
      return;
    }
  }
};

const isRetryable = (error: unknown) => {
  if (error instanceof GoogleChatError || error instanceof GoogleApiError) {
    return error.isRetryable;
  }
  // Network failures, timeouts and our own bugs: worth another try
  return true;
};

let lastPurge = 0;

/**
 * Runs every queued integration job that is due. Safe to call from several
 * places and instances at once: each job is claimed by exactly one caller.
 * Returns how many jobs ran.
 */
export async function processIntegrationJobs(db: dbClient, now = new Date()) {
  let processed = 0;

  // Drain in batches, but stop eventually so one tick can't run forever
  for (let batch = 0; batch < 20; batch++) {
    const jobs = await integrationJobRepo.claim(db, { now: new Date() });
    if (jobs.length === 0) break;

    for (const job of jobs) {
      processed++;
      try {
        await runJob(db, job);
        await integrationJobRepo.complete(db, job.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const delay = RETRY_DELAYS_MINUTES[job.attempts - 1];

        if (delay !== undefined && isRetryable(error)) {
          log.warn(
            {
              err: error,
              jobId: job.id,
              kind: job.kind,
              attempt: job.attempts,
            },
            "Integration job failed; will retry",
          );
          await integrationJobRepo.retry(db, job, {
            runAt: new Date(Date.now() + delay * 60_000),
            error: message,
          });
        } else {
          log.error(
            {
              err: error,
              jobId: job.id,
              kind: job.kind,
              attempt: job.attempts,
            },
            "Integration job failed",
          );
          await integrationJobRepo.fail(db, job.id, message);
        }
      }
    }
  }

  if (now.getTime() - lastPurge > 60 * 60 * 1000) {
    lastPurge = now.getTime();
    await integrationJobRepo.purgeFailed(
      db,
      new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
    );
  }

  if (processed > 0) log.info({ processed }, "Processed integration jobs");
  return processed;
}
