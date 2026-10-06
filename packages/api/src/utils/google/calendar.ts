import { dateOnlyReminderHour } from "@kan/shared/constants";

import { GoogleApiError, googleFetch } from "./oauth";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/** Length of the calendar event placed at a card's due time. */
const EVENT_MINUTES = 30;

/**
 * What a card, or one of its checklist items (sub-tasks), looks like in
 * Google Calendar and Tasks.
 */
export interface CardSyncData {
  /** The card's public id */
  publicId: string;
  /** Set when this is a checklist item of the card */
  checklistItemPublicId?: string;
  /** The card's title, or the item's title with its card's title */
  title: string;
  dueDate: Date;
  /** false when the due date is a whole day, stored as its first moment */
  dueDateHasTime: boolean;
  startDate: Date | null;
  startDateHasTime: boolean;
  /** The card is marked complete, or the checklist item is ticked */
  dueDateCompleted: boolean;
  dueReminderMinutes: number | null;
  boardName: string;
  listName: string;
  cardUrl: string;
}

/**
 * The calendar day (YYYY-MM-DD) a date falls on in a time zone. A date
 * without a time is stored as the start of its day wherever it was set, so
 * its middle is used: that lands on the same day in any nearby time zone.
 */
export const toCalendarDay = (
  date: Date,
  hasTime: boolean,
  timeZone: string,
) => {
  const instant = hasTime ? date : new Date(date.getTime() + 12 * 3_600_000);
  try {
    // en-CA formats as YYYY-MM-DD
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant);
  } catch {
    return instant.toISOString().slice(0, 10);
  }
};

const nextDay = (day: string) => {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};

/**
 * Google's popup reminder for an event. All-day events count minutes back
 * from midnight at the start of the day, while Kan reminds at 09:00 on the
 * due day, so reminders later than midnight can't be shown on them.
 */
const reminderOverrides = (data: CardSyncData) => {
  if (data.dueDateCompleted || data.dueReminderMinutes == null) return [];
  const minutes = data.dueDateHasTime
    ? data.dueReminderMinutes
    : data.dueReminderMinutes - dateOnlyReminderHour * 60;
  return minutes >= 0 ? [{ method: "popup", minutes }] : [];
};

export const createKanCalendar = async (
  accessToken: string,
  timeZone: string,
) => {
  const calendar = await googleFetch<{ id: string }>(
    accessToken,
    `${CALENDAR_API}/calendars`,
    {
      method: "POST",
      body: {
        summary: "Kan",
        description: "Due dates of the Kan cards you're a member of",
        timeZone,
      },
    },
  );
  if (!calendar) throw new Error("Google returned no calendar");
  return calendar.id;
};

const formatStart = (data: CardSyncData, timeZone: string) => {
  if (!data.startDate) return null;
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      ...(data.startDateHasTime && { hour: "2-digit", minute: "2-digit" }),
    }).format(
      data.startDateHasTime
        ? data.startDate
        : new Date(data.startDate.getTime() + 12 * 3_600_000),
    );
  } catch {
    return data.startDate.toISOString();
  }
};

/**
 * A due date with a time is shown as a short event starting at that time, so
 * Google's reminder fires the same number of minutes before it as Kan's. A
 * due date without a time is an all-day event on that day.
 */
export const buildCalendarEvent = (data: CardSyncData, timeZone = "UTC") => {
  const details = [`${data.boardName} · ${data.listName}`];
  const start = formatStart(data, timeZone);
  if (start) details.push(`Starts ${start}`);
  details.push(data.cardUrl);

  let when: {
    start: { dateTime: string } | { date: string };
    end: { dateTime: string } | { date: string };
  };
  if (data.dueDateHasTime) {
    const end = new Date(data.dueDate.getTime() + EVENT_MINUTES * 60_000);
    when = {
      start: { dateTime: data.dueDate.toISOString() },
      end: { dateTime: end.toISOString() },
    };
  } else {
    const day = toCalendarDay(data.dueDate, false, timeZone);
    when = { start: { date: day }, end: { date: nextDay(day) } };
  }

  return {
    summary: data.dueDateCompleted ? `✓ ${data.title}` : `Due: ${data.title}`,
    description: details.join("\n"),
    ...when,
    // Deadlines shouldn't show the person as busy
    transparency: "transparent",
    source: { title: "Kan", url: data.cardUrl },
    reminders: { useDefault: false, overrides: reminderOverrides(data) },
    extendedProperties: {
      private: {
        kanCard: data.publicId,
        ...(data.checklistItemPublicId && {
          kanChecklistItem: data.checklistItemPublicId,
        }),
      },
    },
  };
};

const eventsUrl = (calendarId: string) =>
  `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`;

const isGone = (error: unknown) =>
  error instanceof GoogleApiError &&
  (error.status === 404 || error.status === 410);

/**
 * Creates or replaces a card's event. Returns the event id, which changes when
 * the old event was deleted in Google and had to be created again.
 */
export const upsertCalendarEvent = async (
  accessToken: string,
  calendarId: string,
  eventId: string | null,
  data: CardSyncData,
  timeZone: string,
) => {
  const body = buildCalendarEvent(data, timeZone);

  if (eventId) {
    try {
      await googleFetch(
        accessToken,
        `${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}`,
        { method: "PUT", body: { ...body, status: "confirmed" } },
      );
      return eventId;
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }

  const event = await googleFetch<{ id: string }>(
    accessToken,
    eventsUrl(calendarId),
    { method: "POST", body },
  );
  if (!event) throw new Error("Google returned no event");
  return event.id;
};

export const deleteCalendarEvent = async (
  accessToken: string,
  calendarId: string,
  eventId: string,
) => {
  try {
    await googleFetch(
      accessToken,
      `${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}`,
      { method: "DELETE" },
    );
  } catch (error) {
    if (!isGone(error)) throw error;
  }
};

/** True when the error means the Kan calendar itself no longer exists. */
export const isMissingCalendarError = isGone;

/** Deletes the whole Kan calendar, and with it every event Kan created. */
export const deleteKanCalendar = async (
  accessToken: string,
  calendarId: string,
) => {
  try {
    await googleFetch(
      accessToken,
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}`,
      { method: "DELETE" },
    );
  } catch (error) {
    if (!isGone(error)) throw error;
  }
};
