import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { dbClient } from "@kan/db/client";
import * as boardRepo from "@kan/db/repository/board.repo";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as googleConnectionRepo from "@kan/db/repository/googleConnection.repo";
import * as listRepo from "@kan/db/repository/list.repo";

import type { TestDbClient } from "./test-db";
import { driveFileRouter } from "../src/routers/driveFile";
import { encryptToken } from "../src/utils/encryption";
import { completeGoogleConnection } from "../src/utils/google/connection";
import { createOAuthState } from "../src/utils/google/oauth";
import { createTestDb, seedTestData } from "./test-db";

const SYNC_SCOPES =
  "openid email https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/tasks";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const FILE_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz";

const json = (data: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );

/** Stands in for Google's token, userinfo and Drive endpoints. */
const createFakeGoogle = (grantedScope: string) =>
  vi.fn((input: string | URL) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") {
      return json({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
        scope: grantedScope,
      });
    }
    if (url.hostname === "openidconnect.googleapis.com") {
      return json({ email: "test@example.com" });
    }
    if (url.pathname.startsWith("/drive/v3/files/")) {
      const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      if (id !== FILE_ID) return json({ error: { message: "Not found" } }, 404);
      return json({
        id,
        name: "Q4 plan",
        mimeType: "application/vnd.google-apps.document",
        webViewLink: `https://docs.google.com/document/d/${id}/edit`,
        iconLink:
          "https://drive-thirdparty.googleusercontent.com/16/type/application/vnd.google-apps.document",
      });
    }
    return json({ id: "id1" });
  });

describe("Google Drive files on cards", () => {
  let db: TestDbClient;
  let userId: string;
  let cardPublicId: string;
  let caller: ReturnType<typeof driveFileRouter.createCaller>;

  const connect = (scope: string) =>
    googleConnectionRepo.upsert(db, {
      userId,
      googleEmail: "test@example.com",
      refreshToken: encryptToken("refresh"),
      accessToken: encryptToken("access"),
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scope,
      timeZone: "UTC",
    });

  beforeEach(async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret");
    vi.stubEnv(
      "GOOGLE_CLIENT_ID",
      "123456789012-abc.apps.googleusercontent.com",
    );
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GOOGLE_PICKER_API_KEY", "picker-key");
    vi.stubEnv("NEXT_PUBLIC_BASE_URL", "https://kan.example.com");
    vi.stubGlobal("fetch", createFakeGoogle(`${SYNC_SCOPES} ${DRIVE_SCOPE}`));

    db = await createTestDb();
    const seeded = await seedTestData(db);
    userId = seeded.user.id;
    const board = await boardRepo.create(db, {
      name: "Product",
      slug: "product",
      createdBy: userId,
      workspaceId: seeded.workspace.id,
    });
    const list = await listRepo.create(db, {
      name: "Doing",
      createdBy: userId,
      boardId: board!.id,
    });
    const card = await cardRepo.create(db, {
      title: "Plan Q4",
      description: null,
      createdBy: userId,
      listId: list.id,
      workspaceId: seeded.workspace.id,
      position: "end",
      dueDate: null,
    });
    cardPublicId = card!.publicId;

    caller = driveFileRouter.createCaller({
      db: db as unknown as dbClient,
      user: { id: userId, name: "Test User", email: "test@example.com" },
    } as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("asks people to connect Drive when they only granted Calendar and Tasks", async () => {
    await connect(SYNC_SCOPES);
    expect((await caller.pickerConfig()).status).toBe("connect");
  });

  it("hands the Picker a token, the API key and the project number", async () => {
    await connect(`${SYNC_SCOPES} ${DRIVE_SCOPE}`);
    expect(await caller.pickerConfig()).toEqual({
      status: "ready",
      accessToken: "access",
      developerKey: "picker-key",
      appId: "123456789012",
    });
  });

  it("links a picked file once, logs it and unlinks it", async () => {
    await connect(DRIVE_SCOPE);

    expect(
      await caller.link({ cardPublicId, fileIds: [FILE_ID, FILE_ID] }),
    ).toEqual({ linked: 1, failed: 0 });
    // Linking the same file again doesn't add a second copy
    await caller.link({ cardPublicId, fileIds: [FILE_ID] });

    const { available, files } = await caller.list({ cardPublicId });
    expect(available).toBe(true);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      driveFileId: FILE_ID,
      name: "Q4 plan",
      url: `https://docs.google.com/document/d/${FILE_ID}/edit`,
      createdByName: "Test User",
    });

    const activities = await db.query.cardActivities.findMany();
    expect(activities.map((a) => a.type)).toContain(
      "card.updated.driveFile.added",
    );

    await caller.unlink({ driveFilePublicId: files[0]!.publicId });
    expect((await caller.list({ cardPublicId })).files).toHaveLength(0);
    const after = await db.query.cardActivities.findMany();
    expect(after.map((a) => a.type)).toContain(
      "card.updated.driveFile.removed",
    );
  });

  it("refuses files Drive won't show this person", async () => {
    await connect(DRIVE_SCOPE);
    await expect(
      caller.link({ cardPublicId, fileIds: ["someoneElsesFile123"] }),
    ).rejects.toThrow(/couldn't read/);
  });

  it("connecting for Drive doesn't switch on Calendar or Tasks sync", async () => {
    vi.stubGlobal("fetch", createFakeGoogle(`openid email ${DRIVE_SCOPE}`));
    const result = await completeGoogleConnection(db as unknown as dbClient, {
      userId,
      code: "code",
      state: createOAuthState(userId, "UTC", Date.now(), {
        purpose: "drive",
        returnTo: `/cards/${cardPublicId}`,
      }),
      error: undefined,
    });

    expect(result).toEqual({
      ok: true,
      purpose: "drive",
      returnTo: `/cards/${cardPublicId}`,
    });
    const connection = await googleConnectionRepo.getByUserId(db, userId);
    expect(connection).toMatchObject({
      calendarEnabled: false,
      tasksEnabled: false,
    });
  });

  it("connecting Calendar later turns sync on and keeps Drive", async () => {
    await connect(DRIVE_SCOPE);
    const connection = await googleConnectionRepo.getByUserId(db, userId);
    await googleConnectionRepo.update(db, connection!.id, {
      calendarEnabled: false,
      tasksEnabled: false,
    });

    const result = await completeGoogleConnection(db as unknown as dbClient, {
      userId,
      code: "code",
      state: createOAuthState(userId, "UTC"),
      error: undefined,
    });

    expect(result.ok).toBe(true);
    expect(await googleConnectionRepo.getByUserId(db, userId)).toMatchObject({
      calendarEnabled: true,
      tasksEnabled: true,
    });
    expect((await caller.pickerConfig()).status).toBe("ready");
  });
});
