import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { dbClient } from "@kan/db/client";
import * as boardRepo from "@kan/db/repository/board.repo";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as googleChatRepo from "@kan/db/repository/googleChat.repo";
import * as googleConnectionRepo from "@kan/db/repository/googleConnection.repo";
import * as integrationJobRepo from "@kan/db/repository/integrationJob.repo";
import * as listRepo from "@kan/db/repository/list.repo";
import * as schema from "@kan/db/schema";

import type { TestDbClient } from "./test-db";
import { encryptToken } from "../src/utils/encryption";
import {
  enqueueChatEvent,
  enqueueGoogleCardSync,
  processIntegrationJobs,
} from "../src/utils/integrationJobs";
import { createTestDb, seedTestData } from "./test-db";

const CHAT_URL =
  "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=k&token=t";

interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}

/** A tiny stand-in for the Calendar, Tasks and Chat APIs. */
const createFakeGoogle = () => {
  const calls: RecordedCall[] = [];
  let nextId = 1;

  const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url, body });

    const json = (data: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(data), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );

    if (method === "DELETE") {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (method === "POST") {
      const id = `id${nextId++}`;
      return json({ id });
    }
    return json({});
  });

  return { calls, fetchMock };
};

describe("Google integrations", () => {
  let db: TestDbClient;
  let userId: string;
  let workspaceId: number;
  let boardId: number;
  let listId: number;
  let google: ReturnType<typeof createFakeGoogle>;

  const run = () => processIntegrationJobs(db as unknown as dbClient);

  const createCard = async (title: string, dueDate: Date | null) => {
    const card = await cardRepo.create(db, {
      title,
      description: null,
      createdBy: userId,
      listId,
      workspaceId,
      position: "end",
      dueDate,
    });
    return card;
  };

  const addMember = async (cardId: number) => {
    const member = await db.query.workspaceMembers.findFirst();
    await db.insert(schema.cardToWorkspaceMembers).values({
      cardId,
      workspaceMemberId: member!.id,
    });
  };

  const connectGoogle = (overrides: { tasksEnabled?: boolean } = {}) =>
    googleConnectionRepo
      .upsert(db, {
        userId,
        googleEmail: "test@example.com",
        refreshToken: encryptToken("refresh"),
        accessToken: encryptToken("access"),
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        scope:
          "openid email https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/tasks",
        timeZone: "Africa/Accra",
      })
      .then(async (connection) => {
        if (overrides.tasksEnabled === false) {
          await googleConnectionRepo.update(db, connection!.id, {
            tasksEnabled: false,
          });
        }
        return connection!;
      });

  beforeEach(async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret");
    vi.stubEnv("GOOGLE_CLIENT_ID", "client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
    vi.stubEnv("NEXT_PUBLIC_BASE_URL", "https://kan.example.com");
    google = createFakeGoogle();
    vi.stubGlobal("fetch", google.fetchMock);

    db = await createTestDb();
    const seeded = await seedTestData(db);
    userId = seeded.user.id;
    workspaceId = seeded.workspace.id;
    const board = await boardRepo.create(db, {
      name: "Product",
      slug: "product",
      createdBy: userId,
      workspaceId,
    });
    boardId = board!.id;
    const list = await listRepo.create(db, {
      name: "Doing",
      createdBy: userId,
      boardId,
    });
    listId = list.id;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe("integration job queue", () => {
    it("merges pending jobs with the same dedupe key", async () => {
      const job = {
        kind: "google.sync.card" as const,
        payload: { cardId: 1 },
        dedupeKey: "google.sync.card:1",
      };
      await integrationJobRepo.enqueue(db, [job]);
      await integrationJobRepo.enqueue(db, [job]);

      expect(await db.query.integrationJobs.findMany()).toHaveLength(1);
    });

    it("claims each job once and allows a new pending job while one runs", async () => {
      const job = {
        kind: "google.sync.card" as const,
        payload: { cardId: 1 },
        dedupeKey: "google.sync.card:1",
      };
      await integrationJobRepo.enqueue(db, [job]);

      const claimed = await integrationJobRepo.claim(db, { now: new Date() });
      expect(claimed).toHaveLength(1);
      expect(await integrationJobRepo.claim(db, { now: new Date() })).toEqual(
        [],
      );

      await integrationJobRepo.enqueue(db, [job]);
      expect(await db.query.integrationJobs.findMany()).toHaveLength(2);

      // The running copy is dropped on retry because a newer one is pending
      await integrationJobRepo.retry(db, claimed[0]!, {
        runAt: new Date(),
        error: "boom",
      });
      const remaining = await db.query.integrationJobs.findMany();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.status).toBe("pending");
    });

    it("retries a failing job later, then marks it failed", async () => {
      google.fetchMock.mockImplementation(() =>
        Promise.resolve(new Response("{}", { status: 503 })),
      );
      await googleChatRepo.create(db, {
        workspaceId,
        boardId: null,
        name: "Team",
        webhookUrl: encryptToken(CHAT_URL),
        events: ["card.created"],
        createdBy: userId,
      });
      const card = await createCard("Ship it", null);
      await enqueueChatEvent(db as unknown as dbClient, {
        event: "card.created",
        cardId: card.id,
        actorUserId: userId,
      });

      await run();
      const [job] = await db.query.integrationJobs.findMany();
      expect(job!.status).toBe("pending");
      expect(job!.attempts).toBe(1);
      expect(job!.runAt.getTime()).toBeGreaterThan(Date.now());

      for (let attempt = 2; attempt <= 5; attempt++) {
        await db
          .update(schema.integrationJobs)
          .set({ runAt: new Date(Date.now() - 1000) })
          .where(eq(schema.integrationJobs.id, job!.id));
        await run();
      }

      const [failed] = await db.query.integrationJobs.findMany();
      expect(failed!.status).toBe("failed");
      expect(failed!.attempts).toBe(5);
    });
  });

  describe("Google Chat", () => {
    it("posts to spaces that want the event, threaded by card", async () => {
      await googleChatRepo.create(db, {
        workspaceId,
        boardId,
        name: "Product space",
        webhookUrl: encryptToken(CHAT_URL),
        events: ["card.created", "card.completed"],
        createdBy: userId,
      });
      await googleChatRepo.create(db, {
        workspaceId,
        boardId: null,
        name: "Comments only",
        webhookUrl: encryptToken(CHAT_URL.replace("AAAA", "BBBB")),
        events: ["card.comment.added"],
        createdBy: userId,
      });

      const card = await createCard("Fix login", null);
      await enqueueChatEvent(db as unknown as dbClient, {
        event: "card.created",
        cardId: card.id,
        actorUserId: userId,
      });
      await run();

      expect(google.calls).toHaveLength(1);
      const [call] = google.calls;
      const url = new URL(call!.url);
      expect(url.pathname).toBe("/v1/spaces/AAAA/messages");
      expect(url.searchParams.get("threadKey")).toBe(
        `kan-card-${card.publicId}`,
      );
      expect(call!.body).toEqual({
        text: `🆕 Test User added *Fix login*\nProduct › Doing · <https://kan.example.com/cards/${card.publicId}|Open card>`,
      });
      expect(await db.query.integrationJobs.findMany()).toEqual([]);
    });

    it("skips messages for paused spaces", async () => {
      const space = await googleChatRepo.create(db, {
        workspaceId,
        boardId: null,
        name: "Team",
        webhookUrl: encryptToken(CHAT_URL),
        events: ["card.created"],
        createdBy: userId,
      });
      const card = await createCard("Ship it", null);
      await enqueueChatEvent(db as unknown as dbClient, {
        event: "card.created",
        cardId: card.id,
      });
      await googleChatRepo.update(db, space!.publicId, { active: false });

      await run();
      expect(google.calls).toEqual([]);
    });
  });

  describe("Google Calendar and Tasks sync", () => {
    it("creates, updates and removes a member's event and task", async () => {
      await connectGoogle();
      const due = new Date("2026-10-20T15:00:00.000Z");
      const card = await createCard("Write report", due);
      await addMember(card.id);

      await enqueueGoogleCardSync(db as unknown as dbClient, [card.id]);
      await run();

      const created = google.calls.map(
        (c) => `${c.method} ${new URL(c.url).pathname}`,
      );
      expect(created).toEqual([
        "POST /calendar/v3/calendars",
        "POST /calendar/v3/calendars/id1/events",
        "POST /tasks/v1/users/@me/lists",
        "POST /tasks/v1/lists/id3/tasks",
      ]);
      expect(google.calls[1]!.body).toMatchObject({
        summary: "Due: Write report",
        start: { dateTime: "2026-10-20T15:00:00.000Z" },
        end: { dateTime: "2026-10-20T15:30:00.000Z" },
        extendedProperties: { private: { kanCard: card.publicId } },
      });
      expect(google.calls[3]!.body).toMatchObject({
        title: "Write report",
        due: "2026-10-20T00:00:00.000Z",
        status: "needsAction",
      });

      // A change updates the same event and task in place
      google.calls.length = 0;
      await cardRepo.update(
        db,
        { dueDateCompleted: true },
        { cardPublicId: card.publicId },
      );
      await enqueueGoogleCardSync(db as unknown as dbClient, [card.id]);
      await run();
      expect(
        google.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`),
      ).toEqual([
        "PUT /calendar/v3/calendars/id1/events/id2",
        "PATCH /tasks/v1/lists/id3/tasks/id4",
      ]);
      expect(google.calls[0]!.body).toMatchObject({
        summary: "✓ Write report",
        reminders: { useDefault: false, overrides: [] },
      });
      expect(google.calls[1]!.body).toMatchObject({ status: "completed" });

      // Archiving the card removes both
      google.calls.length = 0;
      await cardRepo.softDelete(db, {
        cardId: card.id,
        deletedAt: new Date(),
        deletedBy: userId,
        archive: true,
      });
      await enqueueGoogleCardSync(db as unknown as dbClient, [card.id]);
      await run();
      expect(
        google.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`),
      ).toEqual([
        "DELETE /calendar/v3/calendars/id1/events/id2",
        "DELETE /tasks/v1/lists/id3/tasks/id4",
      ]);
      expect(await db.query.googleSyncItems.findMany()).toEqual([]);
    });

    it("only syncs what the person turned on", async () => {
      await connectGoogle({ tasksEnabled: false });
      const card = await createCard("Plan sprint", new Date(Date.now() + 1e8));
      await addMember(card.id);

      await enqueueGoogleCardSync(db as unknown as dbClient, [card.id]);
      await run();

      expect(google.calls.every((c) => c.url.includes("/calendar/v3/"))).toBe(
        true,
      );
    });

    it("does nothing for cards whose members haven't connected Google", async () => {
      await connectGoogle();
      const card = await createCard(
        "Nobody's card",
        new Date(Date.now() + 1e8),
      );

      await enqueueGoogleCardSync(db as unknown as dbClient, [card.id]);
      await run();

      expect(google.calls).toEqual([]);
    });

    it("skips queueing entirely when nobody has connected Google", async () => {
      const card = await createCard("Card", new Date(Date.now() + 1e8));
      await addMember(card.id);

      await enqueueGoogleCardSync(db as unknown as dbClient, [card.id]);

      expect(await db.query.integrationJobs.findMany()).toEqual([]);
    });

    it("marks the connection for reconnect when Google revokes access", async () => {
      const connection = await connectGoogle();
      google.fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: "Invalid" } }), {
            status: 401,
          }),
        ),
      );
      const card = await createCard("Card", new Date(Date.now() + 1e8));
      await addMember(card.id);

      await enqueueGoogleCardSync(db as unknown as dbClient, [card.id]);
      await run();

      const updated = await googleConnectionRepo.getById(db, connection.id);
      expect(updated!.status).toBe("error");
      expect(await db.query.integrationJobs.findMany()).toEqual([]);
    });
  });
});
