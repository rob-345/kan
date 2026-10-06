import {
  createLocalJWKSet,
  decodeJwt,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  SignJWT,
} from "jose";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  canChatAppSendMessages,
  CHAT_ISSUER,
  sendChatAppMessage,
  verifyChatRequest,
} from "./auth";
import {
  parseCommand,
  parseDue,
  parseNewCard,
  parseReminder,
  zonedTimeToUtc,
} from "./commands";
import { buildChatResponse, normalizeChatEvent } from "./events";

// Thursday 8 October 2026, 10:00 UTC
const NOW = new Date("2026-10-08T10:00:00Z");

describe("Google Chat app", () => {
  describe("parseCommand", () => {
    it.each([
      ["", { kind: "help" }],
      ["help", { kind: "help" }],
      ["add Fix the bug", { kind: "add", text: "Fix the bug" }],
      ["New: Fix the bug", { kind: "add", text: "Fix the bug" }],
      ["/kan add Fix it", { kind: "add", text: "Fix it" }],
      ["link Product", { kind: "link", board: "Product", list: null }],
      [
        "link Product Roadmap / In progress",
        { kind: "link", board: "Product Roadmap", list: "In progress" },
      ],
      ["link", { kind: "boards" }],
      ["unlink", { kind: "unlink" }],
      ["due", { kind: "due" }],
      ["reminders off", { kind: "reminders", enabled: false }],
      ["reminders on", { kind: "reminders", enabled: true }],
      ["reminders", { kind: "reminders", enabled: null }],
      ["Fix the bug", { kind: "unknown", text: "Fix the bug" }],
    ])("parses %j", (input, expected) => {
      expect(parseCommand(input)).toEqual(expected);
    });
  });

  describe("zonedTimeToUtc", () => {
    it("converts a wall-clock time in a zone with an offset", () => {
      expect(
        zonedTimeToUtc(
          { year: 2026, month: 10, day: 9, hour: 15, minute: 0 },
          "Africa/Lagos",
        ).toISOString(),
      ).toBe("2026-10-09T14:00:00.000Z");
    });

    it("handles daylight saving time", () => {
      expect(
        zonedTimeToUtc(
          { year: 2026, month: 7, day: 1, hour: 9, minute: 30 },
          "Europe/London",
        ).toISOString(),
      ).toBe("2026-07-01T08:30:00.000Z");
      expect(
        zonedTimeToUtc(
          { year: 2026, month: 12, day: 1, hour: 9, minute: 30 },
          "Europe/London",
        ).toISOString(),
      ).toBe("2026-12-01T09:30:00.000Z");
    });
  });

  describe("parseDue", () => {
    const due = (text: string, timeZone = "UTC") =>
      parseDue(text, timeZone, NOW);

    it.each([
      ["today", "2026-10-08T09:00:00.000Z", false],
      ["tomorrow", "2026-10-09T09:00:00.000Z", false],
      ["tomorrow 3pm", "2026-10-09T15:00:00.000Z", true],
      ["tomorrow at 14:30", "2026-10-09T14:30:00.000Z", true],
      ["fri 3pm", "2026-10-09T15:00:00.000Z", true],
      ["thursday", "2026-10-08T09:00:00.000Z", false],
      ["next monday 9am", "2026-10-12T09:00:00.000Z", true],
      ["5pm", "2026-10-08T17:00:00.000Z", true],
      ["12/10 10:15", "2026-10-12T10:15:00.000Z", true],
      ["1/3", "2027-03-01T09:00:00.000Z", false],
      ["2026-11-02", "2026-11-02T09:00:00.000Z", false],
      ["2026-11-02 noon", "2026-11-02T12:00:00.000Z", true],
      ["9 nov", "2026-11-09T09:00:00.000Z", false],
      ["Nov 9 4:45pm", "2026-11-09T16:45:00.000Z", true],
      ["in 3 days", "2026-10-11T09:00:00.000Z", false],
      ["in 2 weeks 8am", "2026-10-22T08:00:00.000Z", true],
    ])("reads %j", (text, iso, hasTime) => {
      expect(due(text)).toEqual({ date: new Date(iso), hasTime });
    });

    it("uses the sender's time zone", () => {
      expect(due("tomorrow 3pm", "America/New_York")?.date.toISOString()).toBe(
        "2026-10-09T19:00:00.000Z",
      );
    });

    it.each(["someday", "31/02", "25:00", "tomorrow 15", "2026-13-01"])(
      "rejects %j",
      (text) => {
        expect(due(text)).toBeNull();
      },
    );
  });

  describe("parseReminder", () => {
    it.each([
      ["0", 0],
      ["at due", 0],
      ["15m", 15],
      ["1h", 60],
      ["2 hours", 120],
      ["1d", 1440],
      ["2 days before", 2880],
      ["10m", null],
      ["soon", null],
    ])("reads %j", (text, minutes) => {
      expect(parseReminder(text)).toBe(minutes);
    });
  });

  describe("parseNewCard", () => {
    it("reads a title on its own", () => {
      expect(parseNewCard("Fix the login bug", "UTC", NOW)).toEqual({
        title: "Fix the login bug",
        dueDate: null,
        dueHasTime: false,
        reminderMinutes: null,
      });
    });

    it("reminds 15 minutes before a due time by default", () => {
      expect(parseNewCard("Call supplier due fri 3pm", "UTC", NOW)).toEqual({
        title: "Call supplier",
        dueDate: new Date("2026-10-09T15:00:00Z"),
        dueHasTime: true,
        reminderMinutes: 15,
      });
    });

    it("reminds at the due time for a date without a time", () => {
      expect(
        parseNewCard("Send invoice due tomorrow", "UTC", NOW).reminderMinutes,
      ).toBe(0);
    });

    it("takes an explicit reminder", () => {
      expect(
        parseNewCard("Board meeting due 12/10 10:00 remind 1d", "UTC", NOW),
      ).toMatchObject({ title: "Board meeting", reminderMinutes: 1440 });
    });

    it("can skip the reminder", () => {
      expect(
        parseNewCard("Board meeting due tomorrow no reminder", "UTC", NOW)
          .reminderMinutes,
      ).toBeNull();
    });

    it("keeps 'due' inside a title when no date follows", () => {
      expect(parseNewCard("Pay dues", "UTC", NOW).title).toBe("Pay dues");
    });

    it("explains a date it can't read", () => {
      expect(parseNewCard("Fix bug due whenever", "UTC", NOW).error).toContain(
        '"whenever"',
      );
    });

    it("explains an unsupported reminder", () => {
      expect(
        parseNewCard("Fix bug due fri remind 10m", "UTC", NOW).error,
      ).toContain("10m");
    });
  });

  describe("normalizeChatEvent", () => {
    it("reads a classic Chat message event", () => {
      const event = normalizeChatEvent({
        type: "MESSAGE",
        message: {
          text: "@Kan add Fix the bug @Ama Mensah due fri",
          argumentText: " add Fix the bug @Ama Mensah due fri",
          annotations: [
            {
              type: "USER_MENTION",
              startIndex: 0,
              length: 4,
              userMention: {
                user: { name: "users/app", displayName: "Kan", type: "BOT" },
              },
            },
            {
              type: "USER_MENTION",
              startIndex: 21,
              length: 11,
              userMention: {
                user: {
                  name: "users/222",
                  displayName: "Ama Mensah",
                  type: "HUMAN",
                },
              },
            },
          ],
        },
        user: {
          name: "users/111",
          displayName: "Robert",
          email: "Robert@Example.com",
          type: "HUMAN",
        },
        space: {
          name: "spaces/AAA",
          type: "ROOM",
          spaceType: "SPACE",
          displayName: "Ops",
        },
        common: { timeZone: { id: "Africa/Accra", offset: 0 } },
      });

      expect(event).toEqual({
        format: "chat",
        type: "MESSAGE",
        text: "add Fix the bug due fri",
        mentions: [{ name: "users/222", displayName: "Ama Mensah" }],
        user: {
          name: "users/111",
          displayName: "Robert",
          email: "robert@example.com",
          isHuman: true,
        },
        space: { name: "spaces/AAA", type: "SPACE", displayName: "Ops" },
        timeZone: "Africa/Accra",
      });
    });

    it("reads a direct message", () => {
      const event = normalizeChatEvent({
        type: "ADDED_TO_SPACE",
        user: { name: "users/111", email: "r@example.com", type: "HUMAN" },
        space: { name: "spaces/DM1", type: "DM", singleUserBotDm: true },
      });
      expect(event?.type).toBe("ADDED_TO_SPACE");
      expect(event?.space?.type).toBe("DM");
      expect(event?.text).toBe("");
    });

    it("reads a Workspace add-on message event", () => {
      const event = normalizeChatEvent({
        commonEventObject: {
          hostApp: "CHAT",
          timeZone: { id: "Europe/London" },
        },
        chat: {
          user: { name: "users/111", email: "r@example.com", type: "HUMAN" },
          messagePayload: {
            space: { name: "spaces/BBB", spaceType: "SPACE" },
            message: { text: "@Kan due", argumentText: "due" },
          },
        },
      });
      expect(event).toMatchObject({
        format: "addon",
        type: "MESSAGE",
        text: "due",
        space: { name: "spaces/BBB", type: "SPACE" },
        timeZone: "Europe/London",
      });
    });

    it("reads a removal", () => {
      expect(
        normalizeChatEvent({
          chat: { removedFromSpacePayload: { space: { name: "spaces/C" } } },
        })?.type,
      ).toBe("REMOVED_FROM_SPACE");
    });

    it("ignores anything else", () => {
      expect(normalizeChatEvent("hello")).toBeNull();
      expect(normalizeChatEvent({ foo: 1 })).toBeNull();
    });
  });

  describe("buildChatResponse", () => {
    it("replies in the classic format", () => {
      expect(buildChatResponse({ format: "chat" }, "Hi")).toEqual({
        text: "Hi",
      });
    });

    it("replies in the add-on format", () => {
      expect(buildChatResponse({ format: "addon" }, "Hi")).toEqual({
        hostAppDataAction: {
          chatDataAction: { createMessageAction: { message: { text: "Hi" } } },
        },
      });
    });

    it("sends nothing when there's nothing to say", () => {
      expect(buildChatResponse({ format: "chat" }, null)).toEqual({});
    });
  });

  describe("verifyChatRequest", () => {
    let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
    let keys: Parameters<typeof verifyChatRequest>[1];

    beforeAll(async () => {
      const pair = await generateKeyPair("RS256");
      privateKey = pair.privateKey;
      const jwk = {
        ...(await exportJWK(pair.publicKey)),
        kid: "k1",
        alg: "RS256",
      };
      const jwks = createLocalJWKSet({ keys: [jwk] });
      keys = { chatKeys: jwks, googleKeys: jwks };
    });

    beforeEach(() => {
      vi.stubEnv("GOOGLE_CHAT_PROJECT_NUMBER", "1234567890");
      vi.stubEnv("NEXT_PUBLIC_BASE_URL", "https://kan.example.com");
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const sign = (
      claims: Record<string, unknown>,
      issuer: string,
      audience: string,
    ) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);

    it("accepts a Chat token for the project number", async () => {
      const token = await sign({}, CHAT_ISSUER, "1234567890");
      expect(await verifyChatRequest(`Bearer ${token}`, keys)).toBe(true);
    });

    it("rejects a Chat token for another project", async () => {
      const token = await sign({}, CHAT_ISSUER, "999");
      expect(await verifyChatRequest(`Bearer ${token}`, keys)).toBe(false);
    });

    it("accepts a Google ID token for the endpoint URL", async () => {
      const token = await sign(
        { email: CHAT_ISSUER, email_verified: true },
        "https://accounts.google.com",
        "https://kan.example.com/api/integrations/google/chat-app",
      );
      expect(await verifyChatRequest(`Bearer ${token}`, keys)).toBe(true);
    });

    it("accepts the project's add-ons service account", async () => {
      const token = await sign(
        {
          email:
            "service-1234567890@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
        },
        "https://accounts.google.com",
        "https://kan.example.com/api/integrations/google/chat-app",
      );
      expect(await verifyChatRequest(`Bearer ${token}`, keys)).toBe(true);
    });

    it("rejects an ID token from anyone else", async () => {
      const token = await sign(
        { email: "someone@example.com", email_verified: true },
        "https://accounts.google.com",
        "https://kan.example.com/api/integrations/google/chat-app",
      );
      expect(await verifyChatRequest(`Bearer ${token}`, keys)).toBe(false);
    });

    it("rejects missing or garbled tokens", async () => {
      expect(await verifyChatRequest(undefined, keys)).toBe(false);
      expect(await verifyChatRequest("Bearer nope", keys)).toBe(false);
    });

    it("rejects everything when the app isn't set up", async () => {
      vi.stubEnv("GOOGLE_CHAT_PROJECT_NUMBER", "");
      const token = await sign({}, CHAT_ISSUER, "1234567890");
      expect(await verifyChatRequest(`Bearer ${token}`, keys)).toBe(false);
    });
  });

  describe("sendChatAppMessage", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    it("signs in as the service account and posts into the thread", async () => {
      const { privateKey } = await generateKeyPair("RS256", {
        extractable: true,
      });
      vi.stubEnv("GOOGLE_CHAT_PROJECT_NUMBER", "123");
      vi.stubEnv("NEXT_PUBLIC_BASE_URL", "https://kan.example.com");
      vi.stubEnv(
        "GOOGLE_CHAT_SERVICE_ACCOUNT_KEY",
        Buffer.from(
          JSON.stringify({
            client_email: "kan-chat@proj.iam.gserviceaccount.com",
            private_key: (await exportPKCS8(privateKey)).replace(/\n/g, "\\n"),
            private_key_id: "kid1",
          }),
        ).toString("base64"),
      );
      expect(canChatAppSendMessages()).toBe(true);

      const calls: { url: string; init: RequestInit }[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((url: URL | string, init: RequestInit) => {
          calls.push({ url: String(url), init });
          const body = String(url).startsWith("https://oauth2")
            ? { access_token: "tok", expires_in: 3600 }
            : { name: "spaces/AAA/messages/1" };
          return Promise.resolve(new Response(JSON.stringify(body)));
        }),
      );

      await sendChatAppMessage("spaces/AAA", "Hello", "kan-card-abc");

      const [tokenCall, messageCall] = calls;
      const assertion = new URLSearchParams(tokenCall?.init.body as string).get(
        "assertion",
      );
      expect(decodeJwt(assertion ?? "")).toMatchObject({
        iss: "kan-chat@proj.iam.gserviceaccount.com",
        aud: "https://oauth2.googleapis.com/token",
        scope: "https://www.googleapis.com/auth/chat.bot",
      });
      expect(messageCall?.url).toBe(
        "https://chat.googleapis.com/v1/spaces/AAA/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
      );
      expect(
        (messageCall?.init.headers as Record<string, string>).Authorization,
      ).toBe("Bearer tok");
      expect(JSON.parse(messageCall?.init.body as string)).toEqual({
        text: "Hello",
        thread: { threadKey: "kan-card-abc" },
      });
    });

    it("refuses anything that isn't a space name", async () => {
      await expect(
        sendChatAppMessage("https://evil.example.com", "Hi"),
      ).rejects.toThrow("Not a Chat space");
    });
  });
});
