import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import {
  checklistItemMembers,
  checklistItems,
  checklists,
} from "@kan/db/schema";
import { generateUID } from "@kan/shared/utils";

import { dueReminderBaseSql } from "./card.repo";

/** Columns returned for a checklist item after it changes. */
const itemReturning = {
  publicId: checklistItems.publicId,
  title: checklistItems.title,
  completed: checklistItems.completed,
  startDate: checklistItems.startDate,
  startDateHasTime: checklistItems.startDateHasTime,
  dueDate: checklistItems.dueDate,
  dueDateHasTime: checklistItems.dueDateHasTime,
  dueReminderMinutes: checklistItems.dueReminderMinutes,
};

export const getCount = async (db: dbClient) => {
  const result = await db
    .select({ count: count() })
    .from(checklists)
    .where(isNull(checklists.deletedAt));
  return result[0]?.count ?? 0;
};

export const getCountItems = async (db: dbClient) => {
  const result = await db
    .select({ count: count() })
    .from(checklistItems)
    .where(isNull(checklistItems.deletedAt));
  return result[0]?.count ?? 0;
};

export const create = async (
  db: dbClient,
  checklistInput: {
    cardId: number;
    name: string;
    createdBy: string;
  },
) => {
  return db.transaction(async (tx) => {
    const card = await tx.query.checklists.findFirst({
      where: and(
        eq(checklists.cardId, checklistInput.cardId),
        isNull(checklists.deletedAt),
      ),
      orderBy: desc(checklists.index),
    });

    const [result] = await tx
      .insert(checklists)
      .values({
        publicId: generateUID(),
        name: checklistInput.name,
        createdBy: checklistInput.createdBy,
        cardId: checklistInput.cardId,
        index: card ? card.index + 1 : 0,
      })
      .returning({
        id: checklists.id,
        publicId: checklists.publicId,
        name: checklists.name,
      });

    return result;
  });
};

export const createItem = async (
  db: dbClient,
  checklistItemInput: {
    checklistId: number;
    title: string;
    createdBy: string;
    completed?: boolean;
  },
) => {
  return db.transaction(async (tx) => {
    const lastItem = await tx.query.checklistItems.findFirst({
      where: and(
        eq(checklistItems.checklistId, checklistItemInput.checklistId),
        isNull(checklistItems.deletedAt),
      ),
      orderBy: desc(checklistItems.index),
    });

    const [result] = await tx
      .insert(checklistItems)
      .values({
        publicId: generateUID(),
        title: checklistItemInput.title,
        createdBy: checklistItemInput.createdBy,
        checklistId: checklistItemInput.checklistId,
        index: lastItem ? lastItem.index + 1 : 0,
        completed: checklistItemInput.completed ?? false,
      })
      .returning({ id: checklistItems.id, ...itemReturning });

    return result;
  });
};

export const getChecklistByPublicId = async (
  db: dbClient,
  checklistPublicId: string,
) => {
  const checklist = await db.query.checklists.findFirst({
    where: and(
      eq(checklists.publicId, checklistPublicId),
      isNull(checklists.deletedAt),
    ),
    with: {
      card: {
        with: {
          list: {
            with: {
              board: {
                with: {
                  workspace: true,
                },
              },
            },
          },
        },
      },
    },
  });

  return checklist;
};

