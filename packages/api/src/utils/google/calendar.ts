import { GoogleApiError, googleFetch } from "./oauth";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/** Length of the calendar event placed at a card's due time. */
const EVENT_MINUTES = 30;

export interface CardSyncData {
  publicId: string;
  title: string;
  dueDate: Date;
  startDate: Date | null;
  dueDateCompleted: boolean;
  dueReminderMinutes: number | null;
  boardName: string;
  listName: string;
  cardUrl: string;
}

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

/**
 * A card is shown as a short event starting at its due time, so Google's
 * reminder fires the same number of minutes before the due date as Kan's.
 */
export const buildCalendarEvent = (card: CardSyncData) => {
  const end = new Date(card.dueDate.getTime() + EVENT_MINUTES * 60_000);
  const details = [`${card.boardName} · ${card.listName}`];
  if (card.startDate) {
    details.push(`Starts ${card.startDate.toISOString()}`);
  }
  details.push(card.cardUrl);

  return {
    summary: card.dueDateCompleted ? `✓ ${card.title}` : `Due: ${card.title}`,
    description: details.join("\n"),
    start: { dateTime: card.dueDate.toISOString() },
    end: { dateTime: end.toISOString() },
    // Deadlines shouldn't show the person as busy
    transparency: "transparent",
    source: { title: "Kan", url: card.cardUrl },
    reminders: {
      useDefault: false,
      overrides:
        card.dueDateCompleted || card.dueReminderMinutes == null
          ? []
          : [{ method: "popup", minutes: card.dueReminderMinutes }],
    },
    extendedProperties: { private: { kanCard: card.publicId } },
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
  card: CardSyncData,
) => {
  const body = buildCalendarEvent(card);

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
