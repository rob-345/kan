import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildCalendarEvent } from "./calendar";
import { buildChatMessageText, googleChatWebhookUrlSchema } from "./chat";
import {
  buildAuthorizationUrl,
  createOAuthState,
  getGrantedFeatures,
  normalizeTimeZone,
  verifyOAuthState,
} from "./oauth";
import { toTaskDueDate } from "./tasks";

describe("Google helpers", () => {
  beforeEach(() => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret");
    vi.stubEnv("GOOGLE_CLIENT_ID", "client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
    vi.stubEnv("NEXT_PUBLIC_BASE_URL", "https://kan.example.com");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("googleChatWebhookUrlSchema", () => {
    it("accepts a Chat incoming webhook URL", () => {
      expect(
        googleChatWebhookUrlSchema.safeParse(
          "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=k&token=t",
        ).success,
      ).toBe(true);
    });

    it.each([
      "https://example.com/v1/spaces/AAAA/messages?key=k&token=t",
      "http://chat.googleapis.com/v1/spaces/AAAA/messages?key=k&token=t",
      "https://chat.googleapis.com/v1/spaces/AAAA/messages",
      "https://chat.googleapis.com/v1/spaces/AAAA/members?key=k&token=t",
    ])("rejects %s", (url) => {
      expect(googleChatWebhookUrlSchema.safeParse(url).success).toBe(false);
    });
  });

  describe("buildChatMessageText", () => {
    const context = {
      cardTitle: "Fix *login*",
      cardUrl: "https://kan.example.com/cards/abc",
      boardName: "Product",
      listName: "Doing",
      actorName: "Ama",
    };

    it("quotes comments as plain text", () => {
      expect(
        buildChatMessageText("card.comment.added", {
          ...context,
          commentHtml: "<p>Looks good &amp; ready</p><p>Ship it</p>",
        }),
      ).toBe(
        "💬 Ama commented on *Fix login*\n> Looks good & ready\n> Ship it\nProduct › Doing · <https://kan.example.com/cards/abc|Open card>",
      );
    });

    it("names the destination list for moves", () => {
      expect(
        buildChatMessageText("card.moved", {
          ...context,
          fromListName: "To do",
          toListName: "Done",
        }),
      ).toBe(
        "➡️ Ama moved *Fix login* from To do to Done\nProduct › Done · <https://kan.example.com/cards/abc|Open card>",
      );
    });

    it("describes reminders without an actor", () => {
      expect(
        buildChatMessageText("card.due.reminder", {
          ...context,
          actorName: null,
          dueText: "in 30 minutes",
        }),
      ).toMatch(/^⏰ \*Fix login\* is due in 30 minutes\n/);
    });
  });

  describe("OAuth state", () => {
    it("round-trips for the same user within ten minutes", () => {
      const state = createOAuthState("user-1", "Africa/Accra", 1_000);
      expect(verifyOAuthState(state, "user-1", 1_000 + 60_000)).toEqual({
        timeZone: "Africa/Accra",
      });
    });

    it("rejects another user, an expired state and garbage", () => {
      const state = createOAuthState("user-1", "UTC", 1_000);
      expect(verifyOAuthState(state, "user-2", 2_000)).toBeNull();
      expect(verifyOAuthState(state, "user-1", 1_000 + 11 * 60_000)).toBeNull();
      expect(verifyOAuthState("not-a-state", "user-1")).toBeNull();
    });

    it("requests offline access to Calendar and Tasks", () => {
      const url = new URL(buildAuthorizationUrl("user-1", "UTC") ?? "");
      expect(url.searchParams.get("access_type")).toBe("offline");
      expect(url.searchParams.get("redirect_uri")).toBe(
        "https://kan.example.com/api/integrations/google/callback",
      );
      expect(url.searchParams.get("scope")).toContain(
        "https://www.googleapis.com/auth/calendar.app.created",
      );
      expect(url.searchParams.get("scope")).toContain(
        "https://www.googleapis.com/auth/tasks",
      );
    });

    it("reports which features were granted", () => {
      expect(
        getGrantedFeatures("openid https://www.googleapis.com/auth/tasks"),
      ).toEqual({ calendar: false, tasks: true });
    });

    it("falls back to UTC for unknown time zones", () => {
      expect(normalizeTimeZone("Not/AZone")).toBe("UTC");
      expect(normalizeTimeZone("Europe/London")).toBe("Europe/London");
    });
  });

  describe("toTaskDueDate", () => {
    it("uses the calendar date in the person's time zone", () => {
      const lateEvening = new Date("2026-10-20T23:30:00.000Z");
      expect(toTaskDueDate(lateEvening, "UTC")).toBe(
        "2026-10-20T00:00:00.000Z",
      );
      expect(toTaskDueDate(lateEvening, "Asia/Tokyo")).toBe(
        "2026-10-21T00:00:00.000Z",
      );
    });
  });

  describe("buildCalendarEvent", () => {
    it("puts the card's reminder on the event", () => {
      const event = buildCalendarEvent({
        publicId: "abc",
        title: "Report",
        dueDate: new Date("2026-10-20T15:00:00.000Z"),
        startDate: null,
        dueDateCompleted: false,
        dueReminderMinutes: 60,
        boardName: "Product",
        listName: "Doing",
        cardUrl: "https://kan.example.com/cards/abc",
      });
      expect(event.reminders).toEqual({
        useDefault: false,
        overrides: [{ method: "popup", minutes: 60 }],
      });
      expect(event.transparency).toBe("transparent");
    });
  });
});
