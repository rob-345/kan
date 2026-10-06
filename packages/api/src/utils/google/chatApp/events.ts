/**
 * Google Chat sends HTTP apps one of two event shapes: the classic Chat
 * interaction event ({ type: "MESSAGE", message, user, space, common }) or,
 * for apps built as Google Workspace add-ons, { chat: { messagePayload, … },
 * commonEventObject }. Both are read into this one shape.
 */
export interface ChatAppEvent {
  format: "chat" | "addon";
  type: "MESSAGE" | "ADDED_TO_SPACE" | "REMOVED_FROM_SPACE" | "OTHER";
  /** The text after the app's mention; the whole message in a DM. */
  text: string;
  user: {
    name: string;
    displayName: string | null;
    email: string | null;
    isHuman: boolean;
  } | null;
  space: {
    name: string;
    type: "DM" | "SPACE";
    displayName: string | null;
  } | null;
  /** People mentioned in the message other than the app. */
  mentions: { name: string; displayName: string | null }[];
  timeZone: string | null;
}

interface RawUser {
  name?: string;
  displayName?: string;
  email?: string;
  type?: string;
}

interface RawSpace {
  name?: string;
  type?: string;
  spaceType?: string;
  singleUserBotDm?: boolean;
  displayName?: string;
}

interface RawMessage {
  text?: string;
  argumentText?: string;
  annotations?: {
    type?: string;
    startIndex?: number;
    length?: number;
    userMention?: { user?: RawUser };
  }[];
  space?: RawSpace;
}

interface RawEvent {
  type?: string;
  message?: RawMessage;
  user?: RawUser;
  space?: RawSpace;
  common?: { timeZone?: { id?: string } };
  commonEventObject?: {
    timeZone?: { id?: string };
    userTimezone?: { id?: string };
  };
  chat?: {
    user?: RawUser;
    messagePayload?: { message?: RawMessage; space?: RawSpace };
    appCommandPayload?: { message?: RawMessage; space?: RawSpace };
    addedToSpacePayload?: { space?: RawSpace };
    removedFromSpacePayload?: { space?: RawSpace };
  };
}

const readUser = (user: RawUser | undefined): ChatAppEvent["user"] =>
  user?.name
    ? {
        name: user.name,
        displayName: user.displayName ?? null,
        email: user.email?.trim() ? user.email.trim().toLowerCase() : null,
        isHuman: user.type !== "BOT",
      }
    : null;

const readSpace = (space: RawSpace | undefined): ChatAppEvent["space"] => {
  if (!space?.name) return null;
  const isDm =
    space.singleUserBotDm === true ||
    space.type === "DM" ||
    space.spaceType === "DIRECT_MESSAGE";
  return {
    name: space.name,
    type: isDm ? "DM" : "SPACE",
    displayName: space.displayName?.trim() ? space.displayName.trim() : null,
  };
};

/**
 * The command text, with the app's mention and other people's mentions taken
 * out. Mentioned people are returned separately.
 */
const readMessage = (message: RawMessage | undefined) => {
  const fullText = message?.text ?? "";
  const mentions: ChatAppEvent["mentions"] = [];
  const humanMentionTexts: string[] = [];

  for (const annotation of message?.annotations ?? []) {
    const user = annotation.userMention?.user;
    if (annotation.type !== "USER_MENTION" || !user?.name) continue;
    if (user.type === "BOT") continue;
    if (!mentions.some((mention) => mention.name === user.name)) {
      mentions.push({ name: user.name, displayName: user.displayName ?? null });
    }
    const sliced =
      typeof annotation.startIndex === "number" &&
      typeof annotation.length === "number"
        ? fullText.slice(
            annotation.startIndex,
            annotation.startIndex + annotation.length,
          )
        : "";
    if (sliced.startsWith("@")) {
      humanMentionTexts.push(sliced);
    } else if (user.displayName) {
      humanMentionTexts.push(`@${user.displayName}`);
    }
  }

  // argumentText drops the app's own mention; fall back to the full text
  let text = message?.argumentText ?? fullText.replace(/^\s*@\S+\s*/, "");
  for (const mentionText of humanMentionTexts) {
    if (mentionText) text = text.split(mentionText).join(" ");
  }

  return { text: text.replace(/\s+/g, " ").trim(), mentions };
};

export const normalizeChatEvent = (body: unknown): ChatAppEvent | null => {
  if (!body || typeof body !== "object") return null;
  const raw = body as RawEvent;

  if (raw.chat) {
    const chat = raw.chat;
    const base = {
      format: "addon" as const,
      user: readUser(chat.user),
      timeZone:
        raw.commonEventObject?.timeZone?.id ??
        raw.commonEventObject?.userTimezone?.id ??
        null,
    };
    const payload = chat.messagePayload ?? chat.appCommandPayload;
    if (payload) {
      const { text, mentions } = readMessage(payload.message);
      return {
        ...base,
        type: "MESSAGE",
        text,
        mentions,
        space: readSpace(payload.space ?? payload.message?.space),
      };
    }
    if (chat.addedToSpacePayload) {
      return {
        ...base,
        type: "ADDED_TO_SPACE",
        text: "",
        mentions: [],
        space: readSpace(chat.addedToSpacePayload.space),
      };
    }
    if (chat.removedFromSpacePayload) {
      return {
        ...base,
        type: "REMOVED_FROM_SPACE",
        text: "",
        mentions: [],
        space: readSpace(chat.removedFromSpacePayload.space),
      };
    }
    return {
      ...base,
      type: "OTHER",
      text: "",
      mentions: [],
      space: null,
    };
  }

  if (typeof raw.type !== "string") return null;

  const type =
    raw.type === "MESSAGE" ||
    raw.type === "ADDED_TO_SPACE" ||
    raw.type === "REMOVED_FROM_SPACE"
      ? raw.type
      : "OTHER";
  // Being added with a message ("@Kan add …") carries that message too
  const { text, mentions } =
    raw.message && type !== "REMOVED_FROM_SPACE"
      ? readMessage(raw.message)
      : { text: "", mentions: [] };

  return {
    format: "chat",
    type,
    text,
    mentions,
    user: readUser(raw.user),
    space: readSpace(raw.space ?? raw.message?.space),
    timeZone: raw.common?.timeZone?.id ?? null,
  };
};

/** The HTTP response body that makes the app reply with a text message. */
export const buildChatResponse = (
  event: Pick<ChatAppEvent, "format">,
  text: string | null,
) => {
  if (!text) return {};
  if (event.format === "addon") {
    return {
      hostAppDataAction: {
        chatDataAction: { createMessageAction: { message: { text } } },
      },
    };
  }
  return { text };
};
