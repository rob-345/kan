import { randomUUID } from "crypto";
import { TRPCError } from "@trpc/server";
import { env } from "next-runtime-env";

import type { dbClient } from "@kan/db/client";
import * as chatAppRepo from "@kan/db/repository/googleChatApp.repo";
import { createLogger } from "@kan/logger";

import type { createTRPCContext } from "../../../trpc-context";
import type { ChatAppCommand } from "./commands";
import type { ChatAppEvent } from "./events";
import { cardRouter } from "../../../routers/card";
import { isValidTimeZone, parseCommand, parseNewCard } from "./commands";

const log = createLogger("google-chat-app");

type KanUser = NonNullable<
  Awaited<ReturnType<typeof chatAppRepo.getUserByEmail>>
>;
type Space = NonNullable<
  Awaited<ReturnType<typeof chatAppRepo.getSpaceByName>>
>;
type Board = Awaited<ReturnType<typeof chatAppRepo.getBoardsForUser>>[number];

const MAX_LISTED = 25;

// Chat treats these as formatting characters
const plain = (value: string) => value.replace(/[*_~`<>|]/g, "");

const cardUrl = (publicId: string) =>
  `${env("NEXT_PUBLIC_BASE_URL")}/cards/${publicId}`;

export const formatInZone = (date: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(date);

const describeReminder = (minutes: number) => {
  if (minutes === 0) return "reminder at due time";
  if (minutes < 60) return `reminder ${minutes} min before`;
  if (minutes < 1440) {
    const hours = minutes / 60;
    return `reminder ${hours} hour${hours === 1 ? "" : "s"} before`;
  }
  const days = minutes / 1440;
  return `reminder ${days} day${days === 1 ? "" : "s"} before`;
};

const helpText = (space: Space) => {
  const at = space.spaceType === "DM" ? "" : "@Kan ";
  const linked = space.board?.deletedAt === null ? space.board : null;
  return [
    linked
      ? `This ${space.spaceType === "DM" ? "chat" : "space"} is linked to *${plain(linked.name)}*${
          space.list?.deletedAt === null ? ` › *${plain(space.list.name)}*` : ""
        }.`
      : `This ${space.spaceType === "DM" ? "chat" : "space"} isn't linked to a board yet.`,
    space.spaceType === "DM"
      ? `Due reminders for your tasks ${space.remindersEnabled ? "come" : "are off"} here.`
      : null,
    "",
    "*What I can do*",
    `• \`${at}add Fix the login bug due fri 3pm\`: add a task. Mention people to make them members, otherwise it's assigned to you. Add \`remind 1h\` (0, 5m, 15m, 1h, 2h, 1d, 2d) or \`no reminder\`.`,
    `• \`${at}link Board name\` or \`${at}link Board / List\`: choose where new tasks go${
      space.spaceType === "DM"
        ? ""
        : ". The board's due reminders are posted here too"
    }.`,
    `• \`${at}boards\` and \`${at}lists\`: see what you can link.`,
    `• \`${at}due\`: your tasks due in the next 7 days.`,
    `• \`${at}reminders on\` or \`off\`: ${
      space.spaceType === "DM"
        ? "due reminders for your tasks in this chat"
        : "the board's due reminders in this space"
    }.`,
    `• \`${at}unlink\`: stop using a board here.`,
  ]
    .filter((line) => line !== null)
    .join("\n");
};

const welcomeText = (space: Space, user: KanUser | undefined) => {
  if (space.spaceType === "DM") {
    return user
      ? `Hi ${plain(user.name?.split(" ")[0] ?? "there")}! I'll send due reminders for your Kan tasks here (say \`reminders off\` to stop). Try \`add Call the supplier due tomorrow 10am\`, or \`help\` for everything I can do.`
      : notRecognisedText(null);
  }
  return "Thanks for adding Kan. Link this space to a board with `@Kan link Board name`, then add tasks with `@Kan add Fix the login bug due fri 3pm`. Say `@Kan help` for more.";
};

const notRecognisedText = (email: string | null) =>
  email
    ? `I couldn't find a Kan account for ${email}. Sign in to ${env("NEXT_PUBLIC_BASE_URL")} with that address first, then try again.`
    : "Google didn't tell me who you are, so I can't match you to a Kan account.";

const boardLabel = (board: Board, boards: Board[]) =>
  new Set(boards.map((b) => b.workspaceId)).size > 1
    ? `${plain(board.workspaceName)} › ${plain(board.name)}`
    : plain(board.name);

