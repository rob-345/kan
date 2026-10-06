import { t } from "@lingui/core/macro";

import type { GoogleChatEvent } from "@kan/db/schema";

export const getGoogleChatEventLabels = (): Record<
  GoogleChatEvent,
  string
> => ({
  "card.created": t`Card added`,
  "card.moved": t`Card moved to another list`,
  "card.comment.added": t`Comment added`,
  "card.dueDate.changed": t`Due date changed`,
  "card.completed": t`Card marked complete`,
  "card.archived": t`Card archived`,
  "card.member.added": t`Member added to a card`,
  "card.due.reminder": t`Due date reminder`,
});

export const defaultGoogleChatEvents: GoogleChatEvent[] = [
  "card.created",
  "card.moved",
  "card.comment.added",
  "card.completed",
  "card.due.reminder",
];
