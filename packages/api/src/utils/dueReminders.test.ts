import { describe, expect, it } from "vitest";

import { getDueReminderBase } from "@kan/shared/constants";

import { formatDueText } from "./dueReminders";

describe("due reminders", () => {
  const now = new Date("2026-10-20T08:00:00.000Z");

  it("counts down to a due time", () => {
    expect(formatDueText(new Date("2026-10-20T08:30:00.000Z"), true, now)).toBe(
      "in 30 minutes",
    );
    expect(formatDueText(new Date("2026-10-20T10:00:00.000Z"), true, now)).toBe(
      "in 2 hours",
    );
  });

  it("names the day of a date without a time", () => {
    // Stored as the start of the day where it was set
    expect(
      formatDueText(new Date("2026-10-20T00:00:00.000Z"), false, now),
    ).toBe("today");
    expect(
      formatDueText(new Date("2026-10-21T00:00:00.000Z"), false, now),
    ).toBe("tomorrow");
    expect(
      formatDueText(new Date("2026-10-23T00:00:00.000Z"), false, now),
    ).toBe("in 3 days");
  });

  it("reminds about a date without a time at 09:00 that day", () => {
    const due = new Date("2026-10-20T00:00:00.000Z");
    expect(getDueReminderBase(due, false).toISOString()).toBe(
      "2026-10-20T09:00:00.000Z",
    );
    expect(getDueReminderBase(due, true)).toBe(due);
  });
});