export const getChecklistItemByPublicIdWithChecklist = async (
  db: dbClient,
  checklistItemPublicId: string,
) => {
  const item = await db.query.checklistItems.findFirst({
    where: and(
      eq(checklistItems.publicId, checklistItemPublicId),
      isNull(checklistItems.deletedAt),
    ),
    with: {
      checklist: {
        with: {
          card: {
            with: {
              list: {
                with: {
                  board: {
                    with: { workspace: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  return item;
};

export const updateItemById = async (
  db: dbClient,
  args: {
    id: number;
    title?: string;
    completed?: boolean;
    startDate?: Date | null;
    startDateHasTime?: boolean;
    dueDate?: Date | null;
    dueDateHasTime?: boolean;
    dueReminderMinutes?: number | null;
  },
) => {
  // A new due date or reminder offset means any reminder already sent is stale
  const resetReminder =
    args.dueDate !== undefined ||
    args.dueDateHasTime !== undefined ||
    args.dueReminderMinutes !== undefined;

  const [result] = await db
    .update(checklistItems)
    .set({
      title: args.title,
      completed: args.completed,
      startDate: args.startDate,
      startDateHasTime: args.startDateHasTime,
      dueDate: args.dueDate,
      dueDateHasTime: args.dueDateHasTime,
      dueReminderMinutes: args.dueReminderMinutes,
      ...(resetReminder && { dueReminderSentAt: null }),
      updatedAt: new Date(),
    })
    .where(eq(checklistItems.id, args.id))
    .returning(itemReturning);

  return result;
};

export const getItemMember = (
  db: dbClient,
  args: { checklistItemId: number; workspaceMemberId: number },
) =>
  db.query.checklistItemMembers.findFirst({
    where: and(
      eq(checklistItemMembers.checklistItemId, args.checklistItemId),
      eq(checklistItemMembers.workspaceMemberId, args.workspaceMemberId),
    ),
  });

export const addItemMember = async (
  db: dbClient,
  args: { checklistItemId: number; workspaceMemberId: number },
) => {
  const rows = await db
    .insert(checklistItemMembers)
    .values(args)
    .onConflictDoNothing()
    .returning({ checklistItemId: checklistItemMembers.checklistItemId });
  return rows.length > 0;
};

export const removeItemMember = async (
  db: dbClient,
  args: { checklistItemId: number; workspaceMemberId: number },
) => {
  const rows = await db
    .delete(checklistItemMembers)
    .where(
      and(
        eq(checklistItemMembers.checklistItemId, args.checklistItemId),
        eq(checklistItemMembers.workspaceMemberId, args.workspaceMemberId),
      ),
    )
    .returning({ checklistItemId: checklistItemMembers.checklistItemId });
  return rows.length > 0;
};

/** User ids of the active board members a checklist item is assigned to. */
export const getItemAssigneeUserIds = async (
  db: dbClient,
  checklistItemId: number,
) => {
  const rows = await db.query.checklistItemMembers.findMany({
    where: eq(checklistItemMembers.checklistItemId, checklistItemId),
    with: { member: { columns: { userId: true, deletedAt: true } } },
  });
  return [
    ...new Set(
      rows.flatMap(({ member }) =>
        member.userId && !member.deletedAt ? [member.userId] : [],
      ),
    ),
  ];
};

/**
 * Claims checklist items whose due date reminder is now due and marks them as
 * sent, so concurrent workers never send the same reminder twice. Items of
 * deleted checklists or cards are skipped.
 */
export const claimDueReminders = async (
  db: dbClient,
  args: { now: Date; limit?: number },
) => {
  // Timestamps are stored as UTC without a time zone, matching Drizzle
  const now = sql`(${args.now.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
  const reminderBase = dueReminderBaseSql("item");

  const claimed = await db.execute<{ id: number }>(sql`
    UPDATE "card_checklist_item" SET "dueReminderSentAt" = ${now}
    WHERE id IN (
      SELECT item.id FROM "card_checklist_item" item
      JOIN "card_checklist" checklist ON checklist.id = item."checklistId"
      JOIN "card" card ON card.id = checklist."cardId"
      WHERE item."dueDate" IS NOT NULL
        AND item."dueReminderMinutes" IS NOT NULL
        AND item."dueReminderSentAt" IS NULL
        AND item.completed = false
        AND item."deletedAt" IS NULL
        AND checklist."deletedAt" IS NULL
        AND card."deletedAt" IS NULL
        AND ${reminderBase} - make_interval(mins => item."dueReminderMinutes") <= ${now}
        AND ${reminderBase} > ${now} - interval '1 hour'
      ORDER BY item."dueDate"
      LIMIT ${args.limit ?? 100}
      FOR UPDATE OF item SKIP LOCKED
    )
    RETURNING id
  `);

  const ids = claimed.rows.map((row) => Number(row.id));
  if (ids.length === 0) return [];

  return db.query.checklistItems.findMany({
    columns: {
      id: true,
      publicId: true,
      title: true,
      dueDate: true,
      dueDateHasTime: true,
    },
    where: inArray(checklistItems.id, ids),
    with: {
      checklist: {
        columns: {},
        with: {
          card: {
            columns: { id: true, publicId: true, title: true },
            with: {
              list: {
                columns: { name: true },
                with: {
                  board: {
                    columns: { id: true, name: true, workspaceId: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
};

export const softDeleteItemById = async (
  db: dbClient,
  args: { id: number; deletedAt: Date; deletedBy: string },
) => {
  const [result] = await db
    .update(checklistItems)
    .set({ deletedAt: args.deletedAt, deletedBy: args.deletedBy })
    .where(eq(checklistItems.id, args.id))
    .returning({ id: checklistItems.id });

  return result;
};

export const softDeleteAllItemsByChecklistId = async (
  db: dbClient,
  args: { checklistId: number; deletedAt: Date; deletedBy: string },
) => {
  const result = await db
    .update(checklistItems)
    .set({ deletedAt: args.deletedAt, deletedBy: args.deletedBy })
    .where(
      and(
        eq(checklistItems.checklistId, args.checklistId),
        isNull(checklistItems.deletedAt),
      ),
    )
    .returning({ id: checklistItems.id });

  return result;
};

export const softDeleteById = async (
  db: dbClient,
  args: { id: number; deletedAt: Date; deletedBy: string },
) => {
  const [result] = await db
    .update(checklists)
    .set({ deletedAt: args.deletedAt, deletedBy: args.deletedBy })
    .where(eq(checklists.id, args.id))
    .returning({ id: checklists.id });

  return result;
};

export const updateChecklistById = async (
  db: dbClient,
  args: { id: number; name: string },
) => {
  const [result] = await db
    .update(checklists)
    .set({ name: args.name, updatedAt: new Date() })
    .where(eq(checklists.id, args.id))
    .returning({ publicId: checklists.publicId, name: checklists.name });
  return result;
};

export const bulkCreate = async (
  db: dbClient,
  checklistInput: {
    cardId: number;
    name: string;
    createdBy: string;
    index: number;
  }[],
) => {
  if (checklistInput.length === 0) return [];

  return db.transaction(async (tx) => {
    const byCard = groupByKey(checklistInput, "cardId");

    const allValuesToInsert: {
      publicId: string;
      cardId: number;
      name: string;
      createdBy: string;
      index: number;
    }[] = [];

    for (const [cardId, items] of byCard.entries()) {
      const last = await tx.query.checklists.findFirst({
        columns: { index: true },
        where: and(eq(checklists.cardId, cardId), isNull(checklists.deletedAt)),
        orderBy: [desc(checklists.index)],
      });

      let nextIndex = last ? last.index + 1 : 0;

      const sorted = [...items].sort((a, b) => a.index - b.index);

      for (const item of sorted) {
        allValuesToInsert.push({
          publicId: generateUID(),
          ...item,
          index: nextIndex++,
        });
      }
    }

    const inserted = await tx
      .insert(checklists)
      .values(allValuesToInsert)
      .returning({ id: checklists.id, publicId: checklists.publicId });

    return inserted;
  });
};

export const bulkCreateItems = async (
  db: dbClient,
  checklistItemInput: {
    checklistId: number;
    title: string;
    createdBy: string;
    index: number;
    completed: boolean;
  }[],
) => {
  if (checklistItemInput.length === 0) return [];

  return db.transaction(async (tx) => {
    const byChecklist = groupByKey(checklistItemInput, "checklistId");

    const allValuesToInsert: {
      publicId: string;
      checklistId: number;
      title: string;
      createdBy: string;
      index: number;
      completed: boolean;
    }[] = [];

    for (const [checklistId, items] of byChecklist.entries()) {
      const last = await tx.query.checklistItems.findFirst({
        columns: { index: true },
        where: and(
          eq(checklistItems.checklistId, checklistId),
          isNull(checklistItems.deletedAt),
        ),
        orderBy: [desc(checklistItems.index)],
      });

      let nextIndex = last ? last.index + 1 : 0;

      const sorted = [...items].sort((a, b) => a.index - b.index);

      for (const item of sorted) {
        allValuesToInsert.push({
          publicId: generateUID(),
          ...item,
          index: nextIndex++,
        });
      }
    }

    const inserted = await tx
      .insert(checklistItems)
      .values(allValuesToInsert)
      .returning({
        id: checklistItems.id,
        publicId: checklistItems.publicId,
        title: checklistItems.title,
        completed: checklistItems.completed,
      });

    return inserted;
  });
};

const groupByKey = <T extends Record<string, unknown>>(
  items: T[],
  keyField: keyof T,
): Map<number, T[]> => {
  const grouped = new Map<number, T[]>();
  for (const item of items) {
    const key = item[keyField] as number;
    const arr = grouped.get(key) ?? [];
    arr.push(item);
    grouped.set(key, arr);
  }
  return grouped;
};

export const reorderItem = async (
  db: dbClient,
  args: {
    itemId: number;
    newIndex: number;
  },
) => {
  return db.transaction(async (tx) => {
    const item = await tx.query.checklistItems.findFirst({
      columns: {
        id: true,
        index: true,
        checklistId: true,
      },
      where: and(
        eq(checklistItems.id, args.itemId),
        isNull(checklistItems.deletedAt),
      ),
    });

    if (!item) {
      throw new Error(`Checklist item not found for ID ${args.itemId}`);
    }

    const currentIndex = item.index;
    const newIndex = args.newIndex;

    if (currentIndex === newIndex) {
      const unchanged = await tx.query.checklistItems.findFirst({
        columns: {
          publicId: true,
          title: true,
          completed: true,
          startDate: true,
          startDateHasTime: true,
          dueDate: true,
          dueDateHasTime: true,
          dueReminderMinutes: true,
        },
        where: and(
          eq(checklistItems.id, args.itemId),
          isNull(checklistItems.deletedAt),
        ),
      });

      if (!unchanged) {
        throw new Error(`Checklist item not found for ID ${args.itemId}`);
      }

      return unchanged;
    }

    if (currentIndex < newIndex) {
      await tx.execute(sql`
        UPDATE card_checklist_item
        SET index = index - 1
        WHERE "checklistId" = ${item.checklistId}
        AND index > ${currentIndex}
        AND index <= ${newIndex}
        AND "deletedAt" IS NULL
        `);
    } else {
      await tx.execute(sql`
        UPDATE card_checklist_item
        SET index = index + 1
        WHERE "checklistId" = ${item.checklistId}
        AND index >= ${newIndex}
        AND index < ${currentIndex}
        AND "deletedAt" IS NULL
        `);
    }

    const [updated] = await tx
      .update(checklistItems)
      .set({ index: newIndex })
      .where(eq(checklistItems.id, args.itemId))
      .returning(itemReturning);

    if (!updated) {
      throw new Error(`Failed to update checklist item with ID ${args.itemId}`);
    }

    return updated;
  });
};
