import { z } from "zod";

import type { GoogleChatEvent } from "@kan/db/schema";

/**
 * A Google Chat incoming webhook URL, as copied from a space's
 * "Apps & integrations → Webhooks" page.
 */
export const googleChatWebhookUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          url.hostname === "chat.googleapis.com" &&
          /^\/v1\/spaces\/[^/]+\/messages$/.test(url.pathname) &&
          url.searchParams.has("key") &&
          url.searchParams.has("token")
        );
      } catch {
        return false;
      }
    },
    {
      message:
        "Paste the webhook URL from Google Chat (https://chat.googleapis.com/v1/spaces/…)",
    },
  );

export interface ChatCardContext {
  cardTitle: string;
  cardUrl: string;
  boardName: string;
  listName: string;
  actorName?: string | null;
  fromListName?: string | null;
  toListName?: string | null;
  dueDate?: string | null;
  /** false when dueDate is a whole day, stored as its first moment */
  dueDateHasTime?: boolean;
  dueText?: string;
  commentHtml?: string | null;
  memberName?: string | null;
  /** Set when the event is about a checklist item (sub-task) of the card */
  itemTitle?: string | null;
}

// Chat treats these as formatting characters in plain text messages
const escapeChat = (value: string) => value.replace(/[*_~`<>]/g, "");

const stripHtml = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const truncate = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

export const formatChatDate = (iso: string, hasTime = true) =>
  hasTime
    ? new Intl.DateTimeFormat("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
        timeZoneName: "short",
      }).format(new Date(iso))
    : // The middle of the day lands on the right date in any nearby zone
      new Intl.DateTimeFormat("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      }).format(new Date(new Date(iso).getTime() + 12 * 3_600_000));

/**
 * The text of the Chat message posted for a card event.
 */
export const buildChatMessageText = (
  event: GoogleChatEvent,
  context: ChatCardContext,
) => {
  const card = `*${escapeChat(context.cardTitle)}*`;
  const actor = escapeChat(context.actorName?.trim() ?? "Someone") || "Someone";

  let headline: string;
  let body: string | undefined;

  switch (event) {
    case "card.created":
      headline = `🆕 ${actor} added ${card}`;
      break;
    case "card.moved":
      headline = `➡️ ${actor} moved ${card} from ${escapeChat(
        context.fromListName ?? "?",
      )} to ${escapeChat(context.toListName ?? context.listName)}`;
      break;
    case "card.comment.added": {
      headline = `💬 ${actor} commented on ${card}`;
      const comment = context.commentHtml ? stripHtml(context.commentHtml) : "";
      if (comment) {
        body = truncate(comment, 500)
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
      }
      break;
    }
    case "card.dueDate.changed":
      headline = context.dueDate
        ? `📅 ${actor} set ${card} due ${formatChatDate(context.dueDate, context.dueDateHasTime ?? true)}`
        : `📅 ${actor} removed the due date from ${card}`;
      break;
    case "card.completed":
      headline = `✅ ${actor} marked ${card} complete`;
      break;
    case "card.archived":
      headline = `🗄️ ${actor} archived ${card}`;
      break;
    case "card.member.added":
      headline = `👤 ${actor} added ${escapeChat(
        context.memberName ?? "a member",
      )} to ${card}`;
      break;
    case "card.due.reminder":
      headline = context.itemTitle
        ? `⏰ ${escapeChat(context.itemTitle)} on ${card} is due ${context.dueText ?? "soon"}`
        : `⏰ ${card} is due ${context.dueText ?? "soon"}`;
      break;
  }

  const footer = `${escapeChat(context.boardName)} › ${escapeChat(
    context.toListName ?? context.listName,
  )} · <${context.cardUrl}|Open card>`;

  return [headline, body, footer].filter(Boolean).join("\n");
};

/** Messages about the same card are grouped into one Chat thread. */
export const chatThreadKey = (cardPublicId: string) =>
  `kan-card-${cardPublicId}`;

export class GoogleChatError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "GoogleChatError";
  }

  get isRetryable() {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

export const postChatMessage = async (
  webhookUrl: string,
  text: string,
  threadKey?: string,
) => {
  const url = new URL(webhookUrl);
  if (threadKey) {
    url.searchParams.set("threadKey", threadKey);
    url.searchParams.set(
      "messageReplyOption",
      "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
    );
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new GoogleChatError(
      `Could not reach Google Chat: ${error instanceof Error ? error.message : String(error)}`,
      0,
    );
  }

  if (!response.ok) {
    const json = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new GoogleChatError(
      `Google Chat rejected the message: ${json?.error?.message ?? response.status}`,
      response.status,
    );
  }
};