const listBoards = (boards: Board[]) => {
  if (boards.length === 0) {
    return "You aren't a member of any boards yet.";
  }
  const lines = boards
    .slice(0, MAX_LISTED)
    .map((board) => `• ${boardLabel(board, boards)}`);
  if (boards.length > MAX_LISTED) {
    lines.push(`…and ${boards.length - MAX_LISTED} more`);
  }
  return lines.join("\n");
};

/** Finds a board or list by name: exact, then starts with, then contains. */
const matchByName = <T extends { name: string }>(items: T[], query: string) => {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const exact = items.filter((item) => item.name.toLowerCase() === needle);
  if (exact.length) return exact;
  const prefix = items.filter((item) =>
    item.name.toLowerCase().startsWith(needle),
  );
  if (prefix.length) return prefix;
  return items.filter((item) => item.name.toLowerCase().includes(needle));
};

const createCardCaller = (db: dbClient, user: KanUser) => {
  type Context = Awaited<ReturnType<typeof createTRPCContext>>;
  const ctx: Context = {
    db,
    user: { ...user, name: user.name ?? user.email },
    // Session helpers aren't used by the card procedures
    auth: undefined as unknown as Context["auth"],
    headers: new Headers(),
    transport: "rest",
    requestId: randomUUID(),
  };
  return cardRouter.createCaller(ctx);
};

const friendlyError = (error: unknown, boardName: string) => {
  if (error instanceof TRPCError) {
    if (error.code === "FORBIDDEN" || error.code === "UNAUTHORIZED") {
      return `You don't have permission to add tasks to *${plain(boardName)}*.`;
    }
    if (error.code === "NOT_FOUND" || error.code === "BAD_REQUEST") {
      return `I couldn't add that task: ${error.message}`;
    }
  }
  log.error({ err: error }, "Chat app failed to create a card");
  return "Something went wrong adding that task. Please try again.";
};

interface CommandContext {
  db: dbClient;
  event: ChatAppEvent;
  space: Space;
  user: KanUser;
  timeZone: string;
  now: Date;
}

const getLinkedBoard = (ctx: CommandContext, boards: Board[]) => {
  const linkedId =
    ctx.space.board && ctx.space.board.deletedAt === null
      ? ctx.space.board.id
      : null;
  if (linkedId) {
    return { board: boards.find((board) => board.id === linkedId) ?? null };
  }
  // Nothing linked: a person with a single board doesn't need to link
  if (boards.length === 1) return { board: boards[0] ?? null };
  return { board: null, notLinked: true };
};

