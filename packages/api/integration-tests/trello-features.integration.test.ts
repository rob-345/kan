import { beforeEach, describe, expect, it } from "vitest";

import * as boardRepo from "@kan/db/repository/board.repo";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as listRepo from "@kan/db/repository/list.repo";
import * as watcherRepo from "@kan/db/repository/watcher.repo";
import * as schema from "@kan/db/schema";

import type { TestDbClient } from "./test-db";
import { createTestDb, seedTestData } from "./test-db";

describe("trello feature repositories", () => {
  let db: TestDbClient;
  let userId: string;
  let workspaceId: number;
  let boardId: number;
  let listId: number;

  const createBoard = async (name: string, slug: string) => {
    const board = await boardRepo.create(db, {
      name,
      slug,
      createdBy: userId,
      workspaceId,
    });
    return board!.id;
  };

  const createCard = (title: string, list = listId) =>
    cardRepo.create(db, {
      title,
      description: null,
      createdBy: userId,
      listId: list,
      workspaceId,
      position: "end",
    });

  const cardIndices = async (list = listId) => {
    const rows = await db.query.cards.findMany({
      columns: { title: true, index: true },
      where: (cards, { and, eq, isNull }) =>
        and(eq(cards.listId, list), isNull(cards.deletedAt)),
      orderBy: (cards, { asc }) => [asc(cards.index)],
    });
    return rows.map((row) => `${row.index}:${row.title}`);
  };

  beforeEach(async () => {
    db = await createTestDb();
    const seeded = await seedTestData(db);
    userId = seeded.user.id;
    workspaceId = seeded.workspace.id;
    boardId = await createBoard("Board", "board");
    const list = await listRepo.create(db, {
      name: "To do",
      createdBy: userId,
      boardId,
    });
    listId = list.id;
  });

  describe("card archive", () => {
    it("hides an archived card, compacts the list and restores it at the end", async () => {
      const first = await createCard("First");
      await createCard("Second");
      await createCard("Third");

      await cardRepo.softDelete(db, {
        cardId: first.id,
        deletedAt: new Date(),
        deletedBy: userId,
        archive: true,
      });

      expect(await cardIndices()).toEqual(["0:Second", "1:Third"]);
      const archived = await cardRepo.getArchivedByBoardId(db, boardId);
      expect(archived.map((card) => card.title)).toEqual(["First"]);

      const restored = await cardRepo.restore(db, {
        cardId: first.id,
        boardId,
      });

      expect(restored?.listId).toBe(listId);
      expect(await cardIndices()).toEqual(["0:Second", "1:Third", "2:First"]);
      expect(await cardRepo.getArchivedByBoardId(db, boardId)).toEqual([]);
    });

    it("does not list deleted cards as archived", async () => {
      const card = await createCard("Deleted");
      await cardRepo.softDelete(db, {
        cardId: card.id,
        deletedAt: new Date(),
        deletedBy: userId,
      });

      expect(await cardRepo.getArchivedByBoardId(db, boardId)).toEqual([]);
    });

    it("restores into the first open list when the card's list was archived", async () => {
      const card = await createCard("Orphan");
      const other = await listRepo.create(db, {
        name: "Doing",
        createdBy: userId,
        boardId,
      });

      await cardRepo.softDelete(db, {
        cardId: card.id,
        deletedAt: new Date(),
        deletedBy: userId,
        archive: true,
      });
      await listRepo.softDeleteById(db, {
        listId,
        deletedAt: new Date(),
        deletedBy: userId,
        archive: true,
      });

      const restored = await cardRepo.restore(db, { cardId: card.id, boardId });

      expect(restored?.listId).toBe(other.id);
    });

    it("drops a card from the archive when it is deleted from there", async () => {
      const card = await createCard("Gone");
      await cardRepo.softDelete(db, {
        cardId: card.id,
        deletedAt: new Date(),
        deletedBy: userId,
        archive: true,
      });

      await cardRepo.discardArchived(db, card.id);

      expect(await cardRepo.getArchivedByBoardId(db, boardId)).toEqual([]);
      const row = await db.query.cards.findFirst({
        where: (cards, { eq }) => eq(cards.id, card.id),
      });
      expect(row?.deletedAt).not.toBeNull();
    });
  });

  describe("list archive, copy and move", () => {
    it("archives and restores a list at the end of the board", async () => {
      const second = await listRepo.create(db, {
        name: "Doing",
        createdBy: userId,
        boardId,
      });

      await listRepo.softDeleteById(db, {
        listId,
        deletedAt: new Date(),
        deletedBy: userId,
        archive: true,
      });

      const archived = await listRepo.getArchivedByBoardId(db, boardId);
      expect(archived.map((list) => list.name)).toEqual(["To do"]);

      await listRepo.restore(db, listId);

      const lists = await db.query.lists.findMany({
        where: (lists, { and, eq, isNull }) =>
          and(eq(lists.boardId, boardId), isNull(lists.deletedAt)),
        orderBy: (lists, { asc }) => [asc(lists.index)],
      });
      expect(lists.map((list) => [list.index, list.id])).toEqual([
        [0, second.id],
        [1, listId],
      ]);
    });

    it("inserts a copied list directly after the original", async () => {
      const last = await listRepo.create(db, {
        name: "Done",
        createdBy: userId,
        boardId,
      });

      const copy = await listRepo.createAt(db, {
        name: "To do (copy)",
        boardId,
        index: 1,
        createdBy: userId,
      });

      const lists = await db.query.lists.findMany({
        where: (lists, { eq }) => eq(lists.boardId, boardId),
        orderBy: (lists, { asc }) => [asc(lists.index)],
      });
      expect(lists.map((list) => list.id)).toEqual([listId, copy.id, last.id]);
    });

    it("moves a list to another board and remaps card labels by name and colour", async () => {
      const targetBoardId = await createBoard("Target", "target");
      const [sourceLabel] = await db
        .insert(schema.labels)
        .values({
          publicId: "labelsrc0001",
          name: "Bug",
          colourCode: "#dc2626",
          boardId,
          createdBy: userId,
        })
        .returning();
      const [unmatchedLabel] = await db
        .insert(schema.labels)
        .values({
          publicId: "labelsrc0002",
          name: "Docs",
          colourCode: "#0284c7",
          boardId,
          createdBy: userId,
        })
        .returning();
      const [targetLabel] = await db
        .insert(schema.labels)
        .values({
          publicId: "labeltgt0001",
          name: "Bug",
          colourCode: "#dc2626",
          boardId: targetBoardId,
          createdBy: userId,
        })
        .returning();
      const card = await createCard("Labelled");
      await db.insert(schema.cardsToLabels).values([
        { cardId: card.id, labelId: sourceLabel!.id },
        { cardId: card.id, labelId: unmatchedLabel!.id },
      ]);

      await listRepo.moveToBoard(db, {
        listId,
        targetBoardId,
        userId,
      });

      const movedList = await db.query.lists.findFirst({
        where: (lists, { eq }) => eq(lists.id, listId),
      });
      expect(movedList?.boardId).toBe(targetBoardId);

      const cardLabels = await db.query.cardsToLabels.findMany({
        where: (rows, { eq }) => eq(rows.cardId, card.id),
        with: { label: true },
      });
      const labelBoards = cardLabels.map((row) => [
        row.label.name,
        row.label.boardId,
      ]);
      expect(labelBoards).toHaveLength(2);
      expect(labelBoards).toContainEqual(["Bug", targetBoardId]);
      expect(labelBoards).toContainEqual(["Docs", targetBoardId]);
      expect(cardLabels.map((row) => row.labelId)).toContain(targetLabel!.id);
    });
  });

  describe("watchers and due reminders", () => {
    it("collects card watchers, board watchers and card members once each", async () => {
      const card = await createCard("Watched");
      const member = await db.query.workspaceMembers.findFirst();
      await db
        .insert(schema.cardToWorkspaceMembers)
        .values({ cardId: card.id, workspaceMemberId: member!.id });
      await watcherRepo.watchCard(db, { cardId: card.id, userId });
      await watcherRepo.watchBoard(db, { boardId, userId });

      expect(await watcherRepo.getCardAudienceUserIds(db, card.id)).toEqual([
        userId,
      ]);
      expect(await watcherRepo.isWatchingBoard(db, { boardId, userId })).toBe(
        true,
      );

      await watcherRepo.unwatchCard(db, { cardId: card.id, userId });
      expect(
        await watcherRepo.isWatchingCard(db, { cardId: card.id, userId }),
      ).toBe(false);
    });

    it("claims each due reminder exactly once, and only when it is due", async () => {
      const now = new Date("2026-10-05T12:00:00.000Z");
      const dueSoon = await createCard("Due soon");
      const dueLater = await createCard("Due later");
      const done = await createCard("Done");
      const longPast = await createCard("Long past");

      const set = (
        publicId: string,
        values: Parameters<typeof cardRepo.update>[1],
      ) => cardRepo.update(db, values, { cardPublicId: publicId });

      await set(dueSoon.publicId, {
        dueDate: new Date("2026-10-06T09:00:00.000Z"),
        dueReminderMinutes: 1440,
      });
      await set(dueLater.publicId, {
        dueDate: new Date("2026-10-08T09:00:00.000Z"),
        dueReminderMinutes: 1440,
      });
      await set(done.publicId, {
        dueDate: new Date("2026-10-05T12:30:00.000Z"),
        dueReminderMinutes: 60,
        dueDateCompleted: true,
      });
      await set(longPast.publicId, {
        dueDate: new Date("2026-10-04T09:00:00.000Z"),
        dueReminderMinutes: 0,
      });

      const claimed = await cardRepo.claimDueReminders(db, { now });
      expect(claimed.map((card) => card.title)).toEqual(["Due soon"]);
      expect(claimed[0]?.list.board.id).toBe(boardId);

      expect(await cardRepo.claimDueReminders(db, { now })).toEqual([]);

      // Moving the due date re-arms the reminder
      await set(dueSoon.publicId, {
        dueDate: new Date("2026-10-06T10:00:00.000Z"),
      });
      const reclaimed = await cardRepo.claimDueReminders(db, { now });
      expect(reclaimed.map((card) => card.title)).toEqual(["Due soon"]);
    });
  });
});