const handleAdd = async (
  ctx: CommandContext,
  command: Extract<ChatAppCommand, { kind: "add" }>,
) => {
  const { db, space, user } = ctx;
  const at = space.spaceType === "DM" ? "" : "@Kan ";
  const boards = await chatAppRepo.getBoardsForUser(db, user.id);
  const { board, notLinked } = getLinkedBoard(ctx, boards);

  if (!board) {
    if (notLinked) {
      return `Which board should this go on? Link one first with \`${at}link Board name\`.\n\n${listBoards(boards)}`;
    }
    return `This ${space.spaceType === "DM" ? "chat" : "space"} is linked to *${plain(space.board?.name ?? "a board")}*, which you aren't a member of.`;
  }

  const lists = await chatAppRepo.getOpenLists(db, board.id);
  const linkedList =
    space.list?.deletedAt === null && space.board?.id === board.id
      ? lists.find((l) => l.id === space.list?.id)
      : undefined;
  const list = linkedList ?? lists[0];
  if (!list) {
    return `*${plain(board.name)}* has no lists yet. Add one in Kan first.`;
  }

  const parsed = parseNewCard(command.text, ctx.timeZone, ctx.now);
  if (parsed.error) return parsed.error;

  // Mentioned people become members; with nobody mentioned, the sender does
  const known = await chatAppRepo.getUserIdsByChatUserNames(
    db,
    ctx.event.mentions.map((mention) => mention.name),
  );
  const unknownNames = ctx.event.mentions
    .filter((mention) => !known.has(mention.name))
    .map((mention) => plain(mention.displayName ?? "someone"));
  const memberUserIds = ctx.event.mentions.length
    ? [...new Set(known.values())]
    : [user.id];
  const memberPublicIds = await chatAppRepo.getWorkspaceMemberPublicIds(
    db,
    board.workspaceId,
    memberUserIds,
  );
  const notInWorkspace = memberUserIds.length - memberPublicIds.length;

  const caller = createCardCaller(db, user);
  let card: { publicId: string };
  try {
    card = await caller.create({
      title: parsed.title,
      description: "",
      listPublicId: list.publicId,
      labelPublicIds: [],
      memberPublicIds,
      position: "end",
      dueDate: parsed.dueDate,
    });
    if (parsed.dueDate && parsed.reminderMinutes !== null) {
      await caller.update({
        cardPublicId: card.publicId,
        dueReminderMinutes: parsed.reminderMinutes,
      });
    }
  } catch (error) {
    return friendlyError(error, board.name);
  }

  const details = [`${plain(board.name)} › ${plain(list.name)}`];
  if (parsed.dueDate) {
    details.push(
      `due ${formatInZone(parsed.dueDate, ctx.timeZone)}${
        parsed.reminderMinutes !== null
          ? `, ${describeReminder(parsed.reminderMinutes)}`
          : ""
      }`,
    );
  }

  const notes: string[] = [];
  if (unknownNames.length) {
    notes.push(
      `I don't know who ${unknownNames.join(", ")} ${
        unknownNames.length === 1 ? "is" : "are"
      } in Kan yet, so I couldn't add them. They can message me once to fix that.`,
    );
  }
  if (notInWorkspace > 0) {
    notes.push(
      `${notInWorkspace === 1 ? "One person isn't" : `${notInWorkspace} people aren't`} in this board's workspace, so I left them off.`,
    );
  }

  return [
    `✅ Added *${plain(parsed.title)}*`,
    `${details.join(" · ")} · <${cardUrl(card.publicId)}|Open card>`,
    ...notes,
  ].join("\n");
};

const handleLink = async (
  ctx: CommandContext,
  command: Extract<ChatAppCommand, { kind: "link" }>,
) => {
  const { db, space, user } = ctx;
  const boards = await chatAppRepo.getBoardsForUser(db, user.id);
  const matches = matchByName(boards, command.board);

  if (matches.length === 0) {
    return `I couldn't find a board called "${plain(command.board)}" that you're a member of. Your boards:\n${listBoards(boards)}`;
  }
  if (matches.length > 1) {
    return `"${plain(command.board)}" matches more than one board. Which one?\n${listBoards(matches)}`;
  }
  const board = matches[0];
  if (!board) return null;

  const lists = await chatAppRepo.getOpenLists(db, board.id);
  let list: (typeof lists)[number] | undefined;
  if (command.list) {
    const listMatches = matchByName(lists, command.list);
    if (listMatches.length !== 1) {
      return `${
        listMatches.length ? "More than one list" : "No list"
      } on *${plain(board.name)}* matches "${plain(command.list)}". Its lists: ${lists
        .map((l) => plain(l.name))
        .join(", ")}`;
    }
    list = listMatches[0];
  }

  await chatAppRepo.linkSpace(db, space.spaceName, {
    workspaceId: board.workspaceId,
    boardId: board.id,
    listId: list?.id ?? null,
    linkedBy: user.id,
  });

  const target = list ?? lists[0];
  const where = space.spaceType === "DM" ? "this chat" : "this space";
  return [
    `🔗 Linked ${where} to *${plain(board.name)}*. New tasks go to ${
      target ? `*${plain(target.name)}*` : "its first list"
    }.`,
    space.spaceType === "DM"
      ? null
      : space.remindersEnabled
        ? "I'll post the board's due reminders here. Say `@Kan reminders off` to stop."
        : "Reminders are off here. Say `@Kan reminders on` to get the board's due reminders.",
  ]
    .filter(Boolean)
    .join("\n");
};

const handleLists = async (ctx: CommandContext) => {
  const boards = await chatAppRepo.getBoardsForUser(ctx.db, ctx.user.id);
  const { board } = getLinkedBoard(ctx, boards);
  if (!board) {
    return "Link a board first, then I can show its lists.";
  }
  const lists = await chatAppRepo.getOpenLists(ctx.db, board.id);
  return lists.length
    ? `Lists on *${plain(board.name)}*:\n${lists.map((l) => `• ${plain(l.name)}`).join("\n")}`
    : `*${plain(board.name)}* has no lists yet.`;
};

const handleDue = async (ctx: CommandContext) => {
  const cards = await chatAppRepo.getDueCardsForUser(ctx.db, {
    userId: ctx.user.id,
    until: new Date(ctx.now.getTime() + 7 * 24 * 60 * 60 * 1000),
  });
  if (cards.length === 0) {
    return "Nothing assigned to you is due in the next 7 days. 🎉";
  }
  const lines = cards.map((card) => {
    const due = card.dueDate
      ? `${formatInZone(card.dueDate, ctx.timeZone)}${
          card.dueDate < ctx.now ? " (overdue)" : ""
        }`
      : "";
    return `• *${plain(card.title)}*: ${due} · ${plain(card.boardName)} › ${plain(card.listName)} · <${cardUrl(card.publicId)}|Open>`;
  });
  return `Your tasks due in the next 7 days:\n${lines.join("\n")}`;
};

const handleReminders = async (
  ctx: CommandContext,
  enabled: boolean | null,
) => {
  const { space } = ctx;
  const at = space.spaceType === "DM" ? "" : "@Kan ";
  const subject =
    space.spaceType === "DM"
      ? "due reminders for your tasks in this chat"
      : "the linked board's due reminders in this space";

  if (enabled === null) {
    return `Reminders are ${space.remindersEnabled ? "on" : "off"}: ${subject}. Say \`${at}reminders on\` or \`${at}reminders off\` to change it.`;
  }

  await chatAppRepo.setRemindersEnabled(ctx.db, space.spaceName, enabled);
  if (enabled && space.spaceType === "SPACE" && !space.board) {
    return "Reminders are on, but this space isn't linked to a board yet. Link one with `@Kan link Board name`.";
  }
  return enabled ? `🔔 Turned on ${subject}.` : `🔕 Turned off ${subject}.`;
};

/**
 * Works out the reply to one event from Google Chat, doing whatever it asks.
 * Returns null when there is nothing to say.
 */
export async function handleChatAppEvent(
  db: dbClient,
  event: ChatAppEvent,
  now = new Date(),
): Promise<string | null> {
  if (!event.space || event.type === "OTHER") return null;

  if (event.type === "REMOVED_FROM_SPACE") {
    await chatAppRepo.deleteSpace(db, event.space.name);
    return null;
  }

  const email = event.user?.isHuman ? event.user.email : null;
  const user = email ? await chatAppRepo.getUserByEmail(db, email) : undefined;
  if (user && event.user) {
    await chatAppRepo.upsertChatUser(db, event.user.name, user.id);
  }

  const space = await chatAppRepo.upsertSpace(db, {
    spaceName: event.space.name,
    spaceType: event.space.type,
    displayName: event.space.displayName,
    userId: user?.id ?? null,
  });
  if (!space) return null;

  if (event.type === "ADDED_TO_SPACE" && !event.text) {
    return welcomeText(space, user);
  }

  if (!user) return notRecognisedText(email);

  const ctx: CommandContext = {
    db,
    event,
    space,
    user,
    timeZone:
      event.timeZone && isValidTimeZone(event.timeZone)
        ? event.timeZone
        : "UTC",
    now,
  };

  const command = parseCommand(event.text);
  switch (command.kind) {
    case "help":
      return helpText(space);
    case "add":
      return handleAdd(ctx, command);
    case "link":
      return handleLink(ctx, command);
    case "unlink":
      await chatAppRepo.unlinkSpace(db, space.spaceName);
      return `Unlinked. ${
        space.spaceType === "DM"
          ? "I'll still send your due reminders here."
          : "I won't post board reminders here until you link a board again."
      }`;
    case "boards": {
      const boards = await chatAppRepo.getBoardsForUser(db, user.id);
      return `Your boards:\n${listBoards(boards)}\n\nLink one with \`${
        space.spaceType === "DM" ? "" : "@Kan "
      }link Board name\`.`;
    }
    case "lists":
      return handleLists(ctx);
    case "due":
      return handleDue(ctx);
    case "reminders":
      return handleReminders(ctx, command.enabled);
    case "unknown":
      return `Sorry, I didn't get "${plain(command.text.slice(0, 80))}". To add a task, start with \`add\`, like \`${
        space.spaceType === "DM" ? "" : "@Kan "
      }add ${plain(command.text.slice(0, 60))}\`. Say \`${
        space.spaceType === "DM" ? "" : "@Kan "
      }help\` for everything I can do.`;
  }
}
